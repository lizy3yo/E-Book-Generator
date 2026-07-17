/**
 * Unified Markdown and Diagrams parser for the E-Book Generator.
 * Converts headings, bold/italic markup, lists, and markdown tables into clean, responsive HTML.
 * Balances HTML blocks recursively to preserve structured layouts like stat blocks, diagrams, and charts.
 * 
 * Supports rendering 45+ industry-standard diagram types (Pie, Bar, SWOT, Flowcharts, Hierarchies, Blueprints, Venns, and more).
 */

/**
 * Editorial diagram palette — the house style for every rendered diagram.
 *
 * Diagrams are framed like plates in a printed manual: a deep navy header bar
 * carrying the title, an amber rule beneath it, and a warm cream field holding
 * white cards outlined in navy. A diagram may override any of these per-block
 * via `color1:` / `color2:` in the DSL; these are the defaults when it doesn't.
 */
const DIAGRAM_NAVY   = '#0F2231'; // header bar, card strokes, body text
const DIAGRAM_AMBER  = '#E07B20'; // accent rule, connectors, step labels
const DIAGRAM_CREAM  = '#FAF5EA'; // diagram field background
const DIAGRAM_CARD   = '#FFFFFF'; // node/card fill

/**
 * Book identity printed in a plate's footer. A plate on a bleed page has no
 * running footer above it (bleed suppresses the page chrome), so it carries
 * its own — this is what puts the book back on the page.
 */
export interface BookMeta {
	title?: string;
	author?: string;
}

/**
 * Classes for an image plate that owns its page.
 *
 * `diagram-box--fullpage` is the canonical "owns its page" hook — every CSS
 * rule that makes a plate fill its sheet keys on it. The paginator matches the
 * looser '--fullpage' substring, so `diagram-box--image--fullpage` alone was
 * enough to win a page but NOT enough to match those rules, which left image
 * plates on a bleed page without the styles that fill it. Carry both:
 * `--image--fullpage` for the figure/img layout, `--fullpage` for the page fill.
 */
const FULLPAGE_IMAGE_CLASSES =
	'diagram-box diagram-box--image diagram-box--image--fullpage diagram-box--fullpage';

/**
 * Keys whose values are free prose or URLs. Every other unrecognised key is
 * treated as a comma-separated list, which would corrupt these.
 */
const PROSE_KEYS = new Set(['image', 'url', 'takeaway', 'takeawaytitle', 'root', 'caption', 'callouts']);

interface DiagramData {
	type: string;
	title: string;
	subtitle?: string;
	labels: string[];
	values: number[];
	[key: string]: any;
}

function parseDiagramLines(content: string): DiagramData {
	const lines = content.split('\n');
	const data: DiagramData = {
		type: '',
		title: '',
		labels: [],
		values: []
	};

	for (let line of lines) {
		line = line.trim();
		if (!line || line.startsWith('#')) continue;

		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) {
			if (line.startsWith('-')) {
				if (!data.nodes) data.nodes = [];
				data.nodes.push(line.slice(1).trim());
			}
			continue;
		}

		const key = line.substring(0, colonIdx).trim().toLowerCase();
		const val = line.substring(colonIdx + 1).trim();

		if (key === 'type') data.type = val;
		else if (key === 'title') data.title = val;
		else if (key === 'subtitle') data.subtitle = val;
		else if (key === 'labels') {
			data.labels = val.split(',').map(s => s.trim());
		} else if (key === 'values') {
			data.values = val.split(',').map(s => parseFloat(s.trim()));
		} else if (PROSE_KEYS.has(key)) {
			// Prose and URLs are opaque single values — the comma-split below
			// would shred a sentence or a data: URL into fragments.
			data[key] = val;
		} else {
			if (val.includes(',')) {
				data[key] = val.split(',').map(s => s.trim());
			} else {
				data[key] = val;
			}
		}
	}

	return data;
}

/** XML-safe escape for text inside an SVG <text> node. */
const svgEsc = (s: string) =>
	String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Greedy word-wrap into lines of at most maxChars characters. */
function wrapSvgText(text: string, maxChars: number): string[] {
	const words = String(text).split(' ');
	const lines: string[] = [];
	let cur = '';
	for (const w of words) {
		const candidate = cur ? `${cur} ${w}` : w;
		if (candidate.length > maxChars && cur) { lines.push(cur); cur = w; }
		else cur = candidate;
	}
	if (cur) lines.push(cur);
	return lines.length ? lines : [''];
}

function hexToRgbA(color: string, alpha = 0.1): string {
	if (!color || !color.startsWith('#')) return color;
	try {
		let c = color.substring(1);
		if (c.length === 3) {
			c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
		}
		const num = parseInt(c, 16);
		const r = (num >> 16) & 255;
		const g = (num >> 8) & 255;
		const b = num & 255;
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	} catch {
		return color;
	}
}

function renderDiagram(
	data: DiagramData,
	rawBlocksLength: number,
	rawBlocks: string[],
	chapterId: string = '',
	diagramIndex: number = 0,
	bookMeta: BookMeta = {}
): string {
	const type = data.type.toLowerCase().replace(/[^a-z0-9]/g, '');
	const title = data.title || 'Diagram';
	const subtitle = data.subtitle || '';

	let body = '';

	// Parse custom color inputs (fallback to theme defaults if not specified)
	const customColors = [
		data.color1,
		data.color2,
		data.color3,
		data.color4,
		data.color5,
		data.color6
	].filter(Boolean) as string[];

	// 1. BAR CHART / COLUMN CHART
	if (type.includes('barchart') || type.includes('columnchart')) {
		const maxVal = Math.max(...data.values, 1);
		const c1 = data.color1 || 'var(--r-accent, #C9A84C)';
		const c2 = data.color2 || 'var(--r-title-color, #1E293B)';

		const rows = data.labels.map((lbl, idx) => {
			const val = data.values[idx] || 0;
			const pct = (val / maxVal) * 100;
			return `
				<div style="display: flex; align-items: center; margin-bottom: 0.5rem; width: 100%;">
					<div style="width: 100px; font-size: 0.8rem; text-align: right; padding-right: 0.75rem; color: var(--r-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${lbl}</div>
					<div style="flex: 1; background-color: var(--r-table-stripe, #f1f5f9); height: 24px; border-radius: 4px; overflow: hidden; position: relative;">
						<div style="background: linear-gradient(90deg, ${c1} 0%, ${c2} 100%); width: ${pct}%; height: 100%; display: flex; align-items: center; justify-content: flex-end; padding-right: 0.5rem; box-sizing: border-box; color: #fff; font-size: 0.75rem; font-weight: bold;">
							${val}
						</div>
					</div>
				</div>
			`;
		}).join('');
		body = `<div style="width: 100%;">${rows}</div>`;
	}

	// 2. PIE CHART / DONUT CHART
	else if (type.includes('piechart') || type.includes('donutchart')) {
		const total = data.values.reduce((a, b) => a + b, 0) || 1;
		let currentAngle = 0;
		const defaultColors = ['#C9A84C', '#1E293B', '#475569', '#64748B', '#94A3B8', '#CBD5E1'];
		const colors = customColors.length > 0 ? customColors : defaultColors;

		const slices = data.values.map((val, idx) => {
			const angle = (val / total) * 360;
			const x1 = 100 + 80 * Math.cos((currentAngle - 90) * Math.PI / 180);
			const y1 = 100 + 80 * Math.sin((currentAngle - 90) * Math.PI / 180);
			currentAngle += angle;
			const x2 = 100 + 80 * Math.cos((currentAngle - 90) * Math.PI / 180);
			const y2 = 100 + 80 * Math.sin((currentAngle - 90) * Math.PI / 180);
			const largeArc = angle > 180 ? 1 : 0;
			const color = colors[idx % colors.length];

			if (angle >= 360) {
				return `<circle cx="100" cy="100" r="80" fill="${color}" stroke="#fff" stroke-width="1" />`;
			}
			return `<path d="M100,100 L${x1.toFixed(1)},${y1.toFixed(1)} A80,80 0 ${largeArc},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}" stroke="#fff" stroke-width="1" />`;
		}).join('');

		const legends = data.labels.map((lbl, idx) => {
			const color = colors[idx % colors.length];
			const val = data.values[idx] || 0;
			const pct = ((val / total) * 100).toFixed(1);
			return `
				<div style="display: flex; align-items: center; font-size: 0.8rem; margin-bottom: 0.25rem;">
					<div style="width: 12px; height: 12px; background-color: ${color}; margin-right: 0.5rem; border-radius: 2px;"></div>
					<span>${lbl}: <strong>${val}</strong> (${pct}%)</span>
				</div>
			`;
		}).join('');

		body = `
			<div style="display: flex; align-items: center; justify-content: center; gap: 2rem; flex-wrap: wrap; width: 100%;">
				<svg width="180" height="180" viewBox="0 0 200 200">${slices}</svg>
				<div>${legends}</div>
			</div>
		`;
	}

	// 3. SWOT DIAGRAM
	else if (type.includes('swot')) {
		const s = data.strengths || data.strength || [];
		const w = data.weaknesses || data.weakness || [];
		const o = data.opportunities || data.opportunity || [];
		const t = data.threats || data.threat || [];

		const mapList = (arr: any) => {
			const items = Array.isArray(arr) ? arr : [arr];
			return items.map((x: string) => `<li style="margin-bottom: 0.25rem;">${x}</li>`).join('');
		};

		const c1 = data.color1 || '#10B981';
		const c2 = data.color2 || '#EF4444';
		const c3 = data.color3 || '#3B82F6';
		const c4 = data.color4 || '#F59E0B';

		body = `
			<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; width: 100%; box-sizing: border-box;">
				<div style="background-color: ${hexToRgbA(c1, 0.08)}; border-left: 4px solid ${c1}; padding: 0.75rem; border-radius: 4px;">
					<h5 style="color: ${c1}; margin: 0 0 0.5rem 0; font-weight: bold; font-size: 0.9rem;">💪 Strengths</h5>
					<ul style="margin: 0; padding-left: 1rem; font-size: 0.8rem; color: ${c1}; list-style-type: disc;">${mapList(s)}</ul>
				</div>
				<div style="background-color: ${hexToRgbA(c2, 0.08)}; border-left: 4px solid ${c2}; padding: 0.75rem; border-radius: 4px;">
					<h5 style="color: ${c2}; margin: 0 0 0.5rem 0; font-weight: bold; font-size: 0.9rem;">⚠️ Weaknesses</h5>
					<ul style="margin: 0; padding-left: 1rem; font-size: 0.8rem; color: ${c2}; list-style-type: disc;">${mapList(w)}</ul>
				</div>
				<div style="background-color: ${hexToRgbA(c3, 0.08)}; border-left: 4px solid ${c3}; padding: 0.75rem; border-radius: 4px;">
					<h5 style="color: ${c3}; margin: 0 0 0.5rem 0; font-weight: bold; font-size: 0.9rem;">🌟 Opportunities</h5>
					<ul style="margin: 0; padding-left: 1rem; font-size: 0.8rem; color: ${c3}; list-style-type: disc;">${mapList(o)}</ul>
				</div>
				<div style="background-color: ${hexToRgbA(c4, 0.08)}; border-left: 4px solid ${c4}; padding: 0.75rem; border-radius: 4px;">
					<h5 style="color: ${c4}; margin: 0 0 0.5rem 0; font-weight: bold; font-size: 0.9rem;">⚡ Threats</h5>
					<ul style="margin: 0; padding-left: 1rem; font-size: 0.8rem; color: ${c4}; list-style-type: disc;">${mapList(t)}</ul>
				</div>
			</div>
		`;
	}

	// 4. PYRAMID DIAGRAM
	else if (type.includes('pyramid')) {
		const layers = data.layers || data.levels || [];
		const layerList = Array.isArray(layers) ? layers : [layers];
		const len = layerList.length;
		const defaultColors = ['#C9A84C', '#D4AF37', '#E5A93B', '#F1B82D', '#F9C94C', '#FFD875'];
		const colors = customColors.length > 0 ? customColors : defaultColors;

		const svgs = layerList.map((layer, idx) => {
			const widthPctTop = (idx / len) * 160;
			const widthPctBottom = ((idx + 1) / len) * 160;
			const color = colors[idx % colors.length];

			const topY = 20 + idx * (160 / len);
			const botY = 20 + (idx + 1) * (160 / len);
			const x1 = 100 - widthPctTop / 2;
			const x2 = 100 + widthPctTop / 2;
			const x3 = 100 + widthPctBottom / 2;
			const x4 = 100 - widthPctBottom / 2;

			return `
				<polygon points="${x1.toFixed(1)},${topY.toFixed(1)} ${x2.toFixed(1)},${topY.toFixed(1)} ${x3.toFixed(1)},${botY.toFixed(1)} ${x4.toFixed(1)},${botY.toFixed(1)}" fill="${color}" stroke="#fff" stroke-width="1.5" />
				<text x="100" y="${(topY + (160 / len) / 2 + 3).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="7" font-family="sans-serif" font-weight="bold">${layer}</text>
			`;
		}).join('');

		body = `
			<div style="text-align: center; width: 100%;">
				<svg width="240" height="200" viewBox="0 0 200 200">${svgs}</svg>
			</div>
		`;
	}

	// 5. VENN DIAGRAM
	else if (type.includes('venn')) {
		const left = data.leftlabel || 'Group A';
		const right = data.rightlabel || 'Group B';
		const leftItems = data.leftitems || [];
		const rightItems = data.rightitems || [];
		const sharedItems = data.shareditems || [];

		const mapList = (arr: any) => {
			const items = Array.isArray(arr) ? arr : [arr];
			return items.map((x: string) => `<div>• ${x}</div>`).join('');
		};

		const c1 = data.color1 || 'var(--r-accent, #C9A84C)';
		const c2 = data.color2 || 'var(--r-title-color, #1E293B)';

		body = `
			<div style="position: relative; width: 100%; max-width: 480px; height: 260px; margin: 0 auto; background-color: var(--r-table-stripe, #f8fafc); border-radius: 6px; padding: 1rem; border: 1px solid var(--r-border, #e2e8f0); box-sizing: border-box;">
				<!-- Left Circle -->
				<div style="position: absolute; left: 20px; top: 30px; width: 200px; height: 200px; border-radius: 50%; background-color: ${hexToRgbA(c1, 0.1)}; border: 2px solid ${c1}; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1rem; box-sizing: border-box; text-align: center; z-index: 2;">
					<strong style="font-size: 0.85rem; color: var(--r-title-color);">${left}</strong>
					<div style="font-size: 0.7rem; margin-top: 0.25rem; color: var(--r-text); overflow: hidden; max-height: 120px;">${mapList(leftItems)}</div>
				</div>
				<!-- Right Circle -->
				<div style="position: absolute; right: 20px; top: 30px; width: 200px; height: 200px; border-radius: 50%; background-color: ${hexToRgbA(c2, 0.06)}; border: 2px solid ${c2}; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1rem; box-sizing: border-box; text-align: center; z-index: 2;">
					<strong style="font-size: 0.85rem; color: var(--r-title-color);">${right}</strong>
					<div style="font-size: 0.7rem; margin-top: 0.25rem; color: var(--r-text); overflow: hidden; max-height: 120px;">${mapList(rightItems)}</div>
				</div>
				<!-- Intersection Content Overlay -->
				<div style="position: absolute; left: 190px; top: 60px; width: 100px; text-align: center; z-index: 10;">
					<strong style="font-size: 0.8rem; color: var(--r-title-color);">Both</strong>
					<div style="font-size: 0.65rem; margin-top: 0.2:rem; color: var(--r-text); font-weight: 500;">${mapList(sharedItems)}</div>
				</div>
			</div>
		`;
	}

	// 6. FLOWCHART / TIMELINE / GANTT / PROCESS / WORKFLOW
	else if (type.includes('flowchart') || type.includes('process') || type.includes('timeline') || type.includes('gantt') || type.includes('workflow') || type.includes('dfd') || type.includes('sequence') || type.includes('activity') || type.includes('state') || type.includes('swimlane')) {
		const accent = data.color1 || DIAGRAM_AMBER;
		const dark   = data.color2 || DIAGRAM_NAVY;

		// Steps may arrive as an array of individual labels, or as a single
		// '->' delimited string produced by the AI (e.g. "A -> B -> C").
		// Normalise both forms into a flat array of step strings.
		const rawSteps = data.steps || data.nodes || [];
		const stepList: string[] = (Array.isArray(rawSteps) ? rawSteps : [rawSteps])
			.flatMap((s: string) => String(s).split(/\s*->\s*/).map((x: string) => x.trim()))
			.filter(Boolean);
		const steps = stepList.length ? stepList : ['No steps defined'];

		// SVG layout constants
		const SVG_W    = 480;
		const FONT_PX  = 10.5;
		const LINE_H   = 15;
		const PAD_V    = 11;
		const LABEL_H  = 14;
		const ARROW_H  = 24;
		const COL_GAP  = 30;

		// The plate is capped at ~504px of page height (DIAGRAM_SVG_MAX_H in
		// exportHtml.ts). Past that the SVG scales down, and a long single
		// column shrinks the text to ~7px — legible on screen, not in print.
		// So a long flow snakes into two columns instead, keeping every node
		// at full size. Step numbers carry the reading order down column one
		// then down column two, which is how a printed manual sets a long
		// procedure; no inter-column connector is needed (and one drawn back
		// up the page would have to cross column two's nodes).
		const MAX_NATURAL_H = 500;

		const esc = svgEsc;
		const wrapText = wrapSvgText;

		// Lay the steps out in `cols` columns and report the geometry. Narrower
		// columns wrap text harder, so heights must be recomputed per layout
		// rather than scaled from the single-column pass.
		const layOut = (cols: number) => {
			const nodeW  = (SVG_W - 20 - (cols - 1) * COL_GAP) / cols;
			const chars  = Math.max(12, Math.floor(nodeW / 8.2));
			const perCol = Math.ceil(steps.length / cols);
			const wrapped = steps.map(s => wrapText(s, chars));
			const heights = wrapped.map(l => PAD_V * 2 + LABEL_H + l.length * LINE_H);

			// Tallest column decides the diagram height
			let tallest = 0;
			for (let c = 0; c < cols; c++) {
				const slice = heights.slice(c * perCol, (c + 1) * perCol);
				if (!slice.length) continue;
				const colH = slice.reduce((a, b) => a + b, 0) + (slice.length - 1) * ARROW_H;
				tallest = Math.max(tallest, colH);
			}
			return { cols, nodeW, perCol, wrapped, heights, totalH: tallest + 40 };
		};

		let L = layOut(1);
		if (L.totalH > MAX_NATURAL_H && steps.length >= 6) {
			const two = layOut(2);
			// Only accept two columns if it actually buys height back
			if (two.totalH < L.totalH) L = two;
		}
		const totalH = L.totalH;

		let svgBody = '';
		steps.forEach((step, idx) => {
			const col     = Math.floor(idx / L.perCol);
			const rowIdx  = idx % L.perCol;
			const isLastInCol = rowIdx === L.perCol - 1 || idx === steps.length - 1;

			// y is the sum of the nodes above this one within its own column
			let y = 20;
			for (let i = col * L.perCol; i < idx; i++) y += L.heights[i] + ARROW_H;

			const x  = 10 + col * (L.nodeW + COL_GAP);
			const cx = x + L.nodeW / 2;
			const h  = L.heights[idx];

			// Node rectangle
			svgBody += `<rect x="${x}" y="${y}" width="${L.nodeW}" height="${h}"
				rx="7" ry="7" fill="#FFFFFF" stroke="${dark}" stroke-width="1.5"/>`;

			// Step label in accent colour
			svgBody += `<text x="${cx}" y="${y + PAD_V + 10}" text-anchor="middle"
				font-family="Georgia,serif" font-size="8" font-weight="700"
				fill="${accent}" letter-spacing="0.8">${esc(`STEP ${String(idx + 1).padStart(2, '0')}`)}</text>`;

			// Wrapped step text
			L.wrapped[idx].forEach((line, li) => {
				svgBody += `<text x="${cx}" y="${y + PAD_V + LABEL_H + (li + 1) * LINE_H}"
					text-anchor="middle" font-family="Georgia,serif"
					font-size="${FONT_PX}" fill="${dark}">${esc(line)}</text>`;
			});

			// Arrow down to the next node in this column
			if (!isLastInCol) {
				svgBody += `<line x1="${cx}" y1="${y + h + 2}" x2="${cx}" y2="${y + h + ARROW_H - 6}"
					stroke="${accent}" stroke-width="1.5" marker-end="url(#fc-arrow)"/>`;
			}
		});

		body = `
			<svg viewBox="0 0 ${SVG_W} ${totalH}" preserveAspectRatio="xMidYMid meet"
				xmlns="http://www.w3.org/2000/svg" class="diagram-svg"
				style="display:block;margin:0 auto;width:100%;height:auto;max-width:${SVG_W}px;">
				<defs>
					<marker id="fc-arrow" markerWidth="8" markerHeight="6"
						refX="7" refY="3" orient="auto">
						<path d="M0,0 L8,3 L0,6 Z" fill="${accent}"/>
					</marker>
				</defs>
				${svgBody}
			</svg>
		`;
	}

	// 7. HIERARCHY / MIND MAP / ORG CHART / TREE / CONCEPT / USE CASE / CLASS
	else if (type.includes('mindmap') || type.includes('hierarchy') || type.includes('orgchart') || type.includes('tree') || type.includes('concept') || type.includes('classdiagram') || type.includes('usecase') || type.includes('taxonomy')) {
		const dark   = data.color1 || DIAGRAM_NAVY;
		const accent = data.color2 || DIAGRAM_AMBER;
		const root   = data.root || data.title || 'Hierarchy';

		const rawNodes = data.nodes || data.steps || [];
		const nodeList: string[] = (Array.isArray(rawNodes) ? rawNodes : [rawNodes])
			.flatMap((s: string) => String(s).split(/\s*,\s*/).map((x: string) => x.trim()))
			.filter(Boolean);

		// Indented spine layout: root at top-left, a single spine dropping down
		// its left edge, and one elbow branching right into each child stacked
		// vertically.
		//
		// This replaces a bus-over-a-grid, which could not express a flat list
		// of more than COLS siblings: every child hung off one bus, so a child
		// in row 2 needed a drop line that ran from the bus straight down THROUGH
		// the nodes in row 0 and 1. A spine has no such crossing at any length,
		// and children wrap their text instead of being truncated to 20 chars.
		const SVG_W    = 480;
		const ROOT_X   = 16;
		const ROOT_Y   = 16;
		const ROOT_H   = 40;
		const ROOT_W   = Math.min(260, SVG_W - 32);
		const SPINE_X  = ROOT_X + 26;          // drops from inside the root's left
		const CHILD_X  = SPINE_X + 22;         // elbow lands here
		const CHILD_W  = SVG_W - CHILD_X - 16;
		const CHILD_PAD_V = 8;
		const CHILD_LINE_H = 13;
		const CHILD_GAP = 10;
		const CHILD_CHARS = Math.max(12, Math.floor((CHILD_W - 20) / 5.4));

		const wrapped = nodeList.map(n => wrapSvgText(n, CHILD_CHARS));
		const heights = wrapped.map(l => CHILD_PAD_V * 2 + l.length * CHILD_LINE_H);

		// Root box
		let svgBody = `
			<rect x="${ROOT_X}" y="${ROOT_Y}" width="${ROOT_W}" height="${ROOT_H}"
				rx="8" ry="8" fill="${dark}"/>
			<text x="${ROOT_X + ROOT_W / 2}" y="${ROOT_Y + ROOT_H / 2 + 4}" text-anchor="middle"
				font-family="Georgia,serif" font-size="11" font-weight="700"
				fill="#FFFFFF">${svgEsc(root)}</text>
		`;

		// Children, stacked; remember each one's centre for the elbows
		let cy = ROOT_Y + ROOT_H + 16;
		const centres: number[] = [];
		nodeList.forEach((node, idx) => {
			const h = heights[idx];
			const centre = cy + h / 2;
			centres.push(centre);

			// Elbow: spine → child
			svgBody += `<line x1="${SPINE_X}" y1="${centre}" x2="${CHILD_X}" y2="${centre}"
				stroke="${accent}" stroke-width="1.5"/>`;

			svgBody += `<rect x="${CHILD_X}" y="${cy}" width="${CHILD_W}" height="${h}"
				rx="6" ry="6" fill="#FFFFFF" stroke="${dark}" stroke-width="1.2"/>`;

			wrapped[idx].forEach((line, li) => {
				svgBody += `<text x="${CHILD_X + CHILD_W / 2}"
					y="${cy + CHILD_PAD_V + (li + 1) * CHILD_LINE_H - 3}" text-anchor="middle"
					font-family="Georgia,serif" font-size="9.5" fill="${dark}">${svgEsc(line)}</text>`;
			});

			cy += h + CHILD_GAP;
		});

		// Spine last so it sits under nothing it shouldn't: root bottom down to
		// the final child's centre, stopping there rather than overshooting.
		if (centres.length) {
			svgBody = `<line x1="${SPINE_X}" y1="${ROOT_Y + ROOT_H}" x2="${SPINE_X}"
				y2="${centres[centres.length - 1]}" stroke="${accent}" stroke-width="1.5"/>` + svgBody;
		}

		const totalH = cy - CHILD_GAP + 16;

		body = `
			<svg viewBox="0 0 ${SVG_W} ${totalH}" preserveAspectRatio="xMidYMid meet"
				xmlns="http://www.w3.org/2000/svg" class="diagram-svg"
				style="display:block;margin:0 auto;width:100%;height:auto;max-width:${SVG_W}px;">
				${svgBody}
			</svg>
		`;
	}

	// 8. BLUEPRINT / ARCHITECTURAL / FLOOR PLAN / SITE MAP / SITE / NETWORK / CIRCUIT / P&ID
	else if (type.includes('blueprint') || type.includes('floorplan') || type.includes('network') || type.includes('circuit') || type.includes('pid') || type.includes('sitemap') || type.includes('spatial') || type.includes('heat') || type.includes('radar') || type.includes('spider') || type.includes('pareto') || type.includes('scatter') || type.includes('bubble') || type.includes('cartesian') || type.includes('linegraph') || type.includes('sparkline') || type.includes('histogram') || type.includes('box') || type.includes('qqplot') || type.includes('freebody') || type.includes('lewis') || type.includes('phase') || type.includes('molecular') || type.includes('scorecard') || type.includes('canvas') || type.includes('matrix')) {
		const c1 = data.color1 || '#2563EB'; // primary color (e.g. background blue or circles blue)
		const c2 = data.color2 || '#1D4ED8'; // secondary border line color

		const gridDots = `<defs><pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M 16 0 L 0 0 0 16" fill="none" stroke="${c2}" stroke-width="0.3" opacity="0.35"/></pattern></defs><rect width="100%" height="100%" fill="url(#grid)" />`;
		const nodes = data.labels && data.labels.length ? data.labels : (data.nodes || []);
		const nodeList = Array.isArray(nodes) ? nodes : [nodes];

		const elements = nodeList.map((n, idx) => {
			const x = 40 + (idx % 3) * 65;
			const y = 45 + Math.floor(idx / 3) * 50;
			return `
				<circle cx="${x}" cy="${y}" r="15" fill="${c1}" opacity="0.85" />
				<circle cx="${x}" cy="${y}" r="15" fill="none" stroke="#fff" stroke-width="1.2" />
				<text x="${x}" y="${y + 2.5}" text-anchor="middle" fill="#fff" font-size="6" font-family="monospace" font-weight="bold">${n.slice(0, 10)}</text>
				${idx > 0 && idx % 3 !== 0 ? `<line x1="${x - 50}" y1="${y}" x2="${x - 15}" y2="${y}" stroke="#fff" stroke-width="1.2" stroke-dasharray="2,2" />` : ''}
			`;
		}).join('');

		body = `
			<div style="background-color: ${c1}; border-radius: 6px; padding: 0.5rem; border: 1.5px solid ${c2}; box-shadow: inset 0 2px 4px rgba(0,0,0,0.3); display: flex; justify-content: center; align-items: center; width: 100%; box-sizing: border-box;">
				<svg width="100%" height="160" style="max-width: 480px;">
					${gridDots}
					<text x="15" y="20" fill="#fff" font-size="7" font-family="monospace" opacity="0.95">// SYSTEM DIAGRAM: ${title.toUpperCase()}</text>
					${elements}
				</svg>
			</div>
		`;
	}

	// 9. GENERAL CARD-BASED ELEMENT (Fallback)
	else {
		const steps = data.labels && data.labels.length ? data.labels : (data.nodes || []);
		const stepList = Array.isArray(steps) ? steps : [steps];
		const listHtml = stepList.map(s => `<li>${s}</li>`).join('');
		const c1 = data.color1 || 'var(--r-accent, #C9A84C)';

		body = `
			<div style="border-left: 4.5px solid ${c1}; padding: 0.5rem 0.75rem; background-color: var(--r-table-stripe); border-radius: 4px; width: 100%; box-sizing: border-box;">
				<h5 style="margin: 0 0 0.4rem 0; color: var(--r-title-color); font-size: 0.85rem; font-weight: bold;">${title}</h5>
				<ul style="margin: 0; padding-left: 1.2rem; font-size: 0.8rem; list-style-type: square;">${listHtml}</ul>
			</div>
		`;
	}

	const html = `
		<div class="diagram-box diagram-box--fullpage">
			<div class="diagram-box__actions">
				<button class="edit-trigger edit-trigger--diagram" data-chapter-id="${chapterId}" data-diagram-index="${diagramIndex}" title="Edit this diagram" aria-label="Edit diagram">
					<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg> Edit
				</button>
			</div>
			<div class="diagram-box__header">
				<div class="diagram-box__title">${title}</div>
				${subtitle ? `<div class="diagram-box__subtitle">${subtitle}</div>` : ''}
			</div>
			<div class="diagram-box__body">
				${body}
			</div>
			${renderPlateFooter(bookMeta)}
		</div>
	`;

	const placeholder = `\x02RAWBLOCK${rawBlocksLength}\x03`;
	rawBlocks.push(html);
	return placeholder;
}

/**
 * Footer band closing a plate: book title left, author right. Renders nothing
 * when neither is known, so a plate never shows an empty band.
 */
function renderPlateFooter(bookMeta: BookMeta): string {
	const title  = bookMeta.title?.trim() ?? '';
	const author = bookMeta.author?.trim() ?? '';
	if (!title && !author) return '';
	return `<div class="diagram-box__footer">` +
		`<span class="diagram-box__footer-book">${svgEsc(title)}</span>` +
		`<span class="diagram-box__footer-author">${svgEsc(author)}</span>` +
		`</div>`;
}

/**
 * Bring an image plate stored by an earlier edit drawer up to current chrome.
 *
 * The drawer splices RENDERED HTML into chapter.content rather than markdown,
 * so an image written before a chrome change stays frozen at that old markup —
 * no navy header bar, plus a figcaption the bar has since replaced. Fixing the
 * drawer only helps new writes; this repairs what is already stored, at render
 * time, so every image matches the diagram plates.
 */
function normaliseStoredImagePlate(html: string, chapterId: string, bookMeta: BookMeta): string {
	if (!html.includes('diagram-box--image')) return html;
	if (html.includes('diagram-box__header')) return html; // already current

	const src = html.match(/<img[^>]*\ssrc="([^"]+)"/i)?.[1] ?? '';
	const alt = html.match(/<img[^>]*\salt="([^"]*)"/i)?.[1] ?? '';
	if (!src || !alt) return html; // no image, or nothing to title the bar with

	// Rebuild rather than patch a bar onto the old markup. The stored HTML
	// carries frozen inline styles (figure margins, img max-width) that the
	// current stylesheet cannot override, so a patched block keeps the old
	// geometry — flush to the plate edge, no cream inset, no photo frame.
	// Rebuilding drops those inline styles and lets the CSS govern, which is
	// what makes it match a plate rendered from markdown today.
	//
	// This does discard per-image border/radius the drawer may have written.
	// That is the deliberate trade: consistency with the house plate over
	// preserving styling frozen against a chrome that no longer exists.
	const idx = html.match(/data-table-index="(\d+)"/)?.[1] ?? '0';
	const raw = html.match(/data-table-raw="([^"]*)"/)?.[1]
		?? encodeURIComponent(`![${alt}](${src})`);

	const editBtn =
		`<button class="edit-trigger edit-trigger--diagram edit-trigger--inline" ` +
		`data-chapter-id="${chapterId}" data-table-index="${idx}" data-table-raw="${raw}" ` +
		`title="Regenerate or edit this image" aria-label="Edit image">${PLATE_EDIT_ICON} Edit</button>`;

	return `<div class="${FULLPAGE_IMAGE_CLASSES}">` +
		`<div class="diagram-box__actions">${editBtn}</div>` +
		`<div class="diagram-box__header"><div class="diagram-box__title">${alt}</div></div>` +
		`<figure><img src="${src}" alt="${alt}" loading="lazy" /></figure>` +
		`${renderPlateFooter(bookMeta)}` +
		`</div>`;
}

const PLATE_EDIT_ICON =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';

/**
 * The image of a plate, plus its callout labels.
 *
 * The picture carries no text — an image model cannot spell, so anything it
 * letters arrives as convincing gibberish. The labels therefore live in the
 * fence as data and are set here in real type, which is the only way they are
 * correct. `callouts` is a JSON array: [{text,x,y,side}], where x/y are
 * percentages of the IMAGE.
 *
 * `.illust-frame` shrink-wraps the image on purpose. The figure is a centred
 * flex box and the image inside is bounded by max-width/max-height, so it is
 * usually NARROWER than the figure — positioning a callout at "50%" of the
 * figure would not put it at 50% of the picture. Percentages only mean what the
 * labels intend when their containing block is the rendered image box itself.
 */
function renderPlateImage(image: string, title: string, calloutsRaw: unknown): string {
	const img = `<img src="${image}" alt="${svgEsc(title)}" loading="lazy" />`;

	let callouts: any[] = [];
	if (typeof calloutsRaw === 'string' && calloutsRaw.trim()) {
		try {
			const parsed = JSON.parse(calloutsRaw);
			if (Array.isArray(parsed)) callouts = parsed;
		} catch {
			// A malformed callout list is a plate with no labels, never a broken
			// plate: the picture is the thing worth keeping.
			console.error('Failed to parse plate callouts:', calloutsRaw);
		}
	}

	const valid = callouts.filter(
		c => c && typeof c.text === 'string' && c.text.trim() &&
		     Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y)) &&
		     Number(c.x) >= 0 && Number(c.x) <= 100 &&
		     Number(c.y) >= 0 && Number(c.y) <= 100
	);

	if (!valid.length) return img;

	const marks = valid
		.map(c =>
			`<span class="illust-callout illust-callout--${c.side === 'left' ? 'left' : 'right'}" ` +
			`style="left:${Number(c.x)}%;top:${Number(c.y)}%;">` +
			`<span class="illust-callout__dot"></span>` +
			`<span class="illust-callout__line"></span>` +
			`<span class="illust-callout__text">${svgEsc(String(c.text))}</span>` +
			`</span>`
		)
		.join('');

	return `<span class="illust-frame">${img}${marks}</span>`;
}

/**
 * Full-page image plate — the house figure format.
 *
 * Renders like a plate in a printed manual: a navy header bar carrying the
 * title and subtitle, the image filling the cream field beneath it, and an
 * optional takeaway box closing the page.
 *
 * The wrapper must carry `diagram-box--image--fullpage` and contain a <figure>:
 * that pair is what exportHtml's paginator keys on to hand the block a whole
 * page (it assigns BODY_H rather than measuring, and flushes around it).
 */
function renderPlate(
	data: DiagramData,
	rawBlocks: string[],
	chapterId: string,
	visualBlockIndex: number,
	bookMeta: BookMeta = {}
): string {
	const title    = data.title || '';
	const subtitle = data.subtitle || '';
	const image    = data.image || data.url || '';
	const takeaway = data.takeaway || '';
	const takeawayTitle = data.takeawaytitle || 'Reader takeaway';

	if (!image) {
		return `<div class="diagram-error">Plate${title ? ` "${title}"` : ''} is missing an "image:" URL.</div>`;
	}

	const editBtn =
		`<button class="edit-trigger edit-trigger--diagram" data-chapter-id="${chapterId}" ` +
		`data-diagram-index="${visualBlockIndex}" title="Edit this plate" aria-label="Edit plate">` +
		`${PLATE_EDIT_ICON} Edit</button>`;

	const header = title || subtitle
		? `<div class="diagram-box__header">` +
		  (title ? `<div class="diagram-box__title">${title}</div>` : '') +
		  (subtitle ? `<div class="diagram-box__subtitle">${subtitle}</div>` : '') +
		  `</div>`
		: '';

	const takeawayHtml = takeaway
		? `<div class="plate-takeaway">` +
		  `<div class="plate-takeaway__title">${takeawayTitle}</div>` +
		  `<p class="plate-takeaway__body">${takeaway}</p>` +
		  `</div>`
		: '';

	const html =
		`<div class="${FULLPAGE_IMAGE_CLASSES} diagram-box--plate">` +
		`<div class="diagram-box__actions">${editBtn}</div>` +
		`${header}` +
		`<figure>${renderPlateImage(image, title, data.callouts)}</figure>` +
		`${takeawayHtml}` +
		`${renderPlateFooter(bookMeta)}` +
		`</div>`;

	const placeholder = `\x02RAWBLOCK${rawBlocks.length}\x03`;
	rawBlocks.push(html);
	return placeholder;
}

export function parseMarkdown(md: string, chapterId: string = '', bookMeta: BookMeta = {}): string {
	if (!md) return '<p>No content written for this chapter yet.</p>';

	let src = md.trim();

	// ── Step 1: extract raw HTML blocks so we don't escape them ───────────
	const rawBlocks: string[] = [];
	let diagramCounter = 0;
	// Unified counter for all editable visual blocks (diagrams, tables, inline HTML elements).
	// Passed as data-diagram-index so the edit drawer identifies which block to splice.
	let visualBlockCounter = 0;

	// Balance tags dynamically to correctly extract nested elements like divs and tables
	while (true) {
		const divMatch = src.match(/<(div|table|thead|tbody|tr|th|td|figure)[\s>]/i);
		if (!divMatch || divMatch.index === undefined) break;

		const tag = divMatch[1].toLowerCase();
		const startIdx = divMatch.index;

		let depth = 0;
		let endIdx = -1;

		const tagRegex = new RegExp(`<\\/?${tag}[\\s>]`, 'gi');
		tagRegex.lastIndex = startIdx;

		let match;
		while ((match = tagRegex.exec(src)) !== null) {
			const matchedTag = match[0].toLowerCase();
			if (matchedTag.startsWith('</')) {
				depth--;
			} else {
				depth++;
			}

			if (depth === 0) {
				endIdx = tagRegex.lastIndex;
				break;
			}
		}

		if (endIdx === -1 && depth > 0) {
			// Tag is unbalanced (e.g. AI forgot to close it or text split cut it off).
			// Auto-close it to prevent it from being escaped as raw text.
			let suffix = '';
			for (let d = 0; d < depth; d++) {
				suffix += `</${tag}>`;
			}
			const fullBlock = src.substring(startIdx) + suffix;
			const placeholder = `\x02RAWBLOCK${rawBlocks.length}\x03`;
			rawBlocks.push(fullBlock);
			src = src.substring(0, startIdx) + placeholder;
		} else if (endIdx !== -1) {
			const fullBlock = src.substring(startIdx, endIdx);
			const placeholder = `\x02RAWBLOCK${rawBlocks.length}\x03`;
			rawBlocks.push(fullBlock);
			src = src.substring(0, startIdx) + placeholder + src.substring(endIdx);
		} else {
			// Prevent infinite loop if tag is completely unbalanced
			src = src.substring(0, startIdx) + '\x01' + src.substring(startIdx + 1);
		}
	}

	// Restore any temporarily renamed brackets
	src = src.replace(/\x01/g, '<');

	// Image plates spliced into content by the edit drawer are stored as
	// rendered HTML, so they are frozen at the chrome of whenever they were
	// written. Repair them here rather than leaving old books stranded.
	for (let i = 0; i < rawBlocks.length; i++) {
		rawBlocks[i] = normaliseStoredImagePlate(rawBlocks[i], chapterId, bookMeta);
	}

	// ── Step 1.45: Parse full-page image plates before escaping ─────────────
	// The extended image form: carries a title, subtitle and takeaway that a
	// bare ![alt](url) has nowhere to put. Runs before the image extractor in
	// Step 1.6 so a plate's image: line is never mistaken for a loose image.
	const plateRegex = /```plate\r?\n([\s\S]*?)```/g;
	src = src.replace(plateRegex, (_match, blockContent) => {
		try {
			const parsed = parseDiagramLines(blockContent);
			const html = renderPlate(parsed, rawBlocks, chapterId, visualBlockCounter, bookMeta);
			visualBlockCounter++;
			return html;
		} catch (err) {
			console.error('Failed to render plate:', err);
			return `<div class="diagram-error">Failed to render plate: ${(err as Error).message}</div>`;
		}
	});

	// ── Step 1.5: Parse custom diagram blocks before escaping ───────────────
	const blockRegex = /```(?:diagram|mermaid)\r?\n([\s\S]*?)```/g;
	src = src.replace(blockRegex, (match, blockContent) => {
		try {
			const parsed = parseDiagramLines(blockContent);
			const html = renderDiagram(parsed, rawBlocks.length, rawBlocks, chapterId, visualBlockCounter, bookMeta);
			diagramCounter++;
			visualBlockCounter++;
			return html;
		} catch (err) {
			console.error('Failed to render diagram:', err);
			return `<div class="diagram-error">Failed to render diagram: ${(err as Error).message}</div>`;
		}
	});

	// ── Step 1.6: Extract markdown images before escaping ──────────────────
	// AI-generated realistic images are written as ![alt](url). If we let them
	// hit Step 2 the `!`, `[`, `(` characters get HTML-escaped and they render
	// as raw text instead of <img> tags. We pull them out as raw blocks here so
	// they survive escaping intact and display correctly in the reader / PDF.
	//
	// Every image renders as a full-page plate: the alt text is promoted into
	// the navy header bar and the image fills the cream field below, matching
	// the ```plate form minus the subtitle and takeaway it has no room for.
	// Note this applies to an image written mid-sentence too — it will break
	// its paragraph onto a page of its own. Use ```plate for authored figures.
	src = src.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (_fullMatch, alt, url) => {
		// data-table-index/-raw keep the edit drawer's image path working: it
		// splices the original ![alt](url) out of the markdown source.
		const editBtn = `<button class="edit-trigger edit-trigger--diagram edit-trigger--inline" data-chapter-id="${chapterId}" data-table-index="${visualBlockCounter}" data-table-raw="${encodeURIComponent(`![${alt}](${url})`)}" title="Regenerate or edit this image" aria-label="Edit image">${PLATE_EDIT_ICON} Edit</button>`;
		const header = alt
			? `<div class="diagram-box__header"><div class="diagram-box__title">${alt}</div></div>`
			: '';
		const figHtml = `<div class="${FULLPAGE_IMAGE_CLASSES}"><div class="diagram-box__actions">${editBtn}</div>${header}<figure><img src="${url}" alt="${alt}" loading="lazy" /></figure>${renderPlateFooter(bookMeta)}</div>`;
		visualBlockCounter++;
		const placeholder = `\x02RAWBLOCK${rawBlocks.length}\x03`;
		rawBlocks.push(figHtml);
		return placeholder;
	});

	// ── Step 2: escape remaining text so inline HTML isn't injected ────────
	let html = src
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');

	// ── Step 3: standard markdown → HTML conversion ─────────────────────
	// Headings (descending so #### is matched before ###)
	html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
	html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
	html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
	html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
	html = html.replace(/^\> (.*?)$/gm, '<blockquote>$1</blockquote>');
	html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
	html = html.replace(/^\* (.*?)$/gm, '<li>$1</li>');
	html = html.replace(/^- (.*?)$/gm, '<li>$1</li>');

	// Numbered lists: "1. item"
	html = html.replace(/^\d+\.\s+(.*?)$/gm, '<li>$1</li>');

	// ── Step 3b: Parse markdown tables ──────────────────────────────
	const lines = html.split('\n');
	const processedLines: string[] = [];
	let inTable = false;
	let tableHeaders: string[] = [];
	let tableRows: string[][] = [];
	let tableAlignments: ('left' | 'center' | 'right' | null)[] = [];
	let tableCounter = 0;

	function renderHtmlTable(headers: string[], rows: string[][], alignments: any[], tableIndex: number): string {
		const maxColumnsPerSegment = 5;
		const columnCount = headers.length;
		const isWideTable = columnCount > maxColumnsPerSegment;

		// Raw markdown for this table — passed back to the edit API for AI rewrites
		const rawHeader = `| ${headers.join(' | ')} |`;
		const rawSeparator = `| ${alignments.map((align) => {
			if (align === 'left') return ':---';
			if (align === 'center') return ':---:';
			if (align === 'right') return '---:';
			return '---';
		}).join(' | ')} |`;
		const rawRows = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
		const rawTable = [rawHeader, rawSeparator, rawRows].filter(Boolean).join('\n');
		const encodedRaw = encodeURIComponent(rawTable);

		// Snapshot the visual-block index for this specific table
		const thisBlockIndex = visualBlockCounter;
		visualBlockCounter++;

		function buildTableSegment(startIndex: number, endIndex: number, segmentLabel?: string): string {
			const segmentHeaders = headers.slice(startIndex, endIndex);
			const segmentAlignments = alignments.slice(startIndex, endIndex);

			const ths = segmentHeaders.map((h, idx) => {
				const align = segmentAlignments[idx] ? ` align="${segmentAlignments[idx]}"` : '';
				const cleanH = h
					.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
					.replace(/\*(.*?)\*/g, '<em>$1</em>');
				return `<th${align}>${cleanH}</th>`;
			}).join('');

			const trs = rows.map(r => {
				const segmentCells = r.slice(startIndex, endIndex);
				const tds = segmentCells.map((cell, idx) => {
					const align = segmentAlignments[idx] ? ` align="${segmentAlignments[idx]}"` : '';
					const cleanCell = cell
						.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
						.replace(/\*(.*?)\*/g, '<em>$1</em>');
					return `<td${align}>${cleanCell}</td>`;
				}).join('');
				return `<tr>${tds}</tr>`;
			}).join('');

			const isFirst = startIndex === 0;
			return `
				<div class="diagram-box diagram-box--table${isWideTable ? ' diagram-box--table--wide' : ''}${segmentLabel ? ' diagram-box--table--continued' : ''}" data-column-count="${segmentHeaders.length}"${segmentLabel ? ` data-segment-label="${segmentLabel}"` : ''}>
					${isFirst ? `<div class="diagram-box__actions"><button class="edit-trigger edit-trigger--diagram" data-chapter-id="${chapterId}" data-table-index="${thisBlockIndex}" data-table-raw="${encodedRaw}" title="Edit this table" aria-label="Edit table"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg> Edit</button></div>` : ''}
					<div class="table-container">
						<table>
							<thead><tr>${ths}</tr></thead>
							<tbody>${trs}</tbody>
						</table>
					</div>
				</div>`;
		}

		const tableHtml = isWideTable
			? Array.from({ length: Math.ceil(columnCount / maxColumnsPerSegment) }, (_, segmentIndex) => {
				const startIndex = segmentIndex * maxColumnsPerSegment;
				const endIndex = Math.min(startIndex + maxColumnsPerSegment, columnCount);
				return buildTableSegment(
					startIndex,
					endIndex,
					segmentIndex === 0 ? undefined : `continued-${segmentIndex + 1}`
				);
			}).join('\n')
			: buildTableSegment(0, columnCount);
		const placeholder = `\x02RAWBLOCK${rawBlocks.length}\x03`;
		rawBlocks.push(tableHtml);
		return placeholder;
	}

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		if (line.startsWith('|') && line.endsWith('|')) {
			const cells = line.slice(1, -1).split('|').map(c => c.trim());

			if (!inTable) {
				const nextLine = lines[i + 1]?.trim() || '';
				if (nextLine.startsWith('|') && nextLine.endsWith('|') && nextLine.replace(/[\s|:\-]/g, '') === '') {
					inTable = true;
					tableHeaders = cells;

					const delims = nextLine.slice(1, -1).split('|').map(c => c.trim());
					tableAlignments = delims.map(d => {
						const left = d.startsWith(':');
						const right = d.endsWith(':');
						if (left && right) return 'center';
						if (right) return 'right';
						if (left) return 'left';
						return null;
					});

					tableRows = [];
					i++; // Skip the delimiter row
					continue;
				}
			} else {
				tableRows.push(cells);
				continue;
			}
		}

		if (inTable && (!line.startsWith('|') || !line.endsWith('|'))) {
			inTable = false;
			processedLines.push(renderHtmlTable(tableHeaders, tableRows, tableAlignments, tableCounter++));
		}

		processedLines.push(lines[i]);
	}

	if (inTable) {
		processedLines.push(renderHtmlTable(tableHeaders, tableRows, tableAlignments, tableCounter++));
	}

	html = processedLines.join('\n');

	// Paragraph wrap — skip if line already contains a block element or placeholder
	const paragraphs = html.split('\n\n');
	html = paragraphs.map((p) => {
		const trimmed = p.trim();
		if (!trimmed) return '';
		if (
			trimmed.startsWith('<h') ||
			trimmed.startsWith('<blockquote') ||
			trimmed.startsWith('<li') ||
			trimmed.startsWith('\x02RAWBLOCK')
		) return trimmed;
		return `<p>${trimmed}</p>`;
	}).join('\n');

	// Merge consecutive <li> into a single <ul>
	html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
	html = html.replace(/<\/ul>\s*<ul>/g, '');

	// ── Step 4: restore raw HTML blocks, injecting edit overlays on visual elements ──
	// Callout boxes, stat blocks, checklists, and pro-con grids are written as raw HTML
	// by the AI. We detect them by class name and inject a standardised edit button
	// directly inside the first opening <div> of each matched block.
	const INLINE_VISUAL_RE = /class="[^"]*\b(callout-box|stat-block|checklist-box|pro-con-grid|quote-box|tip-box|warning-box|key-takeaway)\b/i;
	let inlineVisualIndex = 0;
	html = html.replace(/\x02RAWBLOCK(\d+)\x03/g, (_, i) => {
		const block = rawBlocks[parseInt(i)];
		if (INLINE_VISUAL_RE.test(block)) {
			const idx = inlineVisualIndex++;
			const encodedBlock = encodeURIComponent(block);
			const btn = `<button class="edit-trigger edit-trigger--diagram edit-trigger--inline" data-chapter-id="${chapterId}" data-table-index="${idx}" data-table-raw="${encodedBlock}" title="Edit this element" aria-label="Edit visual element"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg> Edit</button>`;
			// Insert the button immediately after the first opening <div ...>
			return block.replace(/(<div\b[^>]*>)/, `$1${btn}`);
		}
		return block;
	});

	return html;
}
