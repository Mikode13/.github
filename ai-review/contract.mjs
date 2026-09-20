/**
 * Version 2 of the `mikode-review` result contract, as published at the pinned skills
 * revision recorded in the workflow.
 *
 * The reviewer is asked to validate its own output, and a self-check is not proof of
 * behaviour, so the pilot re-derives every semantic rule here. Both the analysis job and
 * the publication job use this module, which keeps a result that reaches a pull request
 * from being trusted on a weaker check than the one that decided to accept it.
 */

export const perspectiveKeys = [
	'intent_scope',
	'correctness_regression',
	'design_architecture',
	'security_reliability',
	'evidence_delivery',
];

export const outcomes = ['clean', 'suggestions', 'concerns', 'blocked', 'incomplete'];

const resultKeys = [
	'context',
	'findings',
	'follow_up',
	'limitations',
	'outcome',
	'perspectives',
	'questions',
	'rechecks',
	'scope',
	'verification',
	'version',
];

export const severities = ['BLOCKER', 'SHOULD FIX', 'SUGGESTION'];
const origins = ['introduced', 'pre_existing', 'unknown'];
const relevances = ['change', 'incidental'];
const recheckStatuses = ['present', 'fixed', 'undetermined'];
const depths = ['baseline', 'deep'];
const coverages = ['complete', 'incomplete', 'not_applicable'];
const dispositions = ['confirmed', 'duplicate', 'rejected', 'unresolved'];
const evidenceKinds = ['inspected', 'reported', 'executed'];

/**
 * One example of every object the result contains, with exactly the fields this module accepts.
 * The reviewer is shown them because it repeatedly added or dropped fields when it had only the
 * contract's prose; a test keeps them valid against the checks below.
 */
export const shapeExamples = {
	perspective: {
		depth: 'baseline',
		coverage: 'complete',
		reason: 'What was reviewed for this perspective and how deeply.',
		skills: ['mikode-code-philosophy-review'],
		finding_ids: ['F1'],
	},
	finding: {
		id: 'F1',
		severity: 'SHOULD FIX',
		origin: 'introduced',
		relevance: 'change',
		blocking: false,
		title: 'What is wrong, as one sentence',
		problem: 'What the code does.',
		consequence: 'What that causes, and for whom.',
		recommended_direction: 'What to change, without writing the patch.',
		location: { path: 'src/example.ts', revision: null, line: 12, symbol: 'example' },
		evidence: [
			{
				source: { ref: 'src/example.ts', revision: null },
				kind: 'inspected',
				observation: 'What the source shows.',
			},
		],
	},
	verification: {
		candidate_id: 'C1',
		disposition: 'confirmed',
		finding_id: 'F1',
		reason: 'Why the candidate holds.',
		checked_sources: [{ ref: 'src/example.ts', revision: null }],
	},
	recheck: {
		key: 'the key of the earlier finding',
		status: 'present',
		finding_id: 'F1',
		reason: 'What still causes the defect.',
	},
	limitation: {
		reason: 'What could not be reviewed.',
		needed: 'What would let the review finish.',
		perspectives: ['security_reliability'],
	},
	question: {
		question: 'What the author should answer.',
		perspective: 'intent_scope',
		prevents_completion: false,
	},
};

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';
const isNullableString = value => value === null || isNonEmptyString(value);

/** A field name the reviewer wrote, quoted only when it cannot carry anything but a name. */
const fieldName = key =>
	/^[A-Za-z_][\w-]{0,39}$/u.test(key) ? `\`${key}\`` : 'an unreadable name';

// The names the reviewer adds are unbounded, so only the first few are listed.
const unexpectedList = keys =>
	keys.length > 5
		? `${keys.slice(0, 5).map(fieldName).join(', ')} and ${String(keys.length - 5)} more`
		: keys.map(fieldName).join(', ');

/**
 * Checks that `value` is an object with exactly `keys`. A mismatch names every missing field,
 * which the contract bounds, and the fields that are not in the contract, because a repair can
 * only correct a shape it is told about, and a rejected reply is not kept anywhere else.
 */
function checkFields(collect, value, keys, subject) {
	if (!isObject(value)) return collect.check(false, `${subject} is not an object.`);

	const present = Object.keys(value);
	const missing = keys.filter(key => !present.includes(key));
	const unexpected = present.filter(key => !keys.includes(key));
	const problems = [
		...(missing.length > 0 ? [`is missing ${missing.map(fieldName).join(', ')}`] : []),
		...(unexpected.length > 0 ? [`has unexpected ${unexpectedList(unexpected)}`] : []),
	];
	return collect.check(problems.length === 0, `${subject} ${problems.join(' and ')}.`);
}

/**
 * Derives the outcome the contract requires for this result. `incomplete` takes precedence
 * so that unfinished review work can never present itself as a decision, and an incidental
 * finding below `BLOCKER` never changes the outcome.
 */
export function deriveOutcome(result) {
	const incomplete =
		result.limitations.length > 0 ||
		perspectiveKeys.some(key => result.perspectives[key]?.coverage === 'incomplete') ||
		result.verification.some(item => item.disposition === 'unresolved') ||
		result.findings.some(finding => finding.severity === null);

	if (incomplete) return 'incomplete';
	if (result.findings.some(finding => finding.blocking === true)) return 'blocked';
	const change = result.findings.filter(finding => finding.relevance === 'change');
	if (change.some(finding => finding.severity === 'SHOULD FIX')) return 'concerns';
	if (change.some(finding => finding.severity === 'SUGGESTION')) return 'suggestions';
	return 'clean';
}

function createCollector() {
	const errors = [];
	return {
		errors,
		check(condition, message) {
			if (!condition) errors.push(message);
			return condition;
		},
	};
}

function checkSource(collect, value, where) {
	if (!checkFields(collect, value, ['ref', 'revision'], where)) return;
	collect.check(isNonEmptyString(value.ref), `${where} has no reference.`);
	collect.check(isNullableString(value.revision), `${where} has an invalid revision.`);
}

function checkEvidence(collect, value, where) {
	if (!checkFields(collect, value, ['source', 'kind', 'observation'], where)) return;
	checkSource(collect, value.source, `${where} source`);
	collect.check(evidenceKinds.includes(value.kind), `${where} has an invalid evidence kind.`);
	collect.check(isNonEmptyString(value.observation), `${where} has no observation.`);
}

function checkScope(collect, result, expected) {
	const fields = ['repository', 'base', 'head', 'paths'];
	if (!checkFields(collect, result.scope, fields, 'The result scope')) return;

	const { repository, base, head, paths } = result.scope;
	collect.check(repository === expected.repository, 'The result names a different repository.');
	collect.check(base === expected.base, 'The result names a different base commit.');
	collect.check(head === expected.head, 'The result names a different head commit.');
	collect.check(
		Array.isArray(paths) && paths.every(isNonEmptyString),
		'The result scope paths are invalid.',
	);
}

function checkPerspectives(collect, result, findingIds) {
	if (!checkFields(collect, result.perspectives, perspectiveKeys, 'The perspectives object')) {
		return;
	}

	for (const key of perspectiveKeys) {
		const perspective = result.perspectives[key];
		const fields = ['depth', 'coverage', 'reason', 'skills', 'finding_ids'];
		if (!checkFields(collect, perspective, fields, `Perspective ${key}`)) continue;

		collect.check(depths.includes(perspective.depth), `Perspective ${key} has an invalid depth.`);
		collect.check(
			coverages.includes(perspective.coverage),
			`Perspective ${key} has an invalid coverage.`,
		);
		collect.check(isNonEmptyString(perspective.reason), `Perspective ${key} has no reason.`);
		collect.check(
			Array.isArray(perspective.skills) && perspective.skills.every(isNonEmptyString),
			`Perspective ${key} lists invalid skills.`,
		);

		const references = perspective.finding_ids;
		if (!collect.check(Array.isArray(references), `Perspective ${key} has invalid finding IDs.`)) {
			continue;
		}
		for (const id of references) {
			collect.check(findingIds.has(id), `Perspective ${key} references the unknown finding ${id}.`);
		}
		collect.check(
			perspective.coverage !== 'not_applicable' || references.length === 0,
			`Perspective ${key} is not applicable but carries findings.`,
		);
	}
}

function checkFinding(collect, finding, index, seen) {
	const fields = [
		'id',
		'severity',
		'origin',
		'relevance',
		'blocking',
		'title',
		'problem',
		'consequence',
		'recommended_direction',
		'location',
		'evidence',
	];
	const where = `Finding ${index + 1}`;
	if (!checkFields(collect, finding, fields, where)) return;

	if (collect.check(isNonEmptyString(finding.id), `${where} has no ID.`)) {
		collect.check(!seen.has(finding.id), `Finding IDs must be unique; ${finding.id} repeats.`);
		seen.add(finding.id);
	}

	collect.check(
		finding.severity === null || severities.includes(finding.severity),
		`${where} has an invalid severity.`,
	);
	collect.check(origins.includes(finding.origin), `${where} has an invalid origin.`);

	collect.check(relevances.includes(finding.relevance), `${where} has an invalid relevance.`);
	collect.check(
		finding.blocking === (finding.severity === 'BLOCKER'),
		`${where} is blocking when it is not a BLOCKER, or not blocking when it is.`,
	);
	// Only a pre-existing defect can be incidental, and a pre-existing suggestion always is.
	collect.check(
		finding.origin === 'pre_existing' || finding.relevance === 'change',
		`${where} is not pre-existing, so its relevance must be change.`,
	);
	collect.check(
		finding.origin !== 'pre_existing' ||
			finding.severity !== 'SUGGESTION' ||
			finding.relevance === 'incidental',
		`${where} is a pre-existing suggestion, so its relevance must be incidental.`,
	);

	for (const field of ['title', 'problem', 'consequence', 'recommended_direction']) {
		collect.check(isNonEmptyString(finding[field]), `${where} has an empty ${field}.`);
	}

	const location = finding.location;
	if (checkFields(collect, location, ['path', 'revision', 'line', 'symbol'], `${where} location`)) {
		collect.check(isNonEmptyString(location.path), `${where} has no location path.`);
		collect.check(
			isNullableString(location.revision),
			`${where} has an invalid location revision.`,
		);
		collect.check(
			location.line === null || (Number.isInteger(location.line) && location.line >= 1),
			`${where} has an invalid location line.`,
		);
		collect.check(isNullableString(location.symbol), `${where} has an invalid location symbol.`);
	}

	const evidence = finding.evidence;
	if (collect.check(Array.isArray(evidence) && evidence.length > 0, `${where} has no evidence.`)) {
		evidence.forEach((item, position) =>
			checkEvidence(collect, item, `${where} evidence ${position + 1}`),
		);
	}
}

function checkVerification(collect, result, findingIds) {
	if (!collect.check(Array.isArray(result.verification), 'Verification must be an array.')) return;

	const candidates = new Set();
	const confirmed = new Set();

	result.verification.forEach((item, index) => {
		const fields = ['candidate_id', 'disposition', 'finding_id', 'reason', 'checked_sources'];
		const where = `Verification ${index + 1}`;
		if (!checkFields(collect, item, fields, where)) return;

		if (collect.check(isNonEmptyString(item.candidate_id), `${where} has no candidate ID.`)) {
			collect.check(!candidates.has(item.candidate_id), `${where} repeats a candidate ID.`);
			candidates.add(item.candidate_id);
		}

		collect.check(dispositions.includes(item.disposition), `${where} has an invalid disposition.`);
		collect.check(isNonEmptyString(item.reason), `${where} has no reason.`);

		if (item.disposition === 'confirmed' || item.disposition === 'duplicate') {
			const known = findingIds.has(item.finding_id);
			collect.check(known, `${where} points at an unknown finding.`);
			if (known && item.disposition === 'confirmed') confirmed.add(item.finding_id);
		} else {
			collect.check(item.finding_id === null, `${where} must not point at a finding.`);
		}

		if (collect.check(Array.isArray(item.checked_sources), `${where} has invalid sources.`)) {
			item.checked_sources.forEach((source, position) =>
				checkSource(collect, source, `${where} source ${position + 1}`),
			);
		}
	});

	for (const id of findingIds) {
		collect.check(confirmed.has(id), `Finding ${id} was never confirmed by a verified candidate.`);
	}
}

/**
 * Every earlier finding the caller supplied gets exactly one recheck. A present one points at
 * the finding that describes it now. An undetermined one whose severity is `BLOCKER` or was
 * never classified needs a limitation, because a review that cannot tell whether blocking harm
 * is gone has not finished.
 */
function checkRechecks(collect, result, findingIds, earlier) {
	if (!collect.check(Array.isArray(result.rechecks), 'Rechecks must be an array.')) return;

	const supplied = new Map(earlier.map(finding => [finding.key, finding]));
	const answered = new Set();

	result.rechecks.forEach((recheck, index) => {
		const where = `Recheck ${index + 1}`;
		const fields = ['key', 'status', 'finding_id', 'reason'];
		if (!checkFields(collect, recheck, fields, where)) {
			// The key alone still says which earlier finding this entry answers, so a malformed
			// entry is reported once, not again as an earlier finding nobody rechecked.
			if (isObject(recheck) && supplied.has(recheck.key)) answered.add(recheck.key);
			return;
		}

		if (
			collect.check(
				supplied.has(recheck.key),
				`${where} names an earlier finding that was not supplied.`,
			)
		) {
			collect.check(
				!answered.has(recheck.key),
				`${where} repeats the earlier finding ${recheck.key}.`,
			);
			answered.add(recheck.key);
		}
		collect.check(recheckStatuses.includes(recheck.status), `${where} has an invalid status.`);
		collect.check(isNonEmptyString(recheck.reason), `${where} has no reason.`);

		if (recheck.status === 'present') {
			collect.check(findingIds.has(recheck.finding_id), `${where} points at an unknown finding.`);
		} else {
			collect.check(recheck.finding_id === null, `${where} must not point at a finding.`);
		}

		const severity = supplied.get(recheck.key)?.severity;
		collect.check(
			recheck.status !== 'undetermined' ||
				(severity !== 'BLOCKER' && severity !== null) ||
				(Array.isArray(result.limitations) && result.limitations.length > 0),
			`${where} leaves an earlier ${severity ?? 'unclassified'} finding undetermined without a limitation.`,
		);
	});

	for (const key of supplied.keys()) {
		collect.check(answered.has(key), `The earlier finding ${key} was not rechecked.`);
	}
}

function checkQuestionsAndLimitations(collect, result) {
	const limited = new Set();

	if (collect.check(Array.isArray(result.limitations), 'Limitations must be an array.')) {
		result.limitations.forEach((limitation, index) => {
			const where = `Limitation ${index + 1}`;
			const fields = ['reason', 'needed', 'perspectives'];
			if (!checkFields(collect, limitation, fields, where)) return;

			collect.check(isNonEmptyString(limitation.reason), `${where} has no reason.`);
			collect.check(isNonEmptyString(limitation.needed), `${where} does not say what is needed.`);

			const affected = limitation.perspectives;
			const valid =
				Array.isArray(affected) &&
				affected.length > 0 &&
				affected.every(key => perspectiveKeys.includes(key));
			if (!collect.check(valid, `${where} names invalid perspectives.`)) return;

			for (const key of affected) {
				limited.add(key);
				collect.check(
					result.perspectives?.[key]?.coverage === 'incomplete',
					`${where} affects ${key}, which is not reported as incomplete.`,
				);
			}
		});
	}

	if (!collect.check(Array.isArray(result.questions), 'Questions must be an array.')) return;

	result.questions.forEach((question, index) => {
		const where = `Question ${index + 1}`;
		const fields = ['question', 'perspective', 'prevents_completion'];
		if (!checkFields(collect, question, fields, where)) return;

		collect.check(isNonEmptyString(question.question), `${where} is empty.`);
		collect.check(
			perspectiveKeys.includes(question.perspective),
			`${where} names an invalid perspective.`,
		);
		if (
			!collect.check(
				typeof question.prevents_completion === 'boolean',
				`${where} has an invalid completion flag.`,
			)
		) {
			return;
		}
		collect.check(
			!question.prevents_completion || limited.has(question.perspective),
			`${where} prevents completion without a matching limitation.`,
		);
	});
}

/**
 * Validates shape and semantics, and confirms that the reported outcome is the one the
 * contract derives. Anything this rejects is an incomplete execution, never a clean review.
 *
 * @param {unknown} value the parsed result returned by the reviewer.
 * @param {{ repository: string, base: string, head: string, earlier?: { key: string, severity: string | null }[] }} expected
 *   the reviewed change and the earlier findings supplied to the reviewer.
 * @returns {{ valid: boolean, errors: string[], outcome: string, result: unknown }}
 */
export function validateResult(value, expected) {
	const collect = createCollector();

	if (!checkFields(collect, value, resultKeys, 'The result')) {
		return { valid: false, errors: collect.errors, outcome: 'incomplete', result: null };
	}

	collect.check(value.version === 2, 'The result version must be 2.');
	collect.check(outcomes.includes(value.outcome), 'The reported outcome is invalid.');

	if (collect.check(isObject(value.scope), 'The result has no scope.')) {
		checkScope(collect, value, expected);
	}

	const findingIds = new Set();
	if (collect.check(Array.isArray(value.findings), 'Findings must be an array.')) {
		value.findings.forEach((finding, index) => checkFinding(collect, finding, index, findingIds));
	}

	if (collect.check(isObject(value.perspectives), 'The result has no perspectives.')) {
		checkPerspectives(collect, value, findingIds);
	}

	checkVerification(collect, value, findingIds);
	checkRechecks(collect, value, findingIds, expected.earlier ?? []);
	checkQuestionsAndLimitations(collect, value);

	if (collect.check(Array.isArray(value.context), 'Context must be an array.')) {
		value.context.forEach((item, index) => checkEvidence(collect, item, `Context ${index + 1}`));
	}
	collect.check(
		Array.isArray(value.follow_up) && value.follow_up.every(isNonEmptyString),
		'Follow-up work must be an array of non-empty strings.',
	);

	if (collect.errors.length === 0) {
		collect.check(
			value.outcome === deriveOutcome(value),
			'The reported outcome contradicts the findings, coverage, and limitations it reports.',
		);
	}

	const valid = collect.errors.length === 0;
	return {
		valid,
		errors: collect.errors,
		outcome: valid ? value.outcome : 'incomplete',
		result: valid ? value : null,
	};
}
