<script lang="ts">
	import { tick } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import { parseMarkdown } from '$lib/diagrams';
	import { X, Sparkles, Palette, Eye, Check, FileText, BarChart3 } from '@lucide/svelte';

	let { editTarget, activeBook, onClose, onSave } = $props<{
		editTarget: {
			chapterId: string;
			chapterTitle: string;
			chapterOrder: number;
			chapterSummary: string;
			chapterContent: string;
			diagramIndex: number;
			diagramRaw: string;
		};
		activeBook: any;
		onClose: () => void;
		onSave: (updatedContent: string, newRaw: string) => void;
	}>();

	// ── State variables ────────────────────────────────────────────────────────
	let editInstruction = $state('');
	let isEditing = $state(false);
	let editSuccess = $state(false);
	let editError = $state('');
	let originalRaw = $state('');
	let tableColor = $state('#C9A84C');

	function isMarkdownTable(raw: string): boolean {
		const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
		if (lines.length < 2) return false;
		if (!lines[0].startsWith('|') || !lines[1].startsWith('|')) return false;
		return lines[1].replace(/[\s|:\-]/g, '') === '';
	}

	// Manual color pickers for the active diagram (color1–color6)
	let diagramColors = $state<string[]>(['', '', '', '', '', '']);
	// Manual field overrides (title, subtitle, labels, values, steps, nodes, etc.)
	let diagramFields = $state<Record<string, string>>({});

	// Seed state on mount/change of editTarget
	$effect(() => {
		if (editTarget) {
			const raw = editTarget.diagramRaw || '';
			originalRaw = raw;
			const fields = parseDiagramRawToFields(raw);
			const seedColors: string[] = ['', '', '', '', '', ''];
			for (let i = 0; i < 6; i++) {
				if (fields[`color${i + 1}`]) {
					seedColors[i] = fields[`color${i + 1}`];
					delete fields[`color${i + 1}`];
				}
			}
			diagramColors = seedColors;
			diagramFields = fields;
			tableColor = '#C9A84C';
			editInstruction = '';
			editSuccess = false;
			editError = '';
		}
	});

	// ── Live Preview ──────────────────────────────────────────────────────────
	// Build raw content reactively from the state of manual inputs
	let liveRaw = $derived(isMarkdownTable(originalRaw) ? originalRaw : buildDiagramRawFromFields(diagramFields, diagramColors));
	// Render to HTML reactively
	let liveHtml = $derived(isMarkdownTable(originalRaw)
		? parseMarkdown(liveRaw, editTarget.chapterId)
		: parseMarkdown('```diagram\n' + liveRaw + '\n```', editTarget.chapterId));

	// ── Helper functions ───────────────────────────────────────────────────────
	function parseDiagramRawToFields(raw: string): Record<string, string> {
		const fields: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			if (trimmed.startsWith('-')) {
				fields['nodes'] = (fields['nodes'] ? fields['nodes'] + '\n' : '') + trimmed;
				continue;
			}
			const ci = trimmed.indexOf(':');
			if (ci === -1) continue;
			const key = trimmed.substring(0, ci).trim().toLowerCase();
			const val = trimmed.substring(ci + 1).trim();
			if (key) fields[key] = val;
		}
		return fields;
	}

	function buildDiagramRawFromFields(fields: Record<string, string>, colors: string[]): string {
		const lines: string[] = [];
		// Emit type, title, subtitle first
		const orderedKeys = ['type', 'title', 'subtitle'];
		for (const k of orderedKeys) {
			if (fields[k] !== undefined) lines.push(`${k}: ${fields[k]}`);
		}
		// Emit colors
		for (let i = 0; i < 6; i++) {
			if (colors[i] && colors[i].trim()) {
				lines.push(`color${i + 1}: ${colors[i].trim()}`);
			}
		}
		// Emit remaining fields
		const skip = new Set([...orderedKeys, 'nodes', 'color1', 'color2', 'color3', 'color4', 'color5', 'color6']);
		for (const [k, v] of Object.entries(fields)) {
			if (skip.has(k)) continue;
			lines.push(`${k}: ${v}`);
		}
		// Emit nodes
		if (fields['nodes']) {
			for (const nodeLine of fields['nodes'].split('\n')) {
				if (nodeLine.trim()) lines.push(nodeLine.trim());
			}
		}
		return lines.join('\n');
	}

	function spliceDiagramBlock(chapterContent: string, index: number, newRaw: string): string {
		const re = /```(diagram|mermaid)\r?\n([\s\S]*?)```/g;
		let i = 0;
		let m: RegExpExecArray | null;
		let result = chapterContent;
		let offset = 0;
		const src = chapterContent;
		const resetRe = /```(diagram|mermaid)\r?\n([\s\S]*?)```/g;
		while ((m = resetRe.exec(src)) !== null) {
			if (i === index) {
				const before = result.substring(0, m.index + offset);
				const after = result.substring(m.index + offset + m[0].length);
				const fenceType = m[1];
				result = before + '```' + fenceType + '\n' + newRaw + '\n```' + after;
				return result;
			}
			i++;
		}
		return chapterContent;
	}

	// ── Actions ────────────────────────────────────────────────────────────────
	async function applyDiagramAIEdit() {
		if (!editInstruction.trim() || isEditing) return;
		isEditing = true;
		editSuccess = false;
		editError = '';

		try {
			const tableMode = isMarkdownTable(originalRaw);
			const diagramSystemPrompt = tableMode
				? `You are a professional editorial assistant.
Your task is to revise a markdown table based on the user instruction.
Rules:
- Return ONLY the table content.
- Preserve the table structure unless the instruction asks otherwise.
- Keep the output as a clean markdown table.`
				: `You are a professional data visualisation expert and diagram designer.
Your task is to revise a custom diagram code block based on the user instruction.
Rules:
- Return ONLY the diagram code block content (lines between the \`\`\`diagram fences — no fences, no extra commentary).
- Preserve key names (type, title, subtitle, labels, values, color1–color6, etc.) unless the instruction says to change them.
- If the user asks for specific colours, write them as hex values (e.g. #FF6B6B) in color1, color2, ... fields.
- Keep it concise — every line is "key: value" or a node line starting with -`;
			const tableHint = tableMode ? `\nPreferred table color: ${tableColor}` : '';

			const res = await fetch('/api/edit', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'edit-page',
					apiKey: globalState.apiKeys.anthropicKey,
					useMockMode: globalState.apiKeys.useMockMode,
					bookTitle: activeBook.title,
					genre: activeBook.genre,
					tone: activeBook.tone,
					chapterTitle: editTarget.chapterTitle,
					chapterOrder: editTarget.chapterOrder,
					chapterContent: originalRaw ?? '',
					pageContent: originalRaw ?? '',
					editInstruction: `${diagramSystemPrompt}${tableHint}\n\nUser instruction: ${editInstruction.trim()}`,
					researchNotes: ''
				})
			});

			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Diagram AI edit failed');

			let newRaw = (data.pageContent || data.content || '').trim();
			newRaw = newRaw.replace(/^```(?:diagram|mermaid)?\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();

			const updatedContent = tableMode
				? editTarget.chapterContent.replace(originalRaw, newRaw)
				: spliceDiagramBlock(editTarget.chapterContent, editTarget.diagramIndex, newRaw);

			// Write back content to state
			globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');

			// Update local view fields/colors
			const newFields = parseDiagramRawToFields(newRaw);
			const newColors: string[] = ['', '', '', '', '', ''];
			for (let ci = 0; ci < 6; ci++) {
				if (newFields[`color${ci + 1}`]) {
					newColors[ci] = newFields[`color${ci + 1}`];
					delete newFields[`color${ci + 1}`];
				}
			}
				diagramColors = newColors;
				diagramFields = newFields;
			editInstruction = '';
			editSuccess = true;

			// Trigger parent callback
			onSave(updatedContent, newRaw);

		} catch (err: any) {
			editError = err.message || 'An unexpected error occurred.';
		} finally {
			isEditing = false;
		}
	}

	function applyDiagramManualEdit() {
		if (isEditing) return;
		editSuccess = false;
		editError = '';

		try {
			const newRaw = buildDiagramRawFromFields(diagramFields, diagramColors);
			const updatedContent = spliceDiagramBlock(editTarget.chapterContent, editTarget.diagramIndex, newRaw);

			// Write back content to state
			globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
			originalRaw = newRaw;
			editSuccess = true;

			// Trigger parent callback
			onSave(updatedContent, newRaw);
		} catch (err: any) {
			editError = err.message || 'Failed to apply manual changes.';
		}
	}
</script>

<!-- Drawer Container -->
<div class="edit-drawer-container">
	<!-- Backdrop -->
	<div class="edit-backdrop" aria-hidden="true" onclick={onClose}></div>

	<!-- Main Drawer Box -->
	<div class="edit-drawer diagram-drawer" role="dialog" aria-modal="true" aria-label="Diagram Editor">
		<!-- Header -->
		<div class="edit-drawer__header">
			<div class="edit-drawer__title-row">
				<span class="edit-drawer__scope-badge edit-drawer__scope-badge--diagram">
					<BarChart3 size={11} /> Diagram Editor
				</span>
				<h3 class="edit-drawer__title font-serif">
					Edit Diagram · Ch. {editTarget.chapterOrder}
				</h3>
			</div>
			<p class="edit-drawer__subtitle font-serif">{editTarget.chapterTitle}</p>
			<button class="edit-drawer__close" onclick={onClose} aria-label="Close editor"><X size={18} /></button>
		</div>

		<!-- Body -->
		<div class="edit-drawer__body-grid">
			<!-- Left Column: Controls -->
			<div class="diagram-drawer__controls">
				<div class="edit-drawer__context">
					<p class="edit-drawer__hint">Use AI to transform this {isMarkdownTable(originalRaw) ? 'table' : 'diagram'} or edit its details directly below. Changes are applied instantly.</p>
				</div>

				{#if isMarkdownTable(originalRaw)}
					<!-- AI Prompt -->
					<div class="diagram-editor__field-group">
						<label class="edit-drawer__label" for="diag-table-instruction"><Sparkles size={13} /> AI Edit Table</label>
						<div class="diagram-editor__ai-row">
							<textarea
								id="diag-table-instruction"
								class="edit-drawer__textarea font-serif"
								placeholder='e.g. "Shorten the labels" or "Use a cleaner executive style"'
								rows={3}
								bind:value={editInstruction}
								disabled={isEditing}
							></textarea>
						</div>
					</div>

					<!-- Color Settings -->
					<div class="diagram-editor__section">
						<div class="diagram-editor__section-title"><Palette size={13} /> Table Color</div>
						<div class="diagram-editor__color-row diagram-editor__color-row--table">
							<input
								type="color"
								id="diag-table-color"
								class="diagram-editor__color-wheel"
								value={tableColor}
								onchange={(ev) => {
									tableColor = ev.currentTarget.value;
								}}
								disabled={isEditing}
							/>
							<input
								type="text"
								class="diagram-editor__color-hex"
								placeholder="#C9A84C"
								value={tableColor}
								oninput={(ev) => {
									tableColor = ev.currentTarget.value;
								}}
								disabled={isEditing}
							/>
						</div>
					</div>
				{:else}
					<!-- AI Prompt -->
					<div class="diagram-editor__field-group">
						<label class="edit-drawer__label" for="diag-ai-instruction"><Sparkles size={13} /> AI Edit Diagram</label>
						<div class="diagram-editor__ai-row">
							<textarea
								id="diag-ai-instruction"
								class="edit-drawer__textarea font-serif"
								placeholder='e.g. "Convert to a Donut Chart" or "Use sunset orange and deep navy colors"'
								rows={3}
								bind:value={editInstruction}
								disabled={isEditing}
							></textarea>
							{#if editInstruction.trim()}
								<button
									class="diagram-editor__ai-btn"
									onclick={applyDiagramAIEdit}
									disabled={isEditing}
								>
									{#if isEditing}
										<span class="spinner"></span>
									{:else}
										Apply AI Edit
									{/if}
								</button>
							{/if}
						</div>
					</div>

					<!-- Color Settings -->
					<div class="diagram-editor__section">
						<div class="diagram-editor__section-title"><Palette size={13} /> Color Customizer</div>
						<div class="diagram-editor__colors">
							{#each diagramColors as color, i}
								<div class="diagram-editor__color-item">
									<label class="diagram-editor__color-label" for="diag-color-{i}">Color {i + 1}</label>
									<div class="diagram-editor__color-row">
										<input
											type="color"
											id="diag-color-{i}"
											class="diagram-editor__color-wheel"
											value={color || '#C9A84C'}
											onchange={(ev) => {
												diagramColors = diagramColors.map((c, ci) => ci === i ? ev.currentTarget.value : c);
												applyDiagramManualEdit();
											}}
											disabled={isEditing}
										/>
										<input
											type="text"
											class="diagram-editor__color-hex"
											placeholder="#C9A84C"
											value={color}
											oninput={(ev) => {
												diagramColors = diagramColors.map((c, ci) => ci === i ? ev.currentTarget.value : c);
												applyDiagramManualEdit();
											}}
											disabled={isEditing}
										/>
										{#if color}
											<button
												class="diagram-editor__color-clear"
												title="Clear color"
												onclick={() => {
													diagramColors = diagramColors.map((c, ci) => ci === i ? '' : c);
													applyDiagramManualEdit();
												}}
												disabled={isEditing}
											><X size={12} /></button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					</div>

					<!-- Fields Settings -->
					<div class="diagram-editor__section">
						<div class="diagram-editor__section-title"><FileText size={13} /> Diagram Details</div>
						{#each Object.entries(diagramFields) as [key, val]}
							<div class="diagram-editor__field">
								<label class="diagram-editor__field-label" for="diag-field-{key}">{key}</label>
								{#if key === 'nodes'}
									<textarea
										id="diag-field-{key}"
										class="diagram-editor__field-input diagram-editor__field-textarea"
										rows={4}
										value={val}
										oninput={(ev) => {
											diagramFields = { ...diagramFields, [key]: ev.currentTarget.value };
											applyDiagramManualEdit();
										}}
										disabled={isEditing}
									></textarea>
								{:else}
									<input
										type="text"
										id="diag-field-{key}"
										class="diagram-editor__field-input"
										value={val}
										oninput={(ev) => {
											diagramFields = { ...diagramFields, [key]: ev.currentTarget.value };
											applyDiagramManualEdit();
										}}
										disabled={isEditing}
									/>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Right Column: Live Preview -->
			<div class="diagram-drawer__preview-panel">
				<div class="diagram-editor__section-title"><Eye size={13} /> Live Paginator Preview</div>
				<div class="diagram-drawer__preview-box" style={isMarkdownTable(originalRaw) ? `--r-table-header-bg: ${tableColor};` : ''}>
					<div class="chapter-body">
						{@html liveHtml}
					</div>
				</div>
			</div>
		</div>

		<!-- Footer status messages -->
		<div class="edit-drawer__footer">
			{#if editError}
				<p class="edit-drawer__error" role="alert">{editError}</p>
			{/if}
			{#if editSuccess}
				<p class="edit-drawer__success" role="status"><Check size={14} /> Diagram updated successfully.</p>
			{/if}
			{#if isMarkdownTable(originalRaw)}
				<div class="edit-drawer__actions">
					<button class="edit-drawer__cancel" onclick={onClose} disabled={isEditing}>Cancel</button>
					<button class="edit-drawer__apply" onclick={applyDiagramAIEdit} disabled={isEditing || !editInstruction.trim()}>
						{#if isEditing}
							<span class="spinner"></span>
							Applying…
						{:else}
							<Sparkles size={13} /> Apply Edit
						{/if}
					</button>
				</div>
			{:else}
				<button class="edit-drawer__cancel" onclick={onClose} disabled={isEditing}>Close Editor</button>
			{/if}
		</div>
	</div>
</div>

<style>
	/* Backdrop styles */
	.edit-backdrop {
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 100vh;
		background: rgba(26, 21, 16, 0.4);
		backdrop-filter: blur(4px);
		z-index: 1000;
	}

	/* Drawer positioning & layout */
	.edit-drawer-container {
		position: fixed;
		top: 0;
		right: 0;
		width: 100vw;
		height: 100vh;
		z-index: 1001;
		display: flex;
		justify-content: flex-end;
	}

	.diagram-drawer {
		width: 85vw;
		max-width: 1100px;
		height: 100vh;
		background: var(--surface, #FAFAF8);
		border-left: 1px solid var(--border, #E5DFD3);
		box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
		display: flex;
		flex-direction: column;
		animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
		z-index: 1002;
	}

	@keyframes slideIn {
		from { transform: translateX(100%); }
		to { transform: translateX(0); }
	}

	/* Header styles */
	.edit-drawer__header {
		padding: 1.25rem 1.75rem;
		border-bottom: 1px solid var(--border, #E5DFD3);
		position: relative;
	}

	.edit-drawer__title-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.25rem;
	}

	.edit-drawer__scope-badge--diagram {
		background: #EFF6FF;
		color: #1D4ED8;
		border: 1px solid #BFDBFE;
		padding: 0.2rem 0.5rem;
		border-radius: 4px;
		font-family: var(--font-sans);
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}

	.edit-drawer__title {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		color: var(--text, #2B2927);
	}

	.edit-drawer__subtitle {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted, #6E6860);
	}

	.edit-drawer__close {
		position: absolute;
		top: 1.25rem;
		right: 1.5rem;
		background: transparent;
		border: none;
		font-size: 1.1rem;
		color: var(--text-muted, #6E6860);
		cursor: pointer;
		padding: 0.25rem;
	}
	.edit-drawer__close:hover { color: var(--text, #2B2927); }

	/* Body layout: 2 columns */
	.edit-drawer__body-grid {
		flex: 1;
		display: grid;
		grid-template-columns: 420px 1fr;
		overflow: hidden;
	}

	.diagram-drawer__controls {
		padding: 1.5rem 1.75rem;
		overflow-y: auto;
		border-right: 1px solid var(--border, #E5DFD3);
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.diagram-drawer__preview-panel {
		padding: 1.5rem 1.75rem;
		background: #F4F3EF;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.diagram-drawer__preview-box {
		flex: 1;
		background: transparent;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 8px;
		padding: 2.5rem;
		overflow: auto;
		display: flex;
		align-items: flex-start;
		justify-content: flex-start;
		box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.04);
	}

	/* Field and Section Styles */
	.edit-drawer__context {
		background: var(--surface-hover, #F0EBE1);
		border-radius: 6px;
		padding: 0.75rem;
	}

	.edit-drawer__hint {
		margin: 0;
		font-family: var(--font-sans);
		font-size: 0.76rem;
		color: var(--text-muted, #6E6860);
		line-height: 1.4;
	}

	.diagram-editor__field-group {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.diagram-editor__color-row--table {
		max-width: 220px;
	}

	.edit-drawer__label {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-muted, #6E6860);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.edit-drawer__textarea {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 6px;
		background: #FFF;
		font-size: 0.85rem;
		resize: none;
		box-sizing: border-box;
	}

	.diagram-editor__ai-row {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.diagram-editor__ai-btn {
		padding: 0.5rem 1rem;
		background: #1D4ED8;
		color: white;
		border: none;
		border-radius: 5px;
		font-weight: 600;
		font-size: 0.8rem;
		cursor: pointer;
		align-self: flex-end;
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.diagram-editor__ai-btn:hover { background: #1E40AF; }

	.diagram-editor__section {
		border-top: 1px solid var(--border, #E5DFD3);
		padding-top: 0.85rem;
	}

	.diagram-editor__section-title {
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted, #6E6860);
		margin-bottom: 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.diagram-editor__colors {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.diagram-editor__color-item {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.diagram-editor__color-label {
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--text-muted, #6E6860);
		text-transform: uppercase;
	}

	.diagram-editor__color-row {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}

	.diagram-editor__color-wheel {
		width: 30px;
		height: 30px;
		padding: 2px;
		border: 1.5px solid var(--border, #E5DFD3);
		border-radius: 5px;
		background: transparent;
		cursor: pointer;
	}

	.diagram-editor__color-hex {
		flex: 1;
		min-width: 0;
		padding: 0.3rem 0.45rem;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 5px;
		font-family: monospace;
		font-size: 0.75rem;
	}

	.diagram-editor__color-clear {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 1px solid var(--border, #E5DFD3);
		background: transparent;
		color: var(--text-muted, #6E6860);
		font-size: 0.65rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.diagram-editor__color-clear:hover {
		background: #FEE2E2;
		color: #DC2626;
		border-color: #FCA5A5;
	}

	.diagram-editor__field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-bottom: 0.65rem;
	}

	.diagram-editor__field-label {
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--text-muted, #6E6860);
		text-transform: uppercase;
	}

	.diagram-editor__field-input {
		width: 100%;
		padding: 0.35rem 0.5rem;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 5px;
		font-size: 0.82rem;
		box-sizing: border-box;
	}

	.diagram-editor__field-textarea {
		resize: vertical;
		min-height: 80px;
		font-family: monospace;
		font-size: 0.75rem;
	}

	.edit-drawer__actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-left: auto;
	}

	.edit-drawer__apply {
		padding: 0.55rem 1.25rem;
		border-radius: 6px;
		border: 1px solid var(--border, #E5DFD3);
		background: var(--chapter-accent-color, #C9A84C);
		color: #fff;
		font-weight: 500;
		font-size: 0.82rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
	}

	.edit-drawer__apply:hover:not(:disabled) {
		opacity: 0.9;
	}

	.edit-drawer__apply:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	/* Footer block */
	.edit-drawer__footer {
		padding: 1.25rem 1.75rem;
		border-top: 1px solid var(--border, #E5DFD3);
		background: var(--surface, #FAFAF8);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.edit-drawer__error {
		color: #DC2626;
		font-size: 0.8rem;
		margin: 0;
	}

	.edit-drawer__success {
		color: #16A34A;
		font-size: 0.8rem;
		margin: 0;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.edit-drawer__cancel {
		padding: 0.55rem 1.25rem;
		border-radius: 6px;
		border: 1px solid var(--border, #E5DFD3);
		background: transparent;
		color: var(--text, #2B2927);
		font-weight: 500;
		font-size: 0.82rem;
		cursor: pointer;
		margin-left: auto;
	}
	.edit-drawer__cancel:hover { background: var(--surface-hover, #F0EBE1); }

	/* Loader and Spinner styles */
	.spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 50%;
		border-top-color: #fff;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* Style Diagram boxes relative */
	.chapter-body {
		width: 100%;
	}
	.chapter-body :global(.diagram-box) {
		position: relative;
		margin: 0;
		background: #FFF;
		border: 1.5px solid var(--border, #E5DFD3);
		border-radius: 6px;
		padding: 1.5rem;
		text-align: center;
		width: 100%;
		box-sizing: border-box;
	}
	.chapter-body :global(.diagram-box__title) {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--text, #2B2927);
		margin-bottom: 0.25rem;
		border-bottom: 1.5px solid var(--accent, #C9A84C);
		padding-bottom: 0.3rem;
	}
	.chapter-body :global(.diagram-box__subtitle) {
		font-size: 0.75rem;
		color: var(--text-muted, #6E6860);
		margin-bottom: 1rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.chapter-body :global(.diagram-box--table) {
		background: transparent;
		border: none;
		box-shadow: none;
		padding: 0;
		margin: 0;
		text-align: left;
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
	}
	.chapter-body :global(.diagram-box--table .table-container) {
		background: transparent;
		width: 100%;
		overflow-x: auto;
	}
	.chapter-body :global(.diagram-box--table table) {
		width: auto;
		min-width: 100%;
	}
	.chapter-body :global(.diagram-box--table th) {
		background-color: var(--r-table-header-bg, #0F172A);
		border-color: var(--r-border, #e2e8f0);
	}
	.chapter-body :global(.diagram-box--table td) {
		border-color: var(--r-border, #e2e8f0);
	}
	.chapter-body :global(.diagram-box--table tr:nth-child(even)) {
		background-color: #f8fafc;
	}
	.chapter-body :global(.diagram-box--table .edit-trigger--diagram) {
		display: none !important;
	}
	.chapter-body :global(.diagram-box--table .edit-trigger--diagram) {
		position: static;
		opacity: 1;
		pointer-events: auto;
		margin-top: 0.85rem;
		align-self: flex-end;
	}
	.chapter-body :global(.diagram-box--table .diagram-box__title),
	.chapter-body :global(.diagram-box--table .diagram-box__subtitle) {
		display: none;
	}
	.chapter-body :global(.edit-trigger--diagram) {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 600;
		padding: 0.3rem 0.65rem;
		border-radius: 5px;
		border: 1px solid rgba(142,116,83,0.5);
		background: rgba(250,248,244,0.9);
		color: var(--r-accent, #8E7453);
		cursor: pointer;
		opacity: 1;
		pointer-events: auto;
		transition: background 0.15s, border-color 0.15s, color 0.15s;
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		white-space: nowrap;
		z-index: 5;
		letter-spacing: 0.02em;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
	}

	.chapter-body :global(.edit-trigger--diagram:hover) {
		background: rgba(142,116,83,0.15);
		border-color: var(--r-accent, #8E7453);
	}
</style>
