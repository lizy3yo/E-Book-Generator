export type EditScope = 'page' | 'chapter' | 'illustration' | 'add-page' | 'diagram';

export interface EditTarget {
	scope: EditScope;
	chapterId: string;
	chapterTitle: string;
	chapterOrder: number;
	chapterSummary: string;
	chapterContent: string;
	researchNotes?: string;
	// page scope
	pageIndex?: number;
	pageStartIdx?: number;
	pageEndIdx?: number;
	pageText?: string;
	// illustration scope
	illustrationUrl?: string;
	illustrationPrompt?: string;
	// diagram scope
	diagramIndex?: number;
	diagramRaw?: string;
	diagramKind?: 'fence' | 'table' | 'inline' | 'image';
}

export interface PageSlice {
	blocks: string[];
	startIdx: number;
	endIdx: number;
}
