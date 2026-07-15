<script lang="ts">
	import { onMount } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import type { CoverSettings } from '$lib/types';
	import { RefreshCw, Download, Bot, User, Check } from '@lucide/svelte';

	let canvas: HTMLCanvasElement | null = $state(null);
	let isGeneratingImage = $state(false);
	
	// Chat Assistant State
	let chatInput = $state('');
	let chatMessages = $state<{ sender: 'user' | 'assistant'; text: string }[]>([
		{
			sender: 'assistant',
			text: "Hello! I'm your Cover Design Assistant. Tell me how you'd like to refine your cover. You can type instructions like: \n- 'Change font to Georgia'\n- 'Make title color gold'\n- 'Change layout to bottom alignment'\n- Or prompt a new image like: 'Generate a dark forest illustration'"
		}
	]);

	// Fetch active book settings or use default mock settings
	let settings = $derived.by(() => {
		if (globalState.activeBook) {
			return globalState.activeBook.coverSettings;
		}
		// Default mock settings
		return {
			title: 'A Beautiful Ebook',
			subtitle: 'Exploring Creative Automation',
			author: 'Alex Mercer',
			titleColor: '#242220',
			subtitleColor: '#6E6860',
			authorColor: '#8E7453',
			titleSize: 32,
			subtitleSize: 16,
			authorSize: 18,
			titleFont: 'Lora' as const,
			alignment: 'center' as const,
			textPosition: 'middle' as const,
			bgImagePrompt: 'Abstract minimalist painting with warm colors',
			bgImageUrl: null,
			useUltraRealistic: false,
			overlayOpacity: 0.15
		};
	});

	// Trigger canvas redraw whenever settings change
	$effect(() => {
		if (canvas && settings) {
			redrawCanvas();
		}
	});

	// ── Cover variants (generated in the wizard Stage 2) ──────────────────
	let coverOptions = $derived(globalState.activeBook?.coverOptions ?? []);
	let selectedCoverIndex = $derived(globalState.activeBook?.selectedCoverIndex ?? null);

	/**
	 * Switch the active design to a different variant.
	 * Applies the chosen option's image + prompt to coverSettings,
	 * then redraws the canvas so the change is immediately visible.
	 */
	function activateVariant(index: number) {
		if (!globalState.activeBookId) return;
		globalState.selectCoverOption(globalState.activeBookId, index);
		// Clear the cached image so redrawCanvas fetches the new variant's URL
		bgImage    = null;
		bgImageSrc = '';
	}

	function updateSetting<K extends keyof CoverSettings>(key: K, value: CoverSettings[K]) {
		if (globalState.activeBook) {
			const updated = { ...globalState.activeBook.coverSettings, [key]: value };
			globalState.updateCoverSettings(globalState.activeBookId!, updated);
		}
	}

	// Dynamic background image loader
	let bgImage: HTMLImageElement | null = null;
	let bgImageSrc = '';   // tracks which URL is currently loaded

	let generateError = $state('');

	/**
	 * Return the URL to use for loading an image into the canvas.
	 * External URLs (http/https) are routed through the server-side proxy so
	 * the browser treats them as same-origin and allows canvas drawImage()
	 * without tainting the canvas.  Data URLs are used as-is.
	 */
	function canvasUrl(url: string): string {
		if (!url) return '';
		if (url.startsWith('data:')) return url;
		return `/api/proxy?url=${encodeURIComponent(url)}`;
	}

	function redrawCanvas() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const width  = canvas.width;
		const height = canvas.height;
		ctx.clearRect(0, 0, width, height);

		if (settings.bgImageUrl) {
			const src = canvasUrl(settings.bgImageUrl);
			if (!bgImage || bgImageSrc !== src) {
				bgImage   = new Image();
				bgImageSrc = src;
				// No crossOrigin needed — proxy serves same-origin
				bgImage.onload  = () => drawLayers(ctx, width, height);
				bgImage.onerror = () => {
					bgImage    = null;
					bgImageSrc = '';
					ctx.fillStyle = '#FAF7F2';
					ctx.fillRect(0, 0, width, height);
					drawLayers(ctx, width, height);
				};
				bgImage.src = src;
			} else {
				drawLayers(ctx, width, height);
			}
		} else {
			ctx.fillStyle = '#FAF7F2';
			ctx.fillRect(0, 0, width, height);
			ctx.strokeStyle = '#E6DDD0';
			ctx.lineWidth = 1;
			ctx.strokeRect(15, 15, width - 30, height - 30);
			ctx.fillStyle = '#EAE5D9';
			ctx.beginPath();
			ctx.arc(width / 2, height / 2.5, width / 5, 0, Math.PI * 2);
			ctx.fill();
			drawLayers(ctx, width, height);
		}
	}

	function drawLayers(ctx: CanvasRenderingContext2D, width: number, height: number) {
		// Draw background image if loaded
		if (settings.bgImageUrl && bgImage && bgImage.complete && bgImage.naturalWidth > 0) {
			const imgRatio = bgImage.width / bgImage.height;
			const canvasRatio = width / height;
			let sWidth = bgImage.width;
			let sHeight = bgImage.height;
			let sx = 0;
			let sy = 0;

			if (imgRatio > canvasRatio) {
				sWidth = bgImage.height * canvasRatio;
				sx = (bgImage.width - sWidth) / 2;
			} else {
				sHeight = bgImage.width / canvasRatio;
				sy = (bgImage.height - sHeight) / 2;
			}

			ctx.drawImage(bgImage, sx, sy, sWidth, sHeight, 0, 0, width, height);

			// If the active bgImageUrl is an AI-generated cover (either a saved
			// variant OR a newly regenerated image), treat it as a baked image and
			// skip all text overlays — the image already contains the full design.
			const isAiImage = settings.bgImageUrl.startsWith('http')
				|| settings.bgImageUrl.startsWith('data:image/');
			if (isAiImage) return;
		}

		// 2. Draw color overlay
		if (settings.overlayOpacity > 0) {
			ctx.fillStyle = `rgba(26, 21, 16, ${settings.overlayOpacity})`;
			ctx.fillRect(0, 0, width, height);
		}

		// 3. Draw border line
		ctx.strokeStyle = settings.bgImageUrl ? 'rgba(255,255,255,0.3)' : '#E6DDD0';
		ctx.lineWidth = 1.5;
		ctx.strokeRect(15, 15, width - 30, height - 30);

		// 4. Draw Typography
		ctx.textAlign = settings.alignment;
		
		// Text positioning calculations
		let x = width / 2;
		if (settings.alignment === 'left') x = 40;
		if (settings.alignment === 'right') x = width - 40;

		let titleY = height / 2 - 40;
		let subtitleY = height / 2 + 10;
		let authorY = height - 60;

		if (settings.textPosition === 'top') {
			titleY = 80;
			subtitleY = 130;
			authorY = height - 60;
		} else if (settings.textPosition === 'bottom') {
			titleY = height / 2 + 40;
			subtitleY = height / 2 + 90;
			authorY = 80;
		}

		// Helper to wrap text
		const wrapText = (text: string, xPos: number, yPos: number, fontSize: number, fontName: string, color: string, maxW: number) => {
			ctx.fillStyle = color;
			ctx.font = `600 ${fontSize}px ${fontName === 'Lora' || fontName === 'Georgia' ? 'Lora, Georgia' : 'Inter, sans-serif'}`;
			
			const words = text.split(' ');
			let line = '';
			let currentY = yPos;
			const lineHeight = fontSize * 1.35;

			for (let n = 0; n < words.length; n++) {
				const testLine = line + words[n] + ' ';
				const metrics = ctx.measureText(testLine);
				const testWidth = metrics.width;
				if (testWidth > maxW && n > 0) {
					ctx.fillText(line, xPos, currentY);
					line = words[n] + ' ';
					currentY += lineHeight;
				} else {
					line = testLine;
				}
			}
			ctx.fillText(line, xPos, currentY);
			return currentY + lineHeight;
		};

		// Draw Title
		const endTitleY = wrapText(
			settings.title, 
			x, 
			titleY, 
			settings.titleSize, 
			settings.titleFont, 
			settings.titleColor, 
			width - 80
		);

		// Draw Subtitle
		wrapText(
			settings.subtitle, 
			x, 
			settings.textPosition === 'top' ? endTitleY - 10 : subtitleY, 
			settings.subtitleSize, 
			settings.titleFont === 'Lora' ? 'Inter' : 'Lora', 
			settings.subtitleColor, 
			width - 80
		);

		// Draw Author
		ctx.font = `italic 500 ${settings.authorSize}px ${settings.titleFont === 'Lora' || settings.titleFont === 'Georgia' ? 'Lora, Georgia' : 'Inter, sans-serif'}`;
		ctx.fillStyle = settings.authorColor;
		ctx.fillText(settings.author, x, authorY);
	}

	async function generateNewCoverArt() {
		if (isGeneratingImage || !globalState.activeBookId) return;
		isGeneratingImage = true;
		generateError = '';

		try {
			const keys = globalState.apiKeys;
			const book = globalState.activeBook!;

			// Build a rich prompt — use the selected variant's stored prompt if available,
			// falling back to the generic bgImagePrompt or a book-specific construction.
			const selectedVariant = selectedCoverIndex !== null
				? coverOptions[selectedCoverIndex]
				: null;

			const storedPrompt = (selectedVariant?.prompt || settings.bgImagePrompt)?.trim();
			const isGenericPrompt = !storedPrompt
				|| storedPrompt === 'Abstract minimalist painting with warm colors';

			const prompt = isGenericPrompt
				? `A professional book cover background for "${book.title}" — ${book.genre} genre. ` +
				  `${book.subtitle ? `Subtitle: ${book.subtitle}. ` : ''}` +
				  `Style: atmospheric, editorial, high-quality illustration. ` +
				  `Cinematic lighting, rich detail, suitable for a published trade ebook.`
				: storedPrompt;

			const res = await fetch('/api/image', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt,
					apiKey: keys.imageKey,
					provider: keys.imageProvider,
					useMockMode: keys.useMockMode,
					isCover: true
				})
			});

			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Image generation failed.');

			// Clear cached image so redrawCanvas picks up the new URL
			bgImage    = null;
			bgImageSrc = '';

			// 1. Update coverSettings so the canvas redraws with the new image
			updateSetting('bgImageUrl', data.imageUrl);

			// 2. Write the new imageUrl back into the selected variant slot so the
			//    thumbnail in the Design Variants panel reflects the new generation.
			if (selectedCoverIndex !== null && coverOptions[selectedCoverIndex]) {
				globalState.replaceCoverOption(book.id, selectedCoverIndex, {
					...coverOptions[selectedCoverIndex],
					imageUrl: data.imageUrl
				});
			} else if (coverOptions.length > 0) {
				// No variant selected — update slot 0 as a sensible default
				globalState.replaceCoverOption(book.id, 0, {
					...coverOptions[0],
					imageUrl: data.imageUrl
				});
			}

			addAssistantMessage('New cover art generated and applied.');
		} catch (err: any) {
			console.error('[Cover] generateNewCoverArt error:', err);
			generateError = err.message || 'Image generation failed. Check your API key and try again.';
			addAssistantMessage(`Generation failed: ${generateError}`);
		} finally {
			isGeneratingImage = false;
		}
	}

	function handleAssistantSubmit(e: Event) {
		e.preventDefault();
		if (!chatInput.trim() || isProcessingChat) return;

		const userMsg = chatInput.trim();
		chatMessages = [...chatMessages, { sender: 'user', text: userMsg }];
		chatInput = '';

		processAssistantCommand(userMsg);
	}

	function addAssistantMessage(text: string) {
		chatMessages = [...chatMessages, { sender: 'assistant', text }];
	}

	let isProcessingChat = $state(false);

	/**
	 * Send the user's instruction to Claude via /api/cover-assistant.
	 * Claude returns a structured mutations object — we apply each field
	 * directly to coverSettings.  If bgImagePrompt is included, we also
	 * kick off a new image generation.
	 */
	async function processAssistantCommand(msg: string) {
		if (!globalState.activeBook) return;
		isProcessingChat = true;

		try {
			// Build a lightweight variant summary so Claude knows which slots exist
			const variants = coverOptions.map((opt, idx) => ({
				index: idx,
				style: opt.style,
				hasImage: !!opt.imageUrl
			}));

			const res = await fetch('/api/cover-assistant', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					instruction: msg,
					apiKey: globalState.apiKeys.anthropicKey,
					useMockMode: globalState.apiKeys.useMockMode,
					currentSettings: settings,
					bookTitle: globalState.activeBook.title,
					genre: globalState.activeBook.genre,
					variants
				})
			});

			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Assistant request failed.');

			const mutations = data.mutations as Record<string, unknown>;
			const hasImagePrompt = 'bgImagePrompt' in mutations && mutations.bgImagePrompt;

			// Apply typography / layout mutations
			const layoutKeys = [
				'titleFont', 'titleColor', 'subtitleColor', 'authorColor',
				'titleSize', 'subtitleSize', 'authorSize',
				'alignment', 'textPosition', 'overlayOpacity'
			];
			for (const key of layoutKeys) {
				if (key in mutations) {
					updateSetting(key as keyof typeof settings, mutations[key] as never);
				}
			}

			// If Claude identified a specific variant slot, activate it first so
			// the generated image lands in the right slot.
			if (typeof data.variantIndex === 'number' && globalState.activeBookId) {
				activateVariant(data.variantIndex);
			}

			addAssistantMessage(data.reply);

			// Trigger image generation after layout mutations are applied
			if (hasImagePrompt) {
				updateSetting('bgImagePrompt', mutations.bgImagePrompt as string);
				addAssistantMessage('Generating new cover art now…');
				await generateNewCoverArt();
			}

		} catch (err: any) {
			console.error('[Cover assistant]', err);
			addAssistantMessage(`Sorry, something went wrong: ${err.message || 'Unknown error.'}`);
		} finally {
			isProcessingChat = false;
		}
	}

	function downloadCover() {
		if (!canvas) return;
		
		// Create downscale temporary high quality anchor link
		const link = document.createElement('a');
		link.download = `${settings.title.toLowerCase().replace(/\s+/g, '_')}_cover.png`;
		link.href = canvas.toDataURL('image/png');
		link.click();
	}

	onMount(() => {
		if (canvas) {
			redrawCanvas();
		}
	});
</script>

<svelte:head>
	<title>Interactive Cover Studio - Ebook Automator</title>
</svelte:head>

<div class="container studio-container">
	<div class="studio-header">
		<h2>Interactive Cover Studio</h2>
		<p class="subtitle font-serif">Refine typography, compose color parameters, and run generative image rendering.</p>
	</div>

	{#if !globalState.activeBookId}
		<div class="card select-warning font-serif">
			<p>No active ebook selected in workspace.</p>
			<p class="small"><a href="/">Go to Write panel</a> to initialize or generate a book first.</p>
		</div>
	{:else}
		<div class="studio-grid">
			
			<!-- Left: Control Panels & Chat assistant -->
			<div class="controls-column">
				
				<!-- Cover Settings manual controls -->
				<div class="settings-panel card">
					<h3 class="font-serif">Layout & Style Controls</h3>
					
					<div class="control-row grid-2-col">
						<div class="form-group">
							<label for="font-family">Title Font</label>
							<select id="font-family" value={settings.titleFont} onchange={(e: Event) => updateSetting('titleFont', (e.target as HTMLSelectElement).value as any)}>
								<option value="Lora">Lora (Elegant Serif)</option>
								<option value="Georgia">Georgia (Classic Serif)</option>
								<option value="Inter">Inter (Minimalist Sans)</option>
								<option value="Arial">Arial (Standard Clean)</option>
							</select>
						</div>

						<div class="form-group">
							<label for="align">Alignment</label>
							<select id="align" value={settings.alignment} onchange={(e: Event) => updateSetting('alignment', (e.target as HTMLSelectElement).value as any)}>
								<option value="left">Left Justified</option>
								<option value="center">Centered</option>
								<option value="right">Right Justified</option>
							</select>
						</div>
					</div>

					<div class="control-row grid-2-col">
						<div class="form-group">
							<label for="placement">Title Placement</label>
							<select id="placement" value={settings.textPosition} onchange={(e: Event) => updateSetting('textPosition', (e.target as HTMLSelectElement).value as any)}>
								<option value="top">Top Segment</option>
								<option value="middle">Center Segment</option>
								<option value="bottom">Bottom Segment</option>
							</select>
						</div>

						<div class="form-group">
							<label for="overlay">Contrast Overlay Opacity</label>
							<div class="range-value-container">
								<input 
									id="overlay" 
									type="range" 
									min="0" 
									max="0.8" 
									step="0.05" 
									value={settings.overlayOpacity} 
									oninput={(e: Event) => updateSetting('overlayOpacity', parseFloat((e.target as HTMLInputElement).value))}
								/>
								<span>{Math.round(settings.overlayOpacity * 100)}%</span>
							</div>
						</div>
					</div>

					<div class="control-row grid-3-col">
						<div class="form-group">
							<label for="title-size">Title Size ({settings.titleSize}px)</label>
							<input 
								id="title-size" 
								type="range" 
								min="18" 
								max="54" 
								value={settings.titleSize} 
								oninput={(e: Event) => updateSetting('titleSize', parseInt((e.target as HTMLInputElement).value))}
							/>
						</div>
						<div class="form-group">
							<label for="subtitle-size">Subtitle Size ({settings.subtitleSize}px)</label>
							<input 
								id="subtitle-size" 
								type="range" 
								min="12" 
								max="28" 
								value={settings.subtitleSize} 
								oninput={(e: Event) => updateSetting('subtitleSize', parseInt((e.target as HTMLInputElement).value))}
							/>
						</div>
						<div class="form-group">
							<label for="author-size">Author Size ({settings.authorSize}px)</label>
							<input 
								id="author-size" 
								type="range" 
								min="12" 
								max="32" 
								value={settings.authorSize} 
								oninput={(e: Event) => updateSetting('authorSize', parseInt((e.target as HTMLInputElement).value))}
							/>
						</div>
					</div>

					<div class="control-row grid-3-col" style="margin-top: 0.5rem;">
						<div class="form-group">
							<label for="color-title">Title Ink</label>
							<input 
								id="color-title" 
								type="color" 
								value={settings.titleColor} 
								oninput={(e: Event) => updateSetting('titleColor', (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="form-group">
							<label for="color-sub">Subtitle Ink</label>
							<input 
								id="color-sub" 
								type="color" 
								value={settings.subtitleColor} 
								oninput={(e: Event) => updateSetting('subtitleColor', (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="form-group">
							<label for="color-auth">Author Ink</label>
							<input 
								id="color-auth" 
								type="color" 
								value={settings.authorColor} 
								oninput={(e: Event) => updateSetting('authorColor', (e.target as HTMLInputElement).value)}
							/>
						</div>
					</div>
				</div>

				<!-- Interactive back-and-forth chat panel -->
				<div class="assistant-chat-panel card">
					<h3 class="font-serif">Cover Studio Assistant</h3>
					<div class="chat-viewport">
						{#each chatMessages as msg}
							<div class="chat-bubble {msg.sender}">
								<div class="avatar">
									{#if msg.sender === 'assistant'}
										<Bot size={16} />
									{:else}
										<User size={16} />
									{/if}
								</div>
								<div class="text font-serif">{msg.text}</div>
							</div>
						{/each}
					</div>

					<form onsubmit={handleAssistantSubmit} class="chat-form flex gap-1">
						<input 
							type="text" 
							placeholder="Ask assistant to modify layout, fonts, colors, or images..." 
							bind:value={chatInput} 
							disabled={isGeneratingImage || isProcessingChat}
						/>
						<button type="submit" class="btn btn-primary" disabled={isGeneratingImage || isProcessingChat || !chatInput.trim()}>
							{#if isProcessingChat || isGeneratingImage}
								…
							{:else}
								Send
							{/if}
						</button>
					</form>
				</div>
			</div>

			<!-- Right: Canvas Book Cover Preview -->
			<div class="preview-column">

				<!-- ── Design Variants ─────────────────────────────────────────── -->
				{#if coverOptions.length > 0}
					<div class="variants-panel card">
						<div class="variants-header">
							<h3 class="font-serif">Design Variants</h3>
							<span class="variants-hint font-serif">Click a variant to select it, then hit Regenerate to generate or switch designs</span>
						</div>
						<div class="variants-grid">
							{#each coverOptions as opt, idx}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
								<div
									class="variant-thumb {selectedCoverIndex === idx ? 'active' : ''} {!opt.imageUrl ? 'ungenerated' : ''}"
									role="button"
									tabindex="0"
									onclick={() => activateVariant(idx)}
									onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateVariant(idx); } }}
									title={opt.imageUrl ? `Switch to: ${opt.style}` : `Select ${opt.style} then click Regenerate`}
								>
									<div class="variant-img-wrap">
										{#if opt.imageUrl}
											<img src={opt.imageUrl} alt={opt.style} />
										{:else}
											<div class="variant-empty">
												{#if selectedCoverIndex === idx}
													<span class="variant-empty-label">Selected — click<br/>Regenerate to generate</span>
												{:else}
													<span class="variant-empty-label">Select to generate</span>
												{/if}
											</div>
										{/if}
										{#if selectedCoverIndex === idx && opt.imageUrl}
											<div class="variant-active-badge" aria-label="Active design">
												<Check size={11} strokeWidth={3} />
											</div>
										{/if}
									</div>
									<span class="variant-label font-serif">{opt.style}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Canvas Book Cover Preview -->
				<div class="canvas-wrapper card">
					<canvas 
						bind:this={canvas} 
						width="400" 
						height="600" 
						class="cover-canvas"
					></canvas>

					{#if generateError}
						<p class="generate-error" role="alert">{generateError}</p>
					{/if}
					
					<div class="actions-row">
						<button 
							class="btn btn-secondary" 
							onclick={generateNewCoverArt}
							disabled={isGeneratingImage}
						>
							{#if isGeneratingImage}
								<span class="spinner"></span> Rendering Art...
							{:else}
								<RefreshCw size={15} /> Regenerate Base Art
							{/if}
						</button>
						
						<button 
							class="btn btn-primary" 
							onclick={downloadCover}
							disabled={isGeneratingImage}
						>
							<Download size={15} /> Download Cover PNG
						</button>
					</div>
				</div>
			</div>

		</div>
	{/if}
</div>

<style>
	.studio-container {
		max-width: 1200px;
		animation: fadeIn 0.4s ease-in-out;
	}

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.studio-header {
		margin-bottom: 2.5rem;
		border-bottom: 1.5px solid var(--border-color);
		padding-bottom: 1rem;
	}

	.studio-header h2 {
		font-size: 2rem;
		font-weight: 600;
	}

	.select-warning {
		text-align: center;
		padding: 4rem 2rem;
		color: var(--text-muted);
		font-style: italic;
	}

	.select-warning a {
		text-decoration: underline;
		font-weight: 600;
	}

	.studio-grid {
		display: grid;
		grid-template-columns: 1.3fr 1fr;
		gap: 2.5rem;
		align-items: start;
	}

	@media (max-width: 900px) {
		.studio-grid {
			grid-template-columns: 1fr;
			gap: 2rem;
		}
	}

	.controls-column {
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.settings-panel h3, .assistant-chat-panel h3 {
		font-size: 1.15rem;
		margin-bottom: 1.25rem;
		color: var(--text-main);
	}

	.control-row {
		margin-bottom: 1.25rem;
	}

	.grid-2-col {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.grid-3-col {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 1rem;
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

	.range-value-container {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.range-value-container input[type="range"] {
		flex: 1;
	}

	.range-value-container span {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-muted);
		width: 32px;
	}

	input[type="color"] {
		padding: 0.2rem;
		height: 38px;
		cursor: pointer;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-color);
	}

	/* Assistant Chat Styling */
	.assistant-chat-panel {
		display: flex;
		flex-direction: column;
		height: 400px;
	}

	.chat-viewport {
		flex: 1;
		overflow-y: auto;
		border: 1px solid var(--border-color);
		background-color: var(--bg-inset);
		border-radius: var(--radius-sm);
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.chat-bubble {
		display: flex;
		gap: 0.75rem;
		max-width: 85%;
		align-self: flex-start;
	}

	.chat-bubble.user {
		align-self: flex-end;
		flex-direction: row-reverse;
	}

	.chat-bubble .avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background-color: var(--bg-card);
		border: 1px solid var(--border-color);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1.1rem;
		flex-shrink: 0;
	}

	.chat-bubble.user .avatar {
		background-color: var(--accent-light);
		border-color: var(--border-focus);
	}

	.chat-bubble .text {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-md);
		background-color: var(--bg-card);
		border: 1px solid var(--border-color);
		font-size: 0.88rem;
		color: var(--text-main);
		line-height: 1.45;
		white-space: pre-line;
		box-shadow: var(--shadow-sm);
	}

	.chat-bubble.user .text {
		background-color: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.chat-form input {
		flex: 1;
	}

	/* Canvas Preview Area */
	.preview-column {
		position: sticky;
		top: 85px;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	@media (max-width: 900px) {
		.preview-column {
			position: static;
		}
	}

	.canvas-wrapper {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1.5rem;
		padding: 2rem;
	}

	/* ── Design Variants panel ─────────────────────────────────────────── */
	.variants-panel {
		padding: 1.25rem 1.5rem;
	}

	.variants-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 1rem;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.variants-header h3 {
		font-size: 1rem;
		font-weight: 600;
		margin: 0;
	}

	.variants-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-style: italic;
	}

	.variants-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.75rem;
	}

	.variant-thumb {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		cursor: pointer;
		border-radius: var(--radius-sm);
		padding: 0.35rem;
		border: 2px solid transparent;
		transition: border-color 0.18s ease, box-shadow 0.18s ease;
	}

	.variant-thumb:hover {
		border-color: var(--border-focus);
	}

	.variant-thumb.active {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}

	/* Ungenerated variant selected as generation target */
	.variant-thumb.ungenerated.active {
		border-style: dashed;
		border-color: var(--accent);
		box-shadow: none;
	}

	.variant-thumb.ungenerated:hover {
		border-color: var(--accent);
		opacity: 0.85;
	}

	.variant-img-wrap {
		position: relative;
		width: 100%;
		aspect-ratio: 2 / 3;
		border-radius: 2px;
		overflow: hidden;
		background-color: var(--bg-inset);
	}

	.variant-img-wrap img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		transition: transform 0.2s ease;
	}

	.variant-thumb:hover .variant-img-wrap img {
		transform: scale(1.03);
	}

	.variant-empty {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		background: var(--bg-inset);
	}

	.variant-empty-label {
		font-family: var(--font-sans, sans-serif);
		font-size: 0.6rem;
		color: var(--text-muted);
		text-align: center;
		padding: 0 0.25rem;
		line-height: 1.3;
	}

	.variant-active-badge {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background-color: var(--accent);
		color: #fff;
		font-size: 0.7rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 1px 4px rgba(0,0,0,0.25);
	}

	.variant-label {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-muted);
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.variant-thumb.active .variant-label {
		color: var(--accent);
	}

	.cover-canvas {
		border: 1px solid var(--border-color);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-lg);
		background-color: #FAF7F2;
		max-width: 100%;
		height: auto;
	}

	.generate-error {
		width: 100%;
		font-family: var(--font-sans, sans-serif);
		font-size: 0.8rem;
		color: #B91C1C;
		background: #FEF2F2;
		border: 1px solid #FECACA;
		border-radius: 6px;
		padding: 0.55rem 0.85rem;
		margin: 0;
		text-align: center;
	}

	.actions-row {
		display: flex;
		width: 100%;
		gap: 1rem;
		justify-content: center;
	}

	@media (max-width: 480px) {
		.actions-row {
			flex-direction: column;
			gap: 0.5rem;
		}
		
		.actions-row button {
			width: 100%;
		}
	}
</style>
