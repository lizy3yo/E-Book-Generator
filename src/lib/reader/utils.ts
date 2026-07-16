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
