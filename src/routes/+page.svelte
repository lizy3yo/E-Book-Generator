<script lang="ts">
	import { globalState } from '$lib/state.svelte';
	import type { Book, Chapter, CoverOption, CoverOrigin, BibleEntry } from '$lib/types';
	import {
		BookMarked, Zap, Paintbrush, BookOpen, Trash2,
		Loader, RefreshCw, CheckCircle, ChevronRight,
		ArrowLeft, Info, RotateCcw, Sparkles, Maximize2, Upload, X
	} from '@lucide/svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import ChapterPlanError from '$lib/components/ChapterPlanError.svelte';
	import CoverPreviewDialog from '$lib/components/CoverPreviewDialog.svelte';
	import { generationRunner } from '$lib/generationRunner.svelte';
	import { AI_CONCEPT_COUNT, hasCoverBrief } from '$lib/coverStyles';
	import { fileToImagePayload } from '$lib/imageInput';
	import { planForPages, clampPageCount, PAGE_PRESETS, MIN_PAGES, MAX_PAGES } from '$lib/bookPlan';

	// ── Stage 1: concept form ──────────────────────────────────────────────────
	let title       = $state('');
	let subtitle    = $state('');
	let author      = $state('');
	let genre       = $state('');
	// Retained only to satisfy the legacy Book.length field on create; page
	// count is what actually drives the plan now.
	let length      = $state<'short' | 'medium' | 'long'>('medium');
	let pageCount   = $state<number>(100);
	const bookPlan  = $derived(planForPages(pageCount));
	const DEFAULT_TONE      = 'Authoritative & Educational';
	const DEFAULT_STRUCTURE = 'Standard Chapters';
	let tone        = $state('');
	let structure   = $state('');
	let useUltraRealistic   = $state(false);
	let researchDepth       = $state<'basic' | 'deep'>('basic');
	// Every book ships through the full fact-mesh cross-validation pass.
	const selfCorrectionLevel: 'standard' | 'rigorous' = 'rigorous';
	/** Optional background brief — injected into every AI call for deeper grounding */
	let userContext = $state('');

	/** Guards the create-book form against a double submit. Purely local: the
	 *  book it would create does not exist yet, so there is no run to consult. */
	let isCreating = $state(false);

	// ── Stage 2: cover options ─────────────────────────────────────────────────
	// Run state (what is generating, what failed) lives in generationRunner so it
	// outlives this component — see `run` below. Only view state is local.
	let previewCoverIdx      = $state<number | null>(null);
	/** Thumbnail of the uploaded reference. Deliberately ephemeral and local:
	 *  the durable artefact is the design language the runner extracts, and the
	 *  source image is never persisted. */
	let referencePreviewUrl  = $state<string | null>(null);

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
	let editingChapterIdx  = $state<number | null>(null);
	let editTitle   = $state('');
	let editSummary = $state('');

	// ── Stage 4: writing ───────────────────────────────────────────────────────
	let logsContainer: HTMLDivElement | null = $state(null);

	// Auto-scroll logs
	$effect(() => {
		if (globalState.activeBook?.logs && logsContainer) {
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	});

	const active = $derived(globalState.activeBook);

	// ── Run state ─────────────────────────────────────────────────────────────
	/**
	 * The active book's in-flight work, owned by the runner rather than this
	 * component. Reading it through a $derived means navigating away and back
	 * re-attaches to the run already in progress instead of showing an idle UI
	 * over work that never stopped.
	 */
	const run = $derived(generationRunner.for(active?.id));
	const coversBusy = $derived(generationRunner.isCoversBusy(active?.id));
	const hasAiConcepts = $derived((active?.coverOptions ?? []).some(o => o.origin === 'ai'));
	/** The author's own direction — written brief, uploaded reference, or both —
	 *  fixes the design language, so Stage 2 renders exactly one cover from it:
	 *  the template and concept tiers have nothing left to vary. */
	const hasBrief = $derived(hasCoverBrief({
		brief:           active?.coverReferencePrompt,
		referenceFormat: active?.coverReferenceFormat
	}));

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 1 → Create book + hand off to the runner (→ Stage 2)
	// ─────────────────────────────────────────────────────────────────────────
	async function handleCreateBook(e: Event) {
		e.preventDefault();
		if (!title.trim() || isCreating) return;
		isCreating = true;

		const book = globalState.createBook({
			title, subtitle, author, genre, length, pageCount,
			tone: tone.trim() || DEFAULT_TONE,
			structure: structure.trim() || DEFAULT_STRUCTURE,
			useUltraRealistic, researchDepth, selfCorrectionLevel,
			userContext, coverReferencePrompt: ''
		});

		title = ''; subtitle = ''; author = ''; userContext = '';
		isCreating = false;
		// Not awaited: the runner owns this from here, and the form is already
		// gone. Awaiting would only tie the run's lifetime to this component.
		generationRunner.startCovers(book);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 2 — cover handlers (thin wrappers over the runner)
	// ─────────────────────────────────────────────────────────────────────────
	function loadAiConcepts() {
		if (active) generationRunner.startAiConcepts(active.id);
	}

	function regenerateSingleCover(idx: number) {
		if (active) generationRunner.regenerateCover(active.id, idx);
	}

	function createBriefCover() {
		if (active) generationRunner.createBriefCover(active.id);
	}

	// ── Reference cover ───────────────────────────────────────────────────────

	/** Read a reference cover's design language and attach it to the book.
	 *  Only the thumbnail is component-local — the analysis itself runs in the
	 *  runner so leaving the page doesn't abandon it. */
	async function handleReferenceUpload(e: Event) {
		const input = e.target as HTMLInputElement;
		const file  = input.files?.[0];
		if (!file || !active) return;

		const bookId = active.id;
		try {
			const payload = await fileToImagePayload(file);
			referencePreviewUrl = payload.previewUrl;
			await generationRunner.analyzeReference(
				bookId,
				{ mediaType: payload.mediaType, data: payload.data },
				file.name
			);
		} catch {
			// The runner records the failure in run.referenceError; a decode
			// failure before it is reported the same way.
			referencePreviewUrl = null;
		}

		// Reset the input so re-picking the same file fires a fresh change event.
		input.value = '';
	}

	function clearReference() {
		if (!active || run.referenceBusy) return;
		globalState.setCoverReferenceFormat(active.id, null, null);
		generationRunner.clearReferenceError(active.id);
		referencePreviewUrl = null;
	}

	// ── Full-size preview ─────────────────────────────────────────────────────

	const previewOption = $derived(
		previewCoverIdx !== null ? active?.coverOptions[previewCoverIdx] ?? null : null
	);

	function openPreview(idx: number) { previewCoverIdx = idx; }
	function closePreview()           { previewCoverIdx = null; }

	function pagePreview(step: number) {
		if (previewCoverIdx === null || !active) return;
		const n = active.coverOptions.length;
		previewCoverIdx = (previewCoverIdx + step + n) % n;
	}

	function selectCoverAndProceed(index: number) {
		if (!active) return;
		previewCoverIdx = null;
		globalState.selectCoverOption(active.id, index);
		generationRunner.startChapterPlan(active);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 3 — chapter plan
	// ─────────────────────────────────────────────────────────────────────────
	function retryChapterPlan() {
		if (active) generationRunner.startChapterPlan(active);
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

	// ─────────────────────────────────────────────────────────────────────────
	// STAGE 4 — writing
	// ─────────────────────────────────────────────────────────────────────────
	function approveChapterPlan() {
		if (!active) return;
		globalState.setPipelineStage(active.id, 4);
		generationRunner.startWriting(active);
	}

	function handleRegenerateChapter(chapIndex: number) {
		if (active) generationRunner.regenerateChapter(active.id, chapIndex);
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
							<label for="pageCount">Target Length</label>
							<!-- Presets carry the common choices in one click; the number
							     input catches everything between them. A bare number input
							     would accept meaningless values and hide what a choice
							     costs — which the old dropdown at least made explicit. -->
							<div class="page-presets" role="group" aria-label="Target page count presets">
								{#each PAGE_PRESETS as preset}
									<button
										type="button"
										class="page-chip"
										class:page-chip--active={pageCount === preset}
										aria-pressed={pageCount === preset}
										onclick={() => (pageCount = preset)}
									>
										{preset}
									</button>
								{/each}
								<div class="page-custom">
									<input
										id="pageCount"
										type="number"
										min={MIN_PAGES}
										max={MAX_PAGES}
										step="25"
										bind:value={pageCount}
										onblur={() => (pageCount = clampPageCount(pageCount))}
										aria-label="Target page count"
									/>
									<span class="page-custom__unit">pages</span>
								</div>
							</div>
							<p class="page-hint">
								≈{bookPlan.totalWords.toLocaleString()} words · {bookPlan.chapterCount} chapters · ~{bookPlan.wordsPerChapter.toLocaleString()} words each
								{#if bookPlan.chapterCount >= 20}
									<span class="page-hint__warn">· long generation — expect this to take a while</span>
								{/if}
							</p>
						</div>
					</div>

					<!-- ── Advanced Settings (collapsed by default) ─────────── -->
					<details class="advanced-settings">
						<summary class="advanced-settings__toggle font-serif">
							<span class="advanced-settings__label">Advanced Settings</span>
							<span class="advanced-settings__hint">Writing tone, book structure, research depth, illustrations</span>
						</summary>
						<div class="advanced-settings__body">
							<div class="advanced-row grid-2-col">
								<div class="form-group">
									<label for="tone">Writing Tone</label>
									<input
										id="tone"
										type="text"
										bind:value={tone}
										list="tone-presets"
										placeholder="e.g., {DEFAULT_TONE}"
										autocomplete="off"
									/>
									<datalist id="tone-presets">
										<option value="Authoritative & Educational"></option>
										<option value="Conversational & Accessible"></option>
										<option value="Practical & Action-Oriented"></option>
										<option value="Academic & Research-Driven"></option>
										<option value="Journalistic & Investigative"></option>
										<option value="Narrative & Storytelling"></option>
										<option value="Inspirational & Motivational"></option>
										<option value="Reflective & Philosophical"></option>
										<option value="Technical & Precise"></option>
										<option value="Instructional & Step-by-Step"></option>
									</datalist>
								</div>
								<div class="form-group">
									<label for="structure">Book Structure</label>
									<input
										id="structure"
										type="text"
										bind:value={structure}
										list="structure-presets"
										placeholder="e.g., {DEFAULT_STRUCTURE}"
										autocomplete="off"
									/>
									<datalist id="structure-presets">
										<option value="Standard Chapters"></option>
										<option value="Problem–Solution Framework"></option>
										<option value="Step-by-Step Blueprint"></option>
										<option value="Pillar & Chapter Framework"></option>
										<option value="Story Narrative"></option>
										<option value="Academic Thesis"></option>
										<option value="Interview & Case Study"></option>
									</datalist>
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
						<button type="submit" class="btn btn-primary" disabled={isCreating || !title.trim()}>
							{#if isCreating}
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
					<p>Cover concepts for <strong>{active.title}</strong>. Click any cover to preview it full size. Load more variants below, or give direction and regenerate.</p>
				</div>

				{#if run.isGeneratingCovers && active.coverOptions.length === 0}
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
						{#each active.coverOptions as opt, idx (opt.id)}
							{@const pending = run.pendingCoverIds.includes(opt.id)}
							<div class="cover-option-card {active.selectedCoverIndex === idx ? 'selected' : ''}">
								<button
									class="cover-option-preview"
									onclick={() => openPreview(idx)}
									disabled={pending}
									aria-label="Preview the {opt.style} cover full size"
								>
									{#if opt.imageUrl}
										<img src={opt.imageUrl} alt="Cover option {idx + 1} — {opt.style}" />
										<span class="cover-zoom-hint" aria-hidden="true"><Maximize2 size={14} /> Preview</span>
									{:else if pending}
										<div class="cover-placeholder">
											<Loader size={24} class="spin-icon" />
										</div>
									{:else}
										<div class="cover-placeholder cover-placeholder--failed">
											<BookMarked size={28} />
											<span>Didn't render — regenerate</span>
										</div>
									{/if}
									{#if run.regeneratingCoverIdx === idx}
										<div class="cover-regenerating-overlay">
											<Loader size={24} class="spin-icon" />
										</div>
									{/if}
								</button>
								<div class="cover-option-meta">
									<div class="cover-style-line">
										<span class="cover-style-label font-serif">{opt.style}</span>
										{#if opt.origin === 'ai'}
											<span class="cover-origin-badge cover-origin-badge--ai"><Sparkles size={10} /> AI</span>
										{/if}
									</div>
									{#if opt.concept}
										<p class="cover-concept-line">{opt.concept}</p>
									{/if}
									<div class="cover-option-actions">
										<button
											class="btn btn-ghost btn-xs"
											onclick={() => regenerateSingleCover(idx)}
											disabled={pending || run.regeneratingCoverIdx !== null}
											title="Regenerate this cover"
										>
											<RotateCcw size={13} />
										</button>
										<button
											class="btn btn-primary btn-xs"
											onclick={() => selectCoverAndProceed(idx)}
											disabled={!opt.imageUrl}
										>
											Select <ChevronRight size={13} />
										</button>
									</div>
								</div>
							</div>
						{/each}
					</div>

					<!-- AI concepts: a paid batch the author opts into -->
					{#if !hasAiConcepts}
						<div class="cover-more">
							<div class="cover-more__copy">
								<span class="cover-more__title font-serif">Want original concepts?</span>
								<span class="cover-more__hint">Claude reads your brief and art-directs {AI_CONCEPT_COUNT} covers of its own — no templates involved.</span>
							</div>
							<div class="cover-more__actions">
								<button
									class="btn btn-secondary btn-sm"
									onclick={loadAiConcepts}
									disabled={run.loadingBatch === 'ai'}
								>
									{#if run.loadingBatch === 'ai'}
										<span class="btn-spinner"></span> Devising concepts…
									{:else}
										<Sparkles size={14} /> {AI_CONCEPT_COUNT} AI concepts from your brief
									{/if}
								</button>
							</div>
						</div>
					{/if}

					{#if run.coverError}
						<p class="cover-error" role="alert">{run.coverError}</p>
					{/if}

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
							disabled={coversBusy}
						></textarea>

						<!-- ── Reference cover ─────────────────────────────────── -->
						<div class="ref-cover">
							<div class="ref-cover__header">
								<span class="ref-cover__title font-serif">Reference Cover</span>
								<span class="context-optional">optional</span>
							</div>
							<p class="ref-cover__desc">
								Upload any cover whose <em>format</em> you want to borrow — it can be from a completely different niche. Claude reads its colour scheme, typography, imagery and graphic treatment, then adds a single cover for your book in that design language. The reference's subject matter is never copied.
							</p>

							{#if active.coverReferenceFormat}
								<div class="ref-cover__loaded">
									{#if referencePreviewUrl}
										<img class="ref-cover__thumb" src={referencePreviewUrl} alt="Uploaded reference cover" />
									{:else}
										<div class="ref-cover__thumb ref-cover__thumb--empty"><BookMarked size={18} /></div>
									{/if}
									<div class="ref-cover__loaded-body">
										<span class="ref-cover__loaded-title">
											<CheckCircle size={13} /> Design language applied
										</span>
										<span class="ref-cover__loaded-name">{active.coverReferenceName || 'Reference cover'}</span>
										<details class="ref-cover__spec">
											<summary>View what Claude read from it</summary>
											<pre>{active.coverReferenceFormat}</pre>
										</details>
									</div>
									<button
										class="btn btn-ghost btn-xs"
										onclick={clearReference}
										disabled={coversBusy}
										title="Remove reference cover"
									>
										<X size={13} />
									</button>
								</div>
								<p class="ref-cover__note">Create a cover below to add one in this design language.</p>
							{:else}
								<label class="ref-cover__drop {run.referenceBusy ? 'is-busy' : ''}">
									<input
										type="file"
										accept="image/png,image/jpeg,image/webp"
										onchange={handleReferenceUpload}
										disabled={coversBusy}
									/>
									{#if run.referenceBusy}
										<Loader size={16} class="spin-icon" />
										<span>Reading the reference…</span>
									{:else}
										<Upload size={16} />
										<span><strong>Upload a reference cover</strong> — JPG, PNG or WebP</span>
									{/if}
								</label>
							{/if}

							{#if run.referenceError}
								<p class="cover-error" role="alert">{run.referenceError}</p>
							{/if}
						</div>

						<div class="form-actions" style="margin-top: 1rem; display: flex; justify-content: flex-end; align-items: center; gap: 0.75rem; width: 100%;">
							{#if !hasBrief}
								<span class="cover-brief-hint">Describe your direction or upload a reference to build a cover from.</span>
							{/if}
							<button
								class="btn btn-primary"
								onclick={createBriefCover}
								disabled={coversBusy || !hasBrief}
								title={hasBrief ? 'Add a cover built from your brief' : 'Add direction or a reference cover first'}
								style="background-color: #8b7355; border-color: #8b7355;"
							>
								{#if run.loadingBatch === 'brief'}
									<span class="btn-spinner"></span> Creating cover…
								{:else}
									<Zap size={15} /> Create Cover
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

				{#if run.planError || (active.status === 'failed' && active.chapters.length === 0 && !run.isGeneratingPlan)}
					<ChapterPlanError
						error={run.planError ?? 'Chapter plan generation failed. Please try again.'}
						isRetrying={run.isGeneratingPlan}
						onRetry={retryChapterPlan}
					/>
				{:else if run.isGeneratingPlan || active.chapters.length === 0}
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
											disabled={run.isWriting || run.regeneratingChapterIdx !== null}
											title="Regenerate this chapter"
										>
											{#if run.regeneratingChapterIdx === idx}
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
							{#if run.isWriting || run.regeneratingChapterIdx !== null}
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
										disabled={run.regeneratingChapterIdx !== null}
										title="Regenerate chapter"
									>
										{#if run.regeneratingChapterIdx === idx}
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

<CoverPreviewDialog
	open={previewCoverIdx !== null && previewOption !== null}
	option={previewOption}
	index={previewCoverIdx ?? 0}
	total={active?.coverOptions.length ?? 0}
	busy={coversBusy}
	onSelect={() => previewCoverIdx !== null && selectCoverAndProceed(previewCoverIdx)}
	onRegenerate={() => previewCoverIdx !== null && regenerateSingleCover(previewCoverIdx)}
	onPrev={() => pagePreview(-1)}
	onNext={() => pagePreview(1)}
	onClose={closePreview}
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

	/* ── Target length: preset chips + number input ─────────────────── */
	.page-presets { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
	.page-chip {
		font: inherit;
		font-size: 0.82rem;
		font-weight: 600;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md, 6px);
		background: var(--bg-card, #fff);
		color: var(--text-color, inherit);
		cursor: pointer;
		transition: background-color 0.12s, border-color 0.12s, color 0.12s;
	}
	.page-chip:hover { border-color: var(--accent-color, #8E7453); }
	.page-chip--active {
		background: var(--accent-color, #8E7453);
		border-color: var(--accent-color, #8E7453);
		color: #fff;
	}
	.page-custom { display: flex; align-items: center; gap: 0.35rem; margin-left: 0.15rem; }
	.page-custom input {
		width: 5.5rem;
		font: inherit;
		font-size: 0.82rem;
		padding: 0.4rem 0.5rem;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md, 6px);
		background: var(--bg-card, #fff);
		color: inherit;
	}
	.page-custom__unit { font-size: 0.78rem; color: var(--text-muted, #6A6055); }
	.page-hint {
		margin: 0.15rem 0 0;
		font-size: 0.76rem;
		color: var(--text-muted, #6A6055);
	}
	/* A 20+ chapter book is a long, costly run — say so before they commit. */
	.page-hint__warn { color: var(--accent-color, #8E7453); font-weight: 600; }

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

	/* Says why Create Cover is disabled — a dead button with no reason reads as
	   a bug rather than a precondition. */
	.cover-brief-hint {
		font-size: 0.78rem; color: var(--text-muted); text-align: right;
	}

	.cover-option-card {
		border: 2px solid var(--border-color); border-radius: var(--radius-md);
		overflow: hidden; transition: var(--transition); background: var(--bg-card);
	}
	.cover-option-card:hover { border-color: var(--border-focus); box-shadow: var(--shadow-md); }
	.cover-option-card.selected { border-color: var(--accent); }

	/* The tile carries the cover's own 2:3 trim size, so the artwork fills it
	   edge to edge with nothing cropped and no letterbox field behind it. */
	.cover-option-preview {
		position: relative; aspect-ratio: 2 / 3; overflow: hidden;
		background-color: var(--bg-inset);
		display: flex; align-items: center; justify-content: center;
		width: 100%; padding: 0; border: none;
		font: inherit; color: inherit; cursor: zoom-in;
	}
	.cover-option-preview:disabled { cursor: default; }
	.cover-option-preview img {
		width: 100%; height: 100%;
		object-fit: cover; display: block;
	}
	.cover-option-preview:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

	/* Preview affordance — the cursor alone doesn't advertise that these open */
	.cover-zoom-hint {
		position: absolute; bottom: 0.5rem; right: 0.5rem;
		display: inline-flex; align-items: center; gap: 0.25rem;
		font-size: 0.68rem; font-weight: 600;
		padding: 0.22rem 0.45rem; border-radius: 4px;
		background: rgba(0,0,0,0.55); color: #fff;
		opacity: 0; transition: opacity 0.15s;
		pointer-events: none;
	}
	.cover-option-preview:hover .cover-zoom-hint,
	.cover-option-preview:focus-visible .cover-zoom-hint { opacity: 1; }

	.cover-placeholder {
		color: var(--text-muted); display: flex; align-items: center;
		justify-content: center; width: 100%; height: 100%;
	}
	.cover-placeholder--failed {
		flex-direction: column; gap: 0.45rem; text-align: center; padding: 0 1rem;
	}
	.cover-placeholder--failed span { font-size: 0.72rem; }

	.cover-regenerating-overlay {
		position: absolute; inset: 0;
		background: rgba(0,0,0,0.45); display: flex;
		align-items: center; justify-content: center; color: #fff;
	}

	.cover-option-meta {
		padding: 0.85rem 1rem;
		display: flex; flex-direction: column; gap: 0.4rem;
		border-top: 1px solid var(--border-color);
	}
	.cover-style-line { display: flex; align-items: center; gap: 0.4rem; }
	.cover-style-label { font-size: 0.88rem; font-weight: 600; }

	.cover-origin-badge {
		display: inline-flex; align-items: center; gap: 0.2rem;
		font-size: 0.6rem; font-weight: 700; letter-spacing: 0.05em;
		text-transform: uppercase;
		padding: 0.12rem 0.3rem; border-radius: 3px;
		background: #F3F0EB; color: var(--text-muted);
	}
	.cover-origin-badge--ai { background: #F0EAFB; color: #6D4AAE; }

	/* Two lines, so a long rationale can't push the Select button out of
	   alignment with the neighbouring cards in the row. */
	.cover-concept-line {
		margin: 0; font-size: 0.74rem; line-height: 1.5; color: var(--text-muted);
		display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
		-webkit-box-orient: vertical; overflow: hidden;
		min-height: 2.2em;
	}

	.cover-option-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: auto; }

	/* ── More variants ─────────────────────────────────────────────────── */
	.cover-more {
		margin-top: 1.25rem; padding: 0.9rem 1.1rem;
		border: 1px dashed var(--border-color); border-radius: var(--radius-md);
		background: var(--bg-inset);
		display: flex; align-items: center; justify-content: space-between;
		gap: 1rem; flex-wrap: wrap;
	}
	.cover-more__copy { display: flex; flex-direction: column; gap: 0.1rem; }
	.cover-more__title { font-size: 0.88rem; font-weight: 600; }
	.cover-more__hint  { font-size: 0.75rem; color: var(--text-muted); }
	.cover-more__actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

	.cover-error {
		margin: 0.75rem 0 0; font-size: 0.78rem; color: #B91C1C;
		background: #FEF2F2; border: 1px solid #FECACA;
		border-radius: var(--radius-md); padding: 0.5rem 0.7rem;
	}

	/* ── Reference cover ───────────────────────────────────────────────── */
	.ref-cover {
		margin-top: 1.1rem; padding-top: 1rem;
		border-top: 1px solid var(--border-color);
		display: flex; flex-direction: column; gap: 0.4rem;
	}
	.ref-cover__header { display: flex; align-items: center; gap: 0.5rem; }
	.ref-cover__title  { font-size: 0.86rem; font-weight: 600; }
	.ref-cover__desc   { margin: 0 0 0.35rem; font-size: 0.78rem; line-height: 1.6; color: var(--text-muted); }
	.ref-cover__note   { margin: 0; font-size: 0.73rem; color: var(--text-muted); }

	.ref-cover__drop {
		display: flex; align-items: center; justify-content: center; gap: 0.5rem;
		padding: 1rem; border: 1px dashed var(--border-color);
		border-radius: var(--radius-md); background: var(--bg-card);
		font-size: 0.8rem; color: var(--text-muted);
		cursor: pointer; transition: border-color 0.15s, background 0.15s;
	}
	.ref-cover__drop:hover { border-color: var(--accent); background: var(--bg-inset); }
	.ref-cover__drop.is-busy { cursor: progress; }
	.ref-cover__drop input { display: none; }
	.ref-cover__drop strong { color: var(--text-color); font-weight: 600; }

	.ref-cover__loaded {
		display: flex; align-items: flex-start; gap: 0.75rem;
		padding: 0.75rem; border: 1px solid var(--border-color);
		border-radius: var(--radius-md); background: var(--bg-card);
	}
	.ref-cover__thumb {
		width: 44px; height: 62px; object-fit: cover; flex-shrink: 0;
		border-radius: 3px; border: 1px solid var(--border-color);
	}
	.ref-cover__thumb--empty {
		display: flex; align-items: center; justify-content: center;
		background: var(--bg-inset); color: var(--text-muted);
	}
	.ref-cover__loaded-body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; }
	.ref-cover__loaded-title {
		display: inline-flex; align-items: center; gap: 0.3rem;
		font-size: 0.8rem; font-weight: 600; color: #15803D;
	}
	.ref-cover__loaded-name {
		font-size: 0.73rem; color: var(--text-muted);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.ref-cover__spec { margin-top: 0.3rem; }
	.ref-cover__spec summary {
		font-size: 0.73rem; color: var(--accent); cursor: pointer; user-select: none;
	}
	.ref-cover__spec pre {
		margin: 0.4rem 0 0; padding: 0.6rem 0.7rem;
		background: var(--bg-inset); border: 1px solid var(--border-color);
		border-radius: 4px;
		font-size: 0.7rem; line-height: 1.6; color: var(--text-muted);
		white-space: pre-wrap; word-break: break-word;
		max-height: 160px; overflow-y: auto;
	}

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
