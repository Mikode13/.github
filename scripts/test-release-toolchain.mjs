import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWorkflowStepScript } from './lib/extractWorkflowStepScript.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const toolchainDirectory = path.join(repositoryRoot, 'release-toolchain');

// Installs the exact pinned toolchain the same way the release job does. This is what
// actually exercises plugin compatibility (this test exists because
// conventional-changelog-conventionalcommits@10 silently broke
// @semantic-release/release-notes-generator@14 with a "missing helper" error that no
// analyzer-only test could have caught).
execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-workspace'], {
	cwd: toolchainDirectory,
	stdio: 'inherit',
});

const workflowText = readFileSync(
	path.join(repositoryRoot, '.github/workflows/release.yml'),
	'utf8',
);
const configScript = extractWorkflowStepScript(
	workflowText,
	'release',
	'Write semantic-release configuration',
);

// Run the exact script release.yml ships, in the toolchain directory -- same as
// production, so the plugins it lists resolve from the toolchain's own node_modules.
const configScriptPath = path.join(toolchainDirectory, 'write-config.cjs');
writeFileSync(configScriptPath, configScript);
execFileSync(process.execPath, [configScriptPath], { cwd: toolchainDirectory });

const generatedConfigPath = path.join(toolchainDirectory, 'release.config.cjs');
const generatedConfig = (await import(generatedConfigPath)).default;

function pluginName(plugin) {
	return Array.isArray(plugin) ? plugin[0] : plugin;
}

// @semantic-release/npm and @semantic-release/github need real network access (the npm
// registry and the GitHub API); everything else in this test must stay offline.
const offlinePlugins = generatedConfig.plugins.filter(
	plugin => !['@semantic-release/npm', '@semantic-release/github'].includes(pluginName(plugin)),
);

// Build a scratch repository with a real local bare remote (not a fake URL) so
// semantic-release's git operations succeed for real, fully offline. Seeds an existing
// v1.0.0 release, then adds a single breaking `perf` commit: perf is normally suppressed
// from releasing at all, so this is the exact regression case
// scripts/test-release-semver-rules.mjs proves at the analyzer level -- this test proves
// it survives the full dry-run pipeline, including release-notes-generator, which is
// exactly the boundary the missing-helper defect lived on.
const scratchRoot = mkdtempSync(path.join(tmpdir(), 'release-toolchain-'));
const bareRemote = path.join(scratchRoot, 'remote.git');
const workDirectory = path.join(scratchRoot, 'work');

function git(args, cwd) {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

execFileSync('git', ['init', '--bare', '--quiet', bareRemote]);
mkdirSync(workDirectory);
git(['init', '--quiet'], workDirectory);
git(['config', 'user.email', 'test@example.com'], workDirectory);
git(['config', 'user.name', 'Release Toolchain Test'], workDirectory);
git(['branch', '-m', 'main'], workDirectory);
git(['remote', 'add', 'origin', bareRemote], workDirectory);

writeFileSync(
	path.join(workDirectory, 'package.json'),
	JSON.stringify({ name: 'release-toolchain-test-fixture', version: '0.0.0-development' }),
);
git(['add', '.'], workDirectory);
git(['commit', '--quiet', '-m', 'chore: initial commit'], workDirectory);
git(['tag', 'v1.0.0'], workDirectory);
git(['push', '--quiet', '-u', 'origin', 'main', '--tags'], workDirectory);

writeFileSync(path.join(workDirectory, 'parser.txt'), 'rewritten');
git(['add', '.'], workDirectory);
git(
	[
		'commit',
		'--quiet',
		'-m',
		'perf!: rewrite the parser incompatibly',
		'-m',
		'BREAKING CHANGE: output format changed',
	],
	workDirectory,
);
git(['push', '--quiet', 'origin', 'main'], workDirectory);

const testConfig = {
	...generatedConfig,
	repositoryUrl: `file://${bareRemote}`,
	plugins: offlinePlugins,
};
const testConfigPath = path.join(toolchainDirectory, 'release.config.test.cjs');
writeFileSync(testConfigPath, `module.exports = ${JSON.stringify(testConfig)};\n`);

const semanticReleaseBin = path.join(
	toolchainDirectory,
	'node_modules/semantic-release/bin/semantic-release.js',
);
const output = execFileSync(
	process.execPath,
	[semanticReleaseBin, '--dry-run', '--no-ci', '--extends', testConfigPath],
	{ cwd: workDirectory, encoding: 'utf8' },
);

assert.match(
	output,
	/The next release version is 2\.0\.0/,
	`expected a major bump to 2.0.0 for a breaking perf commit; full output:\n${output}`,
);
assert.match(
	output,
	/BREAKING CHANGES/,
	'expected a BREAKING CHANGES heading in the release notes',
);
assert.match(
	output,
	/Performance Improvements/,
	'expected the perf commit categorized under Performance Improvements in the release notes',
);

process.stdout.write(
	'Release toolchain produces a correct major release and notes for a breaking perf commit.\n',
);
