import type { Book } from '$lib/types';

/** Extract the Nth diagram code block content from chapter markdown */
export function getDiagramBlockRaw(chapterContent: string, index: number): string {
	const re = /```(?:diagram|mermaid)\r?\n([\s\S]*?)```/g;
	let i = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(chapterContent)) !== null) {
		if (i === index) return m[1];
		i++;
	}
	return '';
}

/**
 * Unified splice helper for all editable visual block kinds.
 * 'fence'  – replaces the Nth ```diagram``` code fence
 * 'table'  – replaces the first occurrence of the original raw markdown table
 * 'inline' – replaces the first occurrence of the original raw HTML block
 * 'image'  – replaces the first occurrence of the original image markdown
 */
export function spliceVisualBlock(
	fullMarkdown: string,
	kind: 'fence' | 'table' | 'inline' | 'image',
	original: string,
	index: number,
	replacement: string,
	asImage = false
): string {
	if (kind === 'fence') {
		const re = /```(?:diagram|mermaid)\r?\n[\s\S]*?```/g;
		let i = 0, m: RegExpExecArray | null;
		while ((m = re.exec(fullMarkdown)) !== null) {
			if (i === index) {
				const block = asImage ? replacement : `\`\`\`diagram\n${replacement}\n\`\`\``;
				return fullMarkdown.slice(0, m.index) + block + fullMarkdown.slice(m.index + m[0].length);
			}
			i++;
		}
		return asImage
			? `${fullMarkdown}\n\n${replacement}`
			: `${fullMarkdown}\n\n\`\`\`diagram\n${replacement}\n\`\`\``;
	}

	if (kind === 'table' || kind === 'inline' || kind === 'image') {
		if (original && fullMarkdown.includes(original)) {
			return fullMarkdown.replace(original, replacement);
		}
		return `${fullMarkdown}\n\n${replacement}`;
	}

	return fullMarkdown;
}

/**
 * Drop a chapter's first content block when it is just the chapter title
 * repeated as a heading. The template already renders the title in
 * `.chapter-header`; a model that also opens its prose with "# <Same Title>"
 * produces a page that shows the title twice in a row. Only an exact
 * (case-insensitive) match is stripped — a genuine section heading that
 * merely resembles the title is left alone.
 */
export function stripDuplicateChapterHeading(blocks: string[], chapterTitle: string): string[] {
	if (!blocks.length || !chapterTitle) return blocks;
	const match = blocks[0].match(/^<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>$/i);
	if (!match) return blocks;
	const headingText = match[1].replace(/<[^>]+>/g, '').trim().toLowerCase();
	if (headingText !== chapterTitle.trim().toLowerCase()) return blocks;
	return blocks.slice(1);
}

/**
 * A `<ul>`/`<ol>` block taller than a single page cannot fit as one atom —
 * the pagination loop places or defers a whole block at a time, so an
 * oversized list was simply left to overflow past the page's `overflow:
 * hidden` and got clipped mid-item. This pre-splits such a list into several
 * same-tag chunks, each measured to fit within `maxHeight`, so the ordinary
 * block-by-block paginator can place them like any other block.
 *
 * `measureDiv` must already be attached to the document and styled to the
 * real column width/font the caller paginates against.
 */
export function splitOversizedLists(blocks: string[], measureDiv: HTMLElement, maxHeight: number): string[] {
	const out: string[] = [];
	for (const block of blocks) {
		const match = block.match(/^<(ul|ol)([^>]*)>([\s\S]*)<\/\1>$/i);
		if (!match) { out.push(block); continue; }

		measureDiv.innerHTML = block;
		if (measureDiv.offsetHeight <= maxHeight) { out.push(block); continue; }

		const [, tag, attrs, inner] = match;
		const items = inner.match(/<li[\s\S]*?<\/li>/gi) ?? [];
		if (items.length <= 1) { out.push(block); continue; }

		let chunk: string[] = [];
		for (const item of items) {
			const trial = `<${tag}${attrs}>${chunk.join('')}${item}</${tag}>`;
			measureDiv.innerHTML = trial;
			if (measureDiv.offsetHeight > maxHeight && chunk.length > 0) {
				out.push(`<${tag}${attrs}>${chunk.join('')}</${tag}>`);
				chunk = [item];
			} else {
				chunk.push(item);
			}
		}
		if (chunk.length) out.push(`<${tag}${attrs}>${chunk.join('')}</${tag}>`);
	}
	return out;
}

/**
 * Same problem as `splitOversizedLists`, for tables: a table taller than a
 * single page is one atomic block, so a long one simply overflowed past the
 * page and was clipped mid-row. This pre-splits such a table's `<tbody>`
 * into several row chunks, each measured to fit within `maxHeight`. Every
 * chunk repeats the full markup ahead of `<tbody>` — including `<thead>` —
 * so the column headers are never separated from the rows that follow them,
 * the industry-standard convention for a table that spans multiple pages.
 * The edit-trigger button (present only on the original block) is dropped
 * from continuation chunks so it doesn't appear twice for one table.
 */
export function splitOversizedTables(blocks: string[], measureDiv: HTMLElement, maxHeight: number): string[] {
	const out: string[] = [];
	for (const block of blocks) {
		if (!/<table[\s>]/i.test(block)) { out.push(block); continue; }

		measureDiv.innerHTML = block;
		if (measureDiv.offsetHeight <= maxHeight) { out.push(block); continue; }

		const tbodyMatch = block.match(/<tbody>([\s\S]*?)<\/tbody>/i);
		if (!tbodyMatch || tbodyMatch.index === undefined) { out.push(block); continue; }

		const rows = tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
		if (rows.length <= 1) { out.push(block); continue; }

		const before = block.slice(0, tbodyMatch.index);
		const beforeContinued = before.replace(/<div class="diagram-box__actions">[\s\S]*?<\/div>/i, '');
		const after = block.slice(tbodyMatch.index + tbodyMatch[0].length);

		let chunk: string[] = [];
		let isFirstChunk = true;
		const flush = () => {
			if (!chunk.length) return;
			const prefix = isFirstChunk ? before : beforeContinued;
			out.push(`${prefix}<tbody>${chunk.join('')}</tbody>${after}`);
			isFirstChunk = false;
			chunk = [];
		};

		for (const row of rows) {
			const prefix = isFirstChunk ? before : beforeContinued;
			const trial = `${prefix}<tbody>${chunk.join('')}${row}</tbody>${after}`;
			measureDiv.innerHTML = trial;
			if (measureDiv.offsetHeight > maxHeight && chunk.length > 0) {
				flush();
				chunk = [row];
			} else {
				chunk.push(row);
			}
		}
		flush();
	}
	return out;
}

export function getChapterOrderLabel(
	chap: { title: string; order: number },
	idx: number,
	chapters: { title: string }[]
): string {
	const lower = chap.title.toLowerCase();
	if (lower.startsWith('preface')) return 'P';
	if (lower.startsWith('introduction') || lower.startsWith('intro')) return 'I';
	if (lower.startsWith('foreword')) return 'F';

	let prefaceCount = 0;
	for (let i = 0; i < idx; i++) {
		const titleLower = chapters[i].title.toLowerCase();
		if (
			titleLower.startsWith('preface') ||
			titleLower.startsWith('introduction') ||
			titleLower.startsWith('foreword') ||
			titleLower.startsWith('intro')
		) {
			prefaceCount++;
		}
	}
	return String(chap.order - prefaceCount);
}

export function getChapterLabel(
	chap: { title: string; order: number },
	idx: number,
	chapters: { title: string }[]
): string {
	const lower = chap.title.toLowerCase();
	if (lower.startsWith('preface')) return 'Preface';
	if (lower.startsWith('introduction') || lower.startsWith('intro')) return 'Introduction';
	if (lower.startsWith('foreword')) return 'Foreword';
	return `Chapter ${getChapterOrderLabel(chap, idx, chapters)}`;
}

/** Strip HTML tags to get plain text for sending to Claude as page context */
export function htmlToPlainText(html: string): string {
	const div = document.createElement('div');
	div.innerHTML = html;
	return div.innerText || div.textContent || '';
}

/**
 * Splice a rewritten page back into the full chapter markdown using block indices.
 */
export function splicePage(
	fullMarkdown: string,
	startIdx: number,
	endIdx: number,
	newMarkdown: string
): string {
	if (!fullMarkdown) return fullMarkdown;
	const mdBlocks = fullMarkdown.split(/\n\n+/);
	if (startIdx >= mdBlocks.length) {
		return `${fullMarkdown}\n\n${newMarkdown}`;
	}
	const clampedEnd = Math.min(endIdx, mdBlocks.length);
	const before = mdBlocks.slice(0, startIdx);
	const after  = mdBlocks.slice(clampedEnd);
	return [...before, newMarkdown.trim(), ...after].join('\n\n');
}

export function isLightColor(color: string | null | undefined): boolean {
	if (!color) return false;
	const hex = color.replace('#', '');
	if (hex.length === 3) {
		const r = parseInt(hex[0] + hex[0], 16);
		const g = parseInt(hex[1] + hex[1], 16);
		const b = parseInt(hex[2] + hex[2], 16);
		return (r * 299 + g * 587 + b * 114) / 1000 > 200;
	}
	if (hex.length === 6) {
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		return (r * 299 + g * 587 + b * 114) / 1000 > 200;
	}
	return false;
}
