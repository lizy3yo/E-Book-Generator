import type { CoverDesign } from './coverPalette';
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

/**
 * Where a cover candidate came from:
 *  'template' — one of the built-in art-directed presets (see $lib/coverStyles)
 *  'ai'       — an original concept Claude devised from the Step 1 brief
 */
export type CoverOrigin = 'template' | 'ai';

/** One of N cover candidates shown to the user during Stage 2 */
export interface CoverOption {
	id: string;
	prompt: string;
	imageUrl: string;
	style: string; // human-readable label e.g. "Dark Minimalist"
	/** Optional on books persisted before origins existed — treat as 'template'. */
	origin?: CoverOrigin;
	/** Stable id of the built-in template that produced it. Templates only —
	 *  lets a single option be regenerated without depending on grid position. */
	styleId?: string;
	/** One-sentence art-direction rationale. AI-originated concepts only. */
	concept?: string;
	/** The specific element of the author's Step 1 input this concept was built
	 *  on, in the author's own words where possible. AI concepts only — it is
	 *  what makes the correlation between brief and cover auditable rather than
	 *  asserted. */
	basis?: string;
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

/**
 * One field of a book's repeating unit — "The Problem", "Money Saved".
 *
 * `role` decides where it renders and therefore how it reads:
 *   prose  — a serif paragraph with a bold run-in label. Explains.
 *   action — a line inside the callout box. Tells the reader what to do.
 * That split (explain in serif, act in sans) is the single most transferable
 * thing in the reference book, and it only works if every field declares which
 * side it is on.
 */
export interface BookFormatField {
	label: string;
	role: 'prose' | 'action';
	/** What belongs in this field, in the writing model's own terms. */
	guidance: string;
}

/**
 * The shape a book's content repeats in.
 *
 * Some books are 100 of the same thing — a fix, a technique, a recipe — each
 * with identical parts. That rigidity is what makes the reference book read as
 * tight as it does, and it is exactly what a language model is good at: a form
 * with named boxes is far harder to write badly than an open chapter.
 *
 * Most books are NOT that. A memoir has no repeating unit, and forcing one on
 * it produces nonsense ("Fix 12 — Reconcile With Your Father"). So `mode` is
 * decided once, up front, from the author's own concept — and defaults to
 * 'free', which is how every book was written before this existed.
 *
 * The unit and its fields are DERIVED per book, never hardcoded: the reference
 * book's "Fix / Money Saved" is plumbing's clothing, not the skeleton.
 */
export interface BookFormat {
	mode: 'free' | 'form';
	/** Singular noun for one unit — "Fix", "Technique", "Recipe". */
	unit?: string;
	/** Plural, for outlines and back matter — "Fixes". */
	unitPlural?: string;
	/** How many across the WHOLE book, numbered 1..N without restarting. */
	unitCount?: number;
	/** In render order. Prose fields first, then the action box. */
	fields?: BookFormatField[];
	/** Why this was chosen. Shown to the author — they don't pick it, but when
	 *  it guesses wrong they deserve to see why the book came out that way. */
	reasoning?: string;
}

/**
 * One callout on a chapter illustration.
 *
 * The image itself carries no text — image models cannot spell, and a
 * hallucinated label is indistinguishable from a real one to the reader. So the
 * wording lives here, as data, and is set in real type by the renderer. `x`/`y`
 * are percentages of the IMAGE (not its container), naming the point the leader
 * line touches; `side` is which way the box sits so it misses the subject.
 */
export interface IllustrationLabel {
	text: string;
	x: number;
	y: number;
	side: 'left' | 'right';
}

export interface Chapter {
	id: string;
	title: string;
	order: number;
	summary: string;
	content: string;
	researchNotes: string;
	illustrationUrl: string | null;
	/** Absent on chapters written before labelling existed, and on any
	 *  illustration the vision pass could not label confidently. */
	illustrationLabels?: IllustrationLabel[];
	/**
	 * Sections the plate planner judged illustration-worthy — the record behind
	 * the reader's manual "add illustration" button. A section listed here that
	 * does NOT already carry a plate (its `### heading` is still present) shows
	 * the button; clicking it generates that plate on demand.
	 *
	 * Stored for every visual-density tier, including 'standard': the tier
	 * decides how many plates are auto-generated, but the suggestions are what let
	 * a reader add one by hand to any section Claude approved. Absent on chapters
	 * generated before this existed — no suggestions, so no buttons.
	 */
	plateSuggestions?: { section: string; subject: string }[];
	/**
	 * The span of the book's repeating units this chapter owns, inclusive —
	 * e.g. 7..12. Set by the outline when `Book.format.mode === 'form'`.
	 *
	 * Numbering is continuous across the WHOLE book, not per chapter: Fix 47 is
	 * Fix 47 wherever it sits. The outline is the only place that can guarantee
	 * that, because chapters are written concurrently and never see each other —
	 * so it assigns the ranges up front and every chapter writes only its own.
	 */
	unitStart?: number;
	unitEnd?: number;
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
	/**
	 * How this book's content is shaped. Decided once from the author's concept
	 * before the outline runs, then obeyed by every chapter.
	 *
	 * Absent on books planned before this existed — treat a missing value as
	 * `{ mode: 'free' }`, which is exactly how they were written.
	 */
	format?: BookFormat;
	useUltraRealistic: boolean;
	researchDepth: 'basic' | 'deep';
	selfCorrectionLevel: 'standard' | 'rigorous';

	/**
	 * How heavily illustrated the book is. Two independent things scale with it,
	 * in two different places:
	 *   • Diagrams and structured visuals (charts, stat blocks, callouts) — these
	 *     are text the writing model emits, so they cost nothing extra and the
	 *     writing prompt just aims higher for richer tiers.
	 *   • Image plates — the paid part (each is one image generation plus two
	 *     Claude vision calls). The generation runner adds extra art-directed
	 *     plates per chapter for the richer tiers; see writeSingleChapter.
	 *
	 * 'standard' is one image plate per chapter (the original behaviour); 'rich'
	 * and 'maximum' add more. Absent on books created before this existed — treat
	 * a missing value as 'standard' so those books keep their original image
	 * count when a chapter is regenerated.
	 */
	visualDensity?: 'standard' | 'rich' | 'maximum';

	/** Guided pipeline stage — drives the main UI wizard */
	pipelineStage: PipelineStage;

	/** Optional deeper context / brief provided by the user at concept time.
	 *  Injected into every AI research and writing call to ground the output. */
	userContext: string;

	/** Optional visual reference / creative direction for cover generation.
	 *  Appended to every cover image prompt. */
	coverReferencePrompt: string;

	/** Design language extracted by Claude from a reference cover the author
	 *  uploaded — palette, typography, imagery treatment, graphic devices,
	 *  layout. Applied to every variant so a format can be borrowed from a
	 *  cover in a completely different niche.
	 *
	 *  Only the derived spec is kept. The source image is deliberately NOT
	 *  persisted: the whole book is serialised into one Supabase row and one
	 *  localStorage entry on every mutation, and an inlined base64 cover would
	 *  bloat both past their practical limits. */
	coverReferenceFormat?: string;

	/** Filename of the analysed reference cover. Display only. */
	coverReferenceName?: string;

	/** Cover candidates generated in Stage 2 */
	coverOptions: CoverOption[];

	/** Index of the chosen cover option (Stage 2) */
	selectedCoverIndex: number | null;

	coverSettings: CoverSettings;

	/**
	 * Colour and type read off the CHOSEN COVER IMAGE, then held to a contrast
	 * floor so the page stays readable.
	 *
	 * Distinct from `coverSettings.titleColor` / `authorColor`, which is what
	 * the interior used to be coloured from. Those describe a cover that was
	 * laid out in HTML; a generated cover bakes its type into the artwork, so
	 * they no longer describe anything the reader can see. This is measured from
	 * the pixels instead.
	 *
	 * Absent until a cover is chosen, and re-derived when it changes.
	 */
	coverDesign?: CoverDesign;

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

	/**
	 * Running AI spend for this book. Claude figures are exact — summed
	 * straight from Anthropic's real per-call token usage. Image and search
	 * counts are estimates: those providers return no usage/cost data, so the
	 * UI prices them off a flat per-call rate rather than a measurement.
	 * Absent on books generated before this existed.
	 */
	usage?: BookUsage;

	createdAt: string;
	updatedAt: string;
}

export interface BookUsage {
	/** Accumulated Claude token usage, keyed by model ID. */
	claude: Record<string, { inputTokens: number; outputTokens: number; calls: number }>;
	/** Count of successful image generations (Kie.ai / 69labs). Estimated cost. */
	images: number;
	/** Count of successful Exa search calls. Estimated cost. */
	searches: number;
}

export interface ApiKeys {
	anthropicKey: string;
	exaKey: string;
	imageKey: string;
	imageProvider: 'kie' | '69labs';
	useMockMode: boolean;
}
