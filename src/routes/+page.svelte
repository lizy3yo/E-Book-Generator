<script lang="ts">
	import { globalState } from '$lib/state.svelte';
	import type { Book, Chapter, CoverOption } from '$lib/types';
	import {
		BookMarked, Zap, Paintbrush, BookOpen, Trash2,
		Loader, RefreshCw, CheckCircle, ChevronRight,
		ArrowLeft, Info, RotateCcw
	} from '@lucide/svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import ChapterPlanError from '$lib/components/ChapterPlanError.svelte';
	import { generateImage } from '$lib/generateImage';

	// ── Stage 1: concept form ──────────────────────────────────────────────────
	let title       = $state('');
	let subtitle    = $state('');
	let author      = $state('');
	let genre       = $state('');
	let length      = $state<'short' | 'medium' | 'long'>('medium');
	let tone        = $state('Authoritative & Educational');
	let structure   = $state('Standard Chapters');
	let useUltraRealistic   = $state(false);
	let researchDepth       = $state<'basic' | 'deep'>('basic');
	let selfCorrectionLevel = $state<'standard' | 'rigorous'>('standard');
	/** Optional background brief — injected into every AI call for deeper grounding */
	let userContext = $state('');

	// ── Stage 2: cover options ─────────────────────────────────────────────────
	let regeneratingCoverIdx = $state<number | null>(null);
	let isGeneratingCovers   = $state(false);

	// ── Delete confirmation ────────────────────────────────────────────────────
	let deleteConfirmOpen  = $state(false);
	let deleteTargetId     = $state<string | null>(null);
	let deleteTargetTitle  = $state('');

	function requestDeleteBook(id: string, title: string) {
		deleteTargetId    = id;
		deleteTargetTitle = title;
		deleteConfirmOpen = true;
	}

	function confirmDeleteBook() {
		if (deleteTargetId) globalState.deleteBook(deleteTargetId);
		deleteConfirmOpen = false;
		deleteTargetId    = null;
		deleteTargetTitle = '';
	}

	function cancelDeleteBook() {
		deleteConfirmOpen = false;
		deleteTargetId    = null;
		deleteTargetTitle = '';
	}

	// ── Stage 3: chapter plan ──────────────────────────────────────────────────
	let isGeneratingPlan   = $state(false);
	let chapterPlanError   = $state<string | null>(null);
	let editingChapterIdx  = $state<number | null>(null);
	let editTitle   = $state('');
	let editSummary = $state('');

	// ── Stage 4: writing ───────────────────────────────────────────────────────
	let isWriting        = $state(false);
	let regeneratingChapterIdx = $state<number | null>(null);
	let logsContainer: HTMLDivElement | null = $state(null);

	// Auto-scroll logs
	$effect(() => {
		if (globalState.activeBook?.logs && logsContainer) {
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	});

	const active = $derived(globalState.activeBook);

	// ── COVER STYLE DEFINITIONS ───────────────────────────────────────────────
	const COVER_STYLES = [
		{
			style: 'Dark Minimalist',
			buildPrompt: (title: string, subtitle: string, author: string, genre: string, refClause: string) =>
				`Luxury dark minimalist professional book cover. Title: "${title}"${subtitle ? ` — ${subtitle}` : ''}. Author: ${author}. Genre: ${genre}. ` +
				`Ultra-deep charcoal or near-black background fills the entire cover. A single powerful thematic object or dramatic silhouette — perfectly relevant to "${title}" — centered with cinematic chiaroscuro side-lighting, casting deep shadows. ` +
				`Thin gold or silver metallic accent lines framing the composition. ` +
				`Bold, elegant white or pale-gold serif title text "${title.toUpperCase()}" dominating the upper half of the cover. ` +
				`Author name "${author}" in small refined serif at the very bottom. ` +
				`No clutter. Maximum restraint and sophistication. Award-winning book cover design. Photorealistic render quality.${refClause}`
		},
		{
			style: 'Warm Editorial',
			buildPrompt: (title: string, subtitle: string, author: string, genre: string, refClause: string) =>
				`Sophisticated warm editorial professional book cover. Title: "${title}"${subtitle ? ` — ${subtitle}` : ''}. Author: ${author}. Genre: ${genre}. ` +
				`Rich cream, ivory, and warm amber tones throughout. Expressive painterly or fine-art illustration style background — botanical, organic shapes, or thematic symbols directly relevant to "${title}". ` +
				`Soft natural light, warm paper texture. Elegant dark serif title text "${title}" in the upper-center of the cover. ` +
				`Tasteful decorative border lines or ornamental elements. Subtitle "${subtitle}" in a smaller refined italic serif below the title. ` +
				`Author name "${author}" at the bottom in italic serif. ` +
				`Intellectual and artistic mood, reminiscent of Penguin Books, Knopf, or Farrar Straus & Giroux publishing house. Literary excellence.${refClause}`
		},
		{
			style: 'Bold Graphic',
			buildPrompt: (title: string, subtitle: string, author: string, genre: string, refClause: string) =>
				`High-impact commercial non-fiction bestselling book cover — identical quality to Amazon Top 10 titles. Title: "${title}"${subtitle ? ` — ${subtitle}` : ''}. Author: ${author}. Genre: ${genre}. ` +
				`Upper 55% of cover: solid deep navy blue background. Massive, extra-bold white all-caps sans-serif (Impact or Helvetica Black weight) title text "${title.toUpperCase()}" — each word on its own line, commanding maximum visual weight. ` +
				`Thin bright gold horizontal accent lines separating the title lines. ` +
				`Lower 40% of cover: seamless photorealistic cinematic scene directly relevant to "${genre}" and the subject of "${title}" — dramatic natural lighting, high-production-value photography quality. ` +
				`Bold red circular callout badge in the lower-right corner with a short 3-word benefit phrase. ` +
				`Very bottom strip: wide solid navy bar with author name "${author.toUpperCase()}" in large white bold condensed-serif text. ` +
				`Resembles top commercial non-fiction and self-help bestsellers. Publisher-quality production.${refClause}`
		}
	];

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 1 → Create book + immediately kick off cover generation (→ Stage 2)
	// ─────────────────────────────────────────────────────────────────────────
	async function handleCreateBook(e: Event) {
		e.preventDefault();
		if (!title.trim() || isGeneratingCovers) return;

		const book = globalState.createBook({
			title, subtitle, author, genre, length,
			tone, structure, useUltraRealistic, researchDepth, selfCorrectionLevel,
			userContext, coverReferencePrompt: ''
		});

		title = ''; subtitle = ''; author = ''; userContext = '';
		await generateCoverOptions(book);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 2 helpers
	// ─────────────────────────────────────────────────────────────────────────
	async function generateCoverOptions(book: Book) {
		isGeneratingCovers = true;
		globalState.setPipelineStage(book.id, 2);

		const keys = globalState.apiKeys;
		const refClause = book.coverReferencePrompt?.trim()
			? ` Visual reference & creative direction: ${book.coverReferencePrompt.trim()}.`
			: '';

		// Pre-allocate slots so covers always render in style order regardless of
		// which generation finishes first.
		const slots: (CoverOption | null)[] = new Array(COVER_STYLES.length).fill(null);

		// Generate all styles concurrently — stream each cover to the UI the moment
		// it's ready so the user sees results progressively.
		await Promise.all(
			COVER_STYLES.map(async (styleInfo, i) => {
				const prompt = styleInfo.buildPrompt(
					book.title, book.subtitle ?? '', book.author ?? 'Unknown Author', book.genre, refClause
				);

				let imageUrl = '';
				try {
					imageUrl = await generateImage({
						prompt,
						apiKey:      keys.imageKey,
						provider:    keys.imageProvider,
						useMockMode: keys.useMockMode,
						isCover:     true
					});
				} catch { /* continue — slot stays with empty imageUrl */ }

				slots[i] = { id: crypto.randomUUID(), prompt, imageUrl, style: styleInfo.style };

				// Push completed covers to the UI immediately (filter out pending slots)
				globalState.setCoverOptions(book.id, slots.filter((s): s is CoverOption => s !== null));
			})
		);

		isGeneratingCovers = false;
	}

	/** Regenerate a single cover option after user gives feedback */
	async function regenerateSingleCover(optionIndex: number) {
		if (!active || regeneratingCoverIdx !== null) return;
		regeneratingCoverIdx = optionIndex;

		const keys   = globalState.apiKeys;
		const style  = COVER_STYLES[optionIndex];
		const refClause = active.coverReferencePrompt?.trim()
			? ` Visual reference & creative direction: ${active.coverReferencePrompt.trim()}.`
			: '';
		const prompt = style.buildPrompt(active.title, active.subtitle ?? '', active.author ?? 'Unknown Author', active.genre, refClause);

		try {
			const imageUrl = await generateImage({
				prompt,
				apiKey:      keys.imageKey,
				provider:    keys.imageProvider,
				useMockMode: keys.useMockMode,
				isCover:     true
			});
			globalState.replaceCoverOption(active.id, optionIndex, {
				id: crypto.randomUUID(),
				prompt,
				imageUrl,
				style: style.style
			});
		} catch (err) {
			console.error(err);
		}

		regeneratingCoverIdx = null;
	}

	/** Regenerate ALL three covers with updated visual direction */
	async function regenerateAllCovers() {
		if (!active) return;
		await generateCoverOptions(active);
	}

	function selectCoverAndProceed(index: number) {
		if (!active) return;
		globalState.selectCoverOption(active.id, index);
		generateChapterPlan(active);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 3 helpers
	// ─────────────────────────────────────────────────────────────────────────
	async function generateChapterPlan(book: Book) {
		isGeneratingPlan = true;
		chapterPlanError = null;
		globalState.setPipelineStage(book.id, 3);
		globalState.updateBookStatus(book.id, 'researching');

		const keys   = globalState.apiKeys;
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
			const searchFacts = researchData.success
				? (researchData.results as any[]).map(f => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';

			// Merge user-provided context with retrieved facts
			const factsSummary = [
				book.userContext?.trim() ? `[Author Brief]\n${book.userContext.trim()}` : '',
				searchFacts
			].filter(Boolean).join('\n\n');

			globalState.updateBookStatus(book.id, 'outlining');

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
					tone: book.tone,
					structure: book.structure,
					researchNotes: factsSummary
				})
			});
			const outlineData = await outlineRes.json();

			if (!outlineData.success) throw new Error(outlineData.error || 'Outline failed.');

			const chapters: Chapter[] = outlineData.chapters;
			globalState.updateBookChapters(book.id, chapters);
		} catch (err: any) {
			chapterPlanError = err.message || 'An unexpected error occurred. Please try again.';
			globalState.updateBookStatus(book.id, 'failed');
			globalState.addLog(book.id, { step: 'outline', status: 'error', message: err.message });
		}

		isGeneratingPlan = false;
	}

	function startEditChapter(idx: number) {
		if (!active) return;
		editingChapterIdx = idx;
		editTitle   = active.chapters[idx].title;
		editSummary = active.chapters[idx].summary;
	}

	function saveChapterEdit() {
		if (!active || editingChapterIdx === null) return;
		const updated = active.chapters.map((c, i) =>
			i === editingChapterIdx ? { ...c, title: editTitle, summary: editSummary } : c
		);
		globalState.updateBookChapters(active.id, updated);
		editingChapterIdx = null;
	}

	function cancelChapterEdit() {
		editingChapterIdx = null;
	}

	function getChapterOrderLabel(chap: any, idx: number, chapters: any[]): string {
		const lower = chap.title.toLowerCase();
		if (lower.startsWith('preface')) return 'P';
		if (lower.startsWith('introduction') || lower.startsWith('intro')) return 'I';
		if (lower.startsWith('foreword')) return 'F';
		
		let prefaceCount = 0;
		for (let i = 0; i < idx; i++) {
			const titleLower = chapters[i].title.toLowerCase();
			if (
				titleLower.startsWith('preface') ||
				titleLower.startsWith('introduction') ||
				titleLower.startsWith('foreword') ||
				titleLower.startsWith('intro')
			) {
				prefaceCount++;
			}
		}
		return String(chap.order - prefaceCount);
	}

	function approveChapterPlan() {
		if (!active) return;
		globalState.setPipelineStage(active.id, 4);
		runWritingPipeline(active);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 4 helpers — write all chapters
	// ─────────────────────────────────────────────────────────────────────────
	async function runWritingPipeline(book: Book) {
		if (isWriting) return;
		isWriting = true;
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
			bookLevelFacts = rd.success
				? (rd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';
		} catch { /* non-fatal */ }

		const chapters = [...globalState.books.find(b => b.id === book.id)!.chapters];

		// Build a queue of chapter indices that still need to be written.
		const pending = chapters
			.map((c, i) => i)
			.filter(i => chapters[i].status !== 'completed');

		// ── Worker pool — process up to CONCURRENCY chapters simultaneously ──────
		// Each worker claims the next available index from the shared queue,
		// runs the full research → write → verify → illustrate pipeline for it,
		// then immediately picks up the next. This means the user sees the first
		// chapter appear as soon as it's done rather than waiting for all of them,
		// while still limiting concurrent API pressure to CONCURRENCY slots.
		const CONCURRENCY = 2;

		async function processNextChapter(): Promise<void> {
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

				await writeSingleChapter(book.id, i, chapters, factsSummary, keys, useMock);
			}
		}

		// Spawn CONCURRENCY workers and let them race through the queue
		await Promise.all(Array.from({ length: CONCURRENCY }, processNextChapter));

		globalState.updateBookStatus(book.id, 'completed');
		globalState.setPipelineStage(book.id, 5);
		globalState.addLog(book.id, {
			step: 'complete', status: 'success',
			message: '🎉 All chapters complete. Ebook ready to read and export.'
		});

		isWriting = false;
	}

	/** Write + illustrate exactly one chapter. Shared between pipeline and per-chapter regen. */
	async function writeSingleChapter(
		bookId: string,
		chapIndex: number,
		chaptersSnapshot: Chapter[],
		factsSummary: string,
		keys: typeof globalState.apiKeys,
		useMock: boolean
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
				chapterTitle: chap.title,
				chapterOrder: chap.order,
				chapterSummary: chap.summary,
				tone: book.tone,
				researchNotes: factsSummary
			})
		});
		const draftData = await draftRes.json();
		if (!draftData.success) throw new Error(draftData.error || `Chapter ${chap.order} draft failed.`);

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
				researchNotes: factsSummary
			})
		});
		const verifyData = await verifyRes.json();
		const finalContent = verifyData.success ? verifyData.verifiedContent : draftData.content;

		// Illustration — use chapter summary for a more relevant prompt
		globalState.addLog(bookId, {
			step: 'illustrate', status: 'running',
			message: `Generating illustration for Chapter ${chap.order}…`
		});

		let illustUrl: string | null = null;
		try {
			// House style — match the editorial diagram plates: warm cream field,
			// deep navy subject, amber accents. Honour the book's ultra-realistic
			// flag the same way the cover and the reader's edit drawer do.
			const ultraRealistic = book.useUltraRealistic || book.coverSettings?.useUltraRealistic;
			const styleClause = ultraRealistic
				? 'Ultra-realistic reference photograph, documentary product photography, sharp focus, ' +
				  'natural directional lighting, shallow depth of field, 8k, highly detailed. ' +
				  'Neutral warm cream backdrop, deep navy and amber colour accents. No text, no labels, no watermarks.'
				: 'High-quality editorial illustration, clean flat vector style with subtle depth. ' +
				  'Warm cream background (#FAF5EA), deep navy linework (#0F2231), amber accents (#E07B20). ' +
				  'Restrained sophisticated palette. No text, no labels, no watermarks.';

			const illustPrompt = chap.summary
				? `${styleClause} Subject: a clear, instructive visual for a chapter titled "${chap.title}". Topic: ${chap.summary}. From the book "${book.title}" (${book.genre}).`
				: `${styleClause} Subject: a clear, instructive visual for a chapter titled "${chap.title}". From the book "${book.title}" (${book.genre}).`;
			illustUrl = await generateImage({
				prompt:      illustPrompt,
				apiKey:      keys.imageKey,
				provider:    keys.imageProvider,
				useMockMode: useMock,
				isCover:     false
			});
		} catch { /* non-fatal */ }

		// Commit
		const final = [...globalState.books.find(b => b.id === bookId)!.chapters];
		final[chapIndex].content         = finalContent;
		final[chapIndex].researchNotes   = factsSummary;
		final[chapIndex].illustrationUrl = illustUrl;
		final[chapIndex].status          = 'completed';
		globalState.updateBookChapters(bookId, final);

		globalState.addLog(bookId, {
			step: 'drafting', status: 'success',
			message: `Chapter ${chap.order} complete.`
		});
	}

	/** Per-chapter regeneration triggered from Stage 4 UI */
	async function handleRegenerateChapter(chapIndex: number) {
		if (!active || isWriting || regeneratingChapterIdx !== null) return;
		regeneratingChapterIdx = chapIndex;

		const keys    = globalState.apiKeys;
		const useMock = keys.useMockMode;
		const chap    = active.chapters[chapIndex];

		// ── Book-level background research ──────────────────────────────────
		let bookLevelFacts = '';
		try {
			const r = await fetch('/api/research', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: `${active.title} ${active.genre} comprehensive overview key concepts`,
					apiKey: keys.exaKey,
					useMockMode: useMock
				})
			});
			const rd = await r.json();
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
					query: `${chap.title} ${active.title} ${active.genre} ${chap.summary ?? ''}`.trim(),
					apiKey: keys.exaKey,
					useMockMode: useMock
				})
			});
			const crd = await cr.json();
			chapterFacts = crd.success
				? (crd.results as any[]).map((f: any) => `[${f.title}] ${f.snippet}`).join('\n\n')
				: '';
		} catch { /* non-fatal */ }

		const factsSummary = [
			active.userContext?.trim() ? `[Author Brief]\n${active.userContext.trim()}` : '',
			bookLevelFacts ? `[Book-Level Research]\n${bookLevelFacts}` : '',
			chapterFacts   ? `[Chapter-Specific Research for "${chap.title}"]\n${chapterFacts}` : ''
		].filter(Boolean).join('\n\n');

		try {
			const snapshot = [...active.chapters];
			await writeSingleChapter(active.id, chapIndex, snapshot, factsSummary, keys, useMock);
		} catch (err: any) {
			const current = [...globalState.books.find(b => b.id === active.id)!.chapters];
			current[chapIndex].status = 'failed';
			globalState.updateBookChapters(active.id, current);
			globalState.addLog(active.id, {
				step: 'drafting', status: 'error',
				message: `Regeneration failed for Chapter ${chapIndex + 1}: ${err.message}`
			});
		}

		regeneratingChapterIdx = null;
	}
</script>

<svelte:head>
	<title>Ebook Automator</title>
</svelte:head>

<div class="workspace-grid">

	<!-- ── Left sidebar: library ──────────────────────────────────────── -->
	<aside class="sidebar-library">
		<div class="library-header font-serif">
			<h3>Your Library</h3>
			<div class="library-header-actions">
				<span class="count">{globalState.books.length}</span>
				<button
					class="btn-new-book"
					onclick={() => globalState.setActiveBook(null)}
					title="Start a new ebook"
					aria-label="Create new ebook"
				>
					+ New
				</button>
			</div>
		</div>

		<div class="library-list">
			{#if globalState.books.length === 0}
				<div class="empty-library font-serif">
					<p>Library is empty.</p>
					<p class="small">Create an ebook to get started.</p>
				</div>
			{/if}

			{#each globalState.books as b}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
				<div
					class="book-row {globalState.activeBookId === b.id ? 'active' : ''}"
					role="button"
					tabindex="0"
					onclick={() => globalState.setActiveBook(b.id)}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); globalState.setActiveBook(b.id); } }}
				>
					<div class="book-row-icon"><BookMarked size={18} /></div>
					<div class="book-row-meta">
						<span class="book-row-title font-serif">{b.title}</span>
						<span class="book-row-status {b.status}">
							{#if b.status === 'completed'} ✓ Ready
							{:else if b.status === 'failed'} ✕ Failed
							{:else if b.status === 'idle'} Draft
							{:else} • Generating…
							{/if}
						</span>
					</div>
					<button
						class="btn-delete"
						onclick={(e: MouseEvent) => { e.stopPropagation(); requestDeleteBook(b.id, b.title); }}
						title="Remove book"
					>
						<Trash2 size={14} />
					</button>
				</div>
			{/each}
		</div>
	</aside>

	<!-- ── Right main area ────────────────────────────────────────────── -->
	<main class="main-workspace">

		<!-- ══════════════════════════════════════════════════════════════
		     STAGE 0 / no active book → Concept Form
		     ══════════════════════════════════════════════════════════════ -->
		{#if !active}
			<div class="create-workspace card">
				<div class="workspace-title font-serif">
					<h2>New Ebook Concept</h2>
					<p>Describe your ebook — we'll generate cover options, build the chapter plan, and write every chapter for you.</p>
				</div>

				<form onsubmit={handleCreateBook} class="create-form">
					<div class="form-row grid-2-col">
						<div class="form-group">
							<label for="title">Book Title <span class="req">*</span></label>
							<input id="title" type="text" placeholder="e.g., The Quantum Mind" bind:value={title} required />
						</div>
						<div class="form-group">
							<label for="subtitle">Subtitle</label>
							<input id="subtitle" type="text" placeholder="e.g., Consciousness in the Age of AI" bind:value={subtitle} />
						</div>
					</div>

					<div class="form-row grid-2-col">
						<div class="form-group">
							<label for="author">Author Name</label>
							<input id="author" type="text" placeholder="e.g., Dr. Elena Rostova" bind:value={author} />
						</div>
						<div class="form-group">
							<label for="genre">Genre / Subject</label>
							<input
								id="genre"
								type="text"
								placeholder="e.g., Technology & AI, Vintage Pipe Restoration, Filipino Street Food History"
								bind:value={genre}
								required
							/>
						</div>
					</div>

					<div class="form-row grid-2-col">
						<div class="form-group">
							<label for="length">Target Length</label>
							<select id="length" bind:value={length}>
								<option value="short">Short — 3 chapters (~10–15k words)</option>
								<option value="medium">Standard — 5 chapters (~25–35k words)</option>
								<option value="long">Full-Length — 8 chapters (~50–60k words)</option>
							</select>
						</div>
					</div>

					<!-- ── Advanced Settings (collapsed by default) ─────────── -->
					<details class="advanced-settings">
						<summary class="advanced-settings__toggle font-serif">
							<span class="advanced-settings__label">Advanced Settings</span>
							<span class="advanced-settings__hint">Writing tone, book structure, research depth, quality pass, illustrations</span>
						</summary>
						<div class="advanced-settings__body">
							<div class="advanced-row grid-2-col">
								<div class="form-group">
									<label for="tone">Writing Tone</label>
									<select id="tone" bind:value={tone}>
										<optgroup label="Non-Fiction / Professional">
											<option value="Authoritative & Educational">Authoritative & Educational</option>
											<option value="Conversational & Accessible">Conversational & Accessible</option>
											<option value="Practical & Action-Oriented">Practical & Action-Oriented</option>
											<option value="Academic & Research-Driven">Academic & Research-Driven</option>
											<option value="Journalistic & Investigative">Journalistic & Investigative</option>
										</optgroup>
										<optgroup label="Narrative / Inspirational">
											<option value="Narrative & Storytelling">Narrative & Storytelling</option>
											<option value="Inspirational & Motivational">Inspirational & Motivational</option>
											<option value="Reflective & Philosophical">Reflective & Philosophical</option>
										</optgroup>
										<optgroup label="Technical">
											<option value="Technical & Precise">Technical & Precise</option>
											<option value="Instructional & Step-by-Step">Instructional & Step-by-Step</option>
										</optgroup>
									</select>
								</div>
								<div class="form-group">
									<label for="structure">Book Structure</label>
									<select id="structure" bind:value={structure}>
										<option value="Standard Chapters">Standard Chapters</option>
										<option value="Problem–Solution Framework">Problem–Solution Framework</option>
										<option value="Step-by-Step Blueprint">Step-by-Step Blueprint</option>
										<option value="Pillar & Chapter Framework">Pillar Framework</option>
										<option value="Story Narrative">Story Narrative</option>
										<option value="Academic Thesis">Academic Thesis</option>
										<option value="Interview & Case Study">Interview & Case Study</option>
									</select>
								</div>
							</div>
							<div class="advanced-row grid-2-col">
								<div class="form-group">
									<label for="depth">Research Grounding</label>
									<select id="depth" bind:value={researchDepth}>
										<option value="basic">Standard — Key facts & citations</option>
										<option value="deep">Deep — Comprehensive source extraction</option>
									</select>
								</div>
								<div class="form-group">
									<label for="correction">Quality Pass</label>
									<select id="correction" bind:value={selfCorrectionLevel}>
										<option value="standard">Standard — Consistency & copy-edit pass</option>
										<option value="rigorous">Rigorous — Full fact-mesh cross-validation</option>
									</select>
								</div>
							</div>
							<div class="advanced-row">
								<label class="checkbox-container">
									<input type="checkbox" bind:checked={useUltraRealistic} />
									<span class="checkbox-custom"></span>
									<span class="checkbox-label-body">
										<span class="checkbox-label-title">Photorealistic Illustrations</span>
										<span class="checkbox-label-desc">Use high-fidelity image generation for chapter art. Produces more detailed, cinematic visuals — uses more API credits and takes longer.</span>
									</span>
								</label>
							</div>
						</div>
					</details>

					<!-- Optional author brief -->
					<div class="context-section">
						<div class="context-header">
							<label for="user-context" class="context-label">
								Author Brief
								<span class="context-optional">optional</span>
							</label>
							<p class="context-desc">
								Paste background knowledge, key facts, terminology, a synopsis, or any domain expertise you want the AI to incorporate throughout every chapter.
							</p>
						</div>
						<textarea
							id="user-context"
							bind:value={userContext}
							placeholder="e.g., This book focuses on practical quantum computing applications for enterprise software teams. Key themes: error correction, NISQ devices, hybrid classical-quantum pipelines. Target audience: senior software architects with no prior physics background…"
							rows="5"
						></textarea>
					</div>



					<div class="form-actions">
						<button type="submit" class="btn btn-primary" disabled={isGeneratingCovers || !title.trim()}>
							{#if isGeneratingCovers}
								<span class="btn-spinner"></span> Generating Cover Options…
							{:else}
								<Zap size={15} /> Generate Cover Options
							{/if}
						</button>
					</div>				</form>
			</div>

		<!-- ══════════════════════════════════════════════════════════════
		     STAGE 2 — Cover selection
		     ══════════════════════════════════════════════════════════════ -->
		{:else if active.pipelineStage === 2}
			<div class="stage-workspace">
				<div class="stage-header">
					<div class="stage-badge">Step 1 of 3</div>
					<h2 class="font-serif">Choose Your Cover Style</h2>
					<p>We've generated three distinct cover concepts for <strong>{active.title}</strong>. Pick the one that fits your vision, or give feedback and regenerate.</p>
				</div>

				{#if isGeneratingCovers}
					<div class="generating-covers-placeholder">
						<div class="cover-skeleton-grid">
							{#each [1,2,3] as _}
								<div class="cover-skeleton">
									<div class="skeleton-img pulse"></div>
									<div class="skeleton-label pulse"></div>
								</div>
							{/each}
						</div>
						<p class="generating-label font-serif"><Loader size={14} class="spin-icon" /> Rendering cover concepts…</p>
					</div>
				{:else}
					<div class="cover-options-grid">
						{#each active.coverOptions as opt, idx}
							<div class="cover-option-card {active.selectedCoverIndex === idx ? 'selected' : ''}">
								<div class="cover-option-preview">
									{#if opt.imageUrl}
										<img src={opt.imageUrl} alt="Cover option {idx + 1}" />
									{:else}
										<div class="cover-placeholder">
											<BookMarked size={32} />
										</div>
									{/if}
									{#if regeneratingCoverIdx === idx}
										<div class="cover-regenerating-overlay">
											<Loader size={24} class="spin-icon" />
										</div>
									{/if}
								</div>
								<div class="cover-option-meta">
									<span class="cover-style-label font-serif">{opt.style}</span>
									<div class="cover-option-actions">
										<button
											class="btn btn-ghost btn-xs"
											onclick={() => regenerateSingleCover(idx)}
											disabled={regeneratingCoverIdx !== null || isGeneratingCovers}
											title="Regenerate this style"
										>
											<RotateCcw size={13} />
										</button>
										<button
											class="btn btn-primary btn-xs"
											onclick={() => selectCoverAndProceed(idx)}
											disabled={regeneratingCoverIdx !== null || isGeneratingCovers}
										>
											Select <ChevronRight size={13} />
										</button>
									</div>
								</div>
							</div>
						{/each}
					</div>

					<!-- Optional cover visual reference / direction in Stage 2 -->
					<div class="context-section" style="margin-top: 1.5rem;">
						<div class="context-header">
							<label for="cover-ref" class="context-label">
								Cover Visual Direction
								<span class="context-optional">optional</span>
							</label>
							<p class="context-desc">
								Describe how you want the cover to look — colour palette, typography style, imagery, mood, layout. Think of this as your creative brief to the designer. The more specific, the better the result.
							</p>
						</div>
						<textarea
							id="cover-ref"
							value={active.coverReferencePrompt || ''}
							oninput={(e) => globalState.updateCoverReferencePrompt(active.id, (e.target as HTMLTextAreaElement).value)}
							placeholder="e.g., Bold white serif title dominating the upper two-thirds on a deep navy background. A photorealistic scene relevant to the topic fills the bottom half. A red circular badge callout in the lower right. Author name in a contrasting bar at the very bottom. High-impact, non-fiction bestseller style similar to mainstream how-to books."
							rows="4"
							disabled={isGeneratingCovers}
						></textarea>

						<div class="form-actions" style="margin-top: 1rem; display: flex; justify-content: flex-end; width: 100%;">
							<button
								class="btn btn-primary"
								onclick={regenerateAllCovers}
								disabled={isGeneratingCovers}
								style="background-color: #8b7355; border-color: #8b7355;"
							>
								{#if isGeneratingCovers}
									<span class="btn-spinner"></span> Generating Cover Options…
								{:else}
									<Zap size={15} /> Generate Cover Options
								{/if}
							</button>
						</div>
					</div>
				{/if}
			</div>

		<!-- ══════════════════════════════════════════════════════════════
		     STAGE 3 — Chapter plan review
		     ══════════════════════════════════════════════════════════════ -->
		{:else if active.pipelineStage === 3}
			<div class="stage-workspace stage-workspace--wide">
				<div class="stage-header">
					<div class="stage-badge">Step 2 of 3</div>
					<h2 class="font-serif">Review Your Chapter Plan</h2>
					<p>AI has structured the outline for <strong>{active.title}</strong>. Edit any chapter title or summary, then approve to begin writing.</p>
				</div>

				{#if chapterPlanError || (active.status === 'failed' && active.chapters.length === 0 && !isGeneratingPlan)}
					<ChapterPlanError
						error={chapterPlanError ?? 'Chapter plan generation failed. Please try again.'}
						isRetrying={isGeneratingPlan}
						onRetry={() => generateChapterPlan(active)}
					/>
				{:else if isGeneratingPlan || active.chapters.length === 0}
					<div class="plan-loading">
						<div class="plan-skeleton">
							{#each [1,2,3,4,5] as _}
								<div class="chapter-skeleton pulse"></div>
							{/each}
						</div>
						<p class="generating-label font-serif"><Loader size={14} class="spin-icon" /> Building chapter structure…</p>
					</div>
				{:else}
					{@const cover = active.coverSettings}
					<div class="plan-layout">

						<!-- ── Left: editable chapter list ──────────────────────── -->
						<div class="plan-left">
							<div class="chapter-plan-list">
								{#each active.chapters as chap, idx}
									<div class="chapter-plan-item">
										{#if editingChapterIdx === idx}
											<!-- Inline edit mode -->
											<div class="chapter-edit-form">
												<div class="chapter-edit-num font-serif">Ch. {getChapterOrderLabel(chap, idx, active.chapters)}</div>
												<div class="chapter-edit-fields">
													<input
														type="text"
														class="chapter-edit-title"
														bind:value={editTitle}
														placeholder="Chapter title"
													/>
													<textarea
														class="chapter-edit-summary"
														bind:value={editSummary}
														rows="2"
														placeholder="Chapter summary"
													></textarea>
													<div class="chapter-edit-actions">
														<button class="btn btn-primary btn-xs" onclick={saveChapterEdit}>
															<CheckCircle size={13} /> Save
														</button>
														<button class="btn btn-ghost btn-xs" onclick={cancelChapterEdit}>
															Cancel
														</button>
													</div>
												</div>
											</div>
										{:else}
											<!-- Read mode -->
											<div class="chapter-plan-num font-serif">{getChapterOrderLabel(chap, idx, active.chapters)}</div>
											<div class="chapter-plan-info">
												<span class="chapter-plan-title font-serif">{chap.title}</span>
												<p class="chapter-plan-summary">{chap.summary}</p>
											</div>
											<button
												class="btn btn-ghost btn-xs chapter-edit-btn"
												onclick={() => startEditChapter(idx)}
												title="Edit this chapter"
											>
												Edit
											</button>
										{/if}
									</div>
								{/each}
							</div>

							<div class="plan-approve-row">
								<p class="font-serif plan-note">
									<Info size={13} /> Chapters look good? Click Approve to start the full writing pipeline.
								</p>
								<button class="btn btn-primary" onclick={approveChapterPlan}>
									<CheckCircle size={15} /> Approve & Start Writing
								</button>
							</div>
						</div>

						<!-- ── Right: book preview ───────────────────────────────── -->
						<div class="plan-right">
							<div class="preview-label font-serif">
								<span class="preview-badge">Preview</span>
								How your ebook will look
							</div>

							<div class="book-preview-scroll">

								<!-- Page 1: Cover -->
								<div class="preview-page preview-cover" style="
									{cover.bgImageUrl
										? `background-image: url('${cover.bgImageUrl}'); background-size: cover; background-position: center;`
										: 'background: linear-gradient(160deg,#2C2C2C 0%,#1A1A1A 100%);'}
								">
									<div class="preview-cover-overlay" style="background:rgba(26,21,16,{active.coverOptions?.some(opt => opt.imageUrl && opt.imageUrl === cover.bgImageUrl) ? 0 : (cover.overlayOpacity ?? 0.15)});"></div>
									{#if !active.coverOptions?.some(opt => opt.imageUrl && opt.imageUrl === cover.bgImageUrl)}
										<div class="preview-cover-content" style="text-align:{cover.alignment ?? 'center'};">
											<div>
												<div class="preview-cover-title" style="color:{cover.titleColor};font-size:{Math.round((cover.titleSize ?? 36) * 0.42)}px;">{active.title}</div>
												{#if active.subtitle}
													<div class="preview-cover-subtitle" style="color:{cover.subtitleColor};font-size:{Math.round((cover.subtitleSize ?? 18) * 0.42)}px;">{active.subtitle}</div>
												{/if}
											</div>
											<div class="preview-cover-author" style="color:{cover.authorColor};font-size:{Math.round((cover.authorSize ?? 20) * 0.42)}px;">{active.author}</div>
										</div>
									{/if}
									<div class="preview-page-label">Cover</div>
								</div>

								<!-- Page 2: Title page -->
								<div class="preview-page preview-interior">
									<div class="preview-title-page">
										<!-- Top decorative bar -->
										<div class="preview-tp-topbar"></div>
										<div class="preview-tp-inner">
											<div class="preview-tp-genre">{active.genre.toUpperCase()}</div>
											<div class="preview-tp-title">{active.title}</div>
											{#if active.subtitle}<div class="preview-tp-subtitle">{active.subtitle}</div>{/if}
											<div class="preview-tp-ornament">⸻</div>
											<div class="preview-tp-author">{active.author}</div>
										</div>
										<!-- Bottom publisher line -->
										<div class="preview-tp-bottombar"></div>
									</div>
									<div class="preview-page-label">Title Page</div>
								</div>

								<!-- Page 3: Table of Contents -->
								<div class="preview-page preview-interior">
									<div class="preview-toc">
										<div class="preview-toc-heading">Contents</div>
										<div class="preview-toc-rule"></div>
										{#each active.chapters as chap}
											<div class="preview-toc-row">
												<span class="preview-toc-num">{chap.order.toString().padStart(2, '0')}</span>
												<span class="preview-toc-title">{chap.title}</span>
											</div>
										{/each}
									</div>
									<div class="preview-page-label">Contents</div>
								</div>

								<!-- Pages 4+: Chapter opening pages (up to 7 chapters = 10 pages total) -->
								{#each active.chapters.slice(0, 7) as chap}
									<div class="preview-page preview-interior">
										<div class="preview-chapter-page">
											<div class="preview-chap-number">Chapter {chap.order}</div>
											<div class="preview-chap-title">{chap.title}</div>
											<div class="preview-chap-rule"></div>
											<div class="preview-chap-summary">{chap.summary}</div>
											<!-- Simulated body text lines -->
											<div class="preview-body-lines">
												{#each Array(8) as _}
													<div class="preview-body-line"></div>
												{/each}
												<div class="preview-body-line short"></div>
											</div>
										</div>
										<div class="preview-page-label">Ch. {chap.order}</div>
									</div>
								{/each}

							</div>
						</div>

					</div>
				{/if}
			</div>

		<!-- ══════════════════════════════════════════════════════════════
		     STAGE 4 — Writing in progress + per-chapter regen
		     ══════════════════════════════════════════════════════════════ -->
		{:else if active.pipelineStage === 4}
			<div class="stage-workspace">
				<div class="stage-header">
					<div class="stage-badge">Step 3 of 3</div>
					<h2 class="font-serif">Writing Your Ebook</h2>
					<p>Chapters are being written and verified one by one. You can regenerate any chapter individually if the result isn't right.</p>
				</div>

				<div class="writing-layout">
					<!-- Chapter status list -->
					<div class="chapters-progress-list">
						{#each active.chapters as chap, idx}
							<div class="writing-chapter-row {chap.status}">
								<div class="wc-badge">{getChapterOrderLabel(chap, idx, active.chapters)}</div>
								<div class="wc-info">
									<span class="wc-title font-serif">{chap.title}</span>
									<span class="wc-status-label">
										{#if chap.status === 'completed'} ✓ Complete
										{:else if chap.status === 'writing'} Drafting…
										{:else if chap.status === 'verifying'} Verifying…
										{:else if chap.status === 'failed'} ✕ Failed
										{:else} Pending
										{/if}
									</span>
								</div>
								<div class="wc-actions">
									{#if chap.status === 'completed' || chap.status === 'failed'}
										<button
											class="btn btn-ghost btn-xs"
											onclick={() => handleRegenerateChapter(idx)}
											disabled={isWriting || regeneratingChapterIdx !== null}
											title="Regenerate this chapter"
										>
											{#if regeneratingChapterIdx === idx}
												<Loader size={13} class="spin-icon" />
											{:else}
												<RotateCcw size={13} /> Redo
											{/if}
										</button>
									{/if}
								</div>
							</div>
						{/each}
					</div>

					<!-- Live log terminal -->
					<div class="logs-panel card">
						<div class="logs-header">
							<h3 class="font-serif">Pipeline Log</h3>
							<span class="log-mode font-serif">
								{globalState.apiKeys.useMockMode ? 'MOCK MODE' : 'LIVE'}
							</span>
						</div>
						<div class="terminal-body" bind:this={logsContainer}>
							{#each active.logs as log}
								<div class="log-row {log.status}">
									<span class="ts">[{log.timestamp}]</span>
									<span class="step">{log.step.toUpperCase()}</span>
									<span class="msg">{log.message}</span>
								</div>
							{/each}
							{#if isWriting || regeneratingChapterIdx !== null}
								<div class="log-row running pulse">
									<span class="ts">[{new Date().toLocaleTimeString()}]</span>
									<span class="step">SYSTEM</span>
									<span class="msg">Processing…</span>
								</div>
							{/if}
						</div>
					</div>
				</div>
			</div>

		<!-- ══════════════════════════════════════════════════════════════
		     STAGE 5 — Complete
		     ══════════════════════════════════════════════════════════════ -->
		{:else if active.pipelineStage === 5}
			<div class="stage-workspace complete-stage">
				<div class="complete-card card">
					<!-- Book cover thumbnail — uses the generated cover image if available,
					     otherwise renders a minimal typeset spine as a fallback -->
					{#if active.coverSettings?.bgImageUrl}
						<div class="complete-cover">
							<img
								src={active.coverSettings.bgImageUrl}
								alt="Cover of {active.title}"
								class="complete-cover-img"
							/>
						</div>
					{:else}
						<div
							class="complete-cover-fallback"
							style="background: linear-gradient(160deg, {active.coverSettings?.titleColor ?? '#1A1612'} 0%, #3A2E22 100%);"
						>
							<span
								class="complete-cover-fallback-title"
								style="font-family: {active.coverSettings?.titleFont === 'Inter' || active.coverSettings?.titleFont === 'Arial' ? 'Inter, sans-serif' : 'Lora, Georgia, serif'}; color: {active.coverSettings?.subtitleColor ?? '#EDE5D5'};"
							>{active.title}</span>
							{#if active.author}
								<span
									class="complete-cover-fallback-author"
									style="color: {active.coverSettings?.authorColor ?? '#8E7453'};"
								>{active.author}</span>
							{/if}
						</div>
					{/if}

					<h2 class="font-serif">{active.title}</h2>
					<p class="font-serif">Your ebook is complete — {active.chapters.length} chapters written, verified, and illustrated.</p>

					<div class="complete-actions">
						<a href="/cover" class="btn btn-secondary"><Paintbrush size={15} /> Refine Cover</a>
						<a href="/reader" class="btn btn-primary"><BookOpen size={15} /> Read & Export PDF</a>
					</div>

					<div class="complete-chapter-summary">
						<h4 class="font-serif">Chapters</h4>
						{#each active.chapters as chap, idx}
							<div class="summary-row">
								<span class="summary-num font-serif">{getChapterOrderLabel(chap, idx, active.chapters)}</span>
								<span class="summary-title font-serif">{chap.title}</span>
								<div class="summary-actions">
									<button
										class="btn btn-ghost btn-xs"
										onclick={() => handleRegenerateChapter(idx)}
										disabled={regeneratingChapterIdx !== null}
										title="Regenerate chapter"
									>
										{#if regeneratingChapterIdx === idx}
											<Loader size={12} class="spin-icon" />
										{:else}
											<RotateCcw size={12} /> Redo
										{/if}
									</button>
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>
		{/if}

	</main>
</div>

<!-- Delete confirmation dialog — rendered outside the layout flow -->
<ConfirmDialog
	open={deleteConfirmOpen}
	title="Remove ebook"
	message={`"${deleteTargetTitle}" and all its chapters will be permanently removed. This cannot be undone.`}
	confirmLabel="Remove"
	intent="danger"
	onConfirm={confirmDeleteBook}
	onCancel={cancelDeleteBook}
/>

<style>
	/* ── Layout ─────────────────────────────────────────────────────────── */
	.workspace-grid {
		display: grid;
		grid-template-columns: 272px 1fr;
		height: calc(100vh - 65px);
		overflow: hidden;
	}
	@media (max-width: 900px) {
		.workspace-grid { grid-template-columns: 1fr; height: auto; overflow: visible; }
	}

	/* ── Sidebar ────────────────────────────────────────────────────────── */
	.sidebar-library {
		background-color: var(--bg-card);
		border-right: 1px solid var(--border-color);
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
	}
	.library-header {
		padding: 1.25rem 1.5rem;
		border-bottom: 1px solid var(--border-color);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.library-header h3 { font-size: 1rem; font-weight: 600; }
	.library-header-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.library-header .count {
		font-size: 0.78rem;
		color: var(--text-muted);
		background-color: var(--accent-light);
		padding: 0.1rem 0.45rem;
		border-radius: 20px;
	}
	.btn-new-book {
		font-family: var(--font-sans, inherit);
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.25rem 0.65rem;
		border-radius: 5px;
		border: 1px solid var(--accent, #8E7453);
		background: transparent;
		color: var(--accent, #8E7453);
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.15s, color 0.15s;
		line-height: 1.4;
	}
	.btn-new-book:hover {
		background: var(--accent, #8E7453);
		color: #fff;
	}
	.library-list { display: flex; flex-direction: column; flex: 1; padding: 0.5rem; gap: 0.2rem; }
	.empty-library { padding: 2rem 1rem; text-align: center; color: var(--text-muted); font-style: italic; font-size: 0.88rem; }
	.empty-library .small { font-size: 0.75rem; margin-top: 0.4rem; }

	.book-row {
		display: flex; align-items: center; gap: 0.7rem;
		padding: 0.8rem 0.9rem;
		background: transparent; border: 1px solid transparent;
		border-radius: var(--radius-sm); cursor: pointer; width: 100%;
		transition: var(--transition); position: relative;
	}
	.book-row:hover { background-color: var(--accent-light); }
	.book-row.active { background-color: var(--accent-light); border-color: var(--border-focus); }
	.book-row-icon { color: var(--accent); display: flex; }
	.book-row-meta { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; overflow: hidden; }
	.book-row-title { font-weight: 600; font-size: 0.88rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.book-row-status { font-size: 0.73rem; }
	.book-row-status.completed { color: var(--success); }
	.book-row-status.failed    { color: var(--error); }
	.book-row-status.idle      { color: var(--text-muted); }
	.book-row-status:not(.completed):not(.failed):not(.idle) { color: var(--warning); }

	.btn-delete {
		background: transparent; border: none; color: var(--text-muted);
		cursor: pointer; display: none; position: absolute; right: 0.5rem; top: 50%;
		transform: translateY(-50%); width: 22px; height: 22px;
		align-items: center; justify-content: center; padding: 0;
	}
	.book-row:hover .btn-delete { display: flex; }
	.btn-delete:hover { color: var(--error); }

	/* ── Main workspace ─────────────────────────────────────────────────── */
	.main-workspace {
		background-color: var(--bg-page);
		padding: 2rem 2.5rem;
		overflow-y: auto;
		height: 100%;
	}
	@media (max-width: 900px) { .main-workspace { padding: 1rem; height: auto; overflow: visible; } }

	/* ── Stage wrapper ──────────────────────────────────────────────────── */
	.stage-workspace { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 2rem; }
	.stage-header { border-bottom: 1.5px solid var(--border-color); padding-bottom: 1.25rem; }
	.stage-badge {
		display: inline-block;
		font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
		color: var(--accent); background-color: var(--accent-light);
		padding: 0.2rem 0.65rem; border-radius: 20px; margin-bottom: 0.6rem;
	}
	.stage-header h2 { font-size: 1.7rem; margin-bottom: 0.4rem; }
	.stage-header p { color: var(--text-muted); font-size: 0.92rem; }

	/* ── Create form ────────────────────────────────────────────────────── */
	.create-workspace { max-width: 800px; margin: 0 auto; padding: 2.5rem; }
	.workspace-title { margin-bottom: 2rem; border-bottom: 1px solid var(--border-color); padding-bottom: 1rem; }
	.workspace-title h2 { font-size: 1.75rem; }
	.workspace-title p { color: var(--text-muted); font-size: 0.9rem; margin-top: 0.25rem; }
	.req { color: var(--error); }

	.create-form { display: flex; flex-direction: column; gap: 1.5rem; }
	.form-row { display: contents; }

	.grid-2-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
	.grid-3-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1.25rem; }
	@media (max-width: 600px) { .grid-2-col, .grid-3-col { grid-template-columns: 1fr; } }

	.form-group { display: flex; flex-direction: column; gap: 0.35rem; }
	.form-group label { font-size: 0.84rem; font-weight: 600; }

	.parameters-section {
		border: 1px solid var(--border-color); background-color: var(--bg-inset);
		border-radius: var(--radius-md); padding: 1.5rem; margin-top: 0.25rem;
	}
	.parameters-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; align-items: center; }
	@media (max-width: 600px) { .parameters-grid { grid-template-columns: 1fr; } }
	.check-group { grid-column: span 2; }
	@media (max-width: 600px) { .check-group { grid-column: span 1; } }

	/* ── Advanced Settings accordion ───────────────────────────────── */
	.advanced-settings {
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background-color: var(--bg-inset);
		overflow: hidden;
	}

	.advanced-settings__toggle {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.9rem 1.25rem;
		cursor: pointer;
		list-style: none;
		user-select: none;
		transition: background 0.15s;
	}

	.advanced-settings__toggle:hover { background: var(--accent-light); }

	.advanced-settings__toggle::before {
		content: '›';
		font-size: 1rem;
		color: var(--accent);
		transition: transform 0.2s ease;
		flex-shrink: 0;
		line-height: 1;
	}

	.advanced-settings[open] .advanced-settings__toggle::before {
		transform: rotate(90deg);
	}

	.advanced-settings__label {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--accent);
	}

	.advanced-settings__hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-style: italic;
		font-family: var(--font-sans);
	}

	.advanced-settings__body {
		padding: 1.25rem 1.25rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		border-top: 1px solid var(--border-color);
	}

	.advanced-row {
		display: flex;
		gap: 1.25rem;
	}

	.advanced-row.grid-2-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.25rem;
	}

	@media (max-width: 600px) {
		.advanced-row.grid-2-col { grid-template-columns: 1fr; }
	}

	/* Custom checkbox */
	.checkbox-container {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		cursor: pointer;
		user-select: none;
	}

	.checkbox-container input[type="checkbox"] {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
	}

	.checkbox-custom {
		flex-shrink: 0;
		width: 18px;
		height: 18px;
		margin-top: 2px;
		border: 1.5px solid var(--border-focus, #8E7453);
		border-radius: 4px;
		background: var(--bg-card, #fff);
		transition: background 0.15s, border-color 0.15s;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.checkbox-container input[type="checkbox"]:checked + .checkbox-custom {
		background: var(--accent, #8E7453);
		border-color: var(--accent, #8E7453);
	}

	.checkbox-container input[type="checkbox"]:checked + .checkbox-custom::after {
		content: '';
		display: block;
		width: 5px;
		height: 9px;
		border: 2px solid #fff;
		border-top: none;
		border-left: none;
		transform: rotate(45deg) translateY(-1px);
	}

	.checkbox-container:hover .checkbox-custom {
		border-color: var(--accent, #8E7453);
		background: var(--accent-light, #f5f0ea);
	}

	.checkbox-label-body {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.checkbox-label-title {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--text-primary, #2B2927);
		line-height: 1.3;
	}

	.checkbox-label-desc {
		font-size: 0.78rem;
		color: var(--text-muted, #6E6860);
		line-height: 1.5;
	}

	.form-actions { display: flex; justify-content: flex-end; padding-top: 0.5rem; }

	/* ── Author Brief / context section ─────────────────────────────────── */
	.context-section {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		border: 1px solid var(--border-color);
		background-color: var(--bg-inset);
		border-radius: var(--radius-md);
		padding: 1.25rem 1.5rem;
	}

	.context-header {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.context-label {
		font-size: 0.88rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-main);
	}

	.context-optional {
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--text-muted);
		background-color: var(--bg-card);
		border: 1px solid var(--border-color);
		padding: 0.1rem 0.45rem;
		border-radius: 20px;
		letter-spacing: 0.03em;
		text-transform: uppercase;
	}

	.context-desc {
		font-size: 0.8rem;
		color: var(--text-muted);
		line-height: 1.5;
		margin: 0;
	}

	.context-section textarea {
		resize: vertical;
		min-height: 100px;
		font-size: 0.88rem;
		line-height: 1.6;
		font-family: var(--font-sans);
		color: var(--text-main);
	}	.btn-spinner {
		display: inline-block; width: 13px; height: 13px;
		border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff;
		border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; margin-right: 4px;
	}

	/* ── Cover options — Stage 2 ────────────────────────────────────────── */
	.cover-options-grid {
		display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem;
	}
	@media (max-width: 700px) { .cover-options-grid { grid-template-columns: 1fr; } }

	.cover-option-card {
		border: 2px solid var(--border-color); border-radius: var(--radius-md);
		overflow: hidden; transition: var(--transition); background: var(--bg-card);
	}
	.cover-option-card:hover { border-color: var(--border-focus); box-shadow: var(--shadow-md); }
	.cover-option-card.selected { border-color: var(--accent); }

	.cover-option-preview {
		position: relative; height: 280px; overflow: hidden;
		background-color: var(--bg-inset);
		display: flex; align-items: center; justify-content: center;
	}
	.cover-option-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }

	.cover-placeholder {
		color: var(--text-muted); display: flex; align-items: center;
		justify-content: center; width: 100%; height: 100%;
	}

	.cover-regenerating-overlay {
		position: absolute; inset: 0;
		background: rgba(0,0,0,0.45); display: flex;
		align-items: center; justify-content: center; color: #fff;
	}

	.cover-option-meta {
		padding: 0.85rem 1rem;
		display: flex; justify-content: space-between; align-items: center;
		border-top: 1px solid var(--border-color);
	}
	.cover-style-label { font-size: 0.88rem; font-weight: 600; }
	.cover-option-actions { display: flex; gap: 0.5rem; }

	/* Generating skeletons */
	.generating-covers-placeholder { display: flex; flex-direction: column; align-items: center; gap: 2rem; }
	.cover-skeleton-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; width: 100%; }
	.cover-skeleton { border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color); }
	.skeleton-img { height: 280px; background: var(--bg-inset); }
	.skeleton-label { height: 48px; background: var(--bg-card); }
	.generating-label { color: var(--text-muted); font-style: italic; font-size: 0.9rem; display: flex; align-items: center; gap: 0.5rem; }



	/* ── Chapter plan — Stage 3 ─────────────────────────────────────────── */
	.plan-loading { display: flex; flex-direction: column; gap: 1.5rem; align-items: center; }
	.plan-skeleton { display: flex; flex-direction: column; gap: 0.75rem; width: 100%; }
	.chapter-skeleton { height: 72px; border-radius: var(--radius-sm); background: var(--bg-inset); }

	/* Wide variant for Stage 3 two-column layout */
	.stage-workspace--wide { max-width: 1200px; }

	/* Two-column plan layout */
	.plan-layout {
		display: grid;
		grid-template-columns: 1fr 340px;
		gap: 2.5rem;
		align-items: start;
	}
	@media (max-width: 960px) { .plan-layout { grid-template-columns: 1fr; } }

	.plan-left { display: flex; flex-direction: column; gap: 1rem; }
	.plan-right { position: sticky; top: 85px; }
	@media (max-width: 960px) { .plan-right { position: static; } }

	/* Preview label above scroll area */
	.preview-label {
		font-size: 0.8rem;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.85rem;
	}
	.preview-badge {
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		background: var(--accent-light);
		color: var(--accent);
		padding: 0.15rem 0.5rem;
		border-radius: 20px;
	}

	/* Horizontal scrollable strip of page thumbnails */
	.book-preview-scroll {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-height: calc(100vh - 240px);
		overflow-y: auto;
		padding-right: 2px; /* prevent scrollbar clipping */
	}

	/* ── Individual page thumbnail ───────────────────────────────────────── */
	/* A5 proportions: 148mm × 210mm → ratio 0.705 → use 224px × 318px */
	.preview-page {
		width: 224px;
		height: 318px;
		border-radius: 3px;
		box-shadow: 0 4px 18px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.08);
		position: relative;
		overflow: hidden;
		flex-shrink: 0;
		cursor: default;
		transition: box-shadow 0.18s ease, transform 0.18s ease;
	}
	.preview-page:hover {
		box-shadow: 0 8px 28px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.1);
		transform: translateY(-2px);
	}

	/* Page number label bottom-right */
	.preview-page-label {
		position: absolute;
		bottom: 6px;
		right: 9px;
		font-size: 7px;
		font-family: 'Inter', sans-serif;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: rgba(255,255,255,0.5);
		pointer-events: none;
	}
	.preview-interior .preview-page-label {
		color: rgba(100,90,80,0.45);
	}

	/* ── Cover page ──────────────────────────────────────────────────────── */
	.preview-cover {
		display: flex;
		flex-direction: column;
	}
	.preview-cover-overlay {
		position: absolute;
		inset: 0;
		z-index: 1;
	}
	.preview-cover-content {
		position: relative;
		z-index: 2;
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		padding: 22px 18px 16px;
	}
	.preview-cover-title {
		font-family: 'Lora', Georgia, serif;
		font-weight: 700;
		line-height: 1.2;
		color: #FAF7F2;
		margin-bottom: 5px;
	}
	.preview-cover-subtitle {
		font-family: 'Inter', sans-serif;
		font-weight: 400;
		line-height: 1.4;
		color: #D9CFBE;
		margin-top: 3px;
	}
	.preview-cover-author {
		font-family: 'Lora', Georgia, serif;
		font-style: italic;
		color: #C9BBA8;
	}

	/* ── Interior pages (title, TOC, chapters) ───────────────────────────── */
	.preview-interior {
		background: #FDFAF5;
		border: 1px solid #E8E0D4;
	}

	/* ── Title page ──────────────────────────────────────────────────────── */
	.preview-title-page {
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		align-items: stretch;
		text-align: center;
		padding: 0;
		background: #FAF8F4;
	}
	.preview-tp-topbar {
		height: 5px;
		background: linear-gradient(90deg, #8E7453 0%, #C4A97A 50%, #8E7453 100%);
		flex-shrink: 0;
	}
	.preview-tp-inner {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 18px 16px;
	}
	.preview-tp-genre {
		font-family: 'Inter', sans-serif;
		font-size: 5.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.18em;
		color: #8E7453;
		border: 0.75px solid #C4A97A;
		padding: 1.5px 5px;
		border-radius: 1px;
		margin-bottom: 6px;
	}
	.preview-tp-title {
		font-family: 'Lora', Georgia, serif;
		font-size: 14px;
		font-weight: 700;
		color: #1A1208;
		line-height: 1.2;
		margin-bottom: 2px;
		letter-spacing: -0.01em;
	}
	.preview-tp-subtitle {
		font-family: 'Inter', sans-serif;
		font-size: 7px;
		color: #6E6860;
		line-height: 1.45;
		max-width: 150px;
		font-style: italic;
	}
	.preview-tp-ornament {
		font-family: Georgia, serif;
		font-size: 10px;
		color: #8E7453;
		opacity: 0.7;
		margin: 6px 0;
		letter-spacing: -1px;
	}
	.preview-tp-author {
		font-family: 'Lora', Georgia, serif;
		font-size: 7.5px;
		font-style: italic;
		color: #4A4238;
		letter-spacing: 0.04em;
	}
	.preview-tp-bottombar {
		height: 22px;
		border-top: 0.75px solid #DDD5C8;
		background: #F2EDE5;
		flex-shrink: 0;
	}

	/* ── Table of Contents page ──────────────────────────────────────────── */
	.preview-toc {
		padding: 20px 16px 16px;
		height: 100%;
		box-sizing: border-box;
	}
	.preview-toc-heading {
		font-family: 'Lora', Georgia, serif;
		font-size: 11px;
		font-weight: 700;
		color: #1A1612;
		margin-bottom: 5px;
	}
	.preview-toc-rule {
		height: 1px;
		background: #D9CFBE;
		margin-bottom: 8px;
	}
	.preview-toc-row {
		display: flex;
		gap: 6px;
		align-items: baseline;
		padding: 3px 0;
		border-bottom: 1px dotted #E8E0D4;
	}
	.preview-toc-num {
		font-family: 'Inter', sans-serif;
		font-size: 6.5px;
		font-weight: 700;
		color: #8E7453;
		flex-shrink: 0;
		letter-spacing: 0.05em;
	}
	.preview-toc-title {
		font-family: 'Lora', Georgia, serif;
		font-size: 7px;
		color: #2B2927;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* ── Chapter opening page ────────────────────────────────────────────── */
	.preview-chapter-page {
		padding: 22px 16px 16px;
		height: 100%;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
	}
	.preview-chap-number {
		font-family: 'Inter', sans-serif;
		font-size: 6px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.14em;
		color: #8E7453;
		margin-bottom: 4px;
	}
	.preview-chap-title {
		font-family: 'Lora', Georgia, serif;
		font-size: 11px;
		font-weight: 700;
		color: #1A1612;
		line-height: 1.3;
		margin-bottom: 4px;
	}
	.preview-chap-rule {
		width: 24px;
		height: 1.5px;
		background: #8E7453;
		margin-bottom: 8px;
		flex-shrink: 0;
	}
	.preview-chap-summary {
		font-family: 'Lora', Georgia, serif;
		font-size: 6.5px;
		color: #5A5248;
		line-height: 1.65;
		margin-bottom: 10px;
		/* clamp to 3 lines */
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.preview-body-lines {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: auto;
	}
	.preview-body-line {
		height: 4px;
		background: #E8E0D4;
		border-radius: 2px;
	}
	.preview-body-line.short { width: 60%; }

	.chapter-plan-list { display: flex; flex-direction: column; gap: 0.65rem; }
	.chapter-plan-item {
		display: flex; align-items: flex-start; gap: 1rem;
		padding: 1rem 1.25rem;
		border: 1px solid var(--border-color); border-radius: var(--radius-sm);
		background: var(--bg-card); transition: var(--transition);
	}
	.chapter-plan-item:hover { border-color: var(--border-focus); }

	.chapter-plan-num {
		width: 28px; height: 28px; border-radius: 50%;
		background: var(--accent-light); color: var(--accent);
		display: flex; align-items: center; justify-content: center;
		font-size: 0.85rem; font-weight: 700; flex-shrink: 0;
	}
	.chapter-plan-info { flex: 1; }
	.chapter-plan-title { font-weight: 600; font-size: 0.95rem; display: block; margin-bottom: 0.2rem; }
	.chapter-plan-summary { font-size: 0.82rem; color: var(--text-muted); margin: 0; line-height: 1.5; }

	.chapter-edit-btn { opacity: 0; transition: opacity 0.15s; }
	.chapter-plan-item:hover .chapter-edit-btn { opacity: 1; }

	/* Edit form */
	.chapter-edit-form { display: flex; gap: 1rem; align-items: flex-start; width: 100%; }
	.chapter-edit-num {
		width: 28px; height: 28px; border-radius: 50%;
		background: var(--accent); color: #fff;
		display: flex; align-items: center; justify-content: center;
		font-size: 0.85rem; font-weight: 700; flex-shrink: 0;
	}
	.chapter-edit-fields { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; }
	.chapter-edit-title { font-size: 0.95rem; font-weight: 600; }
	.chapter-edit-summary { font-size: 0.82rem; resize: vertical; min-height: 56px; }
	.chapter-edit-actions { display: flex; gap: 0.5rem; }

	.plan-approve-row {
		display: flex; align-items: center; justify-content: space-between;
		padding: 1.25rem; border: 1px solid var(--border-color); border-radius: var(--radius-sm);
		background: var(--bg-card); margin-top: 0.5rem;
	}
	.plan-note { font-size: 0.88rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.4rem; margin: 0; }

	/* ── Writing stage — Stage 4 ────────────────────────────────────────── */
	.writing-layout { display: grid; grid-template-columns: 1.1fr 1fr; gap: 2rem; }
	@media (max-width: 800px) { .writing-layout { grid-template-columns: 1fr; } }

	.chapters-progress-list { display: flex; flex-direction: column; gap: 0.6rem; }
	.writing-chapter-row {
		display: flex; align-items: center; gap: 1rem;
		padding: 0.9rem 1.1rem;
		border: 1px solid var(--border-color); border-radius: var(--radius-sm);
		background: var(--bg-card); transition: var(--transition);
	}
	.writing-chapter-row.completed { border-left: 3px solid var(--success); }
	.writing-chapter-row.writing,
	.writing-chapter-row.verifying { border-left: 3px solid var(--warning); }
	.writing-chapter-row.failed { border-left: 3px solid var(--error); }

	.wc-badge {
		width: 26px; height: 26px; border-radius: 50%;
		background: var(--accent-light); color: var(--accent);
		display: flex; align-items: center; justify-content: center;
		font-size: 0.82rem; font-weight: 700; flex-shrink: 0;
	}
	.wc-info { flex: 1; display: flex; flex-direction: column; gap: 0.1rem; }
	.wc-title { font-weight: 600; font-size: 0.9rem; }
	.wc-status-label { font-size: 0.75rem; color: var(--text-muted); }
	.writing-chapter-row.completed .wc-status-label { color: var(--success); }
	.writing-chapter-row.failed .wc-status-label { color: var(--error); }
	.writing-chapter-row.writing .wc-status-label,
	.writing-chapter-row.verifying .wc-status-label { color: var(--warning); }

	.wc-actions { display: flex; gap: 0.4rem; }

	/* Log terminal */
	.logs-panel { display: flex; flex-direction: column; }
	.logs-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
	.logs-header h3 { font-size: 1rem; }
	.log-mode {
		font-size: 0.72rem; font-weight: 700; background: var(--accent-light);
		color: var(--accent); padding: 0.15rem 0.5rem; border-radius: 20px;
	}
	.terminal-body {
		background: var(--bg-inset); border: 1px solid var(--border-color);
		border-radius: var(--radius-sm); padding: 0.9rem;
		font-family: monospace; font-size: 0.78rem; line-height: 1.5;
		color: var(--text-main); overflow-y: auto;
		max-height: 420px; display: flex; flex-direction: column; gap: 0.35rem;
	}
	.log-row { display: flex; gap: 0.4rem; flex-wrap: wrap; }
	.log-row .ts { color: var(--text-muted); flex-shrink: 0; }
	.log-row .step {
		font-weight: bold; font-size: 0.7rem; padding: 0.05rem 0.25rem;
		border-radius: 2px; flex-shrink: 0;
	}
	.log-row.running .step { background: var(--accent-light); color: var(--accent); }
	.log-row.success .step { background: var(--accent-light); color: var(--success); }
	.log-row.error .step, .log-row.error .msg { background: var(--accent-light); color: var(--error); font-weight: 600; }

	/* ── Complete stage — Stage 5 ───────────────────────────────────────── */
	.complete-stage { align-items: center; }
	.complete-card {
		max-width: 620px; width: 100%; text-align: center;
		padding: 3rem 2.5rem; display: flex; flex-direction: column;
		align-items: center; gap: 1.25rem;
	}
	.complete-cover {
		width: 140px;
		height: 210px;
		border-radius: 4px;
		overflow: hidden;
		box-shadow:
			4px 4px 0 rgba(0,0,0,0.08),
			0 8px 24px rgba(0,0,0,0.18),
			0 2px 6px rgba(0,0,0,0.12);
		flex-shrink: 0;
	}
	.complete-cover-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	/* Typeset fallback when no cover image has been generated yet */
	.complete-cover-fallback {
		width: 140px;
		height: 210px;
		border-radius: 4px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
		padding: 1.2rem 0.75rem;
		box-shadow:
			4px 4px 0 rgba(0,0,0,0.08),
			0 8px 24px rgba(0,0,0,0.18),
			0 2px 6px rgba(0,0,0,0.12);
		flex-shrink: 0;
	}
	.complete-cover-fallback-title {
		font-size: 0.82rem;
		font-weight: 700;
		text-align: center;
		line-height: 1.3;
		letter-spacing: 0.01em;
	}
	.complete-cover-fallback-author {
		font-size: 0.65rem;
		font-style: italic;
		text-align: center;
		letter-spacing: 0.02em;
	}
	.complete-card h2 { font-size: 2rem; margin: 0; }
	.complete-card > p { color: var(--text-muted); font-size: 0.95rem; margin: 0; }
	.complete-actions { display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center; }
	.complete-chapter-summary { width: 100%; text-align: left; margin-top: 1rem; border-top: 1px solid var(--border-color); padding-top: 1rem; }
	.complete-chapter-summary h4 { font-size: 0.95rem; margin-bottom: 0.75rem; color: var(--text-muted); }
	.summary-row {
		display: flex; align-items: center; gap: 0.75rem;
		padding: 0.55rem 0; border-bottom: 1px solid var(--border-color);
	}
	.summary-num {
		width: 22px; height: 22px; border-radius: 50%;
		background: var(--accent-light); color: var(--accent);
		display: flex; align-items: center; justify-content: center;
		font-size: 0.75rem; font-weight: 700; flex-shrink: 0;
	}
	.summary-title { flex: 1; font-size: 0.88rem; font-weight: 500; }
	.summary-actions { flex-shrink: 0; }

	/* ── Shared utilities ───────────────────────────────────────────────── */
	.btn-xs { padding: 0.3rem 0.6rem; font-size: 0.78rem; }
	.btn-ghost {
		background: transparent; border: 1px solid var(--border-color);
		color: var(--text-muted); cursor: pointer; border-radius: var(--radius-sm);
		transition: var(--transition); display: inline-flex; align-items: center; gap: 0.3rem;
	}
	.btn-ghost:hover { background: var(--accent-light); color: var(--text-main); border-color: var(--border-focus); }
	.btn-ghost:disabled { opacity: 0.45; cursor: not-allowed; }

	:global(.spin-icon) { animation: spin 1s linear infinite; }

	@keyframes spin { to { transform: rotate(360deg); } }

	.pulse { animation: pulse 1.6s ease-in-out infinite; }
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.45; }
	}
</style>
