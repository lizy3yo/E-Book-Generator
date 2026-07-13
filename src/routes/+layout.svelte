<script lang="ts">
	import { onMount } from 'svelte';
	import '../index.css';
	import { globalState } from '$lib/state.svelte';
	import { BookOpen, PenLine, Palette, Sun, Moon, Settings } from '@lucide/svelte';

	let { children } = $props();
	let currentTheme = $state('light');

	onMount(() => {
		const savedTheme = localStorage.getItem('ebook_theme') || 'light';
		setTheme(savedTheme);
	});

	function setTheme(theme: string) {
		currentTheme = theme;
		document.documentElement.setAttribute('data-theme', theme);
		localStorage.setItem('ebook_theme', theme);
	}

	function toggleTheme() {
		setTheme(currentTheme === 'light' ? 'dark' : 'light');
	}
</script>

<div class="app-layout">
	<!-- Top Elegant Header Bar -->
	<header class="app-header">
		<div class="logo">
			<BookOpen size={22} />
			<h1>Ebook Automator</h1>
		</div>
		
		<nav class="nav-links">
			<a href="/" class="nav-item">
				<PenLine size={16} /> Write
			</a>
			<a href="/cover" class="nav-item">
				<Palette size={16} /> Cover Studio
			</a>
			<a href="/reader" class="nav-item">
				<BookOpen size={16} /> Reader
			</a>
			<a href="/settings" class="nav-item">
				<Settings size={16} /> Settings
			</a>
		</nav>

		<div class="actions">
			<button class="theme-toggle" onclick={toggleTheme} aria-label="Toggle paper theme">
				{#if currentTheme === 'light'}
					<Moon size={15} /> Night Mode
				{:else}
					<Sun size={15} /> Day Mode
				{/if}
			</button>
		</div>
	</header>

	<!-- Main content body wrapper -->
	<main class="app-main">
		{#if !globalState.initialized}
			<div class="loading-screen">
				<div class="spinner"></div>
				<p>Opening library...</p>
			</div>
		{:else}
			{@render children()}
		{/if}
	</main>
</div>

<style>
	.app-layout {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		background-color: var(--bg-page);
	}

	.app-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 2rem;
		background-color: var(--bg-card);
		border-bottom: 1px solid var(--border-color);
		box-shadow: var(--shadow-sm);
		position: sticky;
		top: 0;
		z-index: 100;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		color: var(--text-main);
	}
	.logo h1 {
		font-size: 1.35rem;
		font-family: var(--font-serif);
		letter-spacing: -0.5px;
	}

	.nav-links {
		display: flex;
		align-items: center;
		gap: 2rem;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-muted);
		font-weight: 500;
		font-size: 0.9rem;
		padding: 0.5rem 0.75rem;
		border-radius: var(--radius-sm);
		transition: var(--transition);
	}

	.nav-item:hover {
		color: var(--text-main);
		background-color: var(--accent-light);
		text-decoration: none;
	}

	.actions {
		display: flex;
		align-items: center;
	}

	.theme-toggle {
		background: transparent;
		border: 1px solid var(--border-color);
		color: var(--text-muted);
		padding: 0.5rem 1rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 500;
		transition: var(--transition);
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.theme-toggle:hover {
		border-color: var(--border-focus);
		color: var(--text-main);
		background-color: var(--accent-light);
	}

	.app-main {
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.loading-screen {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		flex: 1;
		gap: 1rem;
		color: var(--text-muted);
		font-family: var(--font-serif);
		font-style: italic;
	}

	@media (max-width: 768px) {
		.app-header {
			flex-direction: column;
			gap: 1rem;
			padding: 1rem;
		}

		.nav-links {
			width: 100%;
			justify-content: space-around;
			gap: 0.5rem;
		}

		.nav-item {
			font-size: 0.8rem;
			padding: 0.35rem 0.5rem;
		}
	}
</style>
