/**
 * coverPalette — reads the colours that are actually in a cover, and keeps the
 * interior legible once they are applied to it.
 *
 * Why sample pixels rather than ask a model
 * ─────────────────────────────────────────
 * A vision model naming "#C8752A" from a picture is estimating. The pixels are
 * not: they are the cover. So the palette is measured here and the model is
 * asked only what pixels cannot say — which colour is the ACCENT rather than
 * the ground, and what the typography is doing. Measure what is measurable;
 * ask only what needs judgement.
 *
 * Why contrast is enforced in code
 * ────────────────────────────────
 * A cover is designed to be seen across a shop; a page is designed to be read
 * for an hour. Those are different jobs. A gold that sings on a navy cover is
 * unreadable on cream, and a cover that is 80% dark navy does not mean the body
 * text should be navy. So the derived colours pass through a contrast floor
 * before they are allowed near the page. Nothing here is a matter of taste —
 * WCAG gives real numbers, and a model asked to "keep it readable" will
 * sometimes say yes and be wrong.
 */

export interface PaletteEntry {
	hex: string;
	/** Fraction of sampled pixels, 0–1. Sorted descending. */
	share: number;
}

/** The design read off a cover, after roles are assigned and contrast enforced. */
export interface CoverDesign {
	/** Headings and body ink. Guaranteed readable on the page ground. */
	primary: string;
	/** Rules, callout bars, the one accent. Guaranteed visible on the ground. */
	accent: string;
	/** The face whose CHARACTER matches the cover's title. Not the cover's
	 *  actual font — a generated cover has no font file to recover. */
	titleFont: string;
	/** One sentence for the author, who never chose this. */
	reasoning: string;
	/** True when the legibility floor moved a colour off what the cover
	 *  actually uses. Surfaced rather than hidden: an author who picked a pale
	 *  gold deserves to know why their rules print darker than their cover. */
	adjustedForContrast?: boolean;
	/** What the cover really uses, before the floor. Kept for that explanation. */
	sourcePrimary?: string;
	sourceAccent?: string;
	/** The cover this was read from. Re-derived when it changes. */
	signature?: string;
}

// ── Colour maths ──────────────────────────────────────────────────────────

export function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace('#', '').trim();
	const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
	const n = parseInt(full.slice(0, 6), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
	const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
	return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** Relative luminance, per WCAG 2.1. */
export function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(v => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1–21. */
export function contrast(a: string, b: string): number {
	const la = luminance(a), lb = luminance(b);
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * Walk a colour toward black until it clears `min` contrast against `ground`.
 *
 * Darkens rather than desaturates: darkening keeps the hue the cover chose,
 * which is the whole point of deriving from the cover. A colour that cannot
 * reach the floor even at black is returned at its darkest — the caller decides
 * what to do, and no caller should be silently handed something unreadable.
 */
export function ensureContrast(hex: string, ground: string, min: number): string {
	if (contrast(hex, ground) >= min) return hex;
	let [r, g, b] = hexToRgb(hex);
	// 40 steps of 2.5% is enough to reach black from any starting colour while
	// keeping the result on the original hue line.
	for (let i = 0; i < 40; i++) {
		r *= 0.975; g *= 0.975; b *= 0.975;
		const next = rgbToHex(r, g, b);
		if (contrast(next, ground) >= min) return next;
	}
	return rgbToHex(r, g, b);
}

/**
 * Walk a colour toward white by `ratio` (0–1), keeping its hue.
 *
 * The counterpart to `ensureContrast`'s walk toward black: this is how a
 * saturated cover colour becomes a pale, cohesive field or card tint (a
 * diagram's cream background, a table's zebra stripe) instead of every book
 * reusing the same fixed off-white regardless of what the cover looked like.
 */
export function tintWithWhite(hex: string, ratio: number): string {
	const [r, g, b] = hexToRgb(hex);
	const t = Math.max(0, Math.min(1, ratio));
	return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}

/** Perceptual-ish distance, good enough to tell two swatches apart. */
function distance(a: string, b: string): number {
	const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
	return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
}

/** Saturation, 0–1. Used to tell an accent from a neutral. */
export function saturation(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(v => v / 255);
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	return max === 0 ? 0 : (max - min) / max;
}

// ── Sampling ──────────────────────────────────────────────────────────────

/**
 * Read the dominant colours out of a cover image.
 *
 * Runs in the browser on a small canvas: the cover is downscaled hard before
 * sampling, because the palette is a question about broad areas, not detail,
 * and a full-size read would cost far more for a worse answer (JPEG noise at
 * full resolution invents thousands of near-identical swatches).
 *
 * Goes through /api/proxy, which re-serves the image same-origin — a remote
 * cover drawn straight onto a canvas taints it and getImageData throws.
 */
export async function samplePalette(imageUrl: string, maxColours = 6): Promise<PaletteEntry[]> {
	if (typeof document === 'undefined' || !imageUrl) return [];

	const src = imageUrl.startsWith('data:')
		? imageUrl
		: `/api/proxy?url=${encodeURIComponent(imageUrl)}`;

	const img = await new Promise<HTMLImageElement>((resolve, reject) => {
		const el = new Image();
		el.crossOrigin = 'anonymous';
		el.onload = () => resolve(el);
		el.onerror = () => reject(new Error('cover image did not load'));
		el.src = src;
		setTimeout(() => reject(new Error('cover image timed out')), 15_000);
	});

	const W = 80, H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W)) || 80;
	const canvas = document.createElement('canvas');
	canvas.width = W; canvas.height = H;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return [];
	ctx.drawImage(img, 0, 0, W, H);

	const { data } = ctx.getImageData(0, 0, W, H);

	// Bucket into a coarse grid first. Exact-value counting on a photograph
	// returns thousands of one-pixel colours and no dominant anything.
	const buckets = new Map<string, { r: number; g: number; b: number; n: number }>();
	let counted = 0;
	for (let i = 0; i < data.length; i += 4) {
		const a = data[i + 3];
		if (a < 200) continue; // ignore transparent edges
		const r = data[i], g = data[i + 1], b = data[i + 2];
		const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
		const cur = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
		cur.r += r; cur.g += g; cur.b += b; cur.n++;
		buckets.set(key, cur);
		counted++;
	}
	if (!counted) return [];

	const ranked = [...buckets.values()]
		.sort((a, b) => b.n - a.n)
		.map(v => ({ hex: rgbToHex(v.r / v.n, v.g / v.n, v.b / v.n), share: v.n / counted }));

	// Merge swatches too close to tell apart, so the list is genuinely distinct
	// colours rather than six shades of the same navy.
	const out: PaletteEntry[] = [];
	for (const entry of ranked) {
		const near = out.find(o => distance(o.hex, entry.hex) < 60);
		if (near) near.share += entry.share;
		else out.push({ ...entry });
		if (out.length >= maxColours) break;
	}
	return out;
}
