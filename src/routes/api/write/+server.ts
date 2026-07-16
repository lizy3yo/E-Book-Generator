import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	CLAUDE_WRITING_MODEL,
	CLAUDE_OPUS_MODEL,
	CLAUDE_CHAT_MODEL,
	ANTHROPIC_API_KEY
} from '$env/static/private';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const {
			action,
			apiKey,
			useMockMode,
			model,
			bookTitle,
			genre,
			length,
			tone,
			structure,
			researchNotes,
			chapterTitle,
			chapterOrder,
			chapterSummary,
			chapterContent
		} = await request.json();

		const activeApiKey = (apiKey?.trim()) || ANTHROPIC_API_KEY;

		// claude-opus-4 → heavyweight flagship; default → sonnet-5 for best quality/speed
		const selectedModel = model === 'claude-opus-4'
			? (CLAUDE_OPUS_MODEL || 'claude-opus-4-8')
			: (CLAUDE_WRITING_MODEL || 'claude-sonnet-5');

		// Handle Mock Mode
		if (useMockMode || !activeApiKey) {
			const serverClaudeKey = ANTHROPIC_API_KEY?.trim();
			if (!serverClaudeKey) {
				await new Promise((resolve) => setTimeout(resolve, 3000)); // Simulate thinking

				if (action === 'outline') {
					// Generate typical outlines based on book title
					const numChapters = length === 'short' ? 3 : length === 'medium' ? 5 : 8;
					const chapters = [];

					for (let i = 1; i <= numChapters; i++) {
						chapters.push({
							id: crypto.randomUUID(),
							title: getMockChapterTitle(bookTitle, i, numChapters),
							order: i,
							summary: getMockChapterSummary(bookTitle, i),
							content: '',
							researchNotes: `Facts retrieved: ${researchNotes ? 'Grounding applied.' : 'General knowledge applied.'}`,
							illustrationUrl: null,
							status: 'pending' as const
						});
					}

					return json({
						success: true,
						chapters,
						source: 'mock'
					});
				}

				if (action === 'write-chapter') {
					const content = getMockChapterContent(bookTitle, chapterTitle || 'Introduction', chapterOrder || 1, tone, researchNotes);
					return json({
						success: true,
						content,
						source: 'mock'
					});
				}

				if (action === 'verify-chapter') {
					// Fact-checking/consistency report simulation
					const validationReport = `[Self-Fact-Checking & Consistency Pass - Claude 3.5 Sonnet]
- Checked consistency of title: "${bookTitle}"
- Checked chapter title: "${chapterTitle}"
- Grounding verification: Verified against semantic facts provided.
- Structural validation: No timeline anomalies or terminology contradictions found.
- Verification status: PASSED.`;

					return json({
						success: true,
						verifiedContent: chapterContent + `\n\n*(Verified for consistency & factual accuracy)*`,
						report: validationReport,
						source: 'mock'
					});
				}
			}
		}

		// Live API Mode (Anthropic Claude API)
		let systemPrompt = '';
		let userPrompt = '';

		// ── Tone → concrete writing instruction map ────────────────────────────
		const toneInstructions: Record<string, string> = {
			'Authoritative & Educational':
				'Write with authority and expertise. Use clear, confident declarative sentences. Teach the reader systematically — define concepts before expanding on them, use evidence to support every claim, and maintain a professional, credible voice throughout.',
			'Conversational & Accessible':
				'Write as if speaking directly to the reader. Use contractions, short paragraphs, rhetorical questions, and relatable analogies. Avoid jargon unless immediately explained. The goal is warmth and clarity — every reader should feel the content is written for them personally.',
			'Practical & Action-Oriented':
				'Lead with value. Every section should give the reader something concrete to do, apply, or implement. Use bullet points, numbered steps, and callout boxes. Cut exposition in favour of usable frameworks and real-world application.',
			'Academic & Research-Driven':
				'Maintain scholarly rigour. Ground every assertion in evidence, cite sources in-text, use precise disciplinary vocabulary, and structure arguments formally (claim → evidence → analysis). Avoid colloquialisms. The tone should reflect peer-reviewed publishing standards.',
			'Journalistic & Investigative':
				'Open with a hook — a striking fact, anecdote, or question. Use the inverted pyramid: most important information first. Weave in interviews, statistics, and case evidence. Maintain objectivity while building a compelling narrative.',
			'Narrative & Storytelling':
				'Tell a story. Use scene-setting, characters (real or composite), sensory detail, and narrative arc. Alternate between close-up moments and wider perspective. Each chapter should feel like a chapter of a novel — drawing the reader forward with tension, resolution, and meaning.',
			'Inspirational & Motivational':
				'Write with energy and belief. Use second-person ("you") to speak directly to the reader\'s potential. Include transformational stories, powerful metaphors, and forward-looking calls to action. Every page should leave the reader feeling capable and motivated.',
			'Reflective & Philosophical':
				'Write with depth and measured contemplation. Pose big questions, sit with ambiguity, and explore ideas from multiple angles before arriving at insight. Use literary references, paradoxes, and nuanced language. Avoid rushing to conclusions.',
			'Technical & Precise':
				'Prioritise accuracy and specificity above all else. Use technical vocabulary correctly, define all domain terms on first use, structure content with numbered sections, and include code samples, diagrams, or data tables where appropriate. Assume a technically literate audience.',
			'Instructional & Step-by-Step':
				'Structure every section as a clear, reproducible procedure. Number all steps. State prerequisites upfront. Highlight warnings, tips, and expected outcomes. The reader should be able to follow the content and achieve a defined result without ambiguity.'
		};

		// ── Structure → chapter architecture instruction map ──────────────────
		const structureInstructions: Record<string, string> = {
			'Standard Chapters':
				'Organise the book as: an opening chapter establishing context and promise, body chapters each developing one major idea with evidence and examples, and a closing chapter that synthesises key takeaways and points forward.',
			'Problem–Solution Framework':
				'Each chapter follows a Problem → Analysis → Resolution arc. Open by articulating a specific challenge the reader faces, develop a deep analysis of root causes, then present a clear, actionable resolution. The book as a whole moves from diagnosis to transformation.',
			'Step-by-Step Blueprint':
				'Structure the book as a sequential programme. Each chapter is a phase or stage in a larger process. Open each chapter with the phase goal, walk through concrete steps with examples, and close with a summary and transition to the next phase.',
			'Pillar Framework':
				'Identify 3–8 core pillars or principles that define the subject. Dedicate one chapter to each pillar. Open with a thesis statement for the pillar, explore it thoroughly, then show how it interconnects with the other pillars.',
			'Story Narrative':
				'Structure the book as a continuous narrative arc. Use a protagonist (the author, a subject, or the reader themselves) moving through challenge, growth, and resolution. Each chapter is a scene or sequence that advances the story while delivering insight.',
			'Academic Thesis':
				'Follow formal academic structure: Abstract → Introduction & Research Question → Literature Review → Methodology → Findings & Analysis → Discussion → Conclusion & Implications. Maintain citations, hedged language, and disciplinary conventions throughout.',
			'Interview & Case Study':
				'Anchor each chapter in one or more real-world case studies or expert interviews. Open with the story, extract principles and lessons, then broaden to universal application. Use primary voices (quotes, dialogue) to ground the analysis in lived reality.'
		};

		const toneGuide = toneInstructions[tone] ?? `Write in a ${tone} voice.`;
		const structureGuide = structureInstructions[structure] ?? `Follow a ${structure} format.`;

		if (action === 'outline') {
			systemPrompt = `You are a senior acquisitions editor at a major publishing house with 20 years of experience structuring bestselling non-fiction ebooks.
Your task is to produce a publication-ready chapter outline.
You MUST strictly follow any custom chapter requirements, structural requests (e.g. adding an Introduction/Preface chapter first, specific topics to cover, or particular formatting), and directions specified by the user in the "[Author Brief]" under Grounding Research & Author Notes.
Respond ONLY with a valid JSON array — no markdown fences, no commentary.
Each element: {"title": "string", "order": number, "summary": "string (2–3 sentences describing what the chapter covers and what the reader will gain)"}`;

			userPrompt = `Create a detailed chapter outline for the following ebook:

Title: "${bookTitle}"
Genre / Subject: ${genre}
Target Length: ${length === 'short' ? '3 chapters (~10–15k words total)' : length === 'medium' ? '5 chapters (~25–35k words total)' : '8 chapters (~50–60k words total)'}
Writing Tone: ${tone}
  → ${toneGuide}
Book Structure: ${structure}
  → ${structureGuide}

Grounding Research & Author Notes:
${researchNotes || 'None provided.'}

Requirements:
- Chapter titles must be compelling and specific, not generic.
- Summaries must describe concrete content, not vague promises.
- The arc across chapters must feel intentional and complete.

Return ONLY a valid JSON array.`;

		} else if (action === 'write-chapter') {
			systemPrompt = `You are an expert researcher, technical writer, and editor writing for a commercial publishing house.
Your task is to generate a professional-quality ebook chapter that is accurate, evidence-based, and thoroughly researched.
You MUST incorporate and respect any specific guidelines, concepts, examples, focus areas, or narrative instructions specified in the "[Author Brief]" under Grounding Research & Author Notes to ensure the chapter aligns perfectly with the author's vision.

Core Principle: Research comes before writing. Ground all your claims in the provided Exa AI research notes. Do not begin writing until you have fully analyzed and synthesized the facts.

Synthesize:
- Combine the information from the provided Exa AI research notes and author context into a cohesive, high-quality chapter.
- Do NOT copy source wording. Rewrite everything in original, sophisticated language.
- The writing should read naturally and flow seamlessly, rather than looking like a collection of raw research notes.

Writing Requirements:
- Include clear, accessible explanations.
- Provide practical examples and real-world applications/case studies to ground theoretical concepts.
- Provide historical background and context where appropriate.
- Incorporate expert insights, highlight common mistakes, and give actionable advice.
- Ensure smooth, natural transitions between ideas and sections.
- Avoid shallow summaries or high-level fluff. Each section must teach the reader something meaningful.
- Use Markdown: ## for section headings, ### for sub-sections, ** for bold key terms, * for italics.
- Open each section with a strong topic sentence.
- End the chapter with a concise "Key Takeaways" or transition paragraph that points to the next chapter.
- Do NOT include a chapter number header — start directly with the first section heading.
- Do NOT include sign-offs, pleasantries, or meta-commentary about the writing.
- Aim for substantial depth: each chapter should read as a complete, standalone piece of professional writing.

Accuracy Rules:
- Never fabricate statistics, studies, surveys, expert quotes, dates, historical events, laws, medical information, or financial information.
- If information cannot be verified confidently from the provided research notes, state that evidence is limited instead of speculating or guessing. Avoid presenting speculation as fact.

Depth Requirements:
- For every major concept introduced:
  1. Explain what it is.
  2. Explain why it matters.
  3. Explain how it works.
  4. Outline its benefits and limitations/drawbacks.
  5. Correct common misconceptions about it.
  6. Detail practical implementation steps and real-world examples.
- Assume the reader has no prior knowledge of the topic, but maintain a professional, high-standard tone.

Consistency:
- Maintain consistent terminology throughout.
- Follow a logical progression of ideas with no contradictions or repeated information.

TONE DIRECTIVE — ${tone}:
${toneGuide}

VISUAL ELEMENTS & LAYOUT DIRECTIVES (Align content with professional, publication-ready ebook standards):

CRITICAL RULE: Actively choose the RIGHT element for each content type. Do not default to paragraphs when a visual element communicates better.

1. TABLES FOR COMPARISONS & CHECKLISTS: When listing scenarios, comparing options, showing lookup data, or presenting checklists, use a markdown table.
   Example:
   | Done | Fix | Est. Cost | Difficulty |
   | :--- | :--- | :--- | :--- |
   | [ ] | Seal foundation cracks | $20–$50 | Easy |
   | [ ] | Replace weatherstripping | $10–$30 | Easy |

2. TYPED CALLOUT BOXES: Use these for tips, definitions, warnings, rules, and key points. Choose the type that fits the message:
   - TIP BOX (advice, best practice):
   <div class="tip-box">
     <span class="callout-box__title">💡 PRO TIP</span>
     <div class="callout-box__content">Actionable advice or best practice here.</div>
   </div>
   - WARNING BOX (safety or risk):
   <div class="warning-box">
     <span class="callout-box__title">⚠️ IMPORTANT WARNING</span>
     <div class="callout-box__content">Safety note or risk to be aware of.</div>
   </div>
   - KEY RULE BOX (critical principle):
   <div class="key-rule-box">
     <span class="callout-box__title">📌 KEY RULE</span>
     <div class="callout-box__content">A core rule or principle that must not be skipped.</div>
   </div>
   - GENERAL CALLOUT (facts, insights, definitions):
   <div class="callout-box">
     <span class="callout-box__title">KEY INSIGHT / DEFINITION</span>
     <div class="callout-box__content">Content here.</div>
   </div>

3. STAT / KPI BLOCKS: Whenever a section introduces a key statistic, percentage, dollar amount, or metric, render it as a visual stat block BEFORE the paragraph that discusses it. Use 2–4 stat items per block.
   <div class="stat-block">
     <div class="stat-block__item">
       <div class="stat-block__num">$2,400</div>
       <div class="stat-block__label">Average annual energy savings</div>
     </div>
     <div class="stat-block__item">
       <div class="stat-block__num">73%</div>
       <div class="stat-block__label">Of homes have fixable air leaks</div>
     </div>
     <div class="stat-block__item">
       <div class="stat-block__num">3–5 yrs</div>
       <div class="stat-block__label">Typical payback period</div>
     </div>
   </div>

4. BAR CHARTS (horizontal): When comparing magnitudes, frequencies, or rankings across 3–8 items, render a horizontal CSS bar chart.
   <div class="chart-bar">
     <div class="chart-bar__title">Most Common Home Repair Costs</div>
     <div class="chart-bar__row">
       <div class="chart-bar__label">Roof repair</div>
       <div class="chart-bar__track"><div class="chart-bar__fill" style="width:85%">$8,500</div></div>
     </div>
     <div class="chart-bar__row">
       <div class="chart-bar__label">HVAC replacement</div>
       <div class="chart-bar__track"><div class="chart-bar__fill" style="width:70%">$7,000</div></div>
     </div>
     <div class="chart-bar__row">
       <div class="chart-bar__label">Foundation repair</div>
       <div class="chart-bar__track"><div class="chart-bar__fill" style="width:60%">$6,000</div></div>
     </div>
   </div>

5. PRO / CON GRIDS: Whenever comparing two sides of an argument, approach, or option, use a side-by-side pro/con grid.
   <div class="pro-con-grid">
     <div class="pro-grid__col pro-grid__col--pro">
       <div class="pro-grid__header">✅ Pros</div>
       <div class="pro-grid__item">Cost-effective long term</div>
       <div class="pro-grid__item">DIY-friendly</div>
     </div>
     <div class="pro-grid__col pro-grid__col--con">
       <div class="pro-grid__header">❌ Cons</div>
       <div class="pro-grid__item">Time-intensive upfront</div>
       <div class="pro-grid__item">Requires specific tools</div>
     </div>
   </div>

6. NUMBERED CHECKLISTS: For step-by-step procedures or action item lists, use a styled checklist.
   <div class="checklist-box">
     <div class="checklist-box__title">Action Checklist</div>
     <div class="checklist-box__item"><span class="checklist-box__num">01</span><span>Inspect all visible pipes for corrosion</span></div>
     <div class="checklist-box__item"><span class="checklist-box__num">02</span><span>Test water pressure at main valve</span></div>
     <div class="checklist-box__item"><span class="checklist-box__num">03</span><span>Document findings with photos</span></div>
   </div>

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
   \`\`\``;

			userPrompt = `Write the complete content for the following ebook chapter:

Book Title: "${bookTitle}"
Genre: ${genre}
Book Structure: ${structure}

Chapter ${chapterOrder}: "${chapterTitle}"
Chapter Brief: ${chapterSummary}

Tone: ${tone}
Tone guidance: ${toneGuide}

Grounding Research & Author Notes (integrate seamlessly — do not list these as sources, weave them into the narrative):
${researchNotes || 'None provided.'}

Write the full chapter now. Be thorough, substantive, and publication-ready.`;

		} else if (action === 'verify-chapter') {
			systemPrompt = `You are a professional copy-editor, expert fact-checker, and reviewer at a publishing house.
Your job is to perform a final review, verification, and validation on the drafted ebook chapter to ensure industry-standard quality.

Validation & Verification Workflow:
- Check that every factual statement in the chapter is verified against the provided Exa AI research notes. Discard any unsupported claims or speculations.
- Verify that all statistics are current, accurate, and not fabricated.
- Ensure terminology is consistent and accurate.
- Check that examples are realistic and explanations are internally consistent, with no contradictions.
- Ensure no fabricated statistics, studies, quotes, dates, or events are present.
- Confirm the chapter is complete, coherent, and meets all accuracy and depth standards.

Return your response in EXACTLY this format with no deviation:
---REPORT---
[Concise bullet-point report: detail your verification results, flag any factual issues, tone deviations, structural gaps, or prose weaknesses. If all clear, state so.]
---CONTENT---
[The fully polished, corrected, and verified chapter content in Markdown]`;

			userPrompt = `Book Title: "${bookTitle}"
Chapter: "${chapterTitle}"
Declared Tone: ${tone}
Tone guidance: ${toneGuide}

Grounding Research & Author Notes:
${researchNotes || 'None provided.'}

Draft chapter to review:
${chapterContent}

Review, correct, and return in the required format.`;
		}

		// Make HTTP request to Anthropic
		// Use a faster model for outline (structured JSON, not prose) and
		// tighten max_tokens to match actual output size.
		const outlineModel = action === 'outline'
			? (CLAUDE_CHAT_MODEL || 'claude-haiku-4-5-20251001')
			: selectedModel;

		// Size the output budget from the actual work, not a fixed guess. A
		// verify pass echoes the whole chapter back after the report, so its
		// budget has to scale with the draft it is given or long chapters get
		// truncated mid-sentence.
		const maxTokens =
			action === 'write-chapter'  ? budgetForWrite(length) :
			action === 'verify-chapter' ? budgetForVerify(chapterContent) :
			/* outline — scale with book length; a long book needs more chapters */
			budgetForOutline(length);

		const controller = new AbortController();
		// Streamed requests only need to survive gaps between chunks, so the
		// ceiling can be generous without risking a silent HTTP timeout.
		const timeoutMs = action === 'outline' ? 60_000 : 600_000;
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		// Anthropic requires streaming once max_tokens is large enough that a
		// single buffered response could exceed the request timeout.
		const useStream = action !== 'outline';

		let response: Response;
		let responseText = '';
		let stopReason: string | null = null;
		try {
			response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': activeApiKey,
					'anthropic-version': '2023-06-01'
				},
				body: JSON.stringify({
					model: outlineModel,
					max_tokens: maxTokens,
					stream: useStream,
					system: systemPrompt,
					messages: [
						{ role: 'user', content: userPrompt }
					]
				})
			});

			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Anthropic API error (${response.status}): ${errText}`);
			}

			({ text: responseText, stopReason } = useStream
				? await readTextStream(response)
				: await readTextResponse(response));
		} catch (fetchErr: any) {
			if (fetchErr.name === 'AbortError') {
				throw new Error(`Claude API timed out after ${timeoutMs / 1000}s. Please try again.`);
			}
			throw fetchErr;
		} finally {
			clearTimeout(timer);
		}

		if (stopReason === 'max_tokens') {
			throw new Error(
				`Claude ran out of output room on "${chapterTitle || bookTitle}" (budget was ${maxTokens} tokens) and the result was cut off. Please retry — if this repeats, the chapter is too long to process in one pass and should be split.`
			);
		}

		if (action === 'outline') {
			// Extract JSON array
			try {
				let cleanJson = responseText.trim();

				// Robust array extraction to discard conversational filler
				const arrayStart = cleanJson.indexOf('[');
				const arrayEnd = cleanJson.lastIndexOf(']');
				if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
					cleanJson = cleanJson.substring(arrayStart, arrayEnd + 1);
				} else {
					if (cleanJson.startsWith('```json')) {
						cleanJson = cleanJson.substring(7);
					}
					if (cleanJson.endsWith('```')) {
						cleanJson = cleanJson.substring(0, cleanJson.length - 3);
					}
					cleanJson = cleanJson.trim();
				}

				const chapters = JSON.parse(cleanJson);
				// Map chapters to include database-like fields
				const formattedChapters = chapters.map((chap: any, index: number) => ({
					id: crypto.randomUUID(),
					title: chap.title || `Chapter ${index + 1}`,
					order: chap.order || (index + 1),
					summary: chap.summary || 'Summary not provided.',
					content: '',
					researchNotes: '',
					illustrationUrl: null,
					status: 'pending' as const
				}));

				return json({
					success: true,
					chapters: formattedChapters,
					source: 'live'
				});
			} catch (parseError) {
				console.error('Failed to parse Claude outline JSON:', responseText);
				throw new Error('Claude did not return a valid JSON outline. Please try again.');
			}
		} else if (action === 'write-chapter') {
			return json({
				success: true,
				content: responseText,
				source: 'live'
			});
		} else if (action === 'verify-chapter') {
			let report = 'No report could be generated.';
			let verifiedContent = chapterContent;

			if (responseText.includes('---REPORT---') && responseText.includes('---CONTENT---')) {
				const parts = responseText.split('---CONTENT---');
				report = parts[0].replace('---REPORT---', '').trim();
				verifiedContent = parts[1].trim();
			} else {
				report = 'Completed fact checking and readability pass.';
				verifiedContent = responseText;
			}

			return json({
				success: true,
				verifiedContent,
				report,
				source: 'live'
			});
		}

		throw new Error('Invalid API action specified.');

	} catch (error: any) {
		console.error('Write API Route Error:', error);
		return json({
			success: false,
			error: error.message || 'An unexpected error occurred during writing.'
		}, { status: 500 });
	}
};

// ── Output budgeting ──────────────────────────────────────────────────────
// Claude Sonnet 5 and Opus 4.8 both cap output at 128k tokens. We stay under
// that so a single runaway request can never stall the whole book.
const MODEL_OUTPUT_CAP = 64_000;

/** Rough token estimate for English markdown prose (~3.5 chars per token). */
function estimateTokens(text: string): number {
	return Math.ceil((text?.length ?? 0) / 3.5);
}

/** A fresh chapter's ceiling scales with how long the book's chapters should be. */
/**
 * Outline output is a JSON array of chapter objects. Each entry is roughly
 * 80–120 tokens. Long books can have 15+ chapters, so the old 900-token fixed
 * ceiling truncated the JSON mid-array and caused a parse failure.
 */
function budgetForOutline(length: string): number {
	const tokens =
		length === 'short'  ? 1_500 :
		length === 'medium' ? 2_500 :
		/* long */            4_000;
	return Math.min(tokens, MODEL_OUTPUT_CAP);
}

function budgetForWrite(length: string): number {
	const target =
		length === 'short'  ? 12_000 :
		length === 'medium' ? 20_000 :
		/* long */            32_000;
	return Math.min(target, MODEL_OUTPUT_CAP);
}

/**
 * A verify pass emits a report and then re-emits the full chapter, so it needs
 * room for the draft it was handed plus editorial expansion, plus the report.
 */
function budgetForVerify(chapterContent: string): number {
	const draft = estimateTokens(chapterContent);
	const needed = Math.ceil(draft * 1.5) + 4_000;
	return Math.min(Math.max(needed, 12_000), MODEL_OUTPUT_CAP);
}

// ── Response readers ──────────────────────────────────────────────────────
type ClaudeText = { text: string; stopReason: string | null };

async function readTextResponse(response: Response): Promise<ClaudeText> {
	const data = await response.json();
	return {
		text: data.content?.find((c: any) => c.type === 'text')?.text || '',
		stopReason: data.stop_reason ?? null
	};
}

/**
 * Accumulates text deltas from Anthropic's SSE stream. Streaming is what lets
 * us request a large budget without tripping the request timeout.
 */
async function readTextStream(response: Response): Promise<ClaudeText> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Claude API returned an empty response stream.');

	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let stopReason: string | null = null;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });

		// SSE events are separated by a blank line; keep any partial tail.
		const events = buffer.split('\n\n');
		buffer = events.pop() ?? '';

		for (const event of events) {
			const dataLine = event.split('\n').find((l) => l.startsWith('data:'));
			if (!dataLine) continue;

			let payload: any;
			try {
				payload = JSON.parse(dataLine.slice(5).trim());
			} catch {
				continue;
			}

			if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
				text += payload.delta.text;
			} else if (payload.type === 'message_delta' && payload.delta?.stop_reason) {
				stopReason = payload.delta.stop_reason;
			} else if (payload.type === 'error') {
				throw new Error(`Anthropic stream error: ${payload.error?.message || 'unknown'}`);
			}
		}
	}

	return { text, stopReason };
}

// Helper utilities for Mock Content Generation
function getMockChapterTitle(bookTitle: string, index: number, total: number): string {
	const titles: Record<number, string[]> = {
		1: ['Foundations and Origins', 'Introduction & Core Concepts', 'The Horizon of Exploration', 'An Overview of the Landscape'],
		2: ['Architectural Dynamics', 'Core Mechanics & Principles', 'The Machinery of Progress', 'Systemic Explorations'],
		3: ['Practical Integration', 'Case Studies and Practical Application', 'Synthesis and Future Horizon', 'Tactical Realities'],
		4: ['Advanced Methodology', 'Scaling the Ecosystem', 'Unlocking Secondary Frontiers', 'High-Tier Architectures'],
		5: ['Synthesis of Concepts', 'Case Studies in Execution', 'Conclusion & Looking Forward', 'Closing Thoughts and Epilogue']
	};

	if (index === total) {
		return 'Synthesis, Horizons, and Beyond';
	}

	const options = titles[index] || [`Advanced Explorations Part ${index}`, `Core Concepts Expanded (Chapter ${index})`];
	return options[Math.floor(Math.random() * options.length)];
}

function getMockChapterSummary(bookTitle: string, index: number): string {
	const summaries = [
		'Establishing the baseline concepts, background context, and setting structural definitions for the entire book.',
		'Diving deep into the core mechanics, outlining logical workflows, and presenting detailed data models.',
		'Focusing on real-world integrations, highlighting operational challenges, and solving standard deployment bottlenecks.',
		'Expanding concepts to global scales, discussing limits, optimizations, and security paradigms.',
		'Synthesizing the core arguments, drawing conclusive summaries, and opening a discussion on future trends.'
	];
	return summaries[(index - 1) % summaries.length];
}

function getMockChapterContent(bookTitle: string, chapterTitle: string, order: number, tone: string, researchNotes: string): string {
	const notesSnippet = researchNotes
		? `*Self-Grounding Integration: This chapter incorporates verified data metrics, specifically referencing the fact that neural grounding approaches yield up to a 92% improvement in reading flow parameters.*`
		: '';

	return `## ${chapterTitle}

### Section 1: The Context of Evolution

Every intellectual endeavor begins with a primary assertion: that our current structural methodologies are incomplete without recursive verification. In writing *${bookTitle}*, we attempt to map the cognitive boundaries that separate raw content generation from high-fidelity publishing. 

As we look at the evolution of modern literature, we see a shift from manual structuring to automated, semantic frameworks. The transition is not merely automated speed, but a structural shift in how ideas are cataloged, verified, and displayed.

> "To write is to perform a double reflection: first of the world, and second of the self. In the age of automated grounding, we add a third: the reflection of the fact."
> — *The Journal of Cognitive Synthesis*

### Section 2: Grounding and Truth

${notesSnippet}

One of the largest roadblocks in automated publishing is the phenomenon of semantic drift, commonly called hallucinations. By using neural semantic search engines like Exa AI alongside Anthropic Claude models, we ensure that every chapter is anchored to an empirical fact. This is not simple retrieval; it is a dynamic fact-checking mesh that compares drafts to external sources before the author finalizes the text.

#### Key Principles of Grounded Writing:
1. **Source Integration:** Every factual claim must be backed by a verified source URI.
2. **Readability Indexing:** Sentence complexity should adapt to the target tone (in this case, written in a **${tone}** format).
3. **Recursive Outlining:** Chapters are structured to minimize logic loops.

### Section 3: Strategic Takeaways

As we move forward into subsequent chapters, the focus will shift from these theoretical baselines to implementation blueprints. The goal is to build an automated agent that can write, research, review, and illustrate books of publication-grade quality with minimal human friction.

*   **Primary Axiom:** Semantic accuracy is not a secondary constraint; it is the core foundation.
*   **Secondary Axiom:** The cover and structural aesthetic must mirror the high standards of the written word.
`;
}
