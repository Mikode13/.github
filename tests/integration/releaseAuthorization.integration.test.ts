import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
	extractWorkflowStepScript,
	readWorkflow,
	repositoryRoot,
} from '../support/fixtures/workflowStep.fixture.ts';

const SHA = 'a'.repeat(40);
const REPOSITORY = 'Mikode13/example';

interface ScriptedResponse {
	status?: number;
	body?: unknown;
}

interface AuthorizationResult {
	status: number | null;
	stderr: string;
	output: string;
	calls: string[][];
}

let scratchRoot: string;
let scriptPath: string;
let fakeGhDirectory: string;
let scenarioCount = 0;

beforeAll(() => {
	scratchRoot = mkdtempSync(path.join(tmpdir(), 'release-authorization-'));

	scriptPath = path.join(scratchRoot, 'authorize.cjs');
	writeFileSync(
		scriptPath,
		extractWorkflowStepScript(
			readWorkflow('release.yml'),
			'authorize',
			'Verify the commit has a successful CI / required check on main',
		),
	);

	// Copied to an extensionless `gh` on the child's PATH, which is why the fake is
	// CommonJS: an extensionless script has no sibling package.json declaring its type.
	fakeGhDirectory = path.join(scratchRoot, 'bin');
	mkdirSync(fakeGhDirectory);
	const fakeGhPath = path.join(fakeGhDirectory, 'gh');
	copyFileSync(path.join(repositoryRoot, 'tests/support/fakes/gh.fake.cjs'), fakeGhPath);
	chmodSync(fakeGhPath, 0o755);
});

function runAuthorization(responses: ScriptedResponse[]): AuthorizationResult {
	scenarioCount += 1;
	const scenarioDirectory = path.join(scratchRoot, `scenario-${String(scenarioCount)}`);
	mkdirSync(scenarioDirectory);

	const githubOutputPath = path.join(scenarioDirectory, 'output.txt');
	const callIndexPath = path.join(scenarioDirectory, 'call-index.txt');
	const logPath = path.join(scenarioDirectory, 'calls.log');
	writeFileSync(githubOutputPath, '');
	writeFileSync(logPath, '');

	const result = spawnSync(process.execPath, [scriptPath], {
		encoding: 'utf8',
		env: {
			PATH: `${fakeGhDirectory}:${process.env.PATH ?? ''}`,
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
			.map(line => JSON.parse(line) as string[]),
	};
}

function workflowRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'CI',
		conclusion: 'success',
		head_sha: SHA,
		check_suite_id: 999,
		...overrides,
	};
}

function checkRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: 'CI / required',
		conclusion: 'success',
		check_suite: { id: 999 },
		...overrides,
	};
}

const authorized: ScriptedResponse[] = [
	{ body: { workflow_runs: [workflowRun()] } },
	{ body: { check_runs: [checkRun()] } },
];

describe('release authorization', () => {
	it('authorizes a successful CI / required result for the commit', () => {
		const { status, output, calls } = runAuthorization(authorized);

		expect(status).toBe(0);
		expect(output).toMatch(/^should-release=true$/m);
		expect(calls).toHaveLength(2);
	});

	it('refuses a run that belongs to a different commit', () => {
		const { status, output } = runAuthorization([
			{ body: { workflow_runs: [workflowRun({ head_sha: 'b'.repeat(40) })] } },
			{ body: { check_runs: [] } },
		]);

		expect(status).not.toBe(0);
		expect(output).not.toMatch(/should-release=true/);
	});

	// The API filters by branch and event server-side, so the script cannot distinguish
	// "wrong branch" from "wrong event" once GitHub has already excluded the run.
	it('refuses when no run matches the branch and event filters', () => {
		const { status, output } = runAuthorization([{ body: { workflow_runs: [] } }]);

		expect(status).not.toBe(0);
		expect(output).not.toMatch(/should-release=true/);
	});

	it('refuses when the CI run for the commit did not succeed', () => {
		const { status, output } = runAuthorization([
			{ body: { workflow_runs: [workflowRun({ conclusion: 'failure' })] } },
		]);

		expect(status).not.toBe(0);
		expect(output).not.toMatch(/should-release=true/);
	});

	it('refuses when the CI / required check is absent', () => {
		const { status, output } = runAuthorization([
			{ body: { workflow_runs: [workflowRun()] } },
			{ body: { check_runs: [] } },
		]);

		expect(status).not.toBe(0);
		expect(output).not.toMatch(/should-release=true/);
	});

	it('refuses when the CI / required check failed', () => {
		const { status, output } = runAuthorization([
			{ body: { workflow_runs: [workflowRun()] } },
			{ body: { check_runs: [checkRun({ conclusion: 'failure' })] } },
		]);

		expect(status).not.toBe(0);
		expect(output).not.toMatch(/should-release=true/);
	});

	// Defends against a stale or unrelated check run of the same name on the same commit.
	it('refuses when the matching check run belongs to another check suite', () => {
		const { status, output } = runAuthorization([
			{ body: { workflow_runs: [workflowRun()] } },
			{ body: { check_runs: [checkRun({ check_suite: { id: 1 } })] } },
		]);

		expect(status).not.toBe(0);
		expect(output).not.toMatch(/should-release=true/);
	});

	// `gh api` switches to POST as soon as -f parameters are present, which would break
	// these read-only calls outright.
	it('makes every API call an explicit GET', () => {
		const { calls } = runAuthorization(authorized);

		for (const call of calls) {
			const methodIndex = call.indexOf('--method');

			expect(methodIndex, `no --method in call: ${JSON.stringify(call)}`).not.toBe(-1);
			expect(call[methodIndex + 1]).toBe('GET');
		}
	});
});
