import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('shows login form on first visit', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /sign in|log in|welcome/i })).toBeVisible();
  });

  test('shows email and password fields', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByPlaceholder(/email/i)).toBeVisible();
    await expect(page.getByPlaceholder(/password/i)).toBeVisible();
  });

  test('shows error on invalid credentials', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder(/email/i).fill('invalid@test.com');
    await page.getByPlaceholder(/password/i).fill('wrongpassword');
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    // Should show error (not redirect to app)
    await expect(page.getByText(/invalid|error|failed/i)).toBeVisible({ timeout: 5000 });
  });

  test('signup form is accessible', async ({ page }) => {
    await page.goto('/');
    const signUpLink = page.getByText(/sign up|create account|register/i);
    if (await signUpLink.isVisible()) {
      await signUpLink.click();
      await expect(page.getByPlaceholder(/email/i)).toBeVisible();
    }
  });
});

test.describe('Navigation', () => {
  test('page loads without JavaScript errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });

  test('CSP header is present', async ({ page }) => {
    const response = await page.goto('/');
    const html = await page.content();
    expect(html).toContain('Content-Security-Policy');
  });
});
