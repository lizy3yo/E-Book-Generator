import type { Chapter } from '$lib/types';

export function getChapterOrderLabel(chapter: Pick<Chapter, 'title' | 'order'>, index: number, chapters: Chapter[]): string {
	const lower = chapter.title.toLowerCase();
	if (lower.startsWith('preface')) return 'P';
	if (lower.startsWith('introduction') || lower.startsWith('intro')) return 'I';
	if (lower.startsWith('foreword')) return 'F';

	const frontMatterCount = chapters.slice(0, index).filter(({ title }) => {
		const titleLower = title.toLowerCase();
		return titleLower.startsWith('preface') || titleLower.startsWith('introduction') || titleLower.startsWith('foreword') || titleLower.startsWith('intro');
	}).length;
	return String(chapter.order - frontMatterCount);
}

export function getChapterLabel(chapter: Pick<Chapter, 'title' | 'order'>, index: number, chapters: Chapter[]): string {
	const lower = chapter.title.toLowerCase();
	if (lower.startsWith('preface')) return 'Preface';
	if (lower.startsWith('introduction') || lower.startsWith('intro')) return 'Introduction';
	if (lower.startsWith('foreword')) return 'Foreword';
	return `Chapter ${getChapterOrderLabel(chapter, index, chapters)}`;
}
