<script lang="ts">
	import { onMount } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import type { CoverSettings } from '$lib/types';

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

	function updateSetting<K extends keyof CoverSettings>(key: K, value: CoverSettings[K]) {
		if (globalState.activeBook) {
			const updated = { ...globalState.activeBook.coverSettings, [key]: value };
			globalState.updateCoverSettings(globalState.activeBookId!, updated);
		}
	}

	// Dynamic background image loader
	let bgImage: HTMLImageElement | null = null;
	function redrawCanvas() {
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const width = canvas.width;
		const height = canvas.height;

		// Clear canvas
		ctx.clearRect(0, 0, width, height);

		// 1. Draw background image or cream fallback
		if (settings.bgImageUrl) {
			if (!bgImage || bgImage.src !== settings.bgImageUrl) {
				bgImage = new Image();
				bgImage.crossOrigin = 'anonymous';
				bgImage.src = settings.bgImageUrl;
				bgImage.onload = () => {
					drawLayers(ctx, width, height);
				};
			} else {
				drawLayers(ctx, width, height);
			}
		} else {
			// Fallback: Cream paper background
			ctx.fillStyle = '#FAF7F2';
			ctx.fillRect(0, 0, width, height);
			
			// Draw simple vector shapes for placeholder
			ctx.strokeStyle = '#E6DDD0';
			ctx.lineWidth = 1;
			ctx.strokeRect(15, 15, width - 30, height - 30);
			
			// Abstract geometric placeholder
			ctx.fillStyle = '#EAE5D9';
			ctx.beginPath();
			ctx.arc(width / 2, height / 2.5, width / 5, 0, Math.PI * 2);
			ctx.fill();
			
			drawLayers(ctx, width, height);
		}
	}

	function drawLayers(ctx: CanvasRenderingContext2D, width: number, height: number) {
		// Draw background image if loaded
		if (settings.bgImageUrl && bgImage && bgImage.complete) {
			// Draw aspect fill
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

		try {
			const keys = globalState.apiKeys;
			const res = await fetch('/api/image', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prompt: settings.bgImagePrompt,
					apiKey: keys.imageKey,
					provider: keys.imageProvider,
					useMockMode: keys.useMockMode,
					isCover: true
				})
			});
			const data = await res.json();

			if (!data.success) {
				throw new Error(data.error || 'Failed to render image.');
			}

			updateSetting('bgImageUrl', data.imageUrl);
			addAssistantMessage("I've successfully generated and applied the new background art!");
		} catch (err: any) {
			console.error(err);
			addAssistantMessage(`Sorry, there was an issue rendering that cover: ${err.message || 'Unknown error.'}`);
		} finally {
			isGeneratingImage = false;
		}
	}

	function handleAssistantSubmit(e: Event) {
		e.preventDefault();
		if (!chatInput.trim()) return;

		const userMsg = chatInput.trim();
		chatMessages = [...chatMessages, { sender: 'user', text: userMsg }];
		chatInput = '';

		// Process assistant response back-and-forth
		processAssistantCommand(userMsg);
	}

	function addAssistantMessage(text: string) {
		chatMessages = [...chatMessages, { sender: 'assistant', text }];
	}

	// Lightweight local assistant command parser
	async function processAssistantCommand(msg: string) {
		const lowerMsg = msg.toLowerCase();
		
		// Simulate assistant thinking
		await new Promise(resolve => setTimeout(resolve, 800));

		// 1. Check for font changes
		if (lowerMsg.includes('font to') || lowerMsg.includes('change font')) {
			if (lowerMsg.includes('georgia')) {
				updateSetting('titleFont', 'Georgia');
				addAssistantMessage("Done! I have changed the font family to Georgia.");
				return;
			} else if (lowerMsg.includes('lora')) {
				updateSetting('titleFont', 'Lora');
				addAssistantMessage("Done! I have updated the font family to Lora.");
				return;
			} else if (lowerMsg.includes('inter') || lowerMsg.includes('sans')) {
				updateSetting('titleFont', 'Inter');
				addAssistantMessage("Done! Font updated to Inter.");
				return;
			} else if (lowerMsg.includes('arial')) {
				updateSetting('titleFont', 'Arial');
				addAssistantMessage("Done! Font changed to Arial.");
				return;
			}
		}

		// 2. Check for layout position changes
		if (lowerMsg.includes('layout') || lowerMsg.includes('position')) {
			if (lowerMsg.includes('top')) {
				updateSetting('textPosition', 'top');
				addAssistantMessage("I've shifted the title group to the top of the cover.");
				return;
			} else if (lowerMsg.includes('bottom')) {
				updateSetting('textPosition', 'bottom');
				addAssistantMessage("I've aligned the titles to the bottom of the cover.");
				return;
			} else if (lowerMsg.includes('middle') || lowerMsg.includes('center')) {
				updateSetting('textPosition', 'middle');
				addAssistantMessage("I've centered the titles vertically.");
				return;
			}
		}

		// 3. Check for text alignments
		if (lowerMsg.includes('align') || lowerMsg.includes('justification')) {
			if (lowerMsg.includes('left')) {
				updateSetting('alignment', 'left');
				addAssistantMessage("Aligned all text fields to the left margin.");
				return;
			} else if (lowerMsg.includes('right')) {
				updateSetting('alignment', 'right');
				addAssistantMessage("Aligned all text fields to the right margin.");
				return;
			} else if (lowerMsg.includes('center')) {
				updateSetting('alignment', 'center');
				addAssistantMessage("Centered all text fields horizontally.");
				return;
			}
		}

		// 4. Check for color changes
		if (lowerMsg.includes('title color to') || lowerMsg.includes('make title')) {
			if (lowerMsg.includes('gold') || lowerMsg.includes('yellow')) {
				updateSetting('titleColor', '#D4AF37');
				addAssistantMessage("Perfect. Title color updated to warm gold (#D4AF37).");
				return;
			} else if (lowerMsg.includes('red')) {
				updateSetting('titleColor', '#A84C4C');
				addAssistantMessage("Updated. Title color set to muted red (#A84C4C).");
				return;
			} else if (lowerMsg.includes('white')) {
				updateSetting('titleColor', '#FFFFFF');
				addAssistantMessage("Updated title color to paper white.");
				return;
			} else if (lowerMsg.includes('dark') || lowerMsg.includes('black') || lowerMsg.includes('charcoal')) {
				updateSetting('titleColor', '#242220');
				addAssistantMessage("Set title color back to deep charcoal ink.");
				return;
			}
		}

		// 5. Check for size adjustments
		if (lowerMsg.includes('title size') || lowerMsg.includes('make title larger') || lowerMsg.includes('make title smaller')) {
			const sizeMatch = lowerMsg.match(/\d+/);
			if (sizeMatch) {
				const size = parseInt(sizeMatch[0]);
				updateSetting('titleSize', size);
				addAssistantMessage(`I've set the title size to ${size}px.`);
				return;
			} else if (lowerMsg.includes('larger')) {
				updateSetting('titleSize', Math.min(settings.titleSize + 4, 60));
				addAssistantMessage(`Increased title size to ${settings.titleSize}px.`);
				return;
			} else if (lowerMsg.includes('smaller')) {
				updateSetting('titleSize', Math.max(settings.titleSize - 4, 18));
				addAssistantMessage(`Reduced title size to ${settings.titleSize}px.`);
				return;
			}
		}

		// 6. Check for image prompt requests
		if (lowerMsg.includes('generate') || lowerMsg.includes('make background') || lowerMsg.includes('image of') || lowerMsg.includes('draw')) {
			let newPrompt = msg;
			if (lowerMsg.startsWith('generate')) newPrompt = msg.substring(8).trim();
			updateSetting('bgImagePrompt', newPrompt);
			addAssistantMessage(`I've updated the image generation prompt to: "${newPrompt}". Generating the new artwork now...`);
			generateNewCoverArt();
			return;
		}

		// Fallback: Default to modifying the image prompt
		updateSetting('bgImagePrompt', msg);
		addAssistantMessage(`I've set your prompt as the active cover art goal: "${msg}". Initiating Kie.ai/69labs image generation pipeline...`);
		generateNewCoverArt();
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
								<div class="avatar font-serif">{msg.sender === 'assistant' ? '🤖' : '👤'}</div>
								<div class="text font-serif">{msg.text}</div>
							</div>
						{/each}
					</div>

					<form onsubmit={handleAssistantSubmit} class="chat-form flex gap-1">
						<input 
							type="text" 
							placeholder="Ask assistant to modify layout, fonts, colors, or images..." 
							bind:value={chatInput} 
							disabled={isGeneratingImage}
						/>
						<button type="submit" class="btn btn-primary" disabled={isGeneratingImage || !chatInput.trim()}>
							{#if isGeneratingImage}
								...
							{:else}
								Send
							{/if}
						</button>
					</form>
				</div>
			</div>

			<!-- Right: Canvas Book Cover Preview -->
			<div class="preview-column">
				<div class="canvas-wrapper card">
					<canvas 
						bind:this={canvas} 
						width="400" 
						height="600" 
						class="cover-canvas"
					></canvas>
					
					<div class="actions-row">
						<button 
							class="btn btn-secondary" 
							onclick={generateNewCoverArt}
							disabled={isGeneratingImage}
						>
							{#if isGeneratingImage}
								<span class="spinner"></span> Rendering Art...
							{:else}
								🔄 Regenerate Base Art
							{/if}
						</button>
						
						<button 
							class="btn btn-primary" 
							onclick={downloadCover}
							disabled={isGeneratingImage}
						>
							💾 Download Cover PNG
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

	.cover-canvas {
		border: 1px solid var(--border-color);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-lg);
		background-color: #FAF7F2;
		max-width: 100%;
		height: auto;
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
