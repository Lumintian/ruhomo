import { expect, test } from '@playwright/test';
import { encodeRecipe } from '@ruhomo/core';
import { PUBLIC_BASE, SOURCE_URL, installBackend } from './backend.ts';

const PREFIX = '/tools/ruhomo/';

test('a deployment under a path prefix loads assets and converts rules through prefixed APIs', async ({ page }) => {
  const { requests } = await installBackend(page, undefined, PREFIX);
  await page.goto(PREFIX);
  await page.getByTestId('source-url').fill(SOURCE_URL);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('target-name')).toHaveCount(3);
  await expect(page.getByTestId('override-yaml')).toContainText('+rules:');

  const token = encodeRecipe({ source: { url: SOURCE_URL } });
  await expect(page.getByTestId('link-yaml')).toHaveValue(`${PUBLIC_BASE}${PREFIX}r/v1/${token}/override.yaml`);
  const paths = requests.map((request) => new URL(request.url()).pathname);
  expect(paths.filter((path) => path.includes('/api/') || path.includes('/r/v1/'))).toEqual(
    expect.arrayContaining([`${PREFIX}api/config`, `${PREFIX}r/v1/${token}/inspect.json`]),
  );
  expect(paths.every((path) => path.startsWith(PREFIX))).toBe(true);
});
