import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ANTHROPIC_API_KEY, EXA_API_KEY, IMAGE_API_KEY, IMAGE_PROVIDER } from '$env/static/private';

/**
 * GET /api/config
 *
 * Returns which server-side API keys are configured in .env — without
 * exposing the key values themselves.  The client uses this to auto-detect
 * whether live mode is available so it can default useMockMode correctly.
 */
export const GET: RequestHandler = async () => {
	const hasAnthropic = !!ANTHROPIC_API_KEY?.trim();
	const hasExa       = !!EXA_API_KEY?.trim();
	const hasImage     = !!IMAGE_API_KEY?.trim();
	const liveReady    = hasAnthropic && hasImage; // Exa is optional (graceful fallback)

	return json({
		server: {
			anthropic: hasAnthropic,
			exa:       hasExa,
			image:     hasImage,
			imageProvider: IMAGE_PROVIDER || 'kie'
		},
		liveReady
	});
};
