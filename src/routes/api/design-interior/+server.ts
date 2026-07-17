import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ANTHROPIC_API_KEY, CLAUDE_CHAT_MODEL } from '$env/static/private';
import { INTERIOR_PRESETS } from '$lib/interiorDesigns';

const SUPPORTED_MEDIA_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp'
]);

async function getImageSource(imageUrl: string, origin: string): Promise<{ media_type: string; data: string } | null> {
	if (!imageUrl) return null;

	if (imageUrl.startsWith('data:')) {
		const parts = imageUrl.split(',');
		if (parts.length < 2) return null;
		
		const meta = parts[0];
		const data = parts[1];
		
		const mediaTypeMatch = meta.match(/^data:([^;]+)/);
		const mediaType = mediaTypeMatch ? mediaTypeMatch[1] : 'image/png';
		const isBase64 = meta.includes('base64');
		
		if (isBase64) {
			return { media_type: mediaType, data };
		} else {
			const decoded = decodeURIComponent(data);
			const base64Data = Buffer.from(decoded).toString('base64');
			return { media_type: mediaType, data: base64Data };
		}
	}

	try {
		const targetUrl = imageUrl.startsWith('/') ? new URL(imageUrl, origin).href : imageUrl;
		const res = await fetch(targetUrl);
		if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
		const arrayBuffer = await res.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		let contentType = res.headers.get('content-type') || 'image/jpeg';
		contentType = contentType.split(';')[0].trim();
		return {
			media_type: contentType,
			data: buffer.toString('base64')
		};
	} catch (err) {
		console.error('Error fetching/converting cover image:', err);
		return null;
	}
}

export const POST: RequestHandler = async ({ request, url }) => {
	// Define variables outside try/catch so they are accessible to programmatic fallback in catch block
	let coverSettings: any = null;
	let coverStyle = '';
	let bookTitle = '';
	let headerFooterPreset = '';
	let customInstructions = '';
	let claudeKey = '';

	const runProgrammaticFallback = () => {
		const primaryColor = coverSettings?.titleColor || '#1A1612';
		const accentColor = coverSettings?.authorColor || '#8E7453';
		const alignment = coverSettings?.alignment || 'left';
		const titleFont = coverSettings?.titleFont || 'Lora';

		const presetFn = INTERIOR_PRESETS[headerFooterPreset] || INTERIOR_PRESETS['Classical Editorial'];
		const design = presetFn({
			primary: primaryColor,
			accent: accentColor,
			alignment,
			titleFont
		});

		return json({
			success: true,
			design
		});
	};

	try {
		const body = await request.json();
		coverSettings = body.coverSettings;
		coverStyle = body.coverStyle;
		bookTitle = body.bookTitle;
		headerFooterPreset = body.headerFooterPreset;
		customInstructions = body.customInstructions;
		
		const apiKey = body.apiKey;
		claudeKey = apiKey || ANTHROPIC_API_KEY;

		// Fallback to programmatic mock design if no Claude API key is provided at all
		if (!claudeKey) {
			return runProgrammaticFallback();
		}

		const systemPrompt = `You are an elite, award-winning book interior designer and typography director.
Your task is to analyze the cover settings and cover image of the ebook "${bookTitle}" to design a cohesive, beautiful, premium, and industry-standard interior layout.

Cover Style Category: "${coverStyle}"
Cover Settings JSON:
${JSON.stringify(coverSettings)}

USER DESIGN PREFERENCES:
- Running Header/Footer Layout Preset: "${headerFooterPreset || 'Classical Editorial'}"
- Custom Styling Instructions: "${customInstructions || ''}"

MANDATORY PRESETS RULES:
- If layout preset is "Classical Editorial": running header should have serif font, light border-bottom line (e.g. 0.5px solid), page numbers centered at the bottom, italic/refined details.
- If layout preset is "Modern Minimalist": running header and footer should have sans-serif fonts, no border lines (border: 'none'), spacious letter tracking, and page numbers at the bottom (opacity 0.7).
- If layout preset is "Bold Tech / Graphic": running header has thick colored rules (e.g., 2.5px solid), heavy uppercase fonts, and accent badges.
- If layout preset is "Royal Elegance": running header and footer has elegant serif italic text, double rule borders (2.5px double), and center alignments.
- If layout preset is "Vintage Academic": running header and footer has academic Georgia font, dotted rules (1.5pt dotted), and centered numbers.
- If layout preset is "Aesthetic Literary": running header and footer has lowercase style, no lines, italic titles and page numbers.
- If layout preset is "Technical Mono": running header/footer has Courier/monospace fonts, dashed lines (1px dashed), and bold spacing.
- If layout preset is "Hidden / None": you must set "--r-header-opacity" to "0", "--r-footer-opacity" to "0", "--r-header-border" to "none", and "--r-footer-border" to "none" so they are completely hidden from the page.

If custom styling instructions are provided, you MUST prioritize and incorporate them. For example, if the user asks to "make header rules gold", choose a gold color (e.g. "#C9A84C") for header/footer rules. If the user asks for "dashed rule lines", set border style to dashed. Ensure the styling remains highly professional, elegant, readable, and consistent with publishing industry standards.

MANDATORY CONSTRAINTS:
1. TYPOGRAPHY SYNC: The interior headings font family ("--r-title-font", "--r-label-font", "--r-header-font") MUST match the cover's titleFont exactly:
   - If coverSettings.titleFont is "Inter" or "Arial", you MUST return '"Inter", sans-serif' or '"Arial", sans-serif'.
   - If coverSettings.titleFont is "Lora" or "Georgia", you MUST return '"Lora", serif' or '"Georgia", serif'.
2. WEIGHT & STYLE SYNC:
   - If coverSettings.titleFont is "Inter" or "Arial" (Bold Graphic look), titles MUST be uppercase ("--r-title-transform": "uppercase"), weight 800 ("--r-title-weight": "800"), and font style normal ("--r-title-style": "normal").
   - If coverSettings.titleFont is "Lora" or "Georgia" (Warm Editorial/Dark Minimalist), use Title Case ("--r-title-transform": "none"), weight 300 or 700, and font style italic ("--r-title-style": "italic") if it's warm editorial.
3. COLOR SYNC:
   - Use the cover's titleColor (or a legible dark contrast version of the cover background color theme) for "--r-title-color".
   - Use the cover's authorColor (or titleColor if authorColor is missing) for "--r-label-color", "--r-dropcap-color", blockquote borders, and rule borders.
   - If using sans-serif fonts (Bold Graphic look), the chapter label background ("--r-label-bg") MUST be the cover's authorColor (acting as an accent badge) and the text color ("--r-label-color") MUST be '#ffffff' (white) with padding '0.2rem 0.6rem' and border-radius '4px' to match the badge design.
4. ALIGNMENT SYNC:
   - The header alignment ("--r-header-align") and text alignment of chapter titles/labels MUST match the cover's alignment:
     - alignment: 'center' -> '--r-header-align': 'center'
     - alignment: 'left' -> '--r-header-align': 'flex-start'
     - alignment: 'right' -> '--r-header-align': 'flex-end'

Remember, the interior page background is always white/light (except inside the reading UI's optional night mode, which is handled automatically). You MUST return dark, readable interior text colors that contrast perfectly with a white page, but are color-cohesive with the cover's theme (e.g. if the cover is dark blue, use a deep navy blue for headers/titles).

Return a JSON object containing two keys:
- "analysis": A 2-3 sentence visual analysis of the cover's design elements and how your chosen interior styles complement it.
- "design": A JSON object of CSS variable mappings (values should be valid CSS expressions):
  - "--r-header-font": Font stack for running header text (e.g. '"Inter", sans-serif', '"Lora", serif')
  - "--r-header-color": Cohesive dark/readable color for running header text (hex)
  - "--r-header-border": CSS border-bottom value for the running header (e.g. '0.5px solid #8E7453')
  - "--r-header-transform": text-transform ('uppercase' | 'none')
  - "--r-header-letter-spacing": CSS letter-spacing
  - "--r-header-opacity": opacity value (e.g. '0.7')
  - "--r-footer-font": Font stack for running footer page number
  - "--r-footer-color": Cohesive dark/readable color for page number
  - "--r-footer-border": CSS border-top value for running footer line
  - "--r-footer-letter-spacing": CSS letter-spacing
  - "--r-footer-opacity": opacity (e.g. '0.7')
  - "--r-title-font": Font stack for the main chapter title
  - "--r-title-color": Legible dark title color matching the cover's primary color theme (e.g. deep navy, deep charcoal, warm dark brown)
  - "--r-title-transform": text-transform ('uppercase' | 'none')
  - "--r-title-letter-spacing": CSS letter-spacing
  - "--r-title-weight": font-weight ('300' | '400' | '600' | '700' | '800')
  - "--r-title-style": font-style for chapter title ('italic' | 'normal')
  - "--r-body-font": Font stack for main body text (e.g. '"Lora", serif', '"Inter", sans-serif')
  - "--r-label-font": Font stack for "Chapter X" label
  - "--r-label-color": Color for "Chapter X" label
  - "--r-label-transform": text-transform ('uppercase' | 'none')
  - "--r-label-letter-spacing": CSS letter-spacing
  - "--r-label-bg": background color for label badge (e.g. cover's accent color if Bold Graphic, otherwise 'transparent')
  - "--r-label-padding": CSS padding for label badge
  - "--r-label-border-radius": border-radius for label badge
  - "--r-rule-border": CSS border-top for the horizontal rule dividing chapter title (e.g. '1.5px solid #8E7453')
  - "--r-rule-width": rule width (e.g. '60px', '100%')
  - "--r-dropcap-font": Font stack for drop cap
  - "--r-dropcap-color": Color for drop cap
  - "--r-dropcap-weight": font-weight for drop cap
  - "--r-dropcap-style": font-style for drop cap ('italic' | 'normal')
  - "--r-blockquote-border": CSS border-left for blockquotes (e.g. '3.5px solid #8E7453')
  - "--r-blockquote-color": Color for blockquote text
  - "--r-blockquote-bg": background color for blockquotes
  - "--r-blockquote-padding": CSS padding for blockquotes
  - "--r-blockquote-border-radius": border-radius for blockquotes
  - "--r-header-align": flexbox layout alignment for chapter header ('flex-start' | 'center' | 'flex-end')
  - "--r-table-header-bg": matching dark/accent background for table headers (e.g. '#0F172A' or the cover's primary/accent color)
  - "--r-border": color for tables/borders matching the theme (e.g. '#e2e8f0' or a light accent tone)
  - "--r-chap-header-pad": padding-top before the chapter title block on page 1 (e.g. '0.25in', '0.5in'). Use smaller values (0.2in–0.35in) for modern/tech styles, larger (0.4in–0.6in) for literary/elegant styles.
  - "--r-chap-header-bg": background of the chapter header block (e.g. 'transparent', or the cover's primary color for a Bold/Tech style full-bleed band)
  - "--r-chap-header-bd-left": optional left accent bar (e.g. 'none', '6px solid #F59E0B', '4px dashed #4A9EFF'). Use for modern/tech/mono styles.
  - "--r-chap-header-bd-top": optional overline above the chapter title (e.g. 'none', '2px solid #8E7453', '3px double #C9A96E'). Use for minimalist and elegant styles.
  - "--r-chap-header-pd": padding inside the chapter header block (e.g. '0', '1rem 0 0 0', '1.25rem 1.5rem'). Must match --r-chap-header-bd-left and --r-chap-header-bg usage.
  - "--r-chap-header-mb": margin-bottom below the chapter header block (e.g. '1.5rem', '2rem')
  - "--r-chap-title-size": font-size of the chapter title (e.g. '20pt', '22pt', '24pt')

Return ONLY the raw JSON. No prose, no markdown code block backticks.
Format: {"analysis": "...", "design": {...}}`;

		const model = CLAUDE_CHAT_MODEL || 'claude-haiku-4-5-20251001';
		const prefill = '{\n  "analysis": "';
		
		let messages: any[] = [];
		const imageSource = coverSettings?.bgImageUrl ? await getImageSource(coverSettings.bgImageUrl, url.origin) : null;

		if (imageSource && SUPPORTED_MEDIA_TYPES.has(imageSource.media_type)) {
			messages = [
				{
					role: 'user',
					content: [
						{
							type: 'image',
							source: {
								type: 'base64',
								media_type: imageSource.media_type,
								data: imageSource.data
							}
						},
						{
							type: 'text',
							text: 'Analyze the attached cover image and the cover settings to generate a matching page interior design JSON. Follow all guidelines in the system prompt.'
						}
					]
				},
				{ role: 'assistant', content: prefill }
			];
		} else {
			messages = [
				{
					role: 'user',
					content: 'Analyze the cover settings and style to generate a matching page interior design JSON. Follow all guidelines in the system prompt.'
				},
				{ role: 'assistant', content: prefill }
			];
		}

		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': claudeKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model,
				max_tokens: 2000,
				system: systemPrompt,
				messages
			})
		});

		if (res.ok) {
			const data = await res.json();
			const text = (data.content?.find((c: any) => c.type === 'text')?.text || '').trim();
			const fullText = prefill + text;
			const result = JSON.parse(fullText);
			console.log('[design-interior] visual analysis of cover:', result.analysis);
			const usage = {
				model,
				inputTokens: data.usage?.input_tokens ?? 0,
				outputTokens: data.usage?.output_tokens ?? 0
			};
			return json({ success: true, design: result.design, usage });
		} else {
			const errText = await res.text();
			throw new Error(`Claude design generation failed (${res.status}): ${errText}`);
		}
	} catch (err: any) {
		console.warn('[design-interior] Claude design call failed or key is missing. Falling back to dynamic programmatic layout design. Reason:', err.message);
		return runProgrammaticFallback();
	}
};
