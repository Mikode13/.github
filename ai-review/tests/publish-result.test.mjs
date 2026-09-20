import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { deriveOutcome, perspectiveKeys, validateResult } from '../contract.mjs';
import { readMarker, summaryMarker } from '../review-state.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const publisher = join(here, '..', 'publish-result.mjs');
const collector = join(here, '..', 'collect-earlier-findings.mjs');
const stub = pathToFileURL(join(here, 'support', 'github-stub.mjs')).href;

const repository = 'Mikode13/slop-lab';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);

// One hunk that adds lines 1 to 3 of src/changed.js; src/untouched.js is not in the diff.
const diff = [
	'diff --git a/src/changed.js b/src/changed.js',
	'--- /dev/null',
	'+++ b/src/changed.js',
	'@@ -0,0 +1,3 @@',
	'+one',
	'+two',
	'+three',
	'',
].join('\n');

const finding = (id, overrides = {}) => ({
	id,
	severity: 'SHOULD FIX',
	origin: 'introduced',
	relevance: 'change',
	blocking: false,
	title: `Finding ${id}`,
	problem: `Problem ${id}.`,
	consequence: `Consequence ${id}.`,
	recommended_direction: `Direction ${id}.`,
	location: { path: 'src/changed.js', revision: head, line: 2, symbol: null },
	evidence: [
		{
			source: { ref: 'src/changed.js', revision: head },
			kind: 'inspected',
			observation: 'The defect is visible at this location.',
		},
	],
	...overrides,
});

const blocker = (id, overrides = {}) =>
	finding(id, { severity: 'BLOCKER', blocking: true, ...overrides });

const at = (path, line) => ({ location: { path, revision: head, line, symbol: null } });

const incidental = { origin: 'pre_existing', relevance: 'incidental' };

/** A valid result with `findings` and `fields`, whose outcome the contract derives. */
function resultWith(findings, fields = {}) {
	const result = {
		version: 2,
		scope: { repository, base, head, paths: ['src/changed.js'] },
		outcome: 'clean',
		perspectives: Object.fromEntries(
			perspectiveKeys.map(key => [
				key,
				{
					depth: 'baseline',
					coverage: 'complete',
					reason: 'Reviewed against the supplied evidence.',
					skills: [],
					finding_ids: key === 'correctness_regression' ? findings.map(item => item.id) : [],
				},
			]),
		),
		findings,
		verification: findings.map(item => ({
			candidate_id: `candidate-${item.id}`,
			disposition: 'confirmed',
			finding_id: item.id,
			reason: 'Confirmed against the diff.',
			checked_sources: [],
		})),
		rechecks: [],
		limitations: [],
		questions: [],
		context: [],
		follow_up: [],
		...fields,
	};
	return { ...result, outcome: deriveOutcome(result) };
}

const botAuthor = { login: 'github-actions' };

/** The review threads GitHub would return for the comments `review` posted. */
const threadsFor = (review, { isResolved = false, isOutdated = false, replies = [] } = {}) =>
	review.comments.map((comment, index) => ({
		id: `thread-${index}`,
		isResolved,
		isOutdated,
		comments: {
			nodes: [
				{ databaseId: 100 + index, body: comment.body, author: botAuthor },
				...replies.map(body => ({ databaseId: 200 + index, body, author: botAuthor })),
			],
		},
	}));

const summaryComment = (body, login = 'github-actions[bot]') => ({
	id: 5,
	body,
	user: { login },
	html_url: 'https://github.com/Mikode13/slop-lab/pull/7#issuecomment-5',
});

const keyOf = comment => readMarker('finding', comment.body);

/**
 * Runs `script` against the stub with the given threads and pull request comments. Returns its
 * exit status and output, every write, the job summary, and the step outputs.
 */
function run(script, { threads = [], comments = [], env = {} } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'ai-review-publish-'));
	const file = name => join(directory, name);
	writeFileSync(file('change.diff'), diff);
	writeFileSync(file('threads.json'), JSON.stringify(threads));
	writeFileSync(file('comments.json'), JSON.stringify(comments));

	const execution = spawnSync(process.execPath, ['--import', stub, script], {
		encoding: 'utf8',
		env: {
			...process.env,
			ANALYZE_RESULT: 'success',
			BASE_SHA: base,
			EVIDENCE_DIR: directory,
			GITHUB_OUTPUT: file('output.txt'),
			GITHUB_STEP_SUMMARY: file('summary.md'),
			GITHUB_TOKEN: 'test-token',
			HEAD_SHA: head,
			PR_NUMBER: '7',
			REPOSITORY: repository,
			STUB_COMMENTS: file('comments.json'),
			STUB_DIFF: file('change.diff'),
			STUB_THREADS: file('threads.json'),
			STUB_WRITES: file('writes.json'),
			...env,
		},
	});

	const read = (name, fallback) =>
		existsSync(file(name)) ? readFileSync(file(name), 'utf8') : fallback;
	return {
		status: execution.status,
		stdout: execution.stdout,
		stderr: execution.stderr,
		writes: JSON.parse(read('writes.json', '[]')),
		jobSummary: read('summary.md', ''),
		outputs: read('output.txt', ''),
		earlier: JSON.parse(read('earlier-findings.json', 'null')),
	};
}

/**
 * Publishes `result` with `earlier` as the findings the reviewer was asked to recheck. Returns
 * the run with the posted review, the summary comment body, and the replies picked out.
 */
function publish(result, { earlier = [], report = {}, threads, comments, env } = {}) {
	if (report.valid !== false) {
		assert.deepEqual(validateResult(result, { repository, base, head, earlier }).errors, []);
	}
	const execution = run(publisher, {
		threads,
		comments,
		env: {
			REPORT: JSON.stringify({
				valid: true,
				outcome: result.outcome,
				errors: [],
				earlier,
				result,
				...report,
			}),
			...env,
		},
	});
	assert.equal(execution.stderr, '');

	const writes = path => execution.writes.filter(write => path.test(write.path));
	return {
		...execution,
		review: writes(/\/pulls\/7\/reviews$/u)[0]?.body ?? null,
		summary: writes(/\/issues\/(?:7|comments\/5)/u)[0] ?? null,
		replies: writes(/\/replies$/u).map(write => write.body.body),
		mutations: writes(/^\/graphql$/u).map(
			write => `${/(\w+)ReviewThread/u.exec(write.body.query)[1]} ${write.body.variables.id}`,
		),
	};
}

/** Publishes `result` once, and returns it with the threads and summary GitHub would then show. */
function published(result, options) {
	const first = publish(result, options);
	return {
		...first,
		threads: options => (first.review ? threadsFor(first.review, options) : []),
		comments: [summaryComment(first.summary.body.body)],
	};
}

test('a BLOCKER is commented on its line, named in the summary, and fails the check', () => {
	const { status, outputs, review, summary } = publish(resultWith([blocker('F1')]), {
		report: { attempts: 1 },
	});

	assert.equal(status, 1);
	assert.match(outputs, /outcome=blocked\npublished=true/u);
	assert.equal(review.comments[0].line, 2);
	assert.match(
		review.comments[0].body,
		/Blocker: `AI Review \/ required` fails while a review still finds this, so the pull request cannot merge\./u,
	);
	assert.match(summary.body.body, /Not ready to merge: 1 blocking finding\./u);
	assert.match(summary.body.body, /Commit bbbbbbb · 1 provider turn$/mu);
	assert.match(summary.body.body, /- \*\*\[BLOCKER\] Finding F1\*\* \(`src\/changed\.js:2`\)$/mu);
	assert.doesNotMatch(summary.body.body, /Problem F1/u);
});

test('a SHOULD FIX of the change passes the check but leaves a conversation that holds the merge', () => {
	const { status, outputs, review, mutations } = publish(resultWith([finding('F1')]));

	assert.equal(status, 0);
	assert.match(outputs, /outcome=concerns/u);
	assert.match(review.comments[0].body, /Problem F1\. Consequence F1\.\n\nDirection F1\./u);
	assert.match(
		review.comments[0].body,
		/This conversation blocks the merge\. Resolve it only after fixing this in the code or opening an issue that tracks it; if the finding is wrong, reply with the reason first\./u,
	);
	assert.deepEqual(mutations, []);
});

test('a SUGGESTION of the change holds the merge like a SHOULD FIX but can be resolved without a change', () => {
	const { status, outputs, review, mutations } = publish(
		resultWith([finding('F1', { severity: 'SUGGESTION' })]),
	);

	assert.equal(status, 0);
	assert.match(outputs, /outcome=suggestions/u);
	assert.match(
		review.comments[0].body,
		/This conversation blocks the merge until it is resolved\. It is optional: resolve it once read, with or without a change\./u,
	);
	assert.deepEqual(mutations, []);
});

test('a finding unrelated to the change opens no conversation and is listed for triage', () => {
	const { status, outputs, review, summary } = publish(resultWith([finding('F1', incidental)]));

	assert.equal(status, 0);
	assert.match(outputs, /outcome=clean/u);
	assert.equal(review, null);
	assert.match(
		summary.body.body,
		/### Found outside this change\n\n- \*\*\[SHOULD FIX · pre-existing\] Finding F1\*\* \(`src\/changed\.js:2`\)\. Problem F1\./u,
	);
});

test('a pre-existing BLOCKER outside the diff still blocks, and the summary explains it', () => {
	const { status, review, summary } = publish(
		resultWith([blocker('F1', { ...incidental, ...at('src/untouched.js', 5) })]),
	);

	assert.equal(status, 1);
	assert.equal(review, null);
	assert.match(
		summary.body.body,
		/- \*\*\[BLOCKER · pre-existing\] Finding F1\*\* \(`src\/untouched\.js:5`\)\. Problem F1\. Consequence F1\. Direction F1\./u,
	);
});

test('a finding about a whole file is commented on its first changed line and names no line', () => {
	const { review, summary } = publish(resultWith([blocker('F1', at('src/changed.js', null))]));

	assert.equal(review.comments[0].line, 1);
	assert.match(review.comments[0].body, /About the whole file, not this line\./u);
	assert.match(summary.body.body, /\(`src\/changed\.js`\)/u);
	assert.doesNotMatch(summary.body.body, /src\/changed\.js:1/u);
});

test('a finding of the change without a line in the diff is described in the summary', () => {
	const { review, summary } = publish(resultWith([finding('F1', at('src/changed.js', 40))]));

	assert.equal(review, null);
	assert.match(
		summary.body.body,
		/### Not on a line of the diff\n\n- \*\*\[SHOULD FIX\] Finding F1\*\* \(`src\/changed\.js:40`\)\. Problem F1\. Consequence F1\. Direction F1\./u,
	);
});

test('the summary comment is created once and then updated in place', () => {
	const first = published(resultWith([finding('F1')]));
	assert.equal(first.summary.method, 'POST');
	assert.ok(first.summary.body.body.startsWith(summaryMarker));

	const second = publish(resultWith([]), { comments: first.comments });
	assert.equal(second.summary.method, 'PATCH');
	assert.equal(second.summary.path, `/repos/${repository}/issues/comments/5`);

	const copied = publish(resultWith([]), {
		comments: [summaryComment(first.summary.body.body, 'someone')],
	});
	assert.equal(copied.summary.method, 'POST');
});

test('publishing the same report again writes nothing', () => {
	const result = resultWith([finding('F1'), finding('F2', incidental)], {
		follow_up: ['F1: Add a regression test.', 'F2: Triage it.'],
	});
	const first = published(result);
	const again = publish(result, { threads: first.threads(), comments: first.comments });

	assert.equal(first.review.comments.length, 1);
	assert.deepEqual(again.writes, []);
});

test('a different result publishes its own comments even when its summary reads the same', () => {
	const first = published(resultWith([finding('F1')]));
	const other = publish(resultWith([finding('F1', { problem: 'Another problem.' })]), {
		threads: first.threads(),
		comments: first.comments,
	});

	assert.equal(other.summary, null);
	assert.equal(other.review.comments.length, 1);
	assert.match(other.review.comments[0].body, /Another problem\./u);
});

/** An earlier review of F1, and the fields a new result needs to recheck it. */
function earlierReview(first) {
	const entry = keyOf(first.review.comments[0]);
	const recheck = (status, findingId = null) => ({
		earlier: [entry],
		fields: {
			rechecks: [{ key: entry.key, status, finding_id: findingId, reason: `It is ${status}.` }],
		},
	});
	return { entry, recheck };
}

test('an earlier finding still on its line gets no new comment and no reply', () => {
	const first = published(resultWith([finding('F1')]));
	const { recheck } = earlierReview(first);
	const { earlier, fields } = recheck('present', 'F7');

	const again = publish(resultWith([finding('F7')], fields), {
		earlier,
		threads: first.threads(),
		comments: first.comments,
	});

	assert.equal(again.status, 0);
	assert.equal(again.review, null);
	assert.deepEqual(again.replies, []);
});

test('an earlier finding that moved is answered once in its conversation', () => {
	const first = published(resultWith([finding('F1')]));
	const { earlier, fields } = earlierReview(first).recheck('present', 'F7');
	const moved = resultWith([finding('F7', at('src/changed.js', 3))], fields);

	const again = publish(moved, {
		earlier,
		threads: first.threads({ isOutdated: true }),
		comments: first.comments,
	});
	assert.equal(again.review, null);
	assert.equal(again.replies.length, 1);
	assert.match(
		again.replies[0],
		/^Still present in bbbbbbb, at `src\/changed\.js:3`: It is present\./u,
	);

	const thirdTime = publish(moved, {
		earlier,
		threads: first.threads({ isOutdated: true, replies: again.replies }),
		comments: first.comments,
	});
	assert.deepEqual(thirdTime.replies, []);
});

test('an earlier finding that looks fixed is answered, and its conversation is left open', () => {
	const first = published(resultWith([finding('F1')]));
	const { earlier, fields } = earlierReview(first).recheck('fixed');

	const open = publish(resultWith([], fields), {
		earlier,
		threads: first.threads(),
		comments: first.comments,
	});
	assert.equal(open.status, 0);
	assert.equal(open.replies.length, 1);
	assert.match(
		open.replies[0],
		/^Looks fixed in bbbbbbb: It is fixed\. Close this conversation if you agree\./u,
	);
	assert.equal(open.writes.filter(write => write.path === '/graphql').length, 0);

	const closed = publish(resultWith([], fields), {
		earlier,
		threads: first.threads({ isResolved: true }),
		comments: first.comments,
	});
	assert.deepEqual(closed.replies, []);
});

test('a suggestion someone resolved reopens once when it is found again as a SHOULD FIX', () => {
	const first = published(resultWith([finding('F1', { severity: 'SUGGESTION' })]));
	const { earlier, fields } = earlierReview(first).recheck('present', 'F7');
	const worse = resultWith([finding('F7')], fields);

	const again = publish(worse, {
		earlier,
		threads: first.threads({ isResolved: true }),
		comments: first.comments,
	});
	assert.equal(again.review, null);
	assert.deepEqual(again.mutations, ['unresolve thread-0']);
	const order = again.writes.map(write => write.path);
	assert.ok(order.indexOf('/graphql') < order.findIndex(path => path.endsWith('/replies')));
	assert.equal(again.replies.length, 1);
	assert.match(
		again.replies[0],
		/^Now SHOULD FIX in bbbbbbb, at `src\/changed\.js:2`: It is present\. This conversation blocks the merge\. Resolve it only after/u,
	);

	const resolvedByAPerson = publish(worse, {
		earlier,
		threads: first.threads({ isResolved: true, replies: again.replies }),
		comments: first.comments,
	});
	assert.deepEqual(resolvedByAPerson.mutations, []);
	assert.deepEqual(resolvedByAPerson.replies, []);
});

test('a BLOCKER whose conversation was closed still blocks, and the summary says so', () => {
	const first = published(resultWith([blocker('F1')]));
	const { earlier, fields } = earlierReview(first).recheck('present', 'F7');

	const again = publish(resultWith([blocker('F7')], fields), {
		earlier,
		threads: first.threads({ isResolved: true }),
		comments: first.comments,
	});

	assert.equal(again.status, 1);
	assert.equal(again.review, null);
	assert.deepEqual(again.replies, []);
	assert.match(
		again.summary.body.body,
		/Its conversation was closed, but the review still finds it\./u,
	);
});

test('a finding without a conversation stays in the summary while present and leaves when fixed', () => {
	const first = published(resultWith([finding('F1', incidental)]));
	const [entry] = readMarker('ledger', first.summary.body.body);
	const recheck = status => ({
		rechecks: [
			{
				key: entry.key,
				status,
				finding_id: status === 'present' ? 'F7' : null,
				reason: 'Checked.',
			},
		],
	});

	const present = publish(resultWith([finding('F7', incidental)], recheck('present')), {
		earlier: [entry],
		comments: first.comments,
	});
	assert.match(present.summary.body.body, /### Found outside this change\n\n- .*Finding F7/u);
	assert.deepEqual(
		readMarker('ledger', present.summary.body.body).map(item => item.key),
		[entry.key],
	);

	const fixed = publish(resultWith([], recheck('fixed')), {
		earlier: [entry],
		comments: first.comments,
	});
	assert.match(
		fixed.summary.body.body,
		/### Earlier findings\n\n- Looks fixed: \*\*\[SHOULD FIX\] Finding F1\*\* \(`src\/changed\.js:2`\)\. Checked\./u,
	);
	assert.deepEqual(readMarker('ledger', fixed.summary.body.body), []);
});

test('an earlier finding the review could not recheck is named and kept', () => {
	const first = published(resultWith([finding('F1', incidental)]));
	const [entry] = readMarker('ledger', first.summary.body.body);

	const again = publish(
		resultWith([], {
			rechecks: [
				{
					key: entry.key,
					status: 'undetermined',
					finding_id: null,
					reason: 'The file is missing.',
				},
			],
		}),
		{ earlier: [entry], comments: first.comments },
	);

	assert.match(
		again.summary.body.body,
		/- Could not recheck: .*Finding F1.*The file is missing\./u,
	);
	assert.deepEqual(readMarker('ledger', again.summary.body.body), [entry]);
});

test('the gate follows the outcome revalidation derives, not the outcome the report claims', () => {
	const result = resultWith([blocker('F1')]);
	const { status, outputs, summary } = publish(result, { report: { outcome: 'clean' } });

	assert.equal(status, 1);
	assert.match(outputs, /outcome=blocked\npublished=true/u);
	assert.match(summary.body.body, /## AI review: blocked/u);
});

test('a result that leaves an earlier finding unrechecked is incomplete', () => {
	const first = published(resultWith([finding('F1')]));
	const { entry } = earlierReview(first);

	const again = run(publisher, {
		threads: first.threads(),
		comments: first.comments,
		env: {
			REPORT: JSON.stringify({
				valid: true,
				outcome: 'clean',
				errors: [],
				earlier: [entry],
				result: resultWith([]),
			}),
		},
	});

	assert.equal(again.status, 1);
	const [summary] = again.writes;
	assert.match(summary.body.body, /## AI review: incomplete/u);
	assert.match(
		summary.body.body,
		/On revalidation: The earlier finding [\w-]+ was not rechecked\./u,
	);
});

test('an invalid report keeps and still shows the findings the previous summary carried', () => {
	const first = published(resultWith([finding('F1', incidental)]));
	const ledger = readMarker('ledger', first.summary.body.body);

	const failed = publish(resultWith([]), {
		report: {
			valid: false,
			outcome: 'incomplete',
			errors: ['The reviewer timed out.'],
			result: null,
		},
		comments: first.comments,
	});

	assert.equal(failed.status, 1);
	assert.match(failed.outputs, /outcome=incomplete\npublished=true/u);
	assert.match(failed.summary.body.body, /- The reviewer timed out\./u);
	assert.match(
		failed.summary.body.body,
		/### Found by earlier reviews, not rechecked\n\n- \*\*\[SHOULD FIX\] Finding F1\*\* \(`src\/changed\.js:2`\)\. Problem F1\./u,
	);
	assert.deepEqual(readMarker('ledger', failed.summary.body.body), ledger);
});

test('an analysis that stopped for a known reason gives that reason instead of its conclusion', () => {
	const reason = 'The pull request conflicts with `main`.';
	const stopped = publish(resultWith([]), {
		report: { valid: false, outcome: 'incomplete', errors: [reason], result: null },
		env: { ANALYZE_RESULT: 'failure' },
	});
	assert.equal(stopped.status, 1);
	assert.match(
		stopped.summary.body.body,
		/## AI review: incomplete\n[^#]*\n- The pull request conflicts/u,
	);
	assert.doesNotMatch(stopped.summary.body.body, /ended as/u);

	const silent = publish(resultWith([]), {
		report: { valid: false },
		env: { ANALYZE_RESULT: 'cancelled', REPORT: '' },
	});
	assert.match(
		silent.summary.body.body,
		/- The analysis job ended as "cancelled" and produced no result\./u,
	);

	const failedLate = publish(resultWith([finding('F1')]), { env: { ANALYZE_RESULT: 'failure' } });
	assert.match(failedLate.summary.body.body, /- The analysis job ended as "failure"\./u);
	assert.equal(failedLate.review, null);
});

test('follow-up that names a finding joins its comment, and the rest stays in the summary', () => {
	const { review, summary } = publish(
		resultWith([finding('F1'), finding('F2', at('src/changed.js', 3))], {
			follow_up: ['F1: Add a regression test.', 'F1 and F2: Test both.', 'Re-run the checks.'],
		}),
	);

	assert.match(review.body, /: 2 new comments\./u);
	assert.match(review.comments[0].body, /Follow-up: Add a regression test\./u);
	assert.match(review.comments[0].body, /Follow-up: Test both\./u);
	assert.match(review.comments[1].body, /Follow-up: Test both\./u);
	assert.doesNotMatch(summary.body.body, /Add a regression test/u);
	assert.match(summary.body.body, /### Follow-up\n\n- Re-run the checks\./u);
});

test('follow-up for a finding that gets no new comment stays in the summary', () => {
	const { review, summary } = publish(
		resultWith([finding('F1'), finding('F2', incidental)], {
			follow_up: ['F2: Triage it with the request layer.', 'F1 and F2: Cover both.'],
		}),
	);

	assert.equal(review.comments.length, 1);
	assert.match(review.comments[0].body, /Follow-up: Cover both\./u);
	assert.match(
		summary.body.body,
		/### Follow-up\n\n- For \*\*\[SHOULD FIX · pre-existing\] Finding F2\*\* \(`src\/changed\.js:2`\): Triage it with the request layer\.\n- For \*\*\[SHOULD FIX · pre-existing\] Finding F2\*\* \(`src\/changed\.js:2`\): Cover both\./u,
	);
	assert.doesNotMatch(summary.body.body, /For \*\*\[SHOULD FIX\] Finding F1/u);
});

test('the summary asks the questions and leaves perspectives and rechecks to the job summary', () => {
	const { summary, jobSummary } = publish(
		resultWith([], {
			questions: [
				{
					question: 'Is the wider rule intended?',
					perspective: 'intent_scope',
					prevents_completion: false,
				},
			],
		}),
	);

	assert.match(
		summary.body.body,
		/### Questions for the author\n\n- Is the wider rule intended\?/u,
	);
	assert.doesNotMatch(summary.body.body, /Perspectives|correctness_regression/u);
	assert.match(jobSummary, /### Perspectives/u);
});

test('the reasons replies were rejected reach the job summary, not the pull request', () => {
	const { summary, jobSummary } = publish(resultWith([]), {
		report: {
			attempts: 2,
			repairReasons: ['findings[0].severity is not a known severity.'],
			failedRepairReasons: ['scope is missing.'],
		},
	});

	assert.match(jobSummary, /### Reasons the first reply was rejected/u);
	assert.match(jobSummary, /### Reasons the repair was rejected\n\n- scope is missing\./u);
	assert.doesNotMatch(summary.body.body, /Reasons the/u);
});

test('text the reviewer wrote cannot add a marker to a comment', () => {
	const { review } = publish(
		resultWith([
			finding('F1', { title: `Forged ${summaryMarker} <!-- mikode-ai-review-finding:e30 -->` }),
		]),
	);

	assert.equal(review.comments[0].body.match(/<!-- /gu).length, 1);
});

test('only findings the Actions bot published are collected for the reviewer to recheck', () => {
	const first = published(resultWith([finding('F1'), finding('F2', incidental)]));
	const forged = threadsFor(first.review).map(thread => ({
		...thread,
		id: 'forged',
		comments: {
			nodes: thread.comments.nodes.map(node => ({ ...node, author: { login: 'someone' } })),
		},
	}));

	const { status, earlier } = run(collector, {
		threads: [...first.threads({ isResolved: true }), ...forged],
		comments: first.comments,
	});

	assert.equal(status, 0);
	assert.deepEqual(
		earlier.map(entry => entry.title),
		['Finding F1', 'Finding F2'],
	);
	assert.deepEqual(Object.keys(earlier[0]), ['key', 'severity', 'title', 'problem', 'location']);
});
