<script lang="ts">
	import { tick } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import type { Book } from '$lib/types';
	import type { EditTarget } from '$lib/reader/types';
	import { generateImage } from '$lib/generateImage';
	import { createIllustration, labelIllustration } from '$lib/illustration';
	import { spliceVisualBlock, splicePage, htmlToPlainText } from '$lib/reader/utils';
	import {
		Clipboard, ClipboardCheck, FileCode, FileDown,
		Image as ImageIcon, PenLine, BookOpen,
		Sparkles, Wand2, RefreshCcw, RotateCcw,
		X, Palette, Camera, Check
	} from '@lucide/svelte';

	interface Props {
		editTarget: EditTarget | null;
		activeBook: Book | null | undefined;
		coverStyle: string;
		paginateAllChapters: () => void;
	}

	let {
		editTarget = $bindable(),
		activeBook,
		coverStyle,
		paginateAllChapters
	}: Props = $props();

	// ── Internal state ────────────────────────────────────────────────────────
	let editInstruction = $state('');
	let isEditing       = $state(false);
	let editSuccess     = $state(false);
	let editError       = $state('');
	let lastInstruction = $state('');
	let activeAction    = $state<'apply' | 'redo' | 'reconstruct' | null>(null);

	// ── Image style editor state ─────────────────────────────────────────────
	let imageFullPage     = $state(false);
	let imageBorderColor  = $state('#C9A84C');
	let imageBorderWidth  = $state('0');
	let imageBorderStyle  = $state('solid');
	let imageBorderRadius = $state('6');

	/** Reset image style controls to neutral defaults */
	function resetImageStyleState() {
		imageFullPage     = false;
		imageBorderColor  = '#C9A84C';
		imageBorderWidth  = '0';
		imageBorderStyle  = 'solid';
		imageBorderRadius = '6';
	}

	let useRealisticIllustration = $state(false);

	// ── Seed state when editTarget opens ─────────────────────────────────────
	$effect(() => {
		if (editTarget) {
			editInstruction = '';
			editSuccess = false;
			editError = '';
			resetImageStyleState();
			useRealisticIllustration =
				!!(activeBook?.useUltraRealistic || activeBook?.coverSettings?.useUltraRealistic);
		}
	});

	// ── Panel helpers ─────────────────────────────────────────────────────────
	function closeEditPanel() {
		editTarget = null;
		editInstruction = '';
		editSuccess = false;
		editError = '';
		lastInstruction = '';
		activeAction = null;
		resetImageStyleState();
	}

	// ── Apply image style (no AI) ─────────────────────────────────────────────
	async function applyImageStyle() {
		if (!editTarget || !activeBook || editTarget.diagramKind !== 'image') return;

		const raw = editTarget.diagramRaw ?? '';
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

		const newTableRaw = encodeURIComponent(raw);
		const editBtn = `<button class="edit-trigger edit-trigger--diagram edit-trigger--inline" data-chapter-id="${editTarget.chapterId}" data-table-index="${editTarget.diagramIndex ?? 0}" data-table-raw="${newTableRaw}" title="Regenerate or edit this image" aria-label="Edit image"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg> Edit</button>`;

		// diagram-box--fullpage is the canonical "owns its page" hook that the
		// page-filling CSS keys on; --image--fullpage only drives the figure/img
		// layout. Carrying just the latter wins a bleed page without the styles
		// that fill it, so both are required here.
		const wrapperClass = imageFullPage
			? 'diagram-box diagram-box--image diagram-box--image--fullpage diagram-box--fullpage'
			: 'diagram-box diagram-box--image';

		// Every image in the chapter content is framed as a plate: the alt text
		// is promoted into the navy header bar. This is NOT gated on
		// imageFullPage — an inline image is still a plate and still carries the
		// bar; full-page only decides whether it gets a page to itself.
		// The figcaption would just restate the bar, so it only appears when
		// there is no alt to title the plate with.
		const header = alt
			? `<div class="diagram-box__header"><div class="diagram-box__title">${alt}</div></div>`
			: '';
		const figCaption = alt ? '' : caption;

		const newHtml = `<div class="${wrapperClass}"><div class="diagram-box__actions">${editBtn}</div>${header}<figure style="${figStyle}"><img src="${url}" alt="${alt}" loading="lazy" style="${imgStyle}" />${figCaption}</figure></div>`;

		const updatedContent = spliceVisualBlock(
			editTarget.chapterContent,
			'image',
			raw,
			editTarget.diagramIndex ?? 0,
			newHtml,
			true
		);

		globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
		editTarget = { ...editTarget, chapterContent: updatedContent };
		editSuccess = true;
		paginateAllChapters();
	}

	// ── applyEdit ─────────────────────────────────────────────────────────────
	async function applyEdit() {
		if (!editTarget || !editInstruction.trim() || !activeBook) return;
		let instruction = editInstruction.trim();
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
	 */
	async function applyReconstruct() {
		if (!editTarget || !activeBook || isEditing) return;
		isEditing = true;
		activeAction = 'reconstruct';
		editSuccess = false;
		editError = '';

		try {
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
				if (rData.success) globalState.addBookUsage(activeBook.id, { searches: 1 });
				if (rData.success && rData.results?.length) {
					const newFacts = (rData.results as any[])
						.map((f: any) => `[${f.title}] ${f.snippet}`)
						.join('\n\n');
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
				if (data.usage) globalState.addBookUsage(activeBook.id, { claude: data.usage });
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
				if (data.usage) globalState.addBookUsage(activeBook.id, { claude: data.usage });
				const updatedContent = splicePage(
					editTarget.chapterContent,
					editTarget.pageStartIdx ?? 0,
					editTarget.pageEndIdx ?? editTarget.chapterContent.split(/\n\n+/).length,
					data.pageContent
				);
				globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
				editTarget = { ...editTarget, chapterContent: updatedContent, pageText: htmlToPlainText(data.pageContent) };

			} else if (editTarget.scope === 'illustration') {
				// Same art direction the writing pipeline uses, so a regenerated
				// illustration matches the ones generation produced instead of drifting
				// into its own look — and so it is briefed from what the chapter says
				// rather than from its title alone.
				const made = await createIllustration(
					activeBook,
					{
						chapterTitle:   editTarget.chapterTitle,
						chapterOrder:   editTarget.chapterOrder,
						chapterSummary: editTarget.chapterSummary,
						chapterContent: editTarget.chapterContent,
						researchNotes:  editTarget.researchNotes
					},
					globalState.apiKeys,
					globalState.apiKeys.useMockMode,
					useRealisticIllustration
				);
				made.claudeUsage.forEach(u => globalState.addBookUsage(activeBook.id, { claude: u }));
				if (made.imageBilled) globalState.addBookUsage(activeBook.id, { images: 1 });

				// The labels go with the image. They are coordinates into this specific
				// picture, so the previous set must be replaced, never carried over.
				globalState.updateChapterIllustration(
					activeBook.id, editTarget.chapterId, made.url, made.labels
				);
				editTarget = { ...editTarget, illustrationUrl: made.url, illustrationPrompt: made.prompt };

			} else if (editTarget.scope === 'diagram') {
				const kind = editTarget.diagramKind ?? 'fence';
				const isUltra = useRealisticIllustration || activeBook.useUltraRealistic || activeBook.coverSettings?.useUltraRealistic;
				if (isUltra) {
					// Turning a diagram into a photograph loses the diagram's exact
					// geometry, so the replacement has to earn its place: it is briefed
					// from the chapter and the research, told what point the diagram was
					// making, and told to stage that point physically rather than redraw
					// it. The old prompt handed the raw diagram source straight to the
					// image model, which tried to render its labels — and could not spell
					// them.
					const made = await createIllustration(
						activeBook,
						{
							chapterTitle:   editTarget.chapterTitle,
							chapterOrder:   editTarget.chapterOrder,
							chapterSummary: editTarget.chapterSummary,
							chapterContent: editTarget.chapterContent,
							researchNotes:  editTarget.researchNotes,
							diagramIntent:  editTarget.diagramRaw
						},
						globalState.apiKeys,
						globalState.apiKeys.useMockMode,
						useRealisticIllustration
					);
					made.claudeUsage.forEach(u => globalState.addBookUsage(activeBook.id, { claude: u }));
					if (made.imageBilled) globalState.addBookUsage(activeBook.id, { images: 1 });

					// Keep the diagram's own title — the author wrote it, and it names the
					// point the plate is still making.
					const plateTitle = (
						editTarget.diagramRaw?.match(/^\s*title:\s*(.+)$/im)?.[1] ?? editTarget.chapterTitle
					).trim();

					// A plate fence rather than a bare ![](), because a markdown image has
					// nowhere to carry the callouts. The fence keeps them as data that the
					// renderer sets in real type — which is the only way the labels are
					// spelled correctly.
					const plateBlock = [
						'```plate',
						`title: ${plateTitle}`,
						`image: ${made.url}`,
						made.labels.length ? `callouts: ${JSON.stringify(made.labels)}` : '',
						'```'
					].filter(Boolean).join('\n');

					const updatedContent = spliceVisualBlock(
						editTarget.chapterContent, kind,
						editTarget.diagramRaw ?? '',
						editTarget.diagramIndex ?? 0,
						plateBlock, true
					);
					globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
					editTarget = {
						...editTarget,
						chapterContent: updatedContent,
						illustrationUrl: made.url,
						illustrationPrompt: made.prompt,
						scope: 'illustration'
					};
				} else {
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
					if (data.usage) globalState.addBookUsage(activeBook.id, { claude: data.usage });
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

			lastInstruction = '';
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
				if (rData.success) globalState.addBookUsage(activeBook.id, { searches: 1 });
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
			if (data.usage) globalState.addBookUsage(activeBook.id, { claude: data.usage });

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
				if (data.usage) globalState.addBookUsage(activeBook.id, { claude: data.usage });
				globalState.updateChapterContent(activeBook.id, editTarget.chapterId, data.content, 'completed');
				if (data.design) {
					globalState.updateBookInteriorDesign(activeBook.id, {
						...activeBook.interiorDesign,
						...data.design
					});
				}
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
				if (data.usage) globalState.addBookUsage(activeBook.id, { claude: data.usage });
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
				if (promptData.usage) globalState.addBookUsage(activeBook.id, { claude: promptData.usage });
				const newIllustUrl = await generateImage({
					prompt:      promptData.prompt,
					apiKey:      globalState.apiKeys.imageKey,
					provider:    globalState.apiKeys.imageProvider,
					useMockMode: globalState.apiKeys.useMockMode,
					isCover:     false
				});
				if (newIllustUrl && !globalState.apiKeys.useMockMode && globalState.apiKeys.imageKey) {
					globalState.addBookUsage(activeBook.id, { images: 1 });
				}

				// Re-label against the NEW picture. The old labels are coordinates into
				// the image this one just replaced, so keeping them would leave every
				// callout pointing at a part that is no longer in the frame.
				const labelResult = await labelIllustration(
					activeBook,
					{
						chapterTitle:   editTarget.chapterTitle,
						chapterOrder:   editTarget.chapterOrder,
						chapterContent: editTarget.chapterContent,
						researchNotes:  editTarget.researchNotes
					},
					newIllustUrl,
					'',
					globalState.apiKeys,
					globalState.apiKeys.useMockMode
				);
				if (labelResult.usage) globalState.addBookUsage(activeBook.id, { claude: labelResult.usage });
				const newLabels = labelResult.labels;
				globalState.updateChapterIllustration(
					activeBook.id, editTarget.chapterId, newIllustUrl, newLabels
				);
				editTarget = { ...editTarget, illustrationUrl: newIllustUrl, illustrationPrompt: promptData.prompt };

			} else if (editTarget.scope === 'diagram') {
				const kind = editTarget.diagramKind ?? 'fence';
				if (useRealisticIllustration) {
					// Same as the regenerate path, with the author's instruction folded in
					// as extra art direction rather than replacing it.
					const made = await createIllustration(
						activeBook,
						{
							chapterTitle:   editTarget.chapterTitle,
							chapterOrder:   editTarget.chapterOrder,
							chapterSummary: editTarget.chapterSummary,
							chapterContent: editTarget.chapterContent,
							researchNotes:  editTarget.researchNotes,
							diagramIntent:  editTarget.diagramRaw,
							authorNote:     instruction.trim() || undefined
						},
						globalState.apiKeys,
						globalState.apiKeys.useMockMode,
						useRealisticIllustration
					);
					made.claudeUsage.forEach(u => globalState.addBookUsage(activeBook.id, { claude: u }));
					if (made.imageBilled) globalState.addBookUsage(activeBook.id, { images: 1 });

					const plateTitle = (
						editTarget.diagramRaw?.match(/^\s*title:\s*(.+)$/im)?.[1] ?? editTarget.chapterTitle
					).trim();
					const plateBlock = [
						'```plate',
						`title: ${plateTitle}`,
						`image: ${made.url}`,
						made.labels.length ? `callouts: ${JSON.stringify(made.labels)}` : '',
						'```'
					].filter(Boolean).join('\n');

					const updatedContent = spliceVisualBlock(
						editTarget.chapterContent, kind,
						editTarget.diagramRaw ?? '',
						editTarget.diagramIndex ?? 0,
						plateBlock, true
					);
					globalState.updateChapterContent(activeBook.id, editTarget.chapterId, updatedContent, 'completed');
					editTarget = {
						...editTarget,
						chapterContent: updatedContent,
						illustrationUrl: made.url,
						illustrationPrompt: made.prompt,
						scope: 'illustration'
					};
				} else {
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
					if (data.usage) globalState.addBookUsage(activeBook.id, { claude: data.usage });
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
</script>

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

<style>
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
