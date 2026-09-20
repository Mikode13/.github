/**
 * Reads back what earlier reviews published on a pull request, so a new review can recheck it
 * and the publisher can tell what already exists.
 *
 * Every finding the publisher posts carries its data in a hidden marker: a finding with a
 * conversation in the comment that opened it, and a finding without one in the ledger of the
 * summary comment. Only markers written by the Actions bot count. Text the reviewer wrote
 * cannot carry one, because the publisher escapes "<" and ">" in everything it renders.
 */

import { severities } from './contract.mjs';

const botLogins = new Set(['github-actions', 'github-actions[bot]']);
const isBot = author => botLogins.has(author?.login);

export const summaryMarker = '<!-- mikode-ai-review-summary -->';

/** A hidden comment holding `value`, encoded so that no character of it can end the comment. */
export const marker = (kind, value) =>
	`<!-- mikode-ai-review-${kind}:${Buffer.from(JSON.stringify(value)).toString('base64url')} -->`;

export function readMarker(kind, body) {
	const match = new RegExp(`<!-- mikode-ai-review-${kind}:([\\w-]+) -->`, 'u').exec(body ?? '');
	if (!match) return null;
	try {
		return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
	} catch {
		return null;
	}
}

const isText = value => typeof value === 'string' && value.trim() !== '';
const isNullableText = value => value === null || isText(value);

/** An earlier finding as the review contract's input defines it, or null for anything else. */
export function toEarlierFinding(value) {
	const location = value?.location;
	const valid =
		isText(value?.key) &&
		(value.severity === null || severities.includes(value.severity)) &&
		isText(value.title) &&
		isText(value.problem) &&
		isText(location?.path) &&
		isNullableText(location.revision) &&
		(location.line === null || (Number.isInteger(location.line) && location.line >= 1)) &&
		isNullableText(location.symbol);
	if (!valid) return null;

	const { path, revision, line, symbol } = location;
	return {
		key: value.key,
		severity: value.severity,
		title: value.title,
		problem: value.problem,
		location: { path, revision, line, symbol },
	};
}

export function createGitHub(token) {
	async function request(
		path,
		{ method = 'GET', body, accept = 'application/vnd.github+json' } = {},
	) {
		const response = await fetch(`https://api.github.com${path}`, {
			method,
			headers: {
				accept,
				authorization: `Bearer ${token}`,
				'x-github-api-version': '2022-11-28',
				...(body ? { 'content-type': 'application/json' } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`);
		return accept.endsWith('diff') ? response.text() : response.json();
	}

	async function graphql(query, variables) {
		const response = await request('/graphql', { method: 'POST', body: { query, variables } });
		if (response.errors?.length) {
			throw new Error(response.errors.map(error => error.message).join('; '));
		}
		return response.data;
	}

	return { request, graphql };
}

const threadsQuery = `
	query ($owner: String!, $name: String!, $number: Int!, $after: String) {
		repository(owner: $owner, name: $name) {
			pullRequest(number: $number) {
				reviewThreads(first: 50, after: $after) {
					pageInfo { hasNextPage endCursor }
					nodes {
						id
						isResolved
						isOutdated
						comments(first: 100) { nodes { databaseId body author { login } } }
					}
				}
			}
		}
	}
`;

async function readThreads(github, repository, pullNumber) {
	const [owner, name] = repository.split('/');
	const threads = [];
	let after = null;

	do {
		const data = await github.graphql(threadsQuery, { owner, name, number: pullNumber, after });
		const { nodes, pageInfo } = data.repository.pullRequest.reviewThreads;
		for (const node of nodes) {
			const [first, ...replies] = node.comments.nodes;
			const finding = isBot(first?.author)
				? toEarlierFinding(readMarker('finding', first.body))
				: null;
			if (finding === null) continue;

			// The last state the publisher stated in this conversation, so it never says it twice.
			const last = replies
				.filter(reply => isBot(reply.author))
				.map(reply => readMarker('recheck', reply.body))
				.findLast(state => state !== null);
			threads.push({
				id: node.id,
				commentId: first.databaseId,
				isResolved: node.isResolved,
				isOutdated: node.isOutdated,
				finding,
				last: last ?? null,
			});
		}
		after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
	} while (after !== null);

	return threads;
}

async function readSummary(github, repository, pullNumber) {
	for (let page = 1; ; page += 1) {
		const comments = await github.request(
			`/repos/${repository}/issues/${pullNumber}/comments?per_page=100&page=${page}`,
		);
		const summary = comments.find(
			comment => isBot(comment.user) && (comment.body ?? '').startsWith(summaryMarker),
		);
		if (summary) {
			const ledger = readMarker('ledger', summary.body);
			return {
				id: summary.id,
				body: summary.body,
				url: summary.html_url,
				ledger: (Array.isArray(ledger) ? ledger : []).map(toEarlierFinding).filter(Boolean),
			};
		}
		if (comments.length < 100) return null;
	}
}

/**
 * Returns the conversations earlier reviews opened, the summary comment, and the earlier
 * findings a new review has to recheck: every finding with a conversation, open or closed, and
 * every finding the summary still carries without one.
 */
export async function readReviewState(github, { repository, pullNumber }) {
	const threads = await readThreads(github, repository, Number(pullNumber));
	const summary = await readSummary(github, repository, pullNumber);

	const earlier = new Map();
	for (const finding of [...threads.map(thread => thread.finding), ...(summary?.ledger ?? [])]) {
		if (!earlier.has(finding.key)) earlier.set(finding.key, finding);
	}
	return { threads, summary, earlier: [...earlier.values()] };
}
