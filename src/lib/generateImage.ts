/**
 * generateImage — shared client-side helper for /api/image
 *
 * Handles the two-step Kie.ai flow (create task → client-side poll)
 * transparently.  For 69labs and mock mode the response is synchronous
 * so the caller doesn't need to know the difference.
 *
 * Transient provider faults are retried. Kie fails a healthy job with
 * `failCode: 500, "internal error, please try again later"` often enough that
 * treating the first failure as final loses covers at random — the caller sees
 * an empty slot and no reason to think a second attempt would have worked.
 */

const MAX_ATTEMPTS = 3;
/**
 * 60 × 3 s = 180 s per attempt. Measured against Kie's flux-2: a cover normally
 * lands in 20–30 s, but the tail runs well past 90 s, and the old 90 s ceiling
 * abandoned jobs that were still generating — reporting a timeout for work that
 * would have succeeded, and costing the generation anyway.
 */
const MAX_POLLS    = 60;
const POLL_MS      = 3000;

/**
 * Kie's transient failure is literally "internal error, please try again
 * later" — a capacity signal. Retrying instantly ignores the "later" and tends
 * to hit the same wall, so attempts are spaced. The jitter matters because a
 * batch fires several covers at once: without it, a capacity blip fails them
 * together and they all retry in the same instant, reproducing the pileup that
 * caused the failure.
 */
const RETRY_BASE_MS = 4000;

function backoffDelay(attempt: number): number {
	const base = RETRY_BASE_MS * 2 ** (attempt - 1); // 4 s, 8 s
	return Math.round(base * (0.5 + Math.random())); // ±50% jitter
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface GenerateImageParams {
	prompt: string;
	apiKey: string;
	provider: string;
	useMockMode: boolean;
	isCover: boolean;
}

/** Carries whether another attempt is worth making. */
export class ImageGenerationError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = 'ImageGenerationError';
		this.retryable = retryable;
	}
}

/**
 * 5xx and 429 are the provider's problem and usually clear on a retry; 4xx is
 * ours (a rejected prompt) and will fail identically every time, so retrying it
 * would just spend the user's credits to reproduce the same error. An absent or
 * unparseable code is given the benefit of the doubt exactly once.
 */
function isRetryable(code: unknown): boolean {
	if (code === null || code === undefined || code === '') return true;
	const n = Number(code);
	if (!Number.isFinite(n)) return true;
	return n >= 500 || n === 429;
}

/**
 * @param params  Same shape as the /api/image POST body (minus `action`)
 * @returns       The generated image URL
 * @throws        ImageGenerationError with a human-readable message on failure
 */
export async function generateImage(params: GenerateImageParams): Promise<string> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await attemptGeneration(params);
		} catch (err) {
			lastError = err;
			const retryable = err instanceof ImageGenerationError ? err.retryable : false;
			if (attempt >= MAX_ATTEMPTS || !retryable) throw err;

			const wait = backoffDelay(attempt);
			console.warn(
				`[generateImage] attempt ${attempt}/${MAX_ATTEMPTS} failed (${(err as Error).message}) — retrying in ${wait}ms`
			);
			await sleep(wait);
		}
	}

	throw lastError;
}

/** One full create → poll cycle. */
async function attemptGeneration(params: GenerateImageParams): Promise<string> {
	// ── Step 1: create the task ────────────────────────────────────────────────
	const createRes = await fetch('/api/image', {
		method:  'POST',
		headers: { 'Content-Type': 'application/json' },
		body:    JSON.stringify({ action: 'create', ...params })
	});
	const createData = await createRes.json();

	if (!createData.success) {
		// A create that fails is a provider/network fault, not a verdict on the
		// prompt — the prompt has not been evaluated yet.
		throw new ImageGenerationError(createData.error || 'Image generation failed.', true);
	}

	// Synchronous providers (69labs, mock) return imageUrl directly
	if (createData.imageUrl !== undefined) {
		return createData.imageUrl;
	}

	// ── Step 2: poll for Kie.ai result ────────────────────────────────────────
	const { taskId } = createData;
	if (!taskId) throw new ImageGenerationError('No taskId returned from image API.', false);

	for (let i = 0; i < MAX_POLLS; i++) {
		await sleep(POLL_MS);

		const pollRes = await fetch('/api/image', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({
				action:      'poll',
				taskId,
				apiKey:      params.apiKey,
				provider:    params.provider,
				useMockMode: params.useMockMode,
				isCover:     params.isCover
			})
		});
		const pollData = await pollRes.json();

		if (pollData.error) throw new ImageGenerationError(pollData.error, isRetryable(pollData.code));
		if (pollData.done && pollData.imageUrl) return pollData.imageUrl;
		// pollData.done === false → still pending, continue polling
	}

	// Not retryable: the job was never reported as failed, so it is most likely
	// still running. Firing a second one would double-spend and race the first.
	throw new ImageGenerationError(
		`Image generation timed out after ${(MAX_POLLS * POLL_MS) / 1000} seconds. Please try again.`,
		false
	);
}
