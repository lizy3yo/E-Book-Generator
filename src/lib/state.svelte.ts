import type { Book, ApiKeys, StepLog, Chapter, CoverSettings } from './types';

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
		// Only run in client context
		if (typeof window !== 'undefined') {
			this.loadFromStorage();
		}
	}

	loadFromStorage() {
		try {
			const savedKeys = localStorage.getItem('ebook_api_keys');
			if (savedKeys) {
				this.apiKeys = { ...this.apiKeys, ...JSON.parse(savedKeys) };
			}

			const savedBooks = localStorage.getItem('ebook_books');
			if (savedBooks) {
				this.books = JSON.parse(savedBooks);
			}

			const savedActiveBookId = localStorage.getItem('ebook_active_book_id');
			if (savedActiveBookId) {
				this.activeBookId = savedActiveBookId;
			}
		} catch (e) {
			console.error('Failed to load from localStorage', e);
		} finally {
			this.initialized = true;
		}
	}

	saveKeys(keys: ApiKeys) {
		this.apiKeys = keys;
		if (typeof window !== 'undefined') {
			localStorage.setItem('ebook_api_keys', JSON.stringify(keys));
		}
	}

	saveBooks() {
		if (typeof window !== 'undefined') {
			localStorage.setItem('ebook_books', JSON.stringify(this.books));
		}
	}

	setActiveBook(id: string | null) {
		this.activeBookId = id;
		if (typeof window !== 'undefined') {
			if (id) localStorage.setItem('ebook_active_book_id', id);
			else localStorage.removeItem('ebook_active_book_id');
		}
	}

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
		this.saveBooks();
		return newBook;
	}

	deleteBook(id: string) {
		this.books = this.books.filter(b => b.id !== id);
		if (this.activeBookId === id) {
			this.setActiveBook(this.books.length > 0 ? this.books[0].id : null);
		}
		this.saveBooks();
	}

	addLog(bookId: string, log: Omit<StepLog, 'id' | 'timestamp'>) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex !== -1) {
			const newLog: StepLog = {
				...log,
				id: crypto.randomUUID(),
				timestamp: new Date().toLocaleTimeString()
			};
			this.books[bookIndex].logs = [...this.books[bookIndex].logs, newLog];
			this.books[bookIndex].currentStep = log.message;
			this.books[bookIndex].updatedAt = new Date().toISOString();
			this.saveBooks();
		}
	}

	updateBookStatus(bookId: string, status: Book['status']) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex !== -1) {
			this.books[bookIndex].status = status;
			this.books[bookIndex].updatedAt = new Date().toISOString();
			this.saveBooks();
		}
	}

	updateBookChapters(bookId: string, chapters: Chapter[]) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex !== -1) {
			this.books[bookIndex].chapters = chapters;
			this.books[bookIndex].updatedAt = new Date().toISOString();
			this.saveBooks();
		}
	}

	updateChapterContent(bookId: string, chapterId: string, content: string, status: Chapter['status']) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex !== -1) {
			const chapIndex = this.books[bookIndex].chapters.findIndex(c => c.id === chapterId);
			if (chapIndex !== -1) {
				this.books[bookIndex].chapters[chapIndex].content = content;
				this.books[bookIndex].chapters[chapIndex].status = status;
				this.books[bookIndex].updatedAt = new Date().toISOString();
				this.saveBooks();
			}
		}
	}

	updateCoverSettings(bookId: string, coverSettings: CoverSettings) {
		const bookIndex = this.books.findIndex(b => b.id === bookId);
		if (bookIndex !== -1) {
			this.books[bookIndex].coverSettings = coverSettings;
			this.books[bookIndex].updatedAt = new Date().toISOString();
			this.saveBooks();
		}
	}

	get activeBook(): Book | undefined {
		return this.books.find(b => b.id === this.activeBookId);
	}
}

export const globalState = new GlobalState();
