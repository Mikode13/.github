import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Options } from 'prettier';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
	executableLines,
	extractWorkflowStepScript,
	readWorkflow,
	repositoryRoot,
} from '../support/fixtures/workflowStep.fixture.ts';

/**
 * Overridable for the same reason the release toolchain directory is: identical logic
 * whether the toolchain was installed in place or through the workflow's own mechanics.
 */
const toolchainDirectory =
	process.env.DOCS_TOOLCHAIN_DIRECTORY ?? path.join(repositoryRoot, 'docs-toolchain');

const fixtureDirectory = path.join(repositoryRoot, 'fixtures/docs-source');
const fixtureFiles = [
	path.join(fixtureDirectory, 'README.md'),
	path.join(fixtureDirectory, 'guides/authoring.md'),
];

const toolchainPrettierConfig = path.join(toolchainDirectory, 'prettier.config.mjs');
const repositoryPrettierConfig = path.join(repositoryRoot, 'prettier.config.mjs');

const workflowText = readWorkflow('ci.yml');
const formattingStep = executableLines(
	extractWorkflowStepScript(
		workflowText,
		'docs',
		'Validate documentation formatting and structure',
	),
);
const linkStep = executableLines(
	extractWorkflowStepScript(workflowText, 'docs', 'Validate internal documentation links'),
);

let toolchainOptions: Options;
let repositoryOptions: Options;

beforeAll(async () => {
	execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-workspace'], {
		cwd: toolchainDirectory,
		stdio: 'inherit',
	});

	toolchainOptions = (
		(await import(pathToFileURL(toolchainPrettierConfig).href)) as { default: Options }
	).default;
	repositoryOptions = (
		(await import(pathToFileURL(repositoryPrettierConfig).href)) as { default: Options }
	).default;
});

function checkFormatting(configPath: string) {
	return spawnSync(
		process.execPath,
		[
			path.join(toolchainDirectory, 'node_modules/prettier/bin/prettier.cjs'),
			'--config',
			configPath,
			'--check',
			...fixtureFiles,
		],
		{ cwd: toolchainDirectory, encoding: 'utf8' },
	);
}

// The defect this suite exists for was a literal `printf '{}'` in the workflow: an empty
// Prettier configuration that silently replaced the shared one. A behavioural test alone
// would not stop someone reintroducing it next to a passing check.
describe('the Documentation capability step', () => {
	it('does not write its own Prettier configuration', () => {
		expect(formattingStep).not.toMatch(/prettier\.json|printf '\{\}/);
	});

	it('formats with the pinned shared configuration', () => {
		expect(formattingStep).toMatch(/--config "\$TOOLCHAIN_DIRECTORY\/prettier\.config\.mjs"/);
	});

	it.each([
		['formatting', () => formattingStep],
		['internal links', () => linkStep],
	])('resolves %s tooling from the committed lockfile, not at run time', (_name, step) => {
		expect(step()).not.toMatch(/pnpm dlx|pnpm --dir "\$tools" add|pnpm add /);
	});

	// `pnpm exec` would resolve against the workspace the sparse checkout drags along and
	// run its `prepare` script, which has nothing installed there.
	it.each([
		['formatting', () => formattingStep],
		['internal links', () => linkStep],
	])('invokes the %s binaries directly rather than through pnpm exec', (_name, step) => {
		expect(step()).not.toMatch(/pnpm (--dir [^\s]+ )?exec/);
	});
});

describe('Source and Documentation formatting agreement', () => {
	it('shares one formatting configuration rather than two that happen to agree', () => {
		expect(toolchainOptions).toStrictEqual(repositoryOptions);
		// Sanity check that the shared configuration is what is being compared, not defaults.
		expect(toolchainOptions.useTabs).toBe(true);
	});

	it('accepts the fixture through the Documentation configuration', () => {
		const result = checkFormatting(toolchainPrettierConfig);

		expect(result.status, result.stderr).toBe(0);
	});

	it('accepts the same fixture through the Source configuration', () => {
		const result = checkFormatting(repositoryPrettierConfig);

		expect(result.status, result.stderr).toBe(0);
	});

	// The fixture only proves something while it still contains Markdown the shared
	// configuration formats differently from Prettier's defaults. This fails if someone
	// trims the code examples out of it and leaves the prose behind.
	it('still fails under Prettier defaults, so it remains a regression test', () => {
		const defaultsConfig = path.join(
			mkdtempSync(path.join(tmpdir(), 'docs-formatting-')),
			'prettier.json',
		);
		writeFileSync(defaultsConfig, '{}\n');

		expect(checkFormatting(defaultsConfig).status).not.toBe(0);
	});
});

describe('the Documentation lint configuration', () => {
	// The shared configuration indents embedded code with tabs, which MD010 rejects by
	// default, so the lint configuration has to tolerate what the formatter produces.
	it('accepts the tabs the shared formatter produces inside code blocks', () => {
		const result = spawnSync(
			process.execPath,
			[
				path.join(toolchainDirectory, 'node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs'),
				'--config',
				path.join(toolchainDirectory, '.markdownlint-cli2.jsonc'),
				...fixtureFiles,
			],
			{ cwd: toolchainDirectory, encoding: 'utf8' },
		);

		expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
	});
});
