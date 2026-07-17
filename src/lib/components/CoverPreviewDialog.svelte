<!--
  CoverPreviewDialog.svelte
  ─────────────────────────────────────────────────────────────────────────────
  Full-size preview of a single cover candidate. The Stage 2 grid necessarily
  shows covers small and side by side; this is where the author actually reads
  one — whole, uncropped, at the size a storefront would show it — before
  committing to it.

  Supports paging between candidates without closing, so covers can be compared
  at full size. Closes on Escape or backdrop click; arrow keys page.

  Props:
    open        boolean                — controls visibility
    option      CoverOption | null     — the cover being previewed
    index       number                 — 0-based position in the grid
    total       number                 — how many candidates are loaded
    busy        boolean                — a generation is in flight; disable actions
    onSelect    () => void             — approve this cover and continue
    onRegenerate () => void            — re-render this cover
    onPrev      () => void
    onNext      () => void
    onClose     () => void
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { CoverOption } from '$lib/types';
	import { X, ChevronLeft, ChevronRight, RotateCcw, CheckCircle, Sparkles, BookMarked } from '@lucide/svelte';

	interface Props {
		open: boolean;
		option: CoverOption | null;
		index: number;
		total: number;
		busy?: boolean;
		onSelect: () => void;
		onRegenerate: () => void;
		onPrev: () => void;
		onNext: () => void;
		onClose: () => void;
	}

	let {
		open, option, index, total, busy = false,
		onSelect, onRegenerate, onPrev, onNext, onClose
	}: Props = $props();

	let dialogEl: HTMLDivElement | null = $state(null);
	let showPrompt = $state(false);

	// The prompt panel is per-cover detail — paging to another cover with it
	// still expanded would show one cover's image beside stale reasoning.
	$effect(() => { void option?.id; showPrompt = false; });

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape')     { e.preventDefault(); onClose(); }
		if (e.key === 'ArrowLeft'  && total > 1) { e.preventDefault(); onPrev(); }
		if (e.key === 'ArrowRight' && total > 1) { e.preventDefault(); onNext(); }
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

{#if open && option}
	<div class="cp-backdrop" aria-hidden="true" onclick={onClose}></div>

	<div
		class="cp-wrapper"
		role="dialog"
		aria-modal="true"
		aria-label="Cover preview — {option.style}"
		bind:this={dialogEl}
	>
		<button class="cp-close" onclick={onClose} aria-label="Close preview">
			<X size={18} />
		</button>

		<!-- The whole cover, never cropped -->
		<div class="cp-stage">
			{#if total > 1}
				<button class="cp-page cp-page--prev" onclick={onPrev} aria-label="Previous cover">
					<ChevronLeft size={20} />
				</button>
			{/if}

			<div class="cp-canvas">
				{#if option.imageUrl}
					<img src={option.imageUrl} alt="Full preview of the {option.style} cover" />
				{:else}
					<div class="cp-empty">
						<BookMarked size={40} />
						<p>This cover didn't render. Regenerate it to try again.</p>
					</div>
				{/if}
			</div>

			{#if total > 1}
				<button class="cp-page cp-page--next" onclick={onNext} aria-label="Next cover">
					<ChevronRight size={20} />
				</button>
			{/if}
		</div>

		<!-- Meta + actions -->
		<div class="cp-panel">
			<div class="cp-meta">
				<div class="cp-heading">
					<h2 class="font-serif">{option.style}</h2>
					{#if option.origin === 'ai'}
						<span class="cp-badge cp-badge--ai"><Sparkles size={11} /> AI Concept</span>
					{:else}
						<span class="cp-badge">Template</span>
					{/if}
				</div>
				<span class="cp-count">{index + 1} of {total}</span>
			</div>

			{#if option.concept}
				<p class="cp-concept">{option.concept}</p>
			{/if}

			<!-- Why this cover exists, in the author's own words. An AI concept
			     claiming to be "derived from your brief" is worth nothing unless
			     the author can see exactly what it was derived from. -->
			{#if option.basis}
				<p class="cp-basis"><span class="cp-basis__label">Drawn from your brief:</span> {option.basis}</p>
			{/if}

			<div class="cp-actions">
				<button class="cp-btn cp-btn--ghost" onclick={() => (showPrompt = !showPrompt)}>
					{showPrompt ? 'Hide' : 'View'} art direction
				</button>
				<div class="cp-actions__right">
					<button class="cp-btn cp-btn--ghost" onclick={onRegenerate} disabled={busy}>
						<RotateCcw size={13} /> Regenerate
					</button>
					<button class="cp-btn cp-btn--primary" onclick={onSelect} disabled={busy || !option.imageUrl}>
						<CheckCircle size={13} /> Use this cover
					</button>
				</div>
			</div>

			{#if showPrompt}
				<pre class="cp-prompt">{option.prompt}</pre>
			{/if}
		</div>
	</div>
{/if}

<style>
	.cp-backdrop {
		position: fixed; inset: 0;
		background: rgba(26, 21, 16, 0.65);
		z-index: 200;
		animation: cpFadeIn 0.15s ease;
	}

	.cp-wrapper {
		position: fixed;
		top: 50%; left: 50%;
		transform: translate(-50%, -50%);
		z-index: 201;
		width: min(940px, calc(100vw - 3rem));
		max-height: calc(100vh - 3rem);
		background: #fff;
		border-radius: 10px;
		box-shadow: 0 10px 30px rgba(0,0,0,0.18), 0 24px 70px rgba(0,0,0,0.14);
		display: flex; flex-direction: column;
		overflow: hidden;
		animation: cpSlideIn 0.18s cubic-bezier(0.22, 0.61, 0.36, 1);
	}

	@keyframes cpFadeIn  { from { opacity: 0; } to { opacity: 1; } }
	@keyframes cpSlideIn { from { transform: translate(-50%, -47%) scale(0.98); opacity: 0; }
	                       to   { transform: translate(-50%, -50%) scale(1);    opacity: 1; } }

	.cp-close {
		position: absolute; top: 0.6rem; right: 0.6rem; z-index: 2;
		width: 32px; height: 32px; border-radius: 50%;
		border: none; cursor: pointer;
		background: rgba(255,255,255,0.9); color: #374151;
		display: flex; align-items: center; justify-content: center;
		box-shadow: 0 1px 4px rgba(0,0,0,0.15);
	}
	.cp-close:hover { background: #fff; }

	/* ── Stage: the cover itself, contained so nothing is ever cropped ────── */
	.cp-stage {
		position: relative;
		flex: 1; min-height: 0;
		background: #1A1510;
		display: flex; align-items: center; justify-content: center;
		padding: 1.25rem;
	}

	.cp-canvas {
		height: 100%; width: 100%;
		display: flex; align-items: center; justify-content: center;
		min-height: 0;
	}
	.cp-canvas img {
		max-width: 100%;
		max-height: min(62vh, 560px);
		width: auto; height: auto;
		object-fit: contain;
		border-radius: 3px;
		box-shadow: 0 6px 28px rgba(0,0,0,0.45);
	}

	.cp-empty {
		color: rgba(255,255,255,0.5);
		display: flex; flex-direction: column; align-items: center; gap: 0.6rem;
		padding: 3rem 1rem; text-align: center;
	}
	.cp-empty p { margin: 0; font-size: 0.83rem; }

	.cp-page {
		position: absolute; top: 50%; transform: translateY(-50%);
		width: 34px; height: 34px; border-radius: 50%;
		border: none; cursor: pointer;
		background: rgba(255,255,255,0.14); color: #fff;
		display: flex; align-items: center; justify-content: center;
		transition: background 0.15s;
	}
	.cp-page:hover { background: rgba(255,255,255,0.28); }
	.cp-page--prev { left: 0.6rem; }
	.cp-page--next { right: 0.6rem; }

	/* ── Panel ───────────────────────────────────────────────────────────── */
	.cp-panel {
		padding: 1rem 1.25rem 1.1rem;
		border-top: 1px solid #E5E7EB;
		display: flex; flex-direction: column; gap: 0.6rem;
		overflow-y: auto;
		flex-shrink: 0;
	}

	.cp-meta { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	.cp-heading { display: flex; align-items: center; gap: 0.55rem; }
	.cp-heading h2 { margin: 0; font-size: 1.02rem; font-weight: 700; color: #111; }

	.cp-badge {
		display: inline-flex; align-items: center; gap: 0.25rem;
		font-size: 0.66rem; font-weight: 700; letter-spacing: 0.04em;
		text-transform: uppercase;
		padding: 0.16rem 0.45rem; border-radius: 3px;
		background: #F3F0EB; color: #6E6860;
	}
	.cp-badge--ai { background: #F0EAFB; color: #6D4AAE; }

	.cp-count { font-size: 0.76rem; color: #9CA3AF; flex-shrink: 0; }

	.cp-concept {
		margin: 0; font-size: 0.84rem; line-height: 1.6; color: #4B5563;
	}

	.cp-basis {
		margin: 0; font-size: 0.78rem; line-height: 1.6; color: #6E6860;
		background: #F9F7F4; border-left: 2px solid var(--accent, #8E7453);
		border-radius: 0 4px 4px 0;
		padding: 0.45rem 0.6rem;
	}
	.cp-basis__label { font-weight: 600; color: #4B5563; }

	.cp-actions {
		display: flex; align-items: center; justify-content: space-between;
		gap: 0.6rem; flex-wrap: wrap; padding-top: 0.15rem;
	}
	.cp-actions__right { display: flex; gap: 0.5rem; }

	.cp-btn {
		display: inline-flex; align-items: center; gap: 0.35rem;
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.8rem; font-weight: 600;
		padding: 0.48rem 0.9rem; border-radius: 6px;
		border: 1px solid transparent; cursor: pointer;
		transition: background 0.15s, opacity 0.15s;
	}
	.cp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.cp-btn--ghost { background: transparent; border-color: #E5E7EB; color: #374151; }
	.cp-btn--ghost:hover:not(:disabled) { background: #F9FAFB; }
	.cp-btn--primary { background: var(--accent, #8E7453); color: #fff; }
	.cp-btn--primary:hover:not(:disabled) { opacity: 0.88; }

	.cp-prompt {
		margin: 0;
		background: #F9F7F4; border: 1px solid #EFEAE3; border-radius: 6px;
		padding: 0.7rem 0.8rem;
		font-size: 0.72rem; line-height: 1.6; color: #6E6860;
		white-space: pre-wrap; word-break: break-word;
		max-height: 150px; overflow-y: auto;
	}

	@media (max-width: 700px) {
		.cp-wrapper { width: calc(100vw - 1.5rem); max-height: calc(100vh - 1.5rem); }
		.cp-canvas img { max-height: 46vh; }
		.cp-actions { flex-direction: column; align-items: stretch; }
		.cp-actions__right { justify-content: stretch; }
		.cp-actions__right .cp-btn { flex: 1; justify-content: center; }
	}
</style>
