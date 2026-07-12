import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

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

		const selectedModel = model === 'claude-opus-4' ? 'claude-3-opus-20240229' : 'claude-3-5-sonnet-20241022';

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

		if (action === 'outline') {
			systemPrompt = 'You are a professional acquisitions editor and structuring assistant. Create a detailed outline for a book. Respond ONLY with a valid JSON array of chapters, where each chapter is an object: {"title": "Chapter Title", "order": 1, "summary": "Detailed summary of what the chapter covers"}. Do not add markdown wrapping or chat pleasantries.';
			userPrompt = `Please create an outline for a book titled "${bookTitle}".
Genre: ${genre}
Tone: ${tone}
Target Length: ${length}
Structure: ${structure}
Grounding Research Notes: ${researchNotes || 'None'}

Return ONLY a JSON array.`;
		} else if (action === 'write-chapter') {
			systemPrompt = `You are a best-selling author. Write a highly detailed, professional, and engaging book chapter. 
Use a minimalist, elegant book style with Markdown formatting (use headings, quotes, lists where appropriate). 
Integrate the provided research notes seamlessly to ground your writing and avoid hallucinations. 
Do not include chat greeting/signature. Start directly with the writing.`;
			userPrompt = `Book Title: "${bookTitle}"
Chapter Title: "${chapterTitle}"
Chapter Number: ${chapterOrder}
Chapter Summary: ${chapterSummary}
Tone: ${tone}
Semantic Research Notes to integrate:
${researchNotes || 'None'}

Please write the complete chapter content. Try to make it thorough, detailed, and professional (aim for a substantial narrative length).`;
		} else if (action === 'verify-chapter') {
			systemPrompt = `You are a critical copy-editor and fact-checker. 
Review the provided chapter content for structural consistency, logical flow, contradictions, and factual correctness based on research grounding. 
Provide a brief fact-checking report and then output the polished, corrected chapter content. 
Structure your response like this:
---REPORT---
[Your fact-checking/consistency report here]
---CONTENT---
[The polished chapter content here]`;
			userPrompt = `Book Title: "${bookTitle}"
Chapter Title: "${chapterTitle}"
Grounding Research Notes:
${researchNotes || 'None'}

Here is the draft chapter content:
${chapterContent}

Please review, self-correct, and return the report and the content.`;
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
