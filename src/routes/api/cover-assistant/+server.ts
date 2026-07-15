import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ANTHROPIC_API_KEY } from '$env/static/private';

/**
 * POST /api/cover-assistant
 *
 * Sends the user's natural-language cover instruction to Claude.
 * Claude returns a JSON object describing exactly which cover settings
 * to mutate, and optionally which variant slot to target for image generation.
 *
 * Response shape:
 * {
 *   "reply":       "string — friendly confirmation",
 *   "variantIndex": number | null  — which variant slot to generate for (0/1/2)
 *   "mutations": {
 *     "titleFont", "titleColor", "subtitleColor", "authorColor",
 *     "titleSize", "subtitleSize", "authorSize",
 *     "alignment", "textPosition", "overlayOpacity",
 *     "bgImagePrompt"  — only when user wants a new image
 *   }
 * }
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const {
			instruction,
			apiKey,
			useMockMode,
			currentSettings,
			bookTitle,
			genre,
			variants          // array of { index, style, hasImage }
		} = await request.json();

		const activeKey = apiKey || ANTHROPIC_API_KEY;

		// ── Mock mode ──────────────────────────────────────────────────────────
		if (useMockMode || !activeKey) {
			await new Promise((r) => setTimeout(r, 800));
			return json({
				success: true,
				reply: `Understood: "${instruction}". In live mode Claude will parse this and apply the changes.`,
				mutations: {},
				variantIndex: null,
				source: 'mock'
			});
		}

		// ── Live — Claude 3.5 Sonnet ───────────────────────────────────────────
		const variantContext = variants?.length
			? `\nAvailable design variants (use variantIndex to target one for image generation):\n` +
			  variants.map((v: { index: number; style: string; hasImage: boolean }) =>
			    `  ${v.index}: "${v.style}" — ${v.hasImage ? 'has image' : 'no image yet'}`
			  ).join('\n')
			: '';

		const systemPrompt = `You are an expert book cover design assistant for the ebook "${bookTitle}" (${genre}).

Your job is to interpret the user's natural-language instruction and return a JSON object describing exactly which cover settings to change and, when applicable, which variant slot to generate an image for.

Current cover settings:
${JSON.stringify(currentSettings, null, 2)}
${variantContext}

Valid setting fields and their allowed values:
- titleFont:      "Lora" | "Inter" | "Georgia" | "Arial"
- titleColor:     any valid CSS hex color string (e.g. "#D4AF37")
- subtitleColor:  any valid CSS hex color string
- authorColor:    any valid CSS hex color string
- titleSize:      integer between 18 and 54 (pixels)
- subtitleSize:   integer between 12 and 28 (pixels)
- authorSize:     integer between 12 and 32 (pixels)
- alignment:      "left" | "center" | "right"
- textPosition:   "top" | "middle" | "bottom"
- overlayOpacity: number between 0 and 0.8
- bgImagePrompt:  a detailed AI image generation prompt string — only set this when the user wants a new background image or illustration generated

Rules:
- Only include mutation fields the instruction actually changes — omit all others.
- If the user asks for a color by name, convert it to the correct hex code.
- If the user mentions a specific variant style by name (e.g. "Dark Minimalist", "Warm Editorial", "Bold Graphic"), set variantIndex to that variant's index number so the image generates into the correct slot.
- If the user asks for a new image without specifying a variant, set variantIndex to null (the currently selected variant will be used).
- If the user only asks for typography/layout changes (no image), set bgImagePrompt to null and variantIndex to null.
- reply must be a concise, friendly 1–2 sentence confirmation of what you are doing.
- Return ONLY valid JSON — no markdown fences, no commentary.

Response format:
{"reply": "...", "variantIndex": <number or null>, "mutations": {...}}`;

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': activeKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: 'claude-3-5-sonnet-20241022',
				max_tokens: 600,
				system: systemPrompt,
				messages: [{ role: 'user', content: instruction }]
			})
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Anthropic API error (${response.status}): ${errText}`);
		}

		const data = await response.json();
		const raw = (data.content?.[0]?.text || '').trim();
		const clean = raw.startsWith('```')
			? raw.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim()
			: raw;

		let parsed: { reply: string; variantIndex: number | null; mutations: Record<string, unknown> };
		try {
			parsed = JSON.parse(clean);
		} catch {
			return json({ success: true, reply: raw, mutations: {}, variantIndex: null, source: 'live' });
		}

		return json({
			success: true,
			reply: parsed.reply || 'Done.',
			variantIndex: parsed.variantIndex ?? null,
			mutations: parsed.mutations || {},
			source: 'live'
		});

	} catch (error: any) {
		console.error('[cover-assistant] Error:', error);
		return json(
			{ success: false, error: error.message || 'Unexpected error.' },
			{ status: 500 }
		);
	}
};
