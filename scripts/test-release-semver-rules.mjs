import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { extractWorkflowStepScript } from './lib/extractWorkflowStepScript.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowText = readFileSync(
	path.join(repositoryRoot, '.github/workflows/release.yml'),
	'utf8',
);
const script = extractWorkflowStepScript(
	workflowText,
	'release',
	'Write semantic-release configuration',
);

// Execute the exact script the workflow ships, in a scratch working directory, so the
// generated config is provably what production runs -- not a hand-copied duplicate that
// can drift out of sync with release.yml.
const scratchRoot = mkdtempSync(path.join(tmpdir(), 'release-semver-'));
const scriptPath = path.join(scratchRoot, 'write-config.cjs');
writeFileSync(scriptPath, script);
execFileSync(process.execPath, [scriptPath], { cwd: scratchRoot });

const configPath = path.join(scratchRoot, 'release.config.cjs');
const config = (await import(configPath)).default;

assert.deepEqual(config.branches, ['main']);

const commitAnalyzerEntry = config.plugins.find(
	plugin => Array.isArray(plugin) && plugin[0] === '@semantic-release/commit-analyzer',
);
assert.ok(commitAnalyzerEntry, 'expected @semantic-release/commit-analyzer in the plugin pipeline');
const [, commitAnalyzerConfig] = commitAnalyzerEntry;

const githubEntry = config.plugins.find(
	plugin => Array.isArray(plugin) && plugin[0] === '@semantic-release/github',
);
assert.ok(githubEntry, 'expected @semantic-release/github in the plugin pipeline');
const [, githubConfig] = githubEntry;
assert.equal(githubConfig.successComment, false);
assert.equal(githubConfig.failComment, false);
assert.equal(githubConfig.releasedLabels, false);

const logger = { log() {}, error() {} };

function releaseTypeFor(message) {
	return analyzeCommits(commitAnalyzerConfig, {
		commits: [{ hash: 'abc1234', message }],
		logger,
		cwd: process.cwd(),
		env: {},
	});
}

const cases = [
	['fix: correct off-by-one error', 'patch'],
	['feat: add passwordless login', 'minor'],
	['feat!: remove the legacy endpoint', 'major'],
	['fix: adjust response shape\n\nBREAKING CHANGE: field renamed', 'major'],
	['perf: speed up the parser', null],
	['revert: remove passwordless login', null],
	['chore: bump dependency versions', null],
	['docs: fix a typo in the README', null],
	// Regression cases: a suppressed type that is ALSO breaking must still release major.
	// commit-analyzer ranks a `release: false` match as more severe than any real release
	// type once matched (it has no index in RELEASE_TYPES), so it can never be overridden
	// by a later rule -- only evaluating { breaking: true, release: 'major' } FIRST, and
	// letting commit-analyzer's early-stop-at-major behavior skip the suppression rules
	// entirely, makes this correct.
	['perf!: rewrite the parser incompatibly', 'major'],
	['revert!: revert "feat: add passwordless login"', 'major'],
	['perf: rewrite the parser\n\nBREAKING CHANGE: output format changed', 'major'],
	['revert: revert "feat: add passwordless login"\n\nBREAKING CHANGE: cannot be undone', 'major'],
];

for (const [message, expected] of cases) {
	const actual = await releaseTypeFor(message);
	assert.equal(
		actual,
		expected,
		`expected "${message.split('\n')[0]}" to produce release type ${expected}, got ${actual}`,
	);
}

process.stdout.write('Release semver rules behave correctly for every tested commit type.\n');
