export interface StepLog {
	id: string;
	step: 'research' | 'outline' | 'drafting' | 'review' | 'illustrate' | 'complete';
	status: 'pending' | 'running' | 'success' | 'error';
	message: string;
	timestamp: string;
}

export interface CoverSettings {
	title: string;
	subtitle: string;
	author: string;
	titleColor: string;
	subtitleColor: string;
	authorColor: string;
	titleSize: number; // in px
	subtitleSize: number; // in px
	authorSize: number; // in px
	titleFont: 'Lora' | 'Inter' | 'Georgia' | 'Arial';
	alignment: 'left' | 'center' | 'right';
	textPosition: 'top' | 'middle' | 'bottom';
	bgImagePrompt: string;
	bgImageUrl: string | null;
	useUltraRealistic: boolean;
	overlayOpacity: number; // 0 to 1
}

/** One of N cover candidates shown to the user during Stage 2 */
export interface CoverOption {
	id: string;
	prompt: string;
	imageUrl: string;
	style: string; // human-readable label e.g. "Dark Minimalist"
}


/**
 * One fact the book has committed to. Chapters are written in parallel batches
 * and never see each other's prose, so this is the only record of what earlier
 * chapters actually SAID (as opposed to what the outline planned for them).
 */
export interface BibleEntry {
	kind: 'term' | 'claim' | 'example' | 'stat';
	/** The thing itself — the term, the position, the example, the figure. */
	label: string;
	/** Definition / statement / what it illustrated. One sentence. */
	detail: string;
	/** Chapter order that introduced it — used to drop oldest when over cap. */
	chapter: number;
}

export interface Chapter {
	id: string;
	title: string;
	order: number;
	summary: string;
	content: string;
	researchNotes: string;
	illustrationUrl: string | null;
	status: 'pending' | 'writing' | 'verifying' | 'completed' | 'failed';
}

/**
 * Which stage of the guided pipeline the book is in.
 *  1 = concept form filled, cover generation pending
 *  2 = cover options presented, awaiting selection / feedback
 *  3 = chapter plan drafted, awaiting user approval
 *  4 = writing in progress / done chapter-by-chapter
 *  5 = fully completed
 */
export type PipelineStage = 1 | 2 | 3 | 4 | 5;

export interface Book {
	id: string;
	title: string;
	subtitle: string;
	author: string;
	genre: string;
	/**
	 * @deprecated Superseded by `pageCount`. Retained so books persisted before
	 * the page-count control still resolve — see `resolvePageCount` in
	 * $lib/bookPlan, which prefers `pageCount` and falls back to this.
	 */
	length: 'short' | 'medium' | 'long';
	/** Target page count, 50–600. Drives chapter count via $lib/bookPlan. */
	pageCount?: number;
	tone: string;
	structure: string;
	useUltraRealistic: boolean;
	researchDepth: 'basic' | 'deep';
	selfCorrectionLevel: 'standard' | 'rigorous';

	/** Guided pipeline stage — drives the main UI wizard */
	pipelineStage: PipelineStage;

	/** Optional deeper context / brief provided by the user at concept time.
	 *  Injected into every AI research and writing call to ground the output. */
	userContext: string;

	/** Optional visual reference / creative direction for cover generation.
	 *  Appended to every cover image prompt. */
	coverReferencePrompt: string;

	/** Cover candidates generated in Stage 2 */
	coverOptions: CoverOption[];

	/** Index of the chosen cover option (Stage 2) */
	selectedCoverIndex: number | null;

	coverSettings: CoverSettings;
	chapters: Chapter[];
	/**
	 * Rolling "book bible" — bounded (see $lib/bookBible), folded in after each
	 * batch of chapters, sent to the next batch. Optional: books written before
	 * it simply generate without one.
	 */
	bible?: BibleEntry[];
	interiorDesign?: Record<string, string>;

	status: 'idle' | 'researching' | 'outlining' | 'writing' | 'verifying' | 'illustrating' | 'completed' | 'failed';
	currentStep: string;
	logs: StepLog[];

	createdAt: string;
	updatedAt: string;
}

export interface ApiKeys {
	anthropicKey: string;
	exaKey: string;
	imageKey: string;
	imageProvider: 'kie' | '69labs';
	useMockMode: boolean;
}
