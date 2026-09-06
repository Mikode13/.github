import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
	'release',
	'Verify the package tarball contains every declared entry point',
);

const scratchRoot = mkdtempSync(path.join(tmpdir(), 'release-package-validation-'));
const scriptPath = path.join(scratchRoot, 'verify-package.cjs');
writeFileSync(scriptPath, script);

function runValidation(fixtureDirectory) {
	return spawnSync(process.execPath, [scriptPath], {
		cwd: path.join(repositoryRoot, 'scripts/fixtures', fixtureDirectory),
		encoding: 'utf8',
	});
}

// This is the exact defect that shipped in cross-platform: a package.json declaring
// dist/* entry points with no dist/ directory ever built. Proves the check catches it.
{
	const result = runValidation('package-missing-dist');
	assert.notEqual(result.status, 0, 'expected validation to fail when dist/ is missing');
	assert.match(result.stderr, /missing declared entry point/);
}

// A properly built package must pass without complaint.
{
	const result = runValidation('package-with-dist');
	assert.equal(
		result.status,
		0,
		`expected validation to pass for a built package, got stderr: ${result.stderr}`,
	);
}

process.stdout.write('Release package validation behaves correctly for both fixtures.\n');
