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

		const systemContent = `You are an expert book cover design assistant for the ebook "${bookTitle}" (${genre}).

Interpret the user's instruction and return a JSON object of cover setting changes.

Current settings: ${JSON.stringify(currentSettings)}
${variantContext}

Fields (all optional — only include ones being changed):
titleFont: "Lora"|"Inter"|"Georgia"|"Arial"
titleColor, subtitleColor, authorColor: CSS hex string
titleSize: 18-54, subtitleSize: 12-28, authorSize: 12-32
alignment: "left"|"center"|"right"
textPosition: "top"|"middle"|"bottom"
overlayOpacity: 0-0.8
bgImagePrompt: detailed image generation prompt (only when user wants a new image)
variantIndex: 0|1|2|null (which variant slot to target; null = currently selected)

Rules:
- Convert color names to hex.
- For image requests, write a rich detailed bgImagePrompt.
- reply: 1–2 sentence friendly confirmation.
- Return ONLY JSON. No prose, no fences.

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
