import { parseMarkdown } from '$lib/diagrams';
import type { Book } from '$lib/types';

/**
 * Escape text destined for the export's HTML.
 *
 * Chapter titles and illustration labels are model-authored, so an unescaped
 * `&` or `<` would break the markup of a document nobody inspects before it is
 * rasterised into a PDF.
 */
const htmlEsc = (s: string) =>
	String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

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
		// Fetch via server-side proxy to bypass CORS.
		// AbortController ensures a slow or dead CDN doesn't stall the entire export.
		const controller = new AbortController();
		const timeoutId  = setTimeout(() => controller.abort(), 15_000);
		const proxyUrl   = `/api/proxy?url=${encodeURIComponent(url)}`;
		const res        = await fetch(proxyUrl, { signal: controller.signal });
		clearTimeout(timeoutId);
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

		// The callout box, resolved once from the active preset.
		//
		// Resolved here rather than inline because the box is styled TWICE below:
		// once on the hidden measurer that decides where pages break, and once on
		// the exported page. If those two disagree by so much as a border width,
		// the paginator budgets for a box that isn't the one it prints, and blocks
		// land on the wrong pages. One source, both consumers.
		const calloutBg     = activeBook.interiorDesign?.['--r-callout-bg']           ?? '#faf7f2';
		const calloutBdW    = activeBook.interiorDesign?.['--r-callout-border-width'] ?? '3.5px';
		const calloutBdC    = activeBook.interiorDesign?.['--r-callout-border-color'] ?? accent;
		const calloutRadius = activeBook.interiorDesign?.['--r-callout-border-radius'] ?? '4px';
		const calloutTitleC = activeBook.interiorDesign?.['--r-callout-title-color']  ?? accent;
		// Serif explains, sans acts — a preset may set the box in sans against a
		// serif body. Falls back to the body face, which is what it always was.
		const calloutFont   = activeBook.interiorDesign?.['--r-callout-font']         ?? bodyFontCss;
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
			? `background-image:url('${bgImg}');background-size:100% 100%;`
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
			// 6 x 9 in — trade paperback, the size a printed non-fiction book
			// actually is. Was 8.5 x 11 (US Letter), which reads as a document.
			// These MUST match .book-page-card in the reader: the PDF is a bitmap
			// capture of that element, so a mismatch stretches every page.
			const PAGE_W_PX  = 576;  // 6in @ 96dpi
			const PAGE_H_PX  = 864;  // 9in @ 96dpi
			// Symmetric 0.52in sides, measured off a real 6x9 manual — a 4.96in
			// column, ~66 characters at 12pt. The old 1.5in gutter + 1.25in
			// fore-edge would leave a 3.25in ribbon on a 6in page, which is why
			// the trim and the margins had to change in one go rather than one
			// after the other.
			const PAD_TOP    = 58;   // 0.60in
			const PAD_BOTTOM = 48;   // 0.50in
			const PAD_LEFT   = 50;   // 0.52in
			const PAD_RIGHT  = 50;   // 0.52in
			const HDR_H      = 32;   // running header + margin
			const FTR_H      = 32;   // running footer + margin
			const CONTENT_PAD_TOP = 34; // .chapter-content padding-top (0.35in)
			const BODY_H = PAGE_H_PX - PAD_TOP - PAD_BOTTOM - HDR_H - FTR_H - CONTENT_PAD_TOP;
			const BODY_W = PAGE_W_PX - PAD_LEFT - PAD_RIGHT;

			// A diagram SVG carries a viewBox, so it scales to whatever box it is
			// given. Cap it at what remains of the page body once the plate's own
			// chrome is paid for, otherwise a tall diagram (a 10-step flowchart
			// computes to ~880px) overflows the page and gets clipped mid-node.
			const DIAGRAM_BOX_MARGIN_H = 80; // .diagram-box margin: 2.5rem 0
			const DIAGRAM_HEADER_H     = 100; // navy bar: 29 padding + 40 title (2rem) + 25 subtitle (1.1rem) + 5 rule
			const DIAGRAM_FOOTER_H     = 40; // footer band: 19 padding + 17 text + 2 rule
			const DIAGRAM_BODY_PAD_H   = 48; // .diagram-box__body padding: 1.5rem
			const DIAGRAM_SLACK_H      = 24; // headroom for a title that wraps to two lines
			// Every one of these is subtracted from the SVG's ceiling, so growing
			// the title or adding the footer band without growing these constants
			// would push the plate back off the page.
			const DIAGRAM_CHROME_H =
				DIAGRAM_HEADER_H + DIAGRAM_FOOTER_H + DIAGRAM_BODY_PAD_H + DIAGRAM_SLACK_H;

			const DIAGRAM_SVG_MAX_H = BODY_H - DIAGRAM_BOX_MARGIN_H - DIAGRAM_CHROME_H;

			// A full-page plate owns the page: no box margins to pay for, so the
			// SVG gets everything left after the plate's own chrome.
			const DIAGRAM_FULLPAGE_SVG_MAX_H = BODY_H - DIAGRAM_CHROME_H;

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
					border-radius: ${calloutRadius};
					padding: 1.25rem 1.5rem;
					margin: 2rem 0;
					box-sizing: border-box;
				}
				.pdf-measurer-container .callout-box {
					background-color: ${calloutBg};
					border-left: ${calloutBdW} solid ${calloutBdC};
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
					color: ${calloutTitleC};
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
					font-family: ${calloutFont};
					font-size: 0.95rem;
					line-height: 1.6;
					color: #1a1612;
				}
				/* Must stay identical to the .diagram-box rules in the export
				   stylesheet below, or measured height diverges from rendered
				   height and pagination drifts. */
				.pdf-measurer-container .diagram-box {
					background-color: #FAF5EA;
					border: 1px solid rgba(15, 34, 49, 0.15);
					border-radius: 8px;
					padding: 0;
					margin: 2.5rem 0;
					text-align: center;
					overflow: hidden;
				}
				.pdf-measurer-container .diagram-box__header {
					background-color: #0F2231;
					border-bottom: 5px solid #E07B20;
					padding: 0.9rem 1.25rem;
					text-align: left;
				}
				.pdf-measurer-container .diagram-box__title {
					font-family: ${titleFontCss};
					font-size: 2rem;
					font-weight: 700;
					color: #FFFFFF;
					line-height: 1.25;
					margin: 0;
				}
				.pdf-measurer-container .diagram-box__subtitle {
					font-size: 1.1rem;
					font-weight: 400;
					color: rgba(255, 255, 255, 0.72);
					letter-spacing: 0.2px;
					margin: 0.2rem 0 0;
				}
				.pdf-measurer-container .diagram-box__footer {
					display: flex;
					justify-content: space-between;
					align-items: baseline;
					gap: 1rem;
					padding: 8pt 1.25rem 10pt;
					border-top: 1px solid rgba(15, 34, 49, 0.18);
					font-size: 8.5pt;
				}
				.pdf-measurer-container .diagram-box__body {
					display: flex;
					justify-content: center;
					width: 100%;
					box-sizing: border-box;
					padding: 1.5rem 1.25rem;
				}
				/* Tables reset the plate look — must match the export stylesheet
				   or the measurer reserves height for a cream band that the PDF
				   no longer renders. */
				.pdf-measurer-container .diagram-box.diagram-box--table {
					background: transparent;
					border: none;
					border-radius: 0;
					box-shadow: none;
					padding: 0;
					overflow: visible;
				}
				/* The measurer MUST carry this clamp too — without it the block
				   measures at its unclamped height and pagination reserves a page
				   budget the rendered plate never uses. */
				.pdf-measurer-container .diagram-svg {
					width: 100%;
					height: auto;
					max-height: ${DIAGRAM_SVG_MAX_H}px;
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
							// If no data URL available, strip the image entirely rather than
							// embedding a cross-origin URL that will cause html2canvas to hang.
							return b64 ? `![${alt}](${b64})` : '';
						}
					);

					// Same swap for raw <img> tags. Chapter content holds these too —
					// the edit drawer splices rendered HTML rather than markdown — and
					// the markdown pattern above never sees them. Missing this leaves a
					// live cross-origin src in the iframe, which html2canvas requests
					// with CORS and which fails on a host that sends no
					// Access-Control-Allow-Origin.
					contentForPdf = contentForPdf.replace(
						/<img\b[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/gi,
						(tag, url) => {
							const b64 = dataUrls[url];
							return b64 ? tag.replace(url, b64) : '';
						}
					);
				}
				const fullMd   = parseMarkdown(contentForPdf, c.id, {
					title:  activeBook.title,
					author: activeBook.author ?? ''
				});
				const rawIllust = c.illustrationUrl || '';
				// Use base64 only — never embed a raw HTTP URL in the iframe HTML.
				// A cross-origin <img> causes html2canvas to stall indefinitely.
				const mappedIllust = rawIllust && Object.prototype.hasOwnProperty.call(dataUrls, rawIllust)
					? dataUrls[rawIllust]  // base64 or '' if fetch failed
					: '';                  // not attempted — omit rather than risk CORS hang
				// Deliberately NOT framed as a plate: the chapter opener sits under
				// the chapter header, which already names the chapter. Plate chrome
				// is for images inside the chapter content.
				//
				// Callouts ride inside `.illust-frame`, which shrink-wraps the image
				// so their percentages resolve against the picture rather than the
				// full-width centred `.illustration` block. They are built only when
				// `mappedIllust` is non-empty: if the image was dropped, its labels
				// must go with it — a floating callout points at nothing.
				const calloutHtml = (c.illustrationLabels ?? [])
					.map(l =>
						`<div class="illust-callout illust-callout--${l.side === 'left' ? 'left' : 'right'}" ` +
						`style="left:${l.x}%;top:${l.y}%;">` +
						`<span class="illust-callout__dot"></span>` +
						`<span class="illust-callout__line"></span>` +
						`<span class="illust-callout__text">${htmlEsc(l.text)}</span>` +
						`</div>`
					)
					.join('');
				const illustHtml = mappedIllust
					? `<div class="illustration"><div class="illust-frame">` +
					  `<img src="${mappedIllust}" alt="${htmlEsc(c.title)}" />${calloutHtml}` +
					  `</div></div>`
					: '';

				const tmp = document.createElement('div');
				tmp.innerHTML = fullMd;
				const blocks = Array.from(tmp.children).map((el) => el.outerHTML);

				type Page = { blocks: string[]; isFirst: boolean };
				const pages: Page[] = [];
				let cur: string[] = [];
				let curH = 0;
				const measurer = document.createElement('div');
				measurer.className = 'pdf-measurer-container';
				measurer.style.cssText =
					`position:absolute;visibility:hidden;width:${BODY_W}px;` +
					`font-size:12pt;line-height:1.85;font-family:${bodyFontCss};`;
				document.body.appendChild(measurer);

				// ── What the opener costs before a block is placed ──────────────
				//
				// The header and illustration are emitted by the template above,
				// not as blocks, so this loop never measures them — their height
				// has to be reserved or prose gets packed into space already
				// spoken for and the page clips it mid-word at the foot.
				//
				// This was a flat `160 + (illust ? 280 : 0)`. The illustration
				// alone is 240pt of image plus 16pt margins top and bottom —
				// about 363px, not 280 — and the header's height depends entirely
				// on how many lines the title wraps to. A three-line title is
				// triple a one-line one, which is precisely what a constant
				// cannot say. So the title is measured, in its own type.
				const titleMeasurer = document.createElement('div');
				titleMeasurer.style.cssText =
					`position:absolute;visibility:hidden;width:${BODY_W}px;` +
					`font-family:${titleFontCss};` +
					`font-size:${activeBook.interiorDesign?.['--r-chap-title-size'] ?? '20pt'};` +
					`font-weight:${activeBook.interiorDesign?.['--r-title-weight'] ?? '700'};` +
					`line-height:1.25;`;
				document.body.appendChild(titleMeasurer);

				const showsLabel = activeBook.interiorDesign?.['--r-label-display'] !== 'none';
				// .chapter-label 8pt + 6pt margin ≈ 21px · .chapter-title 12pt
				// bottom margin ≈ 16px · .chapter-rule ≈ 2px
				const OPENER_CHROME  = (showsLabel ? 21 : 0) + 16 + 2;
				// .illustration img max-height 240pt (320px) + 16pt margins (43px)
				const OPENER_ILLUST  = 363;

				titleMeasurer.textContent = c.title ?? '';
				const firstPageReserve =
					OPENER_CHROME + titleMeasurer.offsetHeight + (mappedIllust ? OPENER_ILLUST : 0);
				document.body.removeChild(titleMeasurer);

				let budget = BODY_H - firstPageReserve;

				for (const blk of blocks) {
					measurer.innerHTML = blk;
					// Images inside <figure> tags report 0px height until loaded.
					// Substitute a realistic fixed height so the page-budget math
					// reserves enough space and doesn't overflow the page.
					const hasFigure = measurer.querySelector('figure') !== null;
					// Any plate carrying a --fullpage class takes a whole page:
					// diagram-box--fullpage (diagrams, whose body is an <svg>) and
					// diagram-box--image--fullpage (image plates, a <figure>).
					// This must NOT be gated on hasFigure — a diagram has no
					// <figure>, so that gate silently denied diagrams a full page.
					const isFullPage = blk.includes('--fullpage');
					const h = isFullPage
						? BODY_H          // full-page plates consume the entire page budget
						: hasFigure
						? 260 + 24        // 220pt max-height + caption + margins
						: measurer.offsetHeight + 24;
					// Full-page plates always start on their own page
					if (isFullPage && cur.length > 0) {
						pages.push({ blocks: cur, isFirst: pages.length === 0 });
						cur = []; curH = 0; budget = BODY_H;
					}
					// `cur.length > 0` alone is not the right guard on the FIRST
					// page: the header and illustration have already claimed it
					// without contributing a block, so the sheet can be full while
					// `cur` is still empty. `budget < BODY_H` is true only on that
					// first page, and is what lets the opening paragraph move to
					// page 2 instead of being clipped under the illustration.
					const pageIsOccupied = cur.length > 0 || budget < BODY_H;
					if (curH + h > budget && pageIsOccupied) {
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
					// A page holding nothing but a full-page plate bleeds to the sheet
					// edge: no printed margins, no running header or footer — the plate
					// is the page. Never on a chapter's first page, which still has to
					// carry the chapter title and illustration.
					const isPlatePage = !isFirst
						&& pBlocks.length === 1
						&& pBlocks[0].includes('--fullpage');
					if (isPlatePage) {
						pageCounter++;
						chapHtml += `
							<section class="chapter-section chapter-section--bleed ${coverStyleClass}">
								${pBlocks[0]}
							</section>`;
						return;
					}

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
	@page { size: 6in 9in; margin: 0; }
	.cover-page {
	width: 576px;
	height: 864px;
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
	width: 6in;
	min-height: 9in;
	padding: 0.6in 0.52in 0.5in 0.52in;
	page-break-after: always;
	box-sizing: border-box;
	}
	.toc-page h1 { font-family: ${titleFontCss}; font-size: 22pt; font-weight: 700; color: ${titleColor}; border-bottom: 1.5pt solid ${accent}; padding-bottom: 10px; margin-bottom: 24px; }
	.toc-row { padding: 7px 0; border-bottom: 1pt dotted #D9CFC2; font-size: 11pt; }

	.chapter-section {
	width: 6in;
	height: 9in;
	/* Mirrors .book-page-card in the reader. These two must not drift: the PDF
	   is a bitmap capture of that element into this sheet. */
	padding: 0.6in 0.52in 0.5in 0.52in;
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
		display: ${activeBook.interiorDesign?.['--r-label-display'] ?? 'block'};
		font-family: ${activeBook.interiorDesign?.['--r-label-font'] ?? `'Inter',sans-serif`};
		font-size: 8pt;
		text-transform: ${activeBook.interiorDesign?.['--r-label-transform'] ?? 'uppercase'};
		letter-spacing: ${activeBook.interiorDesign?.['--r-label-letter-spacing'] ?? '3pt'};
		color: ${activeBook.interiorDesign?.['--r-label-color'] ?? accent};
		background: ${activeBook.interiorDesign?.['--r-label-bg'] ?? 'transparent'};
		padding: ${activeBook.interiorDesign?.['--r-label-padding'] ?? '0'};
		border-radius: ${activeBook.interiorDesign?.['--r-label-border-radius'] ?? '0'};
		margin-bottom: 6pt;
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
	/* Shrink-wraps the image so callout percentages resolve against the picture,
	   not against the full-width centred .illustration block. line-height:0 stops
	   the inline-block from inheriting a text baseline gap under the image. */
	.illust-frame { position: relative; display: inline-block; line-height: 0; }
	/* Callouts: the image itself carries no text — an image model cannot spell,
	   so every label is real type set over the picture. html2canvas rasterises
	   these with the page, so they print exactly as they render. */
	.illust-callout {
		position: absolute;
		display: flex;
		align-items: center;
		line-height: 1;
		transform: translateY(-50%);
	}
	.illust-callout--right { flex-direction: row; }
	.illust-callout--left  { flex-direction: row-reverse; transform: translate(-100%, -50%); }
	.illust-callout__dot {
		width: 5pt; height: 5pt; border-radius: 50%;
		background: #E07B20; border: 1pt solid #fff; flex-shrink: 0;
	}
	.illust-callout__line { width: 18pt; height: 1pt; background: #E07B20; flex-shrink: 0; }
	.illust-callout__text {
		font-family: Helvetica, Arial, sans-serif;
		font-size: 6.5pt;
		font-weight: 700;
		color: #0F2231;
		background: rgba(255,255,255,0.96);
		border: 1pt solid #0F2231;
		border-radius: 2pt;
		padding: 1.5pt 3pt;
		white-space: nowrap;
	}
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
	/* Full-page plate: navy header bar (from .diagram-box__header) above an
	   image filling the rest of the chapter page's body area. Pagination
	   assigns these the full BODY_H budget rather than measuring them. */
	.diagram-box--image--fullpage {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		margin: 0;
		page-break-inside: avoid;
		break-inside: avoid;
	}
	/* The bar keeps its intrinsic height; only the figure flexes. */
	/* Bar and footer keep their intrinsic height; only the figure flexes.
	   Without this the flexing figure squeezes the footer to nothing. */
	.diagram-box--image--fullpage .diagram-box__header,
	.diagram-box--image--fullpage .diagram-box__footer {
		flex-shrink: 0;
	}
	.diagram-box--image--fullpage figure {
		flex: 1;
		margin: 0;
		padding: 14pt;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
	}
	/* width:auto (not 100%) so the box shrinks to the picture's aspect ratio.
	   Pinning width:100% while max-height binds leaves a full-width box with a
	   contain-scaled picture inside it — the leftover gutters showed as white
	   strips, and the navy frame hugged the box rather than the photo. */
	.diagram-box--image--fullpage figure img {
		max-width: 100%;
		max-height: 640pt;
		width: auto;
		height: auto;
	}
	/* Photo matte — the image is mounted in a white frame on the cream field,
	   the way a plate is mounted in a printed manual. Applies to the CSS-driven
	   image paths only; the edit drawer writes its own inline border/radius so
	   the reader can set those per-image. */
	.diagram-box--image figure img,
	.diagram-box--plate figure img {
		border: 2px solid #0F2231;
		border-radius: 8px;
		box-shadow: 0 2px 8px rgba(15, 34, 49, 0.14);
		box-sizing: border-box;
	}

	/* Takeaway box closing a plate — white card, amber spine, cream field. */
	.plate-takeaway {
		flex-shrink: 0;
		margin: 0 14pt 14pt;
		padding: 8pt 10pt;
		background-color: #FFFFFF;
		border: 1px solid rgba(15, 34, 49, 0.15);
		border-left: 4px solid #E07B20;
		border-radius: 5px;
		text-align: left;
	}
	.plate-takeaway__title {
		font-family: ${titleFontCss};
		font-size: 10pt;
		font-weight: 700;
		color: #0F2231;
		margin-bottom: 2pt;
	}
	.plate-takeaway__body {
		font-size: 9pt;
		line-height: 1.5;
		color: #1a1612;
		margin: 0;
		text-indent: 0;
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
	/* A table is wrapped in .diagram-box only to inherit the edit-overlay
	   pattern — it is not a plate, so the plate's cream field, border and
	   radius have to be reset or they frame the table as a cream band above
	   and below it. Mirrors the .diagram-box--table reset in the reader. */
	/* Doubled class (0,2,0) so this beats the .diagram-box plate rule (0,1,0)
	   no matter where each lands in the sheet. Single-class here would tie and
	   lose on source order — .diagram-box is declared later in this stylesheet,
	   which is exactly why the cream field kept framing tables in the PDF while
	   the reader (where the reset happens to come last) looked correct. */
	.diagram-box.diagram-box--table {
		background: transparent;
		border: none;
		border-radius: 0;
		box-shadow: none;
		padding: 0;
		overflow: visible;
	}
	.diagram-box--table .table-container {
		width: 100%;
	}

	.callout-box, .tip-box, .warning-box, .key-rule-box {
		border-radius: ${calloutRadius};
		padding: 1.25rem 1.5rem;
		margin: 2rem 0;
		box-sizing: border-box;
	}
	.callout-box {
		background-color: ${calloutBg};
		border-left: ${calloutBdW} solid ${calloutBdC};
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
		color: ${calloutTitleC};
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
		font-family: ${calloutFont};
		font-size: 0.95rem;
		line-height: 1.6;
		color: #1a1612;
	}

	/* Editorial diagram plate — keep in sync with .pdf-measurer-container
	   .diagram-box rules above so pagination measures what it renders. */
	.diagram-box {
		background-color: #FAF5EA;
		border: 1px solid rgba(15, 34, 49, 0.15);
		border-radius: 8px;
		padding: 0;
		margin: 2.5rem 0;
		text-align: center;
		overflow: hidden;
	}
	.diagram-box__header {
		background-color: #0F2231;
		border-bottom: 5px solid #E07B20;
		padding: 0.9rem 1.25rem;
		text-align: left;
	}
	.diagram-box__title {
		font-family: ${titleFontCss};
		font-size: 2rem;
		font-weight: 700;
		color: #FFFFFF;
		line-height: 1.25;
		margin: 0;
	}
	.diagram-box__subtitle {
		font-size: 1.1rem;
		font-weight: 400;
		color: rgba(255, 255, 255, 0.72);
		letter-spacing: 0.2px;
		margin: 0.2rem 0 0;
	}
	.diagram-box__body {
		display: flex;
		justify-content: center;
		width: 100%;
		box-sizing: border-box;
		padding: 1.5rem 1.25rem;
	}
	/* Footer band: book title left, author right. A bleed page suppresses the
	   running footer, so this is what keeps the book on the page. */
	.diagram-box__footer {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 1rem;
		padding: 8pt 1.25rem 10pt;
		border-top: 1px solid rgba(15, 34, 49, 0.18);
		font-size: 8.5pt;
		color: rgba(15, 34, 49, 0.65);
	}
	.diagram-box__footer-book {
		font-style: italic;
	}
	.diagram-box__footer-author {
		font-family: ${titleFontCss};
		color: #E07B20;
		white-space: nowrap;
	}
	/* Scales a tall diagram down to fit its page instead of clipping it.
	   Keep in sync with the .pdf-measurer-container rule above. */
	.diagram-svg {
		width: 100%;
		height: auto;
		max-height: ${DIAGRAM_SVG_MAX_H}px;
	}

	/* Full-page diagram plate: fills the page body from the header bar down.
	   margin:0 because the plate owns the page rather than sitting in prose. */
	.diagram-box--fullpage {
		height: 100%;
		margin: 0;
		display: flex;
		flex-direction: column;
		page-break-inside: avoid;
		break-inside: avoid;
	}
	.diagram-box--fullpage .diagram-box__header {
		flex-shrink: 0;
	}
	/* min-height:0 lets this flex child actually shrink so the SVG's
	   max-height is what binds, rather than the content forcing overflow. */
	.diagram-box--fullpage .diagram-box__body {
		flex: 1;
		min-height: 0;
		align-items: center;
	}
	/* The plate spans the page width, so lift the 480px authoring cap and
	   let the viewBox scale the diagram up to fill it. */
	.diagram-box--fullpage .diagram-svg {
		max-width: 100%;
		max-height: ${DIAGRAM_FULLPAGE_SVG_MAX_H}px;
	}

	/* ── Bleed plate page ──────────────────────────────────────────────────
	   The plate IS the sheet: the section's 1in/1.25in/1.5in printed margins
	   are dropped so the navy bar meets the physical page edge, and no
	   running header or footer is emitted (see the isPlatePage branch). */
	.chapter-section--bleed {
		padding: 0;
		display: block;
	}
	/* Square off the plate — a radius or border would reveal the sheet
	   underneath and break the bleed. */
	.chapter-section--bleed .diagram-box--fullpage {
		height: 100%;
		margin: 0;
		border: 0;
		border-radius: 0;
	}
	/* Bleeding reclaims the printed margins, so the SVG gets the whole
	   11in sheet minus the plate's own chrome (not the smaller BODY_H).
	   Three classes deep so it beats the .diagram-box--fullpage rule above. */
	.chapter-section--bleed .diagram-box--fullpage .diagram-svg {
		max-height: ${PAGE_H_PX - DIAGRAM_CHROME_H}px;
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
