<script lang="ts">
	import { AlertCircle, RefreshCw } from '@lucide/svelte';

	interface Props {
		error: string;
		onRetry: () => void;
		isRetrying?: boolean;
	}

	let { error, onRetry, isRetrying = false }: Props = $props();
</script>

<div class="chapter-plan-error" role="alert" aria-live="assertive">
	<div class="chapter-plan-error__icon">
		<AlertCircle size={32} />
	</div>
	<div class="chapter-plan-error__body">
		<h3 class="chapter-plan-error__title font-serif">Chapter Plan Generation Failed</h3>
		<p class="chapter-plan-error__message">{error}</p>
	</div>
	<button
		class="btn btn-primary chapter-plan-error__retry"
		onclick={onRetry}
		disabled={isRetrying}
		aria-label="Retry chapter plan generation"
	>
		<RefreshCw size={14} class={isRetrying ? 'spin-icon' : ''} />
		{isRetrying ? 'Retrying…' : 'Retry'}
	</button>
</div>

<style>
	.chapter-plan-error {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		padding: 2.5rem 2rem;
		border: 1px solid var(--color-error, #e53e3e);
		border-radius: 12px;
		background: color-mix(in srgb, var(--color-error, #e53e3e) 6%, transparent);
		text-align: center;
		max-width: 480px;
		margin: 2rem auto;
	}

	.chapter-plan-error__icon {
		color: var(--color-error, #e53e3e);
		opacity: 0.85;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.chapter-plan-error__body {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.chapter-plan-error__title {
		font-size: 1.05rem;
		font-weight: 600;
		color: var(--color-text, #1a1a1a);
		margin: 0;
	}

	.chapter-plan-error__message {
		font-size: 0.875rem;
		color: var(--color-text-muted, #6b7280);
		margin: 0;
		line-height: 1.5;
	}

	.chapter-plan-error__retry {
		margin-top: 0.25rem;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.chapter-plan-error__retry:disabled {
		opacity: 0.65;
		cursor: not-allowed;
	}
</style>
