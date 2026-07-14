import type { Book, ApiKeys, StepLog, Chapter, CoverSettings, CoverOption, PipelineStage } from './types';
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

			this.books = (data ?? []).map((row: { data: Book }) => row.data);

			// Refresh local cache
			localStorage.setItem('ebook_books', JSON.stringify(this.books));
		} catch (e) {
			console.warn('Supabase unavailable, loading from local cache:', e);
			try {
				const cached = localStorage.getItem('ebook_books');
				if (cached) this.books = JSON.parse(cached);
			} catch {
				this.books = [];
			}
		}
	}

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
		tone: string;
		structure: string;
		useUltraRealistic: boolean;
		researchDepth: 'basic' | 'deep';
		selfCorrectionLevel: 'standard' | 'rigorous';
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
			tone: params.tone || 'Informative',
			structure: params.structure || 'Standard Chapters',
			useUltraRealistic: params.useUltraRealistic,
			researchDepth: params.researchDepth,
			selfCorrectionLevel: params.selfCorrectionLevel,
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

		this.books[bookIndex].logs = [...this.books[bookIndex].logs, newLog];
		this.books[bookIndex].currentStep = log.message;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	updateBookStatus(bookId: string, status: Book['status']) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		this.books[bookIndex].status = status;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	updateBookChapters(bookId: string, chapters: Chapter[]) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		this.books[bookIndex].chapters = chapters;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	updateChapterContent(bookId: string, chapterId: string, content: string, status: Chapter['status']) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const chapIndex = this.books[bookIndex].chapters.findIndex(c => c.id === chapterId);
		if (chapIndex === -1) return;

		this.books[bookIndex].chapters[chapIndex].content = content;
		this.books[bookIndex].chapters[chapIndex].status = status;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	updateCoverSettings(bookId: string, coverSettings: CoverSettings) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		this.books[bookIndex].coverSettings = coverSettings;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	setPipelineStage(bookId: string, stage: PipelineStage) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		this.books[bookIndex].pipelineStage = stage;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	setCoverOptions(bookId: string, options: CoverOption[]) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		this.books[bookIndex].coverOptions = options;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	selectCoverOption(bookId: string, index: number) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const option = this.books[bookIndex].coverOptions[index];
		if (!option) return;

		this.books[bookIndex].selectedCoverIndex = index;
		// Apply chosen cover image to coverSettings
		this.books[bookIndex].coverSettings = {
			...this.books[bookIndex].coverSettings,
			bgImageUrl: option.imageUrl,
			bgImagePrompt: option.prompt
		};
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	/** Replace a single cover option (used when regenerating one specific option). */
	replaceCoverOption(bookId: string, index: number, option: CoverOption) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		const opts = [...this.books[bookIndex].coverOptions];
		opts[index] = option;
		this.books[bookIndex].coverOptions = opts;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
	}

	/** Update the cover reference / visual direction creative brief. */
	updateCoverReferencePrompt(bookId: string, prompt: string) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex === -1) return;

		this.books[bookIndex].coverReferencePrompt = prompt;
		this.books[bookIndex].updatedAt = new Date().toISOString();
		this.persistBook(this.books[bookIndex]);
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
