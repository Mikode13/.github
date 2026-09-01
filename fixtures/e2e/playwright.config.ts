import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './e2e/specs',
	use: {
		baseURL: 'http://127.0.0.1:4173',
	},
	webServer: {
		command: 'node app/server.mjs',
		url: 'http://127.0.0.1:4173',
		reuseExistingServer: false,
	},
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium' },
		},
	],
});
