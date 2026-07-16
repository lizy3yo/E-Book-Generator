/** A target for an AI-assisted edit in the reader. */
export type EditScope = 'page' | 'chapter' | 'illustration' | 'add-page' | 'diagram';

export interface EditTarget {
	scope: EditScope;
	chapterId: string;
	chapterTitle: string;
	chapterOrder: number;
	chapterSummary: string;
	chapterContent: string;
	researchNotes?: string;
	pageIndex?: number;
	pageStartIdx?: number;
	pageEndIdx?: number;
	pageText?: string;
	illustrationUrl?: string;
	illustrationPrompt?: string;
	diagramIndex?: number;
	diagramRaw?: string;
	diagramKind?: 'fence' | 'table' | 'inline' | 'image';
}

/** A rendered page and its corresponding paragraph range in Markdown. */
export interface PageSlice {
	blocks: string[];
	startIdx: number;
	endIdx: number;
}
