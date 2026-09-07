import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
	extractWorkflowStepScript,
	readWorkflow,
	repositoryRoot,
} from '../support/fixtures/workflowStep.fixture.ts';

interface CommitAnalyzerContext {
	commits: { hash: string; message: string }[];
	logger: { log: () => void; error: () => void };
	cwd: string;
	env: Record<string, string>;
}

type AnalyzeCommits = (config: unknown, context: CommitAnalyzerContext) => Promise<string | null>;

interface ReleaseConfiguration {
	branches: string[];
	plugins: (string | [string, Record<string, unknown>])[];
}

const toolchainDirectory = path.join(repositoryRoot, 'release-toolchain');
const logger = { log: () => undefined, error: () => undefined };

let analyzeCommits: AnalyzeCommits;
let config: ReleaseConfiguration;

beforeAll(async () => {
	// Installs the exact pinned toolchain rather than a separate root-level dependency, so
	// this exercises the same @semantic-release/commit-analyzer the release job publishes
	// with -- one pinned copy, not two that can drift apart.
	execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-workspace'], {
		cwd: toolchainDirectory,
		stdio: 'inherit',
	});

	analyzeCommits = (
		(await import(
			pathToFileURL(
				path.join(toolchainDirectory, 'node_modules/@semantic-release/commit-analyzer/index.js'),
			).href
		)) as { analyzeCommits: AnalyzeCommits }
	).analyzeCommits;

	// Execute the exact script the workflow ships, in a scratch directory, so the generated
	// configuration is provably what production runs.
	const script = extractWorkflowStepScript(
		readWorkflow('release.yml'),
		'release',
		'Write semantic-release configuration',
	);
	const scratchRoot = mkdtempSync(path.join(tmpdir(), 'release-semver-'));
	const scriptPath = path.join(scratchRoot, 'write-config.cjs');
	writeFileSync(scriptPath, script);
	execFileSync(process.execPath, [scriptPath], { cwd: scratchRoot });

	config = (
		(await import(pathToFileURL(path.join(scratchRoot, 'release.config.cjs')).href)) as {
			default: ReleaseConfiguration;
		}
	).default;
});

function pluginConfig(name: string): Record<string, unknown> {
	const entry = config.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === name);

	expect(entry, `expected ${name} in the plugin pipeline`).toBeDefined();

	return (entry as [string, Record<string, unknown>])[1];
}

describe('generated release configuration', () => {
	it('releases only from main', () => {
		expect(config.branches).toStrictEqual(['main']);
	});

	it('silences the GitHub plugin comments and labels', () => {
		const github = pluginConfig('@semantic-release/github');

		expect(github.successComment).toBe(false);
		expect(github.failComment).toBe(false);
		expect(github.releasedLabels).toBe(false);
	});
});

describe('semver rules', () => {
	async function releaseTypeFor(message: string): Promise<string | null> {
		return analyzeCommits(pluginConfig('@semantic-release/commit-analyzer'), {
			commits: [{ hash: 'abc1234', message }],
			logger,
			cwd: process.cwd(),
			env: {},
		});
	}

	it.each([
		['fix: correct off-by-one error', 'patch'],
		['feat: add passwordless login', 'minor'],
		['feat!: remove the legacy endpoint', 'major'],
		['fix: adjust response shape\n\nBREAKING CHANGE: field renamed', 'major'],
		['perf: speed up the parser', null],
		['revert: remove passwordless login', null],
		['chore: bump dependency versions', null],
		['docs: fix a typo in the README', null],
	])('maps %j to %s', async (message, expected) => {
		await expect(releaseTypeFor(message)).resolves.toBe(expected);
	});

	// A suppressed type that is ALSO breaking must still release major. commit-analyzer
	// ranks a `release: false` match as more severe than any real release type once matched
	// (it has no index in RELEASE_TYPES), so it can never be overridden by a later rule --
	// only evaluating { breaking: true, release: 'major' } FIRST, and letting
	// commit-analyzer's early-stop-at-major behaviour skip the suppression rules entirely,
	// makes this correct.
	it.each([
		['perf!: rewrite the parser incompatibly'],
		['revert!: revert "feat: add passwordless login"'],
		['perf: rewrite the parser\n\nBREAKING CHANGE: output format changed'],
		['revert: revert "feat: add passwordless login"\n\nBREAKING CHANGE: cannot be undone'],
	])('still releases major for the breaking but otherwise suppressed %j', async message => {
		await expect(releaseTypeFor(message)).resolves.toBe('major');
	});
});
