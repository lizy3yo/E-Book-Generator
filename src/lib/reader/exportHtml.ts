import { parseMarkdown } from '$lib/diagrams';
import type { Book } from '$lib/types';

export async function getAsDataUrl(url: string): Promise<string> {
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
export function buildFullHtml(activeBook: Book, getChapterLabel: (chap: {title:string;order:number}, idx:number) => string, dataUrls: Record<string,string> = {}): string {
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
