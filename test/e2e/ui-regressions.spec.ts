import { expect, test } from '@playwright/test';
import { findings, issues, mockApi, report, snapshot } from './fixtures.js';
import { shellCommands } from '../../web/src/features/scans/utils/report-selectors.js';

test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
});

test('desktop spacing, severity tabs and compact evidence filters', async ({ page }) => {
  await mockApi(page);
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const heading = page.getByRole('heading', { name: 'Know what to fix first.' });
    expect(
      await heading.evaluate((el) => parseFloat(getComputedStyle(el).marginTop)),
    ).toBeGreaterThan(20);
    expect(
      await page
        .getByText('Paste a public GitHub repository.')
        .evaluate((el) => parseFloat(getComputedStyle(el).marginTop)),
    ).toBeGreaterThan(15);
    await expect(page.getByRole('textbox', { name: 'Public GitHub repository URL' })).toBeVisible();
    await page.goto('/?scan=scan-a');
    await expect(page.getByRole('heading', { name: /Critical risk/ })).toBeVisible();
    expect(
      await page
        .getByText(report.verdict.summary)
        .evaluate((el) => parseFloat(getComputedStyle(el).marginTop)),
    ).toBeGreaterThan(10);
    await page.getByRole('tab', { name: /Evidence/ }).click();
    await expect(page.getByRole('row')).toHaveCount(9);
    const filters = page.getByRole('group', { name: 'Severity' });
    const scope = page.getByRole('combobox', { name: 'Scope' });
    const dependency = page.getByRole('combobox', { name: 'Dependency' });
    const boxes = await Promise.all([filters, scope, dependency].map((el) => el.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    expect(Math.max(...boxes.map((b) => b!.y)) - Math.min(...boxes.map((b) => b!.y))).toBeLessThan(
      55,
    );
    expect(boxes[1]!.width).toBeLessThan(190);
    expect(boxes[2]!.width).toBeLessThan(190);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test('grouped manual fixes show every project, highest severity and zero EPSS', async ({
  page,
}) => {
  const grouped = [
    {
      ...issues[7],
      id: 'unfixed-a',
      findings: [
        { ...findings[7], id: 'low', severity: 'low' as const, exploit: { kev: false, epss: 0 } },
      ],
      project: { dir: 'apps/a', lockfile: 'apps/a/package-lock.json', workspaces: ['apps/a'] },
    },
    {
      ...issues[7],
      id: 'unfixed-b',
      findings: [{ ...findings[0], id: 'critical', severity: 'critical' as const }],
      project: { dir: 'apps/b', lockfile: 'apps/b/package-lock.json', workspaces: ['apps/b'] },
    },
  ];
  await mockApi(
    page,
    snapshot('completed', {
      report: { ...report, actionPlan: [], topIssues: grouped, issueCount: 2 },
    }),
    grouped,
  );
  await page.goto('/?scan=scan-a');
  await expect(page.getByRole('heading', { name: 'Do these in order' })).toBeVisible();
  await expect(page.getByRole('button', { name: /no known fix/i })).toHaveCount(1);
  await expect(page.getByText('apps/a/package-lock.json')).toBeVisible();
  await expect(page.getByText('apps/b/package-lock.json')).toBeVisible();
  await expect(page.getByText('Workspaces: apps/b')).toBeVisible();
  await expect(page.getByText('critical', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('EPSS 20%')).toBeVisible();
  await expect(
    page.getByText('No command available. Follow the fix guidance above manually.'),
  ).toHaveCount(2);
  await mockApi(
    page,
    snapshot('completed', { report: { ...report, actionPlan: [], issueCount: 2 } }),
    grouped.map((item) => ({
      ...item,
      findings: item.findings.map((f) => ({ ...f, exploit: { kev: false, epss: 0 } })),
    })),
  );
  await page.reload();
  await expect(page.getByText('EPSS 0%')).toBeVisible();
});

test('long repository identity and command stay contained at 320 and 390 pixels', async ({
  page,
}) => {
  const owner = 'a'.repeat(39);
  const repo = 'b'.repeat(100);
  const ref = `feature/${'c'.repeat(110)}`;
  const command = `npm --prefix apps/${'x'.repeat(140)} install ${'long-package'.repeat(12)}@2.0.0`;
  const long = snapshot('running', { owner, repo, ref, stage: 'scan_dependencies' });
  await mockApi(page, long);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?scan=scan-a');
    await expect(
      page.getByRole('heading', { name: 'Match packages to advisories', level: 1 }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
  const longIssue = {
    ...issues[0],
    project: {
      dir: `apps/${'x'.repeat(140)}`,
      lockfile: `apps/${'x'.repeat(140)}/package-lock.json`,
      workspaces: [],
    },
  };
  await mockApi(
    page,
    snapshot('completed', {
      owner,
      repo,
      ref,
      report: {
        ...report,
        actionPlan: [
          {
            order: 1,
            issueIds: ['issue-0'],
            action: 'Upgrade',
            kind: 'upgrade_direct',
            effort: 'low',
            resolves: 1,
            locations: [
              {
                issueId: 'issue-0',
                dir: longIssue.project.dir,
                lockfile: longIssue.project.lockfile,
                resolves: 1,
                command,
              },
            ],
          },
        ],
      },
    }),
    [longIssue],
  );
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?scan=scan-a');
    const copy = page.getByRole('button', { name: `Copy command for apps/${'x'.repeat(140)}` });
    await expect(copy).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await expect(copy).toHaveAttribute('aria-label', /Copy command/);
    const code = page.locator('pre').first();
    expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(Math.abs((await code.boundingBox())!.y - (await copy.boundingBox())!.y)).toBeLessThan(
      30,
    );
  }
});

test('copy controls show scope, keep dimensions, reset, and expose selectable fallback', async ({
  page,
  context,
}) => {
  await mockApi(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.install();
  await page.goto('/?scan=scan-a');
  const link = page.getByRole('button', { name: 'Copy report link' });
  await expect(link.getByText('Copy link').last()).toBeVisible();
  await expect(
    page
      .getByRole('button', { name: 'Copy all shell commands' })
      .getByText('Copy all commands')
      .last(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy command for apps\/a/ }).last()).toBeVisible();
  const before = await link.boundingBox();
  await link.click();
  await expect(link.getByText('Copied').last()).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
  const after = await link.boundingBox();
  expect(after?.width).toBe(before?.width);
  expect(after?.height).toBe(before?.height);
  await page.clock.runFor(1600);
  await expect(link.getByText('Copy link').last()).toBeVisible();
  await page.getByRole('button', { name: 'Copy all shell commands' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    report.actionPlan.flatMap((action) => shellCommands(action, issues)).join('\n'),
  );
  const commandCopy = page.getByRole('button', { name: 'Copy command for apps/a' });
  await commandCopy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    report.actionPlan[0].locations![0].command,
  );
  expect(await commandCopy.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(Error('denied')) },
    }),
  );
  await page.reload();
  await link.click();
  await expect(
    page.getByRole('alert').getByText('Could not copy. Select the text manually.'),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Select copy report link text' })).toHaveValue(
    page.url(),
  );
});

test('cancellation acknowledgement stays running until confirmed, and errors allow retry', async ({
  page,
}) => {
  await mockApi(page, snapshot('running', { stage: 'fetch' }));
  let live = snapshot('running', { stage: 'fetch' });
  await page.route('**/api/scans/scan-a', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(live) }),
  );
  let cancels = 0;
  await page.route('**/api/scans/scan-a/cancel', (route) => {
    cancels++;
    return route.fulfill({
      status: cancels === 1 ? 500 : 202,
      contentType: 'application/json',
      body: JSON.stringify(
        cancels === 1
          ? { error: { code: 'FAILED', message: 'Cancel unavailable' } }
          : { id: 'scan-a', status: 'cancellation_requested' },
      ),
    });
  });
  await page.goto('/?scan=scan-a');
  await page.getByRole('button', { name: /Cancel scan/ }).click();
  await expect(page.getByText('Cancel unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: /Cancel scan/ })).toBeEnabled();
  await page.getByRole('button', { name: /Cancel scan/ }).click();
  await expect(page.getByRole('button', { name: /Cancellation requested/ })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Scan cancelled' })).toHaveCount(0);
  expect(cancels).toBe(2);
  live = snapshot('cancelled');
  await expect(page.getByRole('heading', { name: 'Scan cancelled' })).toBeVisible();
});

test('failed rescan retains attempted URL, ref and force for a corrected retry', async ({
  page,
}) => {
  await mockApi(page);
  let fail = true;
  let submitted: { repoUrl: string; ref: string; force: boolean } | undefined;
  await page.route('**/api/scans', (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: fail ? 503 : 202,
      contentType: 'application/json',
      body: JSON.stringify(
        fail ? { error: { code: 'UNAVAILABLE', message: 'Try again' } } : snapshot('queued'),
      ),
    });
  });
  await page.goto('/?scan=scan-a');
  await page.getByRole('button', { name: 'Rescan' }).click();
  await expect(page.getByText('Try again', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Public GitHub repository URL' })).toHaveValue(
    'https://github.com/example/sample',
  );
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByRole('textbox', { name: 'Branch, tag or commit (optional)' })).toHaveValue(
    'main',
  );
  await expect(
    page.getByRole('checkbox', { name: 'Scan again even if a cached report exists' }),
  ).toBeChecked();
  await page
    .getByRole('textbox', { name: 'Public GitHub repository URL' })
    .fill('https://github.com/OWASP/NodeGoat');
  fail = false;
  await page.getByRole('button', { name: 'Scan repository' }).click();
  expect(submitted).toMatchObject({
    repoUrl: 'https://github.com/OWASP/NodeGoat',
    ref: 'main',
    force: true,
  });
  await expect(page).toHaveURL(/scan=scan-a/);
});

test('Options stay reachable and submit by keyboard at every viewport', async ({ page }, info) => {
  await mockApi(page);
  let submitted: { repoUrl: string; ref: string; force: boolean } | undefined;
  await page.route('**/api/scans', (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(snapshot('queued')),
    });
  });
  for (const width of [320, 390, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Options' }).click();
    const ref = page.getByRole('textbox', { name: 'Branch, tag or commit (optional)' });
    const force = page.getByRole('checkbox', { name: 'Scan again even if a cached report exists' });
    const panel = ref.locator('xpath=../..');
    for (const control of [
      panel,
      ref,
      force,
      page.getByText('Scan again even if a cached report exists'),
    ]) {
      const box = await control.boundingBox();
      expect(box, `control at ${width}px`).not.toBeNull();
      expect(box!.x, `left at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `right at ${width}px`).toBeLessThanOrEqual(width);
    }
    if (width === 320)
      await page.screenshot({ path: info.outputPath('options-320.png'), fullPage: true });
    await page
      .getByRole('textbox', { name: 'Public GitHub repository URL' })
      .fill('https://github.com/example/sample');
    await ref.fill('feature/fix');
    await force.check();
    await ref.press('Enter');
    await expect(page).toHaveURL(/scan=scan-a/);
    expect(submitted).toMatchObject({
      repoUrl: 'https://github.com/example/sample',
      ref: 'feature/fix',
      force: true,
    });
  }
});

test('mobile tabs fit without scrolling and remain keyboard reachable', async ({ page }) => {
  await mockApi(page);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?scan=scan-a');
    const tabs = ['Fix plan', 'Evidence', 'Coverage'].map((name) =>
      page.getByRole('tab', { name: new RegExp(name) }),
    );
    for (const tab of tabs) {
      const box = await tab.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    expect(
      await page
        .getByRole('tablist', { name: 'Report sections' })
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await tabs[0].focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs[1]).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tabs[2]).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: "What was, and wasn't, scanned" }),
    ).toBeVisible();
    await expect(tabs[2]).toHaveAccessibleName(/Coverage.*1 gap/);
  }
});

test('legacy and partial severity totals never invent finding counts; risk bars use level color', async ({
  page,
}) => {
  const legacy = {
    ...report,
    issueCount: 2,
    stats: { packages: 18 },
    verdict: { ...report.verdict, riskLevel: 'low', headline: 'Low risk: review these fixes' },
  };
  await mockApi(page, snapshot('completed', { report: legacy }), issues.slice(0, 2));
  await page.goto('/?scan=scan-a');
  const evidence = page.getByRole('tab', { name: /Evidence/ });
  await expect(evidence).toHaveText('Evidence');
  const riskBar = page
    .getByRole('heading', { name: /Low risk/ })
    .locator('xpath=preceding-sibling::div[1]/span[1]/span[4]');
  expect(await riskBar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(108, 124, 147)',
  );
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await expect(page.getByRole('heading', { name: 'All findings · 8' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'All', exact: true }),
  ).toBeVisible();
  await mockApi(
    page,
    snapshot('completed', { report: { ...legacy, stats: { severity: { critical: 0, low: 2 } } } }),
    issues.slice(0, 2),
  );
  await page.reload();
  await expect(page.getByRole('tab', { name: /Evidence/ })).toHaveText('Evidence');
  await expect(page.getByText('Severity distribution incomplete.')).toBeVisible();
  await expect(page.getByText('critical: 0')).toBeVisible();
  await expect(page.getByText('high: —')).toBeVisible();
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await expect(
    page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'All', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'critical 0' }),
  ).toBeVisible();
  await mockApi(
    page,
    snapshot('completed', {
      report: {
        ...legacy,
        stats: { severity: { critical: 0, high: 0, medium: 0, low: 0 } },
        verdict: { riskLevel: 'clean', headline: 'No known findings', summary: 'None recorded' },
      },
    }),
    [],
    [],
  );
  await page.reload();
  await expect(page.getByRole('tab', { name: /Evidence/ })).toContainText('0');
  await page.getByRole('tab', { name: /Evidence/ }).click();
  await expect(
    page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'All 0' }),
  ).toBeVisible();
});

test('override snippet copies verbatim; denied mobile command keeps code and fallback readable', async ({
  page,
  context,
}) => {
  await mockApi(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?scan=scan-a');
  await page.getByRole('button', { name: /Upgrade package 6/ }).click();
  const snippet = page.getByRole('button', { name: 'Copy override snippet for apps/a' });
  await expect(snippet.getByText('Copy snippet').last()).toBeVisible();
  await snippet.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '{"overrides":{"package-6":"2.0.0"}}',
  );
  await page.getByRole('button', { name: 'Copy all shell commands' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('overrides');
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(Error('denied')) },
    }),
  );
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/?scan=scan-a');
    const copy = page.getByRole('button', { name: 'Copy command for apps/a' });
    const card = copy.locator('xpath=../..');
    const code = card.locator('pre');
    const before = await code.boundingBox();
    await copy.click();
    const alert = card.getByRole('alert');
    const textarea = card.getByRole('textbox', { name: 'Select copy command for apps/a text' });
    await expect(alert).toBeVisible();
    await expect(textarea).toHaveValue(report.actionPlan[0].locations![0].command!);
    await expect(code).toContainText(report.actionPlan[0].locations![0].command!);
    await expect(copy).toBeVisible();
    expect(await copy.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(20, 36, 59)',
    );
    expect(await copy.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
    const after = await code.boundingBox();
    expect(after!.width).toBeGreaterThanOrEqual(before!.width - 1);
    expect(after!.width).toBeGreaterThan(80);
    const cardBox = (await card.boundingBox())!;
    for (const el of [alert, textarea]) {
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(Math.min(cardBox.x + cardBox.width, width));
    }
    expect(await alert.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(232, 238, 248)');
    expect((await alert.boundingBox())!.y).toBeGreaterThan((await code.boundingBox())!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test('severity filtering supports keyboard selection and retains one active filter', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/?scan=scan-a');
  await page.getByRole('tab', { name: /Evidence/ }).click();
  const filters = page.getByRole('group', { name: 'Severity' });
  const all = filters.getByRole('button', { name: /^All/ });
  const critical = filters.getByRole('button', { name: /^critical/i });
  const high = filters.getByRole('button', { name: /^high/i });
  await expect(page.getByText('Showing 1–8 of 8')).toBeVisible();
  await all.focus();
  await all.press('ArrowRight');
  await expect(critical).toBeFocused();
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await critical.press('Space');
  await expect(critical).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Showing 1–1 of 1')).toBeVisible();
  await critical.press('Space');
  await expect(critical).toHaveAttribute('aria-pressed', 'true');
  await expect(filters.getByRole('button', { pressed: true })).toHaveCount(1);
  await expect(page.getByText('Showing 1–1 of 1')).toBeVisible();
  await critical.press('ArrowRight');
  await expect(high).toBeFocused();
  await high.press('Enter');
  await expect(high).toHaveAttribute('aria-pressed', 'true');
  await expect(filters.getByRole('button', { pressed: true })).toHaveCount(1);
  await expect(page.getByText('Showing 1–7 of 7')).toBeVisible();
});

test('scan progress exposes bounded completion and the home control remains keyboard accessible', async ({
  page,
}) => {
  for (const [value, expected] of [
    [-5, 0],
    [45, 45],
    [150, 100],
    [NaN, 0],
  ]) {
    await mockApi(page, snapshot('running', { stage: 'scan_dependencies', progress: value }));
    await page.goto('/?scan=scan-a');
    const progress = page.getByRole('progressbar', { name: 'Scan progress' });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuemin', '0');
    await expect(progress).toHaveAttribute('aria-valuemax', '100');
    await expect(progress).toHaveAttribute('aria-valuenow', String(expected));
    await expect(page.getByText(`${expected}%`, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Scan Review home' }).press('Enter');
  await expect(page).not.toHaveURL(/scan=/);
  await expect(page.getByRole('heading', { name: 'Know what to fix first.' })).toBeVisible();
});
