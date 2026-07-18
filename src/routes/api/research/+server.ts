import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { EXA_API_KEY, ANTHROPIC_API_KEY, CLAUDE_WRITING_MODEL } from '$env/static/private';

// Heuristic fallback to programmatically generate topic-aware mock search results
function generateProgrammaticMock(query: string) {
	let cleanTopic = query
		.replace(/Core concepts and key facts about:/i, '')
		.replace(/Key facts and details about:/i, '')
		.replace(/Core arguments, counter-arguments, and examples for:/i, '')
		.split('Genre:')[0]
		.split('(Book:')[0]
		.split('in the context of')[0]
		.replace(/[^a-zA-Z0-9\s-]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (!cleanTopic) {
		cleanTopic = 'General Research Topic';
	}

	const capitalizedTopic = cleanTopic
		.split(' ')
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');

	const domainTopic = cleanTopic.toLowerCase().replace(/[^a-z0-9]+/g, '-');

	return [
		{
			title: `Introduction to ${capitalizedTopic} — Core Principles and History`,
			url: `https://encyclopedia.org/wiki/${domainTopic}`,
			snippet: `A comprehensive overview of ${cleanTopic}, exploring its historical origins, foundational concepts, and modern significance in contemporary practice and literature.`
		},
		{
			title: `The Science and Methodology of ${capitalizedTopic}`,
			url: `https://sciencejournal.org/article/${domainTopic}-methodology`,
			snippet: `Recent empirical studies and structural analyses detail the operational frameworks of ${cleanTopic}. Key metrics demonstrate significant efficiency gains and optimization pathways.`
		},
		{
			title: `Advanced Guide: Implementing ${capitalizedTopic} in Practice`,
			url: `https://practicalinsights.com/guides/${domainTopic}-implementation`,
			snippet: `Step-by-step practical guide to mastering ${cleanTopic}. This research highlights industry best practices, common failure modes, and expert recommendations for implementation.`
		}
	];
}

/** Exa search is fast (~2–5s), but give it head-room over Vercel's default so a
 *  slow search near its own 12s abort ceiling is never cut off first. */
export const config = { maxDuration: 60 };

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { query, apiKey, useMockMode } = await request.json();
		const activeApiKey = (apiKey?.trim()) || EXA_API_KEY;

		if (useMockMode || !activeApiKey) {
			// Simulate network latency
			await new Promise((resolve) => setTimeout(resolve, 2500));

			// If Anthropic key is available, try to generate high-quality mock facts dynamically
			const anthropicKey = ANTHROPIC_API_KEY?.trim();
			if (anthropicKey) {
				let responseText = '';
				try {
					const model = CLAUDE_WRITING_MODEL || 'claude-sonnet-5';
					const systemPrompt = `You are a research assistant. The user wants to retrieve search results for a research query, but we are in mock mode.
Generate 4 highly realistic, informative, and topic-specific search results (mocking a search engine response).
Each result must contain a title, a URL (relevant to the source), and a comprehensive, detailed snippet (3-4 sentences of actual fact-based information or core concepts relevant to the query).
Respond ONLY with a valid JSON array matching this typescript type:
Array<{ title: string; url: string; snippet: string }>
Do not include any markdown formatting, code block markers (like \`\`\`json), or conversational filler.`;

					const userPrompt = `Generate realistic search results for this research query: "${query}"`;

					const response = await fetch('https://api.anthropic.com/v1/messages', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							'x-api-key': anthropicKey,
							'anthropic-version': '2023-06-01'
						},
						body: JSON.stringify({
							model: model,
							max_tokens: 1500,
							system: systemPrompt,
							messages: [
								{ role: 'user', content: userPrompt }
							]
						})
					});

					if (response.ok) {
						const data = await response.json();
						responseText = (data.content?.find((c: any) => c.type === 'text')?.text || '').trim();
						// This "mock" path still makes a REAL, billed Claude call to
						// fabricate results, so its token usage is returned for the
						// cost total — it is a Claude cost, not an Exa search.
						const usage = {
							model,
							inputTokens: data.usage?.input_tokens ?? 0,
							outputTokens: data.usage?.output_tokens ?? 0
						};

						// Clean markdown formatting if any was returned
						let cleanJson = responseText;
						if (cleanJson.startsWith('```json')) {
							cleanJson = cleanJson.substring(7);
						}
						if (cleanJson.endsWith('```')) {
							cleanJson = cleanJson.substring(0, cleanJson.length - 3);
						}
						cleanJson = cleanJson.trim();

						const parsedResults = JSON.parse(cleanJson);
						if (Array.isArray(parsedResults) && parsedResults.length > 0) {
							return json({
								success: true,
								query,
								results: parsedResults.map(item => ({
									title: item.title || 'Untitled Source',
									url: item.url || '#',
									snippet: item.snippet || 'No snippet available.'
								})),
								usage,
								source: 'mock'
							});
						}
					}
				} catch (llmError: any) {
					console.warn('Failed to generate mock research via Anthropic Claude:', llmError);
					const programmaticFacts = generateProgrammaticMock(query);
					return json({
						success: true,
						query,
						results: programmaticFacts,
						source: 'mock'
					});
				}
			}

			// Heuristic fallback if LLM is unavailable or fails
			const programmaticFacts = generateProgrammaticMock(query);
			return json({
				success: true,
				query,
				results: programmaticFacts,
				source: 'mock'
			});
		}

		// Live API Call to Exa AI
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 12_000);

	let response: Response;
	try {
		response = await fetch('https://api.exa.ai/search', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': activeApiKey
			},
			signal: controller.signal,
			body: JSON.stringify({
				query: query,
				useAutoprompt: true,
				numResults: 5,
				type: 'neural',
				contents: { text: { maxCharacters: 800 } }
			})
		});
	} finally {
		clearTimeout(timeout);
	}

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Exa API error (${response.status}): ${errText}`);
		}

		const data = await response.json();
		
		const results = (data.results || []).map((item: any) => ({
			title: item.title || 'Untitled Source',
			url: item.url || '#',
			snippet: (item.text || item.extract || item.summary || '')
				? (item.text || item.extract || item.summary).substring(0, 400)
				: 'No snippet available.'
		}));

		return json({
			success: true,
			query,
			results,
			source: 'live'
		});

	} catch (error: any) {
		console.error('Research API Route Error:', error);
		return json({
			success: false,
			error: error.message || 'An unexpected error occurred during semantic research.'
		}, { status: 500 });
	}
};
