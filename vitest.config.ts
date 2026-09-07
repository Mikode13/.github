import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'integration',
					// This project covers only this repository's own suites. The Vitest projects
					// inside `fixtures/` belong to separate packages with their own configs;
					// `pnpm run test:fixtures` runs those, and `pnpm test` aggregates both.
					include: ['tests/integration/**/*.integration.test.ts'],
					// releaseSemverRules and releaseToolchain both install into `release-toolchain/`,
					// and the second writes generated config files there while running. Vitest
					// parallelises test files by default, which makes that a race on shared on-disk
					// state -- invisible while these were sequential scripts under `check`.
					fileParallelism: false,
					// Every case here drives a real toolchain: a pnpm install, a semantic-release
					// dry run against a scratch Git repository, a local HTTP server. None of that
					// fits the 5s default.
					testTimeout: 300_000,
					hookTimeout: 300_000,
				},
			},
		],
	},
});
