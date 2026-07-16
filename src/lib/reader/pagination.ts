import { parseMarkdown, type BookMeta } from '$lib/diagrams';
import type { Chapter } from '$lib/types';
import type { PageSlice } from './types';

/**
 * Usable height of a reader page's body, in px. A block that would push past
 * this starts a new page, and a full-page plate is charged the whole budget.
 */
export const PAGE_BUDGET_PX = 700;

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
	bookMeta: BookMeta = {}
): Record<string, PageSlice[]> {
	const measureDiv = document.createElement('div');
	measureDiv.style.position = 'absolute';
	measureDiv.style.visibility = 'hidden';
	measureDiv.style.width = 'calc(8.5in - 2.75in)';
	measureDiv.style.fontSize = `${fontSize}px`;
	measureDiv.style.lineHeight = '1.85';
	measureDiv.style.fontFamily = bodyFont;
	measureDiv.className = 'chapter-body';
	document.body.appendChild(measureDiv);

	const pagesByChapter: Record<string, PageSlice[]> = {};
	for (const chapter of chapters) {
		if (chapter.status !== 'completed' || !chapter.content) {
			pagesByChapter[chapter.id] = [{ blocks: ['<p>This chapter has not been written yet.</p>'], startIdx: 0, endIdx: 1 }];
			continue;
		}
		const blocks = splitHtmlIntoBlocks(parseMarkdown(chapter.content, chapter.id, bookMeta));
		const pages: PageSlice[] = [];
		let currentBlocks: string[] = [];
		let currentHeight = chapter.illustrationUrl ? 440 : 160;
		let currentStartIdx = 0;
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const block = blocks[blockIndex];
			// A plate carrying --fullpage (diagram or image) owns its page, the
			// same rule exportHtml's paginator applies. Without this the reader
			// measures the plate's height and packs the next block in beside it.
			const isFullPage = block.includes('--fullpage');

			measureDiv.innerHTML = block;
			const blockHeight = isFullPage ? PAGE_BUDGET_PX : measureDiv.offsetHeight + 24;

			// Break before: a full-page plate never shares the page above it.
			if ((isFullPage || currentHeight + blockHeight > PAGE_BUDGET_PX) && currentBlocks.length > 0) {
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
	return pagesByChapter;
}
