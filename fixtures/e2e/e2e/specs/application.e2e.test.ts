import { expect, test } from '@playwright/test';

test('serves the application through its external entry point', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'MiKode CI fixture' })).toBeVisible();
});
