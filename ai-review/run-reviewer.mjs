/**
 * Runs one review turn through `harness-cli` and returns a validated result.
 *
 * `single-turn` writes its own JSON envelope to stdout and everything else to stderr, and
 * the reviewer's contract result travels inside that envelope's `response` field as text.
 * Nothing enforces the schema on the provider side, so the text is parsed defensively,
 * validated against the contract, and repaired at most once. Every other failure path —
 * a non-zero exit, an empty answer, an unusable envelope, a result that fails validation
 * twice, or the deadline — produces `incomplete`, never a clean review.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateResult } from './contract.mjs';

const environment = key => {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is required`);
	return value;
};

const repository = environment('REPOSITORY');
const baseSha = environment('BASE_SHA');
const headSha = environment('HEAD_SHA');
const workDirectory = environment('OUTPUT_DIR');
const evidenceDirectory = environment('EVIDENCE_DIR');

const harnessPackage = process.env.HARNESS_PACKAGE ?? '@mikode13/harness-cli@1.1.0';
const reviewerCommand = process.env.REVIEWER_COMMAND ?? 'npx';
const model = process.env.REVIEW_MODEL ?? 'opus';
const effort = process.env.REVIEW_EFFORT ?? 'high';
const timeoutMs = Number(process.env.REVIEW_TIMEOUT_SECONDS ?? 600) * 1000;

// The result has to recheck exactly the earlier findings the prompt supplied, and the publisher
// revalidates it against the same list, so the list travels in the report.
const earlierPath = join(evidenceDirectory, 'earlier-findings.json');
const earlier = existsSync(earlierPath) ? JSON.parse(readFileSync(earlierPath, 'utf8')) : [];
const expected = { repository, base: baseSha, head: headSha, earlier };
const usage = [];
const bytes = text => Buffer.byteLength(text, 'utf8');

/** Keeps a logged message on one line, so text the reviewer wrote cannot start a workflow command. */
const oneLine = text => String(text).replace(/\s+/gu, ' ').trim();

/**
 * Runs the reviewer once. The prompt travels as a file that `harness-cli` reads itself: the
 * command line bounds none of its size, none of its content becomes an argument, and the
 * command is spawned without a shell.
 */
function runTurn(promptPath) {
	return new Promise(resolve => {
		const args =
			reviewerCommand === 'npx'
				? ['--yes', harnessPackage, 'single-turn', '--agent', 'claude']
				: ['single-turn', '--agent', 'claude'];
		const child = spawn(
			reviewerCommand,
			[...args, '--model', model, '--reasoning-effort', effort, '--prompt-file', promptPath],
			// The agent starts in the work directory, never in the workspace that holds the pull
			// request checkout, so no configuration from the head can apply to it.
			{ cwd: workDirectory, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
		);

		let stdout = '';
		let stderr = '';
		let timedOut = false;

		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => (stdout += chunk));
		child.stderr.on('data', chunk => (stderr += chunk));

		// SIGTERM is the documented way to cancel a single-turn run; the kill that follows only
		// covers a process that ignores it, so the job cannot outlive its own deadline.
		const deadline = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
		}, timeoutMs);

		const finish = (code, error) => {
			clearTimeout(deadline);
			resolve({ code, error, stdout, stderr, timedOut });
		};

		child.on('error', error => finish(null, error.message));
		child.on('close', code => finish(code, null));
	});
}

/** Extracts the contract object from a reply that may carry a code fence or stray prose. */
function extractObject(text) {
	const trimmed = text.trim();
	const candidates = [trimmed];

	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
	if (fenced) candidates.push(fenced[1].trim());

	const first = trimmed.indexOf('{');
	const last = trimmed.lastIndexOf('}');
	if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

	let failure = 'The reply contained no JSON object.';
	for (const candidate of candidates) {
		try {
			return { value: JSON.parse(candidate), error: null };
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
	}
	return { value: null, error: failure };
}

/**
 * Reports what the reviewer said on stderr when a turn failed. The prompt is never echoed, and
 * the tail is bounded, so a failing run stays diagnosable without turning the log into a copy
 * of the reviewed pull request.
 */
function reportProgress(turn) {
	const tail = turn.stderr.trimEnd().split('\n').slice(-20).join('\n');
	if (tail === '') return;
	// The tail is text the reviewer wrote, so workflow commands are switched off while it is
	// printed: a line of it that starts with "::" stays a log line.
	const resume = randomUUID();
	console.log(`::stop-commands::${resume}`);
	console.log(`Reviewer progress (last lines):\n${tail}`);
	console.log(`::${resume}::`);
}

/** Turns one completed turn into either a validated result or the reasons it was rejected. */
function interpret(turn) {
	if (turn.timedOut) {
		reportProgress(turn);
		return { errors: ['The reviewer did not finish within its deadline.'] };
	}
	if (turn.error) return { errors: [`The reviewer could not be started: ${turn.error}`] };
	if (turn.code !== 0) {
		reportProgress(turn);
		return { errors: [`The reviewer exited with code ${turn.code}.`] };
	}

	const envelope = extractObject(turn.stdout);
	if (envelope.value === null || typeof envelope.value.response !== 'string') {
		return { errors: ['The reviewer did not produce a usable single-turn envelope.'] };
	}

	usage.push({
		inputTokens: envelope.value.inputTokens ?? null,
		outputTokens: envelope.value.outputTokens ?? null,
		duration: envelope.value.duration ?? null,
	});

	const body = extractObject(envelope.value.response);
	if (body.value === null) {
		return {
			errors: [`The reviewer did not return JSON: ${body.error}`],
			reply: envelope.value.response,
		};
	}

	const validation = validateResult(body.value, expected);
	return validation.valid
		? { result: validation.result }
		: { errors: validation.errors, reply: envelope.value.response };
}

const repairPrompt = (
	reply,
	errors,
) => `Your previous reply was rejected because it did not satisfy the version 2
mikode-review result contract. Return the same review as a valid result object.

Do not review anything again, do not change a severity, an origin, a relevance, a blocking
status, a recheck status, or an outcome to make validation pass, and do not invent findings or evidence you did not already
have. Correct only the structure, and keep "scope" exactly
{"repository": "${repository}", "base": "${baseSha}", "head": "${headSha}", "paths": [...]}.
If the review underlying the previous reply cannot be expressed as a valid result, return a
valid result whose outcome is "incomplete" with a limitation that says so.

Reply with the JSON object only: the first character must be "{" and the last must be "}".

Rejected reply:
${reply}

Reasons it was rejected:
${errors.map(error => `- ${error}`).join('\n')}`;

const promptPath = join(workDirectory, 'prompt.txt');
const buildReport = JSON.parse(readFileSync(join(workDirectory, 'build-report.json'), 'utf8'));

let outcome = 'incomplete';
let result = null;
let errors = [];
let attempts = 0;
let repairReasons = [];
let failedRepairReasons = [];

const bounded = reasons => reasons.slice(0, 20).map(reason => oneLine(reason).slice(0, 300));

if (!buildReport.fits) {
	const missing = buildReport.missingEssentials ?? [];
	errors = [
		missing.length > 0
			? `Essential context could not be supplied: ${missing.join('; ')}. ` +
				'A review without it is not worth the provider call.'
			: `The diff and the mandatory context alone need ${buildReport.bytes} bytes, which ` +
				`exceeds the ${buildReport.limit}-byte review budget.`,
	];
} else if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
	errors = [
		'The provider credential is unavailable. Check the CLAUDE_CODE_OAUTH_TOKEN secret in the ai-review environment of the calling repository.',
	];
} else {
	attempts = 1;
	let attempt = interpret(await runTurn(promptPath));

	// One bounded repair, and only for a reply that already exists: a malformed envelope is a
	// failed run, and re-asking for it would spend the provider again on the same failure. The
	// repair carries the reply and the reasons, not the evidence, so it needs no budget of its own.
	const repairable =
		!attempt.result && typeof attempt.reply === 'string' && attempt.reply.trim() !== '';

	if (repairable) {
		attempts = 2;
		// Kept even when the repair succeeds: they show which part of the contract a first reply
		// gets wrong, which is what tuning the contract needs.
		repairReasons = bounded(attempt.errors);
		console.log('The first reply failed validation; attempting one repair.');
		for (const reason of repairReasons) console.log(`Rejected before repair: ${reason}`);
		const repairPath = join(workDirectory, 'repair-prompt.txt');
		writeFileSync(repairPath, repairPrompt(attempt.reply, attempt.errors));
		const repaired = interpret(await runTurn(repairPath));
		if (repaired.result) {
			attempt = repaired;
		} else {
			failedRepairReasons = bounded(repaired.errors);
			for (const reason of failedRepairReasons) console.log(`Rejected after repair: ${reason}`);
			// The contract's validation messages help tune the contract, not the author, so the pull
			// request gets one plain reason; a failure to run the repair at all is still named.
			attempt = {
				errors: [
					"The reviewer's reply did not satisfy the result contract, and one repair did not " +
						'produce a valid result.',
					...(typeof repaired.reply === 'string' ? [] : repaired.errors),
				],
			};
		}
	}

	if (attempt.result) {
		result = attempt.result;
		outcome = result.outcome;
	} else {
		errors = attempt.errors;
	}
}

const report = {
	repository,
	base: baseSha,
	head: headSha,
	valid: result !== null,
	outcome,
	errors,
	omissions: buildReport.omissions,
	attempts,
	repairReasons,
	failedRepairReasons,
	usage,
	earlier,
	result,
};

const serialized = JSON.stringify(report);
writeFileSync(join(workDirectory, 'review-report.json'), JSON.stringify(report, null, 2));

// A job output is capped near 1 MB, so an oversized report is replaced by the fact that it was
// oversized rather than truncated into something the publisher would fail to parse. Every other
// field is kept from the report itself, so a field added to one shape reaches the other.
const deliverable =
	bytes(serialized) > 900_000
		? JSON.stringify({
				...report,
				valid: false,
				outcome: 'incomplete',
				errors: ['The review result was too large to hand to the publication job.'],
				result: null,
			})
		: serialized;

const delimiter = `report-${randomUUID()}`;
appendFileSync(process.env.GITHUB_OUTPUT, `report<<${delimiter}\n${deliverable}\n${delimiter}\n`);

console.log(
	`Outcome: ${outcome} after ${attempts === 1 ? '1 attempt' : `${String(attempts)} attempts`}.`,
);
for (const entry of usage) {
	console.log(`Usage: ${entry.inputTokens} in, ${entry.outputTokens} out, ${entry.duration}s.`);
}
for (const error of errors) console.log(`Rejected: ${oneLine(error)}`);
