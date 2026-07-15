import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { CLAUDE_WRITING_MODEL, CLAUDE_OPUS_MODEL } from '$env/static/private';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const {
			action,
			// 'edit-page' | 'edit-chapter' | 'edit-illustration'
			// 'reconstruct-chapter' | 'reconstruct-page'
			apiKey,
			useMockMode,
			model,
			// book context
			bookTitle,
			genre,
			tone,
			structure,
			// chapter context
			chapterTitle,
			chapterOrder,
			chapterSummary,   // original chapter brief — used by reconstruct actions
			chapterContent,   // full current chapter markdown (edit-chapter / edit-page)
			// page context (edit-page only)
			pageContent,      // the plain text of just the target page
			// illustration context (edit-illustration only)
			illustrationPrompt,
			// user's editing instruction (absent for reconstruct)
			editInstruction
		} = await request.json();

		const selectedModel =
			model === 'claude-opus-4'
				? (CLAUDE_OPUS_MODEL || 'claude-opus-4-8')
				: (CLAUDE_WRITING_MODEL || 'claude-sonnet-5');

		// ── Mock mode ──────────────────────────────────────────────────────────
		if (useMockMode || !apiKey) {
			await new Promise((r) => setTimeout(r, 2000));

			if (action === 'edit-chapter') {
				return json({
					success: true,
					content: `## ${chapterTitle}\n\n### Opening\n\nThis chapter has been revised based on your instruction. The core ideas have been sharpened and the prose refined to better serve the reader.\n\n### Development\n\nThe revised content maintains the original structure while applying the requested changes throughout. Each section has been updated to reflect the new direction while preserving continuity with the surrounding chapters.\n\n### Conclusion\n\nThe key principles established in this chapter lay the groundwork for what follows. Readers should now have a clearer understanding of the central ideas explored in *${bookTitle}*.`,
					source: 'mock'
				});
			}
			if (action === 'edit-page') {
				return json({
					success: true,
					pageContent: `The revised passage reflects the requested changes. The ideas presented here have been rewritten to better align with the instruction while maintaining the voice and flow of the surrounding chapter content. This serves as a placeholder in mock mode — in live mode, Claude will apply the exact instruction to produce publication-ready prose.`,
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
					content: `## ${chapterTitle}\n\n### The Foundation\n\nEvery meaningful work begins with a clear articulation of its purpose. In the context of *${bookTitle}*, this chapter establishes the conceptual bedrock upon which subsequent arguments are built. The ideas explored here are not merely introductory — they are foundational in the strictest sense.\n\n### Core Arguments\n\nThe central thesis of this chapter rests on three interconnected pillars. First, that complexity need not preclude clarity. Second, that rigour and accessibility are complementary rather than competing virtues. Third, that the reader's experience must always remain the primary measure of quality.\n\n### Looking Forward\n\nThe principles introduced here will recur throughout the book in increasingly practical forms. Each subsequent chapter builds directly on this foundation, testing these ideas against real-world contexts and refining them through application.`,
					source: 'mock'
				});
			}
			if (action === 'reconstruct-page') {
				return json({
					success: true,
					pageContent: `The ideas on this page have been reconstructed from the chapter brief. In a fully realised version, this passage would develop one of the chapter's core arguments through a combination of narrative, evidence, and analysis. The prose would maintain the book's established voice while advancing the reader's understanding in a concrete and memorable way.`,
					source: 'mock'
				});
			}
		}

		// ── Live API — Anthropic ───────────────────────────────────────────────
		let systemPrompt = '';
		let userPrompt = '';

		if (action === 'edit-chapter') {
			// Apply a specific instruction to existing chapter content — preserves structure
			systemPrompt = `You are a professional ebook editor working on "${bookTitle}" (${genre}).
The chapter is written in a "${tone}" voice — preserve this voice in all edits.

Your task is to apply the user's editing instruction to the full chapter content.
Rules:
- Return ONLY the revised chapter content in Markdown — no commentary, no meta-text.
- Preserve the chapter's existing structure (headings, sections, flow) unless the instruction explicitly changes it.
- Keep or improve prose quality; never make the writing worse.
- If the instruction is stylistic (e.g. "make it shorter"), apply it uniformly across the whole chapter.
- Do NOT add a chapter-number heading at the top.`;

			userPrompt = `Chapter ${chapterOrder}: "${chapterTitle}"

Editing instruction:
"${editInstruction}"

Current chapter content:
${chapterContent}

Apply the instruction and return the revised chapter now.`;

		} else if (action === 'reconstruct-chapter') {
			// Full fresh rewrite — existing content is NOT sent; only the brief drives the output
			systemPrompt = `You are a professional ebook author writing for a commercial publishing house.
Book: "${bookTitle}" | Genre: ${genre} | Tone: ${tone}${structure ? ` | Structure: ${structure}` : ''}

Your task is to write a COMPLETELY FRESH version of a chapter from scratch.
Rules:
- Write entirely new prose — do NOT reference, copy, or paraphrase the existing content.
- Anchor your writing to the chapter brief; it defines the scope and purpose of this chapter.
- Use the declared tone and genre conventions throughout.
- Use Markdown: ## for section headings, ### for sub-headings, > for block quotes, ** for bold key terms.
- Open with a strong hook. End with a concise synthesis or forward bridge to the next chapter.
- Do NOT include a chapter-number heading at the top.
- Aim for the same approximate depth and length as a professionally published trade ebook chapter.`;

			userPrompt = `Chapter ${chapterOrder}: "${chapterTitle}"

Chapter brief (your sole creative brief — write to this, not to any prior draft):
${chapterSummary || `Write a comprehensive chapter on the topic of "${chapterTitle}" for a book about "${bookTitle}".`}

Write the complete fresh chapter now.`;

		} else if (action === 'edit-page') {
			// Apply a specific instruction to a single page passage
			systemPrompt = `You are a professional ebook editor working on "${bookTitle}" (${genre}).
The book is written in a "${tone}" voice — preserve this exactly.

Your task is to rewrite a specific passage from Chapter ${chapterOrder}: "${chapterTitle}" based on the user's instruction.
Rules:
- Return ONLY the rewritten passage in Markdown — nothing else.
- Match the length of the original passage unless the instruction asks for more or less.
- Do not add headings the original passage did not have.
- Maintain voice, tense, and style consistency with the rest of the chapter.`;

			userPrompt = `Full chapter context (for reference — do NOT rewrite this):
${chapterContent}

---

Passage to rewrite (this exact excerpt from the chapter):
${pageContent}

---

Editing instruction:
"${editInstruction}"

Return only the rewritten passage.`;

		} else if (action === 'reconstruct-page') {
			// Fresh rewrite of a single page — uses chapter context for continuity, ignores existing page
			systemPrompt = `You are a professional ebook author working on "${bookTitle}" (${genre}).
The book is written in a "${tone}" voice.

Your task is to write a COMPLETELY FRESH passage to replace a specific page in Chapter ${chapterOrder}: "${chapterTitle}".
Rules:
- Write entirely new prose that fits naturally into the surrounding chapter content.
- Do NOT copy, paraphrase, or reference the existing passage.
- Use the chapter context to maintain logical and narrative continuity.
- Match the approximate length of the original passage.
- Return ONLY the new passage in Markdown — no commentary, no labels.
- Maintain voice, tense, and style consistency with the chapter.`;

			userPrompt = `Chapter context (for continuity — do NOT copy this):
${chapterContent}

---

Existing passage being replaced (write something entirely different):
${pageContent}

Write the fresh replacement passage now.`;

		} else if (action === 'edit-illustration') {
			// Refine an image generation prompt based on user direction
			systemPrompt = `You are an expert at writing precise, descriptive prompts for AI image generation.
Your task is to take an existing illustration prompt and apply a user's instruction to produce an improved prompt.
Rules:
- Return ONLY the final prompt string — no commentary, no quotes, no labels.
- Keep the artistic style terms from the original prompt.
- The prompt must be under 500 characters.
- Be highly specific about visual elements, lighting, composition, and style.`;

			userPrompt = `Original illustration prompt for Chapter ${chapterOrder}: "${chapterTitle}" of "${bookTitle}":
${illustrationPrompt}

User's instruction:
"${editInstruction}"

Write the improved image generation prompt now.`;

		} else {
			throw new Error(`Unknown edit action: "${action}"`);
		}

		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: selectedModel,
				max_tokens: (action === 'edit-chapter' || action === 'reconstruct-chapter') ? 4000 : 1500,
				system: systemPrompt,
				messages: [{ role: 'user', content: userPrompt }]
			})
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Anthropic API error (${response.status}): ${errText}`);
		}

		const data = await response.json();
		const text = (data.content?.[0]?.text || '').trim();

		if (action === 'edit-chapter' || action === 'reconstruct-chapter') {
			return json({ success: true, content: text, source: 'live' });
		}
		if (action === 'edit-page' || action === 'reconstruct-page') {
			return json({ success: true, pageContent: text, source: 'live' });
		}
		if (action === 'edit-illustration') {
			return json({ success: true, prompt: text, source: 'live' });
		}

		throw new Error('Unhandled action after API response.');

	} catch (error: any) {
		console.error('[edit API] Error:', error);
		return json(
			{ success: false, error: error.message || 'Unexpected error during edit.' },
			{ status: 500 }
		);
	}
};
