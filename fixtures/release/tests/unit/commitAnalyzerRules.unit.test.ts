import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import { describe, expect, it, vi } from 'vitest';

const releaseRules = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../../../release/commit-analyzer-rules.json', import.meta.url)),
		'utf8',
	),
) as unknown[];

const logger = { log: vi.fn(), error: vi.fn() };

function releaseTypeFor(message: string): Promise<string | null> {
	return analyzeCommits(
		{ preset: 'conventionalcommits', releaseRules },
		{
			commits: [{ hash: 'abc1234', message }],
			logger,
			cwd: process.cwd(),
			env: {},
		},
	);
}

describe('MiKode release rules (release/commit-analyzer-rules.json)', () => {
	it('treats fix as a patch release', async () => {
		await expect(releaseTypeFor('fix: correct off-by-one error')).resolves.toBe('patch');
	});

	it('treats feat as a minor release', async () => {
		await expect(releaseTypeFor('feat: add passwordless login')).resolves.toBe('minor');
	});

	it('treats a "!" breaking marker as a major release', async () => {
		await expect(releaseTypeFor('feat!: remove the legacy endpoint')).resolves.toBe('major');
	});

	it('treats a BREAKING CHANGE footer as a major release', async () => {
		await expect(
			releaseTypeFor('fix: adjust response shape\n\nBREAKING CHANGE: field renamed'),
		).resolves.toBe('major');
	});

	it('does not release for perf, overriding the preset default', async () => {
		await expect(releaseTypeFor('perf: speed up the parser')).resolves.toBeNull();
	});

	it('does not release for revert, overriding the preset default', async () => {
		await expect(releaseTypeFor('revert: remove passwordless login')).resolves.toBeNull();
	});

	it('does not release for chore', async () => {
		await expect(releaseTypeFor('chore: bump dependency versions')).resolves.toBeNull();
	});

	it('does not release for docs', async () => {
		await expect(releaseTypeFor('docs: fix a typo in the README')).resolves.toBeNull();
	});
});
