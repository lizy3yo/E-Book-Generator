<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { globalState } from '$lib/state.svelte';
	import type { Chapter } from '$lib/types';
	import { INTERIOR_PRESETS } from '$lib/interiorDesigns';
	import { samplePalette } from '$lib/coverPalette';
	import {
		BookMarked, FileDown,
		Image as ImageIcon, PenLine, BookOpen,
		RefreshCcw
	} from '@lucide/svelte';
	import type { EditTarget, PageSlice } from '$lib/reader/types';
	import {
		paginateChapters,
		calculateOverallPageNumber as calcOverallPageNumber
	} from '$lib/reader/pagination';
	import { getDiagramBlockRaw, spliceVisualBlock, getChapterLabel, htmlToPlainText, isLightColor } from '$lib/reader/utils';
	import { buildFullHtml, getAsDataUrl } from '$lib/reader/exportHtml';
	import EditDrawer from '$lib/components/reader/EditDrawer.svelte';

	let fontSize = $state(18);
	let readerTheme = $state<'white'>('white');
	// Incrementing this forces all section style attributes to re-evaluate,
	// snapping header/footer design tokens back to the current cover settings.
	let designKey = $state(0);

	let headerFooterPreset = $state('Field Manual');
	let interiorCustomInstructions = $state('');

	// Instantly apply a named preset from $lib/interiorDesigns without hitting the AI endpoint.
	// Useful when the user just wants to swap layout style without regenerating from the cover.
	function applyPresetInstantly(preset: string) {
		if (!activeBook) return;
		const cs = activeBook.coverSettings;
		// Prefer what was read off the cover IMAGE. `coverSettings.titleColor` and
		// `.authorColor` describe a cover laid out in HTML; a generated cover bakes
		// its type into the artwork, so those fields no longer describe anything a
		// reader can see, and colouring the interior from them means colouring it
		// from nothing. They stay as the fallback for books with no cover read yet.
		const cd = activeBook.coverDesign;
		const primary = cd?.primary   || cs?.titleColor  || '#1A1612';
		const accent  = cd?.accent    || cs?.authorColor || '#8E7453';
		const alignment = cs?.alignment || 'left';
		const titleFont = cd?.titleFont || cs?.titleFont || 'Lora';
		const presetFn = INTERIOR_PRESETS[preset];
		if (!presetFn) return;
		const design = presetFn({ primary, accent, alignment, titleFont });
		const current = activeBook.interiorDesign ?? {};
		// _presetName records which named preset produced these tokens, so the
		// dropdown can be restored to the user's actual choice on the next visit
		// instead of always opening back on the hardcoded initial value.
		globalState.updateBookInteriorDesign(activeBook.id, { ...current, ...design, _presetName: preset });
		designKey = Date.now();
	}

	let appliedPreset = $state('Field Manual');
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

	// Restores the preset dropdown to what was actually saved for this book,
	// once per book switch — local $state initialisers only run on first mount,
	// so without this every book reopened the panel on the hardcoded default.
	let presetSyncedForBookId = $state<string | null>(null);
	$effect(() => {
		if (activeBook && activeBook.id !== presetSyncedForBookId) {
			presetSyncedForBookId = activeBook.id;
			const saved = activeBook.interiorDesign?._presetName;
			headerFooterPreset = saved ?? 'Field Manual';
			appliedPreset = headerFooterPreset;
		}
	});

	// editTarget is bound to EditDrawer
	let editTarget = $state<EditTarget | null>(null);

	function openEditPanel(target: EditTarget) {
		editTarget = target;
	}

	// Local adapter: getChapterLabel now requires a chapters array third argument
	function _getChapterLabel(chap: { title: string; order: number }, idx: number): string {
		return getChapterLabel(chap, idx, activeBook?.chapters ?? []);
	}

	/** Click-delegation handler for the reader scroll container */
	function handleReaderClick(e: MouseEvent) {
		const btn = (e.target as HTMLElement).closest('.edit-trigger--diagram') as HTMLElement | null;
		if (!btn) return;
		e.stopPropagation();
		const chapId = btn.dataset.chapterId ?? '';
		const chap   = activeBook?.chapters.find(c => c.id === chapId);
		if (!chap || !activeBook) return;

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
			md += `\n# ${_getChapterLabel(c, idx)}: ${c.title}\n\n${c.content}\n`;
		});
		navigator.clipboard.writeText(md).then(() => {
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2500);
		});
	}

	// ── Export HTML ──────────────────────────────────────────────────────────
	async function handleCompileHtml() {
		if (!activeBook) return;

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

		const html = buildFullHtml(activeBook, _getChapterLabel, dataUrls);
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

	// ── PDF Export ─────────────────────────────────────────────────────────────
	async function handleExportPdf() {
		if (!activeBook || isPdfExporting) return;
		isPdfExporting = true;

		let iframe: HTMLIFrameElement | null = null;

		try {
			// ── Step 1: Resolve all images to base64 data URLs ─────────────────
			const imageUrls: string[] = [];
			const cs = activeBook.coverSettings;
			if (cs.bgImageUrl) imageUrls.push(cs.bgImageUrl);
			activeBook.chapters.forEach((c) => {
				if (c.illustrationUrl) imageUrls.push(c.illustrationUrl);
				if (c.content) {
					// Two forms live in chapter content and BOTH must be resolved:
					// markdown images, and raw <img> tags — the edit drawer splices
					// rendered HTML, not markdown. Anything missed here reaches
					// html2canvas as a live cross-origin URL, which it requests with
					// CORS (useCORS: true) and which then fails or stalls the export.
					const patterns = [
						/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g,
						/<img\b[^>]*\bsrc="(https?:\/\/[^"]+)"/gi
					];
					for (const re of patterns) {
						let m: RegExpExecArray | null;
						while ((m = re.exec(c.content)) !== null) {
							if (!imageUrls.includes(m[1])) imageUrls.push(m[1]);
						}
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
			const fullHtml = buildFullHtml(activeBook, _getChapterLabel, dataUrls).replace(/\sloading="lazy"/g, '');

			// ── Step 3: Mount a hidden iframe ───────────────────────────────────
			iframe = document.createElement('iframe');
			iframe.style.cssText =
				'position:fixed;left:-9999px;top:0;width:6in;height:9in;border:0;opacity:0;pointer-events:none;';
			document.body.appendChild(iframe);

			await new Promise<void>((resolve, reject) => {
				iframe!.onload = () => resolve();
				iframe!.onerror = () => reject(new Error('iframe failed to load'));
				iframe!.srcdoc = fullHtml;
			});

			const iDoc = iframe.contentDocument!;
			const iWin = iframe.contentWindow!;

			// ── Step 4: Wait for fonts inside the iframe ───────────────────────
			if (iDoc.fonts) await iDoc.fonts.ready;

			// ── Step 4b: Wait for all <img> tags inside the iframe to load ────
			const iframeImgs = Array.from(iDoc.querySelectorAll<HTMLImageElement>('img'));
			await Promise.all(
				iframeImgs.map(
					(img) =>
						img.complete
							? Promise.resolve()
							: new Promise<void>((res) => {
									img.onload = () => res();
									img.onerror = () => res();
								})
				)
			);

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

			// 6 x 9 in — trade paperback. Must match .book-page-card exactly, or the
			// captured bitmap is rescaled into a different sheet and every page is
			// subtly stretched.
			const PDF_W_IN = 6;
			const PDF_H_IN = 9;
			const SCALE     = 2;

			const pdf = new jsPDF({
				orientation: 'portrait',
				unit: 'in',
				format: [PDF_W_IN, PDF_H_IN],
				compress: true
			});

			// ── Step 8: Capture each page and add to PDF ───────────────────────
			const CAPTURE_TIMEOUT_MS = 25_000;

			const captureWithTimeout = (el: HTMLElement, scale: number): Promise<HTMLCanvasElement> =>
				Promise.race([
					html2canvas(el, {
						scale,
						useCORS:         true,
						allowTaint:      false,
						logging:         false,
						windowWidth:     iWin.innerWidth,
						windowHeight:    iWin.innerHeight,
						width:           576,  // 6in @ 96dpi
						height:          864,  // 9in @ 96dpi
						backgroundColor: '#ffffff',
						imageTimeout:    10_000,
					}) as Promise<HTMLCanvasElement>,
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error(`timed out`)), CAPTURE_TIMEOUT_MS)
					),
				]);

			for (let i = 0; i < pageEls.length; i++) {
				const el = pageEls[i];
				let canvas: HTMLCanvasElement;

				try {
					canvas = await captureWithTimeout(el, SCALE);
				} catch (primaryErr) {
					console.warn(`[PDF] Page ${i + 1} primary capture failed (${primaryErr}), retrying at scale 1…`);
					try {
						canvas = await captureWithTimeout(el, 1);
					} catch (retryErr) {
						console.warn(`[PDF] Page ${i + 1} retry failed, inserting blank page.`);
						canvas = document.createElement('canvas');
						canvas.width  = 576;
						canvas.height = 864;
						const ctx = canvas.getContext('2d')!;
						ctx.fillStyle = '#ffffff';
						ctx.fillRect(0, 0, 576, 864);
					}
				}

				const imgData = canvas.toDataURL('image/jpeg', 0.92);

				// Release GPU-backed canvas memory immediately — prevents OOM on long books
				canvas.width  = 0;
				canvas.height = 0;

				if (i > 0) pdf.addPage([PDF_W_IN, PDF_H_IN], 'portrait');
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
		if (activeBook?.coverDesign?.accent) return activeBook.coverDesign.accent;
		const ac = coverSettings?.authorColor;
		if (ac && !isLightColor(ac)) return ac;
		return '#8E7453';
	});

	let designTitleColor = $derived.by(() => {
		if (activeBook?.coverDesign?.primary) return activeBook.coverDesign.primary;
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
			`--chapter-alignment: ${coverSettings?.alignment || 'left'}`,
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

	let isDerivingCoverDesign = $state(false);

	/**
	 * Read the chosen cover and colour the interior from it.
	 *
	 * Two steps, deliberately split by what each is good at:
	 *   1. Sample the cover's pixels. The palette is then MEASURED, not guessed —
	 *      a model naming "#C8752A" off a picture is estimating; the pixels are
	 *      the cover.
	 *   2. Ask vision the one thing pixels cannot answer: which of those colours
	 *      is the ACCENT rather than the ground, and what the title's type is
	 *      doing. The server then holds both to a contrast floor, because a cover
	 *      is seen across a shop and a page is read for an hour.
	 *
	 * Never fatal: a book with no cover read simply falls back to the old
	 * coverSettings colours, which is exactly what it did before.
	 */
	async function deriveCoverDesign(force = false) {
		if (!activeBook || isDerivingCoverDesign) return;
		const url = activeBook.coverSettings?.bgImageUrl;
		if (!url) return;

		const sig = currentCoverSignature;
		if (!force && activeBook.coverDesign?.signature === sig) return;

		isDerivingCoverDesign = true;
		try {
			const palette = await samplePalette(url);
			const res = await fetch('/api/write', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					action: 'read-cover-design',
					apiKey: globalState.apiKeys.anthropicKey,
					useMockMode: globalState.apiKeys.useMockMode,
					bookTitle: activeBook.title,
					genre: activeBook.genre,
					imageUrl: url,
					coverPalette: palette
				})
			});
			const data = await res.json();
			if (data.success && data.design) {
				globalState.updateBookCoverDesign(activeBook.id, { ...data.design, signature: sig });
				// Re-apply the preset so the new colours land immediately rather
				// than waiting for the next thing that happens to touch it.
				applyPresetInstantly(headerFooterPreset);
			}
		} catch (err) {
			console.warn('Could not read the cover design; falling back to cover settings.', err);
		} finally {
			isDerivingCoverDesign = false;
		}
	}

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
					_coverSignature: signature,
					_presetName: appliedPreset
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
			// The cover read comes first: the preset is coloured from it, so
			// deriving it after would paint the page twice.
			if (activeBook.coverDesign?.signature !== sig) {
				deriveCoverDesign();
			}
			if (!activeBook.interiorDesign || activeBook.interiorDesign._coverSignature !== sig) {
				generateInteriorDesignAI();
			}
		}
	});

	// Key: chapter.id
	// Value: array of pages; each page is { blocks: string[], startIdx: number, endIdx: number }
	let paginatedChapters = $state<Record<string, PageSlice[]>>({});

	/**
	 * Thin wrapper so the markup can keep calling this with (chapIdx, pageIdx);
	 * the shared implementation takes the book state explicitly rather than
	 * closing over it, which is what makes it testable outside this component.
	 */
	function calculateOverallPageNumber(chapIdx: number, pageIdx: number): number {
		if (!activeBook) return 1;
		return calcOverallPageNumber(activeBook.chapters, paginatedChapters, chapIdx, pageIdx);
	}

	/**
	 * Repaginate the whole book. The implementation lives in
	 * $lib/reader/pagination so it is importable and testable — an inline copy
	 * here previously drifted from the shared module and silently ignored a fix
	 * applied to it. EditDrawer takes this as a prop to repaginate after edits.
	 */
	function paginateAllChapters() {
		if (!activeBook) return;
		// The opener's header is drawn by this template, so the paginator cannot
		// see it and must reserve its height. That height depends on how many
		// lines the title wraps to, which depends on the type it is set in — so
		// the tokens are passed in rather than guessed at. Without this the
		// paginator assumed a flat 160/440px and the overflow was clipped
		// mid-word at the foot of the page.
		const d = activeBook.interiorDesign ?? {};
		paginatedChapters = paginateChapters(
			activeBook.chapters,
			fontSize,
			designBodyFont,
			{ title: activeBook.title, author: activeBook.author ?? '' },
			{
				titleFont:   d['--r-title-font']      ?? designFontFamily,
				titleSize:   d['--r-chap-title-size'] ?? '2rem',
				titleWeight: d['--r-title-weight']    ?? '700',
				showLabel:   d['--r-label-display']   !== 'none'
			}
		);
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
							<span class="chap-num">{_getChapterLabel(chap, idx)}</span>
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
							<optgroup label="Practical / Manual">
								<option value="Field Manual">Field Manual — Left-aligned, no chapter label</option>
								<option value="Field Manual — Cover Aligned">Field Manual — Follows your cover's alignment</option>
							</optgroup>
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
							background-size: 100% 100%;
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
					<!-- A page holding nothing but a full-page plate bleeds to the sheet
					     edge: no printed margins, no running header or footer — the plate
					     is the page. Never on a chapter's first page, which still has to
					     carry the chapter title and illustration. -->
					{@const isPlatePage = pageIdx > 0
						&& pageSlice.blocks.length === 1
						&& pageSlice.blocks[0].includes('--fullpage')}
					<section
						data-section-id="{chapIdx}-{pageIdx}"
						use:registerSection={pageIdx === 0 ? chapIdx : `${chapIdx}-${pageIdx}`}
						style={designStyles}
					>
						<!-- Book page wrap — centres the sheet in the scroll viewport -->
						<div class="book-page-wrap">

							<!-- US Letter sheet: 8.5 × 11 in — header, body, and footer all live inside -->
							<div
								class="book-page-card style-{coverStyle.toLowerCase().replace(/\s+/g, '-')}"
								class:book-page-card--bleed={isPlatePage}
								style="font-size: {fontSize}px;"
							>

								<!-- Running header — top of page, suppressed on page 1 of the chapter -->
								{#if !isPlatePage}
									<header class="running-header" style={pageIdx === 0 ? "display: none;" : ""} aria-hidden="true">
										<span class="running-header__book">{activeBook.title}</span>
										<span class="running-header__chapter">{_getChapterLabel(chap, chapIdx)} — {chap.title}</span>
									</header>
								{/if}

								<!-- Body content area — scrolls between header and footer -->
								<div class="page-body">

									{#if pageIdx === 0}
										<!-- Chapter header — label, title, rule -->
										<div class="chapter-header">
											<span class="chapter-label">{_getChapterLabel(chap, chapIdx)}</span>
											<h2 class="chapter-title">{chap.title}</h2>
											<hr class="chapter-rule" />
										</div>
									{/if}

									{#if pageIdx === 0 && chap.illustrationUrl}
										<!-- Illustration with its own edit trigger. Deliberately NOT
										     framed as a plate: the chapter opener sits under the
										     chapter header, which already names the chapter. Plate
										     chrome is for images inside the chapter content. -->
										<div class="chapter-illust">
										<!-- The frame exists to hug the image. `.chapter-illust` is a
										     full-width centred block, but the image inside is capped by
										     max-height and is usually narrower than it — so a label
										     positioned at "50%" of the container would not be at 50% of
										     the picture. Percentages only mean what the labels intend
										     when their containing block IS the rendered image box. -->
										<div class="illust-frame">
											<img src={chap.illustrationUrl} alt="Illustration – {chap.title}" />
											{#each chap.illustrationLabels ?? [] as label}
												<div
													class="illust-callout illust-callout--{label.side}"
													style="left: {label.x}%; top: {label.y}%;"
												>
													<span class="illust-callout__dot"></span>
													<span class="illust-callout__line"></span>
													<span class="illust-callout__text">{label.text}</span>
												</div>
											{/each}
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
										</div>
									{/if}

									<div class="chapter-body" class:has-drop-cap={pageIdx === 0}>
										{#each pageSlice.blocks as block}
											{@html block}
										{/each}
									</div>

								</div>

								<!-- Running footer — page number + contextual edit actions.
								     Suppressed on a bleed plate page; the plate carries its
								     own Edit button in .diagram-box__actions. -->
								{#if !isPlatePage}
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
								{/if}

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

		<!-- Edit Drawer (rendered as a component) -->
		<EditDrawer bind:editTarget {activeBook} {coverStyle} {paginateAllChapters} />

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
	 * Trim is 6 x 9 in — the trade-paperback size, and what a printed non-fiction
	 * book actually is. It was US Letter (8.5 x 11), which is a document, not a
	 * book: the proportions give it away before a reader has read a word.
	 *
	 * Margins are symmetric at 0.52in, measured off a real 6x9 manual, giving a
	 * 4.96in text column — about 66 characters at the export's 12pt, which is the
	 * readable band. They were 1.5in gutter / 1.25in fore-edge, which on a 6in
	 * page would leave a 3.25in ribbon of text.
	 *
	 * Symmetric, NOT mirrored: there is no wider inner margin alternating by page
	 * for a binding. The reference manual is symmetric too — it is built to be
	 * read as a PDF rather than bound. If these books are ever printed, this is
	 * the number to revisit.
	 */
	.book-page-card {
		width: min(6in, 100%);
		height: 9in;
		margin: 0 auto;
		background-color: var(--r-viewport);
		border: 1px solid var(--r-page-border, #E5DFD3);
		border-radius: 2px;
		box-shadow:
			0 1px 4px rgba(36,34,32,0.06),
			0 6px 20px rgba(36,34,32,0.08),
			0 18px 40px rgba(36,34,32,0.06);

		/* Outer page margins — 6x9 trim, symmetric sides.
		   --page-pad-x is declared here and consumed by .chapter-header's
		   full-bleed break-out. They were two hardcoded pairs that silently
		   disagreed the moment the trim changed; one variable is what stops
		   that happening again. */
		--page-pad-x: 0.52in;
		padding: 0.6in var(--page-pad-x) 0.5in var(--page-pad-x);

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
			min-height: 9in;
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
		 * Negative margins pull this stripe out to the physical card edge; the
		 * matching inner padding restores the text indent. That lets a preset
		 * paint a header background or accent bar to the paper's edge while the
		 * words stay on the text column.
		 *
		 * Both halves MUST equal the card's own side padding. They were hardcoded
		 * to -1.5in / -1.25in — the old US Letter margins — so when the trim
		 * became 6x9 with 0.52in sides, this stripe hung ~1in off the page and
		 * took any header background or bar with it. Reading --page-pad-x from
		 * the card is what makes that impossible rather than merely fixed.
		 * ──────────────────────────────────────────────────────────────────────── */
		margin-left:  calc(-1 * var(--page-pad-x, 0.52in));
		margin-right: calc(-1 * var(--page-pad-x, 0.52in));
		padding-left:  var(--page-pad-x, 0.52in);
		padding-right: var(--page-pad-x, 0.52in);

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
		/* A preset may drop the eyebrow entirely — a manual's chapter opener
		   names itself and does not need "CHAPTER 1" announced above it.
		   Defaults to block, so every existing preset is unchanged. */
		display: var(--r-label-display, block);
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

	/* Shrink-wraps the image so callout percentages resolve against the picture
	   itself. inline-block keeps it centred by the parent's text-align. */
	.illust-frame {
		position: relative;
		display: inline-block;
		line-height: 0;
	}

	.chapter-illust img {
		max-width: 100%;
		max-height: 380px;
		border-radius: 6px;
		box-shadow: 0 4px 20px rgba(0,0,0,0.1);
	}

	/* ── Illustration callouts ──────────────────────────────────────────
	   The image carries no text; these are the labels, set in real type.
	   Anchored at the feature's point, with the box offset to one side. */
	.illust-callout {
		position: absolute;
		display: flex;
		align-items: center;
		line-height: 1;
		/* The anchor point is the dot, so the row centres on the coordinate. */
		transform: translateY(-50%);
	}

	.illust-callout--right { flex-direction: row; }
	.illust-callout--left  { flex-direction: row-reverse; transform: translate(-100%, -50%); }

	.illust-callout__dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #E07B20;
		border: 1.5px solid #fff;
		flex-shrink: 0;
		box-shadow: 0 0 0 1px rgba(15,34,49,0.35);
	}

	.illust-callout__line {
		width: 26px;
		height: 1.5px;
		background: #E07B20;
		flex-shrink: 0;
	}

	.illust-callout__text {
		font-family: var(--font-sans);
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: #0F2231;
		background: rgba(255,255,255,0.96);
		border: 1.5px solid #0F2231;
		border-radius: 4px;
		padding: 0.22rem 0.45rem;
		white-space: nowrap;
		box-shadow: 0 1px 4px rgba(15,34,49,0.18);
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
		/* Serif explains, sans acts: a callout is scanned, not read, so a preset
		   may set it in sans against a serif body. Defaults to `inherit` so every
		   preset that doesn't opt in keeps the body face it always had. */
		font-family: var(--r-callout-font, inherit);
		font-size: 0.95rem;
		line-height: 1.6;
		color: var(--r-text, #1a1612);
	}

	/* ── Diagram and Flowchart Layouts ──────────────────────────────────────── */
	/* ── Editorial diagram plate ──────────────────────────────────────────
	   Navy header bar + amber rule + cream field. Padding lives on the
	   header and body so the bar runs full-bleed to the plate's edges. */
	.chapter-body :global(.diagram-box) {
		background-color: var(--r-diagram-bg, #FAF5EA);
		border: 1px solid var(--r-border, rgba(15, 34, 49, 0.15));
		border-radius: 8px;
		padding: 0;
		margin: 2.5rem 0;
		text-align: center;
		overflow: hidden;
		box-shadow: 0 1px 3px rgba(15, 34, 49, 0.08);
	}
	.chapter-body :global(.diagram-box__header) {
		background-color: var(--r-diagram-header-bg, #0F2231);
		border-bottom: 5px solid var(--r-accent, #E07B20);
		padding: 0.9rem 1.25rem;
		text-align: left;
	}
	.chapter-body :global(.diagram-box__title) {
		font-family: var(--r-title-font, var(--font-serif));
		font-size: 2rem;
		font-weight: 700;
		color: var(--r-diagram-header-color, #FFFFFF);
		line-height: 1.25;
		margin: 0;
	}
	.chapter-body :global(.diagram-box__subtitle) {
		font-size: 1.1rem;
		font-weight: 400;
		color: var(--r-diagram-header-muted, rgba(255, 255, 255, 0.72));
		letter-spacing: 0.2px;
		margin: 0.2rem 0 0;
	}
	/* Footer band: book title left, author right. A bleed page suppresses the
	   running footer, so this is what keeps the book on the page. */
	.chapter-body :global(.diagram-box__footer) {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		flex-shrink: 0;
		padding: 0.55rem 1.25rem 0.7rem;
		border-top: 1px solid rgba(15, 34, 49, 0.18);
		font-size: 0.72rem;
		color: rgba(15, 34, 49, 0.65);
		text-align: left;
	}
	.chapter-body :global(.diagram-box__footer-book) {
		font-style: italic;
	}
	.chapter-body :global(.diagram-box__footer-author) {
		font-family: var(--r-title-font, var(--font-serif));
		color: var(--r-accent, #E07B20);
		white-space: nowrap;
	}
	.chapter-body :global(.diagram-box__body) {
		display: flex;
		justify-content: center;
		width: 100%;
		box-sizing: border-box;
		padding: 1.5rem 1.25rem;
	}
	/* Scales a tall diagram down to fit its page instead of clipping it.
	   504px mirrors DIAGRAM_SVG_MAX_H in exportHtml.ts (page body 736, minus
	   80 box margins, 80 header bar, 48 body padding, 24 slack) so the reader
	   previews what the exported PDF actually produces. */
	.chapter-body :global(.diagram-svg) {
		width: 100%;
		height: auto;
		max-height: 504px;
	}

	/* Full-page diagram plate: owns the page, header bar down to the footer.
	   700px is PAGE_BUDGET_PX from pagination.ts — the paginator charges a
	   full-page plate the entire budget, so the plate has to actually fill it
	   or the page shows dead space. margin:0 because it owns the page rather
	   than sitting in prose. */
	.chapter-body :global(.diagram-box--fullpage) {
		min-height: 700px;
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.chapter-body :global(.diagram-box--fullpage .diagram-box__header) {
		flex-shrink: 0;
	}
	/* min-height:0 lets this flex child shrink, so the SVG's max-height is
	   what binds rather than the content forcing overflow. */
	.chapter-body :global(.diagram-box--fullpage .diagram-box__body) {
		flex: 1;
		min-height: 0;
		align-items: center;
	}
	/* Caps against the flexed body rather than a pixel value mirrored from
	   the export — the reader's page budget (700) and the export's (736)
	   differ, so a shared constant here would be wrong for one of them. */
	.chapter-body :global(.diagram-box--fullpage .diagram-svg) {
		max-width: 100%;
		max-height: 100%;
	}

	/* ── Bleed plate page ──────────────────────────────────────────────────
	 * The plate IS the sheet: printed margins dropped so the navy bar meets
	 * the physical page edge. Running header and footer aren't rendered on
	 * these pages (see the isPlatePage branch in the markup), so page-body
	 * is the card's only child and can take the full height. */
	.book-page-card--bleed {
		/* This is the green frame in devtools: the card's printed margins
		   (1in / 1.25in / 1.5in). Dropping them is what lets the plate reach
		   the sheet edge. overflow:hidden clips the plate's square corners to
		   the card's 2px radius so they don't poke past the paper edge. */
		padding: 0;
		overflow: hidden;
	}
	.book-page-card--bleed .page-body {
		height: 100%;
	}
	.book-page-card--bleed :global(.chapter-body) {
		height: 100%;
	}
	/* Square off the plate — a radius or border would reveal the sheet
	   underneath and break the bleed. min-height:0 releases the 700px
	   in-flow floor so height:100% is what binds here. */
	.book-page-card--bleed :global(.diagram-box--fullpage) {
		height: 100%;
		min-height: 0;
		margin: 0;
		border: 0;
		border-radius: 0;
	}
	/* Doubled class so this beats the .diagram-box plate rule on specificity
	   rather than on source order. It currently wins here only because it is
	   declared later; the export stylesheet declares them the other way round
	   and the cream field framed every table in the PDF. */
	.chapter-body :global(.diagram-box.diagram-box--table) {
		background: transparent;
		border: none;
		border-radius: 0;
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

	/* ── Plate callouts ─────────────────────────────────────────────────
	   Same treatment as the chapter-opener illustration's callouts, but these
	   ride inside HTML injected by the diagram renderer, so they have to be
	   reached with :global. The frame shrink-wraps the image so the
	   percentages resolve against the picture, not the figure. */
	.chapter-body :global(.illust-frame) {
		position: relative;
		display: inline-block;
		line-height: 0;
		max-width: 100%;
	}

	.chapter-body :global(.illust-callout) {
		position: absolute;
		display: flex;
		align-items: center;
		line-height: 1;
		transform: translateY(-50%);
	}

	.chapter-body :global(.illust-callout--right) { flex-direction: row; }
	.chapter-body :global(.illust-callout--left)  {
		flex-direction: row-reverse;
		transform: translate(-100%, -50%);
	}

	.chapter-body :global(.illust-callout__dot) {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #E07B20;
		border: 1.5px solid #fff;
		flex-shrink: 0;
		box-shadow: 0 0 0 1px rgba(15,34,49,0.35);
	}

	.chapter-body :global(.illust-callout__line) {
		width: 26px;
		height: 1.5px;
		background: #E07B20;
		flex-shrink: 0;
	}

	.chapter-body :global(.illust-callout__text) {
		font-family: var(--font-sans);
		font-size: 0.66rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		color: #0F2231;
		background: rgba(255,255,255,0.96);
		border: 1.5px solid #0F2231;
		border-radius: 4px;
		padding: 0.22rem 0.45rem;
		white-space: nowrap;
		box-shadow: 0 1px 4px rgba(15,34,49,0.18);
	}

	/* Full-page plate: navy header bar (from .diagram-box__header) sits above
	   an image that fills the remaining cream field for the whole page block. */
	.chapter-body :global(.diagram-box--image--fullpage) {
		width: 100%;
		min-height: 600px;
		display: flex;
		flex-direction: column;
		align-items: stretch;
	}

	/* The bar keeps its intrinsic height; only the figure flexes. */
	/* Bar and footer keep their intrinsic height; only the figure flexes.
	   Without this the flexing figure squeezes the footer to nothing. */
	.chapter-body :global(.diagram-box--image--fullpage .diagram-box__header),
	.chapter-body :global(.diagram-box--image--fullpage .diagram-box__footer) {
		flex-shrink: 0;
	}

	.chapter-body :global(.diagram-box--image--fullpage figure) {
		flex: 1;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
		margin: 0;
		padding: 1.25rem;
		box-sizing: border-box;
	}

	/* width:auto (not 100%) so the box shrinks to the picture's aspect ratio.
	   Pinning width:100% while max-height binds leaves a full-width box with a
	   contain-scaled picture inside it — the leftover gutters showed as white
	   strips, and the navy frame hugged the box rather than the photo. */
	.chapter-body :global(.diagram-box--image--fullpage figure img) {
		max-width: 100%;
		max-height: 700px;
		width: auto;
		height: auto;
	}

	/* Photo matte — the image is mounted in a white frame on the cream field,
	   the way a plate is mounted in a printed manual. Applies to the CSS-driven
	   image paths only; the edit drawer writes its own inline border/radius so
	   the reader can set those per-image. */
	.chapter-body :global(.diagram-box--image figure img),
	.chapter-body :global(.diagram-box--plate figure img) {
		border: 2px solid var(--r-diagram-header-bg, #0F2231);
		border-radius: 8px;
		box-shadow: 0 2px 8px rgba(15, 34, 49, 0.14);
		box-sizing: border-box;
	}

	/* Takeaway box closing a plate — white card, amber spine, cream field. */
	.chapter-body :global(.plate-takeaway) {
		flex-shrink: 0;
		margin: 0 1.25rem 1.25rem;
		padding: 0.75rem 1rem;
		background-color: #FFFFFF;
		border: 1px solid rgba(15, 34, 49, 0.15);
		border-left: 4px solid var(--r-accent, #E07B20);
		border-radius: 5px;
		text-align: left;
	}
	.chapter-body :global(.plate-takeaway__title) {
		font-family: var(--r-title-font, var(--font-serif));
		font-size: 0.9rem;
		font-weight: 700;
		color: var(--r-title-color, #0F2231);
		margin-bottom: 0.2rem;
	}
	.chapter-body :global(.plate-takeaway__body) {
		font-size: 0.82rem;
		line-height: 1.5;
		color: var(--r-text, #1a1612);
		margin: 0;
		text-indent: 0;
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
</style>
