import { parseMarkdown, type BookMeta } from '$lib/diagrams';
import type { Chapter } from '$lib/types';
import type { PageSlice } from './types';

/**
 * Usable height of a reader page's body, in px. A block that would push past
 * this starts a new page, and a full-page plate is charged the whole budget.
 *
 * MEASURED, not derived: the rendered .book-page-card body on the 6x9 trim is
 * 719px. This is set under it, leaving ~4 lines of slack, because the paginator
 * measures in a detached div whose font context is close to the page's but not
 * identical — the slack is what absorbs that difference.
 *
 * The two failure modes are not symmetric. Too low only wastes page space; too
 * high runs the last block of every page under the footer. So it errs low.
 *
 * It was 700 against an 11in page. If the trim changes, re-measure — do not
 * scale this by eye.
 */
export const PAGE_BUDGET_PX = 660;

/** The page's real text column: 6in trim minus 0.52in each side. A block
 *  measured at a width it will never be rendered at returns a height it will
 *  never have, so both measurers below are pinned to this. */
const COLUMN_CSS = 'calc(6in - 1.04in)';

/**
 * What a chapter opener costs before one block of prose is placed.
 *
 * The opener's header and illustration are drawn by the page TEMPLATE, not as
 * content blocks, so the paginator never measures them — it must reserve their
 * height or it will pack text into space already spoken for.
 *
 * This was two flat numbers (160, or 440 with an illustration) and they were
 * wrong: a real opener on the 6x9 trim measures 254 (header) + 470
 * (illustration) = 724px against a 660px budget — under-reserved by 284px, and
 * the browser clipped the overflow mid-word at the foot of the page.
 *
 * The chrome is constant. The TITLE is not: its height is however many lines it
 * wraps to, and a three-line title is triple a one-line one. No constant can
 * express that, which is why the title is measured rather than assumed.
 */
const OPENER = {
	/** .chapter-header minus the title's own box — the header's margins (34 top,
	 *  24 bottom), the title's 24px bottom margin, the 2px rule, and the header's
	 *  internal spacing. Measured: a 254px header around a 110px three-line title
	 *  leaves 144. */
	CHROME_WITH_LABEL: 144,
	/** The same, less the eyebrow (22px + 9.6px margin) that strict presets hide
	 *  via --r-label-display: none. */
	CHROME_NO_LABEL: 112,
	/** .chapter-illust — a 380px-max image (390px box) plus 40px margins top and
	 *  bottom. Measured at 470. */
	ILLUSTRATION: 470,
	/** line-height of .chapter-title, needed to measure a wrapped title. */
	TITLE_LINE_HEIGHT: 1.25
} as const;

/**
 * The type a chapter title is actually set in, so its height can be measured
 * rather than guessed. Supplied by the caller, which owns the design tokens —
 * the paginator has no business reading them itself.
 */
export interface OpenerMetrics {
	titleFont: string;
	/** A CSS length, e.g. '22pt' — from --r-chap-title-size. */
	titleSize: string;
	/** From --r-title-weight. */
	titleWeight: string;
	/** False when a preset hides the eyebrow via --r-label-display: none. */
	showLabel: boolean;
}

export function splitHtmlIntoBlocks(html: string): string[] {
	if (typeof document === 'undefined') return [html];
	const temp = document.createElement('div');
	temp.innerHTML = html;
	return Array.from(temp.children).map((child) => child.outerHTML);
}

export function calculateOverallPageNumber(chapters: Chapter[], pagesByChapter: Record<string, PageSlice[]>, chapterIndex: number, pageIndex: number): number {
	return chapters.slice(0, chapterIndex).reduce((total, chapter) => total + (pagesByChapter[chapter.id]?.length ?? 1), 0) + pageIndex + 1;
}

export function paginateChapters(
	chapters: Chapter[],
	fontSize: number,
	bodyFont: string,
	bookMeta: BookMeta = {},
	opener?: Partial<OpenerMetrics>
): Record<string, PageSlice[]> {
	const measureDiv = document.createElement('div');
	measureDiv.style.position = 'absolute';
	measureDiv.style.visibility = 'hidden';
	measureDiv.style.width = COLUMN_CSS;
	measureDiv.style.fontSize = `${fontSize}px`;
	measureDiv.style.lineHeight = '1.85';
	measureDiv.style.fontFamily = bodyFont;
	measureDiv.className = 'chapter-body';
	document.body.appendChild(measureDiv);

	// A second measurer set in the TITLE's type rather than the body's. Styled
	// inline rather than by class: the page's own rules are component-scoped and
	// would never reach a detached node.
	const titleDiv = document.createElement('div');
	titleDiv.style.position = 'absolute';
	titleDiv.style.visibility = 'hidden';
	titleDiv.style.width = COLUMN_CSS;
	titleDiv.style.fontFamily = opener?.titleFont ?? bodyFont;
	titleDiv.style.fontSize = opener?.titleSize ?? '2rem';
	titleDiv.style.fontWeight = opener?.titleWeight ?? '700';
	titleDiv.style.lineHeight = String(OPENER.TITLE_LINE_HEIGHT);
	document.body.appendChild(titleDiv);

	const showLabel = opener?.showLabel !== false;

	const openerReserve = (chapter: Chapter): number => {
		titleDiv.textContent = chapter.title ?? '';
		const chrome = showLabel ? OPENER.CHROME_WITH_LABEL : OPENER.CHROME_NO_LABEL;
		return chrome + titleDiv.offsetHeight + (chapter.illustrationUrl ? OPENER.ILLUSTRATION : 0);
	};

	const pagesByChapter: Record<string, PageSlice[]> = {};
	for (const chapter of chapters) {
		if (chapter.status !== 'completed' || !chapter.content) {
			pagesByChapter[chapter.id] = [{ blocks: ['<p>This chapter has not been written yet.</p>'], startIdx: 0, endIdx: 1 }];
			continue;
		}
		const blocks = splitHtmlIntoBlocks(parseMarkdown(chapter.content, chapter.id, bookMeta));
		const pages: PageSlice[] = [];
		let currentBlocks: string[] = [];
		let currentHeight = openerReserve(chapter);
		let currentStartIdx = 0;
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const block = blocks[blockIndex];
			// A plate carrying --fullpage (diagram or image) owns its page, the
			// same rule exportHtml's paginator applies. Without this the reader
			// measures the plate's height and packs the next block in beside it.
			const isFullPage = block.includes('--fullpage');

			measureDiv.innerHTML = block;
			const blockHeight = isFullPage ? PAGE_BUDGET_PX : measureDiv.offsetHeight + 24;

			// A page is occupied if it holds blocks OR if the opener's header and
			// illustration have already claimed it. That second half is the part
			// that was missing: those are drawn by the template, so the block list
			// is still empty while the sheet is in fact full, and a guard of
			// `currentBlocks.length > 0` alone waved the first paragraph onto a
			// page with no room for it. On a 6x9 opener carrying an illustration
			// the reserve exceeds the entire budget, so the correct first page
			// holds the header and the illustration and no prose at all.
			const pageIsOccupied = currentBlocks.length > 0 || currentHeight > 0;

			// Break before: a full-page plate never shares the page above it.
			if ((isFullPage || currentHeight + blockHeight > PAGE_BUDGET_PX) && pageIsOccupied) {
				pages.push({ blocks: currentBlocks, startIdx: currentStartIdx, endIdx: blockIndex });
				currentBlocks = []; currentHeight = 0; currentStartIdx = blockIndex;
			}

			currentBlocks.push(block);
			currentHeight += blockHeight;

			// Break after: nothing follows a full-page plate onto its page.
			if (isFullPage) {
				pages.push({ blocks: currentBlocks, startIdx: currentStartIdx, endIdx: blockIndex + 1 });
				currentBlocks = []; currentHeight = 0; currentStartIdx = blockIndex + 1;
			}
		}
		if (currentBlocks.length) pages.push({ blocks: currentBlocks, startIdx: currentStartIdx, endIdx: blocks.length });
		pagesByChapter[chapter.id] = pages;
	}
	document.body.removeChild(measureDiv);
	document.body.removeChild(titleDiv);
	return pagesByChapter;
}
