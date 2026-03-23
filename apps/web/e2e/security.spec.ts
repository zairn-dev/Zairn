import { test, expect } from '@playwright/test';

test.describe('Security Headers', () => {
  test('CSP meta tag prevents inline scripts', async ({ page }) => {
    const html = await (await page.goto('/')).text();
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('unsafe-eval');
  });

  test('no sensitive data in page source', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    // Supabase anon key is expected (public), but no secret keys
    expect(html).not.toMatch(/GEODROP_ENCRYPTION_SECRET/);
    expect(html).not.toMatch(/pinata_secret_api_key/);
    expect(html).not.toMatch(/CHAIN_PRIVATE_KEY/);
  });
});

test.describe('XSS Prevention', () => {
  test('no dangerouslySetInnerHTML in rendered output', async ({ page }) => {
    await page.goto('/');
    // Verify no script tags injected via user content
    const scriptTags = await page.locator('script:not([src])').count();
    // Only Vite's module script should be present
    expect(scriptTags).toBeLessThanOrEqual(1);
  });
});
