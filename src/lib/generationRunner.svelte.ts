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
import { createIllustration } from './illustration';
import { COVER_TEMPLATES, AI_CONCEPT_COUNT, buildCoverDirection, buildBriefCoverPrompt, hasCoverBrief, type CoverTemplate } from './coverStyles';
import { batched, BATCH_SIZE } from './bookPlan';
import { mergeBible, bibleTokens } from './bookBible';

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
	regeneratingChapterIdx: null
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
		this.patch(book.id, { isWriting: true });
		// try/finally so isWriting always clears. It used to be reset only on
		// the success path, so any throw left it stuck true and the pipeline
		// refused to start again (the guard above) until a full page reload.
		try {
			await this.writeAllChapters(book);
		} finally {
			this.patch(book.id, { isWriting: false });
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
					live[i].status = 'failed';
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

	/** Write + illustrate exactly one chapter. Shared between pipeline and per-chapter regen. */
	private async writeSingleChapter(
		bookId: string,
		chapIndex: number,
		chaptersSnapshot: Chapter[],
		factsSummary: string,
		keys: typeof globalState.apiKeys,
		useMock: boolean,
		bookBible: BibleEntry[] = []
	) {
		const chap = chaptersSnapshot[chapIndex];
		const book = globalState.books.find(b => b.id === bookId)!;

		// Mark writing
		const live = [...globalState.books.find(b => b.id === bookId)!.chapters];
		live[chapIndex].status = 'writing';
		globalState.updateBookChapters(bookId, live);
		globalState.addLog(bookId, {
			step: 'drafting', status: 'running',
			message: `Writing Chapter ${chap.order}: "${chap.title}"…`
		});

		// Draft — include all book context fields so Claude can write unique, informed content
		const draftRes = await fetch('/api/write', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'write-chapter',
				apiKey: keys.anthropicKey,
				useMockMode: useMock,
				bookTitle: book.title,
				genre: book.genre,
				structure: book.structure,
				// Sizes the per-chapter output budget on the server.
				length: book.length,
				pageCount: book.pageCount,
				chapterTitle: chap.title,
				chapterOrder: chap.order,
				chapterSummary: chap.summary,
				tone: book.tone,
				researchNotes: factsSummary,
				// The whole plan, so a chapter knows its place in the book.
				// Chapters are written concurrently and never see each other's
				// output, so without this each one is blind to the rest and
				// re-explains the same foundations. ~40 tokens per chapter
				// against a 200k window — it is what makes long books cohere.
				bookOutline: chaptersSnapshot.map(c => ({
					order:   c.order,
					title:   c.title,
					summary: c.summary
				})),
				// What the already-written chapters SAID, as opposed to what the
				// outline planned for them. Bounded to ~2.5k tokens however long
				// the book is — that bound is the whole reason this scales.
				bookBible,

				// The book's shape, decided once before the outline, plus the span
				// of units THIS chapter owns. Both are needed: the format says what
				// a unit looks like; the range says which ones are this chapter's.
				// Chapters run concurrently, so that range is the only thing
				// stopping two of them both writing number 47.
				bookFormat:       book.format,
				chapterUnitStart: chap.unitStart,
				chapterUnitEnd:   chap.unitEnd
			})
		});
		const draftData = await draftRes.json();
		if (!draftData.success) throw new Error(draftData.error || `Chapter ${chap.order} draft failed.`);
		if (draftData.usage) globalState.addBookUsage(bookId, { claude: draftData.usage });

		// Verify
		const current = [...globalState.books.find(b => b.id === bookId)!.chapters];
		current[chapIndex].status = 'verifying';
		globalState.updateBookChapters(bookId, current);

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
				chapterContent: draftData.content,
				researchNotes: factsSummary,
				// Without this the editor treats the repeating structure as a
				// weakness and edits it out — see the guard in the verify prompt.
				bookFormat: book.format
			})
		});
		const verifyData = await verifyRes.json();
		if (verifyData.usage) globalState.addBookUsage(bookId, { claude: verifyData.usage });
		const finalContent = verifyData.success ? verifyData.verifiedContent : draftData.content;

		// Illustration — art-directed from the finished chapter and its research
		globalState.addLog(bookId, {
			step: 'illustrate', status: 'running',
			message: `Generating illustration for Chapter ${chap.order}…`
		});

		let illustUrl: string | null = null;
		let illustLabels: IllustrationLabel[] = [];
		try {
			// Brief it from what the chapter actually SAYS and what the research
			// actually FOUND — both already in hand here — then draw it, then label
			// the picture that came back. The plate is the only part of the page an
			// image model draws unsupervised, so the brief it gets is the whole
			// difference between a plate that teaches this chapter and stock art
			// that could sit in any book.
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
			made.claudeUsage.forEach(u => globalState.addBookUsage(bookId, { claude: u }));
			if (made.imageBilled) globalState.addBookUsage(bookId, { images: 1 });
		} catch { /* non-fatal */ }

		// Commit
		const final = [...globalState.books.find(b => b.id === bookId)!.chapters];
		final[chapIndex].content            = finalContent;
		final[chapIndex].researchNotes      = factsSummary;
		final[chapIndex].illustrationUrl    = illustUrl;
		final[chapIndex].illustrationLabels = illustLabels;
		final[chapIndex].status             = 'completed';
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

		this.patch(bookId, { regeneratingChapterIdx: chapIndex });

		const keys    = globalState.apiKeys;
		const useMock = keys.useMockMode;
		const chap    = book.chapters[chapIndex];

		// ── Book-level background research ──────────────────────────────────
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
			if (rd.source === 'live') globalState.addBookUsage(bookId, { searches: 1 });
			else if (rd.usage) globalState.addBookUsage(bookId, { claude: rd.usage });
			bookLevelFacts = rd.success
				? (rd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';
		} catch { /* non-fatal */ }

		// ── Chapter-specific targeted research ────────────────────────────
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
			if (crd.source === 'live') globalState.addBookUsage(bookId, { searches: 1 });
			else if (crd.usage) globalState.addBookUsage(bookId, { claude: crd.usage });
			chapterFacts = crd.success
				? (crd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';
		} catch { /* non-fatal */ }

		const factsSummary = [
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
			await this.writeSingleChapter(bookId, chapIndex, snapshot, factsSummary, keys, useMock, bible);
		} catch (err: any) {
			const current = [...globalState.books.find(b => b.id === bookId)!.chapters];
			current[chapIndex].status = 'failed';
			globalState.updateBookChapters(bookId, current);
			globalState.addLog(bookId, {
				step: 'drafting', status: 'error',
				message: `Regeneration failed for Chapter ${chapIndex + 1}: ${err.message}`
			});
		} finally {
			this.patch(bookId, { regeneratingChapterIdx: null });
			// Redoing the one chapter that failed the run makes the whole book
			// complete again — re-derive the top-level status so the library stops
			// showing "Failed" over a book that is now finished.
			globalState.recomputeBookStatus(bookId);
		}
	}
}

export const generationRunner = new GenerationRunner();
