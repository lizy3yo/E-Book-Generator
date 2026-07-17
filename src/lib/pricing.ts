/**
 * Cost estimation for the "cost of this book" feature.
 *
 * Claude figures are exact: Anthropic returns real token counts per call, and
 * these are the current standard-tier list prices (no batch/cache discount —
 * none of these routes use either), so token count × rate matches what
 * Anthropic actually bills for these calls.
 *
 * Image and search figures are NOT exact — Kie.ai, 69labs, and Exa return no
 * cost or usage data in their responses, so those are flat per-call estimates
 * off each provider's public pricing, not a measurement of what was billed.
 * Any UI showing them must disclose that distinction.
 */

/** $ per million tokens, standard (non-batch, non-cached) tier. */
export const CLAUDE_PRICING: Record<string, { input: number; output: number }> = {
	'claude-sonnet-5': { input: 3, output: 15 },
	'claude-opus-4-8': { input: 5, output: 25 },
	'claude-haiku-4-5-20251001': { input: 1, output: 5 }
};

const DEFAULT_CLAUDE_PRICING = CLAUDE_PRICING['claude-sonnet-5'];

/** Strips a trailing `-YYYYMMDD` dated-snapshot suffix so a pinned model still prices correctly. */
function normaliseModelId(model: string): string {
	return model.replace(/-\d{8}$/, '');
}

/** Exact dollar cost of one Claude call from its real token usage. */
export function claudeCallCost(model: string, inputTokens: number, outputTokens: number): number {
	const rate =
		CLAUDE_PRICING[model] ??
		CLAUDE_PRICING[normaliseModelId(model)] ??
		DEFAULT_CLAUDE_PRICING;
	return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

/**
 * Flat per-call estimates for providers that report no usage/cost data.
 * Deliberately rough — these exist so the total isn't silently missing a
 * whole category, not to match a real invoice.
 */
export const ESTIMATED_COST_PER_IMAGE = 0.04; // Kie.ai / 69labs image generation
export const ESTIMATED_COST_PER_SEARCH = 0.005; // Exa search
