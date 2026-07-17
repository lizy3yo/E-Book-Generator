// ── Chapter-header design variables (added to every preset) ─────────────
//
// --r-chap-header-pad       padding-top on .chapter-content before the header block
// --r-chap-header-bg        background-color behind the entire header block
// --r-chap-header-bd-left   optional left accent bar  (border-left CSS value)
// --r-chap-header-bd-top    optional top overline      (border-top CSS value)
// --r-chap-header-pd        padding inside the header block (top right bottom left)
// --r-chap-header-mb        margin-bottom of the whole header block
// --r-chap-title-size       font-size of the chapter title

export interface DesignColors {
	primary: string;
	accent: string;
	alignment: string;
	titleFont: string;
}

// ── 4. FIELD MANUAL ──────────────────────────────────────────────────────
//
// The house style of a printed practical manual, measured off a real one
// (100 Old-House Fixes, 6×9, WeasyPrint).
//
// The rule that governs it: SERIF EXPLAINS, SANS ACTS. Narrative prose is
// serif; anything the reader skims rather than reads — callout boxes, tables,
// labels, running feet — is sans. That split is most of why such a book reads
// as a manual and not a blog post, and it is why this is the only preset that
// sets `--r-title-font` and `--r-body-font` to different families on purpose.
//
// Colours are NOT hardcoded. `c.primary` and `c.accent` arrive from the book's
// chosen cover, so the interior follows the cover rather than imposing one
// palette on every book.
//
// Two variants, sharing this builder so they cannot drift apart. They differ
// in exactly one thing — who decides the chapter opener's alignment:
//   'Field Manual'              — the reference book's own answer: hard left,
//                                 no eyebrow. Ignores the cover on this point.
//   'Field Manual — Cover Aligned' — follows the cover like every other
//                                 preset, and keeps the eyebrow, which is what
//                                 gives a centred opener its structure.
function fieldManual(c: DesignColors, strict: boolean): Record<string, string> {
	const fontSerif = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
	const fontSans  = '"Inter", system-ui, "Helvetica Neue", Arial, sans-serif';

	// Strict follows the source: chapter titles are left-set and the rule runs
	// the full column. Cover-aligned defers to the cover, and a centred title
	// wants a centred short rule rather than a full-width one under it.
	const align = strict ? 'left' : c.alignment;
	const ruleW = strict ? '100%'
		: align === 'center' ? '60px'
		: align === 'right'  ? '120px'
		: '100%';

	return {
		// NO running header, and a bare page number at the foot.
		//
		// Measured off the reference manual: every text page starts straight
		// into the chapter title or the body — there is no repeated book/chapter
		// line anywhere — and the foot is a single centred page number at
		// x 211–216 of a 432pt page, with zero rules above it.
		//
		// The chapter opener already names the chapter, and a numbered unit
		// names itself; a running head repeating either is ink spent telling the
		// reader what they can already see. Hidden via opacity rather than
		// display, as the 'Hidden / None' preset does — the element keeps its
		// space, so the text block still starts where the grid says.
		'--r-header-font': fontSans,
		'--r-header-color': c.primary,
		'--r-header-border': 'none',
		'--r-header-transform': 'none',
		'--r-header-letter-spacing': '0.2pt',
		'--r-header-opacity': '0',
		'--r-footer-font': fontSans,
		'--r-footer-color': c.primary,
		'--r-footer-border': 'none',
		'--r-footer-letter-spacing': '0.2pt',
		'--r-footer-opacity': '0.7',

		// Chapter title: sans, heavy, sentence case — a signpost, not a
		// flourish, set to be read at a glance rather than admired.
		'--r-title-font': fontSans,
		'--r-title-color': c.primary,
		'--r-title-transform': 'none',
		'--r-title-letter-spacing': '-0.2px',
		'--r-title-weight': '800',
		'--r-title-style': 'normal',

		// SERIF EXPLAINS.
		'--r-body-font': fontSerif,

		// SANS ACTS.
		'--r-label-font': fontSans,
		'--r-label-color': c.accent,
		'--r-label-transform': 'uppercase',
		'--r-label-letter-spacing': '1.6pt',
		'--r-label-bg': 'transparent',
		'--r-label-padding': '0',
		'--r-label-border-radius': '0',
		// The eyebrow. The source has none: its titles read "Chapter 1 — The
		// Old-House Emergency Map", with the number inside the title itself.
		// Strict drops it; cover-aligned keeps it, because a centred title with
		// nothing above it loses the structure the eyebrow was providing.
		'--r-label-display': strict ? 'none' : 'block',

		// Alignment. This is the ONLY place the two variants disagree, and it
		// is deliberate: `--chapter-alignment` is set from the cover further up
		// the style string, and preset tokens are appended after it, so writing
		// it here overrides the cover for this preset only.
		'--chapter-alignment': align,
		'--r-header-align': align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',

		// The accent rule under the chapter title. Small device; it is what
		// makes an opener look designed rather than merely typed.
		'--r-rule-border': `2pt solid ${c.accent}`,
		'--r-rule-width': ruleW,

		// A manual does not open with a drop cap.
		'--r-dropcap-font': fontSerif,
		'--r-dropcap-color': c.primary,
		'--r-dropcap-weight': '700',
		'--r-dropcap-style': 'normal',

		'--r-blockquote-border': `3pt solid ${c.accent}`,
		'--r-blockquote-color': '#4D4035',
		'--r-blockquote-bg': 'transparent',
		'--r-blockquote-padding': '0 0 0 1.25rem',
		'--r-blockquote-border-radius': '0',

		// The action box — the thing the reader came for. Warm ivory field, a
		// thick accent bar down the left and no other border, sans inside
		// because it is scanned rather than read.
		'--r-callout-bg': '#FBF8EF',
		'--r-callout-border-color': c.accent,
		'--r-callout-border-width': '6px',
		'--r-callout-border-radius': '0',
		'--r-callout-title-color': c.primary,
		'--r-callout-font': fontSans,

		'--r-table-header-bg': c.primary,
		'--r-border': 'rgba(15, 34, 49, 0.18)',

		// Chapter header: no left bar, no tint. The rule below the title is the
		// only device, which is what keeps the opener quiet.
		'--r-chap-header-pad': '0.35in',
		'--r-chap-header-bg': 'transparent',
		'--r-chap-header-bd-left': 'none',
		'--r-chap-header-bd-top': 'none',
		'--r-chap-header-pd': '0',
		'--r-chap-header-mb': '1.5rem',
		'--r-chap-title-size': '22pt'
	};
}

export const INTERIOR_PRESETS: Record<string, (colors: DesignColors) => Record<string, string>> = {

	// ── 1. CLASSICAL EDITORIAL ───────────────────────────────────────────────
	'Classical Editorial': (c) => {
		const fontSerif = '"Lora", Georgia, serif';
		const ruleW = c.alignment === 'center' ? '60px' : c.alignment === 'right' ? '120px' : '100%';
		return {
			// running header / footer
			'--r-header-font': fontSerif,
			'--r-header-color': c.primary,
			'--r-header-border': `0.5pt solid ${c.accent}`,
			'--r-header-transform': 'uppercase',
			'--r-header-letter-spacing': '1.5pt',
			'--r-header-opacity': '0.75',
			'--r-footer-font': fontSerif,
			'--r-footer-color': c.primary,
			'--r-footer-border': `0.5pt solid ${c.accent}`,
			'--r-footer-letter-spacing': '1pt',
			'--r-footer-opacity': '0.75',
			// chapter title block
			'--r-title-font': fontSerif,
			'--r-title-color': c.primary,
			'--r-title-transform': 'none',
			'--r-title-letter-spacing': '0px',
			'--r-title-weight': '700',
			'--r-title-style': 'normal',
			// body
			'--r-body-font': fontSerif,
			// label
			'--r-label-font': '"Inter", sans-serif',
			'--r-label-color': c.accent,
			'--r-label-transform': 'uppercase',
			'--r-label-letter-spacing': '3pt',
			'--r-label-bg': 'transparent',
			'--r-label-padding': '0',
			'--r-label-border-radius': '0',
			// rule
			'--r-rule-border': `1.5pt solid ${c.accent}`,
			'--r-rule-width': ruleW,
			// drop cap
			'--r-dropcap-font': fontSerif,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '700',
			'--r-dropcap-style': 'italic',
			// blockquote
			'--r-blockquote-border': `3pt solid ${c.accent}`,
			'--r-blockquote-color': '#555555',
			'--r-blockquote-bg': 'transparent',
			'--r-blockquote-padding': '0 0 0 1.5rem',
			'--r-blockquote-border-radius': '0',
			// misc
			'--r-header-align': c.alignment === 'center' ? 'center' : c.alignment === 'right' ? 'flex-end' : 'flex-start',
			'--r-table-header-bg': c.primary,
			'--r-border': '#e2e8f0',
			// ── Chapter header layout ──
			'--r-chap-header-pad': '0.2in',
			'--r-chap-header-bg': 'transparent',
			'--r-chap-header-bd-left': 'none',
			'--r-chap-header-bd-top': 'none',
			'--r-chap-header-pd': '0',
			'--r-chap-header-mb': '1.5rem',
			'--r-chap-title-size': '22pt'
		};
	},

	// ── 2. MODERN MINIMALIST ─────────────────────────────────────────────────
	'Modern Minimalist': (c) => {
		const fontSans = '"Inter", sans-serif';
		return {
			'--r-header-font': fontSans,
			'--r-header-color': c.primary,
			'--r-header-border': 'none',
			'--r-header-transform': 'uppercase',
			'--r-header-letter-spacing': '3px',
			'--r-header-opacity': '0.7',
			'--r-footer-font': fontSans,
			'--r-footer-color': c.primary,
			'--r-footer-border': 'none',
			'--r-footer-letter-spacing': '2px',
			'--r-footer-opacity': '0.7',
			'--r-title-font': fontSans,
			'--r-title-color': c.primary,
			'--r-title-transform': 'none',
			'--r-title-letter-spacing': '-0.5px',
			'--r-title-weight': '600',
			'--r-title-style': 'normal',
			'--r-body-font': fontSans,
			'--r-label-font': fontSans,
			'--r-label-color': c.accent,
			'--r-label-transform': 'uppercase',
			'--r-label-letter-spacing': '2px',
			'--r-label-bg': 'transparent',
			'--r-label-padding': '0',
			'--r-label-border-radius': '0',
			'--r-rule-border': 'none',
			'--r-rule-width': '0px',
			'--r-dropcap-font': fontSans,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '800',
			'--r-dropcap-style': 'normal',
			'--r-blockquote-border': `4px solid #cbd5e1`,
			'--r-blockquote-color': '#475569',
			'--r-blockquote-bg': '#f8fafc',
			'--r-blockquote-padding': '1rem 1.25rem',
			'--r-blockquote-border-radius': '6px',
			'--r-header-align': c.alignment === 'center' ? 'center' : c.alignment === 'right' ? 'flex-end' : 'flex-start',
			'--r-table-header-bg': c.primary,
			'--r-border': '#e2e8f0',
			// ── Chapter header layout: thin top line, tight pad ──
			'--r-chap-header-pad': '0.25in',
			'--r-chap-header-bg': 'transparent',
			'--r-chap-header-bd-left': 'none',
			'--r-chap-header-bd-top': `2px solid ${c.accent}`,
			'--r-chap-header-pd': '1rem 0 0 0',
			'--r-chap-header-mb': '1.25rem',
			'--r-chap-title-size': '24pt'
		};
	},

	// ── 3. BOLD TECH / GRAPHIC ───────────────────────────────────────────────
	'Bold Tech / Graphic': (c) => {
		const fontSans = '"Inter", sans-serif';
		const ruleW = c.alignment === 'center' ? '80px' : c.alignment === 'right' ? '160px' : '100%';
		return {
			'--r-header-font': fontSans,
			'--r-header-color': c.primary,
			'--r-header-border': `3px solid ${c.accent}`,
			'--r-header-transform': 'uppercase',
			'--r-header-letter-spacing': '2px',
			'--r-header-opacity': '0.9',
			'--r-footer-font': fontSans,
			'--r-footer-color': c.primary,
			'--r-footer-border': `3px solid ${c.accent}`,
			'--r-footer-letter-spacing': '1.5px',
			'--r-footer-opacity': '0.9',
			'--r-title-font': fontSans,
			'--r-title-color': c.primary,
			'--r-title-transform': 'uppercase',
			'--r-title-letter-spacing': '1px',
			'--r-title-weight': '800',
			'--r-title-style': 'normal',
			'--r-body-font': fontSans,
			'--r-label-font': fontSans,
			'--r-label-color': '#ffffff',
			'--r-label-transform': 'uppercase',
			'--r-label-letter-spacing': '3px',
			'--r-label-bg': c.accent,
			'--r-label-padding': '0.3rem 0.8rem',
			'--r-label-border-radius': '4px',
			'--r-rule-border': `4px solid ${c.accent}`,
			'--r-rule-width': ruleW,
			'--r-dropcap-font': fontSans,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '900',
			'--r-dropcap-style': 'normal',
			'--r-blockquote-border': `5px solid ${c.accent}`,
			'--r-blockquote-color': '#1e293b',
			'--r-blockquote-bg': '#f1f5f9',
			'--r-blockquote-padding': '1.25rem 1.5rem',
			'--r-blockquote-border-radius': '0',
			'--r-header-align': c.alignment === 'center' ? 'center' : c.alignment === 'right' ? 'flex-end' : 'flex-start',
			'--r-table-header-bg': c.primary,
			'--r-border': '#cbd5e1',
			// ── Chapter header layout: left accent bar with tinted bg ──
			'--r-chap-header-pad': '0.15in',
			'--r-chap-header-bg': 'transparent',
			'--r-chap-header-bd-left': `6px solid ${c.accent}`,
			'--r-chap-header-bd-top': 'none',
			'--r-chap-header-pd': '0.75rem 1.25rem',
			'--r-chap-header-mb': '1.75rem',
			'--r-chap-title-size': '22pt'
		};
	},

	'Field Manual': (c) => fieldManual(c, true),

	'Field Manual — Cover Aligned': (c) => fieldManual(c, false),

	// ── 5. ROYAL ELEGANCE ────────────────────────────────────────────────────
	'Royal Elegance': (c) => {
		const fontRoyal = '"Lora", Georgia, serif';
		return {
			'--r-header-font': fontRoyal,
			'--r-header-color': c.primary,
			'--r-header-border': `2.5px double ${c.accent}`,
			'--r-header-transform': 'uppercase',
			'--r-header-letter-spacing': '2.5pt',
			'--r-header-opacity': '0.85',
			'--r-footer-font': fontRoyal,
			'--r-footer-color': c.primary,
			'--r-footer-border': `2.5px double ${c.accent}`,
			'--r-footer-letter-spacing': '2pt',
			'--r-footer-opacity': '0.85',
			'--r-title-font': fontRoyal,
			'--r-title-color': c.primary,
			'--r-title-transform': 'none',
			'--r-title-letter-spacing': '1px',
			'--r-title-weight': '700',
			'--r-title-style': 'italic',
			'--r-body-font': fontRoyal,
			'--r-label-font': fontRoyal,
			'--r-label-color': c.accent,
			'--r-label-transform': 'uppercase',
			'--r-label-letter-spacing': '4pt',
			'--r-label-bg': 'transparent',
			'--r-label-padding': '0',
			'--r-label-border-radius': '0',
			'--r-rule-border': `3px double ${c.accent}`,
			'--r-rule-width': '120px',
			'--r-dropcap-font': fontRoyal,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '700',
			'--r-dropcap-style': 'normal',
			'--r-blockquote-border': `4px double ${c.accent}`,
			'--r-blockquote-color': '#5c4033',
			'--r-blockquote-bg': '#fdfbf7',
			'--r-blockquote-padding': '1.25rem 1.5rem',
			'--r-blockquote-border-radius': '4px',
			'--r-header-align': 'center',
			'--r-table-header-bg': c.primary,
			'--r-border': '#e4d7c6',
			// ── Chapter header layout: double overline + centered ──
			'--r-chap-header-pad': '0.5in',
			'--r-chap-header-bg': 'transparent',
			'--r-chap-header-bd-left': 'none',
			'--r-chap-header-bd-top': `3px double ${c.accent}`,
			'--r-chap-header-pd': '1rem 0 0 0',
			'--r-chap-header-mb': '1.5rem',
			'--r-chap-title-size': '21pt'
		};
	},

	// ── 5. VINTAGE ACADEMIC ──────────────────────────────────────────────────
	'Vintage Academic': (c) => {
		const fontAcademic = 'Georgia, serif';
		const ruleW = c.alignment === 'center' ? '70px' : c.alignment === 'right' ? '140px' : '100%';
		return {
			'--r-header-font': fontAcademic,
			'--r-header-color': c.primary,
			'--r-header-border': `1.5pt dotted ${c.accent}`,
			'--r-header-transform': 'none',
			'--r-header-letter-spacing': '1pt',
			'--r-header-opacity': '0.8',
			'--r-footer-font': fontAcademic,
			'--r-footer-color': c.primary,
			'--r-footer-border': `1.5pt dotted ${c.accent}`,
			'--r-footer-letter-spacing': '1pt',
			'--r-footer-opacity': '0.8',
			'--r-title-font': fontAcademic,
			'--r-title-color': c.primary,
			'--r-title-transform': 'none',
			'--r-title-letter-spacing': '0.5px',
			'--r-title-weight': '700',
			'--r-title-style': 'normal',
			'--r-body-font': fontAcademic,
			'--r-label-font': fontAcademic,
			'--r-label-color': c.accent,
			'--r-label-transform': 'uppercase',
			'--r-label-letter-spacing': '2pt',
			'--r-label-bg': 'transparent',
			'--r-label-padding': '0',
			'--r-label-border-radius': '0',
			'--r-rule-border': `2.5pt dotted ${c.accent}`,
			'--r-rule-width': ruleW,
			'--r-dropcap-font': fontAcademic,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '700',
			'--r-dropcap-style': 'normal',
			'--r-blockquote-border': `3.5px solid ${c.accent}`,
			'--r-blockquote-color': '#4a4a4a',
			'--r-blockquote-bg': '#fcfcfc',
			'--r-blockquote-padding': '1rem 1.25rem',
			'--r-blockquote-border-radius': '2px',
			'--r-header-align': c.alignment === 'center' ? 'center' : c.alignment === 'right' ? 'flex-end' : 'flex-start',
			'--r-table-header-bg': c.primary,
			'--r-border': '#d1d5db',
			// ── Chapter header layout: dotted top rule, moderate pad ──
			'--r-chap-header-pad': '0.4in',
			'--r-chap-header-bg': 'transparent',
			'--r-chap-header-bd-left': 'none',
			'--r-chap-header-bd-top': `2pt dotted ${c.accent}`,
			'--r-chap-header-pd': '0.75rem 0 0 0',
			'--r-chap-header-mb': '1.5rem',
			'--r-chap-title-size': '20pt'
		};
	},

	// ── 6. AESTHETIC LITERARY ────────────────────────────────────────────────
	'Aesthetic Literary': (c) => {
		const fontSerif = '"Lora", Georgia, serif';
		return {
			'--r-header-font': fontSerif,
			'--r-header-color': '#64748b',
			'--r-header-border': 'none',
			'--r-header-transform': 'lowercase',
			'--r-header-letter-spacing': '2px',
			'--r-header-opacity': '0.6',
			'--r-footer-font': fontSerif,
			'--r-footer-color': '#64748b',
			'--r-footer-border': 'none',
			'--r-footer-letter-spacing': '1px',
			'--r-footer-opacity': '0.6',
			'--r-title-font': fontSerif,
			'--r-title-color': c.primary,
			'--r-title-transform': 'none',
			'--r-title-letter-spacing': '0.2px',
			'--r-title-weight': '300',
			'--r-title-style': 'italic',
			'--r-body-font': fontSerif,
			'--r-label-font': fontSerif,
			'--r-label-color': c.accent,
			'--r-label-transform': 'none',
			'--r-label-letter-spacing': '1pt',
			'--r-label-bg': 'transparent',
			'--r-label-padding': '0',
			'--r-label-border-radius': '0',
			'--r-rule-border': `0.5pt solid ${c.accent}`,
			'--r-rule-width': '50px',
			'--r-dropcap-font': fontSerif,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '400',
			'--r-dropcap-style': 'italic',
			'--r-blockquote-border': `2px solid ${c.accent}`,
			'--r-blockquote-color': '#64748b',
			'--r-blockquote-bg': 'transparent',
			'--r-blockquote-padding': '0.5rem 0 0.5rem 1.25rem',
			'--r-blockquote-border-radius': '0',
			'--r-header-align': 'center',
			'--r-table-header-bg': c.primary,
			'--r-border': '#f1f5f9',
			// ── Chapter header layout: centered, no rule, lots of breathing room ──
			'--r-chap-header-pad': '0.6in',
			'--r-chap-header-bg': 'transparent',
			'--r-chap-header-bd-left': 'none',
			'--r-chap-header-bd-top': 'none',
			'--r-chap-header-pd': '0',
			'--r-chap-header-mb': '2rem',
			'--r-chap-title-size': '22pt'
		};
	},

	// ── 7. TECHNICAL MONO ────────────────────────────────────────────────────
	'Technical Mono': (c) => {
		const fontMono = '"Courier New", Courier, monospace';
		return {
			'--r-header-font': fontMono,
			'--r-header-color': c.primary,
			'--r-header-border': `1px dashed ${c.accent}`,
			'--r-header-transform': 'uppercase',
			'--r-header-letter-spacing': '2px',
			'--r-header-opacity': '0.85',
			'--r-footer-font': fontMono,
			'--r-footer-color': c.primary,
			'--r-footer-border': `1px dashed ${c.accent}`,
			'--r-footer-letter-spacing': '2px',
			'--r-footer-opacity': '0.85',
			'--r-title-font': fontMono,
			'--r-title-color': c.primary,
			'--r-title-transform': 'uppercase',
			'--r-title-letter-spacing': '1.5px',
			'--r-title-weight': '700',
			'--r-title-style': 'normal',
			'--r-body-font': fontMono,
			'--r-label-font': fontMono,
			'--r-label-color': c.accent,
			'--r-label-transform': 'uppercase',
			'--r-label-letter-spacing': '3px',
			'--r-label-bg': 'transparent',
			'--r-label-padding': '0',
			'--r-label-border-radius': '0',
			'--r-rule-border': `2px dashed ${c.accent}`,
			'--r-rule-width': '100%',
			'--r-dropcap-font': fontMono,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '700',
			'--r-dropcap-style': 'normal',
			'--r-blockquote-border': `3px dashed ${c.accent}`,
			'--r-blockquote-color': '#1e293b',
			'--r-blockquote-bg': '#f8fafc',
			'--r-blockquote-padding': '1rem',
			'--r-blockquote-border-radius': '4px',
			'--r-header-align': c.alignment === 'center' ? 'center' : c.alignment === 'right' ? 'flex-end' : 'flex-start',
			'--r-table-header-bg': c.primary,
			'--r-border': '#cbd5e1',
			// ── Chapter header layout: dashed left bar, terminal feel ──
			'--r-chap-header-pad': '0.2in',
			'--r-chap-header-bg': '#f8fafc',
			'--r-chap-header-bd-left': `4px dashed ${c.accent}`,
			'--r-chap-header-bd-top': 'none',
			'--r-chap-header-pd': '0.75rem 1rem',
			'--r-chap-header-mb': '1.5rem',
			'--r-chap-title-size': '18pt'
		};
	},

	// ── 8. HIDDEN / NONE ─────────────────────────────────────────────────────
	'Hidden / None': (c) => {
		const fontSerif = '"Lora", Georgia, serif';
		const ruleW = c.alignment === 'center' ? '60px' : c.alignment === 'right' ? '120px' : '100%';
		return {
			'--r-header-font': fontSerif,
			'--r-header-color': c.primary,
			'--r-header-border': 'none',
			'--r-header-transform': 'none',
			'--r-header-letter-spacing': '0',
			'--r-header-opacity': '0',
			'--r-footer-font': fontSerif,
			'--r-footer-color': c.primary,
			'--r-footer-border': 'none',
			'--r-footer-letter-spacing': '0',
			'--r-footer-opacity': '0',
			'--r-title-font': fontSerif,
			'--r-title-color': c.primary,
			'--r-title-transform': 'none',
			'--r-title-letter-spacing': '0px',
			'--r-title-weight': '700',
			'--r-title-style': 'normal',
			'--r-body-font': fontSerif,
			'--r-label-font': '"Inter", sans-serif',
			'--r-label-color': c.accent,
			'--r-label-transform': 'uppercase',
			'--r-label-letter-spacing': '3pt',
			'--r-label-bg': 'transparent',
			'--r-label-padding': '0',
			'--r-label-border-radius': '0',
			'--r-rule-border': `1.5pt solid ${c.accent}`,
			'--r-rule-width': ruleW,
			'--r-dropcap-font': fontSerif,
			'--r-dropcap-color': c.accent,
			'--r-dropcap-weight': '700',
			'--r-dropcap-style': 'normal',
			'--r-blockquote-border': `3pt solid ${c.accent}`,
			'--r-blockquote-color': '#555555',
			'--r-blockquote-bg': 'transparent',
			'--r-blockquote-padding': '0 0 0 1.5rem',
			'--r-blockquote-border-radius': '0',
			'--r-header-align': c.alignment === 'center' ? 'center' : c.alignment === 'right' ? 'flex-end' : 'flex-start',
			'--r-table-header-bg': c.primary,
			'--r-border': '#e2e8f0',
			// ── Chapter header layout: title near top, no decorations ──
			'--r-chap-header-pad': '0.25in',
			'--r-chap-header-bg': 'transparent',
			'--r-chap-header-bd-left': 'none',
			'--r-chap-header-bd-top': 'none',
			'--r-chap-header-pd': '0',
			'--r-chap-header-mb': '1.5rem',
			'--r-chap-title-size': '22pt'
		};
	}
};
