/**
 * Book sizing — the single source of truth for turning a page count into a
 * chapter plan. Every consumer (concept form, outline prompt, token budgets)
 * reads from here so the arithmetic can't drift between them.
 */

/** Industry convention for a trade paperback: ~250 words per page. */
export const WORDS_PER_PAGE = 250;

export const MIN_PAGES = 50;
export const MAX_PAGES = 600;

/** Page counts offered as one-click presets in the concept form. */
export const PAGE_PRESETS = [50, 100, 200, 300, 600] as const;

/**
 * Words we aim to put in a chapter. Page count drives the NUMBER of chapters,
 * not their size — a chapter is a unit of reading, and 20k-word chapters read
 * badly regardless of what the model can emit.
 */
const TARGET_WORDS_PER_CHAPTER = 5_000;

/**
 * Hard ceiling on a chapter. A chapter is written in ONE response, and the
 * output cap is per-response (~64k tokens). At ~1.4 tokens/word, 6k words is
 * ~8.4k tokens — comfortably inside it, with room for the verify pass that
 * re-emits the whole chapter afterwards. Chapters are added rather than grown
 * past this; growing them instead is what truncates a draft mid-sentence.
 */
const MAX_WORDS_PER_CHAPTER = 6_000;

/** Below this a book has no shape, however few pages were asked for. */
const MIN_CHAPTERS = 3;

/**
 * How many chapters are written in parallel before pausing to fold their output
 * into the book bible. Fixed rather than scaled with chapterCount: it is a
 * COHERENCE knob, not a sizing one. It sets how far a chapter's knowledge can
 * lag the book (at most one batch), and that staleness should not get worse just
 * because the book got longer — a 30-chapter book is exactly where you least
 * want batch 6 blind to batch 5. Smaller = more coherent, more fold round-trips.
 */
export const BATCH_SIZE = 5;

export interface BookPlan {
	pageCount: number;
	totalWords: number;
	chapterCount: number;
	wordsPerChapter: number;
}

/** Split a list into consecutive batches of at most BATCH_SIZE. */
export function batched<T>(items: T[], size: number = BATCH_SIZE): T[][] {
	const n = Math.max(1, Math.floor(size));
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
	return out;
}

export function clampPageCount(pages: number): number {
	if (!Number.isFinite(pages)) return 100;
	return Math.min(MAX_PAGES, Math.max(MIN_PAGES, Math.round(pages)));
}

/**
 * Legacy books persisted `length: 'short' | 'medium' | 'long'` before page
 * counts existed. Map them onto the new scale so an existing book keeps
 * generating at roughly the size its author chose.
 */
export function pagesFromLegacyLength(length: string | undefined): number {
	return length === 'short' ? 60
		: length === 'long'   ? 200
		:                       100; // 'medium' and anything unrecognised
}

/**
 * Resolve a book's page count from either field, preferring the explicit one.
 * Books written before the page-count control only carry `length`.
 */
export function resolvePageCount(book: { pageCount?: number; length?: string }): number {
	return typeof book.pageCount === 'number'
		? clampPageCount(book.pageCount)
		: pagesFromLegacyLength(book.length);
}

/** Derive the chapter plan for a page count. */
export function planForPages(pages: number): BookPlan {
	const pageCount  = clampPageCount(pages);
	const totalWords = pageCount * WORDS_PER_PAGE;

	// Chapter COUNT absorbs the length; chapter SIZE stays readable.
	let chapterCount = Math.max(MIN_CHAPTERS, Math.round(totalWords / TARGET_WORDS_PER_CHAPTER));

	// If that still leaves chapters over the per-response ceiling, add more
	// rather than letting any single chapter grow past what one call can emit.
	chapterCount = Math.max(chapterCount, Math.ceil(totalWords / MAX_WORDS_PER_CHAPTER));

	return {
		pageCount,
		totalWords,
		chapterCount,
		wordsPerChapter: Math.round(totalWords / chapterCount)
	};
}

/** Convenience: the plan for a book holding either field. */
export function planForBook(book: { pageCount?: number; length?: string }): BookPlan {
	return planForPages(resolvePageCount(book));
}
