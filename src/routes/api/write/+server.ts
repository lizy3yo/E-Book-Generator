import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { planForBook } from '$lib/bookPlan';
import { renderBibleBlock } from '$lib/bookBible';
import { NO_TEXT_CLAUSE } from '$lib/illustration';
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
			bookOutline,
			bookBible,
			pageCount,
			chapterContent,
			// ── Illustration art direction ─────────────────────────────────
			ultraRealistic,
			diagramIntent,
			authorNote,
			// ── Illustration labelling ─────────────────────────────────────
			imageUrl,
			illustrationSubject,
			// ── Cover actions ──────────────────────────────────────────────
			bookSubtitle,
			bookAuthor,
			authorBrief,
			coverDirection,
			conceptCount,
			referenceImage
		} = await request.json();

		const activeApiKey = (apiKey?.trim()) || ANTHROPIC_API_KEY;

		// claude-opus-4 → heavyweight flagship; default → sonnet-5 for best quality/speed
		const selectedModel = model === 'claude-opus-4'
			? (CLAUDE_OPUS_MODEL || 'claude-opus-4-8')
			: (CLAUDE_WRITING_MODEL || 'claude-sonnet-5');

		// One plan, derived from pageCount (or the legacy length for books that
		// predate it), so the outline prompt, the mock path and both token
		// budgets can never disagree about how big this book is. Declared here
		// because the prompts below read it.
		const plan = planForBook({ pageCount, length });

		// Handle Mock Mode
		if (useMockMode || !activeApiKey) {
			const serverClaudeKey = ANTHROPIC_API_KEY?.trim();
			if (!serverClaudeKey) {
				await new Promise((resolve) => setTimeout(resolve, 3000)); // Simulate thinking

				if (action === 'outline') {
					// Generate typical outlines based on book title
					const numChapters = plan.chapterCount;
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

				if (action === 'distill-chapter') {
					return json({
						success: true,
						entries: [
							{ kind: 'term', label: `Mock Term ${chapterOrder}`, detail: 'A placeholder definition introduced by mock mode.', chapter: chapterOrder || 1 }
						],
						source: 'mock'
					});
				}

				if (action === 'art-direct-illustration') {
					return json({
						success: true,
						subject: `Mock subject for "${chapterTitle}".`,
						prompt: `Mock art direction — a single instructive visual for "${chapterTitle}" from "${bookTitle}" (${genre}).`,
						source: 'mock'
					});
				}

				if (action === 'place-illustration-labels') {
					// Mock mode has no vision. Inventing coordinates for an image
					// nobody looked at would put labels on the wrong parts, which is
					// the exact failure this whole feature exists to prevent.
					return json({ success: true, labels: [], source: 'mock' });
				}

				if (action === 'cover-concepts') {
					const count = Math.max(1, Math.min(6, conceptCount || 3));
					return json({
						success: true,
						concepts: Array.from({ length: count }, (_, i) => ({
							style: `Mock Concept ${i + 1}`,
							basis: 'Mock mode — no brief was analysed.',
							concept: `A placeholder art direction devised by mock mode for "${bookTitle}".`,
							prompt: `Professional book cover for "${bookTitle}". Genre: ${genre}. Mock concept ${i + 1}.`
						})),
						source: 'mock'
					});
				}

				if (action === 'analyze-cover-reference') {
					return json({
						success: true,
						format: `[Mock reference analysis]
Palette: deep navy, warm gold accent, bone white.
Typography: extra-bold condensed sans title, small letter-spaced caps for the author.
Imagery: single photographic subject, lower half, dark gradient scrim.
Graphics: thin horizontal rules separating title lines; circular badge lower right.
Layout: title occupies the upper 55%, author in a solid bar at the foot.`,
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
Target Length: EXACTLY ${plan.chapterCount} chapters — ${plan.pageCount} pages, ~${plan.totalWords.toLocaleString()} words total (~${plan.wordsPerChapter.toLocaleString()} words per chapter).
Return all ${plan.chapterCount} chapters. Give each one a distinct remit so no two chapters cover the same ground — this outline is the only thing preventing overlap, because chapters are written independently of one another.
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

			// The full plan, so this chapter knows what the rest of the book
			// covers. Chapters are written concurrently and never see each
			// other's prose — without this every chapter is blind to the others
			// and re-explains the same foundations, which is what makes a long
			// book read as repetitive even when each chapter is individually good.
			const outlineBlock = Array.isArray(bookOutline) && bookOutline.length > 1
				? `\nFULL BOOK OUTLINE — every chapter in this book:\n` +
				  bookOutline
					.map((c: any) => `${c.order === chapterOrder ? '>>' : '  '} Ch ${c.order}: "${c.title}" — ${c.summary ?? ''}`)
					.join('\n') +
				  `\n\nThe chapter marked >> is the one you are writing. Rules for using this outline:\n` +
				  `- Every other chapter listed WILL be written. Do not explain what they cover — assume the reader gets it there.\n` +
				  `- Do not restate foundations covered by an earlier chapter. Build on them.\n` +
				  `- You may reference other chapters by number ("as Chapter 3 established", "Chapter 9 takes this further") — only where genuinely relevant, and only for chapters that exist above.\n` +
				  `- Stay strictly inside your own brief. Material belonging to another chapter is that chapter's job.\n`
				: '';

			// The outline says what other chapters are PLANNED to cover. This says
			// what the already-written ones actually SAID — the gap the outline
			// alone cannot close, and where contradictions and re-derivations live.
			// Bounded to ~2.5k tokens at any book length; see $lib/bookBible.
			const bibleBlock = renderBibleBlock(bookBible);

			userPrompt = `Write the complete content for the following ebook chapter:

Book Title: "${bookTitle}"
Genre: ${genre}
Book Structure: ${structure}
${outlineBlock}${bibleBlock}
Chapter ${chapterOrder}: "${chapterTitle}"
Chapter Brief: ${chapterSummary}

Tone: ${tone}
Tone guidance: ${toneGuide}

Grounding Research & Author Notes (integrate seamlessly — do not list these as sources, weave them into the narrative):
${researchNotes || 'None provided.'}

Write the full chapter now. Be thorough, substantive, and publication-ready.`;

		} else if (action === 'distill-chapter') {
			systemPrompt = `You are a continuity editor building a "book bible" — the record of what a book has already committed to, used by the authors of later chapters so they do not contradict, redefine, or repeat what came before.

Read the chapter and extract ONLY what a LATER chapter's author must not get wrong:
- "term": a term or concept this chapter DEFINED. detail = its definition, compressed to one sentence.
- "claim": a substantive position or conclusion this chapter ARGUED. detail = the claim in one sentence.
- "example": a specific case study, anecdote, company, or scenario used to illustrate a point. detail = what it illustrated.
- "stat": a specific number, percentage, dollar amount, or date cited. detail = the figure and what it measures.

Rules:
- Be ruthless. Extract at most 8 entries. Only what is load-bearing for continuity — skip anything a later author could not plausibly collide with.
- "label" must be short (under 8 words). "detail" must be ONE sentence.
- Do NOT summarise the chapter. This is not a summary; it is a list of commitments.
- If the chapter defines nothing and cites nothing, return an empty array.

Respond ONLY with a valid JSON array — no markdown fences, no commentary.
Each element: {"kind": "term"|"claim"|"example"|"stat", "label": "string", "detail": "string"}`;

			userPrompt = `Book: "${bookTitle}"
Chapter ${chapterOrder}: "${chapterTitle}"

Chapter content:
${chapterContent}

Return ONLY the JSON array.`;

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

		} else if (action === 'cover-concepts') {
			const count = Math.max(1, Math.min(6, conceptCount || 3));

			systemPrompt = `You are an award-winning book cover art director at a major trade publisher. You have designed covers that sold millions of copies. You are briefed on a book and you respond with original cover concepts.

═══ 1. EVERY CONCEPT MUST BE DERIVED FROM THIS SPECIFIC BOOK ═══

You are given the author's own words about their book. That brief is your source material, not background colour. For each concept, find one specific idea, tension, image, object, moment, or metaphor that is IN the brief, and build the cover around it. Record exactly what you built on in the "basis" field, quoting the author's own words where you can.

A concept whose "basis" is a genre generality ("it's about business", "it's a memoir") is a failed concept — that is the description of a category, not of this book. If you cannot point to the specific thing in the brief that produced the image, you have not designed for this book, you have decorated its genre.

If the brief is thin, derive from the title, subtitle, genre and tone — but still name the precise element you used.

═══ 2. THE ${count} CONCEPTS MUST COHERE AS ONE SET ═══

All ${count} must be recognisably covers for the SAME book — same subject, same argument, same promise to the same reader, and consistent with the declared writing tone. A quiet, reflective book does not get a loud badge-and-arrow cover. The author should feel they are choosing between ${count} interpretations of their book, not between ${count} different books.

Within that, each must be visually DISTINCT from the others: a different palette, a different compositional strategy, and a different kind of imagery. Do not submit variations of one idea with the colours changed.

═══ 3. EVERY PROMPT MUST BE CONCRETE ═══

The prompt is handed to an image model that knows nothing about this book and cannot ask questions. Vagueness there becomes a generic cover. Each prompt MUST specify, explicitly:
- The background and full palette — name the actual colours, with approximate hex values, and which one is the accent.
- The composition, as zones with rough percentages of the cover ("upper 55%…", "bottom 12% strip…"), and where the visual weight falls.
- The single focal image, described concretely enough to picture it: what the object or scene IS, its material, its lighting direction and quality, and its framing. If photographic, state the lens character and depth of field.
- The title text reproduced VERBATIM and in quotes exactly as supplied, plus its typeface character, weight, case, alignment, and placement, and its size relative to everything else.
- The subtitle and author treatment, in the same specificity.
- The finish: flat, matte, glossy, textured, cinematic, vector-crisp — and the render quality.
- That it must remain legible at thumbnail size.

BANNED, because they instruct an image model to do nothing: "evocative", "striking", "compelling", "modern design", "beautiful typography", "eye-catching", "professional look", "artistic flair". If you would write one, replace it with the concrete thing it is standing in for.

The ONLY text anywhere on the cover is the title, the subtitle, and the author name. Never instruct the image model to render any other words, labels, or captions.

Avoid the obvious genre cliché. If the subject is time, do not reach for an hourglass. If it is growth, do not reach for a bar chart or a sapling. Earn the image.

Write each prompt as dense descriptive prose in one paragraph — not a bullet list.

Submit your ${count} concepts with the submit_cover_concepts tool. It is the only way to respond.`;

			userPrompt = `Brief for the cover concepts:

Title: "${bookTitle}"
${bookSubtitle ? `Subtitle: "${bookSubtitle}"` : 'Subtitle: none'}
Author: ${bookAuthor || 'Unknown Author'}
Genre / Subject: ${genre}
Writing Tone: ${tone}
  → ${toneGuide}
Book Structure: ${structure}
  → ${structureGuide}

Author's background brief — the richest signal you have about what this book actually argues. This is the material you mine for every concept:
${authorBrief?.trim() || 'None provided. Derive the concepts from the title, subtitle, genre and tone above, and say in "basis" which of them you used.'}
${coverDirection?.trim() ? `\nThe author has also given this art direction. Every concept must honour it:\n${coverDirection.trim()}` : ''}

The title must appear in every prompt exactly as written above: "${bookTitle}"

Submit exactly ${count} concepts.`;

		} else if (action === 'analyze-cover-reference') {
			systemPrompt = `You are a design director reverse-engineering the visual system of a book cover so it can be applied to a completely different book in a completely different subject area.

Extract ONLY the transferable design language — the format. Never the content.

Record:
- Palette: the specific colours (name them concretely, with approximate hex), their proportions, and which one carries the accent.
- Typography: typeface character (serif/sans/slab/condensed/display), weight, case, letter-spacing, alignment, and the size relationship between title, subtitle and author.
- Imagery: whether photographic, illustrated, vector, or absent; how it is treated (lighting, cropping, scrims, duotone, texture); and how much of the cover it occupies.
- Graphic devices: rules, bars, badges, borders, blocks, framing — the repeatable ornament vocabulary.
- Layout: the compositional grid — what sits where, the proportions of each zone, and where the visual weight falls.
- Finish: the overall production feel (flat, glossy, textured, matte, cinematic).

Absolute rules:
- Do NOT describe or name the reference's subject matter, imagery content, niche, genre, title text, author, publisher, or any logo or trademark. Someone reading your output must not be able to tell what the reference book was about.
- Do NOT reproduce the reference's wording.
- Describe structure and treatment only, so the format survives being moved to an unrelated subject.

Respond with a plain-text spec under those six headings. No preamble, no commentary, no markdown fences.`;

			userPrompt = `Extract the transferable design language from this cover. Remember: format only — no subject matter, no wording, no niche.`;

		} else if (action === 'art-direct-illustration') {
			// The image model never sees the book. Whatever this prompt fails to
			// specify, it invents — and an invented interior plate is what makes a
			// book look machine-made. So the prompt is art-directed from what the
			// chapter actually SAYS and what the research actually FOUND, not from
			// the chapter title, which is the only thing the old template had.
			const styleDirection = ultraRealistic
				? `MEDIUM: a documentary reference PHOTOGRAPH, of the standard of a photograph commissioned for a printed manual or a serious trade non-fiction title.
- State a real camera position and a real lens character (e.g. "50mm, waist-level, slight three-quarter angle"), and a real depth of field.
- Light it from ONE identifiable direction with ONE quality (hard window light, diffused overcast, single softbox), and say where the shadow falls.
- Real materials with real wear: honest surface texture, fingerprints, grain, patina, slight misalignment. Perfection reads as fake.
- Neutral warm cream setting; deep navy and amber may appear as incidental colour in the objects themselves.`
				: `MEDIUM: an editorial vector illustration, of the standard of a diagram plate in a well-made printed reference book.
- Warm cream field (#FAF5EA), deep navy linework and solid forms (#0F2231), amber (#E07B20) reserved as the ACCENT — used on at most one element, to point at what matters.
- Flat shapes with subtle depth; consistent stroke weight; geometry that is constructed, not sketched.
- Restrained palette — those three colours plus white. No gradients into unrelated hues.`;

			systemPrompt = `You are an art director at a trade non-fiction publisher, commissioning the single interior plate for one chapter of a book. You write the brief that an image model executes. The image model knows nothing about this book, cannot ask questions, and will invent anything you leave unstated.

═══ 1. THE PLATE MUST COME FROM THIS CHAPTER'S SUBSTANCE ═══

You are given the finished chapter text and the research behind it. Read them. Find ONE specific thing that chapter actually explains — a mechanism, an object, a process, a structure, a comparison, a moment — and build the plate around that one thing.

Record it in "subject", naming the precise passage or finding you drew on.

A plate that illustrates the chapter's CATEGORY rather than its CONTENT is a failure. "A businessman at a laptop" for a chapter on pricing strategy is decoration; it teaches nothing and could sit in any book. If you cannot point to the thing in the chapter that produced the image, you have not art-directed this chapter — you have decorated its genre.

Depict only what the chapter and research support. Do not invent a mechanism, a device, an anatomy, or a process that the source material does not describe. An accurate plain plate beats an impressive wrong one — a reader who knows the subject will catch the error, and it discredits the book.

═══ 2. ABSOLUTELY NO TEXT IN THE IMAGE ═══

The image must contain NO writing of any kind: no title, no subtitle, no caption, no labels, no annotations, no legends, no axis text, no numbers, no measurements, no logos, no watermarks, no signature, no UI text, no lettering on any object, sign, screen, spine, packaging or button.

This is not a stylistic preference — it is the hard constraint. Image models cannot spell; every word they attempt arrives as convincing-looking gibberish and instantly marks the book as machine-made. Any label this chapter genuinely needs is rendered elsewhere in real, typeset text, so the plate must leave that job alone.

Therefore: never build the plate around a device that NEEDS text to work. No labelled diagrams, no flowcharts, no org charts, no annotated schematics, no bar/line/pie charts, no graphs with axes, no tables, no timelines with dates, no signage, no book covers, no screens showing interfaces, no keyboards.

Carry meaning through form instead — through arrangement, scale, sequence, contrast, colour, position, and physical relationship. If your idea collapses without a caption, it is the wrong idea; find one that reads on sight.

═══ 3. IT MUST NOT LOOK AI-GENERATED ═══

Name and avoid the tells:
- No glow. No lens flare, no bloom, no light emanating from nothing, no rim-lit haze, no "energy".
- No glowing blue circuitry, no floating holograms, no translucent HUD panels, no particle swarms, no neural-network filaments, no data streams — the default machine idiom for "concept".
- No mirror-perfect symmetry and no centred-subject-on-empty-background. Compose deliberately and off-centre; let weight sit where the meaning is.
- No plastic sheen, no waxy surfaces, no impossible cleanliness, no chrome-and-glass everything.
- No hands, faces or crowds unless the chapter genuinely requires a person; if it does, keep them incidental, partial, or turned away. Hands are the most reliable tell of all.
- No collage of floating icons. No generic upward arrows. No lightbulbs for ideas, no gears for process, no chess pieces for strategy, no jigsaw pieces for fit, no handshakes for agreement, no hourglasses for time, no sprouting seedlings for growth. These are the clichés the model reaches for first; earn the image instead.
- No stock-photo staging: no posed meetings, no pointing at whiteboards.

Aim for something a human professional would have been commissioned to make: one clear idea, honestly rendered, with the restraint and the small irregularities of real work.

═══ 4. THE BRIEF MUST BE CONCRETE ═══

${styleDirection}

Specify, explicitly:
- The single focal subject: what it IS, its material, its scale, its state, and how it is framed and cropped.
- The composition within a SQUARE (1:1) frame, as zones — where the subject sits, where the weight falls, what occupies the negative space.
- The full palette, with approximate hex values, and which colour is the accent.
- The lighting: direction, quality, and where the shadow falls.
- The background: what it actually is. Never "a plain background".
- The finish and render quality.

BANNED, because they instruct an image model to do nothing: "evocative", "striking", "compelling", "conceptual", "modern", "dynamic", "eye-catching", "professional", "high-quality", "detailed", "beautiful", "artistic". If you would write one, replace it with the concrete thing it stands for.

Write the brief as dense descriptive prose in ONE paragraph, 80–140 words. Not a bullet list.

Return ONLY valid JSON, no markdown fences, no commentary:
{"subject":"the one thing from the chapter this plate depicts, and where in the chapter it came from","prompt":"the one-paragraph brief"}`;

			userPrompt = `Book: "${bookTitle}"${genre ? ` (${genre})` : ''}
Chapter ${chapterOrder}: "${chapterTitle}"
${chapterSummary ? `Planned summary: ${chapterSummary}` : ''}

═══ THE RESEARCH BEHIND THIS CHAPTER ═══
The plate must be accurate to these findings wherever they touch the subject you choose.
${researchNotes?.trim() || 'None retrieved. Work strictly from the chapter text below; invent no specifics it does not state.'}

═══ THE FINISHED CHAPTER TEXT ═══
This is what the chapter actually says. Your subject must come from HERE.
${(chapterContent || '').slice(0, 12_000) || 'Not available. Work from the summary above, and choose a subject conservative enough to be safe without it.'}
${diagramIntent?.trim() ? `
═══ WHAT THIS PLATE IS REPLACING ═══
This plate stands in for a diagram the author placed at this exact point, whose source is below. Read it for the POINT it was making — that point is your subject.

Do not reproduce it as a diagram. It is being replaced precisely because a photograph is wanted here instead, and because a drawn-by-model diagram would carry invented labels and unreliable geometry. Take the idea and stage it as a real, physical scene.

If the diagram's meaning lives entirely in numbers or in an abstract structure — a chart's values, a flowchart's branches, a matrix's quadrants — say so in "subject" and choose the closest honest physical subject the chapter supports instead. Never invent quantities, and never imply a magnitude the chapter does not state.

${diagramIntent.trim().slice(0, 2_000)}
` : ''}
${authorNote?.trim() ? `
═══ THE AUTHOR'S OWN INSTRUCTION FOR THIS PLATE ═══
This is the author speaking directly about this plate. It outranks your own judgement about the subject and the treatment — honour it.

The single exception is text. If they ask for a label, a caption or a title in the picture, apply everything else they asked for and leave the text out: an image model cannot spell, and this plate's labels are set separately in real type where they will be correct.

${authorNote.trim().slice(0, 1_000)}
` : ''}
Art-direct the single interior plate for this chapter. Remember: no text of any kind anywhere in the image, and no device that would need text to work.`;

		} else if (action === 'place-illustration-labels') {
			// The division of labour here is the whole point. The image model draws
			// the plate but cannot spell, so the picture carries no text. Claude can
			// see WHERE things are but must not decide WHAT the chapter teaches. So
			// vision supplies coordinates only; the wording comes from the chapter,
			// and the type is set in real HTML by the plate renderer — which is the
			// only participant that can actually spell.
			systemPrompt = `You are labelling a photographic plate for a printed reference manual. You are given the finished chapter, the research behind it, and the plate itself. You return callout labels: what to point at, and exactly where it is in the frame.

═══ 1. THE WORDING COMES FROM THE CHAPTER — NOT FROM THE PICTURE ═══

Your labels must name what the CHAPTER teaches, using the chapter's own terminology. You are not captioning a photograph; you are pointing at the parts that carry the lesson.

A label is worth including only if the chapter explains why that part matters. "Bucket" is a description of the picture. "Bucket containment" is the chapter's point. If the chapter never mentions a thing, do not label it, however prominent it is in the frame.

Use the chapter's exact vocabulary. If the chapter calls it a "P-trap slip nut", the label says "P-trap slip nut" — not "pipe joint". Never invent a term the chapter and research do not use, and never label a part with a name you are not certain is correct. A confidently wrong label teaches the reader something false and discredits the book; a missing label costs nothing.

═══ 2. THE POSITION COMES FROM THE PICTURE ═══

Look at the actual image. For each label, give the coordinates of the thing itself — the exact point a leader line should touch.

- "x" and "y" are PERCENTAGES of the image, 0–100. x=0 is the left edge, x=100 the right. y=0 is the TOP edge, y=100 the bottom.
- Point at the FEATURE, not at empty space near it. If you name the slip nut, the coordinate lands ON the slip nut.
- If you cannot actually see the thing you want to label, or cannot locate it precisely, OMIT that label. Do not approximate, and do not place a label for something you merely expect to be there because the chapter mentions it. A label pointing at the wrong part is worse than no label.

Set "side" to the direction the label box should sit relative to its point — "left" or "right" — choosing whichever has empty space, so the box never covers the subject.

Set "confidence" to "high" only when you can see the feature clearly and are certain of its identity. Anything less is "low", and low-confidence labels are discarded.

═══ 3. RESTRAINT ═══

At most 5 labels. Fewer is better. A plate with 3 labels that each carry a teaching point beats one with 8 that inventory the photograph.

Do not label the obvious ("wall", "floor", "bucket") unless the chapter gives it a role. Do not overlap: keep every point at least 12 percentage units from every other point, so the boxes do not collide.

Return ONLY valid JSON, no markdown fences, no commentary:
{"labels":[{"text":"the chapter's own term, 1–4 words","x":0-100,"y":0-100,"side":"left|right","confidence":"high|low","basis":"where in the chapter this term comes from"}]}

If nothing can be labelled accurately, return {"labels":[]}. That is a valid, correct answer.`;

			userPrompt = `Book: "${bookTitle}"${genre ? ` (${genre})` : ''}
Chapter ${chapterOrder}: "${chapterTitle}"
${illustrationSubject ? `\nWhat this plate was commissioned to show:\n${illustrationSubject}` : ''}

═══ THE RESEARCH BEHIND THIS CHAPTER ═══
${researchNotes?.trim() || 'None retrieved.'}

═══ THE FINISHED CHAPTER TEXT ═══
Your label wording must come from here.
${(chapterContent || '').slice(0, 12_000) || 'Not available — label only what you are certain of, or return an empty list.'}

The plate is the attached image. Label it: the chapter decides what is worth pointing at, the image decides where it is.`;
		}

		// Cover concepts run on their own call path: they are the only action that
		// forces a tool schema and retries on a quality failure, and keeping that
		// out of the chapter pipeline below means neither can regress the other.
		if (action === 'cover-concepts') {
			const concepts = await generateCoverConcepts({
				apiKey:    activeApiKey,
				model:     selectedModel,
				systemPrompt,
				userPrompt,
				count:     Math.max(1, Math.min(6, conceptCount || 3)),
				bookTitle: bookTitle || ''
			});
			return json({ success: true, concepts, source: 'live' });
		}

		// Make HTTP request to Anthropic
		// Use a faster model for the structured-JSON actions (outline, distill) and
		// tighten max_tokens to match actual output size. Distilling runs once per
		// chapter — 30 extra calls on a 600-page book — so it has to be cheap.
		const requestModel = action === 'outline' || action === 'distill-chapter'
			? (CLAUDE_CHAT_MODEL || 'claude-haiku-4-5-20251001')
			: selectedModel;

		// Reading a reference cover is a small, non-streamed vision call like the
		// outline — it must never be held to the 10-minute chapter timeout.
		const isCoverAction = action === 'analyze-cover-reference';

		// Art direction is another small, non-streamed JSON call: it reads a
		// chapter and writes back a single paragraph, so it belongs with the
		// outline rather than under the 10-minute chapter timeout.
		const isArtDirection = action === 'art-direct-illustration';

		// Labelling is a vision call — small output, but it must fetch and read an
		// image, so it gets the same 60s ceiling as the other vision action rather
		// than the 8s that would abort a legitimate read.
		const isLabelling = action === 'place-illustration-labels';

		// Size the output budget from the actual work, not a fixed guess. A
		// verify pass echoes the whole chapter back after the report, so its
		// budget has to scale with the draft it is given or long chapters get
		// truncated mid-sentence.
		const maxTokens =
			action === 'write-chapter'  ? budgetForWrite(plan.wordsPerChapter) :
			action === 'verify-chapter' ? budgetForVerify(chapterContent) :
			action === 'analyze-cover-reference' ? 1_500 :
			/* art direction — a subject line plus a 140-word brief. Reads a long
			   chapter, writes very little. */
			action === 'art-direct-illustration' ? 1_200 :
			/* labelling — at most 5 short labels with coordinates. */
			action === 'place-illustration-labels' ? 1_500 :
			/* distill — at most 8 short entries; the cap is deliberate, an
			   overlong distillation is a bug, not a feature. */
			action === 'distill-chapter' ? 1_500 :
			/* outline — scales with CHAPTER COUNT: a 600-page book plans ~30
			   chapters, and a fixed ceiling truncates the JSON mid-array. */
			budgetForOutline(plan.chapterCount);

		const controller = new AbortController();
		// Streamed requests only need to survive gaps between chunks, so the
		// ceiling can be generous without risking a silent HTTP timeout.
		const timeoutMs = action === 'outline' || action === 'distill-chapter' || isCoverAction || isArtDirection || isLabelling ? 60_000 : 600_000;
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		// Anthropic requires streaming once max_tokens is large enough that a
		// single buffered response could exceed the request timeout. The small
		// JSON actions are nowhere near it.
		const useStream = action !== 'outline' && action !== 'distill-chapter' && !isCoverAction && !isArtDirection && !isLabelling;

		// Reference-cover analysis is the only vision call in the app: the image
		// rides as a content block ahead of the instruction text.
		// Fetch the plate ourselves rather than handing Anthropic the URL.
		//
		// The URL source type looks simpler, but it makes labelling depend on the
		// image host being willing to serve Anthropic's fetcher — and hosts that
		// require a User-Agent reject it, which fails the whole call with an
		// opaque "unable to download the file". Fetching here means labelling
		// works for any image the app itself can reach, which is the same bar the
		// reader and the PDF export already have to clear. It also matches the
		// reference-cover vision call, which is base64 for the same reason.
		const labelImage = isLabelling ? await fetchImageAsBase64(imageUrl) : null;

		const userContent = action === 'analyze-cover-reference' && referenceImage?.data
			? [
					{
						type: 'image',
						source: {
							type: 'base64',
							media_type: referenceImage.mediaType || 'image/jpeg',
							data: referenceImage.data
						}
					},
					{ type: 'text', text: userPrompt }
				]
			: isLabelling
			? [
					// The image leads the turn: Claude attends to instructions that
					// follow an image more reliably than ones that precede it — the
					// same ordering the cover assistant's vision call uses.
					{
						type: 'image',
						source: { type: 'base64', media_type: labelImage!.mediaType, data: labelImage!.data }
					},
					{ type: 'text', text: userPrompt }
				]
			: userPrompt;

		if (action === 'analyze-cover-reference' && !referenceImage?.data) {
			throw new Error('No reference cover image was supplied.');
		}

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
					model: requestModel,
					max_tokens: maxTokens,
					stream: useStream,
					system: systemPrompt,
					messages: [
						{ role: 'user', content: userContent }
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
		} else if (action === 'distill-chapter') {
			// A malformed distillation is a non-event: the caller treats any
			// failure here as "no new bible entries" and writes on. So parse
			// defensively and never let this action be the thing that breaks a book.
			try {
				const start = responseText.indexOf('[');
				const end = responseText.lastIndexOf(']');
				if (start === -1 || end <= start) throw new Error('no JSON array in response');

				const raw = JSON.parse(responseText.substring(start, end + 1));
				const kinds = ['term', 'claim', 'example', 'stat'];
				const entries = (Array.isArray(raw) ? raw : [])
					.filter((e: any) => e && kinds.includes(e.kind) && e.label && e.detail)
					.slice(0, 8)
					.map((e: any) => ({
						kind: e.kind,
						label: String(e.label).trim(),
						detail: String(e.detail).trim(),
						chapter: chapterOrder || 0
					}));

				return json({ success: true, entries, source: 'live' });
			} catch (parseError) {
				console.error('Failed to parse distill JSON:', responseText);
				throw new Error('Claude did not return a valid JSON distillation.');
			}
		} else if (action === 'analyze-cover-reference') {
			const format = responseText.trim();
			if (!format) throw new Error('Claude returned an empty reference analysis. Please try again.');
			return json({ success: true, format, source: 'live' });
		} else if (action === 'art-direct-illustration') {
			// The no-text ban is appended in code rather than left to the model to
			// remember. It is the one rule whose failure is visible on every page —
			// gibberish lettering is the tell that the book was machine-made — and a
			// brief that simply forgets to mention text still licenses the image
			// model to add it. Last, so it is the final thing the image model reads.
			try {
				const start = responseText.indexOf('{');
				const end   = responseText.lastIndexOf('}');
				if (start === -1 || end <= start) throw new Error('no JSON object in response');

				const parsed = JSON.parse(responseText.substring(start, end + 1));
				const brief  = String(parsed.prompt ?? '').trim();
				if (!brief) throw new Error('empty prompt');

				return json({
					success: true,
					subject: String(parsed.subject ?? '').trim(),
					prompt:  `${brief} ${NO_TEXT_CLAUSE}`,
					source:  'live'
				});
			} catch (parseError) {
				console.error('Failed to parse art-direction JSON:', responseText);
				throw new Error('Claude did not return a valid illustration brief.');
			}
		} else if (action === 'place-illustration-labels') {
			// Every filter here drops labels rather than repairing them. A label is
			// a printed claim about what a part of the picture IS — a wrong one
			// teaches the reader something false and they have no way to catch it.
			// A missing one costs nothing but a label. So anything not clearly
			// right is discarded, and an empty list is a perfectly good answer.
			try {
				const start = responseText.indexOf('{');
				const end   = responseText.lastIndexOf('}');
				if (start === -1 || end <= start) throw new Error('no JSON object in response');

				const parsed = JSON.parse(responseText.substring(start, end + 1));
				const raw    = Array.isArray(parsed.labels) ? parsed.labels : [];

				const labels = raw
					.filter((l: any) => l && typeof l.text === 'string' && l.text.trim())
					// The model was told to self-report; honour it. It is the only
					// signal for "I could not actually see this".
					.filter((l: any) => l.confidence === 'high')
					// Coordinates are percentages. Anything outside the frame is a
					// misread, not something to clamp onto the nearest edge — that
					// would pin a leader line to a spot nobody identified.
					.filter((l: any) => {
						const x = Number(l.x), y = Number(l.y);
						return Number.isFinite(x) && Number.isFinite(y) &&
						       x >= 0 && x <= 100 && y >= 0 && y <= 100;
					})
					.slice(0, 5)
					.map((l: any) => ({
						text: String(l.text).trim().slice(0, 40),
						x:    Number(l.x),
						y:    Number(l.y),
						side: sideFor(Number(l.x), l.side)
					}));

				return json({ success: true, labels, source: 'live' });
			} catch (parseError) {
				console.error('Failed to parse illustration labels:', responseText);
				throw new Error('Claude did not return valid illustration labels.');
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
/** The image types the Messages API accepts. SVG is not among them — which is
 *  why mock mode's inline SVG placeholder can never be labelled. */
const VISION_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Which side of its anchor a callout box sits on.
 *
 * Near either edge the box must point INWARD or it overflows the plate and gets
 * clipped — a label half off the page is worse than one sitting over the
 * picture. Claude picks a side by looking for empty space, but it is judging a
 * box whose rendered width it cannot know, so its preference is only honoured
 * in the middle band where either direction fits.
 */
function sideFor(x: number, preferred: unknown): 'left' | 'right' {
	if (x > 58) return 'left';   // near the right edge — extend back into frame
	if (x < 42) return 'right';  // near the left edge  — extend back into frame
	return preferred === 'left' ? 'left' : 'right';
}

/**
 * Fetch a remote image and return it base64-encoded, ready to ride as a vision
 * content block.
 *
 * Mirrors /api/proxy: same User-Agent (some CDNs reject requests without one —
 * this is exactly what breaks handing Anthropic a bare URL), same image-only
 * content-type check.
 *
 * Throws rather than returning null: every caller treats a labelling failure as
 * "no labels", so the message only ever reaches a log, and a precise one is
 * worth more there than a silent empty list.
 */
async function fetchImageAsBase64(url: string): Promise<{ data: string; mediaType: string }> {
	if (!/^https?:\/\//i.test(url ?? '')) {
		throw new Error('Illustration labelling needs an http(s) image URL.');
	}

	const res = await fetch(url, {
		headers: { 'User-Agent': 'EbookAutomator/1.0 (illustration-labeller)' }
	});
	if (!res.ok) throw new Error(`Could not fetch the illustration (${res.status}).`);

	const mediaType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!VISION_MEDIA_TYPES.includes(mediaType)) {
		throw new Error(`Illustration is not a supported image type (${mediaType || 'unknown'}).`);
	}

	const buf = await res.arrayBuffer();
	// The API rejects images past ~5MB. Catching it here names the actual
	// problem instead of surfacing a size error from Anthropic.
	if (buf.byteLength > 4_500_000) {
		throw new Error('Illustration is too large to label.');
	}

	return { data: Buffer.from(buf).toString('base64'), mediaType };
}

function estimateTokens(text: string): number {
	return Math.ceil((text?.length ?? 0) / 3.5);
}

/** A fresh chapter's ceiling scales with how long the book's chapters should be. */
/**
 * Outline output is a JSON array of chapter objects. Each entry is roughly
 * 80–120 tokens. Long books can have 15+ chapters, so the old 900-token fixed
 * ceiling truncated the JSON mid-array and caused a parse failure.
 */
function budgetForOutline(chapterCount: number): number {
	// Each chapter entry is a JSON object with a title and a 2-3 sentence
	// summary — roughly 120 tokens, and they run long more often than short.
	// A 30-chapter book therefore needs ~4.5k just for the array, which the
	// old fixed 4k ceiling would have truncated mid-entry.
	const needed = chapterCount * 160 + 800; // + framing/overhead
	return Math.min(Math.max(needed, 1_500), MODEL_OUTPUT_CAP);
}

function budgetForWrite(wordsPerChapter: number): number {
	// ~1.4 tokens/word, plus generous headroom so a chapter that runs long is
	// never cut mid-sentence. Sized from the chapter's own target rather than
	// the book's total: the output cap is per-response, so what matters is how
	// much THIS chapter has to emit.
	const target = Math.ceil(wordsPerChapter * 1.4 * 1.6);
	return Math.min(Math.max(target, 8_000), MODEL_OUTPUT_CAP);
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

// ── Cover concepts ────────────────────────────────────────────────────────

export interface CoverConcept {
	style:   string;
	basis:   string;
	concept: string;
	prompt:  string;
}

/** Dense prose specifying palette, composition, focal image, typography and
 *  finish does not fit in less than this. A prompt under it is a sketch, and a
 *  sketch handed to an image model comes back as a generic cover. */
const MIN_CONCEPT_PROMPT_CHARS = 500;
const CONCEPT_MAX_TOKENS       = 6_000;
const CONCEPT_TIMEOUT_MS       = 180_000;
/** One repair pass. A second has never been worth the wall-clock in practice —
 *  if the model misses twice, the brief is the problem, not the sampling. */
const CONCEPT_ATTEMPTS         = 2;

/**
 * Forcing a tool call is what makes this robust: the API validates the shape
 * before we ever see it, so malformed JSON — the failure mode of asking for a
 * bare array in prose — cannot reach us. What the schema cannot enforce is
 * whether a concept is concrete or actually derived from the brief, which is
 * what validateConcepts and the repair pass are for.
 */
function coverConceptTool(count: number) {
	return {
		name: 'submit_cover_concepts',
		description: `Submit exactly ${count} original, fully-specified book cover concepts derived from the author's brief.`,
		input_schema: {
			type: 'object',
			properties: {
				concepts: {
					type: 'array',
					minItems: count,
					maxItems: count,
					items: {
						type: 'object',
						properties: {
							style: {
								type: 'string',
								description: 'A 2–4 word name for this concept, e.g. "The Last Drop".'
							},
							basis: {
								type: 'string',
								description:
									"The specific element of the author's brief this concept is built on, quoting their own words where possible. " +
									'Must name a concrete idea, image, object, moment or tension from THIS book — never a genre generality.'
							},
							concept: {
								type: 'string',
								description: 'One sentence: the visual idea, and why it fits this particular book.'
							},
							prompt: {
								type: 'string',
								description:
									'The complete image-generation prompt, as one paragraph of dense descriptive prose. Must fully specify palette with approximate hex values, ' +
									'composition zones with rough percentages, the focal image and its lighting, the verbatim title text in quotes with its typeface character, weight, case and placement, ' +
									'the subtitle and author treatment, and the finish and render quality.'
							}
						},
						required: ['style', 'basis', 'concept', 'prompt']
					}
				}
			},
			required: ['concepts']
		}
	};
}

/**
 * Reject what the schema cannot: prompts too thin to produce a designed cover,
 * concepts that never name what in the brief produced them, a title the image
 * model was never given, and duplicates. Returns the survivors plus a
 * description of what went wrong, which is fed back on the repair pass.
 */
function validateConcepts(raw: any, count: number, bookTitle: string): { ok: CoverConcept[]; problem: string } {
	const list = Array.isArray(raw?.concepts) ? raw.concepts : [];
	const ok: CoverConcept[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();

	for (const c of list) {
		const style   = String(c?.style   ?? '').trim();
		const basis   = String(c?.basis   ?? '').trim();
		const concept = String(c?.concept ?? '').trim();
		const prompt  = String(c?.prompt  ?? '').trim();
		const label   = style || 'an unnamed concept';

		if (!style || !prompt) {
			problems.push(`${label} was missing its style name or its prompt`);
			continue;
		}
		if (prompt.length < MIN_CONCEPT_PROMPT_CHARS) {
			problems.push(
				`the prompt for "${style}" was only ${prompt.length} characters — too thin to specify palette, composition, focal image, typography and finish`
			);
			continue;
		}
		// Case-insensitive: a prompt may legitimately set the title in caps.
		if (bookTitle && !prompt.toLowerCase().includes(bookTitle.toLowerCase())) {
			problems.push(`the prompt for "${style}" never contains the title text "${bookTitle}", so the image model cannot set it`);
			continue;
		}
		if (!basis) {
			problems.push(`"${style}" did not state which part of the author's brief it derives from`);
			continue;
		}
		if (seen.has(style.toLowerCase())) {
			problems.push(`two concepts were both named "${style}"`);
			continue;
		}

		seen.add(style.toLowerCase());
		ok.push({ style, basis, concept, prompt });
	}

	if (ok.length < count) problems.push(`only ${ok.length} of ${count} concepts were usable`);
	return { ok: ok.slice(0, count), problem: problems.join('; ') };
}

/**
 * Devise cover concepts from the Step 1 brief, with one repair pass.
 *
 * Degrades rather than fails: a partial set of good concepts beats an error,
 * because the author still has the templates and can simply ask again.
 */
async function generateCoverConcepts(opts: {
	apiKey: string;
	model: string;
	systemPrompt: string;
	userPrompt: string;
	count: number;
	bookTitle: string;
}): Promise<CoverConcept[]> {
	const tool = coverConceptTool(opts.count);
	let best: CoverConcept[] = [];
	let problem = '';

	for (let attempt = 1; attempt <= CONCEPT_ATTEMPTS; attempt++) {
		// The repair pass is stateless — the failure is appended to a fresh
		// request rather than continued as a conversation, because the previous
		// turn was a forced tool call and replaying it buys nothing.
		const userPrompt = attempt === 1
			? opts.userPrompt
			: `${opts.userPrompt}\n\nYour previous submission was rejected: ${problem}.\nEvery concept must satisfy every requirement. Submit ${opts.count} corrected concepts.`;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CONCEPT_TIMEOUT_MS);

		let data: any;
		try {
			const response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': opts.apiKey,
					'anthropic-version': '2023-06-01'
				},
				body: JSON.stringify({
					model: opts.model,
					max_tokens: CONCEPT_MAX_TOKENS,
					system: opts.systemPrompt,
					tools: [tool],
					tool_choice: { type: 'tool', name: tool.name },
					messages: [{ role: 'user', content: userPrompt }]
				})
			});

			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Anthropic API error (${response.status}): ${errText}`);
			}
			data = await response.json();
		} catch (err: any) {
			if (err.name === 'AbortError') {
				throw new Error(`Claude timed out after ${CONCEPT_TIMEOUT_MS / 1000}s devising cover concepts. Please try again.`);
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}

		if (data.stop_reason === 'max_tokens') {
			problem = 'the submission was cut off before it was complete — keep each prompt to one tight paragraph';
			continue;
		}

		const toolInput = data.content?.find((c: any) => c.type === 'tool_use' && c.name === tool.name)?.input;
		const { ok, problem: found } = validateConcepts(toolInput, opts.count, opts.bookTitle);

		if (ok.length >= opts.count) return ok;
		if (ok.length > best.length) best = ok;
		problem = found;
		console.warn(`[cover-concepts] attempt ${attempt} rejected: ${found}`);
	}

	if (best.length > 0) return best;
	throw new Error(`Claude could not produce usable cover concepts (${problem}). Please try again.`);
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
