<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import type { Chapter } from '$lib/types';

	let fontSize = $state(18);
	let readerTheme = $state<'cream' | 'sepia' | 'white' | 'night'>('cream');

	let copySuccess = $state(false);
	let isPdfExporting = $state(false);

	let activeBook = $derived(globalState.activeBook);
	let coverSettings = $derived(activeBook?.coverSettings);
	let isBakedCover = $derived(
		!!coverSettings?.bgImageUrl &&
		!!(activeBook?.coverOptions?.some(o => o.imageUrl && o.imageUrl === coverSettings?.bgImageUrl))
	);

	// ── Content Editor state ──────────────────────────────────────────────────
	type EditScope = 'page' | 'chapter' | 'illustration';

	interface EditTarget {
		scope: EditScope;
		chapterId: string;
		chapterTitle: string;
		chapterOrder: number;
		chapterSummary: string;
		chapterContent: string;
		// page scope
		pageIndex?: number;
		pageStartIdx?: number;   // markdown block start index for this page
		pageEndIdx?: number;     // markdown block end index (exclusive) for this page
		pageText?: string;       // plain-text snapshot sent to Claude as context
		// illustration scope
		illustrationUrl?: string;
		illustrationPrompt?: string;
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

	function openEditPanel(target: EditTarget) {
		editTarget = target;
		editInstruction = '';
		editSuccess = false;
		editError = '';
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
		const instruction = editInstruction.trim();
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
						chapterSummary: editTarget.chapterSummary
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
						pageContent: editTarget.pageText
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
				const freshPrompt = [
					`A high-quality editorial illustration for a chapter titled "${editTarget.chapterTitle}"`,
					editTarget.chapterSummary ? `about: ${editTarget.chapterSummary}` : '',
					`from the book "${activeBook.title}" (${activeBook.genre}).`,
					'Cinematic lighting, detailed composition, professional finish.'
				].filter(Boolean).join(' ');

				const imgRes = await fetch('/api/image', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						prompt: freshPrompt,
						apiKey: globalState.apiKeys.imageKey,
						provider: globalState.apiKeys.imageProvider,
						useMockMode: globalState.apiKeys.useMockMode,
						isCover: false
					})
				});
				const imgData = await imgRes.json();
				if (!imgData.success) throw new Error(imgData.error || 'Image generation failed');
				globalState.updateChapterIllustration(activeBook.id, editTarget.chapterId, imgData.imageUrl);
				editTarget = { ...editTarget, illustrationUrl: imgData.imageUrl, illustrationPrompt: freshPrompt };
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
						editInstruction: instruction
					})
				});
				const data = await res.json();
				if (!data.success) throw new Error(data.error || 'Edit failed');
				globalState.updateChapterContent(activeBook.id, editTarget.chapterId, data.content, 'completed');
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
						editInstruction: instruction
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
				const imgRes = await fetch('/api/image', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						prompt: promptData.prompt,
						apiKey: globalState.apiKeys.imageKey,
						provider: globalState.apiKeys.imageProvider,
						useMockMode: globalState.apiKeys.useMockMode,
						isCover: false
					})
				});
				const imgData = await imgRes.json();
				if (!imgData.success) throw new Error(imgData.error || 'Image generation failed');
				globalState.updateChapterIllustration(activeBook.id, editTarget.chapterId, imgData.imageUrl);
				// Keep illustration URL in sync for subsequent Redo
				editTarget = { ...editTarget, illustrationUrl: imgData.imageUrl, illustrationPrompt: promptData.prompt };
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
	let observer: IntersectionObserver | null = null;

	// Svelte action to register a section element
	function registerSection(el: HTMLElement, id: 'cover' | number | string) {
		if (typeof id === 'string' && id.includes('-')) return;
		const key = String(id);
		sectionEls.set(key, el);
		el.setAttribute('data-section-id', key);

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
			observer = new IntersectionObserver(
				(entries) => {
					// Pick the entry that is intersecting and has the largest intersection ratio
					let best: IntersectionObserverEntry | null = null;
					for (const entry of entries) {
						if (entry.isIntersecting) {
							if (!best || entry.intersectionRatio > best.intersectionRatio) {
								best = entry;
							}
						}
					}
					if (best) {
						const raw = (best.target as HTMLElement).getAttribute('data-section-id');
						activeSection = raw === 'cover' ? 'cover' : parseInt(raw ?? '0');
					}
				},
				{ threshold: [0.1, 0.25, 0.5] }
			);

			sectionEls.forEach((el) => observer?.observe(el));
		});

		return () => {
			observer?.disconnect();
		};
	});

	// ── Markdown renderer ──────────────────────────────────────────────────────
	function parseMarkdown(md: string): string {
		if (!md) return '<p>No content written for this chapter yet.</p>';

		let html = md.trim();
		html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

		// Headings — handle h1–h4 in descending order so #### matches before ###
		html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
		html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
		html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
		html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
		html = html.replace(/^\> (.*?)$/gm, '<blockquote>$1</blockquote>');
		html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
		html = html.replace(/^\* (.*?)$/gm, '<li>$1</li>');
		html = html.replace(/^- (.*?)$/gm, '<li>$1</li>');

		const paragraphs = html.split('\n\n');
		html = paragraphs.map((p) => {
			const trimmed = p.trim();
			if (!trimmed) return '';
			if (trimmed.startsWith('<h') || trimmed.startsWith('<blockquote') || trimmed.startsWith('<li')) return trimmed;
			return `<p>${trimmed}</p>`;
		}).join('\n');

		html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
		html = html.replace(/<\/ul>\s*<ul>/g, '');
		return html;
	}

	// ── Copy Markdown ──────────────────────────────────────────────────────────
	function handleCopyMarkdown() {
		if (!activeBook) return;
		let md = `# ${activeBook.title}\n## ${activeBook.subtitle}\nBy ${activeBook.author}\n\n`;
		activeBook.chapters.forEach((c) => {
			md += `\n# Chapter ${c.order}: ${c.title}\n\n${c.content}\n`;
		});
		navigator.clipboard.writeText(md).then(() => {
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2500);
		});
	}

	// Helper to convert remote URLs to base64 Data URLs for offline/CORS-safe canvas drawing
	async function getAsDataUrl(url: string): Promise<string> {
		if (!url) return '';
		if (url.startsWith('data:')) return url;
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);
			const blob = await res.blob();
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result as string);
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
		} catch (err) {
			console.warn(`Could not convert ${url} to data URL (CORS or network error). Image will be omitted from PDF.`);
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
				.map((c) => `<div class="toc-row">Chapter ${c.order} — ${c.title}</div>`)
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
			const BODY_H = PAGE_H_PX - PAD_TOP - PAD_BOTTOM - HDR_H - FTR_H;
			const BODY_W = PAGE_W_PX - PAD_LEFT - PAD_RIGHT;

			let chapHtml = '';
			let pageCounter = 1;

			activeBook.chapters.forEach((c) => {
				if (c.status !== 'completed' || !c.content) return;

				const fullMd   = parseMarkdown(c.content);
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
				measurer.style.cssText =
					`position:absolute;visibility:hidden;width:${BODY_W}px;` +
					`font-size:13px;line-height:1.85;font-family:${bodyFontCss};`;
				document.body.appendChild(measurer);

				for (const blk of blocks) {
					measurer.innerHTML = blk;
					const h = measurer.offsetHeight + 20;
					if (curH + h > budget && cur.length > 0) {
						pages.push({ blocks: cur, isFirst: pages.length === 0 });
						cur = []; curH = 0; budget = BODY_H;
					}
					cur.push(blk); curH += h;
				}
				if (cur.length) pages.push({ blocks: cur, isFirst: pages.length === 0 });
				document.body.removeChild(measurer);

				pages.forEach(({ blocks: pBlocks, isFirst }) => {
					const chapHeader = isFirst ? `
						<div class="chapter-header">
							<span class="chapter-label">Chapter ${c.order}</span>
							<h2 class="chapter-title">${c.title}</h2>
							<hr class="chapter-rule">
						</div>${illustHtml}` : '';

					chapHtml += `
						<section class="chapter-section ${coverStyleClass}">
							<div class="running-header">
								<span class="rh-book">${activeBook.title}</span>
								<span class="rh-chap">Chapter ${c.order} — ${c.title}</span>
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
	font-family: ${bodyFontCss};
	font-size: 12pt;
	line-height: 1.85;
	color: #1A1612;
	background: #fff;
	-webkit-print-color-adjust: exact;
	print-color-adjust: exact;
	}
	@page { size: 8.5in 11in; margin: 0; }
	.cover-page {
	width: 8.5in;
	height: 11in;
	position: relative;
	display: flex;
	flex-direction: column;
	padding: 1.25in 1.25in;
	${coverBg}
	text-align: ${alignment};
	overflow: hidden;
	page-break-after: always;
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
	font-family: 'Inter',sans-serif;
	font-size: 7.5pt;
	text-transform: uppercase;
	letter-spacing: 1.5pt;
	color: #9A8E82;
	border-bottom: 0.5pt solid #D9CFC2;
	padding-bottom: 6pt;
	margin-bottom: 0;
	flex-shrink: 0;
	}
	.rh-book  { font-weight: 600; }
	.rh-chap  { font-style: italic; font-family: ${titleFontCss}; text-transform: none; letter-spacing: 0; }
	.chapter-content { flex: 1; overflow: hidden; padding-top: 0.5in; }
	.chapter-header { margin-bottom: 2rem; text-align: ${alignment}; display: flex; flex-direction: column; align-items: ${flexAlign}; }
	.chapter-label  { font-family: 'Inter',sans-serif; font-size: 8pt; text-transform: uppercase; letter-spacing: 3pt; color: ${accent}; margin-bottom: 6pt; }
	.chapter-title  { font-family: ${titleFontCss}; font-size: 20pt; font-weight: 700; line-height: 1.25; color: ${titleColor}; margin-bottom: 12pt; }
	.chapter-rule   { border: none; border-top: 1.5pt solid ${accent}; width: ${ruleW}; margin-left: ${ruleML}; margin-right: ${ruleMR}; }
	.illustration { margin: 16pt 0; text-align: center; }
	.illustration img { max-width: 100%; max-height: 240pt; border-radius: 3pt; }
	p { margin: 0 0 10pt; text-indent: 1.4em; hyphens: auto; }
	p:first-of-type { text-indent: 0; }
	.has-drop-cap p:first-of-type::first-letter {
	font-family: ${titleFontCss};
	font-size: 3.2em; float: left;
	line-height: 0.85; margin-top: 0.1em; margin-right: 0.1em;
	font-weight: 700; color: ${accent};
	}
	h2 { font-family: ${titleFontCss}; font-size: 15pt; font-weight: 600; color: ${titleColor}; margin: 18pt 0 8pt; }
	h3 { font-family: ${titleFontCss}; font-size: 12pt; font-weight: 600; color: ${titleColor}; margin: 14pt 0 6pt; }
	blockquote { border-left: 3pt solid ${accent}; margin: 14pt 0; padding-left: 14pt; font-style: italic; color: #6A6055; }
	ul, ol { margin: 10pt 0; padding-left: 20pt; }
	li { margin-bottom: 5pt; }
	strong { font-weight: 700; }
	em { font-style: italic; }
	.running-footer {
	display: flex;
	justify-content: center;
	align-items: center;
	padding-top: 6pt;
	border-top: 0.5pt solid #D9CFC2;
	flex-shrink: 0;
	}
	.page-num { font-family: 'Inter',sans-serif; font-size: 8pt; color: #9A8E82; letter-spacing: 1pt; }

	.style-dark-minimalist .chapter-title { font-weight: 300; letter-spacing: 2pt; text-transform: uppercase; }
	.style-bold-graphic    .chapter-title { font-weight: 800; text-transform: uppercase; letter-spacing: -0.5pt; }
	.style-bold-graphic    .chapter-label { background: ${accent}; color: #fff; padding: 2pt 6pt; border-radius: 2pt; }
	.style-bold-graphic    .chapter-rule  { border-top-width: 4pt; }
	.style-warm-editorial  .chapter-title { font-style: italic; }

	@media print {
	body { background: #fff; }
	.cover-page, .toc-page, .chapter-section { page-break-after: always; }
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
				});

				const dataUrls: Record<string, string> = {};
				await Promise.all(
					imageUrls.map(async (url) => {
						dataUrls[url] = await getAsDataUrl(url);
					})
				);

				// ── Step 2: Build the self-contained HTML document ─────────────────
				const fullHtml = buildFullHtml(dataUrls);

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
				// Extra settle time for background-image paints and layout reflow
				await new Promise((resolve) => setTimeout(resolve, 600));

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

		// Design values based on the cover style and options
		let coverStyle = $derived(
			activeBook && activeBook.selectedCoverIndex !== null && activeBook.coverOptions?.[activeBook.selectedCoverIndex]
				? activeBook.coverOptions[activeBook.selectedCoverIndex].style
				: 'Warm Editorial'
		);

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

		let designAccentColor = $derived(
			coverSettings?.authorColor || '#8E7453'
		);

		let designTitleColor = $derived(
			coverSettings?.titleColor || '#1A1612'
		);

		let designSubtitleColor = $derived(
			coverSettings?.subtitleColor || '#6E6860'
		);

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

		const maxPageHeight = 740;
		const newPaginated: Record<string, PageSlice[]> = {};

		for (const chap of activeBook.chapters) {
			if (chap.status !== 'completed' || !chap.content) {
				newPaginated[chap.id] = [{ blocks: ['<p>This chapter has not been written yet.</p>'], startIdx: 0, endIdx: 1 }];
				continue;
			}

			const fullHtml = parseMarkdown(chap.content);
			const blocks = splitHtmlIntoBlocks(fullHtml);
			const pages: PageSlice[] = [];
			let currentBlocks: string[] = [];
			let currentHeight = 0;
			let currentStartIdx = 0;

			// Reserve space for the chapter header on page 1
			currentHeight += 160;

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
							📔 Cover
						</button>

						{#each activeBook.chapters as chap, idx}
							<button
								class="toc-item {activeSection === idx ? 'active' : ''}"
								onclick={() => scrollTo(idx)}
								disabled={chap.status !== 'completed'}
							>
								<span class="chap-num">Chapter {chap.order}</span>
								<span class="chap-title">{chap.title}</span>
							</button>
						{/each}
					</nav>

					<div class="sidebar-actions">
						<div class="theme-row">
							<span class="label font-serif">Paper:</span>
							<button class="theme-dot cream {readerTheme === 'cream' ? 'on' : ''}" onclick={() => readerTheme = 'cream'} aria-label="Cream"></button>
							<button class="theme-dot sepia {readerTheme === 'sepia' ? 'on' : ''}" onclick={() => readerTheme = 'sepia'} aria-label="Sepia"></button>
							<button class="theme-dot white {readerTheme === 'white' ? 'on' : ''}" onclick={() => readerTheme = 'white'} aria-label="White"></button>
							<button class="theme-dot night {readerTheme === 'night' ? 'on' : ''}" onclick={() => readerTheme = 'night'} aria-label="Night"></button>
						</div>

						<div class="font-row">
							<span class="label font-serif">Size:</span>
							<button class="font-btn" onclick={() => fontSize = Math.max(fontSize - 1, 14)}>A-</button>
							<span class="font-val font-serif">{fontSize}px</span>
							<button class="font-btn" onclick={() => fontSize = Math.min(fontSize + 1, 26)}>A+</button>
						</div>

						<button class="action-btn font-serif" onclick={handleCopyMarkdown}>
							{copySuccess ? '✓ Copied!' : '📋 Copy Markdown'}
						</button>
						<button class="action-btn font-serif" onclick={handleCompileHtml}>
							💾 Export HTML
						</button>
						<button
							class="action-btn action-btn--primary font-serif"
							onclick={handleExportPdf}
							disabled={isPdfExporting}
						>
							{#if isPdfExporting}
								<span class="spinner"></span> Generating...
							{:else}
								📄 Export PDF
							{/if}
						</button>
					</div>
				</aside>

				<!-- Continuous scroll reader -->
				<main class="reader-scroll-area">

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
							style="
								--chapter-font-family: {designFontFamily};
								--chapter-body-font: {designBodyFont};
								--chapter-accent-color: {designAccentColor};
								--chapter-title-color: {designTitleColor};
								--chapter-subtitle-color: {designSubtitleColor};
								--chapter-alignment: {coverSettings?.alignment || 'center'};
								--chapter-rule-width: {ruleWidth};
								--chapter-rule-margin-left: {ruleMarginLeft};
								--chapter-rule-margin-right: {ruleMarginRight};
								--header-flex-align: {headerFlexAlign};
							"
						>
							<!-- Book page wrap — centres the sheet in the scroll viewport -->
							<div class="book-page-wrap">

								<!-- US Letter sheet: 8.5 × 11 in — header, body, and footer all live inside -->
								<div class="book-page-card style-{coverStyle.toLowerCase().replace(/\s+/g, '-')}" style="font-size: {fontSize}px;">

									<!-- Running header — top of page, inside the margin -->
									<header class="running-header" aria-hidden="true">
										<span class="running-header__book">{activeBook.title}</span>
										<span class="running-header__chapter">Chapter {chap.order} — {chap.title}</span>
									</header>

									<!-- Body content area — scrolls between header and footer -->
									<div class="page-body">

										{#if pageIdx === 0}
											<!-- Chapter header — label, title, rule -->
											<div class="chapter-header">
												<span class="chapter-label">Chapter {chap.order}</span>
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
														illustrationUrl: chap.illustrationUrl ?? '',
														illustrationPrompt: chap.summary
															? `A high-quality editorial illustration for a chapter titled "${chap.title}" about: ${chap.summary}. Cinematic lighting, detailed, professional.`
															: `Editorial illustration: "${chap.title}"`
													})}
												>🎨 Edit Illustration</button>
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
													pageIndex: pageIdx,
													pageStartIdx: pageSlice.startIdx,
													pageEndIdx: pageSlice.endIdx,
													pageText: htmlToPlainText(pageSlice.blocks.join(''))
												})}
											>✏️ Edit Page</button>

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
														chapterContent: chap.content
													})}
												>📖 Edit Chapter</button>
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

			<!-- ── AI Content Editor Drawer ──────────────────────────────────── -->
			{#if editTarget}
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
							<span class="edit-drawer__scope-badge edit-drawer__scope-badge--{editTarget.scope}">
								{editTarget.scope === 'page' ? '✏️ Page' : editTarget.scope === 'chapter' ? '📖 Chapter' : '🎨 Illustration'}
							</span>
							<h3 class="edit-drawer__title font-serif">
								{editTarget.scope === 'page'
									? `Page ${(editTarget.pageIndex ?? 0) + 1} · Chapter ${editTarget.chapterOrder}`
									: editTarget.scope === 'chapter'
									? `Chapter ${editTarget.chapterOrder}`
									: `Illustration`}
							</h3>
						</div>
						<p class="edit-drawer__subtitle font-serif">{editTarget.chapterTitle}</p>
						<button class="edit-drawer__close" onclick={closeEditPanel} aria-label="Close editor">✕</button>
					</div>

					<!-- Scope hint -->
					<div class="edit-drawer__context">
						{#if editTarget.scope === 'page'}
							<p class="edit-drawer__hint">AI will rewrite this specific page while preserving the rest of the chapter. Describe what you want changed.</p>
						{:else if editTarget.scope === 'chapter'}
							<p class="edit-drawer__hint">AI will rewrite the entire chapter based on your instruction. Structure and tone are maintained unless you specify otherwise.</p>
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
					</div>

					<!-- Footer -->
					<div class="edit-drawer__footer">
						{#if editError}
							<p class="edit-drawer__error" role="alert">{editError}</p>
						{/if}
						{#if editSuccess}
							<p class="edit-drawer__success" role="status">
								{editTarget.scope === 'illustration' ? '🎨 New illustration generated.' : '✓ Content updated.'}
							</p>
						{/if}

						<!-- Primary action row: Apply + Redo -->
						<div class="edit-drawer__actions">
							<button
								class="edit-drawer__cancel"
								onclick={closeEditPanel}
								disabled={isEditing}
							>Cancel</button>

							<!-- Redo: replay last instruction — visible only after first successful edit -->
							{#if lastInstruction}
								{@const redoTitle = `Re-run: "${lastInstruction.slice(0, 60)}${lastInstruction.length > 60 ? '…' : ''}"`}
								<button
									class="edit-drawer__redo"
									onclick={applyRedo}
									disabled={isEditing}
									title={redoTitle}
									aria-label="Redo last edit"
								>
									{#if isEditing && activeAction === 'redo'}
										<span class="spinner spinner--dark"></span>
									{:else}
										↺
									{/if}
									Redo
								</button>
							{/if}

							<button
								class="edit-drawer__apply"
								onclick={applyEdit}
								disabled={isEditing || !editInstruction.trim()}
							>
								{#if isEditing && activeAction === 'apply'}
									<span class="spinner"></span>
									{editTarget.scope === 'illustration' ? 'Generating…' : 'Applying…'}
								{:else}
									{editTarget.scope === 'illustration' ? '🎨 Generate' : '✨ Apply Edit'}
								{/if}
							</button>
						</div>

						<!-- Secondary action: Reconstruct (full AI rewrite, no prompt needed) -->
						<div class="edit-drawer__secondary-actions">
							<button
								class="edit-drawer__reconstruct"
								onclick={applyReconstruct}
								disabled={isEditing}
								title={editTarget.scope === 'illustration'
									? 'Generate a completely new illustration from scratch'
									: 'Discard current content and rewrite from scratch using the original chapter brief'}
							>
								{#if isEditing && activeAction === 'reconstruct'}
									<span class="spinner spinner--accent"></span>
									Reconstructing…
								{:else}
									⟳ Reconstruct from Scratch
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
		border: 1px solid var(--r-border);
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
	/*
	 * Sits at the top of the page inside the outer margin.
	 * Book title on the left (recto convention), chapter on the right.
	 */
	.running-header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding-bottom: 0.45rem;
		margin-bottom: 0.6rem;
		border-bottom: 0.5px solid var(--chapter-accent-color, var(--r-border));
		flex-shrink: 0;
		gap: 1rem;
	}

	.running-header__book {
		font-family: var(--font-sans);
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 2.5px;
		font-weight: 600;
		color: var(--chapter-accent-color, var(--r-muted));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		opacity: 0.7;
	}

	.running-header__chapter {
		font-family: var(--font-serif);
		font-size: 0.6rem;
		font-style: italic;
		color: var(--chapter-accent-color, var(--r-muted));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: right;
		opacity: 0.7;
	}

	/* ── Page body ──────────────────────────────────────────────────────────── */
	/* Fills all space between the running header and the footer */
	.page-body {
		flex: 1;
		overflow: hidden;
		min-height: 0;
	}

	/* ── Running footer / page number ───────────────────────────────────────── */
	/*
	 * Centred folio (page number) with a thin rule above it — the most
	 * common convention in professionally typeset books.
	 */
	.page-footer {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding-top: 0.45rem;
		margin-top: 0.6rem;
		border-top: 0.5px solid var(--chapter-accent-color, var(--r-border));
		flex-shrink: 0;
	}

	.page-footer__rule {
		flex: 1;
		height: 1px;
		/* intentionally transparent — the border-top on .page-footer carries the full rule */
	}

	.page-footer__num {
		font-family: var(--font-serif);
		font-size: 0.65rem;
		color: var(--chapter-accent-color, var(--r-muted));
		letter-spacing: 1.5px;
		opacity: 0.7;
	}

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

	.chapter-header { margin-bottom: 2.5rem; }

	.chapter-label {
		display: block;
		font-family: var(--font-sans);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 2.5px;
		color: var(--chapter-accent-color, var(--accent));
		font-weight: 600;
		margin-bottom: 0.6rem;
		text-align: var(--chapter-alignment, center);
	}

	.chapter-title {
		font-size: 2rem;
		font-weight: 700;
		line-height: 1.25;
		margin: 0 0 1.5rem;
		color: var(--chapter-title-color, var(--r-text));
		font-family: var(--chapter-font-family, var(--font-serif));
		text-align: var(--chapter-alignment, center);
	}

	.chapter-rule {
		border: none;
		border-top: 1.5px solid var(--chapter-accent-color, var(--r-border));
		margin: 0;
		width: var(--chapter-rule-width, 100%);
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
		font-family: var(--chapter-body-font, var(--font-serif));
	}

	.chapter-body :global(p) {
		margin-bottom: 1.5rem;
		text-indent: 1.5rem;
	}

	.chapter-body :global(p:first-of-type) { text-indent: 0; }

	/* Drop Cap: Industry standard styling for first paragraph */
	.has-drop-cap :global(p:first-of-type::first-letter) {
		font-family: var(--chapter-font-family, var(--font-serif));
		font-size: 3.5em;
		float: left;
		line-height: 0.85;
		margin-top: 0.1em;
		margin-right: 0.15em;
		font-weight: 700;
		color: var(--chapter-accent-color, var(--accent));
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
		border-left: 3.5px solid var(--chapter-accent-color, var(--accent));
		margin: 2rem 0;
		padding-left: 1.8rem;
		font-style: italic;
		color: var(--r-muted);
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

	/* Cover-specific chapter style pairs */
	.style-dark-minimalist .chapter-title {
		font-weight: 300;
		letter-spacing: 2px;
		text-transform: uppercase;
	}
	.style-dark-minimalist .chapter-body :global(blockquote) {
		border-left: 2px solid var(--chapter-accent-color);
		background-color: var(--r-active-bg);
		padding: 1.2rem 1.8rem;
		border-radius: 4px;
	}

	.style-bold-graphic .chapter-title {
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: -0.5px;
	}
	.style-bold-graphic .chapter-label {
		font-weight: 800;
		background: var(--chapter-accent-color);
		color: #fff !important;
		display: inline-block;
		padding: 0.2rem 0.6rem;
		border-radius: 4px;
		margin-bottom: 1rem;
	}
	.style-bold-graphic .chapter-header {
		display: flex;
		flex-direction: column;
		align-items: var(--header-flex-align, center);
	}
	.style-bold-graphic .chapter-rule {
		border-top: 4px solid var(--chapter-accent-color);
	}

	.style-warm-editorial .chapter-title {
		font-style: italic;
	}
	.style-warm-editorial .chapter-body :global(p:first-of-type::first-letter) {
		font-style: italic;
	}

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
		z-index: 40;
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
		z-index: 50;
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
