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
		const { instruction, apiKey, useMockMode, currentSettings, bookTitle, genre, variants } =
			await request.json();

		const claudeKey = apiKey || ANTHROPIC_API_KEY;

		// ── Mock mode ──────────────────────────────────────────────────────────
		if (useMockMode || !claudeKey) {
			await new Promise((r) => setTimeout(r, 400));
			return json({
				success: true,
				reply: `Got it: "${instruction}". In live mode this applies the changes immediately.`,
				mutations: {},
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

		const systemContent = `You are an award-winning Creative Director and book cover design expert specializing in commercial publishing for the ebook "${bookTitle}" (${genre}).

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
- bgImagePrompt: string — ONLY include when the user explicitly requests a new background image; write a detailed, cinematic, publishing-quality prompt (min 60 words)
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
   - No text, no typography in the image
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
					max_tokens: 400,
					system:     systemContent,
					messages:   [{ role: 'user', content: instruction }]
				})
			},
			8000
		);

		if (claudeRes.ok) {
			const data = await claudeRes.json();
			const raw = (data.content?.[0]?.text || '').trim();
			return json({ success: true, ...parseResponse(raw), source: 'claude' });
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
