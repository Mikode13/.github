import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'integration',
					// Only this repository's own suite. The directories under `fixtures/` are
					// contract fixtures executed by the reusable workflow itself, not tests of
					// this repository, and they run through `pnpm run test:fixtures`.
					include: ['tests/integration/**/*.integration.test.ts'],
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
