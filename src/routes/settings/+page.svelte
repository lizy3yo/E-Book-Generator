<script lang="ts">
	import { globalState } from '$lib/state.svelte';
	import type { ApiKeys } from '$lib/types';

	let showAnthropic = $state(false);
	let showExa = $state(false);
	let showImage = $state(false);

	let anthropicKey = $state(globalState.apiKeys.anthropicKey);
	let exaKey = $state(globalState.apiKeys.exaKey);
	let imageKey = $state(globalState.apiKeys.imageKey);
	let imageProvider = $state<ApiKeys['imageProvider']>(globalState.apiKeys.imageProvider);
	let useMockMode = $state(globalState.apiKeys.useMockMode);

	let message = $state('');
	let messageType = $state<'success' | 'error' | ''>('');

	function saveSettings() {
		globalState.saveKeys({
			anthropicKey,
			exaKey,
			imageKey,
			imageProvider,
			useMockMode
		});
		
		message = 'Configuration saved successfully!';
		messageType = 'success';

		setTimeout(() => {
			message = '';
			messageType = '';
		}, 3000);
	}
</script>

<svelte:head>
	<title>API Configuration - Ebook Automator</title>
</svelte:head>

<div class="container page-container">
	<div class="settings-header">
		<h2>System Configurations</h2>
		<p class="subtitle font-serif">Configure credentials for grounding and generative writing engines.</p>
	</div>

	{#if message}
		<div class="status-alert {messageType}">
			{message}
		</div>
	{/if}

	<div class="grid-layout">
		<!-- Left configuration form -->
		<div class="settings-card card">
			<h3>API Provider Keys</h3>
			<p class="description">API credentials are stored locally in your browser cache and are never shared or sent to any third-party analytics servers.</p>

			<form onsubmit={(e) => { e.preventDefault(); saveSettings(); }} class="form-grid">
				
				<!-- Mock Mode Toggle -->
				<div class="form-group mode-toggle-group">
					<div class="toggle-info">
						<label for="mock-mode" class="toggle-label font-serif">Simulated Generation (Mock Mode)</label>
						<span class="toggle-desc">Generate outlines, full chapters, and covers using instant simulated pipelines without needing API keys.</span>
					</div>
					<label class="switch">
						<input type="checkbox" id="mock-mode" bind:checked={useMockMode} />
						<span class="slider round"></span>
					</label>
				</div>

				<hr class="divider" />

				<!-- Anthropic key -->
				<div class="form-group">
					<div class="label-row">
						<label for="anthropic-key">Claude API Key (Anthropic)</label>
						<button type="button" class="btn-text" onclick={() => showAnthropic = !showAnthropic}>
							{showAnthropic ? 'Hide' : 'Show'}
						</button>
					</div>
					<input 
						id="anthropic-key" 
						type={showAnthropic ? 'text' : 'password'} 
						placeholder="sk-ant-..." 
						bind:value={anthropicKey}
						disabled={useMockMode}
					/>
					<span class="field-desc">Used for chapter drafting, structuring, and self-validation passes.</span>
				</div>

				<!-- Exa Key -->
				<div class="form-group">
					<div class="label-row">
						<label for="exa-key">Exa Search Key (Exa AI)</label>
						<button type="button" class="btn-text" onclick={() => showExa = !showExa}>
							{showExa ? 'Hide' : 'Show'}
						</button>
					</div>
					<input 
						id="exa-key" 
						type={showExa ? 'text' : 'password'} 
						placeholder="exa-api-key-..." 
						bind:value={exaKey}
						disabled={useMockMode}
					/>
					<span class="field-desc">Used to retrieve real statistics, grounding research text, and prevent LLM hallucinations.</span>
				</div>

				<hr class="divider" />

				<!-- Image provider selection -->
				<div class="form-group">
					<label for="image-provider">Image API Provider</label>
					<select id="image-provider" bind:value={imageProvider} disabled={useMockMode}>
						<option value="kie">Kie.ai (Text-to-Image covers & illustration)</option>
						<option value="69labs">69labs.vip (Visual cover layout & text overlay)</option>
					</select>
					<span class="field-desc">Choose the primary visual rendering engine.</span>
				</div>

				<!-- Image API Key -->
				<div class="form-group">
					<div class="label-row">
						<label for="image-key">Image API Key</label>
						<button type="button" class="btn-text" onclick={() => showImage = !showImage}>
							{showImage ? 'Hide' : 'Show'}
						</button>
					</div>
					<input 
						id="image-key" 
						type={showImage ? 'text' : 'password'} 
						placeholder="api-key-..." 
						bind:value={imageKey}
						disabled={useMockMode}
					/>
					<span class="field-desc">Credentials for your selected image rendering provider.</span>
				</div>

				<div class="form-actions">
					<button type="submit" class="btn btn-primary">Save Configurations</button>
				</div>

			</form>
		</div>

		<!-- Right Information/Help Panel -->
		<div class="info-panel font-serif">
			<div class="info-block">
				<h4>System Grounding Philosophy</h4>
				<p>By connecting SvelteKit server controllers directly to Anthropic Claude 3.5 and Exa AI, this platform operates on an industry-standard grounding loop:</p>
				<ol>
					<li><strong>Exa AI Search:</strong> Queries web indices semantically to locate highly relevant journals, statistics, and references.</li>
					<li><strong>Claude Outlining:</strong> Claude reads the title and user guidelines to form an outline.</li>
					<li><strong>Claude Drafting & Verification:</strong> Claude writes chapters by parsing research facts, and then executes a copy-editing self-fact-check pass.</li>
				</ol>
			</div>

			<div class="info-block" style="margin-top: 2rem;">
				<h4>Visual Rendering</h4>
				<p>To design covers and illustrations, the platform connects to Kie.ai and 69labs.vip. Adjustments like text overlays are rendered dynamically on an HTML5 Canvas, ensuring a professional, minimalist book finish.</p>
			</div>
		</div>
	</div>
</div>

<style>
	.page-container {
		max-width: 1100px;
		animation: fadeIn 0.4s ease-in-out;
	}

	@keyframes fadeIn {
		from { opacity: 0; transform: translateY(10px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.settings-header {
		margin-bottom: 2.5rem;
		border-bottom: 1.5px solid var(--border-color);
		padding-bottom: 1rem;
	}

	.settings-header h2 {
		font-size: 2rem;
		font-weight: 600;
	}

	.subtitle {
		color: var(--text-muted);
		font-style: italic;
		margin-top: 0.25rem;
	}

	.grid-layout {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		gap: 3rem;
	}

	@media (max-width: 900px) {
		.grid-layout {
			grid-template-columns: 1fr;
			gap: 2rem;
		}
	}

	.settings-card {
		padding: 2rem;
	}

	.settings-card h3 {
		font-size: 1.25rem;
		margin-bottom: 0.5rem;
	}

	.description {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: 2rem;
	}

	.form-grid {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.label-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	label {
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-main);
	}

	.btn-text {
		background: none;
		border: none;
		color: var(--accent);
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 500;
	}

	.btn-text:hover {
		color: var(--accent-hover);
		text-decoration: underline;
	}

	.field-desc {
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.divider {
		border: none;
		border-top: 1px solid var(--border-color);
		margin: 0.5rem 0;
	}

	.mode-toggle-group {
		flex-direction: row;
		justify-content: space-between;
		align-items: center;
		background-color: var(--bg-inset);
		padding: 1rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-color);
	}

	.toggle-info {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-width: 80%;
	}

	.toggle-label {
		font-weight: 600;
		color: var(--text-main);
		font-size: 0.95rem;
	}

	.toggle-desc {
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	/* Switch Slider styling */
	.switch {
		position: relative;
		display: inline-block;
		width: 46px;
		height: 24px;
	}

	.switch input {
		opacity: 0;
		width: 0;
		height: 0;
	}

	.slider {
		position: absolute;
		cursor: pointer;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--border-color);
		transition: .4s;
	}

	.slider:before {
		position: absolute;
		content: "";
		height: 18px;
		width: 18px;
		left: 3px;
		bottom: 3px;
		background-color: white;
		transition: .4s;
	}

	input:checked + .slider {
		background-color: var(--accent);
	}

	input:checked + .slider:before {
		transform: translateX(22px);
	}

	.slider.round {
		border-radius: 24px;
	}

	.slider.round:before {
		border-radius: 50%;
	}

	.form-actions {
		margin-top: 1rem;
	}

	.info-panel {
		background-color: var(--accent-light);
		padding: 2.2rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--border-color);
		height: fit-content;
	}

	.info-block h4 {
		font-size: 1.15rem;
		margin-bottom: 0.75rem;
		color: var(--accent);
	}

	.info-block p, .info-block ol {
		font-size: 0.9rem;
		color: var(--text-muted);
		line-height: 1.6;
	}

	.info-block ol {
		margin-left: 1.25rem;
		margin-top: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.status-alert {
		padding: 1rem;
		border-radius: var(--radius-sm);
		margin-bottom: 1.5rem;
		font-size: 0.9rem;
	}

	.status-alert.success {
		background-color: var(--accent-light);
		border: 1px solid var(--success);
		color: var(--success);
	}
</style>
