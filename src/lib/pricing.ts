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
/**
 * Per-image list price by image provider, for the exact request this app makes.
 *
 *   kie    — Black Forest Labs FLUX.2 [pro] text-to-image at 1K, billed through
 *            Kie.ai at 5 credits = $0.025/image (Kie published price, Jul 2026;
 *            BFL official $0.03). Covers and illustrations both request 1K, so
 *            one rate covers both.
 *   69labs — 69labs is subscription / credit-based, not pay-per-call, so it has
 *            no single per-call price. This is the entry image-credit-pack rate,
 *            $50 / 1,000 credits = $0.05/image for a standard 1-credit model
 *            (69labs.vip pricing, Jul 2026); larger packs fall to ~$0.03 and
 *            heavier models cost >1 credit, so treat it as approximate.
 *
 * The provider is a global setting, not recorded per book (see ApiKeys), so the
 * estimate prices a book's images at whichever provider is currently selected.
 * See src/routes/api/image/+server.ts for the provider calls.
 */
export const IMAGE_COST_PER_IMAGE: Record<'kie' | '69labs', number> = {
	kie:      0.025,
	'69labs': 0.05
};

/**
 * Per-image estimate for a provider. Falls back to the Kie rate for any unknown
 * value, since Kie is the app's default image provider.
 */
export function imageUnitCost(provider: string | null | undefined): number {
	return IMAGE_COST_PER_IMAGE[(provider ?? '') as 'kie' | '69labs'] ?? IMAGE_COST_PER_IMAGE.kie;
}

/**
 * Per-call list price for the Exa request the app makes: a neural POST /search
 * returning ≤10 results with inline text contents, billed at $7 / 1,000
 * requests = $0.007/search, with the first 10 results' contents included (Exa
 * published pricing, Jul 2026). The app asks for 5 results, so there is no
 * per-result add-on. See src/routes/api/research/+server.ts.
 */
export const ESTIMATED_COST_PER_SEARCH = 0.007;

/**
 * Every distinct generated (billed) image embedded in a chapter's prose.
 *
 * Real images reach chapter content in three stored forms: a rendered
 * `<img src="…">` plate spliced in by the edit drawer, a markdown `![alt](url)`,
 * or a ```plate / ```diagram fence carrying an `image:` / `url:` line. All three
 * point at a raster image the image provider generated and billed for.
 *
 * SVG and chart diagrams (bar, pie, flowchart, hierarchy, …) are drawn from
 * data by code and carry no such URL, so they are correctly skipped — counting
 * them as billed images would inflate the estimate for pictures that cost
 * nothing to make.
 */
function chapterContentImageUrls(content: string): string[] {
	if (!content) return [];
	const urls: string[] = [];
	const re = /(?:<img[^>]+src=["']([^"']+)["'])|(?:!\[[^\]]*\]\(([^)\s]+)[^)]*\))|(?:^[ \t]*(?:image|url)[ \t]*:[ \t]*(\S+))/gim;
	for (const m of content.matchAll(re)) {
		const u = (m[1] || m[2] || m[3] || '').trim();
		if (u && (/^https?:\/\//i.test(u) || /^data:image\//i.test(u))) urls.push(u);
	}
	return urls;
}

/**
 * How many generated images a book represents, for cost estimation.
 *
 * `BookUsage.images` counts every BILLED generation as it happens — cover
 * candidates, chapter illustrations, embedded plates, and regenerations — and
 * is the most faithful figure when it is present. But it is 0 for books whose
 * images were generated before that counter existed (or in mock mode), which is
 * why a book plainly full of pictures could still report "Images (0) — $0.00".
 *
 * So the fallback counts the images the book actually carries, by collecting
 * every distinct image URL it holds:
 *   • cover art — every rendered candidate plus the chosen cover,
 *   • each chapter's illustration plate,
 *   • every raster image embedded in chapter prose (drawer plates, markdown
 *     images, ```plate fences) — but NOT the code-drawn SVG/chart diagrams,
 *     which cost nothing.
 * URLs are deduplicated, so the chosen cover (which repeats a candidate's URL)
 * and any image referenced twice are each counted once.
 *
 * The tracked count and the collected count are combined with max(), never
 * summed: the tracked count already covers the images the book kept, so adding
 * them would double-count. max() keeps the tracked figure when regenerations
 * pushed it above the surviving set, and the collected figure when the tracker
 * missed the generations entirely.
 */
export function estimatedImageCount(book: {
	usage?: { images?: number };
	coverOptions?: { imageUrl?: string }[];
	coverSettings?: { bgImageUrl?: string | null };
	chapters?: { illustrationUrl?: string | null; content?: string }[];
}): number {
	const tracked = book.usage?.images ?? 0;

	const urls = new Set<string>();
	const add = (u?: string | null) => {
		const t = (u ?? '').trim();
		if (t) urls.add(t);
	};

	// Cover art — every rendered candidate, plus the chosen cover (usually a
	// duplicate of one candidate's URL, so the Set collapses it).
	for (const o of book.coverOptions ?? []) add(o.imageUrl);
	add(book.coverSettings?.bgImageUrl);

	// Per-chapter illustration plate + any images embedded in the prose.
	for (const c of book.chapters ?? []) {
		add(c.illustrationUrl);
		for (const u of chapterContentImageUrls(c.content ?? '')) add(u);
	}

	return Math.max(tracked, urls.size);
}
