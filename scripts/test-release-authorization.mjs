import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWorkflowStepScript } from './lib/extractWorkflowStepScript.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowText = readFileSync(
	path.join(repositoryRoot, '.github/workflows/release.yml'),
	'utf8',
);
const script = extractWorkflowStepScript(
	workflowText,
	'authorize',
	'Verify the commit has a successful CI / required check on main',
);

const scratchRoot = mkdtempSync(path.join(tmpdir(), 'release-authorization-'));
const scriptPath = path.join(scratchRoot, 'authorize.cjs');
writeFileSync(scriptPath, script);

const fakeGhSource = readFileSync(path.join(repositoryRoot, 'scripts/lib/fakeGh.cjs'), 'utf8');
const fakeGhDirectory = path.join(scratchRoot, 'bin');
mkdirSync(fakeGhDirectory);
const fakeGhPath = path.join(fakeGhDirectory, 'gh');
writeFileSync(fakeGhPath, fakeGhSource);
chmodSync(fakeGhPath, 0o755);

const SHA = 'a'.repeat(40);
const REPOSITORY = 'Mikode13/example';

let scenarioCount = 0;

function runAuthorization(responses) {
	scenarioCount += 1;
	const scenarioDirectory = path.join(scratchRoot, `scenario-${scenarioCount}`);
	mkdirSync(scenarioDirectory);
	const githubOutputPath = path.join(scenarioDirectory, 'output.txt');
	const callIndexPath = path.join(scenarioDirectory, 'call-index.txt');
	const logPath = path.join(scenarioDirectory, 'calls.log');
	writeFileSync(githubOutputPath, '');
	writeFileSync(logPath, '');

	const result = spawnSync(process.execPath, [scriptPath], {
		encoding: 'utf8',
		env: {
			PATH: `${fakeGhDirectory}:${process.env.PATH}`,
			SHA,
			REPOSITORY,
			GH_TOKEN: 'fake-token',
			GITHUB_OUTPUT: githubOutputPath,
			FAKE_GH_RESPONSES: JSON.stringify(responses),
			FAKE_GH_CALL_INDEX_FILE: callIndexPath,
			FAKE_GH_LOG: logPath,
		},
	});

	return {
		status: result.status,
		stderr: result.stderr,
		output: readFileSync(githubOutputPath, 'utf8'),
		calls: readFileSync(logPath, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map(line => JSON.parse(line)),
	};
}

function runResponse(overrides = {}) {
	return {
		name: 'CI',
		conclusion: 'success',
		head_sha: SHA,
		check_suite_id: 999,
		...overrides,
	};
}

function checkRunResponse(overrides = {}) {
	return {
		name: 'CI / required',
		conclusion: 'success',
		check_suite: { id: 999 },
		...overrides,
	};
}

// 1. Correct authorization succeeds.
{
	const { status, output, calls } = runAuthorization([
		{ body: { workflow_runs: [runResponse()] } },
		{ body: { check_runs: [checkRunResponse()] } },
	]);

	assert.equal(status, 0, 'expected authorization to succeed');
	assert.match(output, /^should-release=true$/m, 'expected should-release=true in GITHUB_OUTPUT');
	assert.equal(calls.length, 2, 'expected exactly two gh api calls');
}

// 2. A run exists but for a different commit SHA is not a match.
{
	const { status, output } = runAuthorization([
		{ body: { workflow_runs: [runResponse({ head_sha: 'b'.repeat(40) })] } },
		{ body: { check_runs: [] } },
	]);

	assert.notEqual(status, 0, 'expected authorization to fail for a mismatched SHA');
	assert.doesNotMatch(output, /should-release=true/, 'must not authorize on a SHA mismatch');
}

// 3. No run matches the branch/event filters (the API itself would omit it server-side;
//    this simulates that by returning an empty list, since the script cannot distinguish
//    "wrong branch" from "wrong event" once GitHub has already filtered the response).
{
	const { status, output } = runAuthorization([{ body: { workflow_runs: [] } }]);

	assert.notEqual(status, 0, 'expected authorization to fail when no run matches branch/event');
	assert.doesNotMatch(output, /should-release=true/);
}

// 4. The CI run exists for the right SHA but did not succeed.
{
	const { status, output } = runAuthorization([
		{ body: { workflow_runs: [runResponse({ conclusion: 'failure' })] } },
	]);

	assert.notEqual(status, 0, 'expected authorization to fail for a failed CI run');
	assert.doesNotMatch(output, /should-release=true/);
}

// 5. CI succeeded, but the CI / required check itself is missing.
{
	const { status, output } = runAuthorization([
		{ body: { workflow_runs: [runResponse()] } },
		{ body: { check_runs: [] } },
	]);

	assert.notEqual(status, 0, 'expected authorization to fail when CI / required is missing');
	assert.doesNotMatch(output, /should-release=true/);
}

// 5b. CI succeeded, but the CI / required check itself failed.
{
	const { status, output } = runAuthorization([
		{ body: { workflow_runs: [runResponse()] } },
		{ body: { check_runs: [checkRunResponse({ conclusion: 'failure' })] } },
	]);

	assert.notEqual(status, 0, 'expected authorization to fail when CI / required failed');
	assert.doesNotMatch(output, /should-release=true/);
}

// 5c. CI succeeded, but the matching check-run belongs to a different check suite
//     (defends against a stale/unrelated check-run of the same name on the same commit).
{
	const { status, output } = runAuthorization([
		{ body: { workflow_runs: [runResponse()] } },
		{ body: { check_runs: [checkRunResponse({ check_suite: { id: 1 } })] } },
	]);

	assert.notEqual(status, 0, 'expected authorization to fail on a check-suite mismatch');
	assert.doesNotMatch(output, /should-release=true/);
}

// 6. Every API call must use an explicit GET method (gh api defaults to POST once -f
//    parameters are present, which would break these read-only calls entirely).
{
	const { calls } = runAuthorization([
		{ body: { workflow_runs: [runResponse()] } },
		{ body: { check_runs: [checkRunResponse()] } },
	]);

	for (const call of calls) {
		assert.ok(call.includes('--method'), `expected --method in call: ${JSON.stringify(call)}`);
		const methodIndex = call.indexOf('--method');
		assert.equal(
			call[methodIndex + 1],
			'GET',
			`expected GET method in call: ${JSON.stringify(call)}`,
		);
	}
}

process.stdout.write('Release authorization behaves correctly for every tested scenario.\n');
