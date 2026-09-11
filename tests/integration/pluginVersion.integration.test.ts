import { describe, expect, it } from 'vitest';

import {
	baseSha,
	change,
	headSha,
	pullRequest,
	repository,
	runPlanner,
	runPluginScript,
	snapshot,
	snapshotResponses,
} from '../support/fixtures/pluginVersion.fixture.ts';

describe('plugin version calculation from the pull request contract', () => {
	it.each([
		['fix: correct instructions', '', '0.1.1'],
		['fix(review): clarify evidence', '', '0.1.1'],
		['feat: add a skill', '', '0.2.0'],
		['feat(review): support a new host', '', '0.2.0'],
		['feat!: replace a public contract', '', '1.0.0'],
		['fix(review)!: remove an input', '', '1.0.0'],
		['refactor: replace a contract', 'Context\n\nBREAKING CHANGE: old input removed', '1.0.0'],
	])('maps %s to %s/%s', (title, body, version) => {
		const input = change(title);
		input.context.body = body;
		const result = runPlanner(input);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ version, needs_update: true });
	});

	it('does not release a docs-only change even with a feature title', () => {
		const input = change('feat: improve the project README');
		input.head = snapshot();
		input.head.tree.push({ path: 'README.md', type: 'blob', mode: '100644', sha: headSha });
		expect(JSON.parse(runPlanner(input).stdout)).toMatchObject({
			version: '0.1.0',
			needs_update: false,
		});
	});

	it.each(['docs: edit a skill', 'ci: edit a skill', 'chore: edit a manifest'])(
		'rejects an unversioned distributed change: %s',
		title => {
			const result = runPlanner(change(title));
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain('Distributed plugin content changed');
		},
	);

	it('is idempotent after the bot commit and keeps other manifest fields', () => {
		const result = runPlanner(change('fix: correct instructions', '0.1.1'));
		expect(JSON.parse(result.stdout)).toMatchObject({
			version: '0.1.1',
			needs_update: false,
			manifests: {
				claude: { description: 'Preserve $(literal) content' },
				codex: { skills: './skills/' },
			},
		});
	});

	it('does not infer another bump from a version-only commit', () => {
		const input = change('fix: no content change');
		input.head = snapshot('0.1.1');
		expect(JSON.parse(runPlanner(input).stdout)).toMatchObject({
			version: '0.1.0',
			needs_update: true,
		});
	});

	it('requires a release for deletion and manifest metadata changes', () => {
		const input = change('docs: remove a skill');
		input.head.tree.pop();
		expect(runPlanner(input).status).not.toBe(0);
		input.head = snapshot();
		input.head.codex.skills = './other-skills/';
		expect(runPlanner(input).status).not.toBe(0);
	});

	it.each(['v1.0.0', '01.0.0', '1.0.0-beta.1', '1.0', '1000000000.0.0'])(
		'refuses unsupported manifest version %s',
		version => {
			expect(runPlanner(change('fix: example', version)).status).not.toBe(0);
		},
	);

	it('repairs discrepant host versions using the numeric maximum without downgrading', () => {
		const input = change('fix: reconcile host versions');
		input.base = snapshot('2.9.0');
		input.base.codex.version = '2.10.0';
		input.head = snapshot('2.10.0');
		expect(JSON.parse(runPlanner(input).stdout)).toMatchObject({
			previous: '2.10.0',
			version: '2.10.0',
			base_repair: true,
			needs_update: false,
		});
	});

	it('allows adopting a second host manifest in a normal feature PR', () => {
		const input = {
			...change('feat: add Codex distribution', '0.2.0'),
			base: {
				...snapshot(),
				codex: null,
				tree: snapshot().tree.filter(entry => entry.path !== '.codex-plugin/plugin.json'),
			},
		};
		expect(JSON.parse(runPlanner(input).stdout)).toMatchObject({
			previous: '0.1.0',
			version: '0.2.0',
			base_repair: true,
			needs_update: false,
		});
	});

	it.each(['0.1.1', '0.2.0', '1.0.0'])(
		'accepts one valid published increment %s without reading the squash message',
		version => {
			const input = change('docs: misleading squash title', version);
			input.context.event = 'push';
			input.context.body = 'BREAKING CHANGE: footer from an individual commit';
			const result = runPlanner(input);
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({ version, needs_update: false });
		},
	);

	it.each(['0.0.9', '0.1.0', '0.1.2', '0.3.0', '1.1.0'])(
		'rejects a missing, skipped or downgraded published version %s',
		version => {
			const input = change('feat: publish', version);
			input.context.event = 'push';
			expect(runPlanner(input).status).not.toBe(0);
		},
	);

	it('rejects discrepant versions at publication even if each parses', () => {
		const input = change('feat: publish', '0.2.0');
		input.context.event = 'push';
		input.head.codex.version = '0.1.1';
		expect(runPlanner(input).stderr).toContain('Published host versions must agree');
	});

	it('preserves the version on docs-only push and allows a version-only repair', () => {
		const input = change('feat!: misleading title');
		input.context.event = 'push';
		input.head = snapshot();
		expect(JSON.parse(runPlanner(input).stdout)).toMatchObject({
			version: '0.1.0',
			needs_update: false,
		});
		input.base.codex.version = '0.2.0';
		input.head = snapshot('0.2.0');
		expect(JSON.parse(runPlanner(input).stdout)).toMatchObject({
			version: '0.2.0',
			base_repair: true,
			needs_update: false,
		});
	});

	it('bootstraps paired manifests at 0.1.0', () => {
		const input = { ...change(), base: { tree: [], claude: null, codex: null } };
		expect(JSON.parse(runPlanner(input).stdout)).toMatchObject({
			version: '0.1.0',
			needs_update: false,
		});
	});
});

function event(context = change().context) {
	return {
		number: context.number,
		repository: { full_name: repository, default_branch: 'main' },
		pull_request: pullRequest(context),
	};
}

const ancestry = [
	{ body: { object: { sha: baseSha } } },
	{ body: { merge_base_commit: { sha: baseSha } } },
] as const;

describe('plugin inspection through GitHub and real JSON blobs', () => {
	it('checks the bot-updated PR without executing consumer code', () => {
		const result = runPluginScript(
			'inspect',
			event(),
			[
				...ancestry,
				...snapshotResponses(snapshot()),
				...snapshotResponses(snapshot('0.1.1', headSha)),
			],
			'pull_request',
			['check'],
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.output).toContain('needs_update=false');
		expect(result.calls).toContain('/git/trees/');
		expect(result.calls).not.toContain('graphql');
	});

	it('fails the required check if either manifest is stale', () => {
		const result = runPluginScript(
			'inspect',
			event(),
			[
				...ancestry,
				...snapshotResponses(snapshot()),
				...snapshotResponses(snapshot('0.1.0', headSha)),
			],
			'pull_request',
			['check'],
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Both plugin manifests must declare 0.1.1');
	});

	it('validates the definitive squash commit on push', () => {
		const input = {
			repository: { full_name: repository, default_branch: 'main' },
			before: 'f'.repeat(40),
			after: headSha,
			head_commit: { message: 'feat: new behavior (#13)\n\nBREAKING CHANGE: from another commit' },
		};
		const result = runPluginScript(
			'inspect',
			input,
			[
				{ body: { parents: [{ sha: baseSha }] } },
				...snapshotResponses(snapshot()),
				...snapshotResponses(snapshot('0.2.0', headSha)),
			],
			'push',
			['check'],
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toContain(`/git/trees/${baseSha}?recursive=1`);
		expect(result.calls).not.toContain('f'.repeat(40));
	});

	it('prepares an update only on the privileged event', () => {
		const responses = [
			...ancestry,
			...snapshotResponses(snapshot()),
			...snapshotResponses(snapshot('0.1.0', headSha)),
		];
		const result = runPluginScript('inspect', event(), responses, 'pull_request_target', [
			'prepare',
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.output).toContain('needs_update=true');
		expect(runPluginScript('inspect', event(), [], 'pull_request', ['prepare']).status).not.toBe(0);
	});

	it('does not prepare writes for a fork', () => {
		const context = change().context;
		context.head_repository = 'external/skills';
		const result = runPluginScript('inspect', event(context), [], 'pull_request_target', [
			'prepare',
		]);
		expect(result.status).toBe(0);
		expect(result.output).toContain('needs_update=false');
		expect(result.calls).toBe('');
	});

	it('requires the PR to include current main', () => {
		const result = runPluginScript(
			'inspect',
			event(),
			[
				{ body: { object: { sha: 'c'.repeat(40) } } },
				ancestry[1],
				...snapshotResponses(snapshot()),
				...snapshotResponses(snapshot('0.1.1', headSha)),
			],
			'pull_request',
			['check'],
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Update the PR branch');
	});

	it.each(['check', 'prepare'])('allows a docs-only PR behind main in %s mode', mode => {
		const input = change('docs: update README');
		const result = runPluginScript(
			'inspect',
			event(input.context),
			[
				{ body: { object: { sha: 'c'.repeat(40) } } },
				ancestry[1],
				...snapshotResponses(snapshot()),
				...snapshotResponses(snapshot()),
			],
			mode === 'check' ? 'pull_request' : 'pull_request_target',
			[mode],
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.output).toContain('needs_update=false');
	});

	it('does not impose branch freshness through the central plugin fixture', () => {
		const value = snapshot();
		value.tree = value.tree.map(entry => ({ ...entry, path: `fixtures/plugin/${entry.path}` }));
		const result = runPluginScript(
			'inspect',
			event(),
			[
				{ body: { object: { sha: 'c'.repeat(40) } } },
				ancestry[1],
				...snapshotResponses(value),
				...snapshotResponses(value),
			],
			'pull_request',
			['check'],
			'fixtures/plugin',
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.output).toContain('needs_update=false');
	});

	it('allows an unrelated old PR opened before plugin adoption', () => {
		const absent = { body: { truncated: false, tree: [] } };
		const result = runPluginScript(
			'inspect',
			event(change('docs: update README').context),
			[{ body: { object: { sha: 'c'.repeat(40) } } }, ancestry[1], absent, absent],
			'pull_request',
			['check'],
			'fixtures/plugin',
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.output).toContain('needs_update=false');
	});

	it('rejects a changed bundle without manifests on an old branch', () => {
		const result = runPluginScript(
			'inspect',
			event(),
			[
				{ body: { object: { sha: 'c'.repeat(40) } } },
				ancestry[1],
				{ body: { truncated: false, tree: [] } },
				{
					body: {
						truncated: false,
						tree: [{ path: 'skills/new/SKILL.md', type: 'blob', mode: '100644', sha: headSha }],
					},
				},
			],
			'pull_request',
			['check'],
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Both plugin manifests must be JSON objects');
	});

	it('still rejects removal of a host manifest', () => {
		const value = snapshot('0.2.0', headSha);
		value.tree = value.tree.filter(entry => entry.path !== '.codex-plugin/plugin.json');
		const result = runPluginScript(
			'inspect',
			event(),
			[...ancestry, ...snapshotResponses(snapshot()), ...snapshotResponses(value).slice(0, 2)],
			'pull_request',
			['check'],
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Both plugin manifests must be JSON objects');
	});

	it('uses the live ref on edited events even when the event base is stale', () => {
		const input = event();
		input.pull_request.base.sha = 'e'.repeat(40);
		const result = runPluginScript(
			'inspect',
			{ ...input, action: 'edited' },
			[
				...ancestry,
				...snapshotResponses(snapshot()),
				...snapshotResponses(snapshot('0.1.1', headSha)),
			],
			'pull_request',
			['check'],
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).not.toContain('e'.repeat(40));
	});

	it('still requires freshness for a version-only correction', () => {
		const result = runPluginScript(
			'inspect',
			event(),
			[
				{ body: { object: { sha: 'c'.repeat(40) } } },
				ancestry[1],
				...snapshotResponses(snapshot()),
				...snapshotResponses(snapshot('0.2.0')),
			],
			'pull_request_target',
			['prepare'],
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Update the PR branch');
	});

	it('refuses a truncated tree instead of treating it as no change', () => {
		const result = runPluginScript(
			'inspect',
			event(),
			[...ancestry, { body: { truncated: true, tree: [] } }],
			'pull_request',
			['check'],
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('complete Git tree');
	});

	it('refuses a manifest symlink', () => {
		const value = snapshot();
		value.tree = value.tree.map(entry =>
			entry.path === '.claude-plugin/plugin.json' ? { ...entry, mode: '120000' } : entry,
		);
		const result = runPluginScript(
			'inspect',
			event(),
			[...ancestry, ...snapshotResponses(value)],
			'pull_request',
			['check'],
		);
		expect(result.stderr).toContain('not symlinks');
	});
});

describe('atomic App version commit', () => {
	it('does not reject stale PR base metadata when the live base still matches', () => {
		const plan: unknown = JSON.parse(runPlanner(change()).stdout);
		const pr = pullRequest();
		pr.base.sha = 'e'.repeat(40);
		const result = runPluginScript('update', plan, [
			{ body: pr },
			ancestry[0],
			{ body: { data: { createCommitOnBranch: { commit: { oid: 'f'.repeat(40) } } } } },
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.requests).toContain(headSha);
	});
	it('updates exactly the two manifests on the expected PR head', () => {
		const plan: unknown = JSON.parse(runPlanner(change()).stdout);
		const result = runPluginScript('update', plan, [
			{ body: pullRequest() },
			ancestry[0],
			{ body: { data: { createCommitOnBranch: { commit: { oid: 'e'.repeat(40) } } } } },
		]);
		expect(result.status, result.stderr).toBe(0);
		const request = JSON.parse(result.requests) as {
			variables: {
				input: {
					expectedHeadOid: string;
					fileChanges: { additions: { path: string; contents: string }[] };
				};
			};
		};
		expect(request.variables.input.expectedHeadOid).toBe(headSha);
		const additions = request.variables.input.fileChanges.additions;
		expect(additions.map(file => file.path)).toEqual([
			'.claude-plugin/plugin.json',
			'.codex-plugin/plugin.json',
		]);
		for (const file of additions)
			expect(JSON.parse(Buffer.from(file.contents, 'base64').toString())).toMatchObject({
				version: '0.1.1',
			});
	});

	it('refuses a PR title changed while preparing the commit', () => {
		const plan: unknown = JSON.parse(runPlanner(change()).stdout);
		const result = runPluginScript('update', plan, [
			{ body: { ...pullRequest(), title: 'feat: new scope' } },
		]);
		expect(result.status).not.toBe(0);
		expect(result.requests).toBe('');
	});

	it('refuses when the default branch moved', () => {
		const plan: unknown = JSON.parse(runPlanner(change()).stdout);
		const result = runPluginScript('update', plan, [
			{ body: pullRequest() },
			{ body: { object: { sha: headSha } } },
		]);
		expect(result.status).not.toBe(0);
		expect(result.requests).toBe('');
	});

	it('fails if GitHub rejects a concurrent head update', () => {
		const plan: unknown = JSON.parse(runPlanner(change()).stdout);
		const result = runPluginScript('update', plan, [
			{ body: pullRequest() },
			ancestry[0],
			{ body: { errors: [{ message: 'expectedHeadOid mismatch' }] } },
		]);
		expect(result.status).not.toBe(0);
	});
});
