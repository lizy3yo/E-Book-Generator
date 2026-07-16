/**
 * The rolling book bible — what the book has ALREADY COMMITTED TO, in prose.
 *
 * Chapters are written in parallel and never see each other's output. The
 * outline tells a chapter what the others are PLANNED to cover; it cannot tell
 * it what they actually said. At 30 chapters that gap is what lets two chapters
 * define the same term differently, re-derive the same foundation, or reach for
 * the same example.
 *
 * The whole design rests on this file staying BOUNDED. Sequential chaining —
 * feeding every prior chapter forward — was rejected because 600 pages is
 * ~210k tokens and blows the 200k input window around chapter 28, at quadratic
 * cost. A bible that grows with the book reintroduces exactly that problem, so
 * the cap here is not a tidiness measure, it is the load-bearing constraint.
 */

import type { BibleEntry } from './types';

/**
 * Token ceiling for the whole bible, at any book length. ~2–3k against a 200k
 * window is affordable on every chapter call; the point is that a 600-page book
 * pays the same as a 50-page one.
 */
export const BIBLE_TOKEN_CAP = 2_500;

/** Rough token estimate for English prose (~3.5 chars per token). */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3.5);
}

function entryTokens(e: BibleEntry): number {
	return estimateTokens(`${e.label}${e.detail}`) + 8; // + framing per line
}

/** Identity of an entry for dedupe purposes: same kind + same label. */
function keyOf(e: BibleEntry): string {
	return `${e.kind}:${e.label.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

function isUsable(e: BibleEntry): boolean {
	return Boolean(e && e.kind && e.label?.trim() && e.detail?.trim());
}

/**
 * Fold new entries into the existing bible: drop junk, dedupe (first definition
 * wins — the chapter that introduced a term owns it, so a later chapter can't
 * silently redefine it), then trim to the cap.
 */
export function mergeBible(existing: BibleEntry[], incoming: BibleEntry[]): BibleEntry[] {
	const byKey = new Map<string, BibleEntry>();

	for (const e of [...(existing ?? []), ...(incoming ?? [])]) {
		if (!isUsable(e)) continue;
		const k = keyOf(e);
		// First writer wins; a duplicate from a later chapter is exactly the
		// contradiction this whole mechanism exists to prevent.
		if (!byKey.has(k)) byKey.set(k, e);
	}

	return capBible([...byKey.values()]);
}

/**
 * Enforce BIBLE_TOKEN_CAP. Over budget, the oldest chapters' entries go first:
 * a term defined in chapter 2 has by chapter 25 either been used enough to be
 * established anyway, or it was never load-bearing. Within an equally-old set,
 * `term` and `stat` outrank `claim` and `example` — a redefined term or a
 * contradicted figure is a hard error to a reader, while a repeated example is
 * only dull.
 */
export function capBible(entries: BibleEntry[], cap: number = BIBLE_TOKEN_CAP): BibleEntry[] {
	const priority: Record<BibleEntry['kind'], number> = { term: 0, stat: 1, claim: 2, example: 3 };

	// Rank worst-to-keep last: newest first, then by kind priority.
	const ranked = [...entries].sort(
		(a, b) => b.chapter - a.chapter || priority[a.kind] - priority[b.kind]
	);

	const kept: BibleEntry[] = [];
	let total = 0;
	for (const e of ranked) {
		const t = entryTokens(e);
		if (total + t > cap) continue; // skip, don't break — a short entry may still fit
		kept.push(e);
		total += t;
	}

	// Restore reading order so the prompt reads as the book runs.
	return kept.sort((a, b) => a.chapter - b.chapter || priority[a.kind] - priority[b.kind]);
}

/** Token cost of a bible as rendered — used to assert the bound holds. */
export function bibleTokens(entries: BibleEntry[]): number {
	return entries.reduce((n, e) => n + entryTokens(e), 0);
}

/**
 * Render the bible for the write-chapter prompt. Returns '' for an empty bible
 * (batch 1, or a book that predates the field) so the prompt is unchanged.
 */
export function renderBibleBlock(entries: BibleEntry[] | undefined): string {
	if (!entries?.length) return '';

	const section = (kind: BibleEntry['kind'], heading: string, rule: string) => {
		const rows = entries.filter((e) => e.kind === kind);
		if (!rows.length) return '';
		return (
			`\n${heading}\n` +
			rows.map((e) => `  - ${e.label} (Ch ${e.chapter}): ${e.detail}`).join('\n') +
			`\n  → ${rule}\n`
		);
	};

	return (
		`\nBOOK BIBLE — what earlier chapters have ALREADY WRITTEN. This is not the plan; it is the text as published. Treat it as settled fact.\n` +
		section('term', 'TERMS ALREADY DEFINED:', 'Use these terms with these meanings. Do not redefine or re-introduce them.') +
		section('claim', 'CLAIMS ALREADY ESTABLISHED:', 'These are argued and settled. Build on them — do not restate or re-argue them, and never contradict them.') +
		section('example', 'EXAMPLES ALREADY USED:', 'These are spent. Choose different ones.') +
		section('stat', 'FIGURES ALREADY CITED:', 'Reuse these exact figures if the same fact comes up. Never cite a different number for the same fact.')
	);
}
