// Only the AI review smoke job imports this module. The publisher uses its real code against
// responses recorded here, so the job can exercise publication without writing to a PR.
import { appendFileSync } from 'node:fs';

const actualFetch = globalThis.fetch;

globalThis.fetch = async (input, options = {}) => {
	const url = new URL(String(input));
	const method = options.method ?? 'GET';
	if (url.origin !== 'https://api.github.com') return actualFetch(input, options);

	const route = url.pathname;
	if (!(
		(method === 'POST' && route === '/graphql') ||
		(method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/u.test(route)) ||
		(method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/u.test(route))
	)) {
		if (method !== 'GET') throw new Error(`Unmocked GitHub write: ${method} ${route}`);
		return actualFetch(input, options);
	}

	appendFileSync(
		process.env.AI_REVIEW_SMOKE_REQUESTS,
		`${JSON.stringify({ method, route, body: options.body ?? null })}\n`,
	);

	let response;
	if (route === '/graphql') {
		response = {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
					},
				},
			},
		};
	} else {
		response = method === 'GET' ? [] : { html_url: 'https://example.invalid/ai-review-smoke' };
	}
	return Response.json(response);
};
