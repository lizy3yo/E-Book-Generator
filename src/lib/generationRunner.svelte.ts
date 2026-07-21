/**
 * generationRunner — owns every long-running generation the app performs:
 * covers (Step 1), the chapter plan (Step 2), and the writing pipeline (Step 3).
 *
 * Why this is not in the page component
 * ─────────────────────────────────────
 * The work itself always survived navigation — a promise does not care that the
 * component that started it was destroyed, and every result lands in
 * `globalState`, which is a module singleton. What did NOT survive was the
 * knowledge that the work was running, because that lived in component state.
 * Leaving the page and coming back therefore produced two real faults:
 *
 *   • Covers still rendering came back as "didn't render", because the set of
 *     pending ids had been destroyed with the component.
 *   • The `isWriting` guard was destroyed too, so a book that was mid-write
 *     looked idle and a second writing pipeline could be started over the top
 *     of the first — duplicating every API call and interleaving writes to the
 *     same chapters.
 *
 * Keeping run state in a singleton, keyed by book, fixes both: the page becomes
 * a view of a run that exists independently of it. It also means several books
 * can generate at once, and progress is observable from any route.
 *
 * Scope: this survives client-side navigation, not a page reload — the browser
 * is still the thing driving the pipeline, so closing or reloading the tab ends
 * it. Chapters already written are persisted, and a fresh run skips completed
 * chapters, so a reload loses the in-flight chapter rather than the book.
 */

import { globalState } from './state.svelte';
import type { Book, Chapter, CoverOption, CoverOrigin, BibleEntry, IllustrationLabel, BookFormat } from './types';
import { generateImage } from './generateImage';
import { createIllustration, planChapterPlates } from './illustration';
import { COVER_TEMPLATES, AI_CONCEPT_COUNT, buildCoverDirection, buildBriefCoverPrompt, hasCoverBrief, type CoverTemplate } from './coverStyles';
import { batched, BATCH_SIZE, planForBook } from './bookPlan';
import { mergeBible, bibleTokens } from './bookBible';

/**
 * Turn a generated image and its callout labels into a ```plate block.
 *
 * The plate renderer ($lib/diagrams) sets the labels in real type over the
 * image and gives it a whole page — the same house figure format an authored
 * plate gets.
 *
 * When the plate opens a section, it carries that section's heading as its
 * `title:` so the heading renders in the plate's own header bar, on the same
 * page as the image, instead of being stranded on the page before it. A plate
 * with no title (e.g. the rare leftover that matched no section) renders as a
 * clean untitled full-page photograph.
 */
export function buildPlateBlock(url: string, labels: IllustrationLabel[], title = ''): string {
	const lines = ['```plate'];
	if (title.trim()) lines.push(`title: ${title.trim()}`);
	lines.push(`image: ${url}`);
	if (labels.length) lines.push(`callouts: ${JSON.stringify(labels)}`);
	lines.push('```');
	return lines.join('\n');
}

/**
 * Open each illustrated section with its plate, titled by the section heading.
 *
 * Used by the richer tiers, where a planning pass has already tied every plate
 * to a named section. Each plate REPLACES that section's heading line: the plate
 * carries the heading text as its own title bar (see buildPlateBlock), so the
 * heading and the image render together on the plate's page. Inserting the plate
 * *after* the heading instead stranded the heading alone on the previous page —
 * a full-page plate cannot share a page with the heading above it — leaving a
 * near-blank page before every figure.
 *
 * Sections are matched at any heading depth (`##`, `###`, `####`): a free-form
 * chapter uses `##` section heads, but a form-format book (one built from a
 * repeating unit) heads each unit with `###`. A plate whose section can no
 * longer be matched (the heading was edited or reworded) falls through to the
 * end rather than being lost, and keeps its own title so it still reads whole.
 */
const HEADING_RE = /^#{2,4}\s/;

export function splicePlatesAtSections(content: string, items: { section: string; block: string }[]): string {
	if (!items.length) return content;

	const lines = content.split('\n');
	const norm = (s: string) => s.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();

	const replacements: { at: number; block: string }[] = [];
	const leftover: string[] = [];
	for (const { section, block } of items) {
		const target = norm(section);
		let at = -1;
		for (let i = 0; i < lines.length; i++) {
			if (HEADING_RE.test(lines[i]) && norm(lines[i]) === target) { at = i; break; }
		}
		if (at === -1) leftover.push(block);
		else replacements.push({ at, block });
	}

	// Replace from the bottom up so earlier line indices stay valid. Each swaps
	// the one heading line for the titled plate (wrapped in blank lines so the
	// markdown parser treats it as its own block).
	replacements.sort((a, b) => b.at - a.at);
	for (const { at, block } of replacements) lines.splice(at, 1, '', block, '');

	let out = lines.join('\n');
	if (leftover.length) out += '\n\n' + leftover.join('\n\n');
	return out;
}

/** Everything the UI needs to know about a book's in-flight work. */
export interface BookRunState {
	// Step 1 — covers
	isGeneratingCovers: boolean;
	/** Which on-demand batch is rendering, if any — Claude's own concepts, or a
	 *  cover built from the author's brief. */
	loadingBatch: null | 'ai' | 'brief';
	regeneratingCoverIdx: number | null;
	/** Ids of covers whose image is still in flight — distinguishes "rendering"
	 *  from "rendered but failed", which otherwise look identical (no imageUrl). */
	pendingCoverIds: string[];
	coverError: string | null;
	referenceBusy: boolean;
	referenceError: string | null;

	// Step 2 — chapter plan
	isGeneratingPlan: boolean;
	planError: string | null;

	// Step 3 — writing
	isWriting: boolean;
	regeneratingChapterIdx: number | null;
	/** Wall-clock bounds of the CURRENT generation run (epoch ms), driving the
	 *  overall timer. Ephemeral per session: reset when a run starts, `runEndedAt`
	 *  stamped when it finishes. Null before the first run of the session. */
	runStartedAt: number | null;
	runEndedAt: number | null;
}

const IDLE: BookRunState = {
	isGeneratingCovers: false,
	loadingBatch: null,
	regeneratingCoverIdx: null,
	pendingCoverIds: [],
	coverError: null,
	referenceBusy: false,
	referenceError: null,
	isGeneratingPlan: false,
	planError: null,
	isWriting: false,
	regeneratingChapterIdx: null,
	runStartedAt: null,
	runEndedAt: null
};

class GenerationRunner {
	/** Keyed by book id — several books may legitimately be generating at once. */
	runs = $state<Record<string, BookRunState>>({});

	/** Reactive run state for a book. Never null, so the UI needn't branch. */
	for(bookId: string | null | undefined): BookRunState {
		if (!bookId) return IDLE;
		return this.runs[bookId] ?? IDLE;
	}

	private patch(bookId: string, changes: Partial<BookRunState>) {
		this.runs[bookId] = { ...(this.runs[bookId] ?? IDLE), ...changes };
	}

	/** Merge fields into one chapter and persist — used for the progress-bar and
	 *  timing ticks so the UI reflects work as it happens, not only at the end. */
	private patchChapter(bookId: string, chapIndex: number, fields: Partial<Chapter>) {
		const arr = [...globalState.books.find(b => b.id === bookId)!.chapters];
		arr[chapIndex] = { ...arr[chapIndex], ...fields };
		globalState.updateBookChapters(bookId, arr);
	}

	// ── Cover art direction ──────────────────────────────────────────────────

	/** The author's written brief plus any design language read off a reference
	 *  cover, composed into the clause appended to every cover prompt. */
	private coverDirection(book: Book): string {
		return buildCoverDirection({
			brief:           book.coverReferencePrompt,
			referenceFormat: book.coverReferenceFormat
		});
	}

	private templatePrompt(template: CoverTemplate, book: Book): string {
		return template.buildPrompt({
			title:     book.title,
			subtitle:  book.subtitle ?? '',
			author:    book.author ?? 'Unknown Author',
			genre:     book.genre,
			direction: this.coverDirection(book)
		});
	}

	/** Has the author given cover direction of their own — written brief, uploaded
	 *  reference, or both? When they have, Stage 2 renders exactly that one cover. */
	private hasBrief(book: Book): boolean {
		return hasCoverBrief({
			brief:           book.coverReferencePrompt,
			referenceFormat: book.coverReferenceFormat
		});
	}

	/**
	 * The single cover the author's own brief produces.
	 *
	 * A brief is one specific design language, so there is no archetype left to
	 * vary — rendering the template tier through it would return near-identical
	 * covers and bill the author three times for the same design. No `styleId`:
	 * there is no template to rebuild from, so a regenerate re-runs this prompt.
	 */
	private briefSpec(book: Book): CoverOption {
		const fromUpload = !!book.coverReferenceFormat?.trim();
		return {
			id:       crypto.randomUUID(),
			prompt:   buildBriefCoverPrompt({
				title:     book.title,
				subtitle:  book.subtitle ?? '',
				author:    book.author ?? 'Unknown Author',
				genre:     book.genre,
				direction: this.coverDirection(book)
			}),
			imageUrl: '',
			style:    fromUpload ? 'Reference Format' : 'Your Direction',
			origin:   'template' as CoverOrigin,
			concept:  fromUpload
				? `Your book set in the design language read from ${book.coverReferenceName || 'your reference cover'}.`
				: 'Your book set in the visual direction you described.'
		};
	}

	private templateSpecs(templates: CoverTemplate[], book: Book): CoverOption[] {
		return templates.map(t => ({
			id:       crypto.randomUUID(),
			prompt:   this.templatePrompt(t, book),
			imageUrl: '',
			style:    t.style,
			origin:   'template' as CoverOrigin,
			styleId:  t.id,
			concept:  t.rationale
		}));
	}

	/**
	 * Render a batch of covers concurrently.
	 *
	 * Every slot is seeded into state before any image is requested, so covers
	 * hold their position in the grid no matter what order they finish in, and
	 * each card can show its own progress. Slots are keyed by id and updated in
	 * place as results land.
	 */
	private async renderCoverBatch(book: Book, specs: CoverOption[]) {
		const keys = globalState.apiKeys;

		globalState.appendCoverOptions(book.id, specs);
		this.patch(book.id, {
			pendingCoverIds: [...this.for(book.id).pendingCoverIds, ...specs.map(s => s.id)]
		});

		await Promise.all(
			specs.map(async (spec) => {
				let imageUrl = '';
				try {
					const img = await generateImage({
						prompt:      spec.prompt,
						apiKey:      keys.imageKey,
						provider:    keys.imageProvider,
						useMockMode: keys.useMockMode,
						isCover:     true
					});
					imageUrl = img.url;
					if (img.billed) globalState.addBookUsage(book.id, { images: 1 });
				} catch (err: any) {
					// Keep the slot: an empty imageUrl renders as a failed card the
					// user can retry, which beats a cover silently going missing.
					// Surface the provider's reason too — "didn't render" alone gives
					// the author nothing to act on.
					console.error(`Cover "${spec.style}" failed to render:`, err);
					this.patch(book.id, {
						coverError: `"${spec.style}" didn't render: ${err?.message || 'unknown error'}`
					});
				}

				globalState.appendCoverOptions(book.id, [{ ...spec, imageUrl }]);
				this.patch(book.id, {
					pendingCoverIds: this.for(book.id).pendingCoverIds.filter(id => id !== spec.id)
				});
			})
		);
	}

	// ── Step 1: covers ───────────────────────────────────────────────────────

	/** Entry into Stage 2 — renders the template tier. The AI concepts and the
	 *  author's own brief-built covers are further batches they opt into. */
	async startCovers(book: Book) {
		if (this.for(book.id).isGeneratingCovers) return;
		this.patch(book.id, { isGeneratingCovers: true, coverError: null });
		globalState.setPipelineStage(book.id, 2);

		try {
			await this.renderCoverBatch(book, this.templateSpecs(COVER_TEMPLATES, book));
		} finally {
			this.patch(book.id, { isGeneratingCovers: false });
		}
	}

	/**
	 * Ask Claude to devise original cover concepts from the Step 1 brief, then
	 * render them. Claude writes the image prompts itself, so these are art
	 * direction the template library has no equivalent for.
	 *
	 * Independent of the template batch by design — only its own run, or a full
	 * regenerate rebuilding the grid underneath it, can block it.
	 */
	async startAiConcepts(bookId: string) {
		const book = globalState.books.find(b => b.id === bookId);
		const run  = this.for(bookId);
		if (!book || run.loadingBatch === 'ai') return;

		this.patch(bookId, { loadingBatch: 'ai', coverError: null });

		try {
			const keys = globalState.apiKeys;
			const res = await fetch('/api/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action:       'cover-concepts',
					apiKey:       keys.anthropicKey,
					useMockMode:  keys.useMockMode,
					bookTitle:    book.title,
					bookSubtitle: book.subtitle,
					bookAuthor:   book.author,
					genre:        book.genre,
					tone:         book.tone,
					structure:    book.structure,
					length:       book.length,
					pageCount:    book.pageCount,
					authorBrief:  book.userContext,
					// Claude folds the direction into the prompts it writes, so the
					// clause is NOT appended again downstream.
					coverDirection: this.coverDirection(book).trim(),
					conceptCount: AI_CONCEPT_COUNT
				})
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Could not generate cover concepts.');
			if (data.usage) globalState.addBookUsage(bookId, { claude: data.usage });

			const specs: CoverOption[] = (data.concepts as any[]).map(c => ({
				id:       crypto.randomUUID(),
				prompt:   c.prompt,
				imageUrl: '',
				style:    c.style,
				origin:   'ai' as CoverOrigin,
				concept:  c.concept,
				basis:    c.basis
			}));

			// The server degrades to a partial set rather than failing outright, so
			// say so instead of letting a short grid look like a silent bug.
			if (specs.length < AI_CONCEPT_COUNT) {
				this.patch(bookId, {
					coverError: `Claude returned ${specs.length} of ${AI_CONCEPT_COUNT} concepts. Regenerate to try for the rest.`
				});
			}

			await this.renderCoverBatch(book, specs);
		} catch (err: any) {
			this.patch(bookId, { coverError: err.message || 'Could not generate cover concepts.' });
		} finally {
			this.patch(bookId, { loadingBatch: null });
		}
	}

	/** Regenerate one cover in place, keeping its slot and its art direction. */
	async regenerateCover(bookId: string, optionIndex: number) {
		const book = globalState.books.find(b => b.id === bookId);
		const run  = this.for(bookId);
		if (!book || run.regeneratingCoverIdx !== null) return;

		const option = book.coverOptions[optionIndex];
		if (!option) return;

		this.patch(bookId, { regeneratingCoverIdx: optionIndex });

		// Templates rebuild from the library so the cover picks up any direction
		// added since it was first rendered. An AI concept has no template to
		// rebuild from — its prompt IS the concept — so it re-runs as written.
		const template = option.styleId
			? COVER_TEMPLATES.find(t => t.id === option.styleId)
			: undefined;
		const prompt = template ? this.templatePrompt(template, book) : option.prompt;

		try {
			const keys = globalState.apiKeys;
			const img = await generateImage({
				prompt,
				apiKey:      keys.imageKey,
				provider:    keys.imageProvider,
				useMockMode: keys.useMockMode,
				isCover:     true
			});
			if (img.billed) globalState.addBookUsage(bookId, { images: 1 });
			globalState.replaceCoverOption(bookId, optionIndex, { ...option, prompt, imageUrl: img.url });
		} catch (err: any) {
			console.error(err);
			this.patch(bookId, { coverError: `That cover failed to render: ${err?.message || 'unknown error'}` });
		} finally {
			this.patch(bookId, { regeneratingCoverIdx: null });
		}
	}

	/**
	 * Add one cover built from the author's own brief.
	 *
	 * Additive, not a rebuild: the brief describes one design, so it produces one
	 * cover and appends it alongside whatever is already on screen. Covers the
	 * author has already accumulated are neither cleared nor re-billed — a brief
	 * is a cover to try, not a verdict on the ones they have.
	 *
	 * Callable repeatedly: each click renders the brief as it currently reads, so
	 * editing the direction and clicking again yields another candidate rather
	 * than overwriting the last.
	 */
	async createBriefCover(bookId: string) {
		const book = globalState.books.find(b => b.id === bookId);
		// No brief means no design to build from — the button is disabled for this,
		// so reaching here is a caller bug rather than something to render blindly.
		if (!book || !this.hasBrief(book) || this.isCoversBusy(bookId)) return;

		this.patch(bookId, { loadingBatch: 'brief', coverError: null });

		try {
			await this.renderCoverBatch(book, [this.briefSpec(book)]);
		} finally {
			this.patch(bookId, { loadingBatch: null });
		}
	}

	/**
	 * Any cover work in flight. Gates the operations that reinterpret the author's
	 * direction — the reference upload, and the brief-built cover that reads it.
	 * Individual batches deliberately do NOT gate each other: they append their
	 * own slots by id and can safely run concurrently, so making the author wait
	 * for the templates before asking for AI concepts would be an artificial
	 * queue, not a safety measure.
	 */
	isCoversBusy(bookId: string | null | undefined): boolean {
		const r = this.for(bookId);
		return r.isGeneratingCovers || r.loadingBatch !== null || r.regeneratingCoverIdx !== null
			|| r.referenceBusy;
	}

	// ── Reference cover ──────────────────────────────────────────────────────

	/** Read a reference cover's design language and attach it to the book.
	 *  The image is analysed once and discarded — only the spec is kept. */
	async analyzeReference(bookId: string, payload: { mediaType: string; data: string }, fileName: string) {
		if (this.for(bookId).referenceBusy) return;
		this.patch(bookId, { referenceBusy: true, referenceError: null });

		try {
			const keys = globalState.apiKeys;
			const res = await fetch('/api/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action:      'analyze-cover-reference',
					apiKey:      keys.anthropicKey,
					useMockMode: keys.useMockMode,
					referenceImage: { mediaType: payload.mediaType, data: payload.data }
				})
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Could not read that cover.');
			if (data.usage) globalState.addBookUsage(bookId, { claude: data.usage });

			globalState.setCoverReferenceFormat(bookId, data.format, fileName);
		} catch (err: any) {
			this.patch(bookId, { referenceError: err.message || 'Could not read that cover.' });
			throw err;
		} finally {
			this.patch(bookId, { referenceBusy: false });
		}
	}

	clearReferenceError(bookId: string) {
		this.patch(bookId, { referenceError: null });
	}

	// ── Step 2: chapter plan ─────────────────────────────────────────────────

	async startChapterPlan(book: Book) {
		if (this.for(book.id).isGeneratingPlan) return;
		this.patch(book.id, { isGeneratingPlan: true, planError: null });
		globalState.setPipelineStage(book.id, 3);
		globalState.updateBookStatus(book.id, 'researching');

		const keys    = globalState.apiKeys;
		const useMock = keys.useMockMode;

		try {
			// Research
			const researchRes = await fetch('/api/research', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: `Core concepts and key facts about: ${book.title}. Genre: ${book.genre}.`,
					apiKey: keys.exaKey,
					useMockMode: useMock
				})
			});
			const researchData = await researchRes.json();
			if (researchData.source === 'live') globalState.addBookUsage(book.id, { searches: 1 });
			else if (researchData.usage) globalState.addBookUsage(book.id, { claude: researchData.usage });
			const searchFacts = researchData.success
				? (researchData.results as any[]).map(f => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';

			// Merge user-provided context with retrieved facts
			const factsSummary = [
				book.userContext?.trim() ? `[Author Brief]\n${book.userContext.trim()}` : '',
				searchFacts
			].filter(Boolean).join('\n\n');

			globalState.updateBookStatus(book.id, 'outlining');

			// ── Decide the book's shape, once, before anything is planned ─────
			//
			// This has to happen here and be persisted, not re-derived later:
			// chapters are written concurrently and never see each other, so if
			// each one worked out its own form you would get a different one in
			// every chapter. Decided once, stored, obeyed by all of them.
			//
			// Never fatal. A book with no format is a free-form book, which is
			// exactly what every book was before this existed.
			let format: BookFormat = { mode: 'free' };
			try {
				const fmtRes = await fetch('/api/write', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'decide-format',
						apiKey: keys.anthropicKey,
						useMockMode: useMock,
						bookTitle: book.title,
						bookSubtitle: book.subtitle,
						genre: book.genre,
						length: book.length,
						pageCount: book.pageCount,
						tone: book.tone,
						structure: book.structure,
						authorBrief: book.userContext
					})
				});
				const fmtData = await fmtRes.json();
				if (fmtData.success && fmtData.format) format = fmtData.format as BookFormat;
				if (fmtData.usage) globalState.addBookUsage(book.id, { claude: fmtData.usage });
			} catch { /* free */ }

			globalState.updateBookFormat(book.id, format);
			globalState.addLog(book.id, {
				step: 'outline', status: 'success',
				message: format.mode === 'form'
					? `Format: ${format.unitCount} ${format.unitPlural ?? 'units'}, each with ${format.fields?.length ?? 0} parts. ${format.reasoning ?? ''}`
					: `Format: free-form chapters. ${format.reasoning ?? ''}`
			});

			// Outline
			const outlineRes = await fetch('/api/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'outline',
					apiKey: keys.anthropicKey,
					useMockMode: useMock,
					bookTitle: book.title,
					genre: book.genre,
					length: book.length,
					pageCount: book.pageCount,
					tone: book.tone,
					structure: book.structure,
					researchNotes: factsSummary,
					bookFormat: format
				})
			});
			const outlineData = await outlineRes.json();

			if (!outlineData.success) throw new Error(outlineData.error || 'Outline failed.');
			if (outlineData.usage) globalState.addBookUsage(book.id, { claude: outlineData.usage });

			const chapters: Chapter[] = outlineData.chapters;
			globalState.updateBookChapters(book.id, chapters);
		} catch (err: any) {
			this.patch(book.id, { planError: err.message || 'An unexpected error occurred. Please try again.' });
			globalState.updateBookStatus(book.id, 'failed');
			globalState.addLog(book.id, { step: 'outline', status: 'error', message: err.message });
		} finally {
			this.patch(book.id, { isGeneratingPlan: false });
		}
	}

	clearPlanError(bookId: string) {
		this.patch(bookId, { planError: null });
	}

	// ── Step 3: writing ──────────────────────────────────────────────────────

	async startWriting(book: Book) {
		if (this.for(book.id).isWriting) return;
		this.patch(book.id, { isWriting: true, runStartedAt: Date.now(), runEndedAt: null });
		// try/finally so isWriting always clears. It used to be reset only on
		// the success path, so any throw left it stuck true and the pipeline
		// refused to start again (the guard above) until a full page reload.
		try {
			await this.writeAllChapters(book);
		} finally {
			this.patch(book.id, { isWriting: false, runEndedAt: Date.now() });
		}
	}

	private async writeAllChapters(book: Book) {
		// Local to the run: a singleton runner may be writing two books at once,
		// and a shared list would attribute one book's failures to the other.
		const failedChapters: number[] = [];
		globalState.updateBookStatus(book.id, 'writing');

		const keys    = globalState.apiKeys;
		const useMock = keys.useMockMode;

		// ── Step 1: Book-level research (shared context for all chapters) ─────
		let bookLevelFacts = '';
		try {
			const r = await fetch('/api/research', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: `${book.title} ${book.genre} comprehensive overview key concepts`,
					apiKey: keys.exaKey,
					useMockMode: useMock
				})
			});
			const rd = await r.json();
			if (rd.source === 'live') globalState.addBookUsage(book.id, { searches: 1 });
			else if (rd.usage) globalState.addBookUsage(book.id, { claude: rd.usage });
			bookLevelFacts = rd.success
				? (rd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';
		} catch { /* non-fatal */ }

		const chapters = [...globalState.books.find(b => b.id === book.id)!.chapters];

		// Build the list of chapter indices that still need to be written.
		const allPending = chapters
			.map((c, i) => i)
			.filter(i => chapters[i].status !== 'completed');

		// Start a run from a clean bible. Entries carry the chapter that wrote
		// them, and a re-run rewrites those chapters — keeping the old ones would
		// tell chapter 7's author that chapter 7 already said something.
		let bible: BibleEntry[] = [];
		globalState.updateBookBible(book.id, bible);

		// The queue the workers drain. Refilled one batch at a time.
		const pending: number[] = [];

		// ── Worker pool — process up to CONCURRENCY chapters simultaneously ──────
		// Each worker claims the next available index from the shared queue,
		// runs the full research → write → verify → illustrate pipeline for it,
		// then immediately picks up the next. This means the user sees the first
		// chapter appear as soon as it's done rather than waiting for all of them,
		// while still limiting concurrent API pressure to CONCURRENCY slots.
		const CONCURRENCY = 2;

		const processNextChapter = async (): Promise<void> => {
			while (pending.length > 0) {
				const i = pending.shift()!;
				const chap = chapters[i];

				// Per-chapter targeted research
				let chapterFacts = '';
				try {
					const cr = await fetch('/api/research', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							query: `${chap.title} ${book.title} ${book.genre} ${chap.summary ?? ''}`.trim(),
							apiKey: keys.exaKey,
							useMockMode: useMock
						})
					});
					const crd = await cr.json();
					if (crd.source === 'live') globalState.addBookUsage(book.id, { searches: 1 });
					else if (crd.usage) globalState.addBookUsage(book.id, { claude: crd.usage });
					chapterFacts = crd.success
						? (crd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
						: '';
					globalState.addLog(book.id, {
						step: 'research', status: 'success',
						message: `Research complete for Chapter ${chap.order}: "${chap.title}"`
					});
				} catch { /* non-fatal */ }

				const factsSummary = [
					book.userContext?.trim() ? `[Author Brief]\n${book.userContext.trim()}` : '',
					bookLevelFacts ? `[Book-Level Research]\n${bookLevelFacts}` : '',
					chapterFacts   ? `[Chapter-Specific Research for "${chap.title}"]\n${chapterFacts}` : ''
				].filter(Boolean).join('\n\n');

				// One chapter must never take the book down with it.
				// writeSingleChapter throws on a failed draft; unguarded, that
				// rejects this worker, rejects the Promise.all below, and aborts
				// the whole run — discarding every chapter that already
				// succeeded. Survivable at 5 chapters, fatal at 30, where ~120
				// API calls make a transient 429 or timeout near-certain.
				// Mark it failed, log it, keep going: the reader can regenerate
				// the one chapter instead of losing the book.
				try {
					await this.writeSingleChapter(book.id, i, chapters, factsSummary, keys, useMock, bible);
				} catch (err: any) {
					failedChapters.push(chap.order);
					const live = [...globalState.books.find(b => b.id === book.id)!.chapters];
					live[i] = { ...live[i], status: 'failed', completedAt: Date.now() };
					globalState.updateBookChapters(book.id, live);
					globalState.addLog(book.id, {
						step: 'drafting', status: 'error',
						message: `Chapter ${chap.order} failed: ${err?.message ?? err}. Continuing with the rest — regenerate it from the reader.`
					});
				}
			}
		};

		// ── Batched fan-out with a fold ───────────────────────────────────────
		// Write a batch in parallel, distil what it actually said into the bible,
		// then write the next batch WITH that bible. Chapters within a batch stay
		// blind to each other — that's the price of parallelism, and it's bounded
		// to BATCH_SIZE chapters rather than the whole book. Batch 1 runs with an
		// empty bible; there is nothing written yet for it to know.
		const batches = batched(allPending, BATCH_SIZE);

		for (const [batchNum, batch] of batches.entries()) {
			pending.push(...batch);
			// Spawn CONCURRENCY workers and let them race through this batch.
			await Promise.all(Array.from({ length: CONCURRENCY }, processNextChapter));

			// No point distilling after the final batch — nobody reads it.
			if (batchNum === batches.length - 1) break;

			globalState.addLog(book.id, {
				step: 'review', status: 'running',
				message: `Folding batch ${batchNum + 1}/${batches.length} into the book bible…`
			});

			// Distil each chapter this batch actually wrote. Every failure mode
			// here is non-fatal: a chapter that failed to write has nothing to
			// distil, and a distillation that throws just means the next batch
			// runs with a slightly thinner bible. Neither is worth losing a book
			// over, so nothing in this fold is allowed to reject.
			const live = globalState.books.find(b => b.id === book.id)!.chapters;
			const distilled = await Promise.all(
				batch.map(async (i) => {
					const c = live[i];
					if (c.status !== 'completed' || !c.content?.trim()) return [];
					try {
						return await this.distillChapter(book, c, keys, useMock);
					} catch (err: any) {
						globalState.addLog(book.id, {
							step: 'review', status: 'error',
							message: `Could not distil Chapter ${c.order} into the book bible: ${err?.message ?? err}. Continuing — later chapters just won't know about it.`
						});
						return [];
					}
				})
			);

			bible = mergeBible(bible, distilled.flat());
			globalState.updateBookBible(book.id, bible);
			globalState.addLog(book.id, {
				step: 'review', status: 'success',
				message: `Book bible now holds ${bible.length} entries (~${bibleTokens(bible)} tokens) for the next batch.`
			});
		}

		const wrote = chapters.length - failedChapters.length;
		globalState.updateBookStatus(book.id, failedChapters.length ? 'failed' : 'completed');
		globalState.setPipelineStage(book.id, 5);
		globalState.addLog(book.id, failedChapters.length
			? {
				step: 'complete', status: 'error',
				message: `${wrote}/${chapters.length} chapters written. Failed: ${failedChapters.join(', ')}. Regenerate those from the reader.`
			}
			: {
				step: 'complete', status: 'success',
				message: '🎉 All chapters complete. Ebook ready to read and export.'
			});
	}

	/**
	 * Ask the cheap model what a finished chapter committed to. Throws on
	 * failure — every caller is expected to treat that as "no entries".
	 */
	private async distillChapter(
		book: Book,
		chap: Chapter,
		keys: typeof globalState.apiKeys,
		useMock: boolean
	): Promise<BibleEntry[]> {
		const res = await fetch('/api/write', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'distill-chapter',
				apiKey: keys.anthropicKey,
				useMockMode: useMock,
				bookTitle: book.title,
				chapterTitle: chap.title,
				chapterOrder: chap.order,
				chapterContent: chap.content
			})
		});
		const data = await res.json();
		if (!data.success) throw new Error(data.error || 'distillation failed');
		if (data.usage) globalState.addBookUsage(book.id, { claude: data.usage });
		return (data.entries ?? []) as BibleEntry[];
	}

	/** Draft one chapter, STREAMING the text so the row shows live word-by-word
	 *  progress and the partial is saved as it arrives — a mid-draft reload keeps
	 *  what was written. Pass `resumeDraft` to continue a saved partial (prefilled
	 *  server-side so Claude picks up seamlessly). Returns the finished raw draft. */
	private async draftChapter(
		bookId: string,
		chapIndex: number,
		chaptersSnapshot: Chapter[],
		factsSummary: string,
		keys: typeof globalState.apiKeys,
		useMock: boolean,
		bookBible: BibleEntry[],
		resumeDraft?: string
	): Promise<string> {
		const chap = chaptersSnapshot[chapIndex];
		const book = globalState.books.find(b => b.id === bookId)!;
		// Target length, so streamed words-so-far map onto the 1–30% the draft owns.
		const expectedWords = Math.max(400, planForBook(book).wordsPerChapter || 1200);

		if (resumeDraft === undefined) {
			// Fresh draft — stamp a clean start and clear any prior run's artifacts.
			const live = [...globalState.books.find(b => b.id === bookId)!.chapters];
			live[chapIndex] = {
				...live[chapIndex],
				status: 'writing',
				startedAt: Date.now(),
				completedAt: undefined,
				progress: 1,
				content: '',
				illustrationUrl: null,
				illustrationLabels: [],
				plateSuggestions: [],
				platesDone: 0
			};
			globalState.updateBookChapters(bookId, live);
		}
		globalState.addLog(bookId, {
			step: 'drafting', status: 'running',
			message: resumeDraft !== undefined
				? `Resuming Chapter ${chap.order} draft…`
				: `Writing Chapter ${chap.order}: "${chap.title}"…`
		});

		// startedAt is offset by any banked time (writeSingleChapter set it up for a
		// resume), so `Date.now() - startedAt` is always the running total.
		const startedAt = globalState.books.find(b => b.id === bookId)!.chapters[chapIndex].startedAt ?? Date.now();

		const baseBody = {
			action:         'write-chapter',
			streamToClient: true,
			apiKey:         keys.anthropicKey,
			useMockMode:    useMock,
			bookTitle:      book.title,
			genre:          book.genre,
			structure:      book.structure,
			length:         book.length,
			pageCount:      book.pageCount,
			chapterTitle:   chap.title,
			chapterOrder:   chap.order,
			chapterSummary: chap.summary,
			tone:           book.tone,
			visualDensity:  book.visualDensity,
			researchNotes:  factsSummary,
			bookOutline:    chaptersSnapshot.map(c => ({ order: c.order, title: c.title, summary: c.summary })),
			bookBible,
			bookFormat:       book.format,
			chapterUnitStart: chap.unitStart,
			chapterUnitEnd:   chap.unitEnd
		};

		let content = resumeDraft ?? '';
		let lastSave = 0;
		const save = () => {
			const words = content.trim() ? content.trim().split(/\s+/).length : 0;
			const pct = Math.min(30, 1 + Math.round((words / expectedWords) * 29));
			this.patchChapter(bookId, chapIndex, { content, progress: pct, elapsedMs: Date.now() - startedAt });
		};

		// Stream the draft; if the model runs out of output room mid-chapter,
		// continue it from what we have (a prefill) until it reaches a natural end.
		const MAX_CONTINUES = 6;
		for (let round = 0; round <= MAX_CONTINUES; round++) {
			const res = await fetch('/api/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...baseBody, draftSoFar: content || undefined })
			});
			if (!res.ok) throw new Error(`Chapter ${chap.order} draft failed (HTTP ${res.status}).`);

			// Mock mode (and any non-streaming fallback) returns plain JSON.
			if (!(res.headers.get('Content-Type') || '').includes('ndjson')) {
				const data = await res.json();
				if (!data.success) throw new Error(data.error || `Chapter ${chap.order} draft failed.`);
				if (data.usage) globalState.addBookUsage(bookId, { claude: data.usage });
				content += data.content ?? '';
				break;
			}

			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			let stopReason: string | null = null;
			let streamErr: string | null = null;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) continue;
					let msg: any;
					try { msg = JSON.parse(line); } catch { continue; }
					if (typeof msg.t === 'string') {
						content += msg.t;
						// Throttle persistence to ~1/sec — the bar still moves smoothly.
						const nowMs = Date.now();
						if (nowMs - lastSave > 1000) { lastSave = nowMs; save(); }
					} else if (msg.error) {
						streamErr = msg.error;
					} else if (msg.done) {
						stopReason = msg.stopReason ?? null;
						if (msg.usage) globalState.addBookUsage(bookId, { claude: msg.usage });
					}
				}
			}
			save();
			if (streamErr) throw new Error(`Chapter ${chap.order} draft: ${streamErr}`);
			if (stopReason !== 'max_tokens') break; // natural end; otherwise continue it
		}

		// Draft complete — persist the finished raw draft and advance to 30%.
		const done = [...globalState.books.find(b => b.id === bookId)!.chapters];
		done[chapIndex] = {
			...done[chapIndex],
			progress: 30,
			content,
			researchNotes: factsSummary,
			elapsedMs: Date.now() - (done[chapIndex].startedAt ?? Date.now())
		};
		globalState.updateBookChapters(bookId, done);
		return content;
	}

	/** Verify one chapter's draft — the fact-check + readability pass. Split from
	 *  the draft so a resume can re-verify a saved draft without redrafting. */
	private async verifyChapter(
		bookId: string,
		chapIndex: number,
		draftContent: string,
		factsSummary: string,
		keys: typeof globalState.apiKeys,
		useMock: boolean
	): Promise<string> {
		const book = globalState.books.find(b => b.id === bookId)!;
		const chap = book.chapters[chapIndex];
		this.patchChapter(bookId, chapIndex, { status: 'verifying', progress: 40 });

		const verifyRes = await fetch('/api/write', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'verify-chapter',
				apiKey: keys.anthropicKey,
				useMockMode: useMock,
				bookTitle: book.title,
				genre: book.genre,
				tone: book.tone,
				chapterTitle: chap.title,
				chapterContent: draftContent,
				researchNotes: factsSummary,
				// Without this the editor treats the repeating structure as a
				// weakness and edits it out — see the guard in the verify prompt.
				bookFormat: book.format
			})
		});
		const verifyData = await verifyRes.json();
		if (verifyData.usage) globalState.addBookUsage(bookId, { claude: verifyData.usage });
		return verifyData.success ? verifyData.verifiedContent : draftContent;
	}

	/** Write + illustrate exactly one chapter. Shared between pipeline and per-chapter regen. */
	private async writeSingleChapter(
		bookId: string,
		chapIndex: number,
		chaptersSnapshot: Chapter[],
		factsSummary: string,
		keys: typeof globalState.apiKeys,
		useMock: boolean,
		bookBible: BibleEntry[] = [],
		resume: boolean = false
	) {
		const chap = chaptersSnapshot[chapIndex];
		const book = globalState.books.find(b => b.id === bookId)!;

		// A chapter interrupted DURING illustration already had its verified draft
		// persisted (see the handoff at the end of the else branch), so resuming it
		// skips the costly draft + verify passes and picks up at the illustration
		// phase it left off in — the ~52% the user last saw — instead of restarting
		// from a blank draft. Chapters interrupted earlier (writing/verifying) have
		// no saved draft, so they correctly fall through to a full rewrite.
		// What survives an interruption decides how far back a resume rewinds:
		//   • 'illustrating' + content → draft AND verify are done; skip to plates.
		//   • 'verifying'    + content → the raw draft is saved; skip drafting, just
		//     re-verify (one cheap call) then illustrate.
		//   • 'writing'      + content → a partial streamed draft is saved; CONTINUE
		//     it from where it stopped rather than starting the draft over.
		//   • anything else → nothing saved yet, so start clean.
		const hasContent         = !!chap.content?.trim();
		const resumeIllustration = resume && chap.status === 'illustrating' && hasContent;
		const resumeVerify       = resume && chap.status === 'verifying'    && hasContent;
		const resumeDraft        = resume && chap.status === 'writing'      && hasContent;

		let finalContent: string;
		// The reference start for this chapter's elapsed timer. It is pushed back by
		// any time already banked (chap.elapsedMs), so `Date.now() - sessionStartedAt`
		// is always the running total — a resume continues the clock instead of
		// restarting it at zero.
		let sessionStartedAt: number;
		if (resumeIllustration) {
			finalContent = chap.content;
			// Continue the timer from the time already accumulated, not from zero.
			sessionStartedAt = Date.now() - (chap.elapsedMs ?? 0);
			this.patchChapter(bookId, chapIndex, {
				status: 'illustrating',
				startedAt: sessionStartedAt,
				completedAt: undefined
			});
		} else {
			if (resumeVerify) {
				// The raw draft is already saved — skip the expensive write pass and
				// just re-run verification on it, continuing the banked timer.
				sessionStartedAt = Date.now() - (chap.elapsedMs ?? 0);
				this.patchChapter(bookId, chapIndex, { startedAt: sessionStartedAt, completedAt: undefined });
				finalContent = await this.verifyChapter(bookId, chapIndex, chap.content, factsSummary, keys, useMock);
			} else {
				let rawDraft: string;
				if (resumeDraft) {
					// A partial streamed draft is saved — continue it from where it
					// stopped, keeping the banked timer running.
					sessionStartedAt = Date.now() - (chap.elapsedMs ?? 0);
					this.patchChapter(bookId, chapIndex, { startedAt: sessionStartedAt, completedAt: undefined });
					rawDraft = await this.draftChapter(bookId, chapIndex, chaptersSnapshot, factsSummary, keys, useMock, bookBible, chap.content);
				} else {
					rawDraft = await this.draftChapter(bookId, chapIndex, chaptersSnapshot, factsSummary, keys, useMock, bookBible);
					// draftChapter stamped startedAt at the draft; keep counting from
					// there so the timer spans the whole chapter, not just illustration.
					sessionStartedAt = globalState.books.find(b => b.id === bookId)!.chapters[chapIndex].startedAt ?? Date.now();
				}
				finalContent = await this.verifyChapter(bookId, chapIndex, rawDraft, factsSummary, keys, useMock);
			}
			// Persist the verified draft NOW — before the long opener + plate phase —
			// so an interruption during illustration resumes from it. This is also
			// where 'verifying' hands off to the 'illustrating' status (the row used
			// to sit on "Verifying…" for minutes while it was really drawing). The
			// illustration checkpoint is reset to a clean slate so a stale
			// opener/plan/counter can never make a resume skip plates it never made.
			this.patchChapter(bookId, chapIndex, {
				status: 'illustrating',
				progress: 52,
				content: finalContent,
				researchNotes: factsSummary,
				elapsedMs: Date.now() - sessionStartedAt,
				illustrationUrl: null,
				illustrationLabels: [],
				plateSuggestions: [],
				platesDone: 0
			});
		}

		// ── Illustration ──────────────────────────────────────────────────────
		// Every step below persists the moment it finishes — the opener, the plate
		// plan, and each plate spliced into the content — so a chapter interrupted
		// mid-illustration and resumed picks up at the exact next plate, keeping the
		// images it already made instead of redrawing them.
		globalState.addLog(bookId, {
			step: 'illustrate', status: 'running',
			message: resumeIllustration
				? `Resuming illustration for Chapter ${chap.order}…`
				: `Generating illustration for Chapter ${chap.order}…`
		});

		// Opener — reuse the saved one when resuming mid-illustration; otherwise draw
		// it and save it immediately so a later interruption never redraws it.
		let illustUrl:    string | null       = resumeIllustration ? (chap.illustrationUrl ?? null) : null;
		let illustLabels: IllustrationLabel[] = resumeIllustration ? (chap.illustrationLabels ?? []) : [];
		// The opener's subject feeds the plate planner so it won't propose the same
		// picture. Not persisted — it is only needed before the plan exists, and by
		// the time a resume matters the plan is already saved.
		let openerSubject = '';
		if (!illustUrl) {
			try {
				// Brief it from what the chapter actually SAYS and the research
				// actually FOUND — then draw it, then label the picture that came back.
				const made = await createIllustration(
					book,
					{
						chapterTitle:   chap.title,
						chapterOrder:   chap.order,
						chapterSummary: chap.summary,
						chapterContent: finalContent,
						researchNotes:  factsSummary
					},
					keys,
					useMock
				);
				illustUrl    = made.url;
				illustLabels = made.labels;
				if (made.subject) openerSubject = made.subject;
				made.claudeUsage.forEach(u => globalState.addBookUsage(bookId, { claude: u }));
				if (made.imageBilled) globalState.addBookUsage(bookId, { images: 1 });
				this.patchChapter(bookId, chapIndex, {
					illustrationUrl: illustUrl,
					illustrationLabels: illustLabels,
					elapsedMs: Date.now() - sessionStartedAt
				});
			} catch { /* non-fatal */ }
			// Only bump to 62% when the opener actually ran — on a resume the bar is
			// already further along and must not jump backward.
			this.patchChapter(bookId, chapIndex, { progress: 62 });
		}

		// ── Extra plates for the richer visual-density tiers ──────────────────
		// 'standard' books stop at the one opener above. 'rich' and 'maximum' both
		// add more, and both do it the SAME smart way: a planning pass reads the
		// finished chapter and decides which sections genuinely earn a full-page
		// photographic plate — skipping the ones a photo would only pad — and what
		// each should depict. Neither tier ever forces a plate onto a section that
		// does not warrant one.
		//
		// The tiers differ ONLY in how many of those qualified spots they fill:
		//   • 'rich'    — the strongest few (the plan is ranked strongest-first).
		//   • 'maximum' — every section that qualifies.
		//
		// Each plate is spliced into the exact section it illustrates as a ```plate
		// block, which the reader renders just like the opener, labels and all.
		// Everything is best-effort: a failed plate is one fewer figure, never a
		// failed chapter, and it all runs only once the opener produced a real
		// image (illustUrl) — otherwise there is nothing to build a richer chapter
		// on.
		const density = book.visualDensity ?? 'standard';
		const RICH_PLATE_CAP = 2;
		// The full ranked plan — persisted once so a resume fills the SAME sections
		// in the same order. On a resume it is already saved; otherwise plan it now.
		let plateSuggestions: { section: string; subject: string }[] = resumeIllustration ? (chap.plateSuggestions ?? []) : [];
		// How many chosen plates are already generated and spliced into the content.
		let platesDone = resumeIllustration ? (chap.platesDone ?? 0) : 0;

		if (illustUrl) {
			try {
				if (!plateSuggestions.length) {
					const plan = await planChapterPlates(
						book,
						{
							chapterTitle:   chap.title,
							chapterOrder:   chap.order,
							chapterSummary: chap.summary,
							chapterContent: finalContent,
							researchNotes:  factsSummary
						},
						// The opener's subject, so the plan does not propose it again.
						openerSubject,
						keys,
						useMock
					);
					if (plan.usage) globalState.addBookUsage(bookId, { claude: plan.usage });
					plateSuggestions = plan.plates;
					// Persist the plan (and a fresh counter) so a resume reuses it.
					this.patchChapter(bookId, chapIndex, { plateSuggestions, platesDone: 0 });
				}

				// 'standard' records the suggestions but auto-generates none; 'rich'
				// fills the strongest few; 'maximum' fills every approved section.
				const chosen = density === 'standard' ? []
					: density === 'rich' ? plateSuggestions.slice(0, RICH_PLATE_CAP)
					: plateSuggestions;

				// Resume from the first plate not yet done — everything before
				// `platesDone` is already spliced into the persisted content.
				for (let pi = platesDone; pi < chosen.length; pi++) {
					const spec = chosen[pi];
					// Advance the bar across the plate span (62 → 95) as each section
					// is processed, so the row keeps moving through the slowest phase
					// instead of sitting frozen while ~24 images render one by one.
					const bumpProgress = () => this.patchChapter(bookId, chapIndex, {
						progress: 62 + Math.round(33 * (pi + 1) / chosen.length)
					});

					const subject = spec?.subject?.trim();
					const section = spec?.section?.trim();
					if (subject && section) {
						const brief = {
							chapterTitle:   chap.title,
							chapterOrder:   chap.order,
							chapterSummary: chap.summary,
							chapterContent: finalContent,
							researchNotes:  factsSummary,
							// The plan chose this subject; mandate it so the art-director
							// depicts exactly that, not its own pick.
							authorNote:     `Depict this specific subject from the chapter, and nothing else: ${subject}.`
						};

						// A plate is one image plus two Claude calls, and a transient
						// failure in any of them would drop this section's photo entirely.
						// The plan already judged this section worth illustrating, so try
						// twice before giving up rather than skipping it on a one-off hiccup.
						let placed = false;
						for (let attempt = 1; attempt <= 2 && !placed; attempt++) {
							try {
								const extra = await createIllustration(book, brief, keys, useMock);
								extra.claudeUsage.forEach(u => globalState.addBookUsage(bookId, { claude: u }));
								if (extra.imageBilled) globalState.addBookUsage(bookId, { images: 1 });
								// Splice THIS plate in immediately — titled with its section
								// heading, which becomes the plate's header bar — so an
								// interruption here keeps it and resumes at the next one.
								if (extra.url) {
									finalContent = splicePlatesAtSections(finalContent, [
										{ section, block: buildPlateBlock(extra.url, extra.labels, section) }
									]);
									placed = true;
								}
							} catch { /* retry once, then leave this one section unillustrated */ }
						}
					}

					// Mark this plate handled (placed or skipped) and persist the WIP
					// content + banked time, so a reload never repeats it and resumes
					// at pi + 1 with the timer continuing from here.
					platesDone = pi + 1;
					this.patchChapter(bookId, chapIndex, {
						content: finalContent,
						platesDone,
						elapsedMs: Date.now() - sessionStartedAt
					});
					bumpProgress();
				}
			} catch { /* planning failed — the chapter keeps its opener */ }
		}

		// Surface what the density tier actually did, so "why only one image?" is
		// answerable from the run log instead of a guess. Only the richer tiers
		// add plates, so only they report — 'standard' has nothing to say here. The
		// count is read back from the content so a resumed chapter reports its true
		// total, not just this session's additions.
		const extraPlatesAdded = (finalContent.match(/```plate/g) ?? []).length;
		if (density !== 'standard') {
			globalState.addLog(bookId, {
				step: 'illustrate', status: 'success',
				message: `Chapter ${chap.order}: visual density "${density}" added ${extraPlatesAdded} extra plate${extraPlatesAdded === 1 ? '' : 's'} (plus the opener).`
			});
		}

		// Commit
		const final = [...globalState.books.find(b => b.id === bookId)!.chapters];
		final[chapIndex].content            = finalContent;
		final[chapIndex].researchNotes      = factsSummary;
		final[chapIndex].illustrationUrl    = illustUrl;
		final[chapIndex].illustrationLabels = illustLabels;
			final[chapIndex].plateSuggestions   = plateSuggestions;
		final[chapIndex].status             = 'completed';
		final[chapIndex].progress           = 100;
		final[chapIndex].completedAt        = Date.now();
		final[chapIndex].elapsedMs          = Date.now() - sessionStartedAt;
		globalState.updateBookChapters(bookId, final);

		globalState.addLog(bookId, {
			step: 'drafting', status: 'success',
			message: `Chapter ${chap.order} complete.`
		});
	}

	/** Per-chapter regeneration triggered from Stage 4 UI */
	async regenerateChapter(bookId: string, chapIndex: number) {
		const book = globalState.books.find(b => b.id === bookId);
		const run  = this.for(bookId);
		if (!book || run.isWriting || run.regeneratingChapterIdx !== null) return;

		this.patch(bookId, { regeneratingChapterIdx: chapIndex, runStartedAt: Date.now(), runEndedAt: null });

		const keys    = globalState.apiKeys;
		const useMock = keys.useMockMode;
		const chap    = book.chapters[chapIndex];

		// A chapter interrupted with saved content — a partial streamed draft
		// ('writing'), a finished draft ('verifying'), or a verified draft mid-
		// illustration ('illustrating') — is a RESUME: skip re-research (the saved
		// content already carries it) and hand writeSingleChapter the resume flag so
		// it picks up where it left off instead of rewriting from scratch.
		const resuming = (chap.status === 'illustrating' || chap.status === 'verifying' || chap.status === 'writing') && !!chap.content?.trim();

		// ── Book-level background research ──────────────────────────────────
		let bookLevelFacts = '';
		if (!resuming) try {
			const r = await fetch('/api/research', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: `${book.title} ${book.genre} comprehensive overview key concepts`,
					apiKey: keys.exaKey,
					useMockMode: useMock
				})
			});
			const rd = await r.json();
			if (rd.source === 'live') globalState.addBookUsage(bookId, { searches: 1 });
			else if (rd.usage) globalState.addBookUsage(bookId, { claude: rd.usage });
			bookLevelFacts = rd.success
				? (rd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';
		} catch { /* non-fatal */ }

		// ── Chapter-specific targeted research ────────────────────────────
		let chapterFacts = '';
		if (!resuming) try {
			const cr = await fetch('/api/research', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: `${chap.title} ${book.title} ${book.genre} ${chap.summary ?? ''}`.trim(),
					apiKey: keys.exaKey,
					useMockMode: useMock
				})
			});
			const crd = await cr.json();
			if (crd.source === 'live') globalState.addBookUsage(bookId, { searches: 1 });
			else if (crd.usage) globalState.addBookUsage(bookId, { claude: crd.usage });
			chapterFacts = crd.success
				? (crd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';
		} catch { /* non-fatal */ }

		const factsSummary = resuming
			? (chap.researchNotes ?? '')
			: [
				book.userContext?.trim() ? `[Author Brief]\n${book.userContext.trim()}` : '',
				bookLevelFacts ? `[Book-Level Research]\n${bookLevelFacts}` : '',
				chapterFacts   ? `[Chapter-Specific Research for "${chap.title}"]\n${chapterFacts}` : ''
			].filter(Boolean).join('\n\n');

		try {
			const snapshot = [...book.chapters];
			// Regenerate against the book bible so the new draft honours what the
			// rest of the book already established — minus this chapter's own
			// entries, which describe the draft we are about to throw away.
			const bible = (book.bible ?? []).filter(e => e.chapter !== snapshot[chapIndex].order);
			await this.writeSingleChapter(bookId, chapIndex, snapshot, factsSummary, keys, useMock, bible, resuming);
		} catch (err: any) {
			const current = [...globalState.books.find(b => b.id === bookId)!.chapters];
			current[chapIndex] = { ...current[chapIndex], status: 'failed', completedAt: Date.now() };
			globalState.updateBookChapters(bookId, current);
			globalState.addLog(bookId, {
				step: 'drafting', status: 'error',
				message: `Regeneration failed for Chapter ${chapIndex + 1}: ${err.message}`
			});
		} finally {
			this.patch(bookId, { regeneratingChapterIdx: null, runEndedAt: Date.now() });
			// Redoing the one chapter that failed the run makes the whole book
			// complete again — re-derive the top-level status so the library stops
			// showing "Failed" over a book that is now finished.
			globalState.recomputeBookStatus(bookId);
		}
	}
}

export const generationRunner = new GenerationRunner();
