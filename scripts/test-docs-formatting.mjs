import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractWorkflowStepScript } from './lib/extractWorkflowStepScript.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Overridable for the same reason RELEASE_TOOLCHAIN_DIRECTORY is: this script's own logic
// is identical whether the toolchain was installed in place or through the real
// checkout-and-move mechanics the workflow uses.
const toolchainDirectory =
	process.env.DOCS_TOOLCHAIN_DIRECTORY ?? path.join(repositoryRoot, 'docs-toolchain');

const fixtureDirectory = path.join(repositoryRoot, 'fixtures/docs-source');
const fixtureFiles = [
	path.join(fixtureDirectory, 'README.md'),
	path.join(fixtureDirectory, 'guides/authoring.md'),
];

// ---------------------------------------------------------------------------
// The workflow step itself, before anything is executed. The defect this test exists
// for was a literal `printf '{}\n'` in the workflow: an empty Prettier configuration
// that silently replaced the shared one. A behavioural test alone would not stop
// someone reintroducing it next to a passing check.
// ---------------------------------------------------------------------------
const workflowText = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
/**
 * Shell comments are stripped before anything is asserted: a comment explaining why
 * `pnpm exec` is avoided must not read as the step using it, and a comment quoting the
 * shared configuration path must not satisfy the assertion that the step passes it.
 */
function executableLines(script) {
	return script
		.split('\n')
		.filter(line => !/^\s*#/.test(line))
		.join('\n');
}

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

assert.doesNotMatch(
	formattingStep,
	/prettier\.json|printf '\{\}/,
	'the Documentation capability must not write its own Prettier configuration',
);
assert.match(
	formattingStep,
	/--config "\$TOOLCHAIN_DIRECTORY\/prettier\.config\.mjs"/,
	'the Documentation capability must format with the pinned shared configuration',
);

for (const [name, step] of [
	['formatting', formattingStep],
	['internal links', linkStep],
]) {
	assert.doesNotMatch(
		step,
		/pnpm dlx|pnpm --dir "\$tools" add|pnpm add /,
		`the ${name} step must resolve tooling from the committed lockfile, not at runtime`,
	);
	// `pnpm exec` would resolve against the workspace the sparse checkout drags along and
	// run its `prepare` script, which has nothing installed. The binaries are called by path.
	assert.doesNotMatch(
		step,
		/pnpm (--dir [^\s]+ )?exec/,
		`the ${name} step must invoke the toolchain binaries directly, not through pnpm exec`,
	);
}

// ---------------------------------------------------------------------------
// The real toolchain, installed exactly as the workflow installs it.
// ---------------------------------------------------------------------------
execFileSync('pnpm', ['install', '--frozen-lockfile', '--ignore-workspace'], {
	cwd: toolchainDirectory,
	stdio: 'inherit',
});

const prettierBinary = path.join(toolchainDirectory, 'node_modules/prettier/bin/prettier.cjs');
const markdownlintBinary = path.join(
	toolchainDirectory,
	'node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs',
);
const toolchainPrettierConfig = path.join(toolchainDirectory, 'prettier.config.mjs');
const repositoryPrettierConfig = path.join(repositoryRoot, 'prettier.config.mjs');

// Both capabilities must resolve the same option object, not merely two configurations
// that happen to agree on the cases this fixture covers today.
const toolchainOptions = (await import(pathToFileURL(toolchainPrettierConfig).href)).default;
const repositoryOptions = (await import(pathToFileURL(repositoryPrettierConfig).href)).default;

assert.deepEqual(
	toolchainOptions,
	repositoryOptions,
	'the documentation toolchain and this repository must share one formatting configuration',
);
assert.equal(
	toolchainOptions.useTabs,
	true,
	'sanity check: the shared configuration is the one being compared, not Prettier defaults',
);

function checkFormatting(configPath) {
	return spawnSync(
		process.execPath,
		[prettierBinary, '--config', configPath, '--check', ...fixtureFiles],
		{
			cwd: toolchainDirectory,
			encoding: 'utf8',
		},
	);
}

// ---------------------------------------------------------------------------
// Source and Documentation agree on the same Markdown fixture.
// ---------------------------------------------------------------------------
{
	const documentation = checkFormatting(toolchainPrettierConfig);
	assert.equal(
		documentation.status,
		0,
		`Documentation formatting rejected the fixture: ${documentation.stderr}`,
	);

	const source = checkFormatting(repositoryPrettierConfig);
	assert.equal(source.status, 0, `Source formatting rejected the fixture: ${source.stderr}`);
}

// The fixture only proves something while it still contains Markdown the shared
// configuration formats differently from Prettier's defaults. This is the assertion that
// fails if someone trims the code examples out of it and leaves prose behind.
{
	const scratch = mkdtempSync(path.join(tmpdir(), 'docs-formatting-'));
	const defaultsConfig = path.join(scratch, 'prettier.json');
	writeFileSync(defaultsConfig, '{}\n');

	const defaults = checkFormatting(defaultsConfig);
	assert.notEqual(
		defaults.status,
		0,
		'the fixture no longer distinguishes the shared configuration from Prettier defaults',
	);
}

// ---------------------------------------------------------------------------
// The lint configuration has to tolerate what that formatter produces: the shared
// configuration indents embedded code with tabs, which MD010 rejects by default.
// ---------------------------------------------------------------------------
{
	const lint = spawnSync(
		process.execPath,
		[
			markdownlintBinary,
			'--config',
			path.join(toolchainDirectory, '.markdownlint-cli2.jsonc'),
			...fixtureFiles,
		],
		{ cwd: toolchainDirectory, encoding: 'utf8' },
	);

	assert.equal(lint.status, 0, `markdownlint rejected the fixture: ${lint.stdout}${lint.stderr}`);
}

process.stdout.write(
	'Source and Documentation format the shared fixture identically, from the committed toolchain lockfile.\n',
);
