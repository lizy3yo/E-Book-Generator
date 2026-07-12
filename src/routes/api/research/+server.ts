import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { query, apiKey, useMockMode } = await request.json();

		if (useMockMode || !apiKey) {
			// Simulate network latency
			await new Promise((resolve) => setTimeout(resolve, 2500));

			const topic = query.toLowerCase();
			let facts = [
				{
					title: "Grounding Semantic Intelligence Study",
					url: "https://example.com/studies/semantic-grounding",
					snippet: "Research demonstrates that real-time semantic grounding reduces LLM hallucination rates from 18% down to less than 1.4% in descriptive outputs."
				},
				{
					title: "Global E-Reading Demographics Annual Report",
					url: "https://example.com/reports/ereading-2026",
					snippet: "Over 68% of users report higher retention rates when non-fiction books utilize structured summary check-points and structured sidebars."
				},
				{
					title: "Cognitive Synthesis & Writing Flow Analysis",
					url: "https://example.com/cognitive-synthesis",
					snippet: "Analysis of professional non-fiction texts shows that high-impact publications maintain a semantic cohesion index of above 0.85 across chapters."
				}
			];

			if (topic.includes("space") || topic.includes("mars") || topic.includes("universe")) {
				facts = [
					{
						title: "NASA Mars Exploration Program Update",
						url: "https://mars.nasa.gov/news/latest",
						snippet: "The Perseverance rover confirmed carbon-bearing organic compounds on Mars, suggesting that historical microbial habitats could have existed."
					},
					{
						title: "SpaceX Starship Orbital Velocity Dynamics",
						url: "https://spacex.com/starship/flight-test-reports",
						snippet: "Starship reached a target orbital speed of 26,500 km/h, proving that multi-planetary heavy-lifting spacecraft structures are structurally viable."
					},
					{
						title: "European Space Agency Deep Space Habitability",
						url: "https://esa.int/science/deep-space-grounding",
						snippet: "Recent simulations indicate that lunar regolith printing provides up to 92% radiation shielding efficiency for deep space operations."
					}
				];
			} else if (topic.includes("ai") || topic.includes("intelligence") || topic.includes("technology")) {
				facts = [
					{
						title: "IEEE Transactions on Neural Architecture Evolution",
						url: "https://ieee.org/ai-neural-evolution",
						snippet: "Varying parameters like context length shows that attention weight alignment using grounding vectors guarantees factuality scores of 99.1%."
					},
					{
						title: "MIT Artificial Intelligence Laboratory Review",
						url: "https://mit.edu/ai-lab/reports/reasoning",
						snippet: "Multi-agent reflection paradigms (where one agent writes and another self-corrects) reduce semantic circular logic issues by 34%."
					},
					{
						title: "Deloitte AI & Automation Enterprise Metrics",
						url: "https://deloitte.com/insights/ai-metrics-2026",
						snippet: "Enterprise adoption of automated document generation saw a 220% increase, focusing largely on compliant fact-grounded reporting frameworks."
					}
				];
			}

			return json({
				success: true,
				query,
				results: facts,
				source: 'mock'
			});
		}

		// Live API Call to Exa AI
		const response = await fetch('https://api.exa.ai/search', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey
			},
			body: JSON.stringify({
				query: query,
				useAutoprompt: true,
				numResults: 5,
				type: 'neural'
			})
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Exa API error (${response.status}): ${errText}`);
		}

		const data = await response.json();
		
		const results = (data.results || []).map((item: any) => ({
			title: item.title || 'Untitled Source',
			url: item.url || '#',
			snippet: item.text ? item.text.substring(0, 300) + '...' : 'No snippet available.'
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
