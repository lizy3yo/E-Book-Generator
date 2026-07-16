/**
 * Unified Markdown and Diagrams parser for the E-Book Generator.
 * Converts headings, bold/italic markup, lists, and markdown tables into clean, responsive HTML.
 * Balances HTML blocks recursively to preserve structured layouts like stat blocks, diagrams, and charts.
 * 
 * Supports rendering 45+ industry-standard diagram types (Pie, Bar, SWOT, Flowcharts, Hierarchies, Blueprints, Venns, and more).
 */

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
	diagramIndex: number = 0
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
		const steps = data.steps || data.nodes || [];
		const stepList = Array.isArray(steps) ? steps : [steps];
		const c1 = data.color1 || 'var(--r-accent, #C9A84C)';

		const htmlSteps = stepList.map((step, idx) => {
			const arrow = idx < stepList.length - 1 ? `<div style="font-size: 1.25rem; color: ${c1}; margin: 0.25rem 0.5rem; text-align: center; align-self: center;">➔</div>` : '';
			return `
				<div style="display: flex; flex-direction: column; align-items: center; margin-bottom: 0.5rem;">
					<div style="background-color: var(--r-table-stripe, #f8fafc); border: 1.5px solid var(--r-border, #cbd5e1); border-radius: 6px; padding: 0.5rem 0.75rem; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05); min-width: 110px;">
						<span style="font-size: 0.65rem; font-weight: bold; color: ${c1}; display: block; text-transform: uppercase;">Step 0${idx + 1}</span>
						<span style="font-size: 0.8rem; font-weight: 600; color: var(--r-title-color);">${step}</span>
					</div>
				</div>
				${arrow}
			`;
		}).join('');

		body = `
			<div style="display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 0.5rem; padding: 0.5rem 0; width: 100%;">
				${htmlSteps}
			</div>
		`;
	}

	// 7. HIERARCHY / MIND MAP / ORG CHART / TREE / CONCEPT / USE CASE / CLASS
	else if (type.includes('mindmap') || type.includes('hierarchy') || type.includes('orgchart') || type.includes('tree') || type.includes('concept') || type.includes('classdiagram') || type.includes('usecase') || type.includes('taxonomy')) {
		const nodes = data.nodes || data.steps || [];
		const nodeList = Array.isArray(nodes) ? nodes : [nodes];
		const root = data.root || data.title || 'Hierarchy';
		const c1 = data.color1 || 'var(--r-title-color, #1E293B)';
		const c2 = data.color2 || 'var(--r-accent, #C9A84C)';

		const children = nodeList.map((n) => {
			return `<div style="background-color: #fff; border: 1px solid var(--r-border); border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 0.75rem; color: var(--r-text); text-align: center; box-shadow: 0 1px 2px rgba(0,0,0,0.05); min-width: 85px;">${n}</div>`;
		}).join('');

		body = `
			<div style="display: flex; flex-direction: column; align-items: center; gap: 0.75rem; padding: 0.5rem 0; width: 100%;">
				<!-- Root node -->
				<div style="background: linear-gradient(135deg, ${c1} 0%, ${c2} 100%); color: #fff; border-radius: 6px; padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: bold; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.08);">
					${root}
				</div>
				<!-- Connective line -->
				<div style="width: 2px; height: 12px; background-color: ${c2};"></div>
				<!-- Children nodes grid -->
				<div style="display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap; width: 100%;">
					${children}
				</div>
			</div>
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
		<div class="diagram-box">
			<div class="diagram-box__actions">
				<button class="edit-trigger edit-trigger--diagram" data-chapter-id="${chapterId}" data-diagram-index="${diagramIndex}" title="Edit this diagram" aria-label="Edit diagram">
					<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pen-line"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg> Edit
				</button>
			</div>
			<div class="diagram-box__title" style="color: var(--r-title-color); font-weight: bold; border-bottom: 1.5px solid var(--r-accent, #C9A84C); padding-bottom: 0.3rem; margin-bottom: 0.6rem; font-size: 0.95rem;">📊 ${title}</div>
			${subtitle ? `<div class="diagram-box__subtitle" style="font-size: 0.75rem; color: var(--r-text-muted); margin-top: -0.4rem; margin-bottom: 0.6rem;">${subtitle}</div>` : ''}
			<div style="display: flex; justify-content: center; width: 100%; box-sizing: border-box;">
				${body}
			</div>
		</div>
	`;

	const placeholder = `\x02RAWBLOCK${rawBlocksLength}\x03`;
	rawBlocks.push(html);
	return placeholder;
}

export function parseMarkdown(md: string, chapterId: string = ''): string {
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

	// ── Step 1.5: Parse custom diagram blocks before escaping ───────────────
	const blockRegex = /```(?:diagram|mermaid)\r?\n([\s\S]*?)```/g;
	src = src.replace(blockRegex, (match, blockContent) => {
		try {
			const parsed = parseDiagramLines(blockContent);
			const html = renderDiagram(parsed, rawBlocks.length, rawBlocks, chapterId, visualBlockCounter);
			diagramCounter++;
			visualBlockCounter++;
			return html;
		} catch (err) {
			console.error('Failed to render diagram:', err);
			return `<div class="diagram-error">Failed to render diagram: ${(err as Error).message}</div>`;
		}
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
