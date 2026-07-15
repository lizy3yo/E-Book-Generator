/**
 * generateImage — shared client-side helper for /api/image
 *
 * Handles the two-step Kie.ai flow (create task → client-side poll)
 * transparently.  For 69labs and mock mode the response is synchronous
 * so the caller doesn't need to know the difference.
 *
 * @param params  Same shape as the /api/image POST body (minus `action`)
 * @returns       The generated image URL
 * @throws        Error with a human-readable message on failure
 */
export async function generateImage(params: {
	prompt: string;
	apiKey: string;
	provider: string;
	useMockMode: boolean;
	isCover: boolean;
}): Promise<string> {
	// ── Step 1: create the task ────────────────────────────────────────────────
	const createRes = await fetch('/api/image', {
		method:  'POST',
		headers: { 'Content-Type': 'application/json' },
		body:    JSON.stringify({ action: 'create', ...params })
	});
	const createData = await createRes.json();

	if (!createData.success) {
		throw new Error(createData.error || 'Image generation failed.');
	}

	// Synchronous providers (69labs, mock) return imageUrl directly
	if (createData.imageUrl !== undefined) {
		return createData.imageUrl;
	}

	// ── Step 2: poll for Kie.ai result ────────────────────────────────────────
	const { taskId } = createData;
	if (!taskId) throw new Error('No taskId returned from image API.');

	const MAX_POLLS   = 30;   // 30 × 3 s = 90 s max
	const POLL_MS     = 3000;

	for (let i = 0; i < MAX_POLLS; i++) {
		await new Promise(r => setTimeout(r, POLL_MS));

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

		if (pollData.error) throw new Error(pollData.error);
		if (pollData.done && pollData.imageUrl) return pollData.imageUrl;
		// pollData.done === false → still pending, continue polling
	}

	throw new Error('Image generation timed out after 90 seconds. Please try again.');
}
