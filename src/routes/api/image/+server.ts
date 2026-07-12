import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { prompt, apiKey, provider, useMockMode, isCover } = await request.json();

		if (useMockMode || !apiKey) {
			// Simulate latency
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Generate a beautiful, minimalist SVG placeholder based on the prompt
			const svgDataUrl = generateMinimalistSvg(prompt || 'Ebook Artwork', isCover);

			return json({
				success: true,
				imageUrl: svgDataUrl,
				source: 'mock'
			});
		}

		// Live API Mode
		// Depending on provider (Kie.ai vs 69labs.vip)
		if (provider === '69labs') {
			// Mock endpoint placeholder for 69labs API or make actual fetch if apiKey provided
			// Let's assume standard POST endpoint or similar
			const response = await fetch('https://api.69labs.vip/v1/images/generations', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				},
				body: JSON.stringify({
					prompt: prompt,
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

			return json({
				success: true,
				imageUrl,
				source: 'live'
			});
		} else {
			// Kie.ai API Call
			const response = await fetch('https://api.kie.ai/v1/images/generations', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`
				},
				body: JSON.stringify({
					prompt: prompt,
					n: 1,
					size: isCover ? '512x768' : '512x512'
				})
			});

			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Kie.ai API error (${response.status}): ${errText}`);
			}

			const data = await response.json();
			const imageUrl = data.data?.[0]?.url || data.url;

			if (!imageUrl) throw new Error('No image URL returned from Kie.ai.');

			return json({
				success: true,
				imageUrl,
				source: 'live'
			});
		}

	} catch (error: any) {
		console.error('Image API Route Error:', error);
		return json({
			success: false,
			error: error.message || 'An unexpected error occurred during image generation.'
		}, { status: 500 });
	}
};

// Generates a beautiful minimalist SVG vector illustration
function generateMinimalistSvg(prompt: string, isCover: boolean): string {
	const hash = prompt.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
	
	// Create warm, premium gradients based on prompt hash
	const colors = [
		['#EAE5D9', '#D9C5B2'], // Warm sand & linen
		['#343A40', '#212529'], // Dark charcoal
		['#E8D3C9', '#C2A398'], // Muted rose
		['#D3D9D4', '#748D92'], // Muted slate & sage
		['#8E7453', '#FAF7F2'], // Brass & cream
		['#2C3E50', '#FD79A8']  // Midnight & soft pink
	];
	
	const selectedColors = colors[hash % colors.length];
	const width = isCover ? 400 : 400;
	const height = isCover ? 600 : 400;

	// Abstract graphic geometries to look artistic and publishing-grade
	let artElements = '';
	const layoutType = hash % 3;

	if (layoutType === 0) {
		// Clean sun/moon circle and minimalist horizon line
		artElements = `
			<circle cx="200" cy="${height / 2.5}" r="${width / 4}" fill="${selectedColors[0]}" opacity="0.85" />
			<line x1="50" y1="${height - 120}" x2="350" y2="${height - 120}" stroke="${selectedColors[1]}" stroke-width="1.5" />
			<circle cx="200" cy="${height / 2.5}" r="${width / 6}" fill="none" stroke="${selectedColors[1]}" stroke-width="0.75" />
		`;
	} else if (layoutType === 1) {
		// Intersecting elegant rectangles / Bauhaus block-style
		artElements = `
			<rect x="80" y="80" width="180" height="280" fill="${selectedColors[0]}" opacity="0.4" />
			<rect x="140" y="160" width="180" height="280" fill="${selectedColors[1]}" opacity="0.3" />
			<line x1="80" y1="80" x2="320" y2="440" stroke="${selectedColors[1]}" stroke-width="1" opacity="0.5" />
		`;
	} else {
		// Flowing abstract curves/topography
		artElements = `
			<path d="M 0,${height / 2} Q 100,${height / 3} 200,${height / 2} T 400,${height / 2} L 400,${height} L 0,${height} Z" fill="${selectedColors[0]}" opacity="0.6" />
			<path d="M 0,${height / 1.7} Q 150,${height / 2.2} 250,${height / 1.7} T 400,${height / 1.5} L 400,${height} L 0,${height} Z" fill="${selectedColors[1]}" opacity="0.4" />
			<circle cx="280" cy="${height / 4}" r="30" fill="${selectedColors[0]}" opacity="0.9" />
		`;
	}

	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
			<!-- Background -->
			<rect width="100%" height="100%" fill="#FAF7F2" />
			<rect width="100%" height="100%" fill="url(#bg-grad)" opacity="0.25" />
			
			<defs>
				<linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="${selectedColors[0]}" />
					<stop offset="100%" stop-color="${selectedColors[1]}" />
				</linearGradient>
			</defs>
			
			<!-- Art piece -->
			<g id="art-layer">
				${artElements}
			</g>
			
			<!-- Elegant border -->
			<rect x="15" y="15" width="${width - 30}" height="${height - 30}" fill="none" stroke="${selectedColors[1]}" stroke-width="0.5" opacity="0.3" />
		</svg>
	`.trim();

	// Convert SVG string to base64 Data URL
	const base64Svg = Buffer.from(svg).toString('base64');
	return `data:image/svg+xml;base64,${base64Svg}`;
}
