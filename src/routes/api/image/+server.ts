import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { IMAGE_API_KEY, IMAGE_PROVIDER } from '$env/static/private';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Kie.ai async task flow ────────────────────────────────────────────────────
// 1. POST /api/v1/jobs/createTask  → returns taskId
// 2. GET  /api/v1/jobs/recordInfo?taskId=…  → poll until state === 'success'
// 3. Parse resultJson (a JSON string) to extract resultUrls[0]
async function generateViaKie(apiKey: string, prompt: string, isCover: boolean): Promise<string> {
	const createRes = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`
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
	if (createData.code !== 200 || !createData.data?.taskId) {
		throw new Error(`Kie.ai createTask failed: ${createData.msg || 'Unknown error'}`);
	}

	const taskId: string = createData.data.taskId;

	// Poll up to 90 seconds (18 × 5 s)
	for (let attempt = 0; attempt < 18; attempt++) {
		await sleep(5000);

		const statusRes = await fetch(
			`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`,
			{ headers: { 'Authorization': `Bearer ${apiKey}` } }
		);
		const statusData = await statusRes.json();
		const record = statusData?.data;

		if (!record) continue;

		if (record.state === 'failed') {
			throw new Error(`Kie.ai task failed: ${record.failMsg || 'Generation error'}`);
		}

		if (record.state === 'success' && record.resultJson) {
			const parsed = JSON.parse(record.resultJson) as { resultUrls?: string[] };
			const url = parsed.resultUrls?.[0];
			if (url) return url;
		}
	}

	throw new Error('Kie.ai image generation timed out after 90 seconds.');
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { prompt, apiKey, provider, useMockMode, isCover } = await request.json();

		const activeApiKey = apiKey || IMAGE_API_KEY;
		const activeProvider = provider || IMAGE_PROVIDER || 'kie';

		// Mock mode: only use SVG placeholder when no real API key is available
		if (useMockMode && !IMAGE_API_KEY && !apiKey) {
			await sleep(2000);
			const svgDataUrl = generateMinimalistSvg(prompt || 'Ebook Artwork', isCover);
			return json({ success: true, imageUrl: svgDataUrl, source: 'mock' });
		}

		if (activeProvider === '69labs') {
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
		} else {
			// Kie.ai — async createTask → poll recordInfo
			const imageUrl = await generateViaKie(activeApiKey, prompt, isCover);
			return json({ success: true, imageUrl, source: 'live' });
		}

	} catch (error: any) {
		console.error('Image API Route Error:', error);
		return json({
			success: false,
			error: error.message || 'An unexpected error occurred during image generation.'
		}, { status: 500 });
	}
};


// ─── Mock SVG generator — style-aware, visually distinct per cover concept ────
function generateMinimalistSvg(prompt: string, isCover: boolean): string {
	const W = 400;
	const H = isCover ? 600 : 400;

	// Extract book title from prompt (pattern: Book cover for "TITLE" —)
	const titleMatch = prompt.match(/for "([^"]+)"/);
	const bookTitle  = titleMatch ? titleMatch[1] : '';

	// Detect which style variant this is from the prompt content
	const lower = prompt.toLowerCase();
	const isDark  = lower.includes('dark') || lower.includes('charcoal') || lower.includes('luxury');
	const isWarm  = lower.includes('warm') || lower.includes('sand') || lower.includes('linen') || lower.includes('watercolor');
	const isBold  = lower.includes('bold') || lower.includes('bauhaus') || lower.includes('high-contrast') || lower.includes('graphic');

	// Detect commercial non-fiction reference style
	const isCommercial = lower.includes('photorealistic') || lower.includes('badge') || lower.includes('callout')
		|| lower.includes('bestseller') || lower.includes('non-fiction') || lower.includes('how-to')
		|| lower.includes('navy') || lower.includes('bar at');

	// If user supplied a commercial/reference direction, use a bestseller-style layout
	// regardless of which of the three style tabs generated it
	if (isCommercial) {
		// ── Commercial Non-Fiction Bestseller ────────────────────────────────
		// Mirroring the reference image: bold title block top, scene area bottom, author bar
		const lines = wrapTitle(bookTitle, 22);
		const titleBlock = lines.map((line, i) =>
			`<text x="${W/2}" y="${60 + i * 30}" text-anchor="middle"
			  font-family="Arial Black,Impact,sans-serif" font-size="28"
			  font-weight="900" fill="#FFFFFF" letter-spacing="-0.5">${escapeXml(line)}</text>`
		).join('\n');

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="topBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0D1B3E"/>
      <stop offset="100%" stop-color="#162554"/>
    </linearGradient>
    <linearGradient id="sceneBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2A1F14"/>
      <stop offset="100%" stop-color="#1A1208"/>
    </linearGradient>
  </defs>
  <!-- Upper title block -->
  <rect x="0" y="0" width="${W}" height="${H*0.56}" fill="url(#topBg)"/>
  <!-- Gold accent lines flanking title -->
  <rect x="${W*0.1}" y="${H*0.13}" width="${W*0.8}" height="2" fill="#D4A82A" opacity="0.9"/>
  <rect x="${W*0.1}" y="${H*0.47}" width="${W*0.8}" height="2" fill="#D4A82A" opacity="0.9"/>
  <!-- Scene / image area -->
  <rect x="0" y="${H*0.56}" width="${W}" height="${H*0.36}" fill="url(#sceneBg)"/>
  <!-- Simulated scene elements (tools / subject matter) -->
  <rect x="${W*0.05}" y="${H*0.68}" width="${W*0.25}" height="${H*0.15}" rx="4" fill="#3A2E22" opacity="0.8"/>
  <circle cx="${W*0.52}" cy="${H*0.72}" r="${W*0.12}" fill="#4A3828" opacity="0.7"/>
  <rect x="${W*0.65}" y="${H*0.62}" width="${W*0.2}" height="${H*0.25}" rx="3" fill="#2E2218" opacity="0.9"/>
  <!-- Callout badge -->
  <circle cx="${W*0.78}" cy="${H*0.63}" r="36" fill="#C0392B"/>
  <text x="${W*0.78}" y="${H*0.608}" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" font-weight="800" fill="#FFFFFF">REFERENCE</text>
  <text x="${W*0.78}" y="${H*0.623}" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" font-weight="800" fill="#FFFFFF">STYLE</text>
  <text x="${W*0.78}" y="${H*0.638}" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" font-weight="800" fill="#FFFFFF">COVER</text>
  <!-- Author bar -->
  <rect x="0" y="${H*0.92}" width="${W}" height="${H*0.08}" fill="#0D1B3E"/>
  <text x="${W/2}" y="${H*0.965}" text-anchor="middle" font-family="Georgia,serif" font-size="15" font-weight="bold" font-style="italic" fill="#FFFFFF">Author Name</text>
  <!-- Title text block -->
  ${titleBlock}
  <!-- Style label -->
  <text x="${W*0.1}" y="${H*0.108}" text-anchor="start" font-family="Arial,sans-serif" font-size="8" fill="#D4A82A" letter-spacing="2" opacity="0.9">COMMERCIAL STYLE</text>
</svg>`;
		const base64Svg = Buffer.from(svg).toString('base64');
		return `data:image/svg+xml;base64,${base64Svg}`;
	}

	let svg = '';

	if (isDark) {
		// ── Dark Minimalist ──────────────────────────────────────────────────
		// Deep charcoal background, single gold circle, geometric lines, white typography
		svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1C1C1E"/>
      <stop offset="100%" stop-color="#0D0D0F"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#C9A84C"/>
      <stop offset="100%" stop-color="#8B6914"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <!-- Subtle noise texture via cross-hatch -->
  <line x1="0" y1="${H*0.72}" x2="${W}" y2="${H*0.72}" stroke="#2A2A2C" stroke-width="1"/>
  <!-- Large decorative circle — centred upper third -->
  <circle cx="${W/2}" cy="${H*0.35}" r="${W*0.28}" fill="none" stroke="url(#gold)" stroke-width="1.5" opacity="0.9"/>
  <circle cx="${W/2}" cy="${H*0.35}" r="${W*0.18}" fill="none" stroke="#C9A84C" stroke-width="0.5" opacity="0.4"/>
  <!-- Horizontal rule -->
  <line x1="${W*0.15}" y1="${H*0.62}" x2="${W*0.85}" y2="${H*0.62}" stroke="#C9A84C" stroke-width="0.8" opacity="0.6"/>
  <!-- Corner marks -->
  <polyline points="20,20 20,40" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <polyline points="20,20 40,20" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <polyline points="${W-20},20 ${W-20},40" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <polyline points="${W-40},20 ${W-20},20" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <polyline points="20,${H-20} 20,${H-40}" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <polyline points="20,${H-20} 40,${H-20}" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <polyline points="${W-20},${H-20} ${W-20},${H-40}" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <polyline points="${W-40},${H-20} ${W-20},${H-20}" stroke="#C9A84C" stroke-width="1" opacity="0.5" fill="none"/>
  <!-- Title text -->
  ${bookTitle ? `<text x="${W/2}" y="${H*0.72}" text-anchor="middle" font-family="Georgia,serif" font-size="22" font-weight="bold" fill="#F5F0E8" letter-spacing="0.5">${escapeXml(bookTitle)}</text>` : ''}
  <!-- Style label -->
  <text x="${W/2}" y="${H-28}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#C9A84C" letter-spacing="3" opacity="0.8">DARK MINIMALIST</text>
</svg>`;

	} else if (isWarm) {
		// ── Warm Editorial ───────────────────────────────────────────────────
		// Cream/sand palette, layered watercolour-style organic shapes, serif typography
		svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F5ECD7"/>
      <stop offset="100%" stop-color="#EDD9B8"/>
    </linearGradient>
    <radialGradient id="blob1" cx="40%" cy="35%" r="55%">
      <stop offset="0%" stop-color="#D4A96A" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#D4A96A" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="blob2" cx="70%" cy="65%" r="50%">
      <stop offset="0%" stop-color="#B07D4A" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#B07D4A" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <!-- Organic watercolour blobs -->
  <ellipse cx="${W*0.38}" cy="${H*0.32}" rx="${W*0.52}" ry="${H*0.38}" fill="url(#blob1)"/>
  <ellipse cx="${W*0.68}" cy="${H*0.64}" rx="${W*0.44}" ry="${H*0.3}" fill="url(#blob2)"/>
  <!-- Horizontal divider line — classic editorial -->
  <line x1="${W*0.12}" y1="${H*0.58}" x2="${W*0.88}" y2="${H*0.58}" stroke="#8E6A3A" stroke-width="0.8" opacity="0.55"/>
  <!-- Small accent circles -->
  <circle cx="${W*0.18}" cy="${H*0.22}" r="4" fill="#8E6A3A" opacity="0.4"/>
  <circle cx="${W*0.82}" cy="${H*0.78}" r="3" fill="#8E6A3A" opacity="0.3"/>
  <!-- Thin border -->
  <rect x="14" y="14" width="${W-28}" height="${H-28}" fill="none" stroke="#8E6A3A" stroke-width="0.6" opacity="0.3"/>
  <!-- Title text -->
  ${bookTitle ? `<text x="${W/2}" y="${H*0.68}" text-anchor="middle" font-family="Georgia,serif" font-size="21" font-weight="bold" fill="#3D2B1A" letter-spacing="0.3">${escapeXml(bookTitle)}</text>` : ''}
  <!-- Style label -->
  <text x="${W/2}" y="${H-26}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#8E6A3A" letter-spacing="3" opacity="0.7">WARM EDITORIAL</text>
</svg>`;

	} else {
		// ── Bold Graphic (default) ────────────────────────────────────────────
		// High-contrast colour blocks, Bauhaus geometry, strong typography
		svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#F2F2F0"/>
      <stop offset="100%" stop-color="#E8E8E5"/>
    </linearGradient>
  </defs>
  <!-- Light background -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <!-- Bold colour block — upper two-thirds -->
  <rect x="0" y="0" width="${W}" height="${H*0.62}" fill="#1A1A2E"/>
  <!-- Accent stripe -->
  <rect x="0" y="${H*0.62}" width="${W}" height="${H*0.04}" fill="#E63946"/>
  <!-- Large offset square — geometric tension -->
  <rect x="${W*0.38}" y="${H*0.12}" width="${W*0.52}" height="${H*0.42}" fill="none" stroke="#E63946" stroke-width="2" opacity="0.8"/>
  <!-- Inner square echo -->
  <rect x="${W*0.46}" y="${H*0.19}" width="${W*0.36}" height="${H*0.28}" fill="rgba(230,57,70,0.08)"/>
  <!-- Vertical accent line -->
  <line x1="${W*0.12}" y1="${H*0.08}" x2="${W*0.12}" y2="${H*0.56}" stroke="#E63946" stroke-width="2.5" opacity="0.9"/>
  <!-- Title text (white on dark) -->
  ${bookTitle ? `<text x="${W*0.12}" y="${H*0.73}" text-anchor="start" font-family="Arial,Helvetica,sans-serif" font-size="20" font-weight="900" fill="#1A1A2E" letter-spacing="-0.5">${escapeXml(bookTitle)}</text>` : ''}
  <!-- Style label -->
  <text x="${W/2}" y="${H-26}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#555" letter-spacing="3" opacity="0.7">BOLD GRAPHIC</text>
</svg>`;
	}

	const base64Svg = Buffer.from(svg).toString('base64');
	return `data:image/svg+xml;base64,${base64Svg}`;
}

/** Wrap a title string into lines of max ~18 chars for SVG rendering */
function wrapTitle(title: string, maxChars: number): string[] {
	if (!title) return ['YOUR TITLE'];
	const words = title.toUpperCase().split(' ');
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		if ((current + ' ' + word).trim().length > maxChars && current) {
			lines.push(current.trim());
			current = word;
		} else {
			current = (current + ' ' + word).trim();
		}
	}
	if (current) lines.push(current.trim());
	return lines.slice(0, 4); // max 4 lines
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
