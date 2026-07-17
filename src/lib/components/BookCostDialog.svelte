<!--
  BookCostDialog.svelte
  ─────────────────────────────────────────────────────────────────────────────
  Shows the running AI spend for a book: an exact, token-based total for every
  Claude call, plus a clearly-labelled estimate for image generation and web
  search (neither provider returns cost data, so those are flat per-call
  guesses, not a measurement).

  Usage:
    <BookCostDialog open={showCost} usage={activeBook.usage} onClose={() => showCost = false} />
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { BookUsage } from '$lib/types';
	import { claudeCallCost, ESTIMATED_COST_PER_IMAGE, ESTIMATED_COST_PER_SEARCH } from '$lib/pricing';

	interface Props {
		open: boolean;
		usage: BookUsage | undefined;
		/** Images the book represents, counted from its actual contents (cover
		 *  candidates + chapter illustrations), not just the billed-at-generation
		 *  counter — see `estimatedImageCount` in $lib/pricing. */
		imageCount: number;
		onClose: () => void;
	}

	let { open, usage, imageCount, onClose }: Props = $props();

	let claudeRows = $derived(
		Object.entries(usage?.claude ?? {}).map(([model, u]) => ({
			model,
			calls: u.calls,
			inputTokens: u.inputTokens,
			outputTokens: u.outputTokens,
			cost: claudeCallCost(model, u.inputTokens, u.outputTokens)
		}))
	);
	let claudeTotal   = $derived(claudeRows.reduce((sum, r) => sum + r.cost, 0));
	let imagesCount   = $derived(imageCount);
	let imagesCost    = $derived(imagesCount * ESTIMATED_COST_PER_IMAGE);
	let searchesCount = $derived(usage?.searches ?? 0);
	let searchesCost  = $derived(searchesCount * ESTIMATED_COST_PER_SEARCH);
	let grandTotal    = $derived(claudeTotal + imagesCost + searchesCost);

	function fmt(n: number): string {
		return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (open && e.key === 'Escape') { e.preventDefault(); onClose(); }
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

{#if open}
	<div class="bcd-backdrop" aria-hidden="true" onclick={onClose}></div>

	<div class="bcd-wrapper" role="dialog" aria-modal="true" aria-labelledby="bcd-title">
		<div class="bcd-header">
			<h2 class="bcd-title" id="bcd-title">Estimated Generation Cost</h2>
			<button class="bcd-close" onclick={onClose} aria-label="Close">×</button>
		</div>

		<div class="bcd-total">{fmt(grandTotal)}<span class="bcd-total-label">total so far</span></div>

		<div class="bcd-section">
			<div class="bcd-section-head">
				<span>Writing &amp; editing (Claude)</span>
				<span class="bcd-badge bcd-badge--exact">Exact</span>
			</div>
			{#if claudeRows.length === 0}
				<p class="bcd-empty">No Claude calls recorded yet.</p>
			{:else}
				{#each claudeRows as row}
					<div class="bcd-row">
						<span class="bcd-row-label">{row.model}<span class="bcd-row-sub">{row.calls} call{row.calls === 1 ? '' : 's'}</span></span>
						<span class="bcd-row-value">{fmt(row.cost)}</span>
					</div>
				{/each}
			{/if}
		</div>

		<div class="bcd-section">
			<div class="bcd-section-head">
				<span>Images ({imagesCount})</span>
				<span class="bcd-badge bcd-badge--estimate">Estimated</span>
			</div>
			<div class="bcd-row">
				<span class="bcd-row-label">Kie.ai / 69labs generation</span>
				<span class="bcd-row-value">{fmt(imagesCost)}</span>
			</div>
		</div>

		<div class="bcd-section">
			<div class="bcd-section-head">
				<span>Research search ({searchesCount})</span>
				<span class="bcd-badge bcd-badge--estimate">Estimated</span>
			</div>
			<div class="bcd-row">
				<span class="bcd-row-label">Exa search</span>
				<span class="bcd-row-value">{fmt(searchesCost)}</span>
			</div>
		</div>

		<p class="bcd-disclaimer">
			Claude costs are calculated from the real number of tokens each call used, priced at
			Anthropic's standard rate — this matches what Anthropic actually bills for these calls.
			Image and search costs are rough estimates: neither provider returns usage or cost data,
			so these are flat per-call guesses, not a measurement of what you were charged. Image
			costs are estimated from the images the book actually contains (its cover and chapter
			illustrations), so regenerated or discarded attempts may not be reflected. Check your
			Kie.ai / 69labs / Exa dashboard for your actual bill. Claude and search totals only
			reflect calls made since this feature was added — they do not include cost from before.
		</p>
	</div>
{/if}

<style>
	.bcd-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(26, 21, 16, 0.45);
		z-index: 200;
	}

	.bcd-wrapper {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 201;
		width: 100%;
		max-width: 440px;
		max-height: calc(100vh - 4rem);
		overflow-y: auto;
		background: #fff;
		border-radius: 10px;
		box-shadow:
			0 4px 6px rgba(0,0,0,0.05),
			0 10px 30px rgba(0,0,0,0.15),
			0 20px 60px rgba(0,0,0,0.10);
		padding: 1.5rem 1.5rem 1.35rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.bcd-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.bcd-title {
		font-family: var(--font-serif, 'Lora', Georgia, serif);
		font-size: 1.05rem;
		font-weight: 700;
		color: #111;
		margin: 0;
	}

	.bcd-close {
		background: transparent;
		border: none;
		font-size: 1.4rem;
		line-height: 1;
		color: #9CA3AF;
		cursor: pointer;
		padding: 0.1rem 0.3rem;
	}
	.bcd-close:hover { color: #374151; }

	.bcd-total {
		font-family: var(--font-serif, 'Lora', Georgia, serif);
		font-size: 2rem;
		font-weight: 700;
		color: #111;
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.bcd-total-label {
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.78rem;
		font-weight: 500;
		color: #9CA3AF;
	}

	.bcd-section {
		border-top: 1px solid #EEE8DE;
		padding-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.bcd-section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.78rem;
		font-weight: 600;
		color: #6B7280;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.bcd-badge {
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.02em;
		padding: 0.15rem 0.45rem;
		border-radius: 4px;
	}
	.bcd-badge--exact    { background: #ECFDF5; color: #059669; }
	.bcd-badge--estimate { background: #FFFBEB; color: #D97706; }

	.bcd-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.86rem;
		color: #374151;
	}
	.bcd-row-label { display: flex; flex-direction: column; gap: 0.1rem; }
	.bcd-row-sub { font-size: 0.72rem; color: #9CA3AF; font-weight: 400; }
	.bcd-row-value { font-weight: 600; color: #111; flex-shrink: 0; }

	.bcd-empty {
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.82rem;
		color: #9CA3AF;
		font-style: italic;
		margin: 0;
	}

	.bcd-disclaimer {
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.72rem;
		line-height: 1.55;
		color: #9CA3AF;
		margin: 0.25rem 0 0;
		border-top: 1px solid #EEE8DE;
		padding-top: 0.75rem;
	}

	@media (max-width: 480px) {
		.bcd-wrapper { max-width: calc(100vw - 2rem); padding: 1.25rem; }
	}
</style>
