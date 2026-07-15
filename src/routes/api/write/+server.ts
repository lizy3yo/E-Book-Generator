import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { CLAUDE_WRITING_MODEL, CLAUDE_OPUS_MODEL } from '$env/static/private';

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

		// claude-opus-4 → heavyweight flagship; default → sonnet-5 for best quality/speed
		const selectedModel = model === 'claude-opus-4'
			? (CLAUDE_OPUS_MODEL || 'claude-opus-4-8')
			: (CLAUDE_WRITING_MODEL || 'claude-sonnet-5');

		// Handle Mock Mode
		if (useMockMode || !apiKey) {
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

		const toneGuide     = toneInstructions[tone]     ?? `Write in a ${tone} voice.`;
		const structureGuide = structureInstructions[structure] ?? `Follow a ${structure} format.`;

		if (action === 'outline') {
			systemPrompt = `You are a senior acquisitions editor at a major publishing house with 20 years of experience structuring bestselling non-fiction ebooks.
Your task is to produce a publication-ready chapter outline.
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
			systemPrompt = `You are a professional ebook author writing for a commercial publishing house.

TONE DIRECTIVE — ${tone}:
${toneGuide}

FORMATTING RULES:
- Use Markdown: ## for section headings, ### for sub-sections, ** for bold key terms, * for italics.
- Open each section with a strong topic sentence.
- Use real examples, data points, and named case studies where possible.
- End the chapter with a concise "Key Takeaways" or transition paragraph that points to the next chapter.
- Do NOT include a chapter number header — start directly with the first section heading.
- Do NOT include sign-offs, pleasantries, or meta-commentary about the writing.
- Aim for substantial depth: each chapter should read as a complete, standalone piece of professional writing.

VISUAL ELEMENTS & LAYOUT DIRECTIVES (Align content with professional, publication-ready ebook standards):
1. TABLES FOR COMPARISONS: If the section lists scenarios, checklists, comparisons, or lookup guides, format them using standard markdown tables.
   Example:
   | Done | Fix | Notes |
   | :--- | :--- | :--- |
   | [ ] | 1. Find main water shutoff | Located in basement or near street meter |
2. PROFESSIONAL CALLOUT BOXES: For tips, definitions, specific guidelines, warning checklists, or important rules, wrap them in clean HTML callout divs.
   Structure:
   <div class="callout-box">
     <span class="callout-box__title">ROGER'S RULE / SAFETY WARNING / KEY CHECKPOINT</span>
     <div class="callout-box__content">Detailed practical rule or checklist items...</div>
   </div>
3. DIAGRAMS & FLOWCHARTS: Where a sequence of steps, a loop/cycle, or visual anatomy is described (e.g. "Water Shutoff Loop" or "Leak-Trace Decision Tree"), write a visual diagram block using a clean HTML flex container matching these classes:
   Structure:
   <div class="diagram-box">
     <div class="diagram-box__title">Diagram Title (e.g., Faucet Anatomy)</div>
     <div class="diagram-box__subtitle">Sub-label detail</div>
     <div class="diagram-flow">
       <div class="diagram-step">
         <div class="diagram-step__num">1. See It</div>
         <div class="diagram-step__text">Observe stain or dampness</div>
       </div>
       <div class="diagram-arrow">➔</div>
       <div class="diagram-step">
         <div class="diagram-step__num">2. Stop Damage</div>
         <div class="diagram-step__text">Locate shutoff immediately</div>
       </div>
       <!-- Add arrows and steps as needed -->
     </div>
     <div class="diagram-takeaway">Short summary takeaway about this diagram...</div>
   </div>`;

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
			systemPrompt = `You are a professional copy-editor and fact-checker at a publishing house.
Your job is to review a drafted ebook chapter for:
1. Factual accuracy against the provided research notes
2. Internal consistency and logical flow
3. Tone adherence — the chapter should match the declared tone
4. Structural completeness — does it fulfil the chapter brief?
5. Grammar, clarity, and prose quality

Return your response in EXACTLY this format with no deviation:
---REPORT---
[Concise bullet-point report: flag any factual issues, tone deviations, structural gaps, or prose weaknesses. If all clear, state so.]
---CONTENT---
[The fully polished, corrected chapter content in Markdown]`;

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
		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: selectedModel,
				max_tokens: action === 'write-chapter' ? 4000 : 2000,
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

		const data = await response.json();
		const responseText = data.content?.[0]?.text || '';

		if (action === 'outline') {
			// Extract JSON array
			try {
				// Clean potential markdown wrap
				let cleanJson = responseText.trim();
				if (cleanJson.startsWith('```json')) {
					cleanJson = cleanJson.substring(7);
				}
				if (cleanJson.endsWith('```')) {
					cleanJson = cleanJson.substring(0, cleanJson.length - 3);
				}
				cleanJson = cleanJson.trim();

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
