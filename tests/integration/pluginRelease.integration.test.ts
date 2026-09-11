import { describe, expect, it } from 'vitest';

import {
	baseSha,
	headSha,
	repository,
	runPluginScript,
	snapshot,
	snapshotResponses,
} from '../support/fixtures/pluginVersion.fixture.ts';

const run = {
	name: 'CI',
	path: '.github/workflows/ci.yml',
	event: 'push',
	head_branch: 'main',
	conclusion: 'success',
	status: 'completed',
	head_repository: { full_name: repository },
	head_sha: headSha,
	check_suite_id: 999,
};
const checks = [
	{ check_runs: [{ name: 'CI / required', head_sha: headSha, conclusion: 'success' }] },
];
const repositoryInfo = { body: { default_branch: 'main' } };
const ready = [
	repositoryInfo,
	{ body: run },
	{ body: checks },
	{ body: { merge_base_commit: { sha: headSha } } },
	{ body: { parents: [{ sha: baseSha }] } },
	...snapshotResponses(snapshot()),
	...snapshotResponses(snapshot('0.1.1', headSha)),
];
const tag = { ref: 'refs/tags/v0.1.1', object: { type: 'commit', sha: headSha } };

describe('plugin release after definitive main CI', () => {
	it('creates a tag for the exact commit and a release with generated notes', () => {
		const result = runPluginScript('release', {}, [
			...ready,
			{ body: [] },
			{ body: tag },
			{ body: [[]] },
			{ body: { id: 1 } },
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.requests).toContain(`"sha": "${headSha}"`);
		expect(result.requests).toContain('"generate_release_notes": true');
		expect(result.stdout).toContain('Published v0.1.1');
	});

	it('does not create another release when retried', () => {
		const result = runPluginScript('release', {}, [
			...ready,
			{ body: [tag] },
			{ body: [[{ tag_name: 'v0.1.1', draft: false }]] },
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.requests).toBe('');
	});

	it('recovers when a previous attempt created only the tag', () => {
		const result = runPluginScript('release', {}, [
			...ready,
			{ body: [tag] },
			{ body: [[]] },
			{ body: { id: 1 } },
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.requests).not.toContain('"ref":');
		expect(result.requests).toContain('"tag_name": "v0.1.1"');
	});

	it.each([
		{ conclusion: 'failure' },
		{ event: 'pull_request' },
		{ head_branch: 'feature' },
		{ path: '.github/workflows/unrelated.yml' },
		{ head_repository: { full_name: 'other/repo' } },
	])('rejects unauthorized CI provenance %j', overrides => {
		const result = runPluginScript('release', {}, [
			repositoryInfo,
			{ body: { ...run, ...overrides } },
		]);
		expect(result.status).not.toBe(0);
		expect(result.requests).toBe('');
	});

	it('requires the aggregate check in the same check suite', () => {
		const result = runPluginScript('release', {}, [
			repositoryInfo,
			{ body: run },
			{ body: [{ check_runs: [] }] },
		]);
		expect(result.status).not.toBe(0);
		expect(result.requests).toBe('');
	});

	it('refuses to move an existing version tag', () => {
		const result = runPluginScript('release', {}, [
			...ready,
			{ body: [{ ...tag, object: { type: 'commit', sha: baseSha } }] },
		]);
		expect(result.status).not.toBe(0);
		expect(result.requests).toBe('');
	});

	it('does not publish for an unchanged plugin version', () => {
		const result = runPluginScript('release', {}, [
			...ready.slice(0, 5),
			...snapshotResponses(snapshot()),
			...snapshotResponses(snapshot()),
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.requests).toBe('');
		expect(result.stdout).toContain('No plugin version change');
	});

	it('does not recreate a version tag after repairing discrepant manifests', () => {
		const previous = snapshot();
		previous.codex.version = '0.2.0';
		const result = runPluginScript('release', {}, [
			...ready.slice(0, 5),
			...snapshotResponses(previous),
			...snapshotResponses(snapshot('0.2.0')),
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).not.toContain('matching-refs');
		expect(result.requests).toBe('');
	});

	it('enforces the same numeric version limit during publication', () => {
		const result = runPluginScript('release', {}, [
			...ready.slice(0, 5),
			...snapshotResponses(snapshot()),
			...snapshotResponses(snapshot('1000000000.0.0')),
		]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('up to nine digits');
		expect(result.requests).toBe('');
	});

	it('explicitly refuses repositories whose default branch is not main', () => {
		const result = runPluginScript('release', {}, [{ body: { default_branch: 'develop' } }]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('default branch is main');
		expect(result.requests).toBe('');
	});
});
