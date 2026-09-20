/**
 * Publishes a validated review the way a person reviewing by hand would: each finding the author
 * has to act on as a comment on its line, and one summary comment that every later review of the
 * pull request updates in place.
 *
 * This job holds write access and no provider credential, so it treats the analysis job's
 * output as data: it re-runs contract validation before believing an outcome, and it
 * neutralizes every string it renders.
 *
 * A `BLOCKER` fails the `AI Review / required` status the workflow reports from this job's
 * outcome, and so does `incomplete`. Every `SHOULD FIX` and `SUGGESTION` of the change opens a
 * conversation, which the ruleset's conversation resolution makes hold the merge until a person
 * resolves it; the comment says what resolving it takes. Findings unrelated to the change are
 * listed in the summary for a maintainer to triage.
 *
 * A later review rechecks what earlier ones found. This job never resolves or deletes a
 * conversation: it answers in it when the finding looks fixed or has moved, and resolving it
 * stays a person's decision. The one conversation it reopens is a resolved suggestion's, when a
 * later review finds the same defect is worse. Every write is identified by the finding's key,
 * so publishing the same report again posts nothing twice.
 */

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { perspectiveKeys, validateResult } from './contract.mjs';
import {
	createGitHub,
	marker,
	readReviewState,
	summaryMarker,
	toEarlierFinding,
} from './review-state.mjs';

const environment = key => {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is required`);
	return value;
};

const repository = environment('REPOSITORY');
const pullNumber = environment('PR_NUMBER');
const baseSha = environment('BASE_SHA');
const headSha = environment('HEAD_SHA');
const analyzeResult = environment('ANALYZE_RESULT');
const github = createGitHub(environment('GITHUB_TOKEN'));

const commit = headSha.slice(0, 7);
const pullPath = `/repos/${repository}/pulls/${pullNumber}`;

/** Neutralizes reviewer-authored text: no mentions, no raw HTML, no hidden comment markers. */
const sanitize = value =>
	String(value ?? '')
		.replace(/\s+/gu, ' ')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('@', '@​')
		.trim();

/**
 * Collects the lines of each file that GitHub accepts as a review comment position: the added
 * and context lines on the reviewed side of every hunk.
 */
function addressableLines(diff) {
	const files = new Map();
	let path = null;
	let line = 0;

	for (const text of diff.split('\n')) {
		if (text.startsWith('+++ ')) {
			const target = text.slice(4).trim();
			path = target === '/dev/null' ? null : target.replace(/^b\//u, '');
			if (path) files.set(path, new Set());
			continue;
		}
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (path === null || text.startsWith('---') || text.startsWith('diff ')) continue;
		if (text.startsWith('+') || text.startsWith(' ')) {
			files.get(path).add(line);
			line += 1;
		}
	}
	return files;
}

/**
 * Where a comment about `location` can go. A finding about a whole file goes on the file's first
 * changed line and says so; a finding about a line GitHub cannot comment on has no position,
 * because a comment on another line would point at code the finding is not about.
 */
function positionOf(location, lines) {
	const addressable = lines.get(location.path);
	if (!addressable || addressable.size === 0) return null;
	if (location.line === null) {
		const first = [...addressable].reduce((lowest, line) => Math.min(lowest, line));
		return { line: first, wholeFile: true };
	}
	return addressable.has(location.line) ? { line: location.line, wholeFile: false } : null;
}

const where = location =>
	location.line === null ? location.path : `${location.path}:${location.line}`;

/**
 * Follow-up items that start with the ids of findings, such as "F1: ...", "F2, F3: ...", or
 * "F2 and F3: ...", attached to those findings, and the rest.
 */
function splitFollowUp(items, findings) {
	const ids = new Set(findings.map(finding => finding.id));
	const byFinding = new Map();
	const attached = [];
	const general = [];

	for (const item of items) {
		const prefixed = /^([^:]{1,80}):\s*(.+)$/su.exec(item);
		const named = prefixed
			? prefixed[1].split(/[\s,]+/u).filter(word => word !== '' && word !== 'and')
			: [];
		if (named.length > 0 && named.every(id => ids.has(id))) {
			attached.push({ ids: named, text: prefixed[2] });
			for (const id of named) byFinding.set(id, [...(byFinding.get(id) ?? []), prefixed[2]]);
		} else {
			general.push(item);
		}
	}
	return { byFinding, attached, general };
}

const origins = { pre_existing: 'pre-existing', unknown: 'unknown origin' };

const label = finding =>
	[finding.severity ?? 'UNCLASSIFIED', origins[finding.origin]].filter(Boolean).join(' · ');

const compact = finding =>
	`**[${label(finding)}] ${sanitize(finding.title)}** (\`${sanitize(where(finding.location))}\`)`;

// What the author is expected to do with the conversation, by severity.
const closing = {
	BLOCKER:
		'Blocker: `AI Review / required` fails while a review still finds this, so the pull ' +
		'request cannot merge.',
	'SHOULD FIX':
		'This conversation blocks the merge. Resolve it only after fixing this in the code or ' +
		'opening an issue that tracks it; if the finding is wrong, reply with the reason first.',
	SUGGESTION:
		'This conversation blocks the merge until it is resolved. It is optional: resolve it once ' +
		'read, with or without a change.',
};

/**
 * Whether a resolved conversation has to hold the merge again: a person may resolve a
 * suggestion without changing anything, which a `SHOULD FIX` or `BLOCKER` does not allow. The
 * severity the conversation last stated is compared, so a person who resolves it again after
 * it was reopened is not overruled.
 */
const escalated = (thread, finding) =>
	thread.isResolved &&
	finding.severity !== 'SUGGESTION' &&
	(thread.last?.severity ?? thread.finding.severity) === 'SUGGESTION';

const reasoning = (finding, followUp) => [
	`${sanitize(finding.problem)} ${sanitize(finding.consequence)}`,
	sanitize(finding.recommended_direction),
	...followUp.map(item => `Follow-up: ${sanitize(item)}`),
];

const earlierEntry = (finding, key) =>
	toEarlierFinding({
		key,
		severity: finding.severity,
		title: finding.title,
		problem: finding.problem,
		location: finding.location,
	});

function findingComment(finding, key, followUp, wholeFile) {
	const paragraphs = [
		`**[${label(finding)}] ${sanitize(finding.title)}**`,
		...(wholeFile ? ['About the whole file, not this line.'] : []),
		...reasoning(finding, followUp),
		`_${closing[finding.severity] ?? closing['SHOULD FIX']}_`,
	];
	return `${paragraphs.join('\n\n')}\n${marker('finding', earlierEntry(finding, key))}`;
}

const emptyPlan = ledger => ({
	comments: [],
	replies: [],
	blocking: [],
	withoutLine: [],
	incidental: [],
	fixed: [],
	undetermined: [],
	reopen: [],
	ledger,
	followUp: { byFinding: new Map(), attached: [], general: [], uncarried: [] },
});

/**
 * Decides every write for a valid result: the comments to open, the replies to post in earlier
 * conversations, what the summary lists, and the ledger of findings that have no conversation.
 */
function plan(result, earlierFindings, state, lines) {
	// A finding reported for the first time is keyed by this result, so the same report published
	// again finds its own comments instead of posting them twice, and a different result never
	// mistakes another result's comments for its own.
	const fingerprint = createHash('sha256')
		.update(JSON.stringify(result))
		.digest('hex')
		.slice(0, 12);
	const threads = new Map(state.threads.map(thread => [thread.finding.key, thread]));
	const earlier = new Map(earlierFindings.map(finding => [finding.key, finding]));
	const findings = new Map(result.findings.map(finding => [finding.id, finding]));
	const planned = {
		...emptyPlan([]),
		followUp: { ...splitFollowUp(result.follow_up, result.findings), uncarried: [] },
	};

	// The findings whose follow-up items appear with them: in the comment this result opens, now or
	// on an earlier delivery of the same report, or in a summary entry that gives the reasoning.
	const carried = new Set();

	const presentKeys = new Map();
	for (const recheck of result.rechecks.filter(item => item.status === 'present')) {
		const keys = presentKeys.get(recheck.finding_id) ?? [];
		presentKeys.set(recheck.finding_id, [...keys, recheck.key]);
	}

	for (const finding of result.findings) {
		const keys = [...(presentKeys.get(finding.id) ?? []), `${fingerprint}-${finding.id}`];
		const key = keys.find(candidate => threads.has(candidate)) ?? keys[0];
		const thread = threads.get(key);
		const items = planned.followUp.byFinding.get(finding.id) ?? [];
		let conversation = null;
		if (thread) {
			conversation = thread.isResolved && !escalated(thread, finding) ? 'closed' : 'open';
		}

		const position = positionOf(finding.location, lines);
		if (!thread && position && (finding.blocking || finding.relevance === 'change')) {
			planned.comments.push({
				path: finding.location.path,
				line: position.line,
				side: 'RIGHT',
				body: findingComment(finding, key, items, position.wholeFile),
			});
			conversation = 'new';
		}
		if (conversation === null) planned.ledger.push(earlierEntry(finding, key));
		const ownComment = thread !== undefined && key === `${fingerprint}-${finding.id}`;
		if (
			conversation === 'new' ||
			ownComment ||
			(conversation === null && (finding.blocking || finding.relevance === 'change'))
		) {
			carried.add(finding.id);
		}

		if (finding.blocking) {
			planned.blocking.push({ finding, conversation, items });
		} else if (conversation === null && finding.relevance === 'change') {
			planned.withoutLine.push({ finding, items });
		} else if (conversation === null) {
			planned.incidental.push(finding);
		}
	}

	// A finding that already has a conversation, or that the summary names in one line, shows no
	// follow-up, so an item attached to it stays in the summary instead of reaching no reader.
	for (const { ids, text } of planned.followUp.attached) {
		const uncarried = ids.filter(id => !carried.has(id));
		if (uncarried.length > 0) {
			planned.followUp.uncarried.push({ about: uncarried.map(id => findings.get(id)), text });
		}
	}

	for (const recheck of result.rechecks) {
		const thread = threads.get(recheck.key);
		const finding = earlier.get(recheck.key);
		if (recheck.status === 'undetermined') {
			planned.undetermined.push({ finding, recheck });
			if (!thread) planned.ledger.push(finding);
			continue;
		}
		if (!thread) {
			if (recheck.status === 'fixed') planned.fixed.push({ finding, recheck });
			continue;
		}
		const current = findings.get(recheck.finding_id);
		if (recheck.status === 'present' && escalated(thread, current)) {
			const now = where(current.location);
			planned.reopen.push(thread);
			planned.replies.push({
				thread,
				body:
					`Now ${current.severity} in ${commit}, at \`${sanitize(now)}\`: ${sanitize(recheck.reason)} ` +
					`${closing[current.severity] ?? closing['SHOULD FIX']}\n` +
					marker('recheck', { status: 'present', where: now, severity: current.severity }),
			});
			continue;
		}
		if (thread.isResolved) continue;

		// Say something only when it changes what the conversation already states: that the
		// finding looks fixed, that it is back, or that it moved away from the commented line.
		const last = thread.last ?? { status: 'present', where: where(thread.finding.location) };
		if (recheck.status === 'fixed') {
			if (last.status === 'fixed') continue;
			planned.replies.push({
				thread,
				body:
					`Looks fixed in ${commit}: ${sanitize(recheck.reason)} ` +
					`Close this conversation if you agree.\n${marker('recheck', { status: 'fixed' })}`,
			});
			continue;
		}
		const now = where(current.location);
		const moved = thread.isOutdated && last.where !== now;
		if (last.status === 'present' && !moved) continue;
		planned.replies.push({
			thread,
			body:
				`Still present in ${commit}, at \`${sanitize(now)}\`: ${sanitize(recheck.reason)}\n` +
				marker('recheck', { status: 'present', where: now, severity: current.severity }),
		});
	}

	return planned;
}

/** "1 new comment", "2 new comments": `plural` defaults to the singular with an "s". */
const count = (number, singular, plural = `${singular}s`) =>
	`${String(number)} ${number === 1 ? singular : plural}`;

const section = (title, items) => (items.length > 0 ? ['', `### ${title}`, '', ...items] : []);

function formatDuration(usage) {
	const seconds = (usage ?? []).reduce((total, entry) => total + (entry.duration ?? 0), 0);
	if (seconds <= 0) return null;
	const rounded = Math.round(seconds);
	return rounded < 60 ? `${rounded} s` : `${Math.floor(rounded / 60)} min ${rounded % 60} s`;
}

function verdict(report, planned) {
	if (!report.valid) {
		return [
			'Incomplete: the review could not be completed or its result could not be trusted, so it ' +
				'is not evidence that the change is safe.',
			'',
			...(report.errors ?? []).map(error => `- ${sanitize(error)}`),
		];
	}
	switch (report.outcome) {
		case 'incomplete':
			return [
				'Incomplete: the review could not cover everything it needed, so it is not evidence ' +
					'that the change is safe. What it did find is published.',
			];
		case 'blocked':
			return [`Not ready to merge: ${count(planned.blocking.length, 'blocking finding')}.`];
		case 'concerns':
			return [
				'No blocking findings. Each `SHOULD FIX` conversation holds the merge until it is ' +
					'resolved by a code change or an issue.',
			];
		case 'suggestions':
			return [
				'No blocking findings, only suggestions. Their conversations hold the merge until they ' +
					'are resolved, with or without a change.',
			];
		default:
			return ['Nothing to change was found in this pull request.'];
	}
}

function renderSummary(report, planned) {
	const result = report.valid ? report.result : null;
	const full = ({ finding, items }) =>
		`- ${compact(finding)}. ${reasoning(finding, items).join(' ')}`;
	const blocking = entry => {
		if (entry.conversation === null) return full(entry);
		const closed =
			entry.conversation === 'closed'
				? ' Its conversation was closed, but the review still finds it.'
				: '';
		return `- ${compact(entry.finding)}${closed}`;
	};

	return [
		summaryMarker,
		`## AI review: ${report.outcome}`,
		'',
		...verdict(report, planned),
		...section('Blocking', planned.blocking.map(blocking)),
		...section('Not on a line of the diff', planned.withoutLine.map(full)),
		...section(
			'Found outside this change',
			planned.incidental.map(finding => `- ${compact(finding)}. ${sanitize(finding.problem)}`),
		),
		// A review without a valid result still shows what earlier reviews found outside a
		// conversation, as they last described it, instead of hiding it until a review completes.
		...section(
			'Found by earlier reviews, not rechecked',
			report.valid
				? []
				: planned.ledger.map(finding => `- ${compact(finding)}. ${sanitize(finding.problem)}`),
		),
		...section('Earlier findings', [
			...planned.fixed.map(
				({ finding, recheck }) => `- Looks fixed: ${compact(finding)}. ${sanitize(recheck.reason)}`,
			),
			...planned.undetermined.map(
				({ finding, recheck }) =>
					`- Could not recheck: ${compact(finding)}. ${sanitize(recheck.reason)}`,
			),
		]),
		...section(
			'Questions for the author',
			(result?.questions ?? []).map(
				question =>
					`- ${sanitize(question.question)}` +
					(question.prevents_completion ? ' This question kept the review from completing.' : ''),
			),
		),
		...section(
			'Limitations',
			(result?.limitations ?? []).map(
				limitation => `- ${sanitize(limitation.reason)} Needed: ${sanitize(limitation.needed)}`,
			),
		),
		...section('Follow-up', [
			...planned.followUp.uncarried.map(
				({ about, text }) => `- For ${about.map(compact).join(' and ')}: ${sanitize(text)}`,
			),
			...planned.followUp.general.map(item => `- ${sanitize(item)}`),
		]),
		...section(
			'Context not supplied to the reviewer',
			(report.omissions ?? []).map(omission => `- ${sanitize(omission)}`),
		),
		'',
		'---',
		[`Commit ${commit}`, count(report.attempts ?? 0, 'provider turn'), formatDuration(report.usage)]
			.filter(Boolean)
			.join(' · '),
		marker('ledger', planned.ledger),
	].join('\n');
}

/** What only the people running the pilot need: coverage, rechecks, and rejected replies. */
function renderOperatorNotes(report) {
	const reasons = key => (Array.isArray(report[key]) ? report[key] : []);
	const result = report.valid ? report.result : null;

	return [
		...section(
			'Perspectives',
			result
				? perspectiveKeys.map(
						key =>
							`- **${key}** — ${result.perspectives[key].coverage} ` +
							`(${result.perspectives[key].depth}): ${sanitize(result.perspectives[key].reason)}`,
					)
				: [],
		),
		...section(
			'Rechecks',
			(result?.rechecks ?? []).map(
				recheck => `- \`${sanitize(recheck.key)}\` ${recheck.status}: ${sanitize(recheck.reason)}`,
			),
		),
		...section(
			'Reasons the first reply was rejected',
			reasons('repairReasons').map(reason => `- ${sanitize(reason)}`),
		),
		...section(
			'Reasons the repair was rejected',
			reasons('failedRepairReasons').map(reason => `- ${sanitize(reason)}`),
		),
	].join('\n');
}

const incomplete = (report, errors) => ({
	...report,
	valid: false,
	result: null,
	outcome: 'incomplete',
	errors,
});

// The analysis job may have failed before it produced anything, so an absent or unparseable
// report is a normal path here, not a crash. A step that stops the analysis for a known reason
// reports it, and that reason says more than the job's conclusion.
let report;
try {
	report = JSON.parse(process.env.REPORT ?? '');
} catch {
	report = incomplete({}, [`The analysis job ended as "${analyzeResult}" and produced no result.`]);
}

if (analyzeResult !== 'success') {
	const explained = report.valid === false && report.errors?.length > 0;
	report = incomplete(
		report,
		explained ? report.errors : [`The analysis job ended as "${analyzeResult}".`],
	);
}

// The publisher never inherits the analysis job's verdict: it revalidates the result it is about
// to act on, against the earlier findings the reviewer was asked to recheck, so a report claiming
// "clean" without a result that earns it cannot pass.
const earlierFindings = Array.isArray(report.earlier) ? report.earlier : [];
if (report.valid) {
	const revalidated = validateResult(report.result, {
		repository,
		base: baseSha,
		head: headSha,
		earlier: earlierFindings,
	});
	// The gate follows the outcome revalidation derived, never the report's own outcome field.
	report = revalidated.valid
		? { ...report, outcome: revalidated.outcome }
		: incomplete(
				report,
				revalidated.errors.map(error => `On revalidation: ${error}`),
			);
}

const state = await readReviewState(github, { repository, pullNumber });

// An invalid report says nothing about earlier findings, so the summary keeps carrying the ones
// the previous summary listed instead of dropping them.
let planned = emptyPlan(state.summary?.ledger ?? []);
if (report.valid) {
	const lines =
		report.result.findings.length > 0
			? addressableLines(await github.request(pullPath, { accept: 'application/vnd.github.diff' }))
			: new Map();
	planned = plan(report.result, earlierFindings, state, lines);
}

// Conversations first and the summary last: a run cancelled in between leaves every finding
// either in a conversation or in the previous summary's ledger, so the next review still
// rechecks it.
if (planned.comments.length > 0) {
	await github.request(`${pullPath}/reviews`, {
		method: 'POST',
		body: {
			commit_id: headSha,
			event: 'COMMENT',
			body: `AI review of ${commit}: ${count(planned.comments.length, 'new comment')}. The summary comment has the rest.`,
			comments: planned.comments,
		},
	});
}
// A conversation is reopened before the reply that records why, so a run that stops in between
// leaves it holding the merge rather than looking already escalated to the next review.
for (const thread of planned.reopen) {
	await github.graphql(
		'mutation ($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }',
		{ id: thread.id },
	);
}

// One at a time, so a failure leaves the replies before it posted and a re-run skips them.
for (const reply of planned.replies) {
	await github.request(`${pullPath}/comments/${reply.thread.commentId}/replies`, {
		method: 'POST',
		body: { body: reply.body },
	});
}
console.log(
	`Posted ${count(planned.comments.length, 'new comment')} and ` +
		`${count(planned.replies.length, 'reply', 'replies')} for ${headSha}.`,
);

const body = renderSummary(report, planned);

if (state.summary === null) {
	const created = await github.request(`/repos/${repository}/issues/${pullNumber}/comments`, {
		method: 'POST',
		body: { body },
	});
	console.log(`Created the summary comment: ${created.html_url}`);
} else if (state.summary.body === body) {
	console.log(`The summary comment already shows this report: ${state.summary.url}`);
} else {
	await github.request(`/repos/${repository}/issues/comments/${state.summary.id}`, {
		method: 'PATCH',
		body: { body },
	});
	console.log(`Updated the summary comment: ${state.summary.url}`);
}

appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n${renderOperatorNotes(report)}\n`);

// The workflow turns the outcome into the AI Review / required status. The job also fails for an
// outcome that holds the merge, so the run itself shows it.
console.log(`Outcome: ${report.outcome}.`);
if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${report.outcome}\npublished=true\n`);
}
process.exit(report.outcome === 'blocked' || report.outcome === 'incomplete' ? 1 : 0);
