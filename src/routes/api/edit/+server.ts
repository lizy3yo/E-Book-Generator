import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { CLAUDE_WRITING_MODEL, CLAUDE_OPUS_MODEL, ANTHROPIC_API_KEY } from '$env/static/private';

const VISUAL_DIRECTIVES = `
VISUAL ELEMENTS & LAYOUT DIRECTIVES — Use the RIGHT element for each content type:
1. TABLES: For comparisons, checklists, lookup data — use markdown tables.
2. TYPED CALLOUTS — pick the matching type:
   <div class="tip-box"><span class="callout-box__title">💡 PRO TIP</span><div class="callout-box__content">Advice here.</div></div>
   <div class="warning-box"><span class="callout-box__title">⚠️ IMPORTANT WARNING</span><div class="callout-box__content">Risk here.</div></div>
   <div class="key-rule-box"><span class="callout-box__title">📌 KEY RULE</span><div class="callout-box__content">Principle here.</div></div>
   <div class="callout-box"><span class="callout-box__title">KEY INSIGHT</span><div class="callout-box__content">Content here.</div></div>
3. STAT BLOCKS (use before paragraphs with key metrics/numbers):
   <div class="stat-block"><div class="stat-block__item"><div class="stat-block__num">75%</div><div class="stat-block__label">Stat label</div></div><div class="stat-block__item"><div class="stat-block__num">$1,200</div><div class="stat-block__label">Another metric</div></div></div>
4. BAR CHARTS (3–8 items being compared by magnitude):
   <div class="chart-bar"><div class="chart-bar__title">Chart Title</div><div class="chart-bar__row"><div class="chart-bar__label">Item A</div><div class="chart-bar__track"><div class="chart-bar__fill" style="width:80%">$8,000</div></div></div><div class="chart-bar__row"><div class="chart-bar__label">Item B</div><div class="chart-bar__track"><div class="chart-bar__fill" style="width:50%">$5,000</div></div></div></div>
5. PRO/CON GRIDS (comparing two sides):
   <div class="pro-con-grid"><div class="pro-grid__col pro-grid__col--pro"><div class="pro-grid__header">✅ Pros</div><div class="pro-grid__item">Benefit one</div></div><div class="pro-grid__col pro-grid__col--con"><div class="pro-grid__header">❌ Cons</div><div class="pro-grid__item">Drawback one</div></div></div>
6. CHECKLISTS (step-by-step actions):
   <div class="checklist-box"><div class="checklist-box__title">Action Checklist</div><div class="checklist-box__item"><span class="checklist-box__num">01</span><span>Step one</span></div><div class="checklist-box__item"><span class="checklist-box__num">02</span><span>Step two</span></div></div>
7. CUSTOM DIAGRAMS & CHARTS: For complex charts and diagrams, use this exact code block format:
   \`\`\`diagram
   type: [Choose from: SWOT Diagram, Balanced Scorecard, Business Model Canvas, Venn Diagram, Mind Map, Concept Map, Network Diagram, Flowchart, Swimlane Diagram, Sankey Diagram, Workflow Diagram, Data Flow Diagram (DFD), Tree Diagram / Dendrogram, Organizational Chart, Pyramid Diagram, Taxonomy Chart, Pie Chart / Donut Chart, Bar Chart / Column Chart, Line Graph / Sparkline, Scatter Plot / Bubble Chart, Cartesian Graph, Timeline / Gantt Chart, Matrix Diagram, Radar Chart (Spider Chart), Pareto Chart, Floor Plan, Blueprint / Architectural Diagram, Site Map, Heat Map, Class Diagram, Sequence Diagram, Activity Diagram, State Machine Diagram, Use Case Diagram, Circuit Diagram, P&ID, Histogram, Box-and-Whisker Plot, Q-Q Plot, Free Body Diagram, Lewis Dot Diagram, Phase Diagram, Molecular Model Diagram]
   title: [Title of Diagram]
   subtitle: [Optional Subtitle]
   # Depending on the diagram type:
   # - For Charts/Graphs/Plots: labels: Item A, Item B / values: 40, 20
   # - For Venn Diagrams: leftLabel: X / rightLabel: Y / leftItems: A, B / rightItems: C / sharedItems: D
   # - For SWOT: strengths: A, B / weaknesses: C / opportunities: D / threats: E
   # - For Flowcharts/Timelines/Gantts/UML: steps: Step 1 -> Step 2 -> Step 3
   # - For Mindmaps/Hierarchies/Org Charts: root: Main Topic / list nodes starting with '-'
   \`\`\`
`;

export const POST: RequestHandler = async ({ request }) => {
	try {
		const {
			action,
			apiKey,
			useMockMode,
			model,
			bookTitle,
			genre,
			tone,
			structure,
			chapterTitle,
			chapterOrder,
			chapterSummary,
			chapterContent,
			pageContent,
			illustrationPrompt,
			editInstruction,
			researchNotes,
			coverSettings,
			coverStyle,
			interiorDesign
		} = await request.json();

		const activeApiKey = (apiKey?.trim()) || ANTHROPIC_API_KEY;

		const selectedModel =
			model === 'claude-opus-4'
				? (CLAUDE_OPUS_MODEL || 'claude-opus-4-8')
				: (CLAUDE_WRITING_MODEL || 'claude-sonnet-5');

		const isDesignEdit = editInstruction && 
			(action === 'edit-chapter' || action === 'edit-page' || action === 'add-page') && 
			/design|color|font|header|footer|border|background|style|alignment|theme/i.test(editInstruction);

		// Helper to execute programmatic mock styling edits
		const runMockDesignOverride = () => {
			let mockedDesign: any = null;
			if (isDesignEdit) {
				const hexColorMatch = editInstruction.match(/#[0-9a-fA-F]{6}/);
				let colorVal = hexColorMatch ? hexColorMatch[0] : null;
				if (!colorVal) {
					if (editInstruction.toLowerCase().includes('gold')) colorVal = '#C9A84C';
					else if (editInstruction.toLowerCase().includes('crimson')) colorVal = '#DC143C';
					else if (editInstruction.toLowerCase().includes('navy')) colorVal = '#1A2744';
					else if (editInstruction.toLowerCase().includes('forest green')) colorVal = '#1B5E20';
				}

				if (colorVal) {
					mockedDesign = {};
					if (editInstruction.toLowerCase().includes('header')) {
						mockedDesign['--r-header-color'] = colorVal;
						mockedDesign['--r-header-border'] = `1.5px solid ${colorVal}`;
					}
					if (editInstruction.toLowerCase().includes('title') || editInstruction.toLowerCase().includes('main color') || editInstruction.toLowerCase().includes('theme')) {
						mockedDesign['--r-title-color'] = colorVal;
					}
					if (editInstruction.toLowerCase().includes('footer')) {
						mockedDesign['--r-footer-color'] = colorVal;
						mockedDesign['--r-footer-border'] = `1.5px solid ${colorVal}`;
					}
				}
			}
			return mockedDesign;
		};

		// ── Mock mode ──────────────────────────────────────────────────────────
		if (useMockMode || !activeApiKey) {
			// If activeApiKey is present on the server, try to run the dynamic Claude edit even in mock mode (to support dynamic edits)
			const serverClaudeKey = ANTHROPIC_API_KEY?.trim();
			if (serverClaudeKey) {
				try {
					// We'll let the main Claude execution code handle it below
				} catch (err) {
					// fall through to static mocks
				}
			} else {
				await new Promise((r) => setTimeout(r, 2000));

				const mockedDesign = runMockDesignOverride();

				if (action === 'edit-chapter') {
					return json({
						success: true,
						content: `## ${chapterTitle}\n\n### Opening\n\nThis chapter has been revised based on your instruction: "${editInstruction}". The core ideas have been sharpened and the prose refined.\n\n| Flour Type | Protein Content | Use Case |\n| :--- | :--- | :--- |\n| White Flour | 10-12% | Cakes and cookies |\n| Whole Wheat | 13-15% | Rustic sourdough bread |\n\n### Conclusion\n\nThe key principles established in this chapter lay the groundwork.`,
						design: mockedDesign,
						source: 'mock'
					});
				}
				if (action === 'edit-page') {
					return json({
						success: true,
						pageContent: `The revised passage reflects the requested changes: "${editInstruction}".\n\n<div class="stat-block"><div class="stat-block__item"><div class="stat-block__num">95%</div><div class="stat-block__label">Visual Retention Rate</div></div></div>\n\nThe text flow has been adjusted to incorporate your feedback while preserving voice.`,
						design: mockedDesign,
						source: 'mock'
					});
				}
				if (action === 'edit-illustration') {
					return json({
						success: true,
						prompt: `${illustrationPrompt}. ${editInstruction}`,
						source: 'mock'
					});
				}
				if (action === 'reconstruct-chapter') {
					return json({
						success: true,
						content: `## ${chapterTitle}\n\n### The Foundation\n\nEvery meaningful work begins with a clear articulation of its purpose. In the context of *${bookTitle}*, this chapter establishes the conceptual bedrock.\n\n### Looking Forward\n\nThe principles introduced here will recur throughout the book.`,
						source: 'mock'
					});
				}
				if (action === 'reconstruct-page') {
					return json({
						success: true,
						pageContent: `The ideas on this page have been reconstructed from the chapter brief. In a fully realised version, this passage would develop one of the chapter's core arguments.`,
						source: 'mock'
					});
				}
				if (action === 'add-page') {
					return json({
						success: true,
						pageContent: `### New Section\n\nThis newly added page expands on the chapter content based on your instruction: "${editInstruction}".\n\n<div class="stat-block"><div class="stat-block__item"><div class="stat-block__num">85%</div><div class="stat-block__label">Flour hydration level</div></div></div>\n\nThe addition integrates seamlessly with surrounding content.`,
						source: 'mock'
					});
				}
			}
		}

		// ── Live API — Anthropic ───────────────────────────────────────────────
		let systemPrompt = '';
		let userPrompt = '';

		if (action === 'edit-chapter') {
			systemPrompt = `You are a professional ebook editor working on "${bookTitle}" (${genre}).
The chapter is written in a "${tone}" voice — preserve this voice in all edits.

Your task is to apply the user's editing instruction to the full chapter content while maintaining absolute factual accuracy.
Rules:
- Return ONLY the revised chapter content in Markdown — no commentary, no meta-text.
- Preserve the chapter's existing structure (headings, sections, flow) unless the instruction explicitly changes it.
- Keep or improve prose quality; never make the writing worse.
- If the instruction is stylistic, apply it uniformly.
- Do NOT add a chapter-number heading at the top.
- Ground all facts in the provided Exa AI research notes. Never fabricate statistics.

${VISUAL_DIRECTIVES}`;

			userPrompt = `Chapter ${chapterOrder}: "${chapterTitle}"

Editing instruction:
"${editInstruction}"

Grounding Research & Author Notes:
${researchNotes || 'None provided.'}

Current chapter content:
${chapterContent}

Apply the instruction and return the revised chapter now.`;

		} else if (action === 'reconstruct-chapter') {
			systemPrompt = `You are an expert researcher, technical writer, and editor writing for a commercial publishing house.
Book: "${bookTitle}" | Genre: ${genre} | Tone: ${tone}${structure ? ` | Structure: ${structure}` : ''}

Your task is to write a COMPLETELY FRESH version of a chapter from scratch, ensuring it is accurate, evidence-based, and thoroughly researched.
Core Principle: Research comes before writing. Ground all your claims in the provided Exa AI research notes.

Synthesize:
- Combine information into a cohesive, high-quality chapter.
- Do NOT copy source wording.
- Markdown: ## for section headings, ### for sub-headings, ** for bold key terms.
- Do NOT include a chapter-number heading at the top.

Accuracy Rules:
- Never fabricate statistics.

${VISUAL_DIRECTIVES}`;

			userPrompt = `Chapter ${chapterOrder}: "${chapterTitle}"

Chapter brief:
${chapterSummary || `Write a comprehensive chapter on the topic of "${chapterTitle}" for a book about "${bookTitle}".`}

Grounding Research & Author Notes:
${researchNotes || 'None provided.'}

Write the complete fresh chapter now.`;

		} else if (action === 'edit-page') {
			systemPrompt = `You are a professional ebook editor working on "${bookTitle}" (${genre}).
The book is written in a "${tone}" voice — preserve this exactly.

Your task is to rewrite a specific passage from Chapter ${chapterOrder}: "${chapterTitle}" based on the user's instruction.
Rules:
- Return ONLY the rewritten passage in Markdown — nothing else.
- Match the length of the original passage unless the instruction asks for more or less.
- Do not add headings the original passage did not have.
- Maintain voice and style consistency.
- Ground all edited information in the provided Exa AI research notes.

${VISUAL_DIRECTIVES}`;

			userPrompt = `Full chapter context (for reference — do NOT rewrite this):
${chapterContent}

---

Passage to rewrite (this exact excerpt from the chapter):
${pageContent}

---

Grounding Research & Author Notes:
${researchNotes || 'None provided.'}

---

Editing instruction:
"${editInstruction}"

Return only the rewritten passage.`;

		} else if (action === 'reconstruct-page') {
			systemPrompt = `You are a professional ebook author working on "${bookTitle}" (${genre}).
The book is written in a "${tone}" voice.

Your task is to write a COMPLETELY FRESH passage to replace a specific page in Chapter ${chapterOrder}: "${chapterTitle}".
Rules:
- Write entirely new prose that fits naturally.
- Do NOT copy the existing passage.
- Return ONLY the new passage in Markdown.
- Ground all claims in the provided Exa AI research notes.

${VISUAL_DIRECTIVES}`;

			userPrompt = `Chapter context (for continuity — do NOT copy this):
${chapterContent}

---

Grounding Research & Author Notes:
${researchNotes || 'None provided.'}

---

Existing passage being replaced (write something entirely different):
${pageContent}

Write the fresh replacement passage now.`;

		} else if (action === 'edit-illustration') {
			systemPrompt = `You are an expert at writing precise, descriptive prompts for AI image generation.
Your task is to take an existing illustration prompt and apply a user's instruction to produce an improved prompt.
Rules:
- Return ONLY the final prompt string — no commentary.
- Keep the artistic style terms from the original prompt.
- The prompt must be under 500 characters.`;

			userPrompt = `Original illustration prompt for Chapter ${chapterOrder}: "${chapterTitle}" of "${bookTitle}":
${illustrationPrompt}

User's instruction:
"${editInstruction}"

Write the improved image generation prompt now.`;

		} else if (action === 'add-page') {
			systemPrompt = `You are a professional ebook author working on "${bookTitle}" (${genre}).
The book is written in a "${tone}" voice.

Your task is to write ONE NEW PAGE of content to be inserted into Chapter ${chapterOrder}: "${chapterTitle}".
Rules:
- Write only the content for the new page — no chapter heading.
- The new content must flow naturally.
- Return ONLY the new content in Markdown.
- Ground all claims in the provided Exa AI research notes.

${VISUAL_DIRECTIVES}`;

			userPrompt = `Chapter context (for continuity):
${chapterContent}

---

Grounding Research & Author Notes:
${researchNotes || 'None provided.'}

---

User's request for the new page content:
"${editInstruction}"

Write the new page content now. It will be inserted after page ${(pageContent as any) ?? 'the selected page'} in this chapter.`;

		} else {
			throw new Error(`Unknown edit action: "${action}"`);
		}

		if (isDesignEdit) {
			systemPrompt += `\n\nCRITICAL: The user is requesting layout/style changes. You MUST return your response as a valid JSON object matching this structure:
{
  "content": "the revised text content in Markdown",
  "design": {
     ...css variable overrides here...
  }
}
Only include CSS variables in the "design" object that the user wants to override (e.g., "--r-header-color", "--r-header-border", "--r-title-color", "--r-title-font", etc.). Use valid CSS expressions for the values (e.g., colors as hex codes, font stacks with fallbacks).
Do not return any conversational filler, markdown block wrappers, or text outside the JSON.`;

			userPrompt += `\n\nCURRENT INTERIOR DESIGN SETTINGS (for reference):
${JSON.stringify(interiorDesign || {})}
COVER STYLE: "${coverStyle || ''}"
COVER SETTINGS: ${JSON.stringify(coverSettings || {})}`;
		}

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': activeApiKey || ANTHROPIC_API_KEY,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: selectedModel,
				max_tokens: (action === 'reconstruct-chapter') ? 8000 : (action === 'edit-chapter') ? 6000 : 2000,
				system: systemPrompt,
				messages: [{ role: 'user', content: userPrompt }]
			})
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Anthropic API error (${response.status}): ${errText}`);
		}

		const data = await response.json();
		const text = (data.content?.find((c: any) => c.type === 'text')?.text || '').trim();

		let contentText = text;
		let designOverrides: any = null;

		if (isDesignEdit) {
			try {
				let cleanJson = text;
				if (cleanJson.startsWith('```json')) {
					cleanJson = cleanJson.substring(7);
				}
				if (cleanJson.endsWith('```')) {
					cleanJson = cleanJson.substring(0, cleanJson.length - 3);
				}
				cleanJson = cleanJson.trim();

				const parsed = JSON.parse(cleanJson);
				contentText = parsed.content || text;
				designOverrides = parsed.design || null;
			} catch (err) {
				console.warn('Failed to parse design edit JSON from Claude:', err);
				contentText = text;
			}
		}

		if (action === 'edit-chapter' || action === 'reconstruct-chapter') {
			return json({ success: true, content: contentText, design: designOverrides, source: 'live' });
		}
		if (action === 'edit-page' || action === 'reconstruct-page' || action === 'add-page') {
			return json({ success: true, pageContent: contentText, design: designOverrides, source: 'live' });
		}
		if (action === 'edit-illustration') {
			return json({ success: true, prompt: text, source: 'live' });
		}

		throw new Error('Unhandled action after API response.');

	} catch (error: any) {
		console.error('[edit API] Error:', error);
		// Try dynamic fallback programmatic mock as a failsafe if it fails on live
		try {
			const body = await request.clone().json();
			const { editInstruction, action, chapterTitle } = body;
			const isDesignEdit = editInstruction && /design|color|font|header|footer|border|background|style|alignment|theme/i.test(editInstruction);
			
			let mockedDesign: any = null;
			if (isDesignEdit) {
				const hexColorMatch = editInstruction.match(/#[0-9a-fA-F]{6}/);
				let colorVal = hexColorMatch ? hexColorMatch[0] : null;
				if (!colorVal) {
					if (editInstruction.toLowerCase().includes('gold')) colorVal = '#C9A84C';
					else if (editInstruction.toLowerCase().includes('crimson')) colorVal = '#DC143C';
					else if (editInstruction.toLowerCase().includes('navy')) colorVal = '#1A2744';
					else if (editInstruction.toLowerCase().includes('forest green')) colorVal = '#1B5E20';
				}

				if (colorVal) {
					mockedDesign = {};
					if (editInstruction.toLowerCase().includes('header')) {
						mockedDesign['--r-header-color'] = colorVal;
						mockedDesign['--r-header-border'] = `1.5px solid ${colorVal}`;
					}
					if (editInstruction.toLowerCase().includes('title') || editInstruction.toLowerCase().includes('main color') || editInstruction.toLowerCase().includes('theme')) {
						mockedDesign['--r-title-color'] = colorVal;
					}
					if (editInstruction.toLowerCase().includes('footer')) {
						mockedDesign['--r-footer-color'] = colorVal;
						mockedDesign['--r-footer-border'] = `1.5px solid ${colorVal}`;
					}
				}
			}

			if (action === 'edit-page') {
				return json({
					success: true,
					pageContent: `[Failsafe Fallback] The revised passage reflects: "${editInstruction}".\n\n<div class="stat-block"><div class="stat-block__item"><div class="stat-block__num">95%</div><div class="stat-block__label">Visual Retention</div></div></div>`,
					design: mockedDesign,
					source: 'mock'
				});
			}
			return json({
				success: true,
				content: `## ${chapterTitle}\n\n[Failsafe Fallback] Chapter revised with instruction: "${editInstruction}".`,
				design: mockedDesign,
				source: 'mock'
			});
		} catch (fallbackErr) {
			return json(
				{ success: false, error: error.message || 'Unexpected error during edit.' },
				{ status: 500 }
			);
		}
	}
};
