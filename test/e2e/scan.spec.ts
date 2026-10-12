import { expect, test } from '@playwright/test';
import { findings, issues, mockApi, report, snapshot } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
});

test('home submit, options, cache and report navigation', async ({ page }, info) => {
  let body: { repoUrl: string; ref?: string; force?: boolean } | undefined;
  await mockApi(page);
  await page.route('**/api/scans', async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(snapshot('completed', { cached: true })),
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Know what to fix first.' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('home-desktop.png'), fullPage: true });
  const heading = page.getByRole('heading', { name: 'Know what to fix first.' });
  const intro = page.getByText('Paste a public GitHub repository.');
  expect(
    await heading.evaluate((el) => parseFloat(getComputedStyle(el).marginTop)),
  ).toBeGreaterThan(20);
  expect(await intro.evaluate((el) => parseFloat(getComputedStyle(el).marginTop))).toBeGreaterThan(
    15,
  );
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('textbox', { name: 'Branch, tag or commit (optional)' }).fill('main');
  await page.getByRole('checkbox', { name: 'Scan again even if a cached report exists' }).check();
  await page
    .getByRole('textbox', { name: 'Public GitHub repository URL' })
    .fill('https://github.com/example/sample');
  await page.getByRole('button', { name: 'Scan repository' }).click();
  await expect(page).toHaveURL(/scan=scan-a/);
  expect(body).toMatchObject({
    repoUrl: 'https://github.com/example/sample',
    ref: 'main',
    force: true,
  });
  await expect(page.getByRole('heading', { name: /Critical risk/ })).toBeVisible();
  await expect(page.getByText('Cached report')).toBeVisible();
  await page.screenshot({ path: info.outputPath('fix-desktop.png'), fullPage: true });
  await page.getByRole('tab', { name: /Coverage/ }).click();
  await expect(page.getByText('pnpm-lock.yaml')).toBeVisible();
  await page.screenshot({ path: info.outputPath('coverage-desktop.png'), fullPage: true });
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await expect(page.getByText('Advisory title 0')).toBeVisible();
  await page.screenshot({ path: info.outputPath('evidence-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'New scan' }).click();
  await expect(page).not.toHaveURL(/scan=/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: /Critical risk/ })).toBeVisible();
});

test('full fixes, associated evidence, filters, copies and legacy', async ({ page, context }) => {
  await mockApi(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Do these in order' })).toBeVisible();
  await expect(page.getByRole('button', { name: /no known fix/i })).toBeVisible();
  await page.getByRole('button', { name: 'Copy all shell commands' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("npm --prefix 'apps/b'");
  expect(copied).not.toContain('overrides');
  await expect(page.getByText('AI-written explanation')).toBeVisible();
  await page.getByRole('button', { name: /View 2 associated findings/ }).click();
  await expect(page.getByRole('button', { name: /Clear issue filter/ })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(3);
  await page.getByRole('button', { name: /Clear issue filter/ }).click();
  await expect(page.getByRole('row')).toHaveCount(9);
  await page.getByRole('tab', { name: /Fix plan/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Evidence/ })).toBeFocused();
});

test('failure, cancellation, rescan and clean partial states', async ({ page }, info) => {
  await mockApi(page, snapshot('failed'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Scan failed' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('error-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Retry scan' }).click();
  await expect(page).toHaveURL(/scan=scan-a/);
  await mockApi(
    page,
    snapshot('completed', {
      report: {
        ...report,
        verdict: {
          riskLevel: 'clean',
          headline: 'Clean risk: no known findings',
          summary: 'No known findings in scanned npm lockfiles.',
        },
        topIssues: [],
        actionPlan: [],
        issueCount: 0,
        stats: {
          packages: 1,
          lockfiles: 1,
          prod: 0,
          dev: 0,
          direct: 0,
          transitive: 0,
          severity: { critical: 0, high: 0, medium: 0, low: 0 },
        },
      },
    }),
    [],
    [],
  );
  await page.reload();
  await expect(page.getByText('No known vulnerabilities found in scanned lockfiles')).toBeVisible();
  await expect(page.getByText(/Partial coverage: KEV unavailable/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('clean-desktop.png'), fullPage: true });
  await mockApi(page, snapshot('queued'));
  await page.reload();
  await expect(page.getByText('Queue position: 1')).toBeVisible();
  await page.screenshot({ path: info.outputPath('scanning-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: /Cancel scan/ }).click();
  await expect(page.getByRole('heading', { name: 'Scan cancelled' })).toBeVisible();
});

test('mobile report, command and evidence have no document overflow', async ({ page }, info) => {
  await mockApi(page);
  for (const width of [390, 320, 900, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: /Critical risk/ })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Upgrade package 0 in two projects/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width <= 390)
      await page.screenshot({ path: info.outputPath(`report-${width}.png`), fullPage: true });
    await page.getByRole('tab', { name: /Evidence/ }).click();
    await expect(page.getByText('Advisory title 0')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (width === 390)
      await page.screenshot({ path: info.outputPath('home-mobile.png'), fullPage: true });
  }
  await mockApi(page, snapshot('queued'));
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Queue position: 1')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('scanning-mobile.png'), fullPage: true });
});

test('filters paginate from API; override is a snippet; clipboard rejection keeps text', async ({
  page,
}) => {
  const many = [...findings, ...findings.slice(0, 5).map((f, i) => ({ ...f, id: `extra-${i}` }))];
  await mockApi(page, snapshot(), issues, many);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
  });
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Copy all shell commands' }).click();
  await expect(page.getByText('Could not copy. Select the text manually.')).toBeVisible();
  await page.getByRole('button', { name: 'Upgrade package 6', exact: false }).click();
  await expect(page.getByText('apps/a/package.json')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Copy override snippet for apps/a' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await expect(page.getByText('Showing 1–10 of 13')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Showing 11–13 of 13')).toBeVisible();
  await page
    .getByRole('group', { name: 'Severity' })
    .getByRole('button', { name: /critical/i })
    .click();
  await expect(page.getByText('Showing 1–2 of 2')).toBeVisible();
});

test('direct failure, retry and rescan force', async ({ page }) => {
  await mockApi(page);
  let unavailable = true;
  await page.route('**/api/scans/scan-a', (route) => {
    if (unavailable) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'Scan not found', retryable: false },
        }),
      });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot()) });
  });
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Scan unavailable' })).toBeVisible();
  unavailable = false;
  await page.getByRole('button', { name: 'Retry loading scan' }).click();
  await expect(page.getByRole('heading', { name: /Critical risk/ })).toBeVisible();
  let request: { repoUrl: string; ref?: string; force?: boolean } | undefined;
  await page.route('**/api/scans', (route) => {
    request = route.request().postDataJSON();
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(snapshot('queued')),
    });
  });
  await page.getByRole('button', { name: 'Rescan' }).click();
  expect(request).toMatchObject({
    repoUrl: 'https://github.com/example/sample',
    ref: 'main',
    force: true,
  });
  await page.getByRole('button', { name: 'New scan' }).click();
  await expect(page.getByRole('heading', { name: 'Know what to fix first.' })).toBeVisible();
});

test('an obsolete snapshot cannot replace the screen after navigation', async ({ page }) => {
  await mockApi(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/scans/scan-a', async (route) => {
    await gate;
    try {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot()) });
    } catch {
      /* navigation aborted the request */
    }
  });
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Loading scan…')).toBeVisible();
  await page.getByRole('button', { name: 'New scan' }).click();
  release();
  await expect(page.getByRole('heading', { name: 'Know what to fix first.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Critical risk/ })).toHaveCount(0);
});

test('SSE updates a queued scan to its completed report', async ({ page }) => {
  await mockApi(page, snapshot('queued'));
  let reads = 0;
  await page.route('**/api/scans/scan-a', (route) => {
    reads++;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(reads === 1 ? snapshot('queued') : snapshot('completed')),
    });
  });
  await page.route('**/api/scans/*/events', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `id: 2\nevent: progress\ndata: ${JSON.stringify({ seq: 2, at: '2026-01-01T00:01:00Z', stage: 'scan_dependencies', level: 'info', message: 'Matched packages' })}\n\nevent: end\ndata: {}\n\n`,
    }),
  );
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Critical risk/ })).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
});

test('legacy command report and no supported lockfile remain distinct', async ({ page }) => {
  const legacy = { ...issues[0], project: undefined };
  const oldReport = {
    ...report,
    topIssues: [legacy],
    issueCount: 1,
    actionPlan: [
      {
        order: 1,
        issueId: legacy.id,
        action: 'Upgrade legacy package',
        command: 'npm install package-0@2.0.0',
        effort: 'low' as const,
        resolves: 1,
      },
    ],
    stats: {
      packages: 1,
      lockfiles: 1,
      prod: 1,
      dev: 0,
      direct: 0,
      transitive: 1,
      severity: { critical: 0, high: 1, medium: 0, low: 0 },
    },
    provenance: { ...report.provenance, kevCatalogAt: undefined },
  };
  await mockApi(page, snapshot('completed', { report: oldReport }), [legacy], [findings[0]]);
  await page.goto('/?scan=scan-a', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /Upgrade legacy package/ })).toBeVisible();
  await expect(page.getByText('npm install package-0@2.0.0')).toBeVisible();
  await page.getByRole('tab', { name: /Coverage/ }).click();
  await expect(page.getByText('Not recorded', { exact: true })).toBeVisible();
  const noLock = {
    ...report,
    issueCount: 0,
    actionPlan: [],
    topIssues: [],
    verdict: { riskLevel: 'clean', headline: 'Clean risk: 0 fixes', summary: '0 findings' },
    coverage: { scanned: [], notScanned: [{ what: 'yarn.lock', why: 'Not supported' }] },
  };
  await mockApi(page, snapshot('completed', { report: noLock }), [], []);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'No supported npm lockfile was scanned', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Coverage unavailable')).toBeVisible();
  await expect(page.getByText('No known vulnerabilities found in scanned lockfiles')).toHaveCount(
    0,
  );
});
