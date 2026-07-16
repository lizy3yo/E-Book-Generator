<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import type { Chapter } from '$lib/types';
	import { generateImage } from '$lib/generateImage';
	import { parseMarkdown } from '$lib/diagrams';
	import { INTERIOR_PRESETS } from '$lib/interiorDesigns';
	import {
		BookMarked, Clipboard, ClipboardCheck, FileCode, FileDown,
		Image as ImageIcon, PenLine, BookOpen,
		Sparkles, Wand2, RefreshCcw, RotateCcw,
		X, Palette, Camera, Check
	} from '@lucide/svelte';

	let fontSize = $state(18);
	let readerTheme = $state<'white'>('white');
	// Incrementing this forces all section style attributes to re-evaluate,
	// snapping header/footer design tokens back to the current cover settings.
	let designKey = $state(0);

	let headerFooterPreset = $state('Classical Editorial');
	let interiorCustomInstructions = $state('');

	// Instantly apply a named preset from $lib/interiorDesigns without hitting the AI endpoint.
	// Useful when the user just wants to swap layout style without regenerating from the cover.
	function applyPresetInstantly(preset: string) {
		if (!activeBook) return;
		const cs = activeBook.coverSettings;
		const primary = cs?.titleColor  || '#1A1612';
		const accent  = cs?.authorColor || '#8E7453';
		const alignment = cs?.alignment || 'left';
		const titleFont = cs?.titleFont  || 'Lora';
		const presetFn = INTERIOR_PRESETS[preset];
		if (!presetFn) return;
		const design = presetFn({ primary, accent, alignment, titleFont });
		const current = activeBook.interiorDesign ?? {};
		globalState.updateBookInteriorDesign(activeBook.id, { ...current, ...design });
		designKey = Date.now();
	}

	let appliedPreset = $state('Classical Editorial');
	let appliedCustomInstructions = $state('');

	let copySuccess = $state(false);
	let isPdfExporting = $state(false);
	let readerScrollArea = $state<HTMLElement | null>(null);

	let activeBook = $derived(globalState.activeBook);
	let coverSettings = $derived(activeBook?.coverSettings);
	let isBakedCover = $derived(
		!!coverSettings?.bgImageUrl &&
		!!(activeBook?.coverOptions?.some(o => o.imageUrl && o.imageUrl === coverSettings?.bgImageUrl))
	);

	// ── Content Editor state ──────────────────────────────────────────────────
	type EditScope = 'page' | 'chapter' | 'illustration' | 'add-page' | 'diagram';

	interface EditTarget {
		scope: EditScope;
		chapterId: string;
		chapterTitle: string;
		chapterOrder: number;
		chapterSummary: string;
		chapterContent: string;
		researchNotes?: string;
		// page scope
		pageIndex?: number;
		pageStartIdx?: number;   // markdown block start index for this page
		pageEndIdx?: number;     // markdown block end index (exclusive) for this page
		pageText?: string;       // plain-text snapshot sent to Claude as context
		// illustration scope
		illustrationUrl?: string;
		illustrationPrompt?: string;
		// diagram scope
		diagramIndex?: number;   // which diagram block (0-based) within this chapter
		diagramRaw?: string;     // raw content: diagram YAML, markdown table, or raw HTML
		// 'fence'  = ```diagram``` code block
		// 'table'  = markdown table (| col | col |)
		// 'inline' = raw HTML visual element (callout-box, stat-block, etc.)
		// 'image'  = AI-generated realistic image rendered via ![alt](url)
		diagramKind?: 'fence' | 'table' | 'inline' | 'image';
	}

	let editTarget      = $state<EditTarget | null>(null);
	let editInstruction = $state('');
	let isEditing       = $state(false);
	let editSuccess     = $state(false);
	let editError       = $state('');
	// Stores the last successfully submitted instruction so Redo can replay it
	let lastInstruction = $state('');
	// Which action triggered the current in-progress edit (for button loading state)
	let activeAction    = $state<'apply' | 'redo' | 'reconstruct' | null>(null);

	// ── Image style editor state ─────────────────────────────────────────────
	// These are only active when editTarget.diagramKind === 'image'.
	let imageFullPage    = $state(false);
	let imageBorderColor = $state('#C9A84C');
	let imageBorderWidth = $state('0');   // '0' = no border
	let imageBorderStyle = $state('solid');
	let imageBorderRadius = $state('6');  // px

	/** Reset image style controls to neutral defaults */
	function resetImageStyleState() {
		imageFullPage     = false;
		imageBorderColor  = '#C9A84C';
		imageBorderWidth  = '0';
		imageBorderStyle  = 'solid';
		imageBorderRadius = '6';
	}
	// When true, the prompt is prefixed with a photorealistic boilerplate that
	// steers the image model toward hyper-detailed, photograph-quality output.
	let useRealisticIllustration = $state(false);

	// ── Diagram editor state ─────────────────────────────────────────────────────
	/** Extract the Nth diagram code block content from chapter markdown */
	function getDiagramBlockRaw(chapterContent: string, index: number): string {
		const re = /```(?:diagram|mermaid)\r?\n([\s\S]*?)```/g;
		let i = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(chapterContent)) !== null) {
			if (i === index) return m[1];
			i++;
		}
		return '';
	}

	/**
	 * Unified splice helper for all editable visual block kinds.
	 *
	 * Strategies:
	 *  'fence'  – replaces the Nth ```diagram``` code fence with new YAML or image markdown
	 *  'table'  – replaces the first occurrence of the original raw markdown table with the new one
	 *  'inline' – replaces the first occurrence of the original raw HTML block with the new one
	 *
	 * @param fullMarkdown  The chapter's raw markdown string
	 * @param kind          Which strategy to use
	 * @param original      The original raw content (for table/inline: used as the search anchor)
	 * @param index         For 'fence': the 0-based index of the code fence to replace
	 * @param replacement   The new content to write in place of the old block
	 * @param asImage       When true, `replacement` is verbatim markdown (no fence wrapper)
	 */
	function spliceVisualBlock(
		fullMarkdown: string,
		kind: 'fence' | 'table' | 'inline' | 'image',
		original: string,
		index: number,
		replacement: string,
		asImage = false
	): string {
		if (kind === 'fence') {
			// Find the Nth ```diagram / ```mermaid block and replace it
			const re = /```(?:diagram|mermaid)\r?\n[\s\S]*?```/g;
			let i = 0, m: RegExpExecArray | null;
			while ((m = re.exec(fullMarkdown)) !== null) {
				if (i === index) {
					const block = asImage ? replacement : `\`\`\`diagram\n${replacement}\n\`\`\``;
					return fullMarkdown.slice(0, m.index) + block + fullMarkdown.slice(m.index + m[0].length);
				}
				i++;
			}
			// Fallback: append
			return asImage
				? `${fullMarkdown}\n\n${replacement}`
				: `${fullMarkdown}\n\n\`\`\`diagram\n${replacement}\n\`\`\``;
		}

		if (kind === 'table' || kind === 'inline' || kind === 'image') {
			// For tables and inline HTML, `original` is the raw string to search for.
			// Use a simple string replace for the first occurrence — safe because
			// identical raw blocks in the same chapter are genuinely unlikely.
			if (original && fullMarkdown.includes(original)) {
				return fullMarkdown.replace(original, asImage ? replacement : replacement);
			}
			// Fallback: append
			return `${fullMarkdown}\n\n${replacement}`;
		}

		return fullMarkdown;
	}

	/** Click-delegation handler for the reader scroll container */
	function handleReaderClick(e: MouseEvent) {
		const btn = (e.target as HTMLElement).closest('.edit-trigger--diagram') as HTMLElement | null;
		if (!btn) return;
		e.stopPropagation();
		const chapId = btn.dataset.chapterId ?? '';
		const chap   = activeBook?.chapters.find(c => c.id === chapId);
		if (!chap || !activeBook) return;

		// Determine the kind of visual block that was clicked:
		//   'fence'  — data-diagram-index set, no data-table-raw   → ```diagram``` code block
		//   'table'  — data-table-index set, data-table-raw starts with '|'  → markdown table
		//   'inline' — data-table-index set, data-table-raw starts with '<'  → raw HTML element
		//   'image'  — data-table-index set, data-table-raw starts with '!'  → ![alt](url) image
		let raw  = '';
		let kind: 'fence' | 'table' | 'inline' | 'image' = 'fence';
		let idx  = 0;

		if (btn.dataset.tableRaw) {
			raw  = decodeURIComponent(btn.dataset.tableRaw);
			idx  = parseInt(btn.dataset.tableIndex ?? '0', 10);
			const trimmed = raw.trimStart();
			kind = trimmed.startsWith('<') ? 'inline' : trimmed.startsWith('!') ? 'image' : 'table';
		} else {
			idx  = parseInt(btn.dataset.diagramIndex ?? '0', 10);
			raw  = getDiagramBlockRaw(chap.content, idx);
			kind = 'fence';
		}

		openEditPanel({
			scope:          'diagram',
			chapterId:      chapId,
			chapterTitle:   chap.title,
			chapterOrder:   chap.order,
			chapterSummary: chap.summary,
			chapterContent: chap.content,
			researchNotes:  chap.researchNotes,
			diagramIndex:   idx,
			diagramRaw:     raw,
			diagramKind:    kind
		});
	}

	// ── Per-book design color overrides (written into interiorDesign) ──────────
	let designAccentOverride = $state('');
	let designPageBgOverride = $state('');
	let designTextOverride   = $state('');
	let designHeaderOverride = $state('');

	function applyColorOverride(key: string, value: string) {
		if (!activeBook) return;
		const current = activeBook.interiorDesign ?? {};
		globalState.updateBookInteriorDesign(activeBook.id, { ...current, [key]: value, _coverSignature: (current._coverSignature ?? '') });
	}

	function openEditPanel(target: EditTarget) {
		editTarget = target;
		editInstruction = '';
		editSuccess = false;
		editError = '';
		resetImageStyleState();
		// Seed the realistic toggle from the book-level setting so it remembers the
		// author's preferred image style without requiring a manual toggle each time.
		useRealisticIllustration =
			!!(activeBook?.useUltraRealistic || activeBook?.coverSettings?.useUltraRealistic);
		// Keep lastInstruction — it's scoped to the drawer session intentionally
		// so Redo works immediately after a successful edit without re-typing
	}

	function closeEditPanel() {
		editTarget = null;
		editInstruction = '';
		editSuccess = false;
		editError = '';
		lastInstruction = '';
		activeAction = null;
		useRealisticIllustration = false;
		resetImageStyleState();
	}

	/**
	 * Apply visual style changes (full-page, border, radius) to an image block
	 * without any AI call — it's a pure in-place HTML patch on the chapter markdown.
	 */
	async function applyImageStyle() {
		if (!editTarget || !activeBook || editTarget.diagramKind !== 'image') return;

		const raw = editTarget.diagramRaw ?? '';
		// Extract alt + url from the stored ![alt](url) raw string
		const imgMatch = raw.match(/^!\[([^\]]*)\]\((https?:\/\/[^)]+)\)$/);
		if (!imgMatch) return;

		const [, alt, url] = imgMatch;

		const bw   = parseInt(imageBorderWidth, 10) || 0;
		const border = bw > 0 ? `${bw}px ${imageBorderStyle} ${imageBorderColor}` : 'none';
		const radius = `${parseInt(imageBorderRadius, 10) || 6}px`;

		const figStyle = imageFullPage
			? `margin:0;padding:0;text-align:center;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;page-break-inside:avoid;`
			: `margin:1.25rem auto;text-align:center;max-width:100%;page-break-inside:avoid;`;

		const imgStyle = imageFullPage
			? `max-width:100%;max-height:100%;width:100%;object-fit:contain;border-radius:${radius};display:block;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.12);border:${border};`
			: `max-width:100%;height:auto;border-radius:${radius};display:block;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,0.12);border:${border};`;

		const caption = alt
			? `<figcaption style="text-align:center;font-size:0.78rem;color:var(--r-text-muted,#64748B);margin-top:0.35rem;font-style:italic;">${alt}</figcaption>`
			: '';

		// Re-encode the raw markdown as the new data-table-raw anchor
		const newTableRaw = encodeURIComponent(raw);
		const editBtn = `<button class="edit-trigger edit-trigger--diagram edit-trigger--inline" data-chapter-id="${editTarget.chapterId}" data-table-index="${editTarget.diagramIndex ?? 0}" data-table-raw="${newTableRaw}" title="Regenerate or edit this image" aria-label="Edit image"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg> Edit</button>`;

		const wrapperClass = imageFullPage
			? 'diagram-box diagram-box--image diagram-box--image--fullpage'
			: 'diagram-box diagram-box--image';

		const newHtml = `<div class="${wrapperClass}"><div class="diagram-box__actions">${editBtn}</div><figure style="${figStyle}"><img src="${url}" alt="${alt}" loading="lazy" style="${imgStyle}" />${caption}</figure></div>`;

		// The raw is ![alt](url), the chapter markdown contains exactly that string.
		// Replace it with the new HTML block wrapped in a div (diagrams.ts Step 1.6
		// already stored the original ![alt](url) as diagramRaw, so we can search for it).
		const updatedContent = spliceVisualBlock(
			editTarget.chapterContent,
			'image',
			raw,
			editTarget.diagramIndex ?? 0,
			newHtml,
			true   // replacement is verbatim HTML, not a diagram fence
		);

		globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
		editTarget = { ...editTarget, chapterContent: updatedContent };
		editSuccess = true;
		paginateAllChapters();
	}

	function getChapterOrderLabel(chap: { title: string; order: number }, idx: number): string {
		const lower = chap.title.toLowerCase();
		if (lower.startsWith('preface')) return 'P';
		if (lower.startsWith('introduction') || lower.startsWith('intro')) return 'I';
		if (lower.startsWith('foreword')) return 'F';
		
		let prefaceCount = 0;
		if (activeBook?.chapters) {
			for (let i = 0; i < idx; i++) {
				const titleLower = activeBook.chapters[i].title.toLowerCase();
				if (
					titleLower.startsWith('preface') ||
					titleLower.startsWith('introduction') ||
					titleLower.startsWith('foreword') ||
					titleLower.startsWith('intro')
				) {
					prefaceCount++;
				}
			}
		}
		return String(chap.order - prefaceCount);
	}

	function getChapterLabel(chap: { title: string; order: number }, idx: number): string {
		const lower = chap.title.toLowerCase();
		if (lower.startsWith('preface') || lower.startsWith('introduction') || lower.startsWith('foreword') || lower.startsWith('intro')) {
			if (lower.startsWith('preface')) return 'Preface';
			if (lower.startsWith('introduction') || lower.startsWith('intro')) return 'Introduction';
			if (lower.startsWith('foreword')) return 'Foreword';
			return 'Preface';
		}
		return `Chapter ${getChapterOrderLabel(chap, idx)}`;
	}

	/** Strip HTML tags to get plain text for sending to Claude as page context */
	function htmlToPlainText(html: string): string {
		const div = document.createElement('div');
		div.innerHTML = html;
		return div.innerText || div.textContent || '';
	}

	/**
	 * Splice a rewritten page back into the full chapter markdown.
	 *
	 * Uses the block-index range stored in paginationMeta to locate exactly
	 * which markdown paragraphs belong to this page, then replaces them with
	 * the new content. This is 100% reliable — no text fingerprinting.
	 *
	 * @param fullMarkdown  Raw markdown source of the whole chapter
	 * @param startIdx      First markdown block index this page covers
	 * @param endIdx        Exclusive end index (one past the last block on this page)
	 * @param newMarkdown   Claude's rewritten content for this page
	 */
	function splicePage(
		fullMarkdown: string,
		startIdx: number,
		endIdx: number,
		newMarkdown: string
	): string {
		if (!fullMarkdown) return fullMarkdown;

		// Split the chapter markdown into the same paragraph-level blocks
		// that parseMarkdown+splitHtmlIntoBlocks would produce, but work
		// directly on the raw markdown so we never have to round-trip through HTML.
		// Double-newline is the universal paragraph separator in Markdown.
		const mdBlocks = fullMarkdown.split(/\n\n+/);

		if (startIdx >= mdBlocks.length) {
			// Fallback: the indices are out of range — append clearly marked
			return `${fullMarkdown}\n\n${newMarkdown}`;
		}

		const clampedEnd = Math.min(endIdx, mdBlocks.length);
		const before = mdBlocks.slice(0, startIdx);
		const after  = mdBlocks.slice(clampedEnd);

		return [...before, newMarkdown.trim(), ...after].join('\n\n');
	}

	async function applyEdit() {
		if (!editTarget || !editInstruction.trim() || !activeBook) return;
		let instruction = editInstruction.trim();
		// When the realistic toggle is active for illustrations or diagrams, prepend a
		// photorealistic style directive so the image model outputs
		// high-fidelity, photograph-quality renders regardless of what the
		// user wrote.
		if ((editTarget.scope === 'illustration' || editTarget.scope === 'diagram') && useRealisticIllustration) {
			instruction =
				`Hyperrealistic photographic render, 8k resolution, cinematic lighting, ` +
				`award-winning professional photography quality, highly detailed. ` +
				instruction;
		}
		await _runEdit(instruction, 'apply');
	}

	/** Re-run the previous instruction unchanged */
	async function applyRedo() {
		if (!editTarget || !lastInstruction || !activeBook) return;
		await _runEdit(lastInstruction, 'redo');
	}

	/**
	 * Reconstruct — full AI rewrite from the original chapter brief only.
	 * The existing content is treated as context for continuity, not as input.
	 * Claude writes entirely fresh prose anchored to the chapter summary.
	 */
	async function applyReconstruct() {
		if (!editTarget || !activeBook || isEditing) return;
		isEditing = true;
		activeAction = 'reconstruct';
		editSuccess = false;
		editError = '';

		try {
			// ── Fetch fresh targeted Exa research for this specific chapter ────
			let freshResearch = editTarget.researchNotes || '';
			try {
				const rRes = await fetch('/api/research', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						query: `${editTarget.chapterTitle} ${activeBook.title} ${activeBook.genre} ${editTarget.chapterSummary ?? ''}`.trim(),
						apiKey: globalState.apiKeys.exaKey,
						useMockMode: globalState.apiKeys.useMockMode
					})
				});
				const rData = await rRes.json();
				if (rData.success && rData.results?.length) {
					const newFacts = (rData.results as any[])
						.map((f: any) => `[${f.title}] ${f.snippet}`)
						.join('\n\n');
					// Merge fresh research with any saved notes
					freshResearch = [
						freshResearch ? `[Saved Research Notes]\n${freshResearch}` : '',
						`[Fresh Research for "${editTarget.chapterTitle}"]\n${newFacts}`
					].filter(Boolean).join('\n\n');
				}
			} catch { /* non-fatal — use saved notes as fallback */ }

			if (editTarget.scope === 'chapter') {
				const res = await fetch('/api/edit', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'reconstruct-chapter',
						apiKey: globalState.apiKeys.anthropicKey,
						useMockMode: globalState.apiKeys.useMockMode,
						bookTitle: activeBook.title,
						genre: activeBook.genre,
						tone: activeBook.tone,
						structure: activeBook.structure,
						chapterTitle: editTarget.chapterTitle,
						chapterOrder: editTarget.chapterOrder,
						chapterSummary: editTarget.chapterSummary,
						researchNotes: freshResearch
					})
				});
				const data = await res.json();
				if (!data.success) throw new Error(data.error || 'Reconstruct failed');
				globalState.updateChapterContent(activeBook.id, editTarget.chapterId, data.content, 'completed');
				editTarget = { ...editTarget, chapterContent: data.content };

			} else if (editTarget.scope === 'page') {
				const res = await fetch('/api/edit', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'reconstruct-page',
						apiKey: globalState.apiKeys.anthropicKey,
						useMockMode: globalState.apiKeys.useMockMode,
						bookTitle: activeBook.title,
						genre: activeBook.genre,
						tone: activeBook.tone,
						chapterTitle: editTarget.chapterTitle,
						chapterOrder: editTarget.chapterOrder,
						chapterSummary: editTarget.chapterSummary,
						chapterContent: editTarget.chapterContent,
						pageContent: editTarget.pageText,
						researchNotes: freshResearch
					})
				});
				const data = await res.json();
				if (!data.success) throw new Error(data.error || 'Reconstruct failed');
				const updatedContent = splicePage(
					editTarget.chapterContent,
					editTarget.pageStartIdx ?? 0,
					editTarget.pageEndIdx ?? editTarget.chapterContent.split(/\n\n+/).length,
					data.pageContent
				);
				globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
				editTarget = { ...editTarget, chapterContent: updatedContent, pageText: htmlToPlainText(data.pageContent) };

			} else if (editTarget.scope === 'illustration') {
				// For illustrations, reconstruct = generate a fresh prompt from scratch
				// using only the chapter title and summary, ignoring the old prompt
				const isUltra = useRealisticIllustration || activeBook.useUltraRealistic || activeBook.coverSettings?.useUltraRealistic;
				const freshPrompt = [
					isUltra 
						? `A hyperrealistic, award-winning photograph, highly detailed photorealistic render, 8k resolution, cinematic lighting, professional composition`
						: `A high-quality editorial illustration`,
					`for a chapter titled "${editTarget.chapterTitle}"`,
					editTarget.chapterSummary ? `about: ${editTarget.chapterSummary}` : '',
					`from the book "${activeBook.title}" (${activeBook.genre}).`
				].filter(Boolean).join(' ');

				const newIllustUrl = await generateImage({
					prompt:      freshPrompt,
					apiKey:      globalState.apiKeys.imageKey,
					provider:    globalState.apiKeys.imageProvider,
					useMockMode: globalState.apiKeys.useMockMode,
					isCover:     false
				});
				globalState.updateChapterIllustration(activeBook.id, editTarget.chapterId, newIllustUrl);
				editTarget = { ...editTarget, illustrationUrl: newIllustUrl, illustrationPrompt: freshPrompt };

			} else if (editTarget.scope === 'diagram') {
				const kind = editTarget.diagramKind ?? 'fence';
				const isUltra = useRealisticIllustration || activeBook.useUltraRealistic || activeBook.coverSettings?.useUltraRealistic;
				if (isUltra) {
					// ── Realistic path: generate a fresh image replacing this visual block ──
					const freshPrompt = [
						'Hyperrealistic photographic render, 8k resolution, cinematic lighting,',
						'award-winning professional photography quality, highly detailed.',
						`Visual representation of: ${editTarget.diagramRaw || editTarget.chapterSummary || editTarget.chapterTitle}`,
						`From the book "${activeBook.title}" (${activeBook.genre}).`
					].join(' ');
					const imgUrl = await generateImage({
						prompt:      freshPrompt,
						apiKey:      globalState.apiKeys.imageKey,
						provider:    globalState.apiKeys.imageProvider,
						useMockMode: globalState.apiKeys.useMockMode,
						isCover:     false
					});
					const imgMarkdown = `![${editTarget.chapterTitle}](${imgUrl})`;
					const updatedContent = spliceVisualBlock(
						editTarget.chapterContent, kind,
						editTarget.diagramRaw ?? '',
						editTarget.diagramIndex ?? 0,
						imgMarkdown, true
					);
					globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
					editTarget = {
						...editTarget,
						chapterContent: updatedContent,
						illustrationUrl: imgUrl,
						illustrationPrompt: freshPrompt,
						scope: 'illustration'
					};
				} else {
					// ── Standard path: reconstruct the visual block from scratch ──────
					const isHtmlBlock = kind === 'table' || kind === 'inline';
					const apiAction   = isHtmlBlock ? 'edit-html-block' : 'edit-diagram';
					const res = await fetch('/api/edit', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							action:        apiAction,
							apiKey:        globalState.apiKeys.anthropicKey,
							useMockMode:   globalState.apiKeys.useMockMode,
							bookTitle:     activeBook.title,
							genre:         activeBook.genre,
							tone:          activeBook.tone,
							chapterTitle:  editTarget.chapterTitle,
							chapterOrder:  editTarget.chapterOrder,
							diagramRaw:    editTarget.diagramRaw,
							editInstruction: `Reconstruct this from scratch. Make it richer, more detailed, and more visually informative.`
						})
					});
					const data = await res.json();
					if (!data.success) throw new Error(data.error || 'Reconstruct failed');
					const newRaw = data.diagramRaw ?? data.htmlBlock ?? editTarget.diagramRaw ?? '';
					const updatedContent = spliceVisualBlock(
						editTarget.chapterContent, kind,
						editTarget.diagramRaw ?? '',
						editTarget.diagramIndex ?? 0,
						newRaw, false
					);
					globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
					editTarget = { ...editTarget, chapterContent: updatedContent, diagramRaw: newRaw };
				}
			}

			lastInstruction = '';   // reconstruct has no re-runnable instruction; clear Redo
			editSuccess = true;
			await tick();
			if (editTarget.scope !== 'illustration') paginateAllChapters();

		} catch (err: any) {
			editError = err.message || 'An unexpected error occurred.';
		} finally {
			isEditing = false;
			activeAction = null;
		}
	}

	/** Add a new page of AI-generated content after the current page */
	async function applyAddPage() {
		if (!editTarget || !editInstruction.trim() || !activeBook || isEditing) return;
		isEditing = true;
		activeAction = 'apply';
		editSuccess = false;
		editError = '';

		try {
			// Fetch fresh Exa research for this chapter
			let freshResearch = editTarget.researchNotes || '';
			try {
				const rRes = await fetch('/api/research', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						query: `${editTarget.chapterTitle} ${activeBook.title} ${editInstruction}`.trim(),
						apiKey: globalState.apiKeys.exaKey,
						useMockMode: globalState.apiKeys.useMockMode
					})
				});
				const rData = await rRes.json();
				if (rData.success && rData.results?.length) {
					const newFacts = (rData.results as any[])
						.map((f: any) => `[${f.title}] ${f.snippet}`)
						.join('\n\n');
					freshResearch = [freshResearch ? `[Saved]\n${freshResearch}` : '', `[Fresh Research]\n${newFacts}`].filter(Boolean).join('\n\n');
				}
			} catch { /* non-fatal */ }

			const res = await fetch('/api/edit', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'add-page',
					apiKey: globalState.apiKeys.anthropicKey,
					useMockMode: globalState.apiKeys.useMockMode,
					bookTitle: activeBook.title,
					genre: activeBook.genre,
					tone: activeBook.tone,
					chapterTitle: editTarget.chapterTitle,
					chapterOrder: editTarget.chapterOrder,
					chapterContent: editTarget.chapterContent,
					pageContent: (editTarget.pageIndex ?? 0) + 1,
					editInstruction: editInstruction.trim(),
					researchNotes: freshResearch
				})
			});
			const data = await res.json();
			if (!data.success) throw new Error(data.error || 'Add page failed');

			// Splice new content AFTER the current page's end index
			const insertAt = editTarget.pageEndIdx ?? editTarget.chapterContent.split(/\n\n+/).length;
			const mdBlocks = editTarget.chapterContent.split(/\n\n+/);
			const before = mdBlocks.slice(0, insertAt);
			const after  = mdBlocks.slice(insertAt);
			const updatedContent = [...before, data.pageContent.trim(), ...after].join('\n\n');

			globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
			editTarget = { ...editTarget, chapterContent: updatedContent };
			lastInstruction = editInstruction.trim();
			editSuccess = true;
			await tick();
			paginateAllChapters();
		} catch (err: any) {
			editError = err.message || 'An unexpected error occurred.';
		} finally {
			isEditing = false;
			activeAction = null;
		}
	}

	/** Shared execution core used by all three actions */
	async function _runEdit(instruction: string, action: 'apply' | 'redo' | 'reconstruct') {
		if (!editTarget || !activeBook || isEditing) return;
		isEditing = true;
		activeAction = action;
		editSuccess = false;
		editError = '';

		try {
			if (editTarget.scope === 'chapter') {
				const res = await fetch('/api/edit', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'edit-chapter',
						apiKey: globalState.apiKeys.anthropicKey,
						useMockMode: globalState.apiKeys.useMockMode,
						bookTitle: activeBook.title,
						genre: activeBook.genre,
						tone: activeBook.tone,
						chapterTitle: editTarget.chapterTitle,
						chapterOrder: editTarget.chapterOrder,
						chapterContent: editTarget.chapterContent,
						editInstruction: instruction,
						researchNotes: editTarget.researchNotes,
						coverSettings: activeBook.coverSettings,
						coverStyle: coverStyle,
						interiorDesign: activeBook.interiorDesign
					})
				});
				const data = await res.json();
				if (!data.success) throw new Error(data.error || 'Edit failed');
				globalState.updateChapterContent(activeBook.id, editTarget.chapterId, data.content, 'completed');
				if (data.design) {
					globalState.updateBookInteriorDesign(activeBook.id, {
						...activeBook.interiorDesign,
						...data.design
					});
				}
				// Keep editTarget in sync so a subsequent Redo has fresh content
				editTarget = { ...editTarget, chapterContent: data.content };

			} else if (editTarget.scope === 'page') {
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
						chapterContent: editTarget.chapterContent,
						pageContent: editTarget.pageText,
						editInstruction: instruction,
						researchNotes: editTarget.researchNotes,
						coverSettings: activeBook.coverSettings,
						coverStyle: coverStyle,
						interiorDesign: activeBook.interiorDesign
					})
				});
				const data = await res.json();
				if (!data.success) throw new Error(data.error || 'Edit failed');
				const updatedContent = splicePage(
					editTarget.chapterContent,
					editTarget.pageStartIdx ?? 0,
					editTarget.pageEndIdx ?? editTarget.chapterContent.split(/\n\n+/).length,
					data.pageContent
				);
				globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
				if (data.design) {
					globalState.updateBookInteriorDesign(activeBook.id, {
						...activeBook.interiorDesign,
						...data.design
					});
				}
				editTarget = { ...editTarget, chapterContent: updatedContent, pageText: htmlToPlainText(data.pageContent) };

			} else if (editTarget.scope === 'illustration') {
				// Step 1: refine prompt
				const promptRes = await fetch('/api/edit', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						action: 'edit-illustration',
						apiKey: globalState.apiKeys.anthropicKey,
						useMockMode: globalState.apiKeys.useMockMode,
						bookTitle: activeBook.title,
						genre: activeBook.genre,
						tone: activeBook.tone,
						chapterTitle: editTarget.chapterTitle,
						chapterOrder: editTarget.chapterOrder,
						illustrationPrompt: editTarget.illustrationPrompt,
						editInstruction: instruction
					})
				});
				const promptData = await promptRes.json();
				if (!promptData.success) throw new Error(promptData.error || 'Prompt refinement failed');
				// Step 2: generate image
				const newIllustUrl = await generateImage({
					prompt:      promptData.prompt,
					apiKey:      globalState.apiKeys.imageKey,
					provider:    globalState.apiKeys.imageProvider,
					useMockMode: globalState.apiKeys.useMockMode,
					isCover:     false
				});
				globalState.updateChapterIllustration(activeBook.id, editTarget.chapterId, newIllustUrl);
				editTarget = { ...editTarget, illustrationUrl: newIllustUrl, illustrationPrompt: promptData.prompt };

			} else if (editTarget.scope === 'diagram') {
				const kind = editTarget.diagramKind ?? 'fence';
				if (useRealisticIllustration) {
					// ── Realistic path: AI image replaces the visual block ──────────
					const diagramContext = editTarget.diagramRaw || editTarget.chapterSummary || editTarget.chapterTitle;
					const imagePrompt = [
						'Hyperrealistic photographic render, 8k resolution, cinematic lighting,',
						'award-winning professional photography quality, highly detailed.',
						instruction.trim() || `Visual representation of: ${diagramContext}`,
						`Context: Chapter "${editTarget.chapterTitle}" from "${activeBook.title}" (${activeBook.genre}).`
					].join(' ');
					const imgUrl = await generateImage({
						prompt:      imagePrompt,
						apiKey:      globalState.apiKeys.imageKey,
						provider:    globalState.apiKeys.imageProvider,
						useMockMode: globalState.apiKeys.useMockMode,
						isCover:     false
					});
					const imgMarkdown = `![${editTarget.chapterTitle}](${imgUrl})`;
					const updatedContent = spliceVisualBlock(
						editTarget.chapterContent, kind,
						editTarget.diagramRaw ?? '',
						editTarget.diagramIndex ?? 0,
						imgMarkdown, true
					);
					globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
					editTarget = {
						...editTarget,
						chapterContent: updatedContent,
						illustrationUrl: imgUrl,
						illustrationPrompt: imagePrompt,
						scope: 'illustration'
					};
				} else {
					// ── Standard path: AI rewrites / edits the visual block ─────────
					// For table/inline blocks, send the raw HTML/markdown as context;
					// Claude rewrites it and we splice the new version back in.
					const isHtmlBlock = kind === 'table' || kind === 'inline';
					const apiAction   = isHtmlBlock ? 'edit-html-block' : 'edit-diagram';
					const res = await fetch('/api/edit', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							action:        apiAction,
							apiKey:        globalState.apiKeys.anthropicKey,
							useMockMode:   globalState.apiKeys.useMockMode,
							bookTitle:     activeBook.title,
							genre:         activeBook.genre,
							tone:          activeBook.tone,
							chapterTitle:  editTarget.chapterTitle,
							chapterOrder:  editTarget.chapterOrder,
							diagramRaw:    editTarget.diagramRaw,
							editInstruction: instruction
						})
					});
					const data = await res.json();
					if (!data.success) throw new Error(data.error || 'Edit failed');
					const newRaw = data.diagramRaw ?? data.htmlBlock ?? editTarget.diagramRaw ?? '';
					const updatedContent = spliceVisualBlock(
						editTarget.chapterContent, kind,
						editTarget.diagramRaw ?? '',
						editTarget.diagramIndex ?? 0,
						newRaw, false
					);
					globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
					editTarget = { ...editTarget, chapterContent: updatedContent, diagramRaw: newRaw };
				}
			}

			lastInstruction = instruction;
			editSuccess = true;
			await tick();
			if (editTarget.scope !== 'illustration') paginateAllChapters();

		} catch (err: any) {
			editError = err.message || 'An unexpected error occurred.';
		} finally {
			isEditing = false;
			activeAction = null;
		}
	}

	// Track which section is currently visible via IntersectionObserver
	let activeSection = $state<'cover' | number>('cover');
	let sectionEls: Map<string, HTMLElement> = new Map();
	let intersectingSet = new Set<string>();
	let observer: IntersectionObserver | null = null;

	// Svelte action to register a section element
	function registerSection(el: HTMLElement, id: 'cover' | number | string) {
		if (typeof id === 'string' && id.includes('-')) return;
		const key = String(id);
		sectionEls.set(key, el);
		el.setAttribute('data-section-id', key);

		if (observer) {
			observer.observe(el);
		}

		return {
			destroy() {
				sectionEls.delete(key);
				observer?.unobserve(el);
			}
		};
	}

	// Scroll to a specific section
	function scrollTo(id: 'cover' | number) {
		const el = sectionEls.get(String(id));
		el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	onMount(() => {
		tick().then(() => {
			const scrollRoot = readerScrollArea;
			if (!scrollRoot) return;

			observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						const id = entry.target.getAttribute('data-section-id');
						if (id) {
							if (entry.isIntersecting) {
								intersectingSet.add(id);
							} else {
								intersectingSet.delete(id);
							}
						}
					}

					let bestId: string | null = null;
					let bestTop = Infinity;

					const rootEl = document.querySelector('.reader-scroll-area');
					const rootTop = rootEl ? rootEl.getBoundingClientRect().top : 0;

					intersectingSet.forEach((id) => {
						const el = sectionEls.get(id);
						if (el) {
							const rect = el.getBoundingClientRect();
							const distance = Math.abs(rect.top - rootTop);
							if (distance < bestTop) {
								bestTop = distance;
								bestId = id;
							}
						}
					});

					if (bestId !== null) {
						activeSection = bestId === 'cover' ? 'cover' : parseInt(bestId);
					}
				},
				{
					root: scrollRoot,
					threshold: [0.0, 0.1, 0.25, 0.5]
				}
			);

			sectionEls.forEach((el) => observer?.observe(el));
			scrollRoot.addEventListener('click', handleReaderClick);
		});

		return () => {
			readerScrollArea?.removeEventListener('click', handleReaderClick);
			observer?.disconnect();
			intersectingSet.clear();
		};
	});



	// ── Copy Markdown ──────────────────────────────────────────────────────────
	function handleCopyMarkdown() {
		if (!activeBook) return;
		let md = `# ${activeBook.title}\n## ${activeBook.subtitle}\nBy ${activeBook.author}\n\n`;
		activeBook.chapters.forEach((c, idx) => {
			md += `\n# ${getChapterLabel(c, idx)}: ${c.title}\n\n${c.content}\n`;
		});
		navigator.clipboard.writeText(md).then(() => {
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2500);
		});
	}

	// Helper to convert remote URLs to base64 Data URLs for offline/CORS-safe canvas drawing
	async function getAsDataUrl(url: string): Promise<string> {
		if (!url) return '';
		if (url.startsWith('data:')) {
			if (url.includes(';base64,')) {
				return url;
			}
			// Base64-encode non-base64 data URL (e.g. utf-8 encoded SVG placeholders)
			const parts = url.split(',');
			if (parts.length >= 2) {
				const meta = parts[0];
				const data = parts[1];
				const decoded = decodeURIComponent(data);
				const base64Data = btoa(unescape(encodeURIComponent(decoded)));
				return `${meta.replace(/;utf8$/i, '').replace(/;charset=[^;]+/i, '')};base64,${base64Data}`;
			}
			return url;
		}
		try {
			// Fetch via server-side proxy to bypass CORS
			const proxyUrl = `/api/proxy?url=${encodeURIComponent(url)}`;
			const res = await fetch(proxyUrl);
			if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);
			const blob = await res.blob();
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result as string);
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
		} catch (err) {
			console.warn(`Could not convert ${url} to data URL via proxy (CORS or network error). Image will be omitted from PDF.`, err);
			return ''; // Return empty — callers check hasOwnProperty to distinguish 'failed' from 'not tried'
		}
	}

	// ── Build HTML for export (self-contained — does not depend on $state pagination) ──
	function buildFullHtml(dataUrls: Record<string, string> = {}): string {
		if (!activeBook) return '';
		const cs = activeBook.coverSettings;

		const opt = (activeBook.selectedCoverIndex !== null
			&& activeBook.coverOptions?.[activeBook.selectedCoverIndex])
			? activeBook.coverOptions[activeBook.selectedCoverIndex]
			: null;
		const coverStyle  = opt?.style || 'Warm Editorial';
		const coverStyleClass = `style-${coverStyle.toLowerCase().replace(/\s+/g, '-')}`;
		const isBaked = activeBook.coverOptions?.some(
			(o) => o.imageUrl && o.imageUrl === cs.bgImageUrl
		);

		// ─ Design tokens ─
		const titleFont     = cs.titleFont || 'Lora';
		const titleFontCss  = titleFont === 'Inter'   ? "'Inter',sans-serif"
						 : titleFont === 'Georgia' ? 'Georgia,serif'
						 : titleFont === 'Arial'   ? 'Arial,sans-serif'
						                           : "'Lora',Georgia,serif";
		const bodyFontCss   = (titleFont === 'Inter' || titleFont === 'Arial')
			? "'Inter',sans-serif" : "'Lora',Georgia,serif";
		const accent        = cs.authorColor  || '#8E7453';
		const titleColor    = cs.titleColor   || '#1A1612';
		const alignment     = cs.alignment    || 'left';
		const ruleW  = alignment === 'center' ? '60px' : alignment === 'right' ? '120px' : '100%';
		const ruleML = alignment === 'center' ? 'auto' : alignment === 'right' ? 'auto' : '0';
		const ruleMR = alignment === 'center' ? 'auto' : alignment === 'right' ? '0'    : 'auto';
		const flexAlign = alignment === 'center' ? 'center'
			          : alignment === 'right'  ? 'flex-end' : 'flex-start';
		const ornament = coverStyle === 'Dark Minimalist' ? '✦'
			         : coverStyle === 'Bold Graphic' ? '◆' : '❦';

		// ─ Cover page background image ─
		// Use the base64 data URL if successfully fetched; fall back to gradient if fetch failed (empty string) or no image.
		const rawBg = cs.bgImageUrl || '';
		const bgImg = rawBg && Object.prototype.hasOwnProperty.call(dataUrls, rawBg)
			? dataUrls[rawBg]   // base64 string, or '' if fetch failed
			: rawBg;            // not attempted — use remote URL as-is
		const coverBg = bgImg
			? `background-image:url('${bgImg}');background-size:cover;background-position:center;`
			: 'background:linear-gradient(135deg,#FAF7F2 0%,#EDE5D5 100%);';
		const overlayOpacity = isBaked ? 0 : (cs.overlayOpacity ?? 0);
		const coverBody = isBaked ? '' : `
			<div class="cover-inner">
					<div>
						<h1 class="cover-title">${activeBook.title}</h1>
						<p class="cover-subtitle">${activeBook.subtitle ?? ''}</p>
					</div>
					<p class="cover-author">${activeBook.author ?? ''}</p>
				</div>`;

			// ─ TOC ─
			const tocRows = activeBook.chapters
				.map((c, idx) => `<div class="toc-row">${getChapterLabel(c, idx)} — ${c.title}</div>`)
				.join('');

			// ─ Chapters: re-paginate synchronously from raw markdown ─
			const PAGE_W_PX  = 816;  // 8.5in @ 96dpi
			const PAGE_H_PX  = 1056; // 11in  @ 96dpi
			const PAD_TOP    = 96;   // 1in
			const PAD_BOTTOM = 96;   // 1in
			const PAD_LEFT   = 144;  // 1.5in (spine)
			const PAD_RIGHT  = 120;  // 1.25in
			const HDR_H      = 40;   // running header + margin
			const FTR_H      = 40;   // running footer + margin
			const BODY_H = PAGE_H_PX - PAD_TOP - PAD_BOTTOM - HDR_H - FTR_H - 48; // Subtract 48px for .chapter-content padding-top (0.5in)
			const BODY_W = PAGE_W_PX - PAD_LEFT - PAD_RIGHT;

			let chapHtml = '';
			let pageCounter = 1;

			// Inject the ebook styles into the parent document temporarily during pagination
			const styleEl = document.createElement('style');
			styleEl.id = 'pdf-measurer-styles';
			styleEl.innerHTML = `
				.pdf-measurer-container {
					font-family: ${activeBook.interiorDesign?.['--r-body-font'] ?? bodyFontCss};
					font-size: 12pt;
					line-height: 1.85;
					color: #1A1612;
				}
				.pdf-measurer-container p { margin: 0 0 10pt; text-indent: 1.4em; }
				.pdf-measurer-container p:first-of-type { text-indent: 0; }
				.pdf-measurer-container h2 { font-size: 15pt; font-weight: 600; margin: 18pt 0 8pt; font-family: ${titleFontCss}; }
				.pdf-measurer-container h3 { font-size: 12pt; font-weight: 600; margin: 14pt 0 6pt; font-family: ${titleFontCss}; }
				.pdf-measurer-container blockquote {
					border-left: ${activeBook.interiorDesign?.['--r-blockquote-border'] ?? `3pt solid ${accent}`};
					background: ${activeBook.interiorDesign?.['--r-blockquote-bg'] ?? 'transparent'};
					margin: 14pt 0;
					padding: ${activeBook.interiorDesign?.['--r-blockquote-padding'] ?? '0 0 0 14pt'};
					border-radius: ${activeBook.interiorDesign?.['--r-blockquote-border-radius'] ?? '0'};
					font-style: italic;
					color: ${activeBook.interiorDesign?.['--r-blockquote-color'] ?? '#6A6055'};
				}
				.pdf-measurer-container ul, .pdf-measurer-container ol { margin: 10pt 0; padding-left: 20pt; }
				.pdf-measurer-container li { margin-bottom: 5pt; }
				
				.pdf-measurer-container table {
					width: 100%;
					border-collapse: collapse;
					margin: 2rem 0;
					font-size: 0.95rem;
					text-align: left;
					line-height: 1.5;
				}
				.pdf-measurer-container th {
					background-color: ${activeBook.interiorDesign?.['--r-table-header-bg'] ?? '#0F172A'};
					color: #ffffff;
					font-weight: 600;
					padding: 0.75rem 1rem;
					border: 1px solid ${activeBook.interiorDesign?.['--r-border'] ?? '#e2e8f0'};
				}
				.pdf-measurer-container td {
					padding: 0.75rem 1rem;
					border: 1px solid ${activeBook.interiorDesign?.['--r-border'] ?? '#e2e8f0'};
				}
				.pdf-measurer-container tr:nth-child(even) {
					background-color: #f8fafc;
				}
				.pdf-measurer-container .callout-box,
				.pdf-measurer-container .tip-box,
				.pdf-measurer-container .warning-box,
				.pdf-measurer-container .key-rule-box {
					border-radius: 4px;
					padding: 1.25rem 1.5rem;
					margin: 2rem 0;
					box-sizing: border-box;
				}
				.pdf-measurer-container .callout-box {
					background-color: #faf7f2;
					border-left: 3.5px solid ${accent};
				}
				.pdf-measurer-container .tip-box {
					background-color: #ecfdf5;
					border-left: 3.5px solid #10b981;
				}
				.pdf-measurer-container .warning-box {
					background-color: #fef2f2;
					border-left: 3.5px solid #ef4444;
				}
				.pdf-measurer-container .key-rule-box {
					background-color: #fffbeb;
					border-left: 3.5px solid #f59e0b;
				}
				.pdf-measurer-container .callout-box__title {
					font-family: 'Inter',sans-serif;
					font-weight: 700;
					font-size: 0.85rem;
					text-transform: uppercase;
					letter-spacing: 1.5px;
					margin-bottom: 0.5rem;
					display: block;
				}
				.pdf-measurer-container .callout-box {
					color: ${accent};
				}
				.pdf-measurer-container .callout-box .callout-box__title {
					color: ${accent};
				}
				.pdf-measurer-container .tip-box .callout-box__title {
					color: #047857;
				}
				.pdf-measurer-container .warning-box .callout-box__title {
					color: #b91c1c;
				}
				.pdf-measurer-container .key-rule-box .callout-box__title {
					color: #b45309;
				}
				.pdf-measurer-container .callout-box__content {
					font-size: 0.95rem;
					line-height: 1.6;
					color: #1a1612;
				}
				.pdf-measurer-container .diagram-box {
					background-color: #f8fafc;
					border: 1.5px solid #e2e8f0;
					border-radius: 6px;
					padding: 1.5rem;
					margin: 2.5rem 0;
					text-align: center;
				}
				.pdf-measurer-container .diagram-box__title {
					font-family: ${titleFontCss};
					font-size: 1.25rem;
					font-weight: 600;
					color: ${titleColor};
					margin-bottom: 0.25rem;
				}
				.pdf-measurer-container .diagram-box__subtitle {
					font-size: 0.8rem;
					color: #64748b;
					margin-bottom: 1.5rem;
					text-transform: uppercase;
					letter-spacing: 1px;
				}
				.pdf-measurer-container .diagram-flow {
					display: flex;
					flex-wrap: wrap;
					justify-content: center;
					align-items: center;
					gap: 1rem;
					margin: 1rem 0;
				}
				.pdf-measurer-container .diagram-step {
					background-color: #ffffff;
					border: 1px solid #cbd5e1;
					border-radius: 4px;
					padding: 0.75rem 1rem;
					min-width: 140px;
					max-width: 200px;
					font-size: 0.85rem;
					text-align: left;
				}
				.pdf-measurer-container .diagram-step__num {
					font-weight: 700;
					color: ${accent};
					margin-bottom: 0.25rem;
					font-size: 0.8rem;
				}
				.pdf-measurer-container .diagram-step__text {
					font-weight: 500;
					color: #1e293b;
				}
				.pdf-measurer-container .diagram-arrow {
					font-size: 1.2rem;
					color: #cbd5e1;
				}
				.pdf-measurer-container .diagram-takeaway {
					margin-top: 1.5rem;
					padding-top: 1rem;
					border-top: 1px solid #e2e8f0;
					font-size: 0.85rem;
					font-style: italic;
					color: #475569;
				}
			`;
			document.head.appendChild(styleEl);

			activeBook.chapters.forEach((c, idx) => {
				if (c.status !== 'completed' || !c.content) return;

				// Replace inline markdown image URLs with their base64 equivalents
				// before parsing so html2canvas captures them without CORS issues.
				let contentForPdf = c.content;
				if (Object.keys(dataUrls).length > 0) {
					contentForPdf = contentForPdf.replace(
						/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,
						(_m, alt, url) => {
							const b64 = dataUrls[url];
							return b64 ? `![${alt}](${b64})` : `![${alt}](${url})`;
						}
					);
				}
				const fullMd   = parseMarkdown(contentForPdf, c.id);
				const rawIllust = c.illustrationUrl || '';
				const mappedIllust = rawIllust && Object.prototype.hasOwnProperty.call(dataUrls, rawIllust)
					? dataUrls[rawIllust]  // base64 or '' if fetch failed
					: rawIllust;           // not attempted
				const illustHtml = mappedIllust
					? `<div class="illustration"><img src="${mappedIllust}" alt="${c.title}" /></div>`
					: '';

				const tmp = document.createElement('div');
				tmp.innerHTML = fullMd;
				const blocks = Array.from(tmp.children).map((el) => el.outerHTML);

				type Page = { blocks: string[]; isFirst: boolean };
				const pages: Page[] = [];
				let cur: string[] = [];
				let curH = 0;
				const firstPageReserve = 160 + (mappedIllust ? 280 : 0);
				let budget = BODY_H - firstPageReserve;

				const measurer = document.createElement('div');
				measurer.className = 'pdf-measurer-container';
				measurer.style.cssText =
					`position:absolute;visibility:hidden;width:${BODY_W}px;` +
					`font-size:12pt;line-height:1.85;font-family:${bodyFontCss};`;
				document.body.appendChild(measurer);

				for (const blk of blocks) {
					measurer.innerHTML = blk;
					// Images inside <figure> tags report 0px height until loaded.
					// Substitute a realistic fixed height so the page-budget math
					// reserves enough space and doesn't overflow the page.
					const hasFigure = measurer.querySelector('figure') !== null;
					const isFullPage = hasFigure && blk.includes('diagram-box--image--fullpage');
					const h = isFullPage
						? BODY_H          // full-page images consume the entire page budget
						: hasFigure
						? 260 + 24        // 220pt max-height + caption + margins
						: measurer.offsetHeight + 24;
					// Full-page images always start on their own page
					if (isFullPage && cur.length > 0) {
						pages.push({ blocks: cur, isFirst: pages.length === 0 });
						cur = []; curH = 0; budget = BODY_H;
					}
					if (curH + h > budget && cur.length > 0) {
						pages.push({ blocks: cur, isFirst: pages.length === 0 });
						cur = []; curH = 0; budget = BODY_H;
					}
					cur.push(blk); curH += h;
					// After a full-page image, flush immediately so nothing shares the page
					if (isFullPage && cur.length > 0) {
						pages.push({ blocks: cur, isFirst: pages.length === 0 });
						cur = []; curH = 0; budget = BODY_H;
					}
				}
				if (cur.length) pages.push({ blocks: cur, isFirst: pages.length === 0 });
				document.body.removeChild(measurer);

				pages.forEach(({ blocks: pBlocks, isFirst }) => {
					const chapHeader = isFirst ? `
						<div class="chapter-header">
							<span class="chapter-label">${getChapterLabel(c, idx)}</span>
							<h2 class="chapter-title">${c.title}</h2>
							<hr class="chapter-rule">
						</div>${illustHtml}` : '';

					chapHtml += `
						<section class="chapter-section ${coverStyleClass}">
							<div class="running-header" ${isFirst ? 'style="visibility: hidden;"' : ''}>
								<span class="rh-book">${activeBook.title}</span>
								<span class="rh-chap">${getChapterLabel(c, idx)} — ${c.title}</span>
							</div>
							<div class="chapter-content ${isFirst ? 'has-drop-cap' : ''}">
								${chapHeader}
								${pBlocks.join('\n')}
							</div>
							<div class="running-footer">
								<span class="page-num">${pageCounter++}</span>
							</div>
						</section>`;
				});
			});
			document.head.removeChild(styleEl);

			return `<!doctype html>
	<html lang="en">
	<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>${activeBook.title}</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
	<style>
	*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
	body, .chapter-section, .cover-page, .toc-page {
	font-family: ${activeBook.interiorDesign?.['--r-body-font'] ?? bodyFontCss};
	font-size: 12pt;
	line-height: 1.85;
	color: #1A1612;
	background: #fff;
	-webkit-print-color-adjust: exact;
	print-color-adjust: exact;
	}
	@page { size: 8.5in 11in; margin: 0; }
	.cover-page {
	width: 816px;
	height: 1056px;
	position: relative;
	display: flex;
	flex-direction: column;
	padding: 80px 80px 80px 80px;
	${coverBg}
	text-align: ${alignment};
	overflow: hidden;
	page-break-after: always;
	flex-shrink: 0;
	}
	.cover-overlay {
	position: absolute; inset: 0;
	background: rgba(26,21,16,${overlayOpacity});
	}
	.cover-inner {
	position: relative; z-index: 2;
	height: 100%;
	display: flex; flex-direction: column;
	justify-content: ${cs.textPosition === 'top' ? 'flex-start' : cs.textPosition === 'bottom' ? 'flex-end' : 'center'};
	gap: 1.5rem;
	}
	.cover-title  { font-family: ${titleFontCss}; font-size: ${cs.titleSize ?? 36}px; font-weight: 700; color: ${cs.titleColor ?? '#fff'}; line-height: 1.2; }
	.cover-subtitle { font-family: 'Inter',sans-serif; font-size: ${cs.subtitleSize ?? 18}px; color: ${cs.subtitleColor ?? '#ccc'}; font-weight: 500; }
	.cover-author   { font-style: italic; font-size: ${cs.authorSize ?? 16}px; color: ${cs.authorColor ?? '#aaa'}; }

	.toc-page {
	width: 8.5in;
	min-height: 11in;
	padding: 1in 1.5in 1in 1.5in;
	page-break-after: always;
	box-sizing: border-box;
	}
	.toc-page h1 { font-family: ${titleFontCss}; font-size: 22pt; font-weight: 700; color: ${titleColor}; border-bottom: 1.5pt solid ${accent}; padding-bottom: 10px; margin-bottom: 24px; }
	.toc-row { padding: 7px 0; border-bottom: 1pt dotted #D9CFC2; font-size: 11pt; }

	.chapter-section {
	width: 8.5in;
	height: 11in;
	padding: 1in 1.25in 1in 1.5in;
	display: flex;
	flex-direction: column;
	justify-content: space-between;
	page-break-before: always;
	page-break-after: always;
	box-sizing: border-box;
	background: #fff;
	overflow: hidden;
	}
	.running-header {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	font-family: ${activeBook.interiorDesign?.['--r-header-font'] ?? `'Inter',sans-serif`};
	font-size: 7.5pt;
	text-transform: ${activeBook.interiorDesign?.['--r-header-transform'] ?? 'uppercase'};
	letter-spacing: ${activeBook.interiorDesign?.['--r-header-letter-spacing'] ?? '1.5pt'};
	color: ${activeBook.interiorDesign?.['--r-header-color'] ?? titleColor};
	border-bottom: ${activeBook.interiorDesign?.['--r-header-border'] ?? `0.5pt solid ${accent}`};
	opacity: ${activeBook.interiorDesign?.['--r-header-opacity'] ?? '0.75'};
	padding-bottom: 6pt;
	margin-bottom: 0;
	flex-shrink: 0;
	}
	.rh-book  { font-weight: 600; }
	.rh-chap  { font-style: italic; font-family: ${titleFontCss}; text-transform: none; letter-spacing: 0; }
	.chapter-content { flex: 1; overflow: hidden; padding-top: ${activeBook.interiorDesign?.['--r-chap-header-pad'] ?? '0.35in'}; }
	.chapter-header {
	margin-bottom: ${activeBook.interiorDesign?.['--r-chap-header-mb'] ?? '1.5rem'};
	text-align: ${alignment};
	display: flex;
	flex-direction: column;
	align-items: ${activeBook.interiorDesign?.['--r-header-align'] ?? flexAlign};
	background: ${activeBook.interiorDesign?.['--r-chap-header-bg'] ?? 'transparent'};
	border-left: ${activeBook.interiorDesign?.['--r-chap-header-bd-left'] ?? 'none'};
	border-top: ${activeBook.interiorDesign?.['--r-chap-header-bd-top'] ?? 'none'};
	padding: ${activeBook.interiorDesign?.['--r-chap-header-pd'] ?? '0'};
	}
	.chapter-label  {
		font-family: ${activeBook.interiorDesign?.['--r-label-font'] ?? `'Inter',sans-serif`};
		font-size: 8pt;
		text-transform: ${activeBook.interiorDesign?.['--r-label-transform'] ?? 'uppercase'};
		letter-spacing: ${activeBook.interiorDesign?.['--r-label-letter-spacing'] ?? '3pt'};
		color: ${activeBook.interiorDesign?.['--r-label-color'] ?? accent};
		background: ${activeBook.interiorDesign?.['--r-label-bg'] ?? 'transparent'};
		padding: ${activeBook.interiorDesign?.['--r-label-padding'] ?? '0'};
		border-radius: ${activeBook.interiorDesign?.['--r-label-border-radius'] ?? '0'};
		margin-bottom: 6pt;
		display: inline-block;
	}
	.chapter-title  {
		font-family: ${activeBook.interiorDesign?.['--r-title-font'] ?? titleFontCss};
		font-size: ${activeBook.interiorDesign?.['--r-chap-title-size'] ?? '20pt'};
		font-weight: ${activeBook.interiorDesign?.['--r-title-weight'] ?? '700'};
		text-transform: ${activeBook.interiorDesign?.['--r-title-transform'] ?? 'none'};
		letter-spacing: ${activeBook.interiorDesign?.['--r-title-letter-spacing'] ?? '0'};
		font-style: ${activeBook.interiorDesign?.['--r-title-style'] ?? 'normal'};
		line-height: 1.25;
		color: ${activeBook.interiorDesign?.['--r-title-color'] ?? titleColor};
		margin-bottom: 12pt;
	}
	.chapter-rule   { border: none; border-top: ${activeBook.interiorDesign?.['--r-rule-border'] ?? `1.5pt solid ${accent}`}; width: ${activeBook.interiorDesign?.['--r-rule-width'] ?? ruleW}; margin-left: ${ruleML}; margin-right: ${ruleMR}; }
	.illustration { margin: 16pt 0; text-align: center; }
	.illustration img { max-width: 100%; max-height: 240pt; border-radius: 3pt; }
	/* AI-generated realistic images rendered via markdown ![alt](url) */
	figure {
		margin: 16pt 0;
		text-align: center;
		page-break-inside: avoid;
		break-inside: avoid;
	}
	figure img {
		max-width: 100%;
		max-height: 220pt;
		width: auto;
		height: auto;
		border-radius: 3pt;
		display: block;
		margin: 0 auto;
		object-fit: contain;
	}
	figcaption {
		margin-top: 5pt;
		font-size: 8.5pt;
		font-style: italic;
		color: #6A6055;
		text-indent: 0;
	}
	/* Full-page image variant: fills the entire body area of a chapter page */
	.diagram-box--image--fullpage {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		margin: 0;
		padding: 0;
		page-break-inside: avoid;
		break-inside: avoid;
	}
	.diagram-box--image--fullpage figure {
		flex: 1;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
	}
	.diagram-box--image--fullpage figure img {
		max-width: 100%;
		max-height: 680pt;
		width: 100%;
		height: auto;
		object-fit: contain;
	}
	p { margin: 0 0 10pt; text-indent: 1.4em; hyphens: auto; }
	p:first-of-type { text-indent: 0; }
	.has-drop-cap p:first-of-type::first-letter {
	font-family: ${activeBook.interiorDesign?.['--r-dropcap-font'] ?? titleFontCss};
	font-size: 3.2em; float: left;
	line-height: 0.85; margin-top: 0.1em; margin-right: 0.1em;
	font-weight: ${activeBook.interiorDesign?.['--r-dropcap-weight'] ?? '700'};
	font-style: ${activeBook.interiorDesign?.['--r-dropcap-style'] ?? 'normal'};
	color: ${activeBook.interiorDesign?.['--r-dropcap-color'] ?? accent};
	}
	h2 { font-family: ${titleFontCss}; font-size: 15pt; font-weight: 600; color: ${activeBook.interiorDesign?.['--r-title-color'] ?? titleColor}; margin: 18pt 0 8pt; }
	h3 { font-family: ${titleFontCss}; font-size: 12pt; font-weight: 600; color: ${activeBook.interiorDesign?.['--r-title-color'] ?? titleColor}; margin: 14pt 0 6pt; }
	blockquote {
		border-left: ${activeBook.interiorDesign?.['--r-blockquote-border'] ?? `3pt solid ${accent}`};
		background: ${activeBook.interiorDesign?.['--r-blockquote-bg'] ?? 'transparent'};
		margin: 14pt 0;
		padding: ${activeBook.interiorDesign?.['--r-blockquote-padding'] ?? '0 0 0 14pt'};
		border-radius: ${activeBook.interiorDesign?.['--r-blockquote-border-radius'] ?? '0'};
		font-style: italic;
		color: ${activeBook.interiorDesign?.['--r-blockquote-color'] ?? '#6A6055'};
	}
	ul, ol { margin: 10pt 0; padding-left: 20pt; }
	li { margin-bottom: 5pt; }
	strong { font-weight: 700; }
	em { font-style: italic; }
	.running-footer {
	display: flex;
	justify-content: center;
	align-items: center;
	padding-top: 6pt;
	border-top: ${activeBook.interiorDesign?.['--r-footer-border'] ?? `0.5pt solid ${accent}`};
	opacity: ${activeBook.interiorDesign?.['--r-footer-opacity'] ?? '0.75'};
	flex-shrink: 0;
	}
	.page-num {
		font-family: ${activeBook.interiorDesign?.['--r-footer-font'] ?? `'Inter',sans-serif`};
		font-size: 8pt;
		color: ${activeBook.interiorDesign?.['--r-footer-color'] ?? titleColor};
		letter-spacing: ${activeBook.interiorDesign?.['--r-footer-letter-spacing'] ?? '1pt'};
	}

	/* All custom layout typography overrides are dynamically loaded from activeBook.interiorDesign. */

	table {
		width: 100%;
		border-collapse: collapse;
		margin: 1.5rem 0;
		font-size: 10pt;
		text-align: left;
		line-height: 1.45;
		table-layout: auto;
	}
	.table-container {
		width: 100%;
		overflow: visible;
	}
	.table-container table {
		margin-left: 0;
		margin-right: 0;
	}
	th, td {
		white-space: normal;
		overflow-wrap: break-word;
		word-break: normal;
		hyphens: none;
		vertical-align: top;
	}
	th {
		background-color: ${activeBook.interiorDesign?.['--r-table-header-bg'] ?? '#1e3a5f'};
		color: #ffffff;
		font-weight: 600;
		padding: 0.6rem 0.75rem;
		border: 1px solid ${activeBook.interiorDesign?.['--r-border'] ?? '#e2e8f0'};
		font-size: 9.5pt;
	}
	td {
		padding: 0.6rem 0.75rem;
		border: 1px solid ${activeBook.interiorDesign?.['--r-border'] ?? '#e2e8f0'};
		font-size: 10pt;
	}
	tr:nth-child(even) td {
		background-color: #f8fafc;
	}
	tr:nth-child(odd) td {
		background-color: #ffffff;
	}
	.diagram-box--table {
		padding: 0;
		overflow: visible;
	}
	.diagram-box--table .table-container {
		width: 100%;
	}

	.callout-box, .tip-box, .warning-box, .key-rule-box {
		border-radius: 4px;
		padding: 1.25rem 1.5rem;
		margin: 2rem 0;
		box-sizing: border-box;
	}
	.callout-box {
		background-color: #faf7f2;
		border-left: 3.5px solid ${accent};
	}
	.tip-box {
		background-color: #ecfdf5;
		border-left: 3.5px solid #10b981;
	}
	.warning-box {
		background-color: #fef2f2;
		border-left: 3.5px solid #ef4444;
	}
	.key-rule-box {
		background-color: #fffbeb;
		border-left: 3.5px solid #f59e0b;
	}
	.callout-box__title {
		font-family: 'Inter',sans-serif;
		font-weight: 700;
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 1.5px;
		margin-bottom: 0.5rem;
		display: block;
	}
	.callout-box .callout-box__title {
		color: ${accent};
	}
	.tip-box .callout-box__title {
		color: #047857;
	}
	.warning-box .callout-box__title {
		color: #b91c1c;
	}
	.key-rule-box .callout-box__title {
		color: #b45309;
	}
	.callout-box__content {
		font-size: 0.95rem;
		line-height: 1.6;
		color: #1a1612;
	}

	.diagram-box {
		background-color: #f8fafc;
		border: 1.5px solid #e2e8f0;
		border-radius: 6px;
		padding: 1.5rem;
		margin: 2.5rem 0;
		text-align: center;
	}
	.diagram-box__title {
		font-family: ${titleFontCss};
		font-size: 1.25rem;
		font-weight: 600;
		color: ${titleColor};
		margin-bottom: 0.25rem;
	}
	.diagram-box__subtitle {
		font-size: 0.8rem;
		color: #64748b;
		margin-bottom: 1.5rem;
		text-transform: uppercase;
		letter-spacing: 1px;
	}
	.diagram-flow {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 1rem;
		margin: 1rem 0;
	}
	.diagram-step {
		background-color: #ffffff;
		border: 1px solid #cbd5e1;
		border-radius: 4px;
		padding: 0.75rem 1rem;
		min-width: 140px;
		max-width: 200px;
		font-size: 0.85rem;
		text-align: left;
	}
	.diagram-step__num {
		font-weight: 700;
		color: ${accent};
		margin-bottom: 0.25rem;
		font-size: 0.8rem;
	}
	.diagram-step__text {
		font-weight: 500;
		color: #1e293b;
	}
	.diagram-arrow {
		font-size: 1.2rem;
		color: #cbd5e1;
		user-select: none;
	}
	.diagram-takeaway {
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid #e2e8f0;
		font-size: 0.85rem;
		font-style: italic;
		color: #475569;
	}

	/* Hide all interactive edit buttons — never visible in PDF */
	.diagram-box__actions,
	.edit-trigger,
	.edit-trigger--diagram,
	.edit-trigger--inline {
		display: none !important;
		visibility: hidden !important;
		pointer-events: none !important;
	}

	@media print {
	body { background: #fff; }
	.cover-page, .toc-page, .chapter-section { page-break-after: always; page-break-inside: avoid; break-inside: avoid; }
	table, .callout-box, .diagram-box, blockquote { page-break-inside: avoid; break-inside: avoid; }
	}
	</style>
	</head>
	<body>
	<div class="cover-page">
		<div class="cover-overlay"></div>
		${coverBody}
	</div>
	<div class="toc-page">
		<h1>Contents</h1>
		${tocRows}
	</div>
	${chapHtml}
	</body>
	</html>`;
		}

		// ── Export HTML ──────────────────────────────────────────────────────────
		async function handleCompileHtml() {
			if (!activeBook) return;

			// Convert images to data URLs so the HTML file is self-contained
			const imageUrls: string[] = [];
			const cs = activeBook.coverSettings;
			if (cs.bgImageUrl) imageUrls.push(cs.bgImageUrl);
			activeBook.chapters.forEach((c) => {
				if (c.illustrationUrl) imageUrls.push(c.illustrationUrl);
			});
			const dataUrls: Record<string, string> = {};
			await Promise.all(imageUrls.map(async (url) => {
				dataUrls[url] = await getAsDataUrl(url);
			}));

			const html = buildFullHtml(dataUrls);
			const blob = new Blob([html], { type: 'text/html' });
			const blobUrl = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = blobUrl;
			a.download = `${activeBook.title.toLowerCase().replace(/\s+/g, '_')}_ebook.html`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(blobUrl);
		}

		// ── PDF Export — jsPDF + html2canvas (industry-standard, no html2pdf.js wrapper) ──
		//
		// html2pdf.js 0.14.0 internally calls jsPDF.getPageSize() which was removed in
		// jsPDF 4.x, causing a silent TypeError that aborts the entire export chain.
		// We bypass html2pdf.js entirely and drive jsPDF + html2canvas ourselves so we
		// control every step and avoid the version incompatibility.
		//
		// Rendering approach:
		//   • Write the full HTML document into a hidden <iframe> so it gets its own
		//     CSS cascade, its own <head> (fonts, styles), and correct layout dimensions.
		//   • Wait for the iframe's load event and font readiness before capturing.
		//   • Query every page element (.cover-page, .toc-page, .chapter-section) and
		//     capture each one individually with html2canvas at 2× DPI (print quality).
		//   • Add each captured image as a full-bleed letter-size page in jsPDF.
		//   • Output as Blob → object URL → programmatic <a> click.
		async function handleExportPdf() {
			if (!activeBook || isPdfExporting) return;
			isPdfExporting = true;

			let iframe: HTMLIFrameElement | null = null;

			try {
				// ── Step 1: Resolve all images to base64 data URLs ─────────────────
				// html2canvas cannot load cross-origin images even with useCORS when
				// the response lacks CORS headers (common for AI-generated image CDNs).
				// Converting to data: URLs first makes capture 100% reliable.
				const imageUrls: string[] = [];
				const cs = activeBook.coverSettings;
				if (cs.bgImageUrl) imageUrls.push(cs.bgImageUrl);
				activeBook.chapters.forEach((c) => {
					if (c.illustrationUrl) imageUrls.push(c.illustrationUrl);
					// Also collect inline markdown images embedded in chapter content
					if (c.content) {
						const mdImgRe = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
						let m: RegExpExecArray | null;
						while ((m = mdImgRe.exec(c.content)) !== null) {
							if (!imageUrls.includes(m[1])) imageUrls.push(m[1]);
						}
					}
				});

				const dataUrls: Record<string, string> = {};
				await Promise.all(
					imageUrls.map(async (url) => {
						dataUrls[url] = await getAsDataUrl(url);
					})
				);

				// ── Step 2: Build the self-contained HTML document ─────────────────
				// Strip lazy-loading attributes so html2canvas can capture all images.
				const fullHtml = buildFullHtml(dataUrls).replace(/\sloading="lazy"/g, '');

				// ── Step 3: Mount a hidden iframe and write the document into it ───
				// An iframe gives the document its own CSS scope — styles in the
				// generated HTML are fully isolated from the host page.
				iframe = document.createElement('iframe');
				// Visually hidden but still rendered (visibility:hidden would prevent
				// layout; left:-9999px keeps it off-screen while allowing offsetHeight).
				iframe.style.cssText =
					'position:fixed;left:-9999px;top:0;width:8.5in;height:11in;border:0;opacity:0;pointer-events:none;';
				document.body.appendChild(iframe);

				await new Promise<void>((resolve, reject) => {
					iframe!.onload = () => resolve();
					iframe!.onerror = () => reject(new Error('iframe failed to load'));
					// srcdoc is the safest cross-browser way to inject a full HTML doc
					iframe!.srcdoc = fullHtml;
				});

				const iDoc = iframe.contentDocument!;
				const iWin = iframe.contentWindow!;

				// ── Step 4: Wait for fonts inside the iframe ───────────────────────
				if (iDoc.fonts) await iDoc.fonts.ready;

				// ── Step 4b: Wait for all <img> tags inside the iframe to load ────
				// html2canvas captures a pixel snapshot — any image that hasn't
				// finished loading will appear blank. Force-load all images first.
				const iframeImgs = Array.from(iDoc.querySelectorAll<HTMLImageElement>('img'));
				await Promise.all(
					iframeImgs.map(
						(img) =>
							img.complete
								? Promise.resolve()
								: new Promise<void>((res) => {
										img.onload = () => res();
										img.onerror = () => res(); // still proceed if one fails
									})
					)
				);

				// Extra settle time for background-image paints and layout reflow
				await new Promise((resolve) => setTimeout(resolve, 800));

				// ── Step 5: Collect page elements ─────────────────────────────────
				const pageEls = Array.from(
					iDoc.querySelectorAll<HTMLElement>('.cover-page, .toc-page, .chapter-section')
				);

				if (pageEls.length === 0) {
					throw new Error(
						'No page elements found in the generated document. ' +
						'Make sure at least one chapter has been written.'
					);
				}

				console.log(`[PDF] Capturing ${pageEls.length} page(s)…`);

				// ── Step 6: Load html2canvas ───────────────────────────────────────
				const html2canvasModule = await import('html2canvas');
				// @ts-ignore — ESM/CJS interop
				const html2canvas = html2canvasModule.default ?? html2canvasModule;

				// ── Step 7: Load jsPDF ─────────────────────────────────────────────
				const { jsPDF } = await import('jspdf');

				// Letter page: 8.5 × 11 in
				const PDF_W_IN = 8.5;
				const PDF_H_IN = 11;
				// Pixel dimensions at 96 dpi (browser default) × 2 for print quality
				const SCALE     = 2;
				const PX_W      = 816  * SCALE;  // 8.5in @ 96dpi × scale
				const PX_H      = 1056 * SCALE;  // 11in  @ 96dpi × scale

				const pdf = new jsPDF({
					orientation: 'portrait',
					unit: 'in',
					format: [PDF_W_IN, PDF_H_IN],
					compress: true
				});

				// ── Step 8: Capture each page and add to PDF ───────────────────────
				for (let i = 0; i < pageEls.length; i++) {
					const el = pageEls[i];

					const canvas = await html2canvas(el, {
						scale: SCALE,
						useCORS: true,
						allowTaint: false,
						logging: false,
						// Target the iframe's window so computed styles resolve correctly
						windowWidth:  iWin.innerWidth,
						windowHeight: iWin.innerHeight,
						width:  816,
						height: 1056,
						backgroundColor: '#ffffff'
					});

					const imgData = canvas.toDataURL('image/jpeg', 0.97);

					if (i > 0) pdf.addPage([PDF_W_IN, PDF_H_IN], 'portrait');

					// Add image full-bleed (no margins — the page layout handles all spacing)
					pdf.addImage(imgData, 'JPEG', 0, 0, PDF_W_IN, PDF_H_IN, undefined, 'FAST');

					console.log(`[PDF] Page ${i + 1}/${pageEls.length} captured`);
				}

				// ── Step 9: Download ───────────────────────────────────────────────
				const filename = `${activeBook.title.toLowerCase().replace(/\s+/g, '_')}_ebook.pdf`;
				const blob = pdf.output('blob');
				const blobUrl = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = blobUrl;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
				// Short delay before revoking so the browser has time to start the download
				setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

			} catch (err) {
				console.error('[PDF] Export error:', err);
				alert(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				iframe?.remove();
				isPdfExporting = false;
			}
		}

		function isLightColor(color: string | null | undefined): boolean {
			if (!color) return false;
			const hex = color.replace('#', '');
			if (hex.length === 3) {
				const r = parseInt(hex[0] + hex[0], 16);
				const g = parseInt(hex[1] + hex[1], 16);
				const b = parseInt(hex[2] + hex[2], 16);
				return (r * 299 + g * 587 + b * 114) / 1000 > 200;
			}
			if (hex.length === 6) {
				const r = parseInt(hex.slice(0, 2), 16);
				const g = parseInt(hex.slice(2, 4), 16);
				const b = parseInt(hex.slice(4, 6), 16);
				return (r * 299 + g * 587 + b * 114) / 1000 > 200;
			}
			return false;
		}

		// Design values based on the cover style and options
		let coverStyle = $derived.by(() => {
			if (activeBook && activeBook.selectedCoverIndex !== null && activeBook.coverOptions?.[activeBook.selectedCoverIndex]) {
				return activeBook.coverOptions[activeBook.selectedCoverIndex].style;
			}
			const font = coverSettings?.titleFont;
			if (font === 'Inter' || font === 'Arial') {
				return 'Bold Graphic';
			}
			return 'Warm Editorial';
		});

		let designFontFamily = $derived(
			coverSettings?.titleFont === 'Lora' ? 'Lora, Georgia, serif' :
			coverSettings?.titleFont === 'Georgia' ? 'Georgia, serif' :
			coverSettings?.titleFont === 'Inter' ? '"Inter", sans-serif' :
			coverSettings?.titleFont === 'Arial' ? 'Arial, sans-serif' :
			'Lora, Georgia, serif'
		);

		let designBodyFont = $derived(
			coverSettings?.titleFont === 'Inter' || coverSettings?.titleFont === 'Arial'
				? '"Inter", sans-serif'
				: 'Lora, Georgia, serif'
		);

		let designAccentColor = $derived.by(() => {
			const ac = coverSettings?.authorColor;
			if (ac && !isLightColor(ac)) return ac;
			return '#8E7453';
		});

		let designTitleColor = $derived.by(() => {
			const tc = coverSettings?.titleColor;
			if (tc && !isLightColor(tc)) return tc;
			if (coverStyle === 'Bold Graphic') return '#0F172A';
			if (coverStyle === 'Dark Minimalist') return '#1A1612';
			return '#3D2B1A';
		});

		let designSubtitleColor = $derived.by(() => {
			const sc = coverSettings?.subtitleColor;
			if (sc && !isLightColor(sc)) return sc;
			if (coverStyle === 'Bold Graphic') return '#334155';
			if (coverStyle === 'Dark Minimalist') return '#57534E';
			return '#5C4033';
		});

		let designOrnament = $derived.by(() => {
			if (coverStyle === 'Dark Minimalist') return '✦';
			if (coverStyle === 'Bold Graphic') return '◆';
			return '❦';
		});

		let ruleWidth = $derived(
			coverSettings?.alignment === 'center' ? '60px' :
			coverSettings?.alignment === 'right' ? '120px' : '100%'
		);
		let ruleMarginLeft = $derived(
			coverSettings?.alignment === 'center' ? 'auto' :
			coverSettings?.alignment === 'right' ? 'auto' : '0'
		);
		let ruleMarginRight = $derived(
			coverSettings?.alignment === 'center' ? 'auto' :
			coverSettings?.alignment === 'right' ? '0' : 'auto'
		);
		let headerFlexAlign = $derived(
			coverSettings?.alignment === 'center' ? 'center' :
			coverSettings?.alignment === 'right' ? 'flex-end' : 'flex-start'
		);

		let designStyles = $derived.by(() => {
			const base = [
				`--design-key: ${designKey}`,
				`--chapter-font-family: ${designFontFamily}`,
				`--chapter-body-font: ${designBodyFont}`,
				`--chapter-accent-color: ${designAccentColor}`,
				`--chapter-title-color: ${designTitleColor}`,
				`--chapter-subtitle-color: ${designSubtitleColor}`,
				`--chapter-alignment: ${coverSettings?.alignment || 'center'}`,
				`--chapter-rule-width: ${ruleWidth}`,
				`--chapter-rule-margin-left: ${ruleMarginLeft}`,
				`--chapter-rule-margin-right: ${ruleMarginRight}`,
				`--header-flex-align: ${headerFlexAlign}`
			];

			if (activeBook?.interiorDesign) {
				for (const [key, val] of Object.entries(activeBook.interiorDesign)) {
					base.push(`${key}: ${val}`);
				}
			}

			return base.join('; ');
		});

		let currentCoverSignature = $derived.by(() => {
			if (!activeBook) return '';
			return JSON.stringify({
				selectedCoverIndex: activeBook.selectedCoverIndex,
				style: coverStyle,
				titleFont: activeBook.coverSettings?.titleFont,
				alignment: activeBook.coverSettings?.alignment,
				textPosition: activeBook.coverSettings?.textPosition,
				titleColor: activeBook.coverSettings?.titleColor,
				subtitleColor: activeBook.coverSettings?.subtitleColor,
				authorColor: activeBook.coverSettings?.authorColor,
				bgImageUrl: activeBook.coverSettings?.bgImageUrl,
				overlayOpacity: activeBook.coverSettings?.overlayOpacity,
				preset: appliedPreset,
				customInstructions: appliedCustomInstructions
			});
		});

		let isGeneratingInteriorDesign = $state(false);

		async function generateInteriorDesignAI(force = false) {
			if (!activeBook || isGeneratingInteriorDesign) return;

			appliedPreset = headerFooterPreset;
			appliedCustomInstructions = interiorCustomInstructions;

			await tick();
			const signature = currentCoverSignature;
			if (!force && activeBook.interiorDesign && activeBook.interiorDesign._coverSignature === signature) return;

			isGeneratingInteriorDesign = true;
			try {
				const res = await fetch('/api/design-interior', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						coverSettings: activeBook.coverSettings,
						coverStyle: coverStyle,
						bookTitle: activeBook.title,
						apiKey: globalState.apiKeys.anthropicKey,
						useMockMode: globalState.apiKeys.useMockMode,
						headerFooterPreset: appliedPreset,
						customInstructions: appliedCustomInstructions
					})
				});
				const data = await res.json();
				if (data.success && data.design) {
					const designWithSig = {
						...data.design,
						_coverSignature: signature
					};
					globalState.updateBookInteriorDesign(activeBook.id, designWithSig);
				}
			} catch (err) {
				console.error('Failed to generate AI interior design:', err);
			} finally {
				isGeneratingInteriorDesign = false;
			}
		}

		$effect(() => {
			if (activeBook && typeof window !== 'undefined') {
				const sig = currentCoverSignature;
				if (!activeBook.interiorDesign || activeBook.interiorDesign._coverSignature !== sig) {
					generateInteriorDesignAI();
				}
			}
		});
		// Key: chapter.id
	// Value: array of pages; each page is { blocks: string[], startIdx: number, endIdx: number }
	// startIdx/endIdx are the markdown paragraph-block indices this page covers.
	interface PageSlice { blocks: string[]; startIdx: number; endIdx: number; }
	let paginatedChapters = $state<Record<string, PageSlice[]>>({});

	function splitHtmlIntoBlocks(html: string): string[] {
		if (typeof document === 'undefined') return [html];
		const temp = document.createElement('div');
		temp.innerHTML = html;
		return Array.from(temp.children).map(child => child.outerHTML);
	}

	function calculateOverallPageNumber(chapIdx: number, pageIdx: number): number {
		if (!activeBook) return 1;
		let total = 0;
		for (let i = 0; i < chapIdx; i++) {
			const chap = activeBook.chapters[i];
			const pages = paginatedChapters[chap.id];
			total += pages ? pages.length : 1;
		}
		return total + pageIdx + 1;
	}

	function paginateAllChapters() {
		if (!activeBook) return;

		const measureDiv = document.createElement('div');
		measureDiv.style.position = 'absolute';
		measureDiv.style.visibility = 'hidden';
		measureDiv.style.width = 'calc(8.5in - 2.75in)';
		measureDiv.style.fontSize = `${fontSize}px`;
		measureDiv.style.lineHeight = '1.85';
		measureDiv.style.fontFamily = designBodyFont;
		measureDiv.className = 'chapter-body';
		document.body.appendChild(measureDiv);

		const maxPageHeight = 700;
		const newPaginated: Record<string, PageSlice[]> = {};

		for (const chap of activeBook.chapters) {
			if (chap.status !== 'completed' || !chap.content) {
				newPaginated[chap.id] = [{ blocks: ['<p>This chapter has not been written yet.</p>'], startIdx: 0, endIdx: 1 }];
				continue;
			}

			const fullHtml = parseMarkdown(chap.content, chap.id);
			const blocks = splitHtmlIntoBlocks(fullHtml);
			const pages: PageSlice[] = [];
			let currentBlocks: string[] = [];
			let currentHeight = 0;
			let currentStartIdx = 0;

			// Reserve space for the chapter header on page 1.
			// Chapter label + title + rule ≈ 120px.
			// Illustration (when present) has max-height 380px + margins ≈ 440px.
			// Use a conservative combined reserve so text is never clipped.
			const hasIllustration = !!chap.illustrationUrl;
			currentHeight += hasIllustration ? 440 : 160;

			for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
				const block = blocks[blockIdx];
				measureDiv.innerHTML = block;
				const blockHeight = measureDiv.offsetHeight + 24;

				if (currentHeight + blockHeight > maxPageHeight && currentBlocks.length > 0) {
					pages.push({ blocks: currentBlocks, startIdx: currentStartIdx, endIdx: blockIdx });
					currentBlocks = [block];
					currentHeight = blockHeight;
					currentStartIdx = blockIdx;
				} else {
					currentBlocks.push(block);
					currentHeight += blockHeight;
				}
			}

			if (currentBlocks.length > 0) {
				pages.push({ blocks: currentBlocks, startIdx: currentStartIdx, endIdx: blocks.length });
			}

			newPaginated[chap.id] = pages;
		}

		document.body.removeChild(measureDiv);
		paginatedChapters = newPaginated;
	}

		$effect(() => {
			if (activeBook && activeBook.chapters && typeof window !== 'undefined') {
				paginateAllChapters();
			}
		});
	</script>

	<svelte:head>
		<title>E-Reader – Ebook Automator</title>
	</svelte:head>

	<div class="reader-workspace">
		{#if !activeBook}
			<div class="no-book-wrapper">
				<div class="card no-book">
					<p class="font-serif">No active ebook selected.</p>
					<p class="small"><a href="/">Go to Write panel</a> to generate a book first.</p>
				</div>
			</div>
		{:else}
			<div class="reader-layout theme-{readerTheme}">

				<!-- Left nav sidebar -->
				<aside class="reader-sidebar">
					<div class="book-spine font-serif">
						<h4>{activeBook.title}</h4>
						<p class="by">by {activeBook.author}</p>
					</div>

					<nav class="toc-nav font-serif">
						<button
							class="toc-item {activeSection === 'cover' ? 'active' : ''}"
							onclick={() => scrollTo('cover')}
						>
							<BookMarked size={14} /> Cover
						</button>

						{#each activeBook.chapters as chap, idx}
							<button
								class="toc-item {activeSection === idx ? 'active' : ''}"
								onclick={() => scrollTo(idx)}
								disabled={chap.status !== 'completed'}
							>
								<span class="chap-num">{getChapterLabel(chap, idx)}</span>
								<span class="chap-title">{chap.title}</span>
							</button>
						{/each}
					</nav>

					<div class="sidebar-actions">
						<div class="font-row">
							<span class="label font-serif">Size:</span>
							<button class="font-btn" onclick={() => fontSize = Math.max(fontSize - 1, 14)}>A-</button>
							<span class="font-val font-serif">{fontSize}px</span>
							<button class="font-btn" onclick={() => fontSize = Math.min(fontSize + 1, 26)}>A+</button>
						</div>

						<div class="form-group font-row" style="display:flex; flex-direction:column; gap:0.4rem; margin-top: 0.5rem; margin-bottom: 0.5rem; width: 100%;">
							<span class="label font-serif">Header/Footer Style:</span>
							<select
								class="preset-select"
								value={headerFooterPreset}
								onchange={(e: Event) => {
									headerFooterPreset = (e.target as HTMLSelectElement).value;
									applyPresetInstantly(headerFooterPreset);
								}}
								style="width: 100%; padding: 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color); font-size: 0.85rem;"
							>
								<optgroup label="Serif / Literary">
									<option value="Classical Editorial">Classical Editorial — Serif, thin rules</option>
									<option value="Royal Elegance">Royal Elegance — Italic serif, double rules</option>
									<option value="Vintage Academic">Vintage Academic — Georgia, dotted rules</option>
									<option value="Aesthetic Literary">Aesthetic Literary — Light italic, no lines</option>
								</optgroup>
								<optgroup label="Sans-Serif / Modern">
									<option value="Modern Minimalist">Modern Minimalist — Sans, no rules</option>
									<option value="Bold Tech / Graphic">Bold Tech / Graphic — Heavy sans, thick rules</option>
								</optgroup>
								<optgroup label="Specialty">
									<option value="Technical Mono">Technical Mono — Monospace, dashed rules</option>
									<option value="Hidden / None">Hidden / None — No headers or footers</option>
								</optgroup>
							</select>
						</div>

						<div class="form-group font-row" style="display:flex; flex-direction:column; gap:0.4rem; margin-bottom: 0.75rem; width: 100%;">
							<span class="label font-serif">Custom Style Prompt:</span>
							<input
								type="text"
								class="style-input"
								placeholder="e.g. elegant gold lines, centered page numbers..."
								value={interiorCustomInstructions}
								oninput={(e: Event) => interiorCustomInstructions = (e.target as HTMLInputElement).value}
								style="width: 100%; padding: 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color); font-size: 0.85rem;"
							/>
						</div>

						<button
							class="action-btn font-serif"
							onclick={() => { generateInteriorDesignAI(true); designKey = Date.now(); }}
							title="Generate dynamic, contrast-safe interior styles based on the cover using Claude AI"
							disabled={isGeneratingInteriorDesign}
						>
							{#if isGeneratingInteriorDesign}
								<span class="spinner"></span> Restyling...
							{:else}
								<RefreshCcw size={14} /> AI Restyle
							{/if}
						</button>
						<button
							class="action-btn action-btn--primary font-serif"
							onclick={handleExportPdf}
							disabled={isPdfExporting}
						>
							{#if isPdfExporting}
								<span class="spinner"></span> Generating...
							{:else}
								<FileDown size={14} /> Export PDF
							{/if}
						</button>
					</div>
				</aside>

				<!-- Continuous scroll reader -->
				<main class="reader-scroll-area" bind:this={readerScrollArea}>

					<section
						data-section-id="cover"
						use:registerSection={'cover'}
						class="cover-section-container"
					>
						{#if coverSettings}
						<div
							class="cover-hero"
							style="
								background-image: {coverSettings.bgImageUrl ? `url(${coverSettings.bgImageUrl})` : 'none'};
								background-color: {coverSettings.bgImageUrl ? 'transparent' : '#FAF7F2'};
								background-size: cover;
								background-position: center;
								text-align: {coverSettings.alignment};
							"
						>
							<div class="cover-overlay" style="background-color: rgba(26,21,16,{isBakedCover ? 0 : coverSettings.overlayOpacity});"></div>
							{#if !isBakedCover}
								<div class="cover-text-layer" style="justify-content: {coverSettings.textPosition === 'top' ? 'flex-start' : coverSettings.textPosition === 'bottom' ? 'flex-end' : 'center'};">
									<div class="title-sub">
										<h1 class="cover-title" style="color:{coverSettings.titleColor};font-size:{coverSettings.titleSize * 1.2}px;font-family:{coverSettings.titleFont === 'Lora' || coverSettings.titleFont === 'Georgia' ? 'Lora, Georgia' : 'Inter, sans-serif'};">
											{activeBook.title}
										</h1>
										{#if activeBook.subtitle}
											<p class="cover-subtitle" style="color:{coverSettings.subtitleColor};font-size:{coverSettings.subtitleSize * 1.2}px;">
												{activeBook.subtitle}
											</p>
										{/if}
									</div>
									<p class="cover-author-text" style="color:{coverSettings.authorColor};font-size:{coverSettings.authorSize}px;">
										{activeBook.author ?? ''}
									</p>
								</div>
							{/if}
						</div>
						{/if}
				</section>

				<!-- Chapter sections — continuous flow of paginated sheets -->
				{#each activeBook.chapters as chap, chapIdx}
					{@const chapPages = paginatedChapters[chap.id] || [{ blocks: ['<p>Loading…</p>'], startIdx: 0, endIdx: 1 }]}
					{#each chapPages as pageSlice, pageIdx}
						<section
							data-section-id="{chapIdx}-{pageIdx}"
							use:registerSection={pageIdx === 0 ? chapIdx : `${chapIdx}-${pageIdx}`}
							style={designStyles}
						>
							<!-- Book page wrap — centres the sheet in the scroll viewport -->
							<div class="book-page-wrap">

								<!-- US Letter sheet: 8.5 × 11 in — header, body, and footer all live inside -->
								<div class="book-page-card style-{coverStyle.toLowerCase().replace(/\s+/g, '-')}" style="font-size: {fontSize}px;">

									<!-- Running header — top of page, suppressed on page 1 of the chapter -->
									<header class="running-header" style={pageIdx === 0 ? "display: none;" : ""} aria-hidden="true">
										<span class="running-header__book">{activeBook.title}</span>
										<span class="running-header__chapter">{getChapterLabel(chap, chapIdx)} — {chap.title}</span>
									</header>

									<!-- Body content area — scrolls between header and footer -->
									<div class="page-body">

										{#if pageIdx === 0}
											<!-- Chapter header — label, title, rule -->
											<div class="chapter-header">
												<span class="chapter-label">{getChapterLabel(chap, chapIdx)}</span>
												<h2 class="chapter-title">{chap.title}</h2>
												<hr class="chapter-rule" />
											</div>
										{/if}

										{#if pageIdx === 0 && chap.illustrationUrl}
											<!-- Illustration with its own edit trigger -->
											<div class="chapter-illust">
												<img src={chap.illustrationUrl} alt="Illustration – {chap.title}" />
												<button
													class="edit-trigger edit-trigger--illust"
													title="Edit this illustration"
													aria-label="Edit illustration for {chap.title}"
													onclick={() => openEditPanel({
														scope: 'illustration',
														chapterId: chap.id,
														chapterTitle: chap.title,
														chapterOrder: chap.order,
														chapterSummary: chap.summary,
														chapterContent: chap.content,
														researchNotes: chap.researchNotes,
														illustrationUrl: chap.illustrationUrl ?? '',
														illustrationPrompt: chap.summary
															? `${activeBook?.useUltraRealistic || activeBook?.coverSettings?.useUltraRealistic ? 'A hyperrealistic, award-winning photograph, highly detailed photorealistic render, 8k resolution, cinematic lighting, professional composition' : 'A high-quality editorial illustration'} for a chapter titled "${chap.title}" about: ${chap.summary}.`
															: `Editorial illustration: "${chap.title}"`
													})}
												>
												<ImageIcon size={13} /> Edit Illustration
											</button>
											</div>
										{/if}

										<div class="chapter-body" class:has-drop-cap={pageIdx === 0}>
											{#each pageSlice.blocks as block}
												{@html block}
											{/each}
										</div>

									</div>

									<!-- Running footer — page number + contextual edit actions -->
									<footer class="page-footer" aria-label="Page {calculateOverallPageNumber(chapIdx, pageIdx)}">
										<span class="page-footer__rule"></span>
										<span class="page-footer__num">{calculateOverallPageNumber(chapIdx, pageIdx)}</span>
										<span class="page-footer__rule"></span>

										<!-- Edit actions — revealed on card hover -->
										<div class="page-edit-actions" aria-label="Edit actions for page {calculateOverallPageNumber(chapIdx, pageIdx)}">
											<button
												class="page-edit-btn"
												title="Rewrite this page with AI"
												onclick={() => openEditPanel({
													scope: 'page',
													chapterId: chap.id,
													chapterTitle: chap.title,
													chapterOrder: chap.order,
													chapterSummary: chap.summary,
													chapterContent: chap.content,
													researchNotes: chap.researchNotes,
													pageIndex: pageIdx,
													pageStartIdx: pageSlice.startIdx,
													pageEndIdx: pageSlice.endIdx,
													pageText: htmlToPlainText(pageSlice.blocks.join(''))
												})}
											>
											<PenLine size={12} /> Edit Page
										</button>

											{#if pageIdx === 0}
												<button
													class="page-edit-btn page-edit-btn--chapter"
													title="Rewrite the entire chapter with AI"
													onclick={() => openEditPanel({
														scope: 'chapter',
														chapterId: chap.id,
														chapterTitle: chap.title,
														chapterOrder: chap.order,
														chapterSummary: chap.summary,
														chapterContent: chap.content,
														researchNotes: chap.researchNotes
													})}
												>
												<BookOpen size={12} /> Edit Chapter
											</button>
											{/if}
										</div>
									</footer>

								</div>

							</div>

							<!-- Page separator visual gutter (space between pages) -->
							{#if !(chapIdx === activeBook.chapters.length - 1 && pageIdx === chapPages.length - 1)}
								<div class="chapter-separator" aria-hidden="true">
									<div class="sep-line"></div>
									<span class="sep-ornament">{designOrnament}</span>
									<div class="sep-line"></div>
								</div>
							{/if}
						</section>
					{/each}
				{/each}

			</main>

			{#if editTarget}
				<!-- ── AI Content Editor Drawer ──────────────────────────────────── -->
				<!-- Backdrop -->
				<div
					class="edit-backdrop"
					aria-hidden="true"
					onclick={closeEditPanel}
				></div>

				<div class="edit-drawer" role="dialog" aria-modal="true" aria-label="AI Content Editor">
					<!-- Header -->
					<div class="edit-drawer__header">
						<div class="edit-drawer__title-row">
							<span class="edit-drawer__scope-badge edit-drawer__scope-badge--{editTarget.scope}{editTarget.scope === 'diagram' ? '--' + (editTarget.diagramKind ?? 'fence') : ''}">
								{#if editTarget.scope === 'page'}
									<PenLine size={11} /> Page
								{:else if editTarget.scope === 'chapter'}
									<BookOpen size={11} /> Chapter
								{:else if editTarget.scope === 'add-page'}
									<Sparkles size={11} /> Add Page
								{:else if editTarget.scope === 'diagram' && editTarget.diagramKind === 'image'}
									<Camera size={11} /> Image
							{:else if editTarget.scope === 'diagram' && editTarget.diagramKind === 'table'}
									<Wand2 size={11} /> Table
								{:else if editTarget.scope === 'diagram' && editTarget.diagramKind === 'inline'}
									<Wand2 size={11} /> Visual Block
								{:else if editTarget.scope === 'diagram'}
									<Wand2 size={11} /> Diagram
								{:else}
									<ImageIcon size={11} /> Illustration
								{/if}
							</span>
							<h3 class="edit-drawer__title font-serif">
								{editTarget.scope === 'page'
									? `Edit Page ${(editTarget.pageIndex ?? 0) + 1} · Ch. ${editTarget.chapterOrder}`
									: editTarget.scope === 'chapter'
									? `Edit Chapter ${editTarget.chapterOrder}`
									: editTarget.scope === 'add-page'
									? `Add Page After Page ${(editTarget.pageIndex ?? 0) + 1}`
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'image'
									? `Edit Image`
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'table'
									? `Edit Table`
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'inline'
									? `Edit Visual Block`
									: editTarget.scope === 'diagram'
									? `Edit Diagram`
									: `Edit Illustration`}
							</h3>
						</div>
						<p class="edit-drawer__subtitle font-serif">{editTarget.chapterTitle}</p>
						<button class="edit-drawer__close" onclick={closeEditPanel} aria-label="Close editor"><X size={14} /></button>
					</div>

					<!-- Scope hint -->
					<div class="edit-drawer__context">
						{#if editTarget.scope === 'page'}
							<p class="edit-drawer__hint">AI will rewrite this specific page while preserving the rest of the chapter. Describe what you want changed.</p>
						{:else if editTarget.scope === 'chapter'}
							<p class="edit-drawer__hint">AI will rewrite the entire chapter based on your instruction. Structure and tone are maintained unless you specify otherwise.</p>
						{:else if editTarget.scope === 'add-page'}
							<p class="edit-drawer__hint">AI will generate a brand-new page and insert it <strong>after</strong> page {(editTarget.pageIndex ?? 0) + 1}. Describe exactly what content you want — tables, stat blocks, diagrams, comparisons, and more.</p>
						{:else if editTarget.scope === 'diagram'}
							{#if useRealisticIllustration}
								<p class="edit-drawer__hint">AI will generate a <strong>realistic image</strong> that replaces this element. Describe the visual scene, mood, or subject you want.</p>
							{:else if editTarget.diagramKind === 'table'}
								<p class="edit-drawer__hint">AI will rewrite this table. Describe what to change — rows, columns, values, or structure.</p>
							{:else if editTarget.diagramKind === 'inline'}
								<p class="edit-drawer__hint">AI will rewrite this element. Describe what to update — items, labels, values, or emphasis.</p>
							{:else}
								<p class="edit-drawer__hint">AI will rewrite the diagram. Describe what to change — steps, labels, type, or structure.</p>
							{/if}
						{:else}
							<p class="edit-drawer__hint">AI will generate a new illustration. Be specific about style, mood, subject, and composition.</p>
						{/if}
					</div>

					<!-- Instruction input -->
					<div class="edit-drawer__body">
						<label class="edit-drawer__label" for="edit-instruction">Your instruction</label>
						<textarea
							id="edit-instruction"
							class="edit-drawer__textarea font-serif"
							placeholder={
								editTarget.scope === 'page'
									? 'e.g. "Make this more concise" or "Rewrite in a more formal tone"'
									: editTarget.scope === 'chapter'
									? 'e.g. "Add more real-world examples" or "Strengthen the opening hook"'
									: editTarget.scope === 'diagram' && useRealisticIllustration
									? 'e.g. "A sunlit Mediterranean kitchen" or "Close-up of hands kneading dough"'
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'table'
									? 'e.g. "Add a Total row" or "Change column 3 header to Outcome"'
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'inline'
									? 'e.g. "Add two more stat items" or "Change the title to Key Results"'
									: editTarget.scope === 'diagram'
									? 'e.g. "Add two more steps" or "Change type to SWOT"'
									: 'e.g. "Dark, moody atmosphere with dramatic lighting" or "Watercolour, warm earth tones"'
							}
							rows={5}
							bind:value={editInstruction}
							disabled={isEditing}
						></textarea>

						{#if editTarget.scope === 'page' && editTarget.pageText}
							<details class="edit-drawer__preview">
								<summary class="edit-drawer__preview-toggle">Preview selected content</summary>
								<div class="edit-drawer__preview-body font-serif">{editTarget.pageText.slice(0, 400)}{editTarget.pageText.length > 400 ? '…' : ''}</div>
							</details>
						{/if}

						{#if editTarget.scope === 'illustration' && editTarget.illustrationUrl}
							<div class="edit-drawer__illust-preview">
								<img src={editTarget.illustrationUrl} alt="Current illustration" />
							</div>
						{/if}

						{#if editTarget.scope === 'illustration' || editTarget.scope === 'diagram'}
							<!-- Realistic image toggle ── industry-standard photorealism switch -->
							<div class="edit-drawer__realistic-toggle" role="group" aria-label="Image realism setting">
								<button
									type="button"
									class="realistic-toggle__btn"
									class:realistic-toggle__btn--active={!useRealisticIllustration}
									onclick={() => (useRealisticIllustration = false)}
									disabled={isEditing}
									aria-pressed={!useRealisticIllustration}
								>
									<Palette size={13} /> Illustrated
								</button>
								<button
									type="button"
									class="realistic-toggle__btn"
									class:realistic-toggle__btn--active={useRealisticIllustration}
									onclick={() => (useRealisticIllustration = true)}
									disabled={isEditing}
									aria-pressed={useRealisticIllustration}
								>
									<Camera size={13} /> Realistic
								</button>
							</div>
						{/if}

						{#if editTarget.scope === 'diagram' && editTarget.diagramKind === 'image'}
							<!-- ── Image Style Controls ─────────────────────────────────── -->
							<div class="edit-drawer__image-style" role="group" aria-label="Image display style">
								<p class="edit-drawer__label" style="margin-bottom:0.5rem;">Display &amp; Style</p>

								<!-- Full-page toggle -->
								<div class="image-style__row">
									<span class="image-style__row-label">Full page</span>
									<button
										type="button"
										class="image-style__toggle"
										class:image-style__toggle--on={imageFullPage}
										onclick={() => (imageFullPage = !imageFullPage)}
										disabled={isEditing}
										aria-pressed={imageFullPage}
										title="Stretch image to fill the entire page"
									>
										{imageFullPage ? 'On' : 'Off'}
									</button>
								</div>

								<!-- Border width -->
								<div class="image-style__row">
									<span class="image-style__row-label">Border width</span>
									<div class="image-style__select-wrap">
										<select
											bind:value={imageBorderWidth}
											disabled={isEditing}
											aria-label="Border width"
										>
											<option value="0">None</option>
											<option value="1">1 px</option>
											<option value="2">2 px</option>
											<option value="3">3 px</option>
											<option value="4">4 px</option>
											<option value="6">6 px</option>
										</select>
									</div>
								</div>

								{#if imageBorderWidth !== '0'}
									<!-- Border style -->
									<div class="image-style__row">
										<span class="image-style__row-label">Border style</span>
										<div class="image-style__select-wrap">
											<select
												bind:value={imageBorderStyle}
												disabled={isEditing}
												aria-label="Border style"
											>
												<option value="solid">Solid</option>
												<option value="dashed">Dashed</option>
												<option value="dotted">Dotted</option>
												<option value="double">Double</option>
											</select>
										</div>
									</div>

									<!-- Border color -->
									<div class="image-style__row">
										<span class="image-style__row-label">Border color</span>
										<div class="image-style__color-wrap">
											<input
												type="color"
												bind:value={imageBorderColor}
												disabled={isEditing}
												aria-label="Border color"
												class="image-style__color-input"
											/>
											<span class="image-style__color-hex">{imageBorderColor}</span>
										</div>
									</div>
								{/if}

								<!-- Corner radius -->
								<div class="image-style__row">
									<span class="image-style__row-label">Corner radius</span>
									<div class="image-style__select-wrap">
										<select
											bind:value={imageBorderRadius}
											disabled={isEditing}
											aria-label="Corner radius"
										>
											<option value="0">Square</option>
											<option value="4">4 px</option>
											<option value="6">6 px (default)</option>
											<option value="12">12 px</option>
											<option value="20">20 px</option>
											<option value="9999">Pill</option>
										</select>
									</div>
								</div>

								<button
									class="image-style__apply-btn"
									onclick={applyImageStyle}
									disabled={isEditing}
								>
									<Check size={13} /> Apply Style
								</button>
							</div>
						{/if}
					</div>

					<!-- Footer -->
					<div class="edit-drawer__footer">
						{#if editError}
							<p class="edit-drawer__error" role="alert">{editError}</p>
						{/if}
						{#if editSuccess}
							<p class="edit-drawer__success" role="status">
								<Check size={14} />
								{editTarget.scope === 'illustration' || (editTarget.scope === 'diagram' && useRealisticIllustration)
									? 'New image generated.'
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'image'
									? 'Image style applied.'
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'table'
									? 'Table updated.'
									: editTarget.scope === 'diagram' && editTarget.diagramKind === 'inline'
									? 'Visual block updated.'
									: editTarget.scope === 'diagram'
									? 'Diagram updated.'
									: 'Content updated.'}
							</p>
						{/if}

						<!-- Primary action row: Apply + Redo -->
						<div class="edit-drawer__actions">
							<button class="edit-drawer__cancel" onclick={closeEditPanel} disabled={isEditing}>Cancel</button>
							{#if lastInstruction}
								{@const redoTitle = `Re-run: ""`}
								<button class="edit-drawer__redo" onclick={applyRedo} disabled={isEditing} title={redoTitle} aria-label="Redo last edit">
									{#if isEditing && activeAction === 'redo'}
										<span class="spinner spinner--dark"></span>
									{:else}
										<RotateCcw size={12} />
									{/if}
									Redo
								</button>
							{/if}
							<button class="edit-drawer__apply" onclick={applyEdit} disabled={isEditing || !editInstruction.trim()}>
								{#if isEditing && activeAction === 'apply'}
									<span class="spinner"></span>
									{editTarget.scope === 'illustration' || (editTarget.scope === 'diagram' && useRealisticIllustration) ? 'Generating…' : 'Applying…'}
								{:else}
									{#if editTarget.scope === 'illustration'}
										<Palette size={13} /> Generate
									{:else if editTarget.scope === 'diagram' && useRealisticIllustration}
										<Camera size={13} /> Generate Image
									{:else}
										<Sparkles size={13} /> Apply Edit
									{/if}
								{/if}
							</button>
						</div>

						<!-- Secondary action: Reconstruct -->
						<div class="edit-drawer__secondary-actions">
							<button class="edit-drawer__reconstruct" onclick={applyReconstruct} disabled={isEditing}
								title={
									editTarget.scope === 'illustration'
										? 'Generate a completely new illustration from scratch'
										: editTarget.scope === 'diagram' && editTarget.diagramKind === 'image'
										? 'Generate a brand-new version of this image from scratch'
										: editTarget.scope === 'diagram' && useRealisticIllustration
										? 'Generate a brand-new realistic image from scratch, replacing this element'
										: editTarget.scope === 'diagram' && editTarget.diagramKind === 'table'
										? 'Rebuild this table from scratch based on the chapter content'
										: editTarget.scope === 'diagram' && editTarget.diagramKind === 'inline'
										? 'Rebuild this visual block from scratch based on the chapter content'
										: editTarget.scope === 'diagram'
										? 'Rebuild this diagram from scratch based on the chapter content'
										: 'Discard current content and rewrite from scratch using the original chapter brief'
								}>
								{#if isEditing && activeAction === 'reconstruct'}
									<span class="spinner spinner--accent"></span> Reconstructing…
								{:else}
									<RefreshCcw size={12} /> Reconstruct from Scratch
								{/if}
							</button>
						</div>
					</div>
			</div><!-- /edit-drawer -->
			{/if}

		</div>
	{/if}
</div>

<style>
	.reader-workspace {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.no-book-wrapper {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.no-book {
		text-align: center;
		padding: 4rem 2rem;
		color: var(--text-muted);
		font-style: italic;
		max-width: 600px;
	}

	.no-book a { text-decoration: underline; font-weight: 600; }

	.reader-layout {
		display: flex;
		flex-direction: row;
		height: calc(100vh - 65px);
		overflow: hidden;
	}

	/* Themes */
	.theme-cream {
		--r-sidebar: #F4EFE5; --r-viewport: #FAF7F2;
		--r-text: #2B2927; --r-muted: #6E6860;
		--r-border: #E5DFD3; --r-active-bg: #EAE3D4;
	}
	.theme-sepia {
		--r-sidebar: #E9DDC6; --r-viewport: #EFE4CD;
		--r-text: #413524; --r-muted: #7E6C53;
		--r-border: #DFD0B3; --r-active-bg: #DFD3BA;
	}
	.theme-white {
		--r-sidebar: #F4F4F4; --r-viewport: #FAFAFA;
		--r-text: #111111; --r-muted: #555555;
		--r-border: #E5E5E5; --r-active-bg: #EAEAEA;
	}
	.theme-night {
		--r-sidebar: #131211; --r-viewport: #181716;
		--r-text: #E5DFD5; --r-muted: #9E958A;
		--r-border: #2D2A26; --r-active-bg: #272523;
		--chapter-title-color: #E5DFD5 !important;
		--chapter-subtitle-color: #9E958A !important;
		--chapter-accent-color: #C4A97A !important;
	}

	/* Sidebar — fixed panel that never scrolls with content */
	.reader-sidebar {
		width: 280px;
		min-width: 280px;
		height: 100%;
		background-color: var(--r-sidebar);
		border-right: 1px solid var(--r-border);
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		transition: background-color 0.25s;
		position: sticky;
		top: 0;
		flex-shrink: 0;
	}

	.book-spine {
		padding: 1.4rem 1.5rem;
		border-bottom: 1px solid var(--r-border);
	}

	.book-spine h4 {
		font-size: 1rem;
		font-weight: 600;
		color: var(--r-text);
		margin: 0 0 0.2rem;
		line-height: 1.35;
	}

	.book-spine .by {
		font-size: 0.78rem;
		font-style: italic;
		color: var(--r-muted);
		margin: 0;
	}

	.toc-nav {
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		gap: 0.1rem;
		flex: 1;
	}

	.toc-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		padding: 0.7rem 1rem;
		border-radius: 6px;
		border: 1px solid transparent;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: var(--r-muted);
		transition: background 0.2s, color 0.2s;
		font-size: 0.85rem;
	}

	.toc-item:hover:not(:disabled) {
		background-color: var(--r-active-bg);
		color: var(--r-text);
	}

	.toc-item.active {
		background-color: var(--r-active-bg);
		color: var(--r-text);
		font-weight: 500;
		border-left: 2px solid var(--accent);
	}

	.toc-item:disabled { opacity: 0.3; cursor: not-allowed; }

	.chap-num {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--r-muted);
	}

	.chap-title {
		font-size: 0.85rem;
		margin-top: 0.1rem;
	}

	/* Sidebar actions */
	.sidebar-actions {
		padding: 1rem;
		border-top: 1px solid var(--r-border);
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}

	.theme-row, .font-row {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.25rem 0;
	}

	.label {
		font-size: 0.78rem;
		color: var(--r-muted);
		flex-shrink: 0;
	}

	.theme-dot {
		width: 18px; height: 18px;
		border-radius: 50%;
		border: 1.5px solid transparent;
		cursor: pointer;
		transition: transform 0.15s;
	}

	.theme-dot:hover { transform: scale(1.18); }
	.theme-dot.on { box-shadow: 0 0 0 2px var(--accent); }
	.theme-dot.cream { background: #FCFAF6; border-color: #E5DFD3; }
	.theme-dot.sepia { background: #F4ECCF; border-color: #DFD0B3; }
	.theme-dot.white { background: #FFFFFF; border-color: #ccc; }
	.theme-dot.night { background: #1C1B1A; border-color: #444; }

	.font-btn {
		background: transparent;
		border: 1px solid var(--r-border);
		color: var(--r-text);
		width: 26px; height: 26px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.78rem;
		font-weight: bold;
		display: flex; align-items: center; justify-content: center;
		transition: background 0.15s;
	}

	.font-btn:hover { background: var(--r-active-bg); }

	.font-val {
		font-size: 0.82rem;
		color: var(--r-muted);
		min-width: 36px;
		text-align: center;
	}

	.action-btn {
		width: 100%;
		padding: 0.5rem 0.75rem;
		font-size: 0.8rem;
		border-radius: 6px;
		border: 1px solid var(--r-border);
		background: transparent;
		color: var(--r-text);
		cursor: pointer;
		text-align: center;
		transition: background 0.2s;
	}

	.action-btn:hover:not(:disabled) { background: var(--r-active-bg); }

	.action-btn--primary {
		background: var(--accent);
		color: #fff;
		border-color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
	}

	.action-btn--primary:hover:not(:disabled) { opacity: 0.9; }
	.action-btn--primary:disabled { opacity: 0.6; cursor: not-allowed; }

	.spinner {
		display: inline-block;
		width: 11px; height: 11px;
		border: 2px solid rgba(255,255,255,0.35);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	@keyframes spin { to { transform: rotate(360deg); } }

	/* Scroll area — fills remaining width, owns all vertical scrolling */
	.reader-scroll-area {
		flex: 1;
		min-width: 0; /* prevent flex blowout */
		background-color: var(--r-viewport);
		overflow-y: auto;
		overflow-x: auto;
		height: 100%;
		transition: background-color 0.25s;
	}

	/* ─ Responsive: collapse sidebar above content on small screens ─ */
	@media (max-width: 768px) {
		.reader-layout {
			flex-direction: column;
			height: auto;
			overflow: visible;
		}
		.reader-sidebar {
			width: 100%;
			min-width: 0;
			height: auto;
			max-height: 220px;
			position: static;
			border-right: none;
			border-bottom: 1px solid var(--r-border);
			overflow-y: auto;
		}
		.reader-scroll-area {
			height: calc(100vh - 65px - 220px);
		}
	}

	/* Cover section container for book mockup centering */
	.cover-section-container {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 4rem 2rem;
		min-height: calc(100vh - 65px);
		box-sizing: border-box;
	}

	/* Cover hero — realistic book cover dimensions */
	.cover-hero {
		width: 100%;
		max-width: 480px;
		height: 720px;
		position: relative;
		display: flex;
		flex-direction: column;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15), 0 2px 6px rgba(0, 0, 0, 0.08);
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--r-border);
		background-color: var(--r-sheet);
	}

	.cover-overlay {
		position: absolute;
		inset: 0;
		z-index: 1;
	}

	.cover-text-layer {
		position: relative;
		z-index: 2;
		flex: 1;
		display: flex;
		flex-direction: column;
		padding: 3.5rem 2.5rem;
		gap: 1.5rem;
	}

	.title-sub { display: flex; flex-direction: column; gap: 0.75rem; }

	.cover-title {
		font-weight: 700;
		line-height: 1.2;
		margin: 0;
	}

	.cover-subtitle {
		margin: 0;
		font-family: var(--font-sans);
		font-weight: 500;
	}

	.cover-author-text {
		font-style: italic;
		margin: 0;
	}

	/* ── Book-page layout ───────────────────────────────────────────────────── */

	/*
	 * Outer wrap — provides the viewport gutter around each sheet.
	 * The card itself is centred; the scroll area handles horizontal overflow.
	 */
	.book-page-wrap {
		width: 100%;
		padding: 3.5rem 2rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		box-sizing: border-box;
	}

	/*
	 * US Letter sheet — 8.5 × 11 in (ANSI A), the industry standard for
	 * trade paperbacks and self-published ebooks printed to PDF.
	 *
	 * Inner layout is a flex column:
	 *   ┌──────────────────────────────────────────┐
	 *   │  running-header   (fixed, ~0.4in)         │
	 *   │──────────────────────────────────────────│
	 *   │                                           │
	 *   │  page-body        (flex: 1, scrollable)   │
	 *   │                                           │
	 *   │──────────────────────────────────────────│
	 *   │  page-footer      (fixed, ~0.35in)        │
	 *   └──────────────────────────────────────────┘
	 *
	 * Outer padding mirrors Chicago Manual of Style margins:
	 *   top: 1 in  |  bottom: 1 in
	 *   gutter (left): 1.5 in  |  fore-edge (right): 1.25 in
	 */
	.book-page-card {
		width: min(8.5in, 100%);
		height: 11in;
		margin: 0 auto;
		background-color: var(--r-viewport);
		border: 1px solid var(--r-page-border, #E5DFD3);
		border-radius: 2px;
		box-shadow:
			0 1px 4px rgba(36,34,32,0.06),
			0 6px 20px rgba(36,34,32,0.08),
			0 18px 40px rgba(36,34,32,0.06);

		/* Outer page margins */
		padding: 1in 1.25in 1in 1.5in;

		/* Three-zone flex column */
		display: flex;
		flex-direction: column;

		color: var(--r-text);
		line-height: 1.85;
		transition: color 0.25s, background-color 0.25s, box-shadow 0.25s;
		position: relative;
		box-sizing: border-box;
		overflow: hidden;
	}

	/* Spine binding accent — mimics a perfect-bound inner margin */
	.book-page-card::before {
		content: '';
		position: absolute;
		left: 0; top: 0; bottom: 0;
		width: 3px;
		background: linear-gradient(
			to bottom,
			transparent 0%,
			var(--chapter-accent-color, var(--accent)) 15%,
			var(--chapter-accent-color, var(--accent)) 85%,
			transparent 100%
		);
		opacity: 0.35;
		border-radius: 2px 0 0 2px;
	}

	/* ── Running header ─────────────────────────────────────────────────────── */
	.running-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding-bottom: 0.45rem;
		margin-bottom: 0.6rem;
		border-bottom: var(--r-header-border, var(--page-rule-width, 0.5px) solid var(--chapter-accent-color, var(--r-border)));
		flex-shrink: 0;
		gap: 1rem;
	}

	.running-header__book {
		font-family: var(--r-header-font, var(--chapter-font-family, var(--font-sans)));
		font-size: 0.6rem;
		text-transform: var(--r-header-transform, uppercase);
		letter-spacing: var(--r-header-letter-spacing, 2.5px);
		font-weight: 600;
		color: var(--r-header-color, var(--chapter-title-color, var(--r-text)));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		opacity: var(--r-header-opacity, 0.7);
	}

	.running-header__chapter {
		font-family: var(--r-header-font, var(--chapter-font-family, var(--font-serif)));
		font-size: 0.6rem;
		font-style: italic;
		color: var(--r-header-color, var(--chapter-title-color, var(--r-text)));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: right;
		opacity: var(--r-header-opacity, 0.7);
	}

	/* ── Page body ──────────────────────────────────────────────────────────── */
	.page-body {
		flex: 1;
		overflow: hidden;
		min-height: 0;
	}

	/* ── Running footer / page number ───────────────────────────────────────── */
	.page-footer {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding-top: 0.45rem;
		margin-top: 0.6rem;
		border-top: var(--r-footer-border, var(--page-rule-width, 0.5px) solid var(--chapter-accent-color, var(--r-border)));
		flex-shrink: 0;
	}

	.page-footer__rule {
		flex: 1;
		height: 1px;
	}

	.page-footer__num {
		font-family: var(--r-footer-font, var(--chapter-font-family, var(--font-serif)));
		font-size: 0.65rem;
		color: var(--r-footer-color, var(--chapter-title-color, var(--r-text)));
		letter-spacing: var(--r-footer-letter-spacing, 1.5px);
		opacity: var(--r-footer-opacity, 0.7);
	}

	/* ── Cover-style header/footer treatments ───────────────────────────────── */
	/*
	 * Each cover style gets a distinct typographic treatment on the running
	 * header and footer so the interior pages feel cohesive with the cover.
	 *
	 * Dark Minimalist — thinner rules, tight uppercase tracking
	 * Bold Graphic    — heavier rules, no italic
	 * Warm Editorial  — standard weight, italic chapter title (default)
	 */
	/* All running header and footer styles are fully dynamic and driven by AI variables. */

	/*
	 * Fluid below 1100px: viewport is narrower than sidebar (280px) + 8.5in card.
	 * Card stays fluid so it never overflows the scroll area.
	 */
	@media (max-width: 1100px) {
		.book-page-card {
			width: 100%;
			min-height: 11in;
			height: auto;
			padding: 1in 1.25in 1in 1.5in;
		}
	}
	@media (max-width: 700px) {
		.book-page-card {
			width: 100%;
			min-height: auto;
			height: auto;
			padding: 2.5rem 1.5rem 2.5rem 2rem;
			border-radius: 0;
		}
		.book-page-wrap { padding: 1rem 0 2rem; }
	}

	.chapter-header {
		/* ── Full-bleed break-out ───────────────────────────────────────────────
		 * The book-page-card has 1.5in left / 1.25in right printed margins.
		 * Negative margins pull this stripe to the physical card edge;
		 * the matching inner padding restores the visual text indent.
		 * Industry-standard technique ("bleed" in book / magazine typesetting).
		 * ──────────────────────────────────────────────────────────────────────── */
		margin-left:  -1.5in;
		margin-right: -1.25in;
		padding-left:  1.5in;
		padding-right: 1.25in;

		margin-top: var(--r-chap-header-pad, 0.5rem);
		margin-bottom: var(--r-chap-header-mb, 1.5rem);

		display: flex;
		flex-direction: column;
		align-items: var(--r-header-align, var(--header-flex-align, center));
		background: var(--r-chap-header-bg, transparent);
		border-left: var(--r-chap-header-bd-left, none);
		border-top: var(--r-chap-header-bd-top, none);
		padding-top:    var(--r-chap-header-pd-v, 0.9rem);
		padding-bottom: var(--r-chap-header-pd-v, 0.9rem);
	}

	.chapter-label {
		display: block;
		font-family: var(--r-label-font, var(--font-sans));
		font-size: 0.75rem;
		text-transform: var(--r-label-transform, uppercase);
		letter-spacing: var(--r-label-letter-spacing, 2.5px);
		color: var(--r-label-color, var(--chapter-accent-color, var(--accent)));
		font-weight: 600;
		margin-bottom: 0.6rem;
		text-align: var(--chapter-alignment, center);
		background: var(--r-label-bg, transparent);
		padding: var(--r-label-padding, 0);
		border-radius: var(--r-label-border-radius, 0);
	}

	.chapter-title {
		font-size: var(--r-chap-title-size, 2rem);
		font-weight: var(--r-title-weight, 700);
		line-height: 1.25;
		margin: 0 0 1.5rem;
		color: var(--r-title-color, var(--chapter-title-color, var(--r-text)));
		font-family: var(--r-title-font, var(--chapter-font-family, var(--font-serif)));
		text-align: var(--chapter-alignment, center);
		text-transform: var(--r-title-transform, none);
		letter-spacing: var(--r-title-letter-spacing, 0px);
		font-style: var(--r-title-style, normal);
	}

	.chapter-rule {
		border: none;
		border-top: var(--r-rule-border, 1.5px solid var(--chapter-accent-color, var(--r-border)));
		margin: 0;
		width: var(--r-rule-width, var(--chapter-rule-width, 100%));
		margin-left: var(--chapter-rule-margin-left, 0);
		margin-right: var(--chapter-rule-margin-right, auto);
	}

	.chapter-pending {
		padding: 3rem 0;
		color: var(--r-muted);
		font-style: italic;
		text-align: center;
	}

	.chapter-illust {
		margin: 2.5rem 0;
		text-align: center;
	}

	.chapter-illust img {
		max-width: 100%;
		max-height: 380px;
		border-radius: 6px;
		box-shadow: 0 4px 20px rgba(0,0,0,0.1);
	}

	.chapter-body {
		font-family: var(--r-body-font, var(--chapter-body-font, var(--font-serif)));
	}

	.chapter-body :global(p) {
		margin-bottom: 1.5rem;
		text-indent: 1.5rem;
	}

	.chapter-body :global(p:first-of-type) { text-indent: 0; }

	/* Drop Cap: Industry standard styling for first paragraph */
	.has-drop-cap :global(p:first-of-type::first-letter) {
		font-family: var(--r-dropcap-font, var(--chapter-font-family, var(--font-serif)));
		font-size: 3.5em;
		float: left;
		line-height: 0.85;
		margin-top: 0.1em;
		margin-right: 0.15em;
		font-weight: var(--r-dropcap-weight, 700);
		color: var(--r-dropcap-color, var(--chapter-accent-color, var(--accent)));
		font-style: var(--r-dropcap-style, normal);
	}

	.chapter-body :global(h2) {
		font-size: 1.35rem;
		font-weight: 600;
		margin: 2.5rem 0 1rem;
		font-family: var(--chapter-font-family, var(--font-serif));
		color: var(--chapter-title-color, var(--r-text));
	}

	.chapter-body :global(h3) {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 2rem 0 0.75rem;
		font-family: var(--chapter-font-family, var(--font-serif));
		color: var(--chapter-title-color, var(--r-text));
	}

	.chapter-body :global(h4) {
		font-size: 0.95rem;
		font-weight: 600;
		margin: 1.5rem 0 0.5rem;
		font-family: var(--font-sans);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--chapter-accent-color, var(--r-muted));
	}

	.chapter-body :global(blockquote) {
		border-left: var(--r-blockquote-border, 3.5px solid var(--chapter-accent-color, var(--accent)));
		margin: 2rem 0;
		padding: var(--r-blockquote-padding, 0 0 0 1.8rem);
		font-style: italic;
		color: var(--r-blockquote-color, var(--r-muted));
		background-color: var(--r-blockquote-bg, transparent);
		border-radius: var(--r-blockquote-border-radius, 0);
		line-height: 1.7;
	}

	.chapter-body :global(ul) {
		margin: 1.5rem 0;
		padding-left: 2rem;
	}

	.chapter-body :global(li) {
		margin-bottom: 0.5rem;
		text-indent: 0;
	}

	.chapter-body :global(strong) { font-weight: 700; }
	.chapter-body :global(em) { font-style: italic; }

	/* Cover-specific chapter styles are dynamically defined by AI variables. */

	/* Chapter separator */
	.chapter-separator {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		max-width: 720px;
		margin: 0 auto;
		padding: 0 4rem 4rem;
	}

	.sep-line {
		flex: 1;
		height: 1px;
		background: var(--chapter-accent-color, var(--r-border));
		opacity: 0.25;
	}

	.sep-ornament {
		font-size: 1.2rem;
		color: var(--chapter-accent-color, var(--r-muted));
		opacity: 0.75;
		line-height: 1;
	}

	/* ── Industry-Standard Table Styles ────────────────────────────────────── */
	.chapter-body :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 2rem 0;
		font-size: 0.95rem;
		text-align: left;
		line-height: 1.5;
	}
	.chapter-body :global(th) {
		background-color: var(--r-table-header-bg, #0F172A);
		color: #ffffff;
		font-weight: 600;
		padding: 0.75rem 1rem;
		border: 1px solid var(--r-table-border, var(--r-border, #e2e8f0));
	}
	.chapter-body :global(td) {
		padding: 0.75rem 1rem;
		border: 1px solid var(--r-table-border, var(--r-border, #e2e8f0));
	}
	.chapter-body :global(tr:nth-child(even)) {
		background-color: var(--r-table-stripe, #f8fafc);
	}
	.chapter-body :global(tr:hover) {
		background-color: var(--r-table-hover, #f1f5f9);
	}

	/* ── Callout Boxes ──────────────────────────────────────────────────────── */
	.chapter-body :global(.callout-box),
	.chapter-body :global(.tip-box),
	.chapter-body :global(.warning-box),
	.chapter-body :global(.key-rule-box) {
		border-radius: var(--r-callout-border-radius, 4px);
		padding: 1.25rem 1.5rem;
		margin: 2rem 0;
		box-sizing: border-box;
	}
	.chapter-body :global(.callout-box) {
		background-color: var(--r-callout-bg, #faf7f2);
		border-left: var(--r-callout-border-width, 3.5px) solid var(--r-callout-border-color, var(--chapter-accent-color, #8e7453));
	}
	.chapter-body :global(.tip-box) {
		background-color: #ecfdf5;
		border-left: var(--r-callout-border-width, 3.5px) solid #10b981;
	}
	.chapter-body :global(.warning-box) {
		background-color: #fef2f2;
		border-left: var(--r-callout-border-width, 3.5px) solid #ef4444;
	}
	.chapter-body :global(.key-rule-box) {
		background-color: #fffbeb;
		border-left: var(--r-callout-border-width, 3.5px) solid #f59e0b;
	}
	.chapter-body :global(.callout-box__title) {
		font-family: var(--r-label-font, var(--font-sans));
		font-weight: 700;
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 1.5px;
		margin-bottom: 0.5rem;
		display: block;
	}
	.chapter-body :global(.callout-box .callout-box__title) {
		color: var(--r-callout-title-color, var(--chapter-accent-color, #8e7453));
	}
	.chapter-body :global(.tip-box .callout-box__title) {
		color: #047857;
	}
	.chapter-body :global(.warning-box .callout-box__title) {
		color: #b91c1c;
	}
	.chapter-body :global(.key-rule-box .callout-box__title) {
		color: #b45309;
	}
	.chapter-body :global(.callout-box__content) {
		font-size: 0.95rem;
		line-height: 1.6;
		color: var(--r-text, #1a1612);
	}

	/* ── Diagram and Flowchart Layouts ──────────────────────────────────────── */
	.chapter-body :global(.diagram-box) {
		background-color: var(--r-diagram-bg, #f8fafc);
		border: 1.5px solid var(--r-border, #e2e8f0);
		border-radius: 6px;
		padding: 1.5rem;
		margin: 2.5rem 0;
		text-align: center;
		box-shadow: 0 1px 3px rgba(0,0,0,0.05);
	}
	.chapter-body :global(.diagram-box__title) {
		font-family: var(--r-title-font, var(--font-serif));
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--r-title-color, var(--chapter-title-color, #0f172a));
		margin-bottom: 0.25rem;
	}
	.chapter-body :global(.diagram-box__subtitle) {
		font-size: 0.8rem;
		color: var(--r-muted, #64748b);
		margin-bottom: 1.5rem;
		text-transform: uppercase;
		letter-spacing: 1px;
	}
	.chapter-body :global(.diagram-box--table) {
		background: transparent;
		border: none;
		box-shadow: none;
		padding: 0;
		margin: 2.5rem 0;
		text-align: left;
		display: flex;
		flex-direction: column;
	}
	.chapter-body :global(.diagram-box--table .table-container) {
		background: transparent;
	}
	.chapter-body :global(.diagram-box--table .edit-trigger--diagram) {
		position: static;
		opacity: 1;
		pointer-events: auto;
		margin-top: 0.85rem;
		align-self: flex-end;
	}
	.chapter-body :global(.diagram-box--table .edit-trigger--diagram:hover) {
		background: rgba(142,116,83,0.15);
	}
	.chapter-body :global(.diagram-flow) {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 1rem;
		margin: 1rem 0;
	}
	.chapter-body :global(.diagram-step) {
		background-color: #ffffff;
		border: 1px solid var(--r-border, #cbd5e1);
		border-radius: 4px;
		padding: 0.75rem 1rem;
		min-width: 140px;
		max-width: 200px;
		font-size: 0.85rem;
		box-shadow: 0 1px 2px rgba(0,0,0,0.02);
		text-align: left;
	}
	.chapter-body :global(.diagram-step__num) {
		font-weight: 700;
		color: var(--chapter-accent-color, #8e7453);
		margin-bottom: 0.25rem;
		font-size: 0.8rem;
	}
	.chapter-body :global(.diagram-step__text) {
		font-weight: 500;
		color: var(--r-text, #1e293b);
	}
	.chapter-body :global(.diagram-arrow) {
		font-size: 1.2rem;
		color: var(--chapter-accent-color, #cbd5e1);
		user-select: none;
	}
	.chapter-body :global(.diagram-takeaway) {
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--r-border, #e2e8f0);
		font-size: 0.85rem;
		font-style: italic;
		color: var(--r-muted, #475569);
	}

	/* ── Edit triggers — shown on card hover ────────────────────────────────── */

	/*
	 * Page-level edit actions live inside .page-footer.
	 * They are hidden by default and revealed when the parent card is hovered.
	 * Using opacity + pointer-events gives a clean fade without layout shift.
	 */
	.page-edit-actions {
		position: absolute;
		right: 0;
		bottom: 0;
		display: flex;
		gap: 0.4rem;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.18s ease;
	}

	.book-page-card:hover .page-edit-actions {
		opacity: 1;
		pointer-events: auto;
	}

	/* footer needs relative positioning so the actions can sit in the corner */
	.page-footer {
		position: relative;
	}

	.page-edit-btn {
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 500;
		padding: 0.28rem 0.65rem;
		border-radius: 4px;
		border: 1px solid var(--r-border);
		background: var(--r-viewport);
		color: var(--r-muted);
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.15s, color 0.15s, border-color 0.15s;
		line-height: 1.4;
	}

	.page-edit-btn:hover {
		background: var(--r-active-bg);
		color: var(--r-text);
		border-color: var(--chapter-accent-color, var(--accent));
	}

	.page-edit-btn--chapter {
		border-color: var(--chapter-accent-color, var(--accent));
		color: var(--chapter-accent-color, var(--accent));
	}

	.page-edit-btn--chapter:hover {
		background: var(--chapter-accent-color, var(--accent));
		color: #fff;
	}

	/* Illustration edit trigger */
	.chapter-illust {
		position: relative;
	}

	.edit-trigger--illust {
		font-family: var(--font-sans);
		font-size: 0.7rem;
		font-weight: 500;
		position: absolute;
		bottom: 0.5rem;
		right: 0.5rem;
		padding: 0.3rem 0.7rem;
		border-radius: 5px;
		border: 1px solid rgba(255,255,255,0.45);
		background: rgba(26,21,16,0.55);
		color: #fff;
		cursor: pointer;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.18s ease, background 0.15s;
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		white-space: nowrap;
	}

	.chapter-illust:hover .edit-trigger--illust {
		opacity: 1;
		pointer-events: auto;
	}

	.edit-trigger--illust:hover {
		background: rgba(26,21,16,0.82);
	}

	/* ── Diagram edit trigger (shown on diagram-box hover) ── */
	.chapter-body :global(.diagram-box__actions) {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		display: flex;
		gap: 0.35rem;
		flex-wrap: wrap;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.18s ease;
		z-index: 5;
	}

	.chapter-body :global(.diagram-box:hover .diagram-box__actions) {
		opacity: 1;
		pointer-events: auto;
	}

	.chapter-body :global(.diagram-box:hover .edit-trigger--diagram),
	.chapter-body :global(.diagram-box:focus-within .edit-trigger--diagram) {
		opacity: 1;
		pointer-events: auto;
	}

	.chapter-body :global(.edit-trigger--diagram) {
		font-family: var(--font-sans);
		font-size: 0.68rem;
		font-weight: 600;
		padding: 0.3rem 0.65rem;
		border-radius: 5px;
		border: 1px solid rgba(142,116,83,0.5);
		background: rgba(250,248,244,0.9);
		color: var(--r-accent, #8E7453);
		cursor: pointer;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.18s ease, background 0.15s;
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		white-space: nowrap;
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

	/* Position diagram-box relative so the trigger can be absolutely placed */
	.chapter-body :global(.diagram-box) {
		position: relative;
	}

	/* ── Image block variants ── */
	.chapter-body :global(.diagram-box--image) {
		overflow: hidden;
	}

	.chapter-body :global(.diagram-box--image figure) {
		margin: 0;
	}

	/* Full-page: image expands to fill the reader page block */
	.chapter-body :global(.diagram-box--image--fullpage) {
		width: 100%;
		min-height: 600px;
		display: flex;
		flex-direction: column;
		align-items: stretch;
	}

	.chapter-body :global(.diagram-box--image--fullpage figure) {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		margin: 0;
	}

	.chapter-body :global(.diagram-box--image--fullpage figure img) {
		width: 100%;
		max-height: 700px;
		height: auto;
		object-fit: contain;
	}

	/* ── Inline visual element edit trigger (callout-box, stat-block, etc.) ── */
	/* The button is injected as the first child of the element's root div.     */
	.chapter-body :global(.callout-box),
	.chapter-body :global(.stat-block),
	.chapter-body :global(.checklist-box),
	.chapter-body :global(.pro-con-grid),
	.chapter-body :global(.quote-box),
	.chapter-body :global(.tip-box),
	.chapter-body :global(.warning-box),
	.chapter-body :global(.key-takeaway) {
		position: relative;
	}

	.chapter-body :global(.edit-trigger--inline) {
		position: absolute;
		top: 0.4rem;
		right: 0.4rem;
		z-index: 10;
		opacity: 0;
		pointer-events: none;
	}

	.chapter-body :global(.callout-box:hover .edit-trigger--inline),
	.chapter-body :global(.stat-block:hover .edit-trigger--inline),
	.chapter-body :global(.checklist-box:hover .edit-trigger--inline),
	.chapter-body :global(.pro-con-grid:hover .edit-trigger--inline),
	.chapter-body :global(.quote-box:hover .edit-trigger--inline),
	.chapter-body :global(.tip-box:hover .edit-trigger--inline),
	.chapter-body :global(.warning-box:hover .edit-trigger--inline),
	.chapter-body :global(.key-takeaway:hover .edit-trigger--inline) {
		opacity: 1;
		pointer-events: auto;
	}

	/* Hide diagram edit triggers during print / PDF export */
	@media print {
		.chapter-body :global(.diagram-box__actions) { display: none !important; }
		.chapter-body :global(.edit-trigger--diagram) { display: none !important; }
	}

	/* ── Edit drawer ────────────────────────────────────────────────────────── */

	/*
	 * The drawer slides in from the right edge, sitting on top of the reader
	 * scroll area without pushing the layout. A semi-transparent backdrop dims
	 * the page content below while the panel is open.
	 *
	 * Width is fixed at 420px — wide enough for a comfortable textarea, narrow
	 * enough not to obscure the page card on typical desktop viewports.
	 */

	.edit-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(26, 21, 16, 0.35);
		z-index: 140;
		animation: fadeIn 0.2s ease;
	}

	@keyframes fadeIn  { from { opacity: 0; } to { opacity: 1; } }
	@keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }

	.edit-drawer {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		width: 420px;
		max-width: 100vw;
		background: var(--surface, #FDFCFA);
		border-left: 1px solid var(--border, #E5DFD3);
		display: flex;
		flex-direction: column;
		z-index: 150;
		animation: slideIn 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
		box-shadow: -8px 0 32px rgba(26, 21, 16, 0.12);
	}

	/* ── Drawer header ── */
	.edit-drawer__header {
		position: relative;
		padding: 1.4rem 1.5rem 1rem;
		border-bottom: 1px solid var(--border, #E5DFD3);
		flex-shrink: 0;
	}

	.edit-drawer__title-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.2rem;
		padding-right: 2rem; /* avoid overlapping close btn */
	}

	.edit-drawer__scope-badge {
		display: inline-flex;
		align-items: center;
		font-family: var(--font-sans);
		font-size: 0.65rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 1px;
		padding: 0.2rem 0.5rem;
		border-radius: 3px;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.edit-drawer__scope-badge--page        { background: #EEF2FF; color: #4F46E5; }
	.edit-drawer__scope-badge--chapter     { background: #FFF7ED; color: #C2410C; }
	.edit-drawer__scope-badge--illustration { background: #F0FDF4; color: #15803D; }
	.edit-drawer__scope-badge--diagram--fence  { background: #FFF7ED; color: #92400E; }
	.edit-drawer__scope-badge--diagram--table  { background: #EFF6FF; color: #1D4ED8; }
	.edit-drawer__scope-badge--diagram--inline { background: #FAF5FF; color: #7E22CE; }
	.edit-drawer__scope-badge--diagram--image  { background: #F0FDF4; color: #0E7490; }

	.edit-drawer__title {
		font-size: 1rem;
		font-weight: 600;
		color: var(--text, #2B2927);
		margin: 0;
		line-height: 1.3;
	}

	.edit-drawer__subtitle {
		font-size: 0.82rem;
		color: var(--text-muted, #6E6860);
		font-style: italic;
		margin: 0;
	}

	.edit-drawer__close {
		position: absolute;
		top: 1.1rem;
		right: 1.1rem;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: 1px solid var(--border, #E5DFD3);
		background: transparent;
		color: var(--text-muted, #6E6860);
		font-size: 0.8rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s, color 0.15s;
	}

	.edit-drawer__close:hover {
		background: var(--surface-hover, #F0EBE1);
		color: var(--text, #2B2927);
	}

	/* ── Scope hint ── */
	.edit-drawer__context {
		padding: 0.75rem 1.5rem;
		border-bottom: 1px solid var(--border, #E5DFD3);
		background: var(--surface-alt, #F7F4F0);
		flex-shrink: 0;
	}

	.edit-drawer__hint {
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: var(--text-muted, #6E6860);
		margin: 0;
		line-height: 1.55;
	}

	/* ── Body ── */
	.edit-drawer__body {
		flex: 1;
		overflow-y: auto;
		padding: 1.25rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.edit-drawer__label {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text, #2B2927);
		text-transform: uppercase;
		letter-spacing: 0.8px;
	}

	.edit-drawer__textarea {
		width: 100%;
		padding: 0.75rem 0.9rem;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 6px;
		background: var(--surface, #FDFCFA);
		color: var(--text, #2B2927);
		font-size: 0.9rem;
		line-height: 1.65;
		resize: vertical;
		min-height: 110px;
		transition: border-color 0.15s, box-shadow 0.15s;
		box-sizing: border-box;
	}

	.edit-drawer__textarea:focus {
		outline: none;
		border-color: var(--accent, #8E7453);
		box-shadow: 0 0 0 3px rgba(142, 116, 83, 0.12);
	}

	.edit-drawer__textarea:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Content preview accordion */
	.edit-drawer__preview {
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 6px;
		overflow: hidden;
	}

	.edit-drawer__preview-toggle {
		font-family: var(--font-sans);
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted, #6E6860);
		padding: 0.6rem 0.9rem;
		cursor: pointer;
		background: var(--surface-alt, #F7F4F0);
		list-style: none;
		user-select: none;
		transition: background 0.15s;
	}

	.edit-drawer__preview-toggle:hover { background: var(--surface-hover, #F0EBE1); }

	.edit-drawer__preview-body {
		padding: 0.75rem 0.9rem;
		font-size: 0.8rem;
		line-height: 1.65;
		color: var(--text-muted, #6E6860);
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 160px;
		overflow-y: auto;
	}

	/* Illustration preview */
	.edit-drawer__illust-preview {
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 6px;
		overflow: hidden;
		text-align: center;
	}

	.edit-drawer__illust-preview img {
		max-width: 100%;
		max-height: 200px;
		object-fit: contain;
		display: block;
		margin: 0 auto;
	}

	/* ── Realistic image toggle ── */
	.edit-drawer__realistic-toggle {
		display: flex;
		gap: 0;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 6px;
		overflow: hidden;
		background: var(--bg-subtle, #F5F1EB);
	}

	.realistic-toggle__btn {
		flex: 1;
		padding: 0.45rem 0.75rem;
		font-size: 0.78rem;
		font-weight: 500;
		letter-spacing: 0.01em;
		background: transparent;
		border: none;
		cursor: pointer;
		color: var(--text-muted, #9C8E7A);
		transition: background 0.15s ease, color 0.15s ease;
		line-height: 1.4;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.25rem;
	}

	.realistic-toggle__btn:not(:last-child) {
		border-right: 1px solid var(--border, #E5DFD3);
	}

	.realistic-toggle__btn--active {
		background: var(--surface, #FFFFFF);
		color: var(--text-primary, #1A1612);
		font-weight: 600;
		box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06);
	}

	.realistic-toggle__btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* ── Image Style Controls ── */
	.edit-drawer__image-style {
		margin-top: 1rem;
		padding: 0.85rem 1rem;
		background: var(--bg-subtle, #F5F1EB);
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.image-style__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.image-style__row-label {
		font-size: 0.78rem;
		color: var(--text-muted, #6E6860);
		font-weight: 500;
		flex-shrink: 0;
	}

	.image-style__select-wrap select {
		font-size: 0.78rem;
		padding: 0.3rem 0.5rem;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 4px;
		background: var(--surface, #FFFFFF);
		color: var(--text-primary, #1A1612);
		cursor: pointer;
	}

	.image-style__color-wrap {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.image-style__color-input {
		width: 28px;
		height: 28px;
		border: 1px solid var(--border, #E5DFD3);
		border-radius: 4px;
		padding: 2px;
		cursor: pointer;
		background: none;
	}

	.image-style__color-hex {
		font-size: 0.73rem;
		font-family: monospace;
		color: var(--text-muted, #6E6860);
	}

	.image-style__toggle {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.25rem 0.65rem;
		border-radius: 4px;
		border: 1px solid var(--border, #E5DFD3);
		background: var(--surface, #FFFFFF);
		color: var(--text-muted, #6E6860);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
		min-width: 42px;
	}

	.image-style__toggle--on {
		background: var(--accent, #8E7453);
		color: #FFFFFF;
		border-color: var(--accent, #8E7453);
	}

	.image-style__toggle:disabled,
	.image-style__select-wrap select:disabled,
	.image-style__color-input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.image-style__apply-btn {
		margin-top: 0.25rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		padding: 0.45rem 1rem;
		font-size: 0.78rem;
		font-weight: 600;
		border-radius: 5px;
		border: none;
		background: var(--accent, #8E7453);
		color: #FFFFFF;
		cursor: pointer;
		transition: opacity 0.15s;
		width: 100%;
	}

	.image-style__apply-btn:hover:not(:disabled) { opacity: 0.88; }
	.image-style__apply-btn:disabled { opacity: 0.45; cursor: not-allowed; }

	/* ── Footer ── */
	.edit-drawer__footer {
		padding: 1rem 1.5rem 1.25rem;
		border-top: 1px solid var(--border, #E5DFD3);
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}

	.edit-drawer__error {
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: #B91C1C;
		background: #FEF2F2;
		border: 1px solid #FECACA;
		border-radius: 5px;
		padding: 0.5rem 0.75rem;
		margin: 0;
	}

	.edit-drawer__success {
		font-family: var(--font-sans);
		font-size: 0.78rem;
		color: #166534;
		background: #F0FDF4;
		border: 1px solid #BBF7D0;
		border-radius: 5px;
		padding: 0.5rem 0.75rem;
		margin: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.edit-drawer__actions {
		display: flex;
		gap: 0.6rem;
	}

	.edit-drawer__cancel {
		flex: 0 0 auto;
		padding: 0.55rem 1.1rem;
		border-radius: 6px;
		border: 1px solid var(--border, #E5DFD3);
		background: transparent;
		color: var(--text-muted, #6E6860);
		font-family: var(--font-sans);
		font-size: 0.82rem;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.edit-drawer__cancel:hover:not(:disabled) {
		background: var(--surface-hover, #F0EBE1);
		color: var(--text, #2B2927);
	}

	.edit-drawer__cancel:disabled { opacity: 0.45; cursor: not-allowed; }

	.edit-drawer__apply {
		flex: 1;
		padding: 0.55rem 1.1rem;
		border-radius: 6px;
		border: none;
		background: var(--accent, #8E7453);
		color: #fff;
		font-family: var(--font-sans);
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		transition: opacity 0.15s, background 0.15s;
	}

	.edit-drawer__apply:hover:not(:disabled) { opacity: 0.88; }

	.edit-drawer__apply:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	/* ── Redo button ── */
	.edit-drawer__redo {
		flex: 0 0 auto;
		padding: 0.55rem 0.9rem;
		border-radius: 6px;
		border: 1px solid var(--border, #E5DFD3);
		background: transparent;
		color: var(--text, #2B2927);
		font-family: var(--font-sans);
		font-size: 0.82rem;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		transition: background 0.15s, border-color 0.15s, color 0.15s;
		white-space: nowrap;
	}

	.edit-drawer__redo:hover:not(:disabled) {
		background: var(--surface-hover, #F0EBE1);
		border-color: var(--accent, #8E7453);
		color: var(--accent, #8E7453);
	}

	.edit-drawer__redo:disabled { opacity: 0.45; cursor: not-allowed; }

	/* ── Secondary action row (Reconstruct) ── */
	.edit-drawer__secondary-actions {
		display: flex;
	}

	.edit-drawer__reconstruct {
		width: 100%;
		padding: 0.5rem 1rem;
		border-radius: 6px;
		border: 1px dashed var(--border, #E5DFD3);
		background: transparent;
		color: var(--text-muted, #6E6860);
		font-family: var(--font-sans);
		font-size: 0.78rem;
		font-weight: 500;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		transition: background 0.15s, border-color 0.15s, color 0.15s;
	}

	.edit-drawer__reconstruct:hover:not(:disabled) {
		background: #FFF7ED;
		border-color: #C2410C;
		color: #C2410C;
	}

	.edit-drawer__reconstruct:disabled { opacity: 0.45; cursor: not-allowed; }

	/* Spinner variants */
	.spinner--dark {
		border-color: rgba(43,41,39,0.25);
		border-top-color: var(--text, #2B2927);
	}

	.spinner--accent {
		border-color: rgba(142,116,83,0.25);
		border-top-color: var(--accent, #8E7453);
	}

	@media (max-width: 600px) {
		.edit-drawer { width: 100vw; }
	}
</style>
