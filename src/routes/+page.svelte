<script lang="ts">
	import { onMount } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import type { Book, Chapter, StepLog } from '$lib/types';
	import { BookMarked, Zap, Paintbrush, BookOpen, Trash2, Loader, CheckCircle2, XCircle, Info } from '@lucide/svelte';

	// Form inputs
	let title = $state('');
	let subtitle = $state('');
	let author = $state('');
	let genre = $state('Technology');
	let length = $state<'short' | 'medium' | 'long'>('short');
	let tone = $state('Professional & Insightful');
	let structure = $state('Standard Chapters');
	let useUltraRealistic = $state(false);
	let researchDepth = $state<'basic' | 'deep'>('basic');
	let selfCorrectionLevel = $state<'standard' | 'rigorous'>('standard');

	let isGenerating = $state(false);
	let logsContainer: HTMLDivElement | null = $state(null);

	// Auto-scroll logs
	$effect(() => {
		if (globalState.activeBook?.logs && logsContainer) {
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	});

	function handleCreateBook(e: Event) {
		e.preventDefault();
		if (!title.trim()) return;

		const newBook = globalState.createBook({
			title,
			subtitle,
			author,
			genre,
			length,
			tone,
			structure,
			useUltraRealistic,
			researchDepth,
			selfCorrectionLevel
		});

		// Clear form
		title = '';
		subtitle = '';
		author = '';
	}

	async function runAutomatedPipeline(book: Book) {
		if (isGenerating) return;
		isGenerating = true;

		try {
			const keys = globalState.apiKeys;
			const useMock = keys.useMockMode;

			// 1. Research Phase
			globalState.updateBookStatus(book.id, 'researching');
			globalState.addLog(book.id, {
				step: 'research',
				status: 'running',
				message: `Starting Exa AI semantic research for "${book.title}"...`
			});

			const researchRes = await fetch('/api/research', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					query: `Grounding research and core statistics on: ${book.title}. Genre: ${book.genre}. Subject focus.`,
					apiKey: keys.exaKey,
					useMockMode: useMock
				})
			});
			const researchData = await researchRes.json();

			if (!researchData.success) {
				throw new Error(researchData.error || 'Exa AI research failed.');
			}

			const facts = researchData.results;
			const factsSummary = facts.map((f: any) => `[Source: ${f.title}] ${f.snippet}`).join('\n\n');
			
			globalState.addLog(book.id, {
				step: 'research',
				status: 'success',
				message: `Grounding search complete. Extracted ${facts.length} semantic facts & citations.`
			});

			// 2. Outlining Phase
			globalState.updateBookStatus(book.id, 'outlining');
			globalState.addLog(book.id, {
				step: 'outline',
				status: 'running',
				message: 'Prompting Claude to structure the book outline and chapter summaries...'
			});

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

			if (!outlineData.success) {
				throw new Error(outlineData.error || 'Claude outlining failed.');
			}

			const chapters: Chapter[] = outlineData.chapters;
			globalState.updateBookChapters(book.id, chapters);
			globalState.addLog(book.id, {
				step: 'outline',
				status: 'success',
				message: `Outline designed. Structured ${chapters.length} chapters based on tone rules.`
			});

			// 3. Chapter-by-chapter drafting and validation loop
			globalState.updateBookStatus(book.id, 'writing');
			
			for (let i = 0; i < chapters.length; i++) {
				const chap = chapters[i];
				globalState.addLog(book.id, {
					step: 'drafting',
					status: 'running',
					message: `Drafting Chapter ${chap.order}/${chapters.length}: "${chap.title}"...`
				});

				// Update specific chapter status in state
				const updatedChaps = [...globalState.books.find((b: Book) => b.id === book.id)!.chapters];
				updatedChaps[i].status = 'writing';
				globalState.updateBookChapters(book.id, updatedChaps);

				// Generate Chapter Draft
				const draftRes = await fetch('/api/write', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'write-chapter',
						apiKey: keys.anthropicKey,
						useMockMode: useMock,
						bookTitle: book.title,
						chapterTitle: chap.title,
						chapterOrder: chap.order,
						chapterSummary: chap.summary,
						tone: book.tone,
						researchNotes: factsSummary
					})
				});
				const draftData = await draftRes.json();

				if (!draftData.success) {
					throw new Error(draftData.error || `Failed to draft Chapter ${chap.order}.`);
				}

				const rawContent = draftData.content;

				// Verify & Self-Fact-Check Chapter
				globalState.addLog(book.id, {
					step: 'review',
					status: 'running',
					message: `Executing Claude consistency & fact-checking pass on Chapter ${chap.order}...`
				});

				updatedChaps[i].status = 'verifying';
				globalState.updateBookChapters(book.id, updatedChaps);

				const verifyRes = await fetch('/api/write', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'verify-chapter',
						apiKey: keys.anthropicKey,
						useMockMode: useMock,
						bookTitle: book.title,
						chapterTitle: chap.title,
						chapterContent: rawContent,
						researchNotes: factsSummary
					})
				});
				const verifyData = await verifyRes.json();

				if (!verifyData.success) {
					throw new Error(verifyData.error || `Failed to verify Chapter ${chap.order}.`);
				}

				// Chapter Illustration Phase
				globalState.addLog(book.id, {
					step: 'illustrate',
					status: 'running',
					message: `Generating custom minimalist chapter illustration using Kie.ai/69labs...`
				});

				const illustRes = await fetch('/api/image', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						prompt: `A beautiful minimalist book chapter illustration for chapter titled "${chap.title}". Modern editorial style, vector art, cream background.`,
						apiKey: keys.imageKey,
						provider: keys.imageProvider,
						useMockMode: useMock,
						isCover: false
					})
				});
				const illustData = await illustRes.json();

				// Save final chapter results
				updatedChaps[i].content = verifyData.verifiedContent;
				updatedChaps[i].status = 'completed';
				updatedChaps[i].illustrationUrl = illustData.success ? illustData.imageUrl : null;
				globalState.updateBookChapters(book.id, updatedChaps);

				globalState.addLog(book.id, {
					step: 'drafting',
					status: 'success',
					message: `Chapter ${chap.order} fully completed & checked.`
				});
			}

			// 4. Generate Book Cover automatically in background if not exists
			globalState.addLog(book.id, {
				step: 'illustrate',
				status: 'running',
				message: 'Generating base ebook cover art in background...'
			});
			globalState.updateBookStatus(book.id, 'illustrating');

			const coverRes = await fetch('/api/image', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: book.coverSettings.bgImagePrompt,
					apiKey: keys.imageKey,
					provider: keys.imageProvider,
					useMockMode: useMock,
					isCover: true
				})
			});
			const coverData = await coverRes.json();
			
			if (coverData.success) {
				const updatedCover = { ...book.coverSettings, bgImageUrl: coverData.imageUrl };
				globalState.updateCoverSettings(book.id, updatedCover);
				globalState.addLog(book.id, {
					step: 'illustrate',
					status: 'success',
					message: 'Base book cover successfully generated.'
				});
			} else {
				globalState.addLog(book.id, {
					step: 'illustrate',
					status: 'error',
					message: 'Failed to generate cover art. Can be configured later in Cover Studio.'
				});
			}

			// Finalize
			globalState.updateBookStatus(book.id, 'completed');
			globalState.addLog(book.id, {
				step: 'complete',
				status: 'success',
				message: '🎉 Ebook generation pipeline finished successfully! Head to Cover Studio or the Reader.'
			});

		} catch (err: any) {
			console.error('Generation pipeline error:', err);
			globalState.updateBookStatus(book.id, 'failed');
			globalState.addLog(book.id, {
				step: 'complete',
				status: 'error',
				message: `Pipeline halted: ${err.message || 'Unknown error occurred.'}`
			});
		} finally {
			isGenerating = false;
		}
	}
</script>

<svelte:head>
	<title>Ebook Automator Dashboard</title>
</svelte:head>

<div class="workspace-grid">
	
	<!-- Left Side: Books Library List -->
	<aside class="sidebar-library">
		<div class="library-header font-serif">
			<h3>Your Library</h3>
			<span class="count">{globalState.books.length} Books</span>
		</div>

		<div class="library-list">
			{#if globalState.books.length === 0}
				<div class="empty-library font-serif">
					<p>Library is empty.</p>
					<p class="small">Create an ebook in the workspace to get started.</p>
				</div>
			{/if}

			{#each globalState.books as b}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
				<div 
					class="book-row {globalState.activeBookId === b.id ? 'active' : ''}" 
					role="button"
					tabindex="0"
					onclick={() => { if (!isGenerating || globalState.activeBookId === b.id) globalState.setActiveBook(b.id); }}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!isGenerating || globalState.activeBookId === b.id) globalState.setActiveBook(b.id); } }}
				>
					<div class="book-row-icon"><BookMarked size={18} /></div>
					<div class="book-row-meta">
						<span class="book-row-title font-serif">{b.title}</span>
						<span class="book-row-status {b.status}">
							{#if b.status === 'completed'}
								✓ Ready
							{:else if b.status === 'failed'}
								✕ Failed
							{:else if b.status === 'idle'}
								Draft
							{:else}
								• Generating...
							{/if}
						</span>
					</div>
					<button 
						class="btn-delete" 
						onclick={(e: MouseEvent) => { e.stopPropagation(); globalState.deleteBook(b.id); }}
						disabled={isGenerating}
						title="Delete book"
					>
						<Trash2 size={14} />
					</button>
				</div>
			{/each}
		</div>
	</aside>

	<!-- Right Side: Active Workspace -->
	<main class="main-workspace">
		{#if !globalState.activeBook}
			<!-- Create Form Screen -->
			<div class="create-workspace card">
				<div class="workspace-title font-serif">
					<h2>Create New Ebook</h2>
					<p>Set up parameters to start the automated semantic research and writing pipeline.</p>
				</div>

				<form onsubmit={handleCreateBook} class="create-form">
					<div class="form-row grid-2-col">
						<div class="form-group">
							<label for="title">Book Title</label>
							<input 
								id="title" 
								type="text" 
								placeholder="e.g., The Future of Lunar Agriculture" 
								bind:value={title} 
								required 
							/>
						</div>
						<div class="form-group">
							<label for="subtitle">Subtitle</label>
							<input 
								id="subtitle" 
								type="text" 
								placeholder="e.g., Engineering Crops in Extreme Environments" 
								bind:value={subtitle} 
							/>
						</div>
					</div>

					<div class="form-row grid-2-col">
						<div class="form-group">
							<label for="author">Author Name</label>
							<input 
								id="author" 
								type="text" 
								placeholder="e.g., Dr. Elena Rostova" 
								bind:value={author} 
							/>
						</div>
						<div class="form-group">
							<label for="genre">Genre / Subject</label>
							<select id="genre" bind:value={genre}>
								<option value="Technology & AI">Technology & AI</option>
								<option value="Science & Space">Science & Space</option>
								<option value="Business & Finance">Business & Finance</option>
								<option value="History & Culture">History & Culture</option>
								<option value="Self-Help & Growth">Self-Help & Growth</option>
							</select>
						</div>
					</div>

					<div class="form-row grid-3-col">
						<div class="form-group">
							<label for="length">Target Length</label>
							<select id="length" bind:value={length}>
								<option value="short">Short (3 Chapters)</option>
								<option value="medium">Medium (5 Chapters)</option>
								<option value="long">Long (8 Chapters)</option>
							</select>
						</div>
						<div class="form-group">
							<label for="tone">Writing Tone</label>
							<input 
								id="tone" 
								type="text" 
								placeholder="e.g., Professional, Academic, Conversational" 
								bind:value={tone} 
							/>
						</div>
						<div class="form-group">
							<label for="structure">Book Structure style</label>
							<select id="structure" bind:value={structure}>
								<option value="Standard Chapters">Standard Chapters (Intro, Body, Outro)</option>
								<option value="Academic Thesis">Academic Thesis (Abstract, Methods, Discussion)</option>
								<option value="Story Narrative">Story Narrative (Chapters with narrative arcs)</option>
								<option value="Step-by-Step Guide">Step-by-Step Blueprint (Phases & Guides)</option>
							</select>
						</div>
					</div>

					<div class="form-row parameters-section font-serif">
						<h4>Pipeline Rigor Settings</h4>
						<div class="parameters-grid">
							<!-- Grounding Depth -->
							<div class="parameter-group">
								<label for="depth">Research Grounding (Exa AI)</label>
								<select id="depth" bind:value={researchDepth}>
									<option value="basic">Basic (Fast semantic search)</option>
									<option value="deep">Deep (Comprehensive index extraction)</option>
								</select>
							</div>
							
							<!-- Correction -->
							<div class="parameter-group">
								<label for="correction">Claude Self-Correction</label>
								<select id="correction" bind:value={selfCorrectionLevel}>
									<option value="standard">Standard copy-editing pass</option>
									<option value="rigorous">Rigorous facts-mesh cross-validation</option>
								</select>
							</div>

							<!-- Ultra realistic images -->
							<div class="parameter-group check-group">
								<label class="checkbox-container">
									<input type="checkbox" bind:checked={useUltraRealistic} />
									<span class="checkbox-custom"></span>
									<span>Enable Ultra Realistic Illustrations</span>
								</label>
							</div>
						</div>
					</div>

					<div class="form-actions">
						<button type="submit" class="btn btn-primary">Initialize Book Structure</button>
					</div>
				</form>
			</div>
		{:else}
			<!-- Book Active Workspace Monitor -->
			{@const active = globalState.activeBook}
			<div class="monitor-workspace">
				
				<!-- Monitor Header -->
				<div class="monitor-header">
					<div class="monitor-title font-serif">
						<h2>{active.title}</h2>
						<p class="meta">by {active.author} • {active.genre} • {active.chapters.length} Chapters</p>
					</div>

					<div class="monitor-controls">
						{#if active.status === 'idle' || active.status === 'failed'}
							<button 
								class="btn btn-primary" 
								onclick={() => runAutomatedPipeline(active)}
								disabled={isGenerating}
							>
								<Zap size={15} /> Start Automation Pipeline
							</button>
						{:else if active.status === 'completed'}
							<div class="completed-actions">
								<a href="/cover" class="btn btn-secondary"><Paintbrush size={15} /> Design Cover</a>
								<a href="/reader" class="btn btn-primary"><BookOpen size={15} /> Read Ebook</a>
							</div>
						{:else}
							<div class="generating-badge pulse">
								<Loader size={15} class="spin" />
								<span>Generating...</span>
							</div>
						{/if}
					</div>
				</div>

				<div class="monitor-grid">
					
					<!-- Left Section: Details & Outline Check -->
					<div class="monitor-details">
						<!-- Outline Preview -->
						<div class="outline-card card">
							<h3 class="font-serif">Table of Contents</h3>
							{#if active.chapters.length === 0}
								<div class="empty-outline font-serif">
									<p>Outline has not been created yet.</p>
									<p class="small">The outline will be drafted by Claude during the generation pipeline.</p>
								</div>
							{:else}
								<div class="chapters-timeline">
									{#each active.chapters as chap}
										<div class="chapter-item {chap.status}">
											<div class="chapter-badge">{chap.order}</div>
											<div class="chapter-info">
												<span class="chapter-title font-serif">{chap.title}</span>
												<p class="chapter-summary">{chap.summary}</p>
											</div>
											<div class="chapter-item-status">
												{#if chap.status === 'completed'}
													<span class="status-check">✓ Done</span>
												{:else if chap.status === 'writing' || chap.status === 'verifying'}
													<span class="status-write pulse">Writing...</span>
												{:else}
													<span class="status-pending">Pending</span>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>

					<!-- Right Section: Interactive Logs Terminal -->
					<div class="monitor-logs">
						<div class="logs-card card">
							<div class="logs-header justify-between align-center">
								<h3 class="font-serif">Automation Logs</h3>
								<span class="log-mode font-serif">
									{globalState.apiKeys.useMockMode ? 'MOCK MODE' : 'LIVE API MODE'}
								</span>
							</div>

							<!-- Terminal Body -->
							<div class="terminal-body" bind:this={logsContainer}>
								{#each active.logs as log}
									<div class="log-row-msg {log.status}">
										<span class="timestamp">[{log.timestamp}]</span>
										<span class="step-badge">{log.step.toUpperCase()}</span>
										<span class="message">{log.message}</span>
									</div>
								{/each}
								
								{#if isGenerating}
									<div class="log-row-msg running pulse">
										<span class="timestamp">[{new Date().toLocaleTimeString()}]</span>
										<span class="step-badge">SYSTEM</span>
										<span class="message">Waiting for agent callback...</span>
									</div>
								{/if}
							</div>
						</div>

						<!-- Config Tip Alert -->
						{#if globalState.apiKeys.useMockMode}
							<div class="alert-tip font-serif">
								<p><Info size={13} class="alert-tip-icon" /> <strong>Running in Mock Mode:</strong> SvelteKit is simulating API outputs. You can wire real APIs by adding your Anthropic, Exa, and Kie.ai keys in the <a href="/settings">Settings panel</a>.</p>
							</div>
						{/if}
					</div>

				</div>
			</div>
		{/if}
	</main>
</div>

<style>
	.workspace-grid {
		display: grid;
		grid-template-columns: 280px 1fr;
		flex: 1;
		height: calc(100vh - 65px);
		overflow: hidden;
	}

	@media (max-width: 900px) {
		.workspace-grid {
			grid-template-columns: 1fr;
			height: auto;
			overflow: visible;
		}
	}

	/* Sidebar Library Styling */
	.sidebar-library {
		background-color: var(--bg-card);
		border-right: 1px solid var(--border-color);
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
	}

	.library-header {
		padding: 1.5rem;
		border-bottom: 1px solid var(--border-color);
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.library-header h3 {
		font-size: 1.1rem;
		font-weight: 600;
	}

	.library-header .count {
		font-size: 0.8rem;
		color: var(--text-muted);
		background-color: var(--accent-light);
		padding: 0.15rem 0.5rem;
		border-radius: 20px;
	}

	.library-list {
		display: flex;
		flex-direction: column;
		flex: 1;
		padding: 0.5rem;
		gap: 0.25rem;
	}

	.empty-library {
		padding: 2rem 1.5rem;
		text-align: center;
		color: var(--text-muted);
		font-style: italic;
	}

	.empty-library .small {
		font-size: 0.75rem;
		margin-top: 0.5rem;
	}

	.book-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.85rem 1rem;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		text-align: left;
		cursor: pointer;
		width: 100%;
		transition: var(--transition);
		position: relative;
	}

	.book-row:hover {
		background-color: var(--accent-light);
	}

	.book-row.active {
		background-color: var(--accent-light);
		border-color: var(--border-focus);
	}

	.book-row-icon {
		font-size: 1.25rem;
		display: flex;
		align-items: center;
		color: var(--accent);
	}

	.book-row-meta {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		flex: 1;
		overflow: hidden;
	}

	.book-row-title {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text-main);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.book-row-status {
		font-size: 0.75rem;
		text-transform: capitalize;
	}

	.book-row-status.completed { color: var(--success); }
	.book-row-status.failed { color: var(--error); }
	.book-row-status.idle { color: var(--text-muted); }
	.book-row-status:not(.completed):not(.failed):not(.idle) { color: var(--warning); }

	.btn-delete {
		background: transparent;
		border: none;
		color: var(--text-muted);
		cursor: pointer;
		display: none;
		position: absolute;
		right: 0.5rem;
		top: 50%;
		transform: translateY(-50%);
		width: 24px;
		height: 24px;
		align-items: center;
		justify-content: center;
		padding: 0;
	}

	.book-row:hover .btn-delete {
		display: flex;
	}

	.btn-delete:hover {
		color: var(--error);
	}

	/* Main Workspace Area */
	.main-workspace {
		background-color: var(--bg-page);
		padding: 2rem;
		overflow-y: auto;
		height: 100%;
	}

	@media (max-width: 900px) {
		.main-workspace {
			overflow-y: visible;
			height: auto;
			padding: 1rem;
		}
	}

	/* Create Form Styling */
	.create-workspace {
		max-width: 800px;
		margin: 0 auto;
		padding: 2.5rem;
	}

	.workspace-title {
		margin-bottom: 2rem;
		border-bottom: 1px solid var(--border-color);
		padding-bottom: 1rem;
	}

	.workspace-title h2 {
		font-size: 1.75rem;
	}

	.workspace-title p {
		color: var(--text-muted);
		margin-top: 0.25rem;
		font-size: 0.9rem;
	}

	.create-form {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.grid-2-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
	}

	.grid-3-col {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 1.5rem;
	}

	@media (max-width: 600px) {
		.grid-2-col, .grid-3-col {
			grid-template-columns: 1fr;
			gap: 1rem;
		}
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.form-group label {
		font-size: 0.85rem;
		font-weight: 600;
	}

	.parameters-section {
		border: 1px solid var(--border-color);
		background-color: var(--bg-inset);
		border-radius: var(--radius-md);
		padding: 1.5rem;
		margin-top: 0.5rem;
	}

	.parameters-section h4 {
		font-size: 1.05rem;
		margin-bottom: 1rem;
		color: var(--accent);
	}

	.parameters-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
		align-items: center;
	}

	@media (max-width: 600px) {
		.parameters-grid {
			grid-template-columns: 1fr;
			gap: 1rem;
		}
	}

	.check-group {
		grid-column: span 2;
		margin-top: 0.5rem;
	}

	@media (max-width: 600px) {
		.check-group {
			grid-column: span 1;
		}
	}

	/* Monitor Workspace Styling */
	.monitor-workspace {
		display: flex;
		flex-direction: column;
		gap: 2rem;
		height: 100%;
	}

	.monitor-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		border-bottom: 1.5px solid var(--border-color);
		padding-bottom: 1.5rem;
	}

	.monitor-title h2 {
		font-size: 1.75rem;
	}

	.monitor-title .meta {
		color: var(--text-muted);
		font-size: 0.9rem;
		margin-top: 0.25rem;
	}

	.completed-actions {
		display: flex;
		gap: 1rem;
	}

	.generating-badge {
		background-color: var(--accent-light);
		color: var(--accent);
		border: 1px solid var(--border-focus);
		padding: 0.6rem 1.2rem;
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-weight: 500;
		font-size: 0.9rem;
	}

	.monitor-grid {
		display: grid;
		grid-template-columns: 1.2fr 1fr;
		gap: 2rem;
		flex: 1;
		min-height: 0; /* Important for flex child scroll */
	}

	@media (max-width: 1000px) {
		.monitor-grid {
			grid-template-columns: 1fr;
			min-height: auto;
		}
	}

	.monitor-details, .monitor-logs {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.outline-card, .logs-card {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.outline-card h3, .logs-card h3 {
		font-size: 1.15rem;
		margin-bottom: 1.25rem;
		color: var(--text-main);
	}

	.empty-outline {
		padding: 3rem 1.5rem;
		text-align: center;
		color: var(--text-muted);
		font-style: italic;
	}

	.empty-outline .small {
		font-size: 0.8rem;
		margin-top: 0.5rem;
	}

	/* Timeline chapters list */
	.chapters-timeline {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		overflow-y: auto;
		padding-right: 0.5rem;
	}

	.chapter-item {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 1rem;
		border-radius: var(--radius-sm);
		background-color: var(--bg-page);
		border: 1px solid var(--border-color);
		transition: var(--transition);
	}

	.chapter-item.completed {
		border-left: 3px solid var(--success);
		background-color: var(--bg-card);
	}

	.chapter-item.writing, .chapter-item.verifying {
		border-left: 3px solid var(--warning);
		background-color: var(--bg-card);
	}

	.chapter-badge {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background-color: var(--accent-light);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: bold;
		font-size: 0.85rem;
	}

	.chapter-info {
		flex: 1;
	}

	.chapter-title {
		font-weight: 600;
		font-size: 0.95rem;
		color: var(--text-main);
	}

	.chapter-summary {
		font-size: 0.8rem;
		color: var(--text-muted);
		margin-top: 0.15rem;
		margin-bottom: 0;
	}

	.chapter-item-status {
		font-size: 0.8rem;
		font-weight: 500;
	}

	.chapter-item-status .status-check {
		color: var(--success);
	}

	.chapter-item-status .status-write {
		color: var(--warning);
	}

	.chapter-item-status .status-pending {
		color: var(--text-muted);
	}

	/* Terminal Logs */
	.log-mode {
		font-size: 0.75rem;
		background-color: var(--accent-light);
		color: var(--accent);
		padding: 0.2rem 0.6rem;
		border-radius: var(--radius-sm);
		font-weight: 600;
	}

	.terminal-body {
		background-color: var(--bg-inset);
		border: 1px solid var(--border-color);
		border-radius: var(--radius-sm);
		padding: 1rem;
		font-family: monospace;
		font-size: 0.8rem;
		color: var(--text-main);
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		height: 250px;
	}

	.log-row-msg {
		line-height: 1.4;
		border-bottom: 1px solid rgba(0,0,0,0.02);
		padding-bottom: 0.25rem;
	}

	:root[data-theme="dark"] .log-row-msg {
		border-bottom-color: rgba(255,255,255,0.02);
	}

	.log-row-msg .timestamp {
		color: var(--text-muted);
		margin-right: 0.5rem;
	}

	.log-row-msg .step-badge {
		font-weight: bold;
		margin-right: 0.5rem;
		padding: 0.05rem 0.25rem;
		border-radius: 2px;
		font-size: 0.7rem;
	}

	.log-row-msg.pending .step-badge { background-color: var(--border-color); color: var(--text-muted); }
	.log-row-msg.running .step-badge { background-color: var(--accent-light); color: var(--accent); }
	.log-row-msg.success .step-badge { background-color: var(--accent-light); color: var(--success); }
	.log-row-msg.error .step-badge { background-color: var(--accent-light); color: var(--error); }

	.log-row-msg.error .message {
		color: var(--error);
		font-weight: 600;
	}

	.alert-tip {
		background-color: var(--bg-card);
		border: 1px dashed var(--border-focus);
		padding: 1rem;
		border-radius: var(--radius-sm);
		margin-top: 1rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.alert-tip a {
		text-decoration: underline;
		font-weight: 600;
	}

	:global(.alert-tip-icon) {
		display: inline-block;
		vertical-align: middle;
		margin-right: 0.25rem;
		color: var(--accent);
	}

	:global(.spin) {
		animation: spin 1.2s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to   { transform: rotate(360deg); }
	}
</style>
