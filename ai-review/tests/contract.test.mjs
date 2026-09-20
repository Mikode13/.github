import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveOutcome, perspectiveKeys, shapeExamples, validateResult } from '../contract.mjs';

const repository = 'Mikode13/slop-lab';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);

const finding = (id, overrides = {}) => ({
	id,
	severity: 'SHOULD FIX',
	origin: 'introduced',
	relevance: 'change',
	blocking: false,
	title: `Finding ${id}`,
	problem: 'A problem.',
	consequence: 'A consequence.',
	recommended_direction: 'A direction.',
	location: { path: 'src/changed.js', revision: head, line: 2, symbol: null },
	evidence: [
		{ source: { ref: 'src/changed.js', revision: head }, kind: 'inspected', observation: 'Seen.' },
	],
	...overrides,
});

function resultWith(findings, fields = {}) {
	return {
		version: 2,
		scope: { repository, base, head, paths: ['src/changed.js'] },
		outcome: 'clean',
		perspectives: Object.fromEntries(
			perspectiveKeys.map(key => [
				key,
				{
					depth: 'baseline',
					coverage: 'complete',
					reason: 'Reviewed.',
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
			reason: 'Confirmed.',
			checked_sources: [],
		})),
		rechecks: [],
		limitations: [],
		questions: [],
		context: [],
		follow_up: [],
		...fields,
	};
}

/** Validates `result` with its derived outcome, against `earlier` findings. */
function errorsOf(result, earlier = []) {
	const withOutcome = { ...result, outcome: deriveOutcome(result) };
	return validateResult(withOutcome, { repository, base, head, earlier }).errors;
}

const preExisting = { origin: 'pre_existing', relevance: 'incidental' };

test('only a BLOCKER blocks, whatever its origin, and incidental findings below it leave the review clean', () => {
	const outcome = findings => deriveOutcome(resultWith(findings));

	assert.equal(
		outcome([finding('F1', { severity: 'BLOCKER', blocking: true, ...preExisting })]),
		'blocked',
	);
	assert.equal(outcome([finding('F1')]), 'concerns');
	assert.equal(outcome([finding('F1', { severity: 'SUGGESTION' })]), 'suggestions');
	assert.equal(outcome([finding('F1', preExisting)]), 'clean');
	assert.equal(outcome([finding('F1', { origin: 'unknown' })]), 'concerns');
	assert.equal(outcome([finding('F1', { origin: 'pre_existing' })]), 'concerns');
});

test('blocking and relevance must agree with severity and origin', () => {
	assert.deepEqual(errorsOf(resultWith([finding('F1')])), []);
	assert.match(
		errorsOf(resultWith([finding('F1', { blocking: true })])).join(' '),
		/is blocking when it is not a BLOCKER/u,
	);
	assert.match(
		errorsOf(resultWith([finding('F1', { relevance: 'incidental' })])).join(' '),
		/is not pre-existing, so its relevance must be change/u,
	);
	assert.match(
		errorsOf(resultWith([finding('F1', { severity: 'SUGGESTION', origin: 'pre_existing' })])).join(
			' ',
		),
		/is a pre-existing suggestion, so its relevance must be incidental/u,
	);
});

const earlier = [
	{
		key: 'e1',
		severity: 'SHOULD FIX',
		title: 'Earlier',
		problem: 'Earlier problem.',
		location: finding('F0').location,
	},
	{
		key: 'e2',
		severity: 'BLOCKER',
		title: 'Earlier blocker',
		problem: 'Earlier problem.',
		location: finding('F0').location,
	},
];

const recheck = (key, status, findingId = null) => ({
	key,
	status,
	finding_id: findingId,
	reason: 'Rechecked.',
});

test('every earlier finding is rechecked exactly once, and a present one points at a finding', () => {
	const valid = resultWith([finding('F1')], {
		rechecks: [recheck('e1', 'present', 'F1'), recheck('e2', 'fixed')],
	});
	assert.deepEqual(errorsOf(valid, earlier), []);

	const errors = rechecks => errorsOf(resultWith([finding('F1')], { rechecks }), earlier).join(' ');
	assert.match(errors([recheck('e1', 'fixed')]), /The earlier finding e2 was not rechecked\./u);
	assert.match(
		errors([recheck('e1', 'fixed'), recheck('e2', 'fixed'), recheck('e3', 'fixed')]),
		/names an earlier finding that was not supplied/u,
	);
	assert.match(
		errors([recheck('e1', 'fixed'), recheck('e1', 'fixed'), recheck('e2', 'fixed')]),
		/repeats the earlier finding e1/u,
	);
	assert.match(
		errors([recheck('e1', 'present', 'F9'), recheck('e2', 'fixed')]),
		/points at an unknown finding/u,
	);
	assert.match(
		errors([recheck('e1', 'fixed', 'F1'), recheck('e2', 'fixed')]),
		/must not point at a finding/u,
	);
});

test('an earlier BLOCKER or unclassified finding that cannot be rechecked needs a limitation', () => {
	const rechecks = [recheck('e1', 'undetermined'), recheck('e2', 'undetermined')];
	assert.match(
		errorsOf(resultWith([], { rechecks }), earlier).join(' '),
		/leaves an earlier BLOCKER finding undetermined without a limitation/u,
	);
	assert.deepEqual(
		errorsOf(
			resultWith([], { rechecks: [recheck('e1', 'undetermined'), recheck('e2', 'fixed')] }),
			earlier,
		),
		[],
	);

	const unclassified = [{ ...earlier[0], severity: null }, earlier[1]];
	assert.match(
		errorsOf(
			resultWith([], { rechecks: [recheck('e1', 'undetermined'), recheck('e2', 'fixed')] }),
			unclassified,
		).join(' '),
		/leaves an earlier unclassified finding undetermined without a limitation/u,
	);

	const limited = resultWith([], {
		rechecks,
		perspectives: Object.fromEntries(
			perspectiveKeys.map(key => [
				key,
				{
					depth: 'baseline',
					coverage: 'incomplete',
					reason: 'Limited.',
					skills: [],
					finding_ids: [],
				},
			]),
		),
		limitations: [
			{
				reason: 'The file was not supplied.',
				needed: 'The file.',
				perspectives: [...perspectiveKeys],
			},
		],
	});
	assert.deepEqual(errorsOf(limited, earlier), []);
	assert.equal(deriveOutcome(limited), 'incomplete');
});

test('a field mismatch names the fields, so a repair knows what to change', () => {
	const withoutFindingId = recheck('e1', 'fixed');
	delete withoutFindingId.finding_id;
	const rechecks = [
		{ ...withoutFindingId, severity: 'SHOULD FIX', '::warning::x': true },
		recheck('e2', 'fixed'),
	];
	const errors = errorsOf(resultWith([finding('F1')], { rechecks }), earlier);

	assert.deepEqual(errors, [
		'Recheck 1 is missing `finding_id` and has unexpected `severity`, an unreadable name.',
	]);

	const withoutEvidence = finding('F1');
	delete withoutEvidence.evidence;
	assert.ok(
		errorsOf(resultWith([{ ...withoutEvidence, notes: 'x' }])).includes(
			'Finding 1 is missing `evidence` and has unexpected `notes`.',
		),
	);
});

test('a result that has too few fields hears about every one it lacks', () => {
	const errors = errorsOf(resultWith([{ id: 'F1' }])).join(' ');
	assert.match(
		errors,
		/Finding 1 is missing `severity`, `origin`, `relevance`, `blocking`, `title`, `problem`, `consequence`, `recommended_direction`, `location`, `evidence`\./u,
	);
});

test('the shape examples shown to the reviewer form a valid result', () => {
	const { perspective, finding, verification, recheck, limitation, question } = shapeExamples;
	const limited = limitation.perspectives[0];
	const result = resultWith([finding], {
		perspectives: Object.fromEntries(
			perspectiveKeys.map(key => [
				key,
				key === limited ? { ...perspective, coverage: 'incomplete' } : perspective,
			]),
		),
		verification: [verification],
		rechecks: [recheck],
		limitations: [limitation],
		questions: [question],
		context: finding.evidence,
		follow_up: ['F1: A follow-up item.'],
	});

	assert.deepEqual(errorsOf(result, [{ key: recheck.key, severity: 'SHOULD FIX' }]), []);
});
