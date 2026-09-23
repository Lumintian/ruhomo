import { expect, test } from '@playwright/test';
import { encodeRecipe } from '@ruhomo/core';
import { ACCEPTANCE, PUBLIC_BASE, SOURCE_URL, installBackend } from './backend.ts';

test.beforeEach(async ({ context, browserName }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('URL mode converts and copies the correct override link', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.getByTestId('source-url').fill(SOURCE_URL);
  await page.getByTestId('convert').click();

  await expect(page.getByTestId('target-name')).toHaveText(['DIRECT', '示例代理', '默认代理']);
  const token = encodeRecipe({ source: { url: SOURCE_URL } });
  const expected = `${PUBLIC_BASE}/r/v1/${token}/override.yaml`;
  await expect(page.getByTestId('link-yaml')).toHaveValue(expected);
  await expect(page.getByTestId('override-yaml')).toContainText('+rules:');
  await expect(page.getByTestId('override-yaml')).toContainText('type: http');

  await page.getByTestId('copy-override-link').click();
  await expect(page.getByTestId('copy-override-link')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);

  await page.getByRole('tab', { name: 'JavaScript' }).click();
  await expect(page.getByTestId('link-js')).toHaveValue(`${PUBLIC_BASE}/r/v1/${token}/override.js`);
  await expect(page.getByTestId('override-js')).toContainText('function main(config)');

  // Lazy provider preview fetched from the provider endpoint.
  await page.getByTestId('provider-item').nth(1).getByRole('button', { name: '预览' }).click();
  await expect(page.getByTestId('provider-text')).toHaveText(
    'DOMAIN-SUFFIX,proxy-one.example\nDOMAIN-SUFFIX,proxy-two.example\nDOMAIN-SUFFIX,proxy-three.example\n',
  );
});

test('paste mode converts locally without uploading the rules', async ({ page }) => {
  const { requests } = await installBackend(page);
  await page.goto('/');
  await page.getByTestId('mode-paste').click();
  await page.getByTestId('source-text').fill(ACCEPTANCE);
  await page.getByTestId('convert').click();

  await expect(page.getByTestId('target-name')).toHaveText(['DIRECT', '示例代理', '默认代理']);
  await expect(page.getByTestId('static-export-notice')).toBeVisible();
  await expect(page.getByTestId('remote-link-row')).toHaveCount(0);
  await expect(page.getByTestId('override-yaml')).toContainText('type: inline');
  await expect(page.getByTestId('override-yaml')).not.toContainText('http');

  for (const r of requests) {
    expect(r.url()).not.toContain('direct.example');
    expect(r.url()).not.toMatch(/\/r\/v1\//);
    expect(r.postData() ?? '').not.toContain('direct.example');
  }
  expect(requests.filter((r) => r.method() !== 'GET')).toHaveLength(0);
});

test('reordering targets updates the override', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.getByTestId('mode-paste').click();
  await page.getByTestId('source-text').fill(ACCEPTANCE);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('target-name')).toHaveText(['DIRECT', '示例代理', '默认代理']);

  await page.getByRole('button', { name: '下移 DIRECT' }).click();
  await expect(page.getByTestId('target-name')).toHaveText(['示例代理', 'DIRECT', '默认代理']);
  const yaml = (await page.getByTestId('override-yaml').textContent()) ?? '';
  const rules = yaml
    .split('+rules:')[1]!
    .trim()
    .split('\n')
    .map((l) => l.split(',').at(-1));
  expect(rules).toEqual(['示例代理', 'DIRECT', '默认代理']);
});

test('reordering in URL mode produces a new recipe link', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.getByTestId('source-url').fill(SOURCE_URL);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('target-name')).toHaveText(['DIRECT', '示例代理', '默认代理']);
  await page.getByRole('button', { name: '上移 默认代理' }).click();
  await expect(page.getByTestId('target-name')).toHaveText(['DIRECT', '默认代理', '示例代理']);
  const token = encodeRecipe({ source: { url: SOURCE_URL }, targetOrder: ['DIRECT', '默认代理', '示例代理'] });
  await expect(page.getByTestId('link-yaml')).toHaveValue(`${PUBLIC_BASE}/r/v1/${token}/override.yaml`);
});

test('errors are located and the input is preserved', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.getByTestId('mode-paste').click();
  const bad = 'DOMAIN,a.com,DIRECT\nDOMAIN,b.com,示例代理\nMATCH,DIRECT\nIP-CIDR,1.2.3.4,X\n';
  await page.getByTestId('source-text').fill(bad);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('failure')).toBeVisible();
  const errors = page.getByTestId('diag-error');
  await expect(errors).toHaveCount(2);
  await expect(errors.nth(0)).toContainText('第 3 行');
  await expect(errors.nth(0)).toContainText('FORBIDDEN_RULE_TYPE');
  await expect(errors.nth(1)).toContainText('第 4 行');
  await expect(page.getByTestId('source-text')).toHaveValue(bad);
  await expect(page.getByTestId('targets-table')).toHaveCount(0);
});

test('URL mode surfaces upstream failures and recovers on retry', async ({ page }) => {
  const { upstream } = await installBackend(page, { status: 500, body: 'boom' });
  await page.goto('/');
  await page.getByTestId('source-url').fill(SOURCE_URL);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('failure')).toContainText('UPSTREAM_STATUS');
  await expect(page.getByTestId('source-url')).toHaveValue(SOURCE_URL);
  upstream.status = 200;
  upstream.body = ACCEPTANCE;
  await page.waitForTimeout(5100); // the service backs off briefly after a failure
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByTestId('target-name')).toHaveText(['DIRECT', '示例代理', '默认代理']);
});

test('rule content is rendered as text, never as HTML', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.getByTestId('mode-paste').click();
  const payload = '<img src=x onerror=window.__xss=1>';
  await page.getByTestId('source-text').fill(`DOMAIN,a.com,${payload}\nDOMAIN-KEYWORD,<script>window.__xss=2</script>,DIRECT\n`);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('target-name').first()).toHaveText(payload);
  await page.getByTestId('provider-item').nth(1).getByRole('button', { name: '预览' }).click();
  await expect(page.getByTestId('provider-text')).toContainText('<script>window.__xss=2</script>');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
});

test('remember and clear local data', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.getByTestId('mode-paste').click();
  await page.getByTestId('source-text').fill('DOMAIN,a.com,DIRECT\n');
  await page.reload();
  await expect(page.getByTestId('source-url')).toBeVisible(); // nothing remembered by default

  await page.getByTestId('mode-paste').click();
  await page.getByTestId('source-text').fill('DOMAIN,a.com,DIRECT\n');
  await page.getByTestId('remember').check();
  await page.reload();
  await expect(page.getByTestId('source-text')).toHaveValue('DOMAIN,a.com,DIRECT\n');

  await page.getByTestId('clear-local').click();
  await page.reload();
  await expect(page.getByTestId('source-url')).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
});

test('layout has no horizontal overflow', async ({ page }) => {
  await installBackend(page);
  await page.goto('/');
  await page.getByTestId('source-url').fill(SOURCE_URL);
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('target-name')).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
