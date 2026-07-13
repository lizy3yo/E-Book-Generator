<script lang="ts">
	import { globalState } from '$lib/state.svelte';
	import type { Book } from '$lib/types';

	let activeSection = $state<'cover' | number>('cover'); // 'cover' or chapter index (0-based)
	let fontSize = $state(18); // in px
	let readerTheme = $state<'cream' | 'sepia' | 'white' | 'night'>('cream');
	
	let copySuccess = $state(false);

	let activeBook = $derived(globalState.activeBook);

	// Markdown Compiler
	function parseMarkdown(md: string): string {
		if (!md) return '<p>No content written for this chapter yet.</p>';
		
		let html = md.trim();
		
		// Escape simple HTML characters safely
		html = html
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
			
		// Headings
		html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
		html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
		html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
		
		// Blockquotes
		html = html.replace(/^> (.*?)$/gm, '<blockquote>$1</blockquote>');
		
		// Bold / Italic
		html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
		
		// Lists
		html = html.replace(/^\* (.*?)$/gm, '<li>$1</li>');
		html = html.replace(/^- (.*?)$/gm, '<li>$1</li>');
		
		// Paragraph mapping
		const paragraphs = html.split('\n\n');
		html = paragraphs.map(p => {
			const trimmed = p.trim();
			if (!trimmed) return '';
			if (trimmed.startsWith('<h') || trimmed.startsWith('<blockquote') || trimmed.startsWith('<li')) {
				return trimmed;
			}
			return `<p>${trimmed}</p>`;
		}).join('\n');

		// Wrap loose list items in ul
		html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
		// Clean up adjacent duplicate ul wrappers
		html = html.replace(/<\/ul>\s*<ul>/g, '');
		
		return html;
	}

	function handleCopyMarkdown() {
		if (!activeBook) return;

		let fullBookMd = `# ${activeBook.title}\n## ${activeBook.subtitle}\nBy ${activeBook.author}\n\n`;
		
		activeBook.chapters.forEach(chap => {
			fullBookMd += `\n# Chapter ${chap.order}: ${chap.title}\n\n${chap.content}\n`;
		});

		navigator.clipboard.writeText(fullBookMd).then(() => {
			copySuccess = true;
			setTimeout(() => copySuccess = false, 2500);
		});
	}

	function handleCompileHtml() {
		if (!activeBook) return;

		const coverSettings = activeBook.coverSettings;
		const coverBgStyle = coverSettings.bgImageUrl 
			? `background-image: url('${coverSettings.bgImageUrl}'); background-size: cover; background-position: center;`
			: 'background-color: #FAF7F2;';

		// Construct HTML content
		let chaptersHtml = '';
		activeBook.chapters.forEach(chap => {
			const chapIllustHtml = chap.illustrationUrl 
				? `<div class="illustration"><img src="${chap.illustrationUrl}" alt="${chap.title}" /></div>`
				: '';

			chaptersHtml += `
				<section class="chapter-page">
					<span class="chapter-number">Chapter ${chap.order}</span>
					<h1 class="chapter-title">${chap.title}</h1>
					${chapIllustHtml}
					<div class="chapter-body">${parseMarkdown(chap.content)}</div>
				</section>
				<hr class="page-break" />
			`;
		});

		const fullHtml = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<title>${activeBook.title}</title>
	<style>
		@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Lora:ital,wght@0,400;0,600;1,400&display=swap');
		
		body {
			margin: 0;
			padding: 0;
			background-color: #FAF7F2;
			color: #242220;
			font-family: 'Lora', serif;
			font-size: 18px;
			line-height: 1.8;
			-webkit-font-smoothing: antialiased;
		}

		.book-container {
			max-width: 700px;
			margin: 0 auto;
			padding: 4rem 2rem;
		}

		/* Cover Styling */
		.cover-page {
			height: 90vh;
			display: flex;
			flex-direction: column;
			justify-content: space-between;
			border: 1px solid rgba(0,0,0,0.08);
			padding: 3rem;
			box-sizing: border-box;
			border-radius: 4px;
			margin-bottom: 5rem;
			position: relative;
			text-align: ${coverSettings.alignment};
			${coverBgStyle}
		}

		.cover-overlay {
			position: absolute;
			top: 0; left: 0; right: 0; bottom: 0;
			background-color: rgba(26, 21, 16, ${coverSettings.overlayOpacity});
			z-index: 1;
		}

		.cover-content {
			position: relative;
			z-index: 2;
			height: 100%;
			display: flex;
			flex-direction: column;
			justify-content: space-between;
		}

		.cover-title {
			font-size: 40px;
			font-weight: 600;
			color: ${coverSettings.titleColor};
			margin: 0 0 10px 0;
		}

		.cover-subtitle {
			font-size: 20px;
			color: ${coverSettings.subtitleColor};
			font-family: 'Inter', sans-serif;
			margin: 0;
		}

		.cover-author {
			font-size: 22px;
			font-style: italic;
			color: ${coverSettings.authorColor};
			margin: 0;
		}

		/* Chapter Styling */
		.chapter-page {
			margin-bottom: 5rem;
		}

		.chapter-number {
			display: block;
			font-family: 'Inter', sans-serif;
			font-size: 14px;
			text-transform: uppercase;
			letter-spacing: 2px;
			color: #8E7453;
			margin-bottom: 0.5rem;
		}

		.chapter-title {
			font-size: 32px;
			font-weight: 600;
			margin-top: 0;
			margin-bottom: 2rem;
		}

		.illustration {
			margin: 2rem 0;
			text-align: center;
		}

		.illustration img {
			max-width: 100%;
			max-height: 400px;
			border-radius: 4px;
			box-shadow: 0 4px 12px rgba(0,0,0,0.06);
		}

		.chapter-body p {
			margin-bottom: 1.5rem;
		}

		blockquote {
			border-left: 3px solid #8E7453;
			margin: 2rem 0;
			padding-left: 1.5rem;
			font-style: italic;
			color: #6E6860;
		}

		ul {
			margin: 1.5rem 0;
			padding-left: 2rem;
		}

		li {
			margin-bottom: 0.5rem;
		}

		.page-break {
			border: none;
			border-top: 1px solid #E6DDD0;
			margin: 4rem 0;
			page-break-before: always;
		}

		@media print {
			body { background-color: #ffffff; }
			.book-container { padding: 0; max-width: 100%; }
			.cover-page { height: 95vh; border: none; }
		}
	</style>
</head>
<body>
	<div class="book-container">
		<!-- Cover Page -->
		<div class="cover-page">
			<div class="cover-overlay"></div>
			<div class="cover-content" style="justify-content: ${coverSettings.textPosition === 'top' ? 'flex-start' : coverSettings.textPosition === 'bottom' ? 'flex-end' : 'center'}; gap: 2rem;">
				<div>
					<h1 class="cover-title">${activeBook.title}</h1>
					<p class="cover-subtitle">${activeBook.subtitle}</p>
				</div>
				<div style="${coverSettings.textPosition === 'bottom' ? 'order: -1; margin-bottom: auto;' : ''}">
					<p class="cover-author">${activeBook.author}</p>
				</div>
			</div>
		</div>

		<hr class="page-break" />

		<!-- Table of Contents -->
		<section class="chapter-page" style="page-break-after: always;">
			<h1 style="font-size: 28px; margin-bottom: 2rem;">Contents</h1>
			<ul style="list-style: none; padding-left: 0;">
				${activeBook.chapters.map(c => `<li style="display: flex; justify-content: space-between; margin-bottom: 1rem; border-bottom: 1px dashed #E6DDD0; padding-bottom: 0.25rem;"><span style="font-weight: 600;">Chapter ${c.order}: ${c.title}</span></li>`).join('')}
			</ul>
		</section>

		<hr class="page-break" />

		<!-- Chapters -->
		${chaptersHtml}
	</div>
</body>
</html>`;

		const blob = new Blob([fullHtml], { type: 'text/html' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `${activeBook.title.toLowerCase().replace(/\s+/g, '_')}_ebook.html`;
		link.click();
	}

	// ── PDF Export ──────────────────────────────────────────────────────────────
	let isPdfExporting = $state(false);

	async function handleExportPdf() {
		if (!activeBook || isPdfExporting) return;
		isPdfExporting = true;

		try {
			// Dynamically import to keep the initial bundle lean
			const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
				import('jspdf'),
				import('html2canvas')
			]);

			// A4 dimensions in mm (industry standard)
			const PAGE_W_MM  = 210;
			const PAGE_H_MM  = 297;
			// Inner margins (mm)
			const MARGIN_MM  = 18;
			const CONTENT_W  = PAGE_W_MM - MARGIN_MM * 2;

			const pdf = new jsPDF({
				orientation: 'portrait',
				unit: 'mm',
				format: 'a4',
				compress: true
			});

			// ── Build the full HTML (same as HTML export but with print-safe tweaks) ──
			const coverSettings = activeBook.coverSettings;
			const coverBgStyle  = coverSettings.bgImageUrl
				? `background-image: url('${coverSettings.bgImageUrl}'); background-size: cover; background-position: center;`
				: 'background: linear-gradient(135deg,#FAF7F2 0%,#EDE5D5 100%);';

			let chaptersHtml = '';
			activeBook.chapters.forEach(chap => {
				const illustHtml = chap.illustrationUrl
					? `<div class="illustration"><img src="${chap.illustrationUrl}" alt="${chap.title}" crossorigin="anonymous" /></div>`
					: '';
				chaptersHtml += `
					<section class="chapter-section">
						<div class="chapter-number-label">Chapter ${chap.order}</div>
						<h1 class="chapter-title">${chap.title}</h1>
						${illustHtml}
						<div class="chapter-body">${parseMarkdown(chap.content)}</div>
					</section>
				`;
			});

			const tocRows = activeBook.chapters
				.map(c => `<div class="toc-row"><span>Chapter ${c.order}: ${c.title}</span><span class="toc-dots"></span></div>`)
				.join('');

			const fullHtml = `<!doctype html><html><head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Lora:ital,wght@0,400;0,600;1,400&display=swap');

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0; padding: 0;
    background: #FFFFFF;
    color: #1A1612;
    font-family: 'Lora', Georgia, serif;
    font-size: 13px;
    line-height: 1.85;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Cover ── */
  .cover-page {
    width: 210mm; height: 297mm;
    position: relative;
    display: flex; flex-direction: column;
    padding: 18mm;
    ${coverBgStyle}
    text-align: ${coverSettings.alignment};
    page-break-after: always;
    overflow: hidden;
  }
  .cover-overlay {
    position: absolute; inset: 0;
    background: rgba(26,21,16,${coverSettings.overlayOpacity});
  }
  .cover-inner {
    position: relative; z-index: 2;
    height: 100%;
    display: flex; flex-direction: column;
    justify-content: ${
      coverSettings.textPosition === 'top'    ? 'flex-start' :
      coverSettings.textPosition === 'bottom' ? 'flex-end'   : 'center'
    };
    gap: 1.5rem;
  }
  .cover-title {
    font-size: ${coverSettings.titleSize}px;
    font-weight: 700;
    color: ${coverSettings.titleColor};
    line-height: 1.2;
    margin: 0 0 8px;
    font-family: ${coverSettings.titleFont === 'Inter' ? "'Inter', sans-serif" : "'Lora', Georgia, serif"};
  }
  .cover-subtitle {
    font-size: ${coverSettings.subtitleSize}px;
    color: ${coverSettings.subtitleColor};
    font-family: 'Inter', sans-serif;
    font-weight: 500;
    margin: 0;
  }
  .cover-author {
    font-size: ${coverSettings.authorSize}px;
    font-style: italic;
    color: ${coverSettings.authorColor};
    margin: 0;
  }

  /* ── Content wrapper ── */
  .content-wrap {
    width: 174mm; /* 210 - 2×18 */
    margin: 0 auto;
    padding: 14mm 0;
  }

  /* ── TOC ── */
  .toc-section {
    page-break-after: always;
    margin-bottom: 14mm;
  }
  .toc-section h1 {
    font-size: 22px;
    font-weight: 600;
    border-bottom: 1.5px solid #D9CFC2;
    padding-bottom: 8px;
    margin-bottom: 18px;
    letter-spacing: 0.02em;
  }
  .toc-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 5px 0;
    border-bottom: 1px dotted #E0D8CC;
    font-size: 12.5px;
    font-family: 'Inter', sans-serif;
  }

  /* ── Chapter ── */
  .chapter-section {
    page-break-before: always;
    padding-bottom: 14mm;
  }
  .chapter-number-label {
    font-family: 'Inter', sans-serif;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 3px;
    color: #8E7453;
    margin-bottom: 6px;
  }
  .chapter-title {
    font-size: 24px;
    font-weight: 700;
    line-height: 1.25;
    margin: 0 0 22px;
    color: #1A1612;
  }
  .illustration {
    margin: 18px 0;
    text-align: center;
  }
  .illustration img {
    max-width: 100%;
    max-height: 260px;
    border-radius: 3px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.09);
  }
  .chapter-body p {
    margin: 0 0 14px;
    text-indent: 1.4em;
    hyphens: auto;
  }
  .chapter-body p:first-of-type { text-indent: 0; }
  .chapter-body h2 { font-size: 17px; font-weight: 600; margin: 22px 0 10px; }
  .chapter-body h3 { font-size: 14px; font-weight: 600; margin: 18px 0 8px; }
  .chapter-body blockquote {
    border-left: 3px solid #8E7453;
    margin: 18px 0;
    padding-left: 16px;
    font-style: italic;
    color: #6A6055;
  }
  .chapter-body ul { margin: 12px 0; padding-left: 22px; }
  .chapter-body li { margin-bottom: 6px; text-indent: 0; }
  .chapter-body strong { font-weight: 600; }
  .chapter-body em { font-style: italic; }

  /* ── Footer ── */
  .pdf-footer {
    position: fixed; bottom: 10mm; left: 0; right: 0;
    text-align: center;
    font-family: 'Inter', sans-serif;
    font-size: 9px;
    color: #AEA89E;
    letter-spacing: 0.04em;
  }
</style>
</head><body>

<!-- Cover -->
<div class="cover-page">
  <div class="cover-overlay"></div>
  <div class="cover-inner">
    <div>
      <h1 class="cover-title">${activeBook.title}</h1>
      <p class="cover-subtitle">${activeBook.subtitle}</p>
    </div>
    <p class="cover-author">${activeBook.author}</p>
  </div>
</div>

<!-- TOC + Chapters -->
<div class="content-wrap">
  <section class="toc-section">
    <h1>Contents</h1>
    ${tocRows}
  </section>
  ${chaptersHtml}
</div>

<div class="pdf-footer">${activeBook.title} &nbsp;·&nbsp; ${activeBook.author}</div>

</body></html>`;

			// ── Render via hidden off-screen iframe ──────────────────────────────────
			const iframe = document.createElement('iframe');
			iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:794px;border:none;visibility:hidden;';
			document.body.appendChild(iframe);

			await new Promise<void>((resolve) => {
				iframe.onload = () => resolve();
				iframe.srcdoc = fullHtml;
			});

			// Give fonts/images a moment to settle
			await new Promise(r => setTimeout(r, 1200));

			const iDoc = iframe.contentDocument!;
			const body = iDoc.body;

			// ── Determine sections to render as pages ────────────────────────────────
			// A4 pixel height at 96dpi ≈ 1123px; we use the cover + each section
			const A4_PX_H = 1122; // 297mm at 96dpi

			// Collect renderable sections
			const sections: Element[] = [
				iDoc.querySelector('.cover-page')!,
				iDoc.querySelector('.toc-section')!,
				...Array.from(iDoc.querySelectorAll('.chapter-section'))
			].filter(Boolean);

			let isFirstPage = true;

			for (const section of sections) {
				const canvas = await html2canvas(section as HTMLElement, {
					scale: 2,           // 2× for crisp 150+ DPI output
					useCORS: true,
					allowTaint: false,
					backgroundColor: '#FFFFFF',
					logging: false,
					windowWidth: 794
				});

				const imgData   = canvas.toDataURL('image/jpeg', 0.92);
				const imgW      = canvas.width;
				const imgH      = canvas.height;

				// Scale image to fit A4 width inside margins
				const pdfImgW   = CONTENT_W;
				const pdfImgH   = (imgH / imgW) * pdfImgW;

				// Paginate: if image taller than one page, split across pages
				let yOffset = 0;
				const pageContentH = PAGE_H_MM - MARGIN_MM * 2;

				while (yOffset < pdfImgH) {
					if (!isFirstPage) pdf.addPage();
					isFirstPage = false;

					// Clip slice of the canvas image to this page
					const sliceH    = Math.min(pageContentH, pdfImgH - yOffset);
					const srcY      = (yOffset / pdfImgH) * imgH;
					const srcSliceH = (sliceH / pdfImgH) * imgH;

					// Create a slice canvas
					const sliceCanvas  = document.createElement('canvas');
					sliceCanvas.width  = imgW;
					sliceCanvas.height = srcSliceH;
					const ctx = sliceCanvas.getContext('2d')!;
					ctx.drawImage(canvas, 0, srcY, imgW, srcSliceH, 0, 0, imgW, srcSliceH);

					const sliceData = sliceCanvas.toDataURL('image/jpeg', 0.92);
					pdf.addImage(sliceData, 'JPEG', MARGIN_MM, MARGIN_MM, pdfImgW, sliceH, undefined, 'FAST');

					// Page number footer
					pdf.setFont('helvetica', 'normal');
					pdf.setFontSize(8);
					pdf.setTextColor(180, 170, 158);
					pdf.text(
						`${activeBook.title}  ·  ${activeBook.author}`,
						PAGE_W_MM / 2,
						PAGE_H_MM - 8,
						{ align: 'center' }
					);

					yOffset += pageContentH;
				}
			}

			// ── Save ─────────────────────────────────────────────────────────────────
			const filename = `${activeBook.title.toLowerCase().replace(/\s+/g, '_')}_ebook.pdf`;
			pdf.save(filename);

			document.body.removeChild(iframe);

		} catch (err) {
			console.error('PDF export failed:', err);
			alert('PDF export encountered an error. Please try again.');
		} finally {
			isPdfExporting = false;
		}
	}
</script>

<svelte:head>
	<title>E-Reader - Ebook Automator</title>
</svelte:head>

<div class="reader-workspace">
	{#if !activeBook}
		<div class="container select-warning-container font-serif">
			<div class="card select-warning">
				<p>No active ebook selected in workspace.</p>
				<p class="small"><a href="/">Go to Write panel</a> to initialize or generate a book first.</p>
			</div>
		</div>
	{:else}
		<!-- Layout: Left Sidebar (Index) & Right Main Reader -->
		<div class="reader-layout theme-{readerTheme}">
			
			<!-- Left navigation sidebar -->
			<aside class="reader-nav-sidebar">
				<div class="book-spine font-serif">
					<h4>{activeBook.title}</h4>
					<p class="author">by {activeBook.author}</p>
				</div>

				<div class="toc-links font-serif">
					<button 
						class="toc-item {activeSection === 'cover' ? 'active' : ''}" 
						onclick={() => activeSection = 'cover'}
					>
						📔 Ebook Cover
					</button>

					{#each activeBook.chapters as chap, idx}
						<button 
							class="toc-item {activeSection === idx ? 'active' : ''}" 
							onclick={() => activeSection = idx}
							disabled={chap.status !== 'completed'}
						>
							<span class="chap-num">Chapter {chap.order}:</span>
							<span class="chap-title">{chap.title}</span>
						</button>
					{/each}
				</div>

				<div class="compile-actions">
					<button 
						class="btn btn-secondary btn-small font-serif" 
						onclick={handleCopyMarkdown}
					>
						{copySuccess ? '✓ Copied!' : '📋 Copy Markdown'}
					</button>
					
					<button 
						class="btn btn-secondary btn-small font-serif" 
						onclick={handleCompileHtml}
					>
						💾 Export HTML
					</button>

					<button 
						class="btn btn-primary btn-small font-serif pdf-export-btn" 
						onclick={handleExportPdf}
						disabled={isPdfExporting}
					>
						{#if isPdfExporting}
							<span class="pdf-spinner"></span> Generating PDF…
						{:else}
							📄 Export PDF
						{/if}
					</button>
				</div>
			</aside>

			<!-- Right scrollable reader content viewport -->
			<main class="reader-content-viewport">
				
				<!-- Upper settings ribbon -->
				<header class="reader-settings-ribbon">
					<div class="theme-controls">
						<span class="font-serif">Paper:</span>
						<button class="theme-btn cream {readerTheme === 'cream' ? 'active' : ''}" onclick={() => readerTheme = 'cream'} aria-label="Cream mode"></button>
						<button class="theme-btn sepia {readerTheme === 'sepia' ? 'active' : ''}" onclick={() => readerTheme = 'sepia'} aria-label="Sepia mode"></button>
						<button class="theme-btn white {readerTheme === 'white' ? 'active' : ''}" onclick={() => readerTheme = 'white'} aria-label="White mode"></button>
						<button class="theme-btn night {readerTheme === 'night' ? 'active' : ''}" onclick={() => readerTheme = 'night'} aria-label="Night mode"></button>
					</div>

					<div class="text-controls">
						<button class="font-adjust-btn" onclick={() => fontSize = Math.max(fontSize - 1, 14)} aria-label="Decrease font size">A-</button>
						<span class="font-size-label font-serif">{fontSize}px</span>
						<button class="font-adjust-btn" onclick={() => fontSize = Math.min(fontSize + 1, 26)} aria-label="Increase font size">A+</button>
					</div>
				</header>

				<!-- Scrollable book page sheet -->
				<div class="book-page-wrapper">
					<div class="book-page-sheet font-serif" style="font-size: {fontSize}px;">
						
						{#if activeSection === 'cover'}
							<!-- Display Ebook Cover view -->
							{@const cover = activeBook.coverSettings}
							<div 
								class="cover-card"
								style="
									background-image: {cover.bgImageUrl ? `url(${cover.bgImageUrl})` : 'none'}; 
									background-color: {cover.bgImageUrl ? 'transparent' : '#FAF7F2'}; 
									background-size: cover; 
									background-position: center; 
									text-align: {cover.alignment};
								"
							>
								<!-- Contrast Overlay -->
								<div class="cover-overlay" style="background-color: rgba(26, 21, 16, ${cover.overlayOpacity});"></div>
								
								<div class="cover-card-content" style="justify-content: {cover.textPosition === 'top' ? 'flex-start' : cover.textPosition === 'bottom' ? 'flex-end' : 'center'};">
									<div class="title-sub-group">
										<h1 class="cover-title" style="color: {cover.titleColor}; font-size: {cover.titleSize * 1.2}px; font-family: {cover.titleFont === 'Lora' || cover.titleFont === 'Georgia' ? 'Lora, Georgia' : 'Inter, sans-serif'};">
											{activeBook.title}
										</h1>
										<p class="cover-subtitle" style="color: {cover.subtitleColor}; font-size: {cover.subtitleSize * 1.2}px;">
											{activeBook.subtitle}
										</p>
									</div>
									<div class="author-group" style="{cover.textPosition === 'bottom' ? 'order: -1; margin-bottom: auto;' : ''}">
										<p class="cover-author" style="color: {cover.authorColor}; font-size: {cover.authorSize * 1.1}px;">
											{activeBook.author}
										</p>
									</div>
								</div>
							</div>
						{:else}
							<!-- Display Selected Chapter content -->
							{@const chap = activeBook.chapters[activeSection]}
							<div class="chapter-content-container">
								<span class="chapter-order font-serif">Chapter {chap.order}</span>
								<h2 class="chapter-title font-serif">{chap.title}</h2>
								
								{#if chap.illustrationUrl}
									<div class="chapter-illustration">
										<img src={chap.illustrationUrl} alt="Illustration for Chapter {chap.title}" />
									</div>
								{/if}

								<hr class="chapter-divider" />

								<div class="chapter-text-body font-serif">
									{@html parseMarkdown(chap.content)}
								</div>
							</div>
						{/if}

					</div>
				</div>

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

	.select-warning-container {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
	}

	.select-warning {
		text-align: center;
		padding: 4rem 2rem;
		color: var(--text-muted);
		font-style: italic;
		max-width: 600px;
	}

	.select-warning a {
		text-decoration: underline;
		font-weight: 600;
	}

	/* Layout Split */
	.reader-layout {
		display: grid;
		grid-template-columns: 300px 1fr;
		flex: 1;
		height: 100%;
		overflow: hidden;
		transition: var(--transition);
	}

	@media (max-width: 800px) {
		.reader-layout {
			grid-template-columns: 1fr;
		}
	}

	/* Themes */
	.reader-layout.theme-cream {
		--r-bg-sidebar: #F4EFE5;
		--r-bg-viewport: #FAF7F2;
		--r-bg-sheet: #FCFAF6;
		--r-text: #2B2927;
		--r-text-muted: #6E6860;
		--r-border: #E5DFD3;
		--r-sidebar-item-active: #EAE3D4;
	}

	.reader-layout.theme-sepia {
		--r-bg-sidebar: #E9DDC6;
		--r-bg-viewport: #EFE4CD;
		--r-bg-sheet: #F4ECCF;
		--r-text: #413524;
		--r-text-muted: #7E6C53;
		--r-border: #DFD0B3;
		--r-sidebar-item-active: #DFD3BA;
	}

	.reader-layout.theme-white {
		--r-bg-sidebar: #F4F4F4;
		--r-bg-viewport: #FAFAFA;
		--r-bg-sheet: #FFFFFF;
		--r-text: #111111;
		--r-text-muted: #555555;
		--r-border: #E5E5E5;
		--r-sidebar-item-active: #EAEAEA;
	}

	.reader-layout.theme-night {
		--r-bg-sidebar: #131211;
		--r-bg-viewport: #181716;
		--r-bg-sheet: #1C1B1A;
		--r-text: #E5DFD5;
		--r-text-muted: #9E958A;
		--r-border: #2D2A26;
		--r-sidebar-item-active: #272523;
	}

	/* Left Navigation Sidebar */
	.reader-nav-sidebar {
		background-color: var(--r-bg-sidebar);
		border-right: 1px solid var(--r-border);
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow-y: auto;
		transition: var(--transition);
	}

	@media (max-width: 800px) {
		.reader-nav-sidebar {
			display: none; /* Hide index on small screens, can scroll page directly */
		}
	}

	.book-spine {
		padding: 1.5rem;
		border-bottom: 1px solid var(--r-border);
	}

	.book-spine h4 {
		font-size: 1.05rem;
		font-weight: 600;
		color: var(--r-text);
		margin-bottom: 0.25rem;
		line-height: 1.35;
	}

	.book-spine .author {
		font-size: 0.8rem;
		font-style: italic;
		color: var(--r-text-muted);
	}

	.toc-links {
		display: flex;
		flex-direction: column;
		padding: 0.5rem;
		gap: 0.15rem;
		flex: 1;
	}

	.toc-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		padding: 0.75rem 1rem;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: var(--r-text-muted);
		transition: var(--transition);
	}

	.toc-item:hover:not(:disabled) {
		background-color: var(--r-sidebar-item-active);
		color: var(--r-text);
	}

	.toc-item.active {
		background-color: var(--r-sidebar-item-active);
		color: var(--r-text);
		font-weight: 500;
		border-left: 2px solid var(--accent);
	}

	.toc-item:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.toc-item .chap-num {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.toc-item .chap-title {
		font-size: 0.88rem;
		margin-top: 0.1rem;
	}

	.compile-actions {
		padding: 1rem;
		border-top: 1px solid var(--r-border);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.btn-small {
		padding: 0.5rem 1rem;
		font-size: 0.8rem;
		width: 100%;
	}

	/* Right Content Viewport */
	.reader-content-viewport {
		background-color: var(--r-bg-viewport);
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		transition: var(--transition);
	}

	.reader-settings-ribbon {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 2.5rem;
		border-bottom: 1px solid var(--r-border);
		background-color: var(--r-bg-sheet);
		transition: var(--transition);
		z-index: 5;
	}

	.theme-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.85rem;
		color: var(--r-text-muted);
	}

	.theme-btn {
		width: 20px;
		height: 20px;
		border-radius: 50%;
		border: 1.5px solid transparent;
		cursor: pointer;
		transition: var(--transition);
	}

	.theme-btn:hover {
		transform: scale(1.15);
	}

	.theme-btn.active {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--r-text);
	}

	.theme-btn.cream { background-color: #FCFAF6; border-color: #E5DFD3; }
	.theme-btn.sepia { background-color: #F4ECCF; border-color: #DFD0B3; }
	.theme-btn.white { background-color: #FFFFFF; border-color: #E5E5E5; }
	.theme-btn.night { background-color: #1C1B1A; border-color: #2D2A26; }

	.text-controls {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.font-adjust-btn {
		background: transparent;
		border: 1px solid var(--r-border);
		color: var(--r-text);
		width: 28px;
		height: 28px;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
		font-weight: bold;
		transition: var(--transition);
	}

	.font-adjust-btn:hover {
		background-color: var(--r-bg-sidebar);
	}

	.font-size-label {
		font-size: 0.85rem;
		color: var(--r-text-muted);
		width: 40px;
		text-align: center;
	}

	/* Scrollable Book Page Wrapper */
	.book-page-wrapper {
		flex: 1;
		overflow-y: auto;
		display: flex;
		justify-content: center;
		padding: 3rem 2rem;
	}

	.book-page-sheet {
		background-color: var(--r-bg-sheet);
		box-shadow: var(--shadow-md);
		border: 1px solid var(--r-border);
		border-radius: 4px;
		width: 100%;
		max-width: 750px;
		min-height: 80vh;
		padding: 4rem 4.5rem;
		box-sizing: border-box;
		color: var(--r-text);
		line-height: 1.8;
		transition: background-color var(--transition), color var(--transition), border var(--transition);
		height: fit-content;
	}

	@media (max-width: 600px) {
		.book-page-sheet {
			padding: 2rem 1.5rem;
		}
	}

	/* Cover card visualizer in reader */
	.cover-card {
		height: 600px;
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-lg);
		padding: 3rem;
		box-sizing: border-box;
		position: relative;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.cover-overlay {
		position: absolute;
		top: 0; left: 0; right: 0; bottom: 0;
		z-index: 1;
	}

	.cover-card-content {
		position: relative;
		z-index: 2;
		height: 100%;
		display: flex;
		flex-direction: column;
		gap: 2rem;
	}

	.cover-title {
		font-weight: bold;
		line-height: 1.25;
		margin: 0 0 10px 0;
	}

	.cover-subtitle {
		margin: 0;
		font-family: var(--font-sans);
		font-weight: 500;
	}

	.cover-author {
		font-style: italic;
		font-weight: 500;
		margin: 0;
	}

	/* Chapter page styling */
	.chapter-content-container {
		animation: pageFadeIn 0.3s ease-in-out;
		max-width: 65ch;
		margin: 0 auto;
	}

	@keyframes pageFadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	.chapter-order {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 2px;
		color: var(--accent);
		display: block;
		margin-bottom: 0.5rem;
		font-family: var(--font-sans);
		font-weight: 600;
	}

	.chapter-title {
		font-size: 1.85rem;
		font-weight: 600;
		margin-top: 0;
		margin-bottom: 2rem;
		line-height: 1.3;
	}

	.chapter-illustration {
		margin: 2.5rem 0;
		text-align: center;
	}

	.chapter-illustration img {
		max-width: 100%;
		max-height: 380px;
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-sm);
	}

	.chapter-divider {
		border: none;
		border-top: 1px solid var(--r-border);
		margin: 2rem 0;
	}

	/* Sub-markdown nodes styling */
	.chapter-text-body :global(p) {
		margin-bottom: 1.5rem;
		text-indent: 1.5rem; /* Classic book paragraph format */
	}

	.chapter-text-body :global(p:first-of-type) {
		text-indent: 0; /* No indent on first paragraph */
	}

	.chapter-text-body :global(h3) {
		font-size: 1.2rem;
		margin-top: 2rem;
		margin-bottom: 1rem;
		font-weight: 600;
	}

	.chapter-text-body :global(blockquote) {
		border-left: 3.5px solid var(--accent);
		margin: 2.2rem 0;
		padding-left: 1.8rem;
		font-style: italic;
		color: var(--r-text-muted);
		line-height: 1.7;
	}

	.chapter-text-body :global(ul) {
		margin: 1.5rem 0;
		padding-left: 2rem;
	}

	.chapter-text-body :global(li) {
		margin-bottom: 0.5rem;
		text-indent: 0;
	}

	/* PDF export button */
	.pdf-export-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
	}

	.pdf-export-btn:disabled {
		opacity: 0.65;
		cursor: not-allowed;
	}

	.pdf-spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid rgba(255,255,255,0.35);
		border-top-color: #fff;
		border-radius: 50%;
		animation: pdf-spin 0.7s linear infinite;
		flex-shrink: 0;
	}

	@keyframes pdf-spin {
		to { transform: rotate(360deg); }
	}
</style>
