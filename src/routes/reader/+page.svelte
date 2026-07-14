<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { globalState } from '$lib/state.svelte';

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

	// ── Build HTML for export ──────────────────────────────────────────────────
	function buildFullHtml(): string {
		if (!activeBook) return '';
		const cs = activeBook.coverSettings;
		const isBaked = activeBook.coverOptions?.some((o) => o.imageUrl && o.imageUrl === cs.bgImageUrl);
		const opt = (activeBook.selectedCoverIndex !== null && activeBook.coverOptions?.[activeBook.selectedCoverIndex])
			? activeBook.coverOptions[activeBook.selectedCoverIndex]
			: null;
		const coverStyle = opt?.style || 'Warm Editorial';
		const coverStyleClass = `style-${coverStyle.toLowerCase().replace(/\s+/g, '-')}`;

		const coverBg = cs.bgImageUrl
			? `background-image:url('${cs.bgImageUrl}');background-size:cover;background-position:center;`
			: 'background:linear-gradient(135deg,#FAF7F2 0%,#EDE5D5 100%);';
		const coverOverlay = isBaked ? 0 : cs.overlayOpacity;
		const coverInner = isBaked
			? ''
			: `<div class="cover-inner">
				<div>
					<h1 class="cover-title">${activeBook.title}</h1>
					<p class="cover-subtitle">${activeBook.subtitle ?? ''}</p>
				</div>
				<p class="cover-author">${activeBook.author ?? ''}</p>
			</div>`;

		const tocRows = activeBook.chapters
			.map((c) => `<div class="toc-row"><span>Chapter ${c.order}: ${c.title}</span></div>`)
			.join('');

		const designOrnament = coverStyle === 'Dark Minimalist' ? '✦' : coverStyle === 'Bold Graphic' ? '◆' : '❦';
		const titleFontName = cs.titleFont === 'Inter' ? "'Inter',sans-serif" : cs.titleFont === 'Georgia' ? "Georgia,serif" : cs.titleFont === 'Arial' ? "Arial,sans-serif" : "'Lora',Georgia,serif";
		const bodyFontName = cs.titleFont === 'Inter' || cs.titleFont === 'Arial' ? "'Inter',sans-serif" : "'Lora',Georgia,serif";
		const designAccentColor = cs.authorColor || '#8E7453';
		const designTitleColor = cs.titleColor || '#1A1612';

		const ruleWidth = cs.alignment === 'center' ? '60px' : cs.alignment === 'right' ? '120px' : '100%';
		const ruleMarginLeft = cs.alignment === 'center' ? 'auto' : cs.alignment === 'right' ? 'auto' : '0';
		const ruleMarginRight = cs.alignment === 'center' ? 'auto' : cs.alignment === 'right' ? '0' : 'auto';
		const headerFlexAlign = cs.alignment === 'center' ? 'center' : cs.alignment === 'right' ? 'flex-end' : 'flex-start';

		let chaptersHtml = '';
		activeBook.chapters.forEach((c, chapIdx) => {
			const illust = c.illustrationUrl
				? `<div class="illustration"><img src="${c.illustrationUrl}" alt="${c.title}" crossorigin="anonymous" /></div>`
				: '';

			const chapPages = paginatedChapters[c.id] || [['']];

			chapPages.forEach((pageBlocks, pageIdx) => {
				const isFirstPage = pageIdx === 0;
				const headerHtml = isFirstPage
					? `<div class="chapter-header">
							<span class="chapter-number-label">Chapter ${c.order}</span>
							<h1 class="chapter-title">${c.title}</h1>
							<hr class="chapter-rule" />
					   </div>
					   ${illust}`
					: '';

				const bodyContent = pageBlocks.join('\n');
				const pageNum = calculateOverallPageNumber(chapIdx, pageIdx);

				const separator = (chapIdx === activeBook.chapters.length - 1 && pageIdx === chapPages.length - 1)
					? ''
					: `<div class="chapter-separator"><div class="sep-line"></div><span class="sep-ornament">${designOrnament}</span><div class="sep-line"></div></div>`;

				chaptersHtml += `
					<section class="chapter-section ${coverStyleClass}">
						<div class="page-running-header">
							<span class="running-title">${activeBook.title}</span>
							<span class="running-sep">|</span>
							<span class="running-section">Chapter ${c.order}</span>
						</div>
						<div class="chapter-content-flow">
							${headerHtml}
							<div class="chapter-body ${isFirstPage ? 'has-drop-cap' : ''}">${bodyContent}</div>
						</div>
						<div class="page-running-footer">
							<span class="page-number">— ${pageNum} —</span>
						</div>
						${separator}
					</section>`;
			});
		});

		return `<!doctype html><html><head>
<meta charset="utf-8">
<title>${activeBook.title}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;800&family=Lora:ital,wght@0,400;0,600;1,400&display=swap');
*,*::before,*::after{box-sizing:border-box;}
body{margin:0;padding:0;background:#fff;color:#1A1612;font-family:${bodyFontName};font-size:13px;line-height:1.85;-webkit-font-smoothing:antialiased;}
.cover-page{width:210mm;height:297mm;position:relative;display:flex;flex-direction:column;padding:18mm;${coverBg}text-align:${cs.alignment};page-break-after:always;overflow:hidden;}
.cover-overlay{position:absolute;inset:0;background:rgba(26,21,16,${coverOverlay});}
.cover-inner{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;justify-content:${cs.textPosition === 'top' ? 'flex-start' : cs.textPosition === 'bottom' ? 'flex-end' : 'center'};gap:1.5rem;}
.cover-title{font-size:${cs.titleSize}px;font-weight:700;color:${cs.titleColor};line-height:1.2;margin:0 0 8px;font-family:${titleFontName};}
.cover-subtitle{font-size:${cs.subtitleSize}px;color:${cs.subtitleColor};font-family:'Inter',sans-serif;font-weight:500;margin:0;}
.cover-author{font-size:${cs.authorSize}px;font-style:italic;color:${cs.authorColor};margin:0;}
.content-wrap{width:174mm;margin:0 auto;padding:14mm 0;}
.toc-section{page-break-after:always;margin-bottom:14mm;}
.toc-section h1{font-size:22px;font-weight:600;border-bottom:1.5px solid #D9CFC2;padding-bottom:8px;margin-bottom:18px;}
.toc-row{padding:5px 0;border-bottom:1px dotted #E0D8CC;font-size:12.5px;font-family:'Inter',sans-serif;}

.chapter-section{page-break-before:always;padding:1in 1.25in 1in 1.5in;display:flex;flex-direction:column;width:8.5in;height:11in;min-height:11in;justify-content:space-between;box-sizing:border-box;background:#fff;}
.page-running-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	font-family: 'Inter', sans-serif;
	font-size: 9px;
	text-transform: uppercase;
	letter-spacing: 1.5px;
	color: #6A6055;
	border-bottom: 1px solid #E0D8CC;
	padding-bottom: 6px;
	margin-bottom: 30px;
}
.running-sep {
	opacity: 0.4;
	margin: 0 6px;
}
.chapter-content-flow {
	flex: 1;
}
.page-running-footer {
	display: flex;
	justify-content: center;
	margin-top: 35px;
	padding-top: 6px;
	border-top: 1px dashed #E0D8CC;
}
.page-number {
	font-family: 'Inter', sans-serif;
	font-size: 10px;
	color: #6A6055;
	letter-spacing: 1px;
}

.chapter-header{margin-bottom:2.5rem;text-align:${cs.alignment};display:flex;flex-direction:column;align-items:${headerFlexAlign};}
.chapter-number-label{font-family:'Inter',sans-serif;font-size:10.5px;text-transform:uppercase;letter-spacing:3px;color:${designAccentColor};margin-bottom:6px;}
.chapter-title{font-family:${titleFontName};font-size:24px;font-weight:700;line-height:1.25;margin:0 0 14px;color:${designTitleColor};}
.chapter-rule{border:none;border-top:1.5px solid ${designAccentColor};margin:0;width:${ruleWidth};margin-left:${ruleMarginLeft};margin-right:${ruleMarginRight};}
.illustration{margin:18px 0;text-align:center;}
.illustration img{max-width:100%;max-height:260px;border-radius:3px;}
.chapter-body{font-family:${bodyFontName};}
.chapter-body p{margin:0 0 14px;text-indent:1.4em;hyphens:auto;}
.chapter-body p:first-of-type{text-indent:0;}
.chapter-body.has-drop-cap p:first-of-type::first-letter {
	font-family: ${titleFontName};
	font-size: 3.2em;
	float: left;
	line-height: 0.85;
	margin-top: 0.1em;
	margin-right: 0.15em;
	font-weight: 700;
	color: ${designAccentColor};
}
.chapter-body h2{font-size:17px;font-weight:600;margin:22px 0 10px;font-family:${titleFontName};color:${designTitleColor};}
.chapter-body h3{font-size:14px;font-weight:600;margin:18px 0 8px;font-family:${titleFontName};color:${designTitleColor};}
.chapter-body blockquote{border-left:3px solid ${designAccentColor};margin:18px 0;padding-left:16px;font-style:italic;color:#6A6055;}
.chapter-body ul{margin:12px 0;padding-left:22px;}
.chapter-body li{margin-bottom:6px;}

/* Cover-specific chapter style pairs */
.style-dark-minimalist .chapter-title {
	font-weight: 300;
	letter-spacing: 2px;
	text-transform: uppercase;
}
.style-dark-minimalist .chapter-body blockquote {
	border-left: 2px solid ${designAccentColor};
	background-color: #FAF8F5;
	padding: 12px 18px;
	border-radius: 4px;
}

.style-bold-graphic .chapter-title {
	font-weight: 800;
	text-transform: uppercase;
	letter-spacing: -0.5px;
}
.style-bold-graphic .chapter-number-label {
	font-weight: 800;
	background: ${designAccentColor};
	color: #fff !important;
	display: inline-block;
	padding: 2px 8px;
	border-radius: 3px;
	margin-bottom: 8px;
}
.style-bold-graphic .chapter-rule {
	border-top: 4px solid ${designAccentColor};
}

.style-warm-editorial .chapter-title {
	font-style: italic;
}
.style-warm-editorial .chapter-body p:first-of-type::first-letter {
	font-style: italic;
}

/* Chapter separator styles */
.chapter-separator {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 1.5rem;
	margin-top: 30px;
	margin-bottom: 10px;
	page-break-inside: avoid;
}
.sep-line {
	flex: 1;
	height: 1px;
	background: ${designAccentColor};
	opacity: 0.25;
}
.sep-ornament {
	font-size: 1.2rem;
	color: ${designAccentColor};
	opacity: 0.75;
	line-height: 1;
}

@page{size:8.5in 11in;margin:0;}
@media print{body{background:#fff;}.cover-page{page-break-after:always;}.chapter-section{page-break-before:always;page-break-after:always;}}
</style></head><body>
<div class="cover-page"><div class="cover-overlay"></div>${coverInner}</div>
<div class="content-wrap">
<section class="toc-section"><h1>Contents</h1>${tocRows}</section>
${chaptersHtml}
</div>
</body></html>`;
	}

	function handleCompileHtml() {
		if (!activeBook) return;
		const html = buildFullHtml();
		const blob = new Blob([html], { type: 'text/html' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${activeBook.title.toLowerCase().replace(/\s+/g, '_')}_ebook.html`;
		a.click();
		URL.revokeObjectURL(url);
	}

	// ── PDF Export via print window ────────────────────────────────────────────
	async function handleExportPdf() {
		if (!activeBook || isPdfExporting) return;
		isPdfExporting = true;
		try {
			const html = buildFullHtml();
			const printWin = window.open('', '_blank', 'width=900,height=700');
			if (!printWin) {
				alert('Pop-up blocked. Please allow pop-ups for this page to export PDF.');
				isPdfExporting = false;
				return;
			}
			printWin.document.open();
			printWin.document.write(html);
			printWin.document.close();

			await new Promise<void>((resolve) => {
				printWin.onload = () => resolve();
				setTimeout(resolve, 2500);
			});

			printWin.focus();
			printWin.print();
			setTimeout(() => { try { printWin.close(); } catch (_) {} }, 4000);
		} catch (err) {
			console.error('PDF export error:', err);
			alert('PDF export encountered an error. Please try again.');
		} finally {
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
	// A map or array of paginated pages per chapter
	// Key: chapter.id, Value: array of pages (where each page is an array of block HTML strings)
	let paginatedChapters = $state<Record<string, string[][]>>({});

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
		
		// Create a temporary container for measurement
		const measureDiv = document.createElement('div');
		// Style it exactly like the page text area
		measureDiv.style.position = 'absolute';
		measureDiv.style.visibility = 'hidden';
		measureDiv.style.width = 'calc(8.5in - 2.75in)'; // 8.5in width minus padding (1.5in left + 1.25in right)
		measureDiv.style.fontSize = `${fontSize}px`;
		measureDiv.style.lineHeight = '1.85';
		measureDiv.style.fontFamily = designBodyFont;
		measureDiv.className = 'chapter-body'; // inherit typography styles
		document.body.appendChild(measureDiv);

		const maxPageHeight = 740; // 11in (1056px) - 2in padding (192px) - running header/footer space (~120px)
		const newPaginated: Record<string, string[][]> = {};

		for (const chap of activeBook.chapters) {
			if (chap.status !== 'completed' || !chap.content) {
				newPaginated[chap.id] = [['<p>This chapter has not been written yet.</p>']];
				continue;
			}

			const fullHtml = parseMarkdown(chap.content);
			const blocks = splitHtmlIntoBlocks(fullHtml);
			const pages: string[][] = [];
			let currentPage: string[] = [];
			let currentHeight = 0;

			// Add chapter title/header height to the first page calculation
			currentHeight += 160; 

			for (const block of blocks) {
				measureDiv.innerHTML = block;
				const blockHeight = measureDiv.offsetHeight + 24; // block height + vertical margin

				if (currentHeight + blockHeight > maxPageHeight && currentPage.length > 0) {
					pages.push(currentPage);
					currentPage = [block];
					currentHeight = blockHeight;
				} else {
					currentPage.push(block);
					currentHeight += blockHeight;
				}
			}

			if (currentPage.length > 0) {
				pages.push(currentPage);
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
					{@const chapPages = paginatedChapters[chap.id] || [[`Loading chapter...`]]}
					{#each chapPages as pageBlocks, pageIdx}
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
							<!-- Book page wrap: running header + paper card + page number -->
							<div class="book-page-wrap">

								<!-- Running header (recto: odd pages show book title; verso: even pages show chapter) -->
								<div class="running-header" aria-hidden="true">
									<span class="running-header__book">{activeBook.title}</span>
									<span class="running-header__chapter">Chapter {chap.order} — {chap.title}</span>
								</div>

								<!-- Raised paper card -->
								<div class="book-page-card style-{coverStyle.toLowerCase().replace(/\s+/g, '-')}" style="font-size: {fontSize}px;">

									{#if pageIdx === 0}
										<!-- Only show the chapter header on the first page of the chapter -->
										<div class="chapter-header">
											<span class="chapter-label">Chapter {chap.order}</span>
											<h2 class="chapter-title">{chap.title}</h2>
											<hr class="chapter-rule" />
										</div>
									{/if}

									{#if pageIdx === 0 && chap.illustrationUrl}
										<div class="chapter-illust">
											<img src={chap.illustrationUrl} alt="Illustration – {chap.title}" />
										</div>
									{/if}

									<div class="chapter-body" class:has-drop-cap={pageIdx === 0}>
										{#each pageBlocks as block}
											{@html block}
										{/each}
									</div>

								</div>

								<!-- Page number footer (cumulative across all pages in the book) -->
								<div class="page-number-footer" aria-label="Page number">
									<span class="page-number-footer__line"></span>
									<span class="page-number-footer__num">{calculateOverallPageNumber(chapIdx, pageIdx)}</span>
									<span class="page-number-footer__line"></span>
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
		</div>
	{/if}
</div>

<style>
	.reader-workspace {
		flex: 1;
		display: flex;
		flex-direction: column;
		height: calc(100vh - 65px);
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
		display: grid;
		grid-template-columns: 280px 1fr;
		height: 100%;
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

	/* Sidebar */
	.reader-sidebar {
		background-color: var(--r-sidebar);
		border-right: 1px solid var(--r-border);
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
		transition: background-color 0.25s;
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

	/* Scroll area */
	.reader-scroll-area {
		background-color: var(--r-viewport);
		overflow-y: auto;
		overflow-x: auto;
		height: 100%;
		transition: background-color 0.25s;
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
	 * Outer wrap — provides the page-background gutter around each sheet.
	 * Centres the 8.5in card horizontally; scroll area handles overflow-x.
	 */
	.book-page-wrap {
		width: 100%;
		margin: 0 auto;
		padding: 3rem 2rem 4rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0;
		box-sizing: border-box;
	}

	/* Running header — mimics the live text at the top of a typeset book page */
	.running-header {
		width: min(8.5in, 100%);
		margin: 0 auto;
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		padding: 0 0 0.6rem;
		border-bottom: 1px solid var(--chapter-accent-color, var(--r-border));
		opacity: 0.45;
		margin-bottom: 0.75rem;
		gap: 1rem;
		box-sizing: border-box;
	}

	.running-header__book {
		font-family: var(--font-sans);
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 2.5px;
		color: var(--chapter-accent-color, var(--r-muted));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.running-header__chapter {
		font-family: var(--font-serif);
		font-size: 0.65rem;
		font-style: italic;
		color: var(--chapter-accent-color, var(--r-muted));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: right;
	}

	/* The raised paper card — US Letter: 8.5 × 11 in (ANSI A) */
	.book-page-card {
		/*
		 * width: min(8.5in, 100%) — fills up to exactly 8.5in if viewport
		 * allows, gracefully shrinks on smaller screens.
		 * fixed height: 11in — splits paragraphs/elements across pages to match real typesetting
		 */
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
		padding: 1in 1.25in 1in 1.5in;
		color: var(--r-text);
		line-height: 1.85;
		transition: color 0.25s, background-color 0.25s, box-shadow 0.25s;
		position: relative;
		box-sizing: border-box;
		overflow: hidden;
	}

	/* Spine binding edge accent line — mimics a perfect-bound inner margin */
	.book-page-card::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
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

	/* Page-number footer */
	.page-number-footer {
		width: min(8.5in, 100%);
		margin: 0.75rem auto 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 0.6rem 0 0;
		border-top: 1px solid var(--chapter-accent-color, var(--r-border));
		opacity: 0.4;
		box-sizing: border-box;
	}

	.page-number-footer__line {
		flex: 1;
		height: 1px;
		background: transparent;
	}

	.page-number-footer__num {
		font-family: var(--font-serif);
		font-size: 0.7rem;
		color: var(--chapter-accent-color, var(--r-muted));
		letter-spacing: 1.5px;
	}

	/*
	 * Below 1100px: viewport is narrower than sidebar (280px) + 8.5in card (816px)
	 * + gutters. Let the card go fluid so it never overflows the scroll area.
	 */
	@media (max-width: 1100px) {
		.book-page-card {
			width: 100%;
			min-height: 11in;
			padding: 1in 1.25in 1in 1.5in;
		}
	}
	@media (max-width: 700px) {
		.book-page-card {
			width: 100%;
			min-height: auto;
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
</style>
