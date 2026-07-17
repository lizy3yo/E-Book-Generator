/**
 * coverStyles — the built-in cover art direction library used by Stage 2.
 *
 * Three templates, all drawn from the same commercial family: loud, type-led,
 * built to sell at thumbnail size. They differ in mechanism, not in ambition —
 * a split field with a photograph, a full-bleed photograph, and a flat colour
 * field with a hero object. A reader scanning a storefront should be able to
 * tell them apart instantly; an author choosing between them should feel like
 * they are choosing a strategy, not a colour swap.
 *
 * Everything else is delegated to the AI concepts tier, which devises original
 * art direction from the Step 1 brief rather than fitting the book to a preset.
 *
 * `direction` carries the author's written brief and/or the design language
 * extracted from an uploaded reference cover. It is appended last so it can
 * override the archetype's own palette and typography instructions.
 */

export interface CoverPromptContext {
	title: string;
	subtitle: string;
	author: string;
	genre: string;
	/** Pre-composed direction clause. Empty string when the author gave none. */
	direction: string;
}

export interface CoverTemplate {
	/** Stable key — persisted on CoverOption so a cover can be regenerated
	 *  regardless of where it sits in the grid. Never reuse or renumber. */
	id: string;
	/** Human-readable label shown under the cover. */
	style: string;
	/** One line explaining when this archetype is the right call. */
	rationale: string;
	buildPrompt: (ctx: CoverPromptContext) => string;
}

export const COVER_TEMPLATES: CoverTemplate[] = [
	{
		id: 'bold-graphic',
		style: 'Bold Graphic',
		rationale: 'Maximum shelf impact — the mainstream commercial non-fiction look.',
		buildPrompt: ({ title, subtitle, author, genre, direction }) =>
			`High-impact commercial non-fiction bestselling book cover — identical quality to Amazon Top 10 titles. Title: "${title}"${subtitle ? ` — ${subtitle}` : ''}. Author: ${author}. Genre: ${genre}. ` +
			`Upper 55% of cover: solid deep navy blue background. Massive, extra-bold white all-caps sans-serif (Impact or Helvetica Black weight) title text "${title.toUpperCase()}" — each word on its own line, commanding maximum visual weight. ` +
			`Thin bright gold horizontal accent lines separating the title lines. ` +
			`Lower 40% of cover: seamless photorealistic cinematic scene directly relevant to "${genre}" and the subject of "${title}" — dramatic natural lighting, high-production-value photography quality. ` +
			`Bold red circular callout badge in the lower-right corner with a short 3-word benefit phrase. ` +
			`Very bottom strip: wide solid navy bar with author name "${author.toUpperCase()}" in large white bold condensed-serif text. ` +
			`Resembles top commercial non-fiction and self-help bestsellers. Publisher-quality production.${direction}`
	},
	{
		id: 'bold-contrast',
		style: 'Bold Contrast',
		rationale: 'One saturated field, one hero object, enormous type — loud and instantly legible.',
		buildPrompt: ({ title, subtitle, author, genre, direction }) =>
			`High-impact commercial bestselling book cover in the loud, graphic, type-led tradition of top self-help and big-idea non-fiction. Title: "${title}"${subtitle ? ` — ${subtitle}` : ''}. Author: ${author}. Genre: ${genre}. ` +
			`The entire cover is one flat, saturated, high-chroma colour field — a confident single hue chosen to suit "${genre}" and to stop a scrolling reader dead. No photographic background, no gradient, no texture. ` +
			`Enormous ultra-bold all-caps sans-serif title text "${title.toUpperCase()}" (Helvetica Black or Futura Extra Bold weight) in hard-contrast black or white, stacked across multiple lines with tight leading, occupying the upper 45% of the cover and running nearly edge to edge. ` +
			`Dead centre: ONE single iconic hero object, unmistakably relevant to the subject of "${title}" — rendered as a crisp, brightly lit, high-contrast photorealistic cut-out floating clean on the colour field, with a hard directional drop shadow beneath it giving it weight and depth. The object is the only image on the cover. ` +
			`A bold contrasting horizontal bar sits beneath the object carrying the subtitle "${subtitle}" in white or black bold condensed caps. ` +
			`Author name "${author.toUpperCase()}" in large bold caps at the very bottom, in the same contrasting colour as the title. ` +
			`Deliberately loud, confident and commercial. Flat vector-clean colour, sharp edges, punchy contrast, perfectly legible at thumbnail size. Publisher-quality production.${direction}`
	},
	{
		id: 'photographic-documentary',
		style: 'Photographic Documentary',
		rationale: 'One arresting full-bleed photograph — journalistic and immediate.',
		buildPrompt: ({ title, subtitle, author, genre, direction }) =>
			`Documentary photographic professional book cover. Title: "${title}"${subtitle ? ` — ${subtitle}` : ''}. Author: ${author}. Genre: ${genre}. ` +
			`A single arresting full-bleed photorealistic photograph fills the entire cover edge to edge — a real, specific, human moment directly relevant to the subject of "${title}" and to ${genre}. Natural available light, honest reportage framing, shallow depth of field, fine 35mm grain. ` +
			`A smooth dark gradient scrim rises from the bottom third so text sits legibly over the image without a solid panel. ` +
			`Clean white medium-weight sans-serif title text "${title.toUpperCase()}" in the lower third, left-aligned, sized to command attention without covering the subject's face. ` +
			`Subtitle "${subtitle}" directly beneath in a lighter weight at half the title size. Author name "${author.toUpperCase()}" in small letter-spaced caps at the very bottom. ` +
			`Restrained, truthful, and cinematic — the visual language of long-form journalism and award-winning photo essays. No illustration, no graphic ornament.${direction}`
	}
];

/** How many original concepts Claude is asked to devise from the Step 1 brief. */
export const AI_CONCEPT_COUNT = 3;

/**
 * The prompt for the single cover the author's own brief produces.
 *
 * Deliberately archetype-free: the brief already fixes the palette, typography,
 * imagery and layout, so fitting it to one of the templates above would mean two
 * competing art directions in a single prompt. Everything design-related arrives
 * through `direction`; this states only the book's own text and the instruction
 * to set it in the brief's language.
 */
export function buildBriefCoverPrompt(ctx: CoverPromptContext): string {
	const { title, subtitle, author, genre, direction } = ctx;
	return `Professional publisher-quality book cover. Title: "${title}"${subtitle ? ` — ${subtitle}` : ''}. Author: ${author}. Genre: ${genre}. ` +
		`Compose this cover entirely in the design language given below — do not impose any other layout or style. ` +
		`Set the title${subtitle ? ', subtitle' : ''} and author name exactly as written above, using that language's own typography, hierarchy, placement and graphic treatment. ` +
		`Perfectly legible at thumbnail size.${direction}`;
}

/**
 * Whether the author has supplied cover direction of their own — a written
 * brief, an uploaded reference, or both.
 *
 * Defined as "the direction clause is non-empty" rather than by re-testing the
 * fields, so what Stage 2 counts as a brief cannot drift from what actually
 * reaches the image prompt.
 */
export function hasCoverBrief(opts: { brief?: string; referenceFormat?: string }): boolean {
	return buildCoverDirection(opts) !== '';
}

/**
 * Compose the direction clause appended to every cover prompt.
 *
 * The reference format is stated last and framed as a design language to
 * transfer — never as subject matter. Borrowing a cover's format across niches
 * only works if the image model is told explicitly not to bring the reference's
 * content with it.
 */
export function buildCoverDirection(opts: {
	brief?: string;
	referenceFormat?: string;
}): string {
	const parts: string[] = [];

	if (opts.brief?.trim()) {
		parts.push(`Visual reference & creative direction: ${opts.brief.trim()}.`);
	}

	if (opts.referenceFormat?.trim()) {
		parts.push(
			`Apply the following design language, which was extracted from a reference cover supplied by the author. ` +
			`Adopt its palette, typography, imagery treatment, graphic devices and layout faithfully, and let it override the palette and type described above where the two conflict. ` +
			`Keep this book's own subject matter and text exactly as specified — do NOT reproduce the reference's subject, niche, artwork, imagery, logos, or wording:\n${opts.referenceFormat.trim()}`
		);
	}

	return parts.length ? ` ${parts.join(' ')}` : '';
}
