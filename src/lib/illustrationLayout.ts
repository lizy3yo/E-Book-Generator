/**
 * Callout de-collision — the one place that stops illustration labels from
 * stacking on top of one another.
 *
 * The vision pass points each label at its real feature, in image percentages.
 * When several features cluster — four things around one eye, a row of tools on
 * one shelf — their points, and the text boxes anchored to those points, land in
 * the same spot and pile up into an unreadable smear. The labelling prompt asks
 * the model to keep them apart and it does not do so reliably, because pixel
 * layout is not something a language model can be trusted to get right.
 *
 * So this is the deterministic safety net, run at render time by every path that
 * draws callouts (the chapter opener, the inline plates, and the PDF/HTML
 * export). It keeps each label's `x` — the column it points from, and the
 * feature it names — and adjusts only `y`, enforcing a minimum vertical gap so
 * no two boxes occupy the same horizontal band. A label is nudged only when it
 * actually collides with the one above it; labels already far enough apart are
 * left exactly where the vision pass put them.
 */

/**
 * Minimum vertical distance between two labels' anchor points, as a percentage
 * of the image height. A rendered label box is ~21px tall (0.66rem text plus
 * padding and border); on a plate image of ~420–520px that is ~4–5%, so 8%
 * clears a box with a margin of air to spare at any plausible render size.
 */
const MIN_GAP_PCT = 8;

/** Keep anchors off the very edges so a nudged box is never clipped by the frame. */
const TOP_BOUND = 3;
const BOTTOM_BOUND = 97;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Return a copy of `labels` with `y` values spread so their boxes never overlap.
 *
 * Input order is preserved (callers rely on it for stable rendering); only the
 * `y` field changes. Labels are pushed downward to clear the one above, then, if
 * that pushes the last past the bottom edge, the whole set is lifted back up so
 * the spread stays inside the frame instead of piling against an edge.
 */
export function deconflictLabels<T extends { x: number; y: number }>(labels: T[]): T[] {
	if (!Array.isArray(labels) || labels.length < 2) return labels;

	// Resolve collisions in y-order, but remember each label's original index so
	// the returned array matches the order the caller passed in.
	const order = labels
		.map((l, i) => ({ i, y: clamp(Number(l.y) || 0, TOP_BOUND, BOTTOM_BOUND) }))
		.sort((a, b) => a.y - b.y);

	// Top-down: push each anchor down just enough to clear the one above it.
	for (let k = 1; k < order.length; k++) {
		if (order[k].y - order[k - 1].y < MIN_GAP_PCT) {
			order[k].y = order[k - 1].y + MIN_GAP_PCT;
		}
	}

	// If the stack now runs past the bottom, lift it all back up by the overflow,
	// then re-clear any collision that lift reintroduced at the top.
	const overflow = order[order.length - 1].y - BOTTOM_BOUND;
	if (overflow > 0) {
		for (const o of order) o.y -= overflow;
		for (let k = 1; k < order.length; k++) {
			if (order[k].y - order[k - 1].y < MIN_GAP_PCT) {
				order[k].y = order[k - 1].y + MIN_GAP_PCT;
			}
		}
	}

	const out = labels.map((l) => ({ ...l }));
	for (const o of order) out[o.i] = { ...out[o.i], y: clamp(o.y, TOP_BOUND, BOTTOM_BOUND) };
	return out;
}
