/**
 * Stands in for the GitHub API while the publisher or the collector runs under test, so no test
 * reaches GitHub or needs a token. It serves the diff in STUB_DIFF, the review threads in
 * STUB_THREADS as GraphQL returns them, and the pull request comments in STUB_COMMENTS, and it
 * appends every write, including any GraphQL mutation, to the JSON array in STUB_WRITES.
 *
 * Like GitHub, it lists a thread for each comment of a review posted during the run, and
 * resolving or reopening a thread changes what it lists.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const load = (variable, fallback) =>
	process.env[variable] && existsSync(process.env[variable])
		? JSON.parse(readFileSync(process.env[variable], 'utf8'))
		: fallback;

const threads = load('STUB_THREADS', []);
const postedThreads = [];
const comments = load('STUB_COMMENTS', []);

const reply = body => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function record(method, path, body) {
	const writes = load('STUB_WRITES', []);
	writes.push({ method, path, body });
	writeFileSync(process.env.STUB_WRITES, JSON.stringify(writes));
}

globalThis.fetch = (url, options = {}) => {
	const method = options.method ?? 'GET';
	const { pathname, searchParams } = new URL(url);

	if (method === 'POST' && pathname === '/graphql') {
		const { query, variables } = JSON.parse(options.body);
		const listed = [...threads, ...postedThreads];
		if (query.includes('mutation')) {
			record(method, pathname, { query, variables });
			const thread = listed.find(item => item.id === variables.id);
			if (thread)
				thread.isResolved = query.includes('resolveReviewThread(') && !query.includes('unresolve');
			return reply({ data: {} });
		}
		const start = Number(variables.after ?? 0);
		const nodes = listed.slice(start, start + Number(process.env.STUB_THREAD_PAGE_SIZE ?? 50));
		const end = start + nodes.length;
		const pageInfo = { hasNextPage: end < listed.length, endCursor: String(end) };
		return reply({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } } });
	}
	if (method !== 'GET') {
		const body = JSON.parse(options.body);
		record(method, pathname, body);
		if (pathname.endsWith('/reviews')) {
			for (const comment of body.comments) {
				const index = postedThreads.length;
				postedThreads.push({
					id: `posted-${index}`,
					isResolved: false,
					isOutdated: false,
					comments: {
						nodes: [
							{ databaseId: 900 + index, body: comment.body, author: { login: 'github-actions' } },
						],
					},
				});
			}
		}
		return reply({
			id: 99,
			html_url: 'https://github.com/Mikode13/slop-lab/pull/7#issuecomment-99',
		});
	}
	if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/u.test(pathname)) {
		const page = Number(searchParams.get('page') ?? 1);
		return reply(comments.slice((page - 1) * 100, page * 100));
	}
	if (options.headers?.accept?.endsWith('diff')) {
		return Promise.resolve({
			ok: true,
			text: () => Promise.resolve(readFileSync(process.env.STUB_DIFF, 'utf8')),
		});
	}
	return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
};
