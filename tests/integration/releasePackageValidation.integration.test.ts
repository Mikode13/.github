import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
	extractWorkflowStepScript,
	readWorkflow,
	repositoryRoot,
} from '../support/fixtures/workflowStep.fixture.ts';

let scriptPath: string;

beforeAll(() => {
	// The literal script release.yml ships, not a hand-copied duplicate that can drift.
	const script = extractWorkflowStepScript(
		readWorkflow('release.yml'),
		'release',
		'Verify the package tarball contains every declared entry point',
	);

	scriptPath = path.join(
		mkdtempSync(path.join(tmpdir(), 'release-package-validation-')),
		'verify-package.cjs',
	);
	writeFileSync(scriptPath, script);
});

function runValidation(fixtureDirectory: string) {
	return spawnSync(process.execPath, [scriptPath], {
		cwd: path.join(repositoryRoot, 'tests/support/fixtures', fixtureDirectory),
		encoding: 'utf8',
	});
}

describe('release package validation', () => {
	it('rejects a manifest whose declared entry points were never built', () => {
		// The exact defect that shipped in cross-platform: a package.json declaring dist/*
		// entry points with no dist/ directory ever built.
		const result = runValidation('package-missing-dist');

		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/missing declared entry point/);
	});

	it('accepts a package whose build output is present', () => {
		const result = runValidation('package-with-dist');

		expect(result.status, `stderr: ${result.stderr}`).toBe(0);
	});
});
