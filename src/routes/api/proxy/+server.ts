import type { RequestHandler } from './$types';

/**
 * GET /api/proxy?url=<encoded-url>
 *
 * Server-side image proxy.  Fetches a remote image and re-serves it with
 * same-origin headers so the browser's canvas security policy allows
 * drawImage() without tainting the canvas.
 *
 * Only image content-types are forwarded; all other responses are rejected
 * to prevent this endpoint from being used as a general-purpose proxy.
 */
/** Fetches a remote image (for PDF/HTML export) through the server to dodge
 *  CORS; a slow CDN can take up to its own 15s ceiling, so give it head-room
 *  over Vercel's default. Ignored in local dev. */
export const config = { maxDuration: 30 };

export const GET: RequestHandler = async ({ url }) => {
	const target = url.searchParams.get('url');

	if (!target) {
		return new Response('Missing url parameter', { status: 400 });
	}

	// Only allow http/https URLs
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return new Response('Invalid URL', { status: 400 });
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return new Response('Only http and https URLs are supported', { status: 400 });
	}

	try {
		const upstream = await fetch(target, {
			headers: {
				// Identify the request; some CDNs require a User-Agent
				'User-Agent': 'EbookAutomator/1.0 (image-proxy)'
			}
		});

		if (!upstream.ok) {
			return new Response(`Upstream returned ${upstream.status}`, { status: 502 });
		}

		const contentType = upstream.headers.get('content-type') ?? '';
		if (!contentType.startsWith('image/')) {
			return new Response('Remote resource is not an image', { status: 422 });
		}

		const buffer = await upstream.arrayBuffer();

		return new Response(buffer, {
			status: 200,
			headers: {
				'Content-Type': contentType,
				'Cache-Control': 'public, max-age=3600',
				// Allow the browser to use this in canvas without taint
				'Access-Control-Allow-Origin': '*'
			}
		});
	} catch (err: any) {
		console.error('[image-proxy] fetch error:', err);
		return new Response('Failed to fetch remote image', { status: 502 });
	}
};
