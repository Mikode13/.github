import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { repositoryRoot } from './workflowStep.fixture.ts';

export const baseSha = 'a'.repeat(40);
export const headSha = 'b'.repeat(40);
export const repository = 'Mikode13/skills';

export function snapshot(version = '0.1.0', skillSha = baseSha) {
	return {
		claude: { name: 'mikode-skills', version, description: 'Preserve $(literal) content' },
		codex: { name: 'mikode-skills', version, skills: './skills/' },
		tree: [
			{ path: '.claude-plugin/plugin.json', type: 'blob', mode: '100644', sha: 'c'.repeat(40) },
			{ path: '.codex-plugin/plugin.json', type: 'blob', mode: '100644', sha: 'd'.repeat(40) },
			{ path: 'skills/example/SKILL.md', type: 'blob', mode: '100644', sha: skillSha },
		],
	};
}

export function change(title = 'fix: correct review instructions', version = '0.1.0') {
	return {
		context: {
			event: 'pull_request',
			title,
			body: '',
			repository,
			head_repository: repository,
			base: baseSha,
			head: headSha,
			branch: 'fix/example',
			default_branch: 'main',
			base_branch: 'main',
			number: 13,
			directory: '',
			state: 'open',
			draft: false,
		},
		base: snapshot(),
		head: snapshot(version, headSha),
	};
}

export function pullRequest(context = change().context) {
	return {
		title: context.title,
		body: context.body,
		state: context.state,
		draft: context.draft,
		base: { sha: context.base, ref: context.base_branch, repo: { full_name: repository } },
		head: { sha: context.head, ref: context.branch, repo: { full_name: context.head_repository } },
	};
}

export function snapshotResponses(value: ReturnType<typeof snapshot>) {
	return [
		{ body: { truncated: false, tree: value.tree } },
		...[value.claude, value.codex].map(manifest => ({
			body: {
				encoding: 'base64',
				content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
			},
		})),
	];
}

export function runPlanner(input: unknown) {
	return spawnSync(
		'jq',
		[
			'-L',
			path.join(repositoryRoot, 'plugin-version'),
			'-f',
			path.join(repositoryRoot, 'plugin-version/plan.jq'),
		],
		{
			input: JSON.stringify(input),
			encoding: 'utf8',
		},
	);
}

export function runPluginScript(
	script: string,
	input: unknown,
	responses: { body?: unknown; status?: number }[],
	eventName = 'pull_request',
	args: string[] = [],
	pluginDirectory = '.',
) {
	const directory = mkdtempSync(path.join(tmpdir(), 'plugin-version-test-'));
	const gh = path.join(directory, 'gh');
	copyFileSync(path.join(repositoryRoot, 'tests/support/fakes/gh.fake.cjs'), gh);
	chmodSync(gh, 0o755);
	const inputPath = path.join(directory, 'input.json');
	const planPath = script === 'update' ? inputPath : path.join(directory, 'plan.json');
	writeFileSync(inputPath, JSON.stringify(input));
	for (const file of ['output', 'calls', 'requests']) writeFileSync(path.join(directory, file), '');
	const result = spawnSync(
		'bash',
		[path.join(repositoryRoot, `plugin-version/${script}.sh`), ...args],
		{
			encoding: 'utf8',
			env: {
				PATH: `${directory}:${process.env.PATH ?? ''}`,
				RUNNER_TEMP: directory,
				GITHUB_REPOSITORY: repository,
				GITHUB_EVENT_PATH: inputPath,
				GITHUB_EVENT_NAME: eventName,
				GITHUB_OUTPUT: path.join(directory, 'output'),
				PLUGIN_VERSION_PLAN: planPath,
				PLUGIN_DIRECTORY: pluginDirectory,
				PLUGIN_CI_RUN_ID: '1234',
				READ_TOKEN: 'fake-read-token',
				APP_TOKEN: 'fake-app-token',
				GH_TOKEN: 'fake-token',
				FAKE_GH_RESPONSES: JSON.stringify(responses),
				FAKE_GH_LOG: path.join(directory, 'calls'),
				FAKE_GH_CALL_INDEX_FILE: path.join(directory, 'index'),
				FAKE_GH_INPUT_LOG: path.join(directory, 'requests'),
			},
		},
	);
	return {
		...result,
		output: readFileSync(path.join(directory, 'output'), 'utf8'),
		calls: readFileSync(path.join(directory, 'calls'), 'utf8'),
		requests: readFileSync(path.join(directory, 'requests'), 'utf8'),
	};
}
