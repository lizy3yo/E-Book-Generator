import type { Book, ApiKeys, StepLog, Chapter, CoverSettings, CoverOption, PipelineStage, BibleEntry, IllustrationLabel, BookFormat, BookUsage } from './types';
import type { CoverDesign } from './coverPalette';
import { supabase } from './supabase';

class GlobalState {
	books = $state<Book[]>([]);
	activeBookId = $state<string | null>(null);
	apiKeys = $state<ApiKeys>({
		anthropicKey: '',
		exaKey: '',
		imageKey: '',
		imageProvider: 'kie',
		useMockMode: true
	});
	initialized = $state(false);

	constructor() {
		if (typeof window !== 'undefined') {
			this.init();
		}
	}

	// ─── Initialisation ──────────────────────────────────────────────────────────

	async init() {
		// Load API keys from localStorage (never stored in Supabase)
		try {
			const savedKeys = localStorage.getItem('ebook_api_keys');
			if (savedKeys) {
				this.apiKeys = { ...this.apiKeys, ...JSON.parse(savedKeys) };
			}

			const savedActiveBookId = localStorage.getItem('ebook_active_book_id');
			if (savedActiveBookId) {
				this.activeBookId = savedActiveBookId;
			}
		} catch (e) {
			console.error('Failed to load settings from localStorage:', e);
		}

		// Load books from Supabase; fall back to localStorage cache on error
		await this.loadBooksFromSupabase();

		this.initialized = true;
	}

	private async loadBooksFromSupabase() {
		try {
			const { data, error } = await supabase
				.from('books')
				.select('data')
				.order('created_at', { ascending: false });

			if (error) throw error;

			this.books = (data ?? [])
				.map((row: { data: Book }) => row.data)
				.map(this.sanitiseBook);

			// Refresh local cache with clean data
			localStorage.setItem('ebook_books', JSON.stringify(this.books));
		} catch (e) {
			console.warn('Supabase unavailable, loading from local cache:', e);
			try {
				const cached = localStorage.getItem('ebook_books');
				if (cached) this.books = (JSON.parse(cached) as Book[]).map(this.sanitiseBook);
			} catch {
				this.books = [];
			}
		}
	}

	/**
	 * Strip debug / mock artifacts that may have been written into chapter
	 * content during earlier development sessions.  Runs on every load so
	 * stale data is cleaned transparently without manual intervention.
	 *
	 * Patterns removed:
	 *   • *[Mock …]* italic wrappers left by old mock API responses
	 *   • --- \n*[Edited passage — review and merge manually]*\n… fallback blocks
	 *   • Bare [Mock …] text (without italic markers, after entity rendering)
	 *   • Leading / trailing blank lines left behind after removal
	 */
	private sanitiseBook = (book: Book): Book => {
		const cleanedChapters = book.chapters.map((chapter) => {
			if (!chapter.content) return chapter;

			let content = chapter.content;

			// Remove the splicePage fallback block:
			// "---\n*[Edited passage — review and merge manually]*\n\n<new content>"
			// The new content following it should be kept, so we strip only the header.
			content = content.replace(
				/\n*---\n\*\[Edited passage[^\]]*\]\*\n*/g,
				'\n\n'
			);

			// Remove old italic mock markers: *[Mock …]* (any variant)
			content = content.replace(/\*\[Mock[^\]]*\]\*/g, '');

			// Remove bare [Mock …] text (rendered version without asterisks)
			content = content.replace(/\[Mock[^\]]*\]/g, '');

			// Collapse 3+ consecutive blank lines down to 2
			content = content.replace(/\n{3,}/g, '\n\n').trim();

			if (content === chapter.content) return chapter;

			return { ...chapter, content };
		});

		// Only create a new book object if something actually changed
		const changed = cleanedChapters.some((c, i) => c !== book.chapters[i]);
		if (!changed) return book;

		const cleanedBook: Book = { ...book, chapters: cleanedChapters };

		// Persist the clean version asynchronously — fire and forget
		this.persistBook(cleanedBook);

		return cleanedBook;
	};

	// ─── Persistence ─────────────────────────────────────────────────────────────

	saveKeys(keys: ApiKeys) {
		this.apiKeys = keys;
		if (typeof window !== 'undefined') {
			localStorage.setItem('ebook_api_keys', JSON.stringify(keys));
		}
	}

	/** Upsert a single book to Supabase and refresh the local cache. */
	private async persistBook(book: Book) {
		try {
			const { error } = await supabase
				.from('books')
				.upsert(
					{ id: book.id, data: book },
					{ onConflict: 'id' }
				);

			if (error) throw error;
		} catch (e) {
			console.error('Failed to persist book to Supabase:', e);
		}

		// Always keep localStorage in sync as a local cache
		localStorage.setItem('ebook_books', JSON.stringify(this.books));
	}

	/** Remove a single book from Supabase. */
	private async removeBookFromDB(id: string) {
		try {
			const { error } = await supabase
				.from('books')
				.delete()
				.eq('id', id);

			if (error) throw error;
		} catch (e) {
			console.error('Failed to delete book from Supabase:', e);
		}

		localStorage.setItem('ebook_books', JSON.stringify(this.books));
	}

	// ─── Active Book ─────────────────────────────────────────────────────────────

	setActiveBook(id: string | null) {
		this.activeBookId = id;
		if (typeof window !== 'undefined') {
			if (id) localStorage.setItem('ebook_active_book_id', id);
			else localStorage.removeItem('ebook_active_book_id');
		}
	}

	// ─── CRUD ────────────────────────────────────────────────────────────────────

	createBook(params: {
		title: string;
		subtitle: string;
		author: string;
		genre: string;
		length: 'short' | 'medium' | 'long';
		/** Target pages, 50–600. Drives the chapter plan; see $lib/bookPlan. */
		pageCount?: number;
		tone: string;
		structure: string;
		useUltraRealistic: boolean;
		researchDepth: 'basic' | 'deep';
		selfCorrectionLevel: 'standard' | 'rigorous';
		visualDensity: 'standard' | 'rich' | 'maximum';
		userContext: string;
		coverReferencePrompt: string;
	}): Book {
		const newBook: Book = {
			id: crypto.randomUUID(),
			title: params.title,
			subtitle: params.subtitle || 'An Automated Exploration',
			author: params.author || 'AI Automator',
			genre: params.genre || 'General',
			length: params.length,
			pageCount: params.pageCount,
			tone: params.tone || 'Informative',
			structure: params.structure || 'Standard Chapters',
			useUltraRealistic: params.useUltraRealistic,
			researchDepth: params.researchDepth,
			selfCorrectionLevel: params.selfCorrectionLevel,
			visualDensity: params.visualDensity,
			userContext: params.userContext,
			coverReferencePrompt: params.coverReferencePrompt,
			pipelineStage: 1,
			coverOptions: [],
			selectedCoverIndex: null,
			status: 'idle',
			currentStep: 'Idle',
			coverSettings: {
				title: params.title,
				subtitle: params.subtitle || 'An Automated Exploration',
				author: params.author || 'AI Automator',
				titleColor: '#242220',
				subtitleColor: '#6E6860',
				authorColor: '#8E7453',
				titleSize: 36,
				subtitleSize: 18,
				authorSize: 20,
				titleFont: 'Lora',
				alignment: 'center',
				textPosition: 'middle',
				bgImagePrompt: `A beautiful minimalist book cover for a book about "${params.title}" in ${params.genre} genre. Clean vector art.`,
				bgImageUrl: null,
				useUltraRealistic: params.useUltraRealistic,
				overlayOpacity: 0.1
			},
			chapters: [],
			logs: [
				{
					id: crypto.randomUUID(),
					step: 'research',
					status: 'pending',
					message: 'Generation workspace ready.',
					timestamp: new Date().toLocaleTimeString()
				}
			],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		};

		this.books = [newBook, ...this.books];
		this.setActiveBook(newBook.id);
		this.persistBook(newBook);
		return newBook;
	}

	deleteBook(id: string) {
		this.books = this.books.filter(b => b.id !== id);
		if (this.activeBookId === id) {
			this.setActiveBook(this.books.length > 0 ? this.books[0].id : null);
		}
		this.removeBookFromDB(id);
	}

	// ─── Mutations (all persist to Supabase) ─────────────────────────────────────

	addLog(bookId: string, log: Omit<StepLog, 'id' | 'timestamp'>) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const newLog: StepLog = {
			...log,
			id: crypto.randomUUID(),
			timestamp: new Date().toLocaleTimeString()
		};

		const updatedBook: Book = {
			...this.books[bookIndex],
			logs: [...this.books[bookIndex].logs, newLog],
			currentStep: log.message,
			updatedAt: new Date().toISOString()
		};
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	updateBookStatus(bookId: string, status: Book['status']) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = { ...this.books[bookIndex], status, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/**
	 * Re-derive a book's top-level status from its chapters.
	 *
	 * The status is written once, at the end of the writing pipeline: 'failed'
	 * if any chapter failed there, 'completed' otherwise. But a chapter that
	 * failed can be fixed on its own afterwards — regenerated with Redo, or
	 * edited by hand in the reader until it has content — and nothing recomputed
	 * the book status. So a book whose every chapter is now complete kept showing
	 * "Failed" in the library. This closes that gap; call it after any mutation
	 * that changes a single chapter's status.
	 *
	 * Guardrails:
	 *  • Only acts once the book has chapters and has entered the writing phase
	 *    (writing / failed / completed). Earlier stages (idle / researching /
	 *    outlining) own their own status and must not be overwritten by a book
	 *    that simply has no chapters yet.
	 *  • Never overrides an in-flight run: while any chapter is still writing /
	 *    verifying / pending the runner is mid-pipeline and owns the status.
	 */
	recomputeBookStatus(bookId: string) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;
		const book = this.books[bookIndex];

		if (book.chapters.length === 0) return;
		if (book.status !== 'writing' && book.status !== 'failed' && book.status !== 'completed') return;

		const inFlight = book.chapters.some(
			(c) => c.status === 'writing' || c.status === 'verifying' || c.status === 'pending'
		);
		if (inFlight) return;

		// "Done" means the chapter has content the reader can actually see. A
		// failed chapter with no content keeps the book failed; the moment it
		// gains content — via Redo or a manual edit — it counts, which is exactly
		// the behaviour asked for.
		const allDone = book.chapters.every((c) => c.status === 'completed' && !!c.content?.trim());
		const next: Book['status'] = allDone ? 'completed' : 'failed';
		if (next === book.status) return;

		const updatedBook: Book = { ...book, status: next, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	updateBookChapters(bookId: string, chapters: Chapter[]) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = { ...this.books[bookIndex], chapters, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/** Replace the rolling book bible — called once per batch fold. */
	updateBookBible(bookId: string, bible: BibleEntry[]) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = { ...this.books[bookIndex], bible, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	updateBookInteriorDesign(bookId: string, interiorDesign: Record<string, string>) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = { ...this.books[bookIndex], interiorDesign, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/**
	 * Add one AI call's cost to a book's running total. `claude` carries real
	 * token usage from an Anthropic response and is summed per model; `images`
	 * / `searches` are call counts for providers that report no usage data —
	 * their cost is only ever an estimate (see $lib/pricing).
	 */
	addBookUsage(bookId: string, entry: { claude?: { model: string; inputTokens: number; outputTokens: number } | null; images?: number; searches?: number }) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const current: BookUsage = this.books[bookIndex].usage ?? { claude: {}, images: 0, searches: 0 };
		const claude = { ...current.claude };
		if (entry.claude) {
			const { model, inputTokens, outputTokens } = entry.claude;
			const prior = claude[model] ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
			claude[model] = {
				inputTokens: prior.inputTokens + inputTokens,
				outputTokens: prior.outputTokens + outputTokens,
				calls: prior.calls + 1
			};
		}
		const usage: BookUsage = {
			claude,
			images: current.images + (entry.images ?? 0),
			searches: current.searches + (entry.searches ?? 0)
		};

		const updatedBook: Book = { ...this.books[bookIndex], usage, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	updateChapterContent(bookId: string, chapterId: string, content: string, status: Chapter['status']) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const chapIndex = this.books[bookIndex].chapters.findIndex(c => c.id === chapterId);
		if (chapIndex === -1) return;

		// Replace the chapter object immutably so Svelte 5's fine-grained reactivity
		// detects the change and re-runs all derived values and effects that depend
		// on activeBook.chapters. Deep-mutation (chapters[i].content = …) does not
		// reliably invalidate $derived selectors that return the same object reference.
		const updatedChapters = this.books[bookIndex].chapters.map((c, i) =>
			i === chapIndex ? { ...c, content, status } : c
		);
		const updatedBook: Book = {
			...this.books[bookIndex],
			chapters: updatedChapters,
			updatedAt: new Date().toISOString()
		};
		// Replace the top-level array so the $state proxy fires a root-level change
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);

		// A chapter that now has content can lift a "Failed" book back to "Ready".
		this.recomputeBookStatus(bookId);
	}

	/**
	 * Replace a chapter's illustration.
	 *
	 * `illustrationLabels` is REQUIRED, not optional, and always overwritten —
	 * labels are coordinates into one specific picture. Carrying the old ones
	 * over to a new image leaves every callout pointing at a part that is no
	 * longer there, which is the one failure mode this whole feature exists to
	 * prevent. A caller with no labels passes [] and says so.
	 */
	updateChapterIllustration(
		bookId: string,
		chapterId: string,
		illustrationUrl: string,
		illustrationLabels: IllustrationLabel[]
	) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const chapIndex = this.books[bookIndex].chapters.findIndex(c => c.id === chapterId);
		if (chapIndex === -1) return;

		const updatedChapters = this.books[bookIndex].chapters.map((c, i) =>
			i === chapIndex ? { ...c, illustrationUrl, illustrationLabels } : c
		);
		const updatedBook: Book = {
			...this.books[bookIndex],
			chapters: updatedChapters,
			updatedAt: new Date().toISOString()
		};
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/**
	 * Record the shape the book will be written in.
	 *
	 * Written once, before the outline, and read by every chapter afterwards.
	 * It is persisted rather than recomputed because chapters are written
	 * concurrently: a format re-derived per chapter would drift, and the whole
	 * point of a form is that it does not.
	 */
	updateBookFormat(bookId: string, format: BookFormat) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = {
			...this.books[bookIndex],
			format,
			updatedAt: new Date().toISOString()
		};
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/**
	 * Record the colour and type read off the chosen cover.
	 *
	 * Persisted rather than derived on render because getting it costs a canvas
	 * read plus a vision call — doing that on every paint would be absurd, and
	 * the answer only changes when the cover does.
	 */
	updateBookCoverDesign(bookId: string, coverDesign: CoverDesign) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = {
			...this.books[bookIndex],
			coverDesign,
			updatedAt: new Date().toISOString()
		};
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	updateCoverSettings(bookId: string, coverSettings: CoverSettings) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		// Immutable replacement at every level so Svelte 5 $derived / $effect
		// detect the change and redraw the canvas.
		const updatedBook: Book = {
			...this.books[bookIndex],
			coverSettings,
			updatedAt: new Date().toISOString()
		};
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	setPipelineStage(bookId: string, stage: PipelineStage) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = { ...this.books[bookIndex], pipelineStage: stage, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	setCoverOptions(bookId: string, options: CoverOption[]) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = { ...this.books[bookIndex], coverOptions: options, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	selectCoverOption(bookId: string, index: number) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const option = this.books[bookIndex].coverOptions[index];
		if (!option) return;

		const updatedBook: Book = {
			...this.books[bookIndex],
			selectedCoverIndex: index,
			coverSettings: {
				...this.books[bookIndex].coverSettings,
				bgImageUrl: option.imageUrl,
				bgImagePrompt: option.prompt
			},
			updatedAt: new Date().toISOString()
		};
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/** Replace a single cover option (used when regenerating one specific option). */
	replaceCoverOption(bookId: string, index: number, option: CoverOption) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const opts = [...this.books[bookIndex].coverOptions];
		opts[index] = option;
		const updatedBook: Book = { ...this.books[bookIndex], coverOptions: opts, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/**
	 * Append a batch of cover candidates, keeping the ones already on screen.
	 * Stage 2 loads covers in tiers on demand, so batches accumulate rather
	 * than replace — use setCoverOptions to start a run from scratch.
	 */
	appendCoverOptions(bookId: string, options: CoverOption[]) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const existing = this.books[bookIndex].coverOptions;
		// Re-entrant by id: a batch streams in one cover at a time and calls
		// this on every arrival, so the same option is appended repeatedly.
		const merged = [...existing];
		for (const opt of options) {
			const at = merged.findIndex(o => o.id === opt.id);
			if (at === -1) merged.push(opt);
			else merged[at] = opt;
		}

		const updatedBook: Book = { ...this.books[bookIndex], coverOptions: merged, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/** Update the cover reference / visual direction creative brief. */
	updateCoverReferencePrompt(bookId: string, prompt: string) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = { ...this.books[bookIndex], coverReferencePrompt: prompt, updatedAt: new Date().toISOString() };
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/**
	 * Store the design language extracted from an uploaded reference cover.
	 * Pass nulls to clear it. The source image is never stored — see
	 * `coverReferenceFormat` in $lib/types.
	 */
	setCoverReferenceFormat(bookId: string, format: string | null, name: string | null) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const updatedBook: Book = {
			...this.books[bookIndex],
			coverReferenceFormat: format ?? undefined,
			coverReferenceName:   name   ?? undefined,
			updatedAt: new Date().toISOString()
		};
		this.books = this.books.map((b, i) => i === bookIndex ? updatedBook : b);
		this.persistBook(updatedBook);
	}

	/** Regenerate a single chapter's content + illustration without touching other chapters. */
	async regenerateChapter(
		bookId: string,
		chapterId: string,
		fetchFn: (chapterId: string) => Promise<{ content: string; illustrationUrl: string | null }>
	) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const chapIndex = this.books[bookIndex].chapters.findIndex(c => c.id === chapterId);
		if (chapIndex === -1) return;

		this.books[bookIndex].chapters[chapIndex].status = 'writing';
		this.persistBook(this.books[bookIndex]);

		try {
			const result = await fetchFn(chapterId);
			this.books[bookIndex].chapters[chapIndex].content = result.content;
			this.books[bookIndex].chapters[chapIndex].illustrationUrl = result.illustrationUrl;
			this.books[bookIndex].chapters[chapIndex].status = 'completed';
		} catch {
			this.books[bookIndex].chapters[chapIndex].status = 'failed';
		}

		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	// ─── Derived ─────────────────────────────────────────────────────────────────

	get activeBook(): Book | undefined {
		return this.books.find(b => b.id === this.activeBookId);
	}
}

export const globalState = new GlobalState();
