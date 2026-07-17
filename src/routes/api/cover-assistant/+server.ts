import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ANTHROPIC_API_KEY, CLAUDE_CHAT_MODEL } from '$env/static/private';

/**
 * POST /api/cover-assistant
 *
 * Interprets a natural-language cover design instruction and returns a
 * structured JSON object of mutations to apply to coverSettings.
 *
 * Model: CLAUDE_CHAT_MODEL (env) — defaults to claude-haiku-4-5-20251001
 *
 * Circuit breaker: after a hard failure (billing/auth), Claude is skipped
 * for CIRCUIT_RESET_MS to avoid wasting time on every subsequent request.
 */

const CIRCUIT_RESET_MS    = 5 * 60 * 1000;
let   claudeCircuitOpenUntil = 0;
const CLAUDE_HARD_FAIL_CODES = new Set([400, 401, 403]);

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { instruction, apiKey, useMockMode, currentSettings, bookTitle, genre, variants, referenceImage } =
			await request.json();

		const claudeKey = apiKey || ANTHROPIC_API_KEY;
		const hasImage  = !!(referenceImage?.mediaType && referenceImage?.data);
		// An attachment with no instruction is a question, not a command: the user
		// is showing the assistant something and expecting to be told what it is.
		const isImageOnly = hasImage && !instruction?.trim();

		// ── Mock mode ──────────────────────────────────────────────────────────
		if (useMockMode || !claudeKey) {
			await new Promise((r) => setTimeout(r, 400));

			// Mock mode has no vision — say so rather than inventing a reading of an
			// image nobody looked at.
			if (hasImage) {
				return json({
					success: true,
					reply: isImageOnly
						? "I can see you've attached an image, but mock mode can't actually read it — add an Anthropic API key in Settings and I'll describe its palette, typography and layout, then ask what you'd like applied."
						: `Mock mode can't read attached images, so I've worked from your text alone: "${instruction}".`,
					mutations: {},
					variantIndex: null,
					source: 'mock'
				});
			}

			const lower = instruction.toLowerCase();
			const mutations: Record<string, any> = {};
			let reply = `I've updated the cover design based on your feedback: "${instruction}".`;

			if (lower.includes('dark') || lower.includes('black') || lower.includes('deep')) {
				mutations.overlayOpacity = 0.45;
				mutations.bgImagePrompt = `Luxury dark minimalist professional book cover. Title: "${bookTitle}". Style: deep charcoal background with elegant lighting, incorporating: ${instruction}.`;
				reply = "I've deepened the overlay opacity and adjusted the prompt for a darker, more atmospheric background.";
			} else if (lower.includes('light') || lower.includes('warm') || lower.includes('cream')) {
				mutations.overlayOpacity = 0.1;
				mutations.bgImagePrompt = `Sophisticated warm editorial professional book cover. Title: "${bookTitle}". Style: warm cream tones, painterly textures, incorporating: ${instruction}.`;
				reply = "I've adjusted the lighting and prompt to bring out warmer, softer cream tones in the cover design.";
			} else if (lower.includes('modern') || lower.includes('sans') || lower.includes('clean')) {
				mutations.titleFont = 'Inter';
				mutations.bgImagePrompt = `High-impact commercial bold graphic book cover. Title: "${bookTitle}". Style: clean modern sans-serif typography with high contrast, incorporating: ${instruction}.`;
				reply = "I've updated the design prompt to use clean, modern sans-serif typography with a high-contrast layout.";
			} else {
				mutations.bgImagePrompt = `Refined professional book cover. Title: "${bookTitle}". Genre: ${genre}. Style: editorial illustration with custom elements, incorporating: ${instruction}.`;
			}

			return json({
				success: true,
				reply,
				mutations,
				variantIndex: null,
				source: 'mock'
			});
		}

		// ── Shared system prompt ───────────────────────────────────────────────
		const variantContext = variants?.length
			? `\nAvailable design variants:\n` +
			  (variants as { index: number; style: string; hasImage: boolean }[])
			    .map(v => `  ${v.index}: "${v.style}" — ${v.hasImage ? 'has image' : 'no image yet'}`)
			    .join('\n')
			: '';

		// The attachment changes what a turn MEANS, so it is stated in the system
		// prompt rather than left for the model to infer from the image's presence.
		const imageContext = !hasImage ? '' : isImageOnly
			? `

THE USER HAS ATTACHED A REFERENCE IMAGE AND WRITTEN NO INSTRUCTION.
Do NOT change the cover. They are showing you something and want to know what you see.
- Return an EMPTY mutations object ({}) and variantIndex null.
- In "reply", describe what you actually read from the image, as a creative director would: its colour palette (name the hex values you'd use), typography (serif/sans, weight, case, hierarchy), imagery treatment, graphic devices, and layout.
- Describe ONLY what is genuinely visible. Never invent detail you cannot see.
- End by asking which parts they want applied to "${bookTitle}" — the palette, the typography, the layout, or the whole design language.
- This reply is prose for a human, NOT a design change. Ignore the minimum-word and bgImagePrompt rules below; they do not apply to this turn.
- Reply may be up to 200 words. Still return ONLY the JSON object.`
			: `

THE USER HAS ATTACHED A REFERENCE IMAGE ALONGSIDE THEIR INSTRUCTION.
Read its design language — palette, typography, imagery treatment, graphic devices, layout — and apply it as their instruction directs.
Borrow the FORMAT only. Never copy the reference's subject matter, wording, artwork or logos into "${bookTitle}"; this book keeps its own title, author and subject.
Where the reference conflicts with the current settings, the reference wins — that is why they attached it.`;

		const systemContent = `You are an award-winning Creative Director and book cover design expert specializing in commercial publishing for the ebook "${bookTitle}" (${genre}).${imageContext}

Your role is to interpret the user's natural-language design instruction and return ONLY a structured JSON mutations object. You must think like a senior designer at a major publishing house (Penguin, Knopf, HarperCollins) who understands professional typography, color theory, and market-tested cover design conventions.

CURRENT COVER SETTINGS:
${JSON.stringify(currentSettings, null, 2)}
${variantContext}

AVAILABLE MUTATION FIELDS (only include fields that are being changed):
- titleFont: "Lora" | "Inter" | "Georgia" | "Arial"
  • Lora/Georgia = warm, literary, editorial (non-fiction, memoir, literary fiction)
  • Inter/Arial = clean, modern, bold (tech, business, self-help, Bold Graphic style)
- titleColor: hex color — the color of the main title text on the cover
- subtitleColor: hex color — must have high readability contrast on the cover background
- authorColor: hex color — typically subtle, below the title; also used as the interior accent color
- titleSize: number (18–54) — title font size in px
- subtitleSize: number (12–28) — subtitle font size in px
- authorSize: number (12–32) — author name font size in px
- alignment: "left" | "center" | "right"
- textPosition: "top" | "middle" | "bottom"
- overlayOpacity: number (0–0.8) — dark overlay on the background image for text legibility
- bgImagePrompt: string — Since the typography and visual layout are baked directly into the generated cover image, you MUST always generate and return an updated bgImagePrompt for any design instruction (including typography, color, layout, or background changes). Describe the entire cover design in detail (min 60 words), incorporating all of the user's requested refinements (e.g. font style, colors, lighting, theme) so that the newly generated image reflects their request.
- variantIndex: 0 | 1 | 2 | null — which design slot to update (null = currently selected)

PROFESSIONAL DESIGN RULES:
1. COLOR HARMONY: Colors must work cohesively. Never pick random colors. Use curated palettes:
   - Dark Minimalist style → rich charcoal/near-black backgrounds, gold/silver accents, white or pale-gold title text
   - Warm Editorial style → cream, warm ivory, deep brown or warm dark red tones; never pure black or bright neon
   - Bold Graphic style → high-contrast navy/black + pure white or bright accent; strong visual impact
2. FONT PAIRING: Pair serif (Lora/Georgia) with smaller serif or italic for subtitles. Pair sans (Inter/Arial) with bold weight for impact.
3. SIZE HIERARCHY: titleSize > subtitleSize > authorSize. Never make author larger than subtitle.
4. OVERLAY: If the user wants text to pop over a photo background, recommend overlayOpacity 0.35–0.55. For illustrated/painted backgrounds, 0.1–0.2.
5. COLOR NAMES → HEX: Always convert color names. Examples: "gold" → "#C9A84C", "navy" → "#1A2744", "cream" → "#FAF7F2", "charcoal" → "#1A1612", "crimson" → "#8B1A1A", "forest green" → "#1E4D2B"
6. IMAGE PROMPTS: When writing bgImagePrompt, always include:
   - Style description (Dark Minimalist / Warm Editorial / Bold Graphic)
   - Book title and genre context
   - Lighting quality (cinematic chiaroscuro / warm soft natural / high-contrast dramatic)
   - Specific visual subject directly relevant to "${bookTitle}"
   - Quality descriptor (photorealistic render / painterly editorial illustration / bold vector graphic)
   - Include the title and author name explicitly in the prompt, describing their placement, font style, and colors (e.g., "Bold elegant white serif title text 'THE BOOK TITLE' dominating the top half..."), so the text is generated directly as part of the visual composition.
   - Minimum 60 words

RESPONSE FORMAT:
- reply: 1–2 sentence friendly, professional confirmation of what you changed
- variantIndex: null (or 0/1/2 if switching slots)
- mutations: only the fields you are changing

Return ONLY valid JSON. No markdown. No explanation outside the JSON.
Format: {"reply":"...","variantIndex":null,"mutations":{}}`;

		// ── Parse Claude text → structured result ──────────────────────────────
		function parseResponse(raw: string) {
			let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

			// Attempt 1: direct parse
			try {
				const p = JSON.parse(text) as Record<string, unknown>;
				return {
					reply:        String(p.reply        ?? 'Done.'),
					variantIndex: p.variantIndex != null ? Number(p.variantIndex) : null,
					mutations:    (p.mutations as Record<string, unknown>) ?? {}
				};
			} catch { /* extract */ }

			const s = text.indexOf('{');
			if (s !== -1) {
				const partial = text.slice(s);

				// Attempt 2: brace-match
				let d = 0, e = -1;
				for (let i = 0; i < partial.length; i++) {
					if (partial[i] === '{') d++;
					else if (partial[i] === '}' && --d === 0) { e = i; break; }
				}
				if (e !== -1) {
					try {
						const p = JSON.parse(partial.slice(0, e + 1)) as Record<string, unknown>;
						return {
							reply:        String(p.reply        ?? 'Done.'),
							variantIndex: p.variantIndex != null ? Number(p.variantIndex) : null,
							mutations:    (p.mutations as Record<string, unknown>) ?? {}
						};
					} catch { /* repair */ }
				}

				// Attempt 3: truncation repair
				let open = 0;
				for (const ch of partial) { if (ch === '{') open++; else if (ch === '}') open--; }
				if (open > 0) {
					try {
						const p = JSON.parse(partial + '}'.repeat(open)) as Record<string, unknown>;
						return {
							reply:        String(p.reply        ?? 'Done.'),
							variantIndex: p.variantIndex != null ? Number(p.variantIndex) : null,
							mutations:    (p.mutations as Record<string, unknown>) ?? {}
						};
					} catch { /* regex */ }
				}

				// Attempt 4: regex extraction
				const replyMatch = partial.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
				const mutMatch   = partial.match(/"mutations"\s*:\s*(\{[^}]*\})/);
				if (replyMatch) {
					let mutations: Record<string, unknown> = {};
					if (mutMatch) { try { mutations = JSON.parse(mutMatch[1]); } catch { /* ignore */ } }
					return { reply: replyMatch[1], variantIndex: null, mutations };
				}
			}

			return { reply: text, variantIndex: null, mutations: {} };
		}

		/**
		 * Guarantee that a design turn carries an image prompt.
		 *
		 * Generated covers bake their typography into the artwork, so the studio
		 * skips every text overlay for them: a mutation like titleColor with no
		 * accompanying bgImagePrompt is invisible, and the client only renders when
		 * a prompt is present — so the author's instruction lands as a silent no-op.
		 * The model is told to always return one, but instruction is not a
		 * guarantee, so rebuild it from the current prompt plus the author's own
		 * words rather than drop their request.
		 *
		 * Turns with NO mutations are left alone by design: those are questions and
		 * image readings, answered in prose, and must not spend an image render.
		 */
		function ensureImagePrompt(result: ReturnType<typeof parseResponse>) {
			const m = result.mutations;
			if (!Object.keys(m).length || m.bgImagePrompt) return result;

			const base = String((currentSettings?.bgImagePrompt as string) ?? '').trim();
			m.bgImagePrompt = base
				? `${base} Additionally, apply this refinement: ${instruction}.`
				: `Professional publisher-quality book cover for "${bookTitle}" (${genre}). ${instruction}.`;
			return result;
		}

		// ── Fetch helper with AbortController timeout ──────────────────────────
		async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
			const ctrl  = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), timeoutMs);
			try   { return await fetch(url, { ...init, signal: ctrl.signal }); }
			finally { clearTimeout(timer); }
		}

		// ── Circuit-breaker guard ──────────────────────────────────────────────
		if (Date.now() < claudeCircuitOpenUntil) {
			const remainSec = Math.ceil((claudeCircuitOpenUntil - Date.now()) / 1000);
			throw new Error(`Claude is temporarily unavailable. Retry in ${remainSec}s.`);
		}

		// ── Call Claude ────────────────────────────────────────────────────────
		const model = CLAUDE_CHAT_MODEL || 'claude-haiku-4-5-20251001';

		// The image leads the turn — Claude attends to text that follows an image
		// more reliably than text that precedes it.
		const userContent = hasImage
			? [
					{
						type: 'image',
						source: {
							type:       'base64',
							media_type: referenceImage.mediaType,
							data:       referenceImage.data
						}
					},
					{
						type: 'text',
						text: instruction?.trim() || 'Describe this reference cover, then ask me which parts to apply.'
					}
			  ]
			: instruction;

		const claudeRes = await fetchWithTimeout(
			'https://api.anthropic.com/v1/messages',
			{
				method:  'POST',
				headers: {
					'Content-Type':      'application/json',
					'x-api-key':         claudeKey,
					'anthropic-version': '2023-06-01'
				},
				body: JSON.stringify({
					model,
					// A described reading runs longer than a 1–2 sentence confirmation.
					max_tokens: isImageOnly ? 900 : 400,
					system:     systemContent,
					messages:   [{ role: 'user', content: userContent }]
				})
			},
			// Vision adds real latency; 8s reliably aborts a legitimate read.
			hasImage ? 30000 : 8000
		);

		if (claudeRes.ok) {
			const data = await claudeRes.json();
			const raw = (data.content?.find((c: any) => c.type === 'text')?.text || '').trim();
			const usage = {
				model,
				inputTokens: data.usage?.input_tokens ?? 0,
				outputTokens: data.usage?.output_tokens ?? 0
			};
			return json({ success: true, ...ensureImagePrompt(parseResponse(raw)), usage, source: 'claude' });
		}

		// Open circuit on hard billing/auth failures
		if (CLAUDE_HARD_FAIL_CODES.has(claudeRes.status)) {
			claudeCircuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
		}

		const errText = await claudeRes.text();
		throw new Error(`Anthropic API error (${claudeRes.status}): ${errText}`);

	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : 'Unexpected error.';
		console.error('[cover-assistant] Error:', msg);
		return json({ success: false, error: msg }, { status: 500 });
	}
};
