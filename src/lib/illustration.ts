/**
 * illustration — the one place that decides what a generated picture shows and
 * what its labels say.
 *
 * Why this is a module and not private to generationRunner
 * ───────────────────────────────────────────────────────
 * Three call sites make chapter pictures: the writing pipeline, the reader's
 * "regenerate illustration", and the reader's ultra-realistic "turn this diagram
 * into a photo". They used to each carry their own inlined prompt string, and
 * they had already drifted — only the pipeline's copy had the house palette, so
 * regenerating from the reader produced a visibly different image than
 * generation did. Art direction and labelling are the kind of thing that only
 * gets worse when copied, so they live here and every caller shares them.
 *
 * The division of labour, which is the whole design:
 *   • The image model draws. It cannot spell, so the picture carries no text.
 *   • Claude reads the chapter and decides WHAT is worth pointing at, and looks
 *     at the finished picture to say WHERE that thing is.
 *   • The renderer sets the labels in real type. It is the only participant
 *     that can actually spell.
 */

import { generateImage } from './generateImage';
import type { IllustrationLabel } from './types';

/** Just enough of a book to brief an illustration. */
export interface IllustrationBookContext {
	title: string;
	genre: string;
	useUltraRealistic?: boolean;
	coverSettings?: { useUltraRealistic?: boolean } | null;
}

export interface IllustrationKeys {
	anthropicKey: string;
	imageKey: string;
	imageProvider: string;
}

/** What the caller knows about the thing being illustrated. */
export interface IllustrationBrief {
	chapterTitle: string;
	chapterOrder: number;
	chapterSummary?: string;
	/** The finished prose. The single most useful input there is — it is the
	 *  only thing that says what the chapter actually teaches. */
	chapterContent?: string;
	researchNotes?: string;
	/** For the diagram→photo path: the diagram's own source, which states the
	 *  point the author wanted made visually. */
	diagramIntent?: string;
	/** A direct instruction typed by the author in the reader. Art direction
	 *  bends to it; the no-text rule does not. */
	authorNote?: string;
}

/** Resolve the ultra-realistic flag the same way everywhere. */
export function isUltraRealistic(book: IllustrationBookContext, override?: boolean): boolean {
	return !!(override || book.useUltraRealistic || book.coverSettings?.useUltraRealistic);
}

/**
 * The no-text rule, stated in code rather than left to the model to remember.
 *
 * It is the one constraint whose failure is visible on every page — an image
 * model left to itself letters every surface it draws, and it cannot spell, so
 * the result is confident gibberish. Appended last so it is the final thing the
 * image model reads.
 */
export const NO_TEXT_CLAUSE =
	'ABSOLUTE CONSTRAINT — the image contains no text of any kind: no words, letters, numerals, ' +
	'captions, labels, annotations, legends, signage, logos, watermarks or signature; ' +
	'no title and no subtitle; no lettering on any object or surface. ' +
	'All meaning is carried by form alone. Square 1:1 composition.';

/**
 * The house-style prompt — the fallback when art direction is unavailable
 * (mock mode, a failed call, an unparseable brief).
 *
 * It knows nothing about what the chapter says, so it can only ask for a
 * competent generic plate. That is exactly why it is the fallback.
 */
export function houseStyleIllustrationPrompt(
	book: IllustrationBookContext,
	brief: IllustrationBrief,
	ultraRealistic: boolean
): string {
	const styleClause = ultraRealistic
		? 'Ultra-realistic reference photograph, documentary product photography, sharp focus, ' +
		  'natural directional lighting, shallow depth of field, highly detailed. ' +
		  'Neutral warm cream backdrop, deep navy and amber colour accents.'
		: 'High-quality editorial illustration, clean flat vector style with subtle depth. ' +
		  'Warm cream background (#FAF5EA), deep navy linework (#0F2231), amber accents (#E07B20). ' +
		  'Restrained sophisticated palette.';

	const topic = brief.chapterSummary ? ` Topic: ${brief.chapterSummary}.` : '';
	return `${styleClause} Subject: a clear, instructive visual for a chapter titled ` +
		`"${brief.chapterTitle}".${topic} From the book "${book.title}" (${book.genre}). ${NO_TEXT_CLAUSE}`;
}

/**
 * Ask Claude to art-direct a plate from what the chapter says and the research
 * behind it.
 *
 * Returns null on any failure — the caller falls back to the house style and
 * still gets a picture. Losing the art direction costs relevance; throwing
 * would cost the image.
 */
/** One Claude call's real token usage, priced by the caller — see $lib/pricing. */
export interface CallUsage {
	model: string;
	inputTokens: number;
	outputTokens: number;
}

export async function artDirectIllustration(
	book: IllustrationBookContext,
	brief: IllustrationBrief,
	ultraRealistic: boolean,
	keys: IllustrationKeys,
	useMock: boolean
): Promise<{ prompt: string; subject: string; usage: CallUsage | null } | null> {
	try {
		const res = await fetch('/api/write', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action:         'art-direct-illustration',
				apiKey:         keys.anthropicKey,
				useMockMode:    useMock,
				bookTitle:      book.title,
				genre:          book.genre,
				chapterTitle:   brief.chapterTitle,
				chapterOrder:   brief.chapterOrder,
				chapterSummary: brief.chapterSummary,
				chapterContent: brief.chapterContent,
				researchNotes:  brief.researchNotes,
				diagramIntent:  brief.diagramIntent,
				authorNote:     brief.authorNote,
				ultraRealistic
			})
		});
		const data = await res.json();
		return data.success && data.prompt
			? { prompt: data.prompt as string, subject: (data.subject as string) ?? '', usage: data.usage ?? null }
			: null;
	} catch {
		return null;
	}
}

/**
 * Look at the picture that actually came back and report where each labelled
 * part sits in the frame.
 *
 * Must run after the image exists: the labels describe the picture that arrived,
 * not the one the brief asked for. The image model composes the frame however it
 * likes, so where anything ended up is only knowable by looking.
 *
 * Returns [] on any failure. An unlabelled plate is still a good plate.
 */
export async function labelIllustration(
	book: IllustrationBookContext,
	brief: IllustrationBrief,
	imageUrl: string,
	subject: string,
	keys: IllustrationKeys,
	useMock: boolean
): Promise<{ labels: IllustrationLabel[]; usage: CallUsage | null }> {
	try {
		const res = await fetch('/api/write', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action:         'place-illustration-labels',
				apiKey:         keys.anthropicKey,
				useMockMode:    useMock,
				bookTitle:      book.title,
				genre:          book.genre,
				chapterTitle:   brief.chapterTitle,
				chapterOrder:   brief.chapterOrder,
				chapterContent: brief.chapterContent,
				researchNotes:  brief.researchNotes,
				imageUrl,
				illustrationSubject: subject
			})
		});
		const data = await res.json();
		return {
			labels: data.success && Array.isArray(data.labels) ? (data.labels as IllustrationLabel[]) : [],
			usage: data.usage ?? null
		};
	} catch {
		return { labels: [], usage: null };
	}
}

/**
 * The whole job: brief it, draw it, label it.
 *
 * Every caller wants these three together — an image without its labels is the
 * old behaviour, and labels without a fresh image are worse than none (they
 * point at parts of a picture that no longer exists). Keeping them in one call
 * is what stops a caller from doing half of it.
 */
export async function createIllustration(
	book: IllustrationBookContext,
	brief: IllustrationBrief,
	keys: IllustrationKeys,
	useMock: boolean,
	ultraOverride?: boolean
): Promise<{
	url: string;
	labels: IllustrationLabel[];
	prompt: string;
	/** Real token usage from the art-direction and labelling calls, for cost tracking. */
	claudeUsage: CallUsage[];
	/** True if the image itself was actually generated by a paid provider (not mock mode). */
	imageBilled: boolean;
}> {
	const ultra     = isUltraRealistic(book, ultraOverride);
	const direction = await artDirectIllustration(book, brief, ultra, keys, useMock);
	const prompt    = direction?.prompt ?? houseStyleIllustrationPrompt(book, brief, ultra);

	const url = await generateImage({
		prompt,
		apiKey:      keys.imageKey,
		provider:    keys.imageProvider,
		useMockMode: useMock,
		isCover:     false
	});

	const labelResult = url
		? await labelIllustration(book, brief, url, direction?.subject ?? '', keys, useMock)
		: { labels: [] as IllustrationLabel[], usage: null as CallUsage | null };

	const claudeUsage = [direction?.usage, labelResult.usage].filter((u): u is CallUsage => !!u);

	return {
		url,
		labels: labelResult.labels,
		prompt,
		claudeUsage,
		imageBilled: !!url && !useMock && !!keys.imageKey
	};
}
