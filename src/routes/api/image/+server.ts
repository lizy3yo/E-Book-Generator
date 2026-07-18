import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { IMAGE_API_KEY, IMAGE_PROVIDER } from '$env/static/private';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * POST /api/image
 *
 * Supports two modes via the `action` field:
 *
 * action: "create" (default / omitted)
 *   — Submits the generation job to Kie.ai and returns { taskId } immediately.
 *   — For 69labs (synchronous), returns { imageUrl } directly.
 *   — For mock mode, returns { imageUrl } with an SVG placeholder.
 *
 * action: "poll"
 *   — Checks a single Kie.ai taskId.
 *   — Returns { done: true, imageUrl } on success, { done: false } while pending,
 *     or { done: true, error } on failure.
 *
 * The client is responsible for polling every few seconds until done === true.
 * This keeps the HTTP connection short and avoids server-side blocking.
 */
/**
 * Kie.ai submits-and-polls (each request is short), but the 69labs provider is
 * synchronous — one create request blocks ~40–60s while the image renders. 120s
 * covers that worst case with margin; Kie stays far under it. Ignored locally.
 */
export const config = { maxDuration: 120 };

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { action = 'create', prompt, apiKey, provider, useMockMode, isCover, taskId } =
			await request.json();

		const activeApiKey  = (apiKey?.trim()) || IMAGE_API_KEY;
		const activeProvider = provider || IMAGE_PROVIDER || 'kie';

		console.log(`[image] action=${action} provider=${activeProvider} hasKey=${!!activeApiKey} mock=${useMockMode}`);

		// ── Mock mode ──────────────────────────────────────────────────────────
		if (useMockMode && !activeApiKey) {
			if (action === 'poll') return json({ done: true, imageUrl: '' });
			await sleep(1500);
			return json({
				success: true,
				imageUrl: generateMinimalistSvg(prompt || 'Ebook Artwork', isCover),
				source: 'mock'
			});
		}

		if (!activeApiKey) {
			throw new Error('No image API key configured. Add IMAGE_API_KEY to .env or enter one in Settings.');
		}

		// ── 69labs — synchronous, no polling needed ────────────────────────────
		if (activeProvider === '69labs') {
			if (action === 'poll') return json({ done: true, imageUrl: '' }); // no-op
			const response = await fetch('https://api.69labs.vip/v1/images/generations', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${activeApiKey}`
				},
				body: JSON.stringify({
					prompt,
					n: 1,
					size: isCover ? '512x768' : '512x512',
					response_format: 'url'
				})
			});
			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`69labs API error (${response.status}): ${errText}`);
			}
			const data = await response.json();
			const imageUrl = data.data?.[0]?.url || data.url;
			if (!imageUrl) throw new Error('No image URL returned from 69labs.');
			return json({ success: true, imageUrl, source: 'live' });
		}

		// ── Kie.ai ─────────────────────────────────────────────────────────────
		if (action === 'poll') {
			// Single poll attempt — client calls this repeatedly
			if (!taskId) throw new Error('taskId is required for poll action.');
			const statusRes = await fetch(
				`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`,
				{ headers: { 'Authorization': `Bearer ${activeApiKey}` } }
			);
			const statusData = await statusRes.json();
			const record = statusData?.data;

			if (!record) return json({ done: false });

			// Kie reports a failed job as state "fail". Matching only "failed" here
			// meant every failure looked like "still generating", so the client
			// polled a dead job for its full 90s budget and then reported a
			// timeout — hiding both the real reason and the fact that a plain
			// retry would have worked. failCode is passed through so the caller
			// can tell a transient provider fault from a permanent rejection.
			if (record.state === 'fail' || record.state === 'failed') {
				return json({
					done:  true,
					error: record.failMsg || `Kie.ai generation failed (${record.failCode ?? 'unknown'}).`,
					code:  record.failCode ?? null
				});
			}
			if (record.state === 'success' && record.resultJson) {
				const parsed = JSON.parse(record.resultJson) as { resultUrls?: string[] };
				const imageUrl = parsed.resultUrls?.[0];
				if (imageUrl) return json({ done: true, imageUrl });
			}
			return json({ done: false });
		}

		// action === 'create' — submit job and return taskId immediately
		const createRes = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${activeApiKey}`
			},
			body: JSON.stringify({
				model: 'flux-2/pro-text-to-image',
				input: {
					prompt,
					aspect_ratio: isCover ? '2:3' : '1:1',
					resolution: '1K',
					nsfw_checker: false
				}
			})
		});

		const createData = await createRes.json();
		console.log('[kie.ai] createTask:', JSON.stringify(createData));

		if (createData.code !== 200 || !createData.data?.taskId) {
			throw new Error(`Kie.ai createTask failed: ${createData.msg || JSON.stringify(createData)}`);
		}

		return json({ success: true, taskId: createData.data.taskId, source: 'kie' });

	} catch (error: any) {
		console.error('[image] Error:', error.message);
		return json(
			{ success: false, error: error.message || 'Unexpected error during image generation.' },
			{ status: 500 }
		);
	}
};


// ─── Mock SVG generator ────────────────────────────────────────────────────────
function generateMinimalistSvg(prompt: string, isCover: boolean): string {
	const W = 400;
	const H = isCover ? 600 : 400;

	const titleMatch = prompt.match(/for "([^"]+)"/);
	const bookTitle  = titleMatch ? titleMatch[1] : '';
	const lower      = prompt.toLowerCase();
	const isDark     = lower.includes('dark') || lower.includes('charcoal') || lower.includes('luxury');
	const isWarm     = lower.includes('warm') || lower.includes('sand') || lower.includes('watercolor');

	let svg = '';

	if (isDark) {
		svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1C1C1E"/><stop offset="100%" stop-color="#0D0D0F"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#C9A84C"/><stop offset="100%" stop-color="#8B6914"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="${W/2}" cy="${H*0.35}" r="${W*0.28}" fill="none" stroke="url(#gold)" stroke-width="1.5" opacity="0.9"/>
  <line x1="${W*0.15}" y1="${H*0.62}" x2="${W*0.85}" y2="${H*0.62}" stroke="#C9A84C" stroke-width="0.8" opacity="0.6"/>
  <rect x="20" y="20" width="${W-40}" height="${H-40}" fill="none" stroke="#C9A84C" stroke-width="0.6" opacity="0.3"/>
  ${bookTitle ? `<text x="${W/2}" y="${H*0.72}" text-anchor="middle" font-family="Georgia,serif" font-size="22" font-weight="bold" fill="#F5F0E8">${escapeXml(bookTitle)}</text>` : ''}
  <text x="${W/2}" y="${H-28}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#C9A84C" letter-spacing="3" opacity="0.8">DARK MINIMALIST</text>
</svg>`;
	} else if (isWarm) {
		svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F5ECD7"/><stop offset="100%" stop-color="#EDD9B8"/>
    </linearGradient>
    <radialGradient id="blob1" cx="40%" cy="35%" r="55%">
      <stop offset="0%" stop-color="#D4A96A" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#D4A96A" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <ellipse cx="${W*0.38}" cy="${H*0.32}" rx="${W*0.52}" ry="${H*0.38}" fill="url(#blob1)"/>
  <line x1="${W*0.12}" y1="${H*0.58}" x2="${W*0.88}" y2="${H*0.58}" stroke="#8E6A3A" stroke-width="0.8" opacity="0.55"/>
  <rect x="14" y="14" width="${W-28}" height="${H-28}" fill="none" stroke="#8E6A3A" stroke-width="0.6" opacity="0.3"/>
  ${bookTitle ? `<text x="${W/2}" y="${H*0.68}" text-anchor="middle" font-family="Georgia,serif" font-size="21" font-weight="bold" fill="#3D2B1A">${escapeXml(bookTitle)}</text>` : ''}
  <text x="${W/2}" y="${H-26}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#8E6A3A" letter-spacing="3" opacity="0.7">WARM EDITORIAL</text>
</svg>`;
	} else {
		svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#F2F2F0"/>
  <rect x="0" y="0" width="${W}" height="${H*0.62}" fill="#1A1A2E"/>
  <rect x="0" y="${H*0.62}" width="${W}" height="${H*0.04}" fill="#E63946"/>
  <rect x="${W*0.38}" y="${H*0.12}" width="${W*0.52}" height="${H*0.42}" fill="none" stroke="#E63946" stroke-width="2" opacity="0.8"/>
  <line x1="${W*0.12}" y1="${H*0.08}" x2="${W*0.12}" y2="${H*0.56}" stroke="#E63946" stroke-width="2.5" opacity="0.9"/>
  ${bookTitle ? `<text x="${W*0.12}" y="${H*0.73}" text-anchor="start" font-family="Arial,sans-serif" font-size="20" font-weight="900" fill="#1A1A2E">${escapeXml(bookTitle)}</text>` : ''}
  <text x="${W/2}" y="${H-26}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#555" letter-spacing="3" opacity="0.7">BOLD GRAPHIC</text>
</svg>`;
	}

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function escapeXml(str: string): string {
	return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
