import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
	extractWorkflowStepScript,
	readWorkflow,
	repositoryRoot,
} from '../support/fixtures/workflowStep.fixture.ts';

type Plugin = string | [string, Record<string, unknown>];

interface ReleaseConfiguration {
	branches: string[];
	plugins: Plugin[];
	repositoryUrl?: string;
}

/**
 * Overridable for the same reason the workflow pins its own toolchain commit: this suite's
 * logic is identical whether the toolchain was installed in place (the default, exercised
 * by `pnpm test`) or through the real checkout-and-move mechanics release.yml uses (the
 * `release toolchain mechanics` job points this at `runner.temp`). Only the latter would
 * catch actions/checkout rejecting a path outside GITHUB_WORKSPACE, because no test that
 * never invokes the real action can.
 */
const toolchainDirectory =
	process.env.RELEASE_TOOLCHAIN_DIRECTORY ?? path.join(repositoryRoot, 'release-toolchain');

// Isolated from this suite's own CI environment. Without this, running inside GitHub
// Actions leaks GITHUB_ACTIONS/GITHUB_REF (set on the outer job, e.g. refs/pull/7/merge)
// into the inner dry run's branch detection -- `--no-ci` only skips the "is this CI" gate,
// not environment-reported branch resolution, so semantic-release silently refused to
// release, believing it was on the wrong branch. A denylist rather than an allowlist, so
// PATH, HOME, proxy, locale and certificate settings all survive.
const cleanEnv = Object.fromEntries(
	Object.entries(process.env).filter(
		([name]) => !/^(CI|GITHUB_.*|RUNNER_.*|ACTIONS_.*)$/.test(name),
	),
);

let generatedConfig: ReleaseConfiguration;
let dryRunOutput: string;

function git(args: string[], cwd: string): void {
	execFileSync('git', args, { cwd, env: cleanEnv, stdio: 'pipe' });
}

function pluginName(plugin: Plugin): string {
	return Array.isArray(plugin) ? plugin[0] : plugin;
}

beforeAll(async () => {
	// Installs the exact pinned toolchain the same way the release job does. This is what
	// exercises plugin compatibility: this suite exists because
	// conventional-changelog-conventionalcommits@10 silently broke
	// @semantic-release/release-notes-generator@14 with a "missing helper" error that no
	// analyzer-only test could have caught.
	execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-workspace'], {
		cwd: toolchainDirectory,
		stdio: 'inherit',
	});

	// Run the exact script release.yml ships, in the toolchain directory -- same as
	// production, so the plugins it lists resolve from the toolchain's own node_modules.
	const configScriptPath = path.join(toolchainDirectory, 'write-config.cjs');
	writeFileSync(
		configScriptPath,
		extractWorkflowStepScript(
			readWorkflow('release.yml'),
			'release',
			'Write semantic-release configuration',
		),
	);
	execFileSync(process.execPath, [configScriptPath], { cwd: toolchainDirectory });

	generatedConfig = (
		(await import(pathToFileURL(path.join(toolchainDirectory, 'release.config.cjs')).href)) as {
			default: ReleaseConfiguration;
		}
	).default;

	// Build a scratch repository with a real local bare remote (not a fake URL) so
	// semantic-release's git operations succeed for real, fully offline. Seeds an existing
	// v1.0.0 release, then adds a single breaking `perf` commit: perf is normally suppressed
	// from releasing at all, so this is the regression case releaseSemverRules proves at the
	// analyzer level -- proven here through the full pipeline, including the notes
	// generator, which is the boundary the missing-helper defect lived on.
	const scratchRoot = mkdtempSync(path.join(tmpdir(), 'release-toolchain-'));
	const bareRemote = path.join(scratchRoot, 'remote.git');
	const workDirectory = path.join(scratchRoot, 'work');

	execFileSync('git', ['init', '--bare', '--quiet', bareRemote], { env: cleanEnv });
	// A fresh bare repository's HEAD default (main vs. master) depends on the installation's
	// own init.defaultBranch, which differs between environments -- this failed in real CI
	// while passing locally for exactly that reason, because semantic-release fetches HEAD
	// from the remote to resolve branches and this suite only ever pushes main.
	execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
		cwd: bareRemote,
		env: cleanEnv,
	});

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

	// @semantic-release/npm and @semantic-release/github need real network access (the npm
	// registry and the GitHub API); everything else must stay offline.
	const testConfig: ReleaseConfiguration = {
		...generatedConfig,
		repositoryUrl: `file://${bareRemote}`,
		plugins: generatedConfig.plugins.filter(
			plugin => !['@semantic-release/npm', '@semantic-release/github'].includes(pluginName(plugin)),
		),
	};
	const testConfigPath = path.join(toolchainDirectory, 'release.config.test.cjs');
	writeFileSync(testConfigPath, `module.exports = ${JSON.stringify(testConfig)};\n`);

	dryRunOutput = execFileSync(
		process.execPath,
		[
			path.join(toolchainDirectory, 'node_modules/semantic-release/bin/semantic-release.js'),
			'--dry-run',
			'--no-ci',
			'--extends',
			testConfigPath,
		],
		{ cwd: workDirectory, env: cleanEnv, encoding: 'utf8' },
	);
});

describe('pinned release toolchain', () => {
	it('bumps a breaking perf commit to the next major version', () => {
		expect(dryRunOutput, dryRunOutput).toMatch(/The next release version is 2\.0\.0/);
	});

	it('renders a BREAKING CHANGES heading in the release notes', () => {
		expect(dryRunOutput).toMatch(/BREAKING CHANGES/);
	});

	// The notes generator, not the analyzer, is where conventional-changelog-
	// conventionalcommits@10 broke with a "missing helper" error.
	it('categorises the perf commit under Performance Improvements', () => {
		expect(dryRunOutput).toMatch(/Performance Improvements/);
	});
});
