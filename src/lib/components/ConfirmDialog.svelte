<!--
  ConfirmDialog.svelte
  ─────────────────────────────────────────────────────────────────────────────
  A reusable, accessible confirmation modal. Traps focus, closes on Escape,
  and closes on backdrop click. Supports three intent variants:
    • "danger"  — destructive action (delete, remove, clear)   → red confirm
    • "warning" — potentially risky but reversible              → amber confirm
    • "default" — neutral confirmation                          → accent confirm

  Usage:
    <ConfirmDialog
      open={showDialog}
      title="Delete ebook"
      message="This will permanently delete «The Quantum Mind» and all its chapters. This cannot be undone."
      confirmLabel="Delete"
      intent="danger"
      onConfirm={() => { globalState.deleteBook(id); showDialog = false; }}
      onCancel={() => { showDialog = false; }}
    />

  Props:
    open         boolean               — controls visibility
    title        string                — dialog heading
    message      string                — body copy (supports a short detail line)
    confirmLabel string  = "Confirm"   — text on the confirm button
    cancelLabel  string  = "Cancel"    — text on the cancel button
    intent       "danger"|"warning"|"default" = "default"
    onConfirm    () => void            — called when the user confirms
    onCancel     () => void            — called when the user cancels or dismisses
-->
<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		intent?: 'danger' | 'warning' | 'default';
		onConfirm: () => void;
		onCancel: () => void;
	}

	let {
		open,
		title,
		message,
		confirmLabel = 'Confirm',
		cancelLabel  = 'Cancel',
		intent       = 'default',
		onConfirm,
		onCancel
	}: Props = $props();

	let dialogEl: HTMLDivElement | null = $state(null);
	let confirmBtn: HTMLButtonElement | null = $state(null);

	// Focus the confirm button when the dialog opens
	$effect(() => {
		if (open && confirmBtn) {
			// Defer slightly to allow the element to be visible first
			setTimeout(() => confirmBtn?.focus(), 30);
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
		// Tab-trap: keep focus inside the dialog
		if (e.key === 'Tab' && dialogEl) {
			const focusable = Array.from(
				dialogEl.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				)
			).filter(el => !el.hasAttribute('disabled'));
			if (focusable.length === 0) { e.preventDefault(); return; }
			const first = focusable[0];
			const last  = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault(); last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault(); first.focus();
			}
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

{#if open}
	<!-- Backdrop -->
	<div
		class="cd-backdrop"
		aria-hidden="true"
		onclick={onCancel}
	></div>

	<!-- Dialog -->
	<div
		class="cd-wrapper"
		role="dialog"
		aria-modal="true"
		aria-labelledby="cd-title"
		aria-describedby="cd-message"
		bind:this={dialogEl}
	>
		<!-- Icon -->
		<div class="cd-icon cd-icon--{intent}" aria-hidden="true">
			{#if intent === 'danger'}
				<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
				</svg>
			{:else if intent === 'warning'}
				<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd" />
				</svg>
			{:else}
				<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
					<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd" />
				</svg>
			{/if}
		</div>

		<div class="cd-body">
			<h2 class="cd-title" id="cd-title">{title}</h2>
			<p class="cd-message" id="cd-message">{message}</p>
		</div>

		<div class="cd-actions">
			<button
				class="cd-btn cd-btn--cancel"
				onclick={onCancel}
			>{cancelLabel}</button>
			<button
				class="cd-btn cd-btn--confirm cd-btn--{intent}"
				onclick={onConfirm}
				bind:this={confirmBtn}
			>{confirmLabel}</button>
		</div>
	</div>
{/if}

<style>
	.cd-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(26, 21, 16, 0.45);
		z-index: 200;
		animation: cdFadeIn 0.15s ease;
	}

	.cd-wrapper {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 201;
		width: 100%;
		max-width: 420px;
		background: #fff;
		border-radius: 10px;
		box-shadow:
			0 4px 6px rgba(0,0,0,0.05),
			0 10px 30px rgba(0,0,0,0.15),
			0 20px 60px rgba(0,0,0,0.10);
		padding: 1.75rem 1.75rem 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		animation: cdSlideIn 0.18s cubic-bezier(0.22, 0.61, 0.36, 1);
	}

	@keyframes cdFadeIn  { from { opacity: 0; }              to { opacity: 1; } }
	@keyframes cdSlideIn { from { transform: translate(-50%, -46%) scale(0.97); opacity: 0; }
	                       to   { transform: translate(-50%, -50%) scale(1);    opacity: 1; } }

	/* Icon */
	.cd-icon {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.cd-icon svg { width: 20px; height: 20px; }

	.cd-icon--danger  { background: #FEF2F2; color: #DC2626; }
	.cd-icon--warning { background: #FFFBEB; color: #D97706; }
	.cd-icon--default { background: #F5F0EA; color: #8E7453; }

	/* Text */
	.cd-body { display: flex; flex-direction: column; gap: 0.35rem; }

	.cd-title {
		font-family: var(--font-serif, 'Lora', Georgia, serif);
		font-size: 1.05rem;
		font-weight: 700;
		color: #111;
		margin: 0;
		line-height: 1.3;
	}

	.cd-message {
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.85rem;
		color: #6B7280;
		margin: 0;
		line-height: 1.6;
	}

	/* Actions */
	.cd-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		padding-top: 0.25rem;
	}

	.cd-btn {
		font-family: var(--font-sans, 'Inter', sans-serif);
		font-size: 0.83rem;
		font-weight: 600;
		padding: 0.5rem 1.1rem;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.15s, opacity 0.15s, box-shadow 0.15s;
		border: 1px solid transparent;
		line-height: 1.4;
	}

	.cd-btn--cancel {
		background: transparent;
		border-color: #E5E7EB;
		color: #374151;
	}
	.cd-btn--cancel:hover { background: #F9FAFB; }

	/* Confirm variants */
	.cd-btn--danger  { background: #DC2626; color: #fff; }
	.cd-btn--warning { background: #D97706; color: #fff; }
	.cd-btn--default { background: var(--accent, #8E7453); color: #fff; }

	.cd-btn--confirm:hover   { opacity: 0.88; }
	.cd-btn--confirm:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 2px;
	}

	@media (max-width: 480px) {
		.cd-wrapper { max-width: calc(100vw - 2rem); padding: 1.5rem; }
		.cd-actions { flex-direction: column-reverse; }
		.cd-btn { width: 100%; text-align: center; }
	}
</style>
