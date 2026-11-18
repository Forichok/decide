import { spawnSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { startDecide, writeFile, spec, pluginDir } from './helpers.mjs';
import path from 'node:path';
let d;
const review = { reviewers: { none: 'This fixture opens without agents.' }, previous: false, title: 'Comfort', summary: 'Two places.', chapters: [{ id: 'all', title: 'Code', summary: 'Read it.', hunks: ['a.mjs'] }] };
test.beforeAll(async () => {
  d = await startDecide({name: 'comfort'});
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {cwd: d.project, encoding: 'utf8'});
    if (r.status) throw Error(r.stderr);
  };
  git('init', '-b', 'main');
  const content = (changed) => Array.from({length: 60}, (_, i) => i === 3 ? `const animal = "${changed ? 'dog' : 'cat'}";` : i === 48 ? (changed ? 'entirely rewritten' : 'old text') : `// line ${i + 1}`).join('\n') + '\n';
  writeFile(d.project, 'a.mjs', content(false)); git('add', '.'); git('commit', '-m', 'base');
  git('checkout', '-b', 'feature'); writeFile(d.project, 'a.mjs', content(true)); git('add', '.'); git('commit', '-m', 'change');
});
test.afterAll(async () => d?.stop());
async function open(page) {
  const r = await d.must('POST', '/api/rounds', {project: d.project, mode: 'review', spec: review, open: false});
  await page.goto(r.url.replace("/#", "/?lang=en#"));
  await page.locator('.cr-full').click();
  await expect(page.locator('.cr-hunk')).toHaveCount(2);
  return r.id;
}
test('an owner can reopen a saved review link to read whole files', async ({page}) => {
  const r = await d.must('POST', '/api/rounds', {project: d.project, mode: 'review', spec: review, open: false});
  // A bookmark copied after the browser removed the owner credential.
  const bookmark = new URL('/?lang=en', d.origin);
  bookmark.hash = 'r=' + r.id;
  await page.goto(bookmark.href);
  const first = page.locator('.cr-hunk').first();
  await first.getByRole('button', {name: 'Whole file', exact: true}).click();
  await expect(first.locator('.cr-file-access')).toContainText(`open ${r.id}`);
  await expect(first.locator('tr.far')).toHaveCount(0);

  const opened = spawnSync(process.execPath, [path.join(pluginDir, 'decide.mjs'), 'open', r.id], {
    cwd: d.project, encoding: 'utf8',
    env: {...process.env, DECIDE_HOME: path.join(d.dir, 'dh'), DECIDE_PORT: String(d.port), DECIDE_NOTIFY: '0'},
  });
  expect(opened.status, opened.stderr).toBe(0);
  const link = opened.stdout.match(/https?:\/\/\S+/)[0];
  await page.goto(link.replace('/#', '/?lang=en#'));
  await expect.poll(() => new URL(page.url()).hash).toBe(`#r=${r.id}`);
  await page.reload();
  await first.getByRole('button', {name: 'Whole file', exact: true}).click();
  await expect(first.locator('tr.far').first()).toBeAttached();
});
test('whole-file neighbours share comments, ownership, coverage and digest', async ({page}) => {
  const id = await open(page);
  const first = page.locator('.cr-hunk').first(), second = page.locator('.cr-hunk').last();
  for (const host of [first, second]) await host.getByRole('button', {name: 'Whole file', exact: true}).click();
  const neighbour = first.locator('tr.cr-line[data-key="new:49"]');
  await neighbour.locator('td.t').click();
  await first.locator('.cr-compose textarea').fill('Check the replacement.');
  await first.locator('.cr-compose .btn.primary').click();
  for (const host of [first, second]) await expect(host.locator('.cr-cm-text')).toHaveText('Check the replacement.');
  const owner = await second.getAttribute('data-hunk');
  await expect.poll(async () => (await d.round(id)).review.comments[0]?.hunk).toBe(owner);
  await neighbour.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await d.round(id)).review.coverage[await second.getAttribute('data-hunk')]).toBe('opened');
  await page.locator('.cr-bar [data-verdict="return"]').click();
  await page.locator('.cr-verdict .btn.primary').click();
  await expect.poll(async () => (await d.round(id)).result?.digest ?? '').toContain('Check the replacement.'); // the verdict is saved after the click
});
test('intraline marks preserve row text and omit rewrites', async ({page}) => {
  await open(page);
  for (const [side, word] of [['old', 'cat'], ['new', 'dog']]) {
    const row = page.locator(`tr.cr-line[data-key="${side}:4"] td.t`);
    await expect(row).toHaveText(`const animal = "${word}";`);
    await expect(row.locator('.cr-intraline')).toHaveText(word);
  }
  await expect(page.locator('tr[data-key="new:49"] .cr-intraline')).toHaveCount(0);
});
test('review inbox folds, overlays without resizing code, remembers and leaves questions unchanged', async ({page}) => {
  await d.open(spec());
  for (const [width, theme] of [[1440, "light"], [1280, "dark"]]) {
    await page.setViewportSize({width, height: 900});
    await open(page);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const toggle = page.locator('.ib-review-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const code = page.locator('.cr-view');
    const before = await code.boundingBox();
    expect(before.width).toBeGreaterThan(width - 500);
    await toggle.focus(); await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await code.boundingBox()).width).toBe(before.width);
    await page.reload(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape'); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click(); await page.locator('.rail-scrim').click({position: {x: width - 10, y: 500}});
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }
  const q = await d.open(spec()); await page.goto(`${d.origin}/?lang=en#r=${q}`);
  await expect(page.locator('.ib-review-toggle')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/review-inbox/);
  await page.setViewportSize({width: 1440, height: 900});
  await expect(page.locator('.rail')).toBeVisible();
});

test('whole-file exposure counts a neighbouring hunk while its chapter stays folded', async ({page}) => {
  const spec = { ...review, chapters: [
    {id: 'first', title: 'First', summary: 'Read here.', hunks: ['a.mjs:1-10']},
    {id: 'last', title: 'Last', summary: 'Later.', hunks: ['a.mjs'], skim: 'Read only if needed.'},
  ] };
  const r = await d.must('POST', '/api/rounds', {project: d.project, mode: 'review', spec, open: false});
  await page.goto(r.url.replace("/#", "/?lang=en#"));
  const first = page.locator('#cr-ch-first .cr-hunk');
  await first.getByRole('button', {name: 'Whole file', exact: true}).click();
  const neighbour = first.locator('tr.cr-line.add[data-key="new:49"]');
  const owner = await neighbour.getAttribute('data-owner');
  await neighbour.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await d.round(r.id)).review.coverage[owner]).toBe('opened');
  await expect(page.locator('#cr-ch-last details.cr-others')).not.toHaveAttribute('open');
});


test('whole-file coverage waits until the neighbouring change enters the viewport', async ({page}) => {
  const spec = { ...review, chapters: [
    {id: 'first', title: 'First', summary: 'Read here.', hunks: ['a.mjs:1-10']},
    {id: 'last', title: 'Last', summary: 'Later.', hunks: ['a.mjs'], skim: 'Read only if needed.'},
  ] };
  const r = await d.must('POST', '/api/rounds', {project: d.project, mode: 'review', spec, open: false});
  await page.goto(r.url.replace("/#", "/?lang=en#"));
  const first = page.locator('#cr-ch-first .cr-hunk');
  await first.getByRole('button', {name: 'Whole file', exact: true}).click();
  const neighbour = first.locator('tr.cr-line.add[data-key="new:49"]');
  const owner = await neighbour.getAttribute('data-owner');
  expect(await neighbour.evaluate(el => el.getBoundingClientRect().top >= innerHeight)).toBe(true);
  // Let the coverage measurement and its debounced write finish before checking an absent owner.
  await page.waitForTimeout(350);
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="coverage"]')).toBeVisible();
  expect((await d.round(r.id)).review.coverage[owner]).toBeUndefined();
  await page.locator('.cr-verdict .btn').filter({hasText: /^Cancel$/}).click();
  await neighbour.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await d.round(r.id)).review.coverage[owner]).toBe('opened');
});

test('legacy omitted reviewer roles appear in overview and approval warnings', async ({page}) => {
  const r = await d.must('POST', '/api/rounds', {project: d.project, mode: 'review', spec: review, open: false});
  await page.route(`**/api/rounds/${r.id}`, async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.review.reviewers = {
      defaultRoles: data.review.reviewers.defaultRoles,
      ran: [{role: 'correctness', model: '', summary: 'Checked.', verdict: 'clean'}],
      skipped: [], findings: [],
      requirement: {required: true, mode: 'always', lines: 4, roles: [
        {id: 'correctness', title: 'correctness', brief: 'Check behavior.'}, {id: 'safety', title: 'safety', brief: 'Check security.'},
      ]},
    };
    await route.fulfill({response, json: data});
  });
  await page.goto(r.url.replace("/#", "/?lang=en#"));
  await expect(page.locator('.cr-reviewers')).toContainText('No result or reason for skipping');
  await page.locator('.cr-bar [data-verdict="approve"]').click();
  await expect(page.locator('[data-alert="reviewer-missing"]')).toContainText('safety');
});


function prepareLongChange() {
  writeFile(d.project, 'a.mjs', Array.from({length: 100}, (_, i) => `const value${i} = 1;`).join('\n') + '\n');
  for (const args of [['add', '.'], ['commit', '--allow-empty', '-m', 'long change']]) {
    const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {cwd: d.project, encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
  }
}

test('a fully unfolded long change stays partial until every changed row has been exposed', async ({page}) => {
  prepareLongChange();
  const spec = {...review, chapters: [{id: 'large', title: 'Long change', summary: 'Inspect all lines.', hunks: ['a.mjs']}]};
  const r = await d.must('POST', '/api/rounds', {project: d.project, mode: 'review', spec, open: false});
  await page.goto(r.url.replace("/#", "/?lang=en#"));
  const host = page.locator('#cr-ch-large .cr-hunk');
  await host.getByRole('button', {name: 'Whole file', exact: true}).click();
  const owner = await host.getAttribute('data-hunk');
  await expect.poll(async () => (await d.round(r.id)).review.coverage[owner]).toBe('part');
  const rows = host.locator('tr.cr-line.add, tr.cr-line.del');
  await expect(rows).toHaveCount(160);
  for (let i = 0; i < await rows.count(); i += 8) {
    await rows.nth(i).evaluate(el => el.scrollIntoView({block: 'center', behavior: 'instant'}));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await rows.last().scrollIntoViewIfNeeded();
  await expect.poll(async () => (await d.round(r.id)).review.coverage[owner]).toBe('opened');
});


test('coverage combines exact exposure before and after reloading a long change', async ({page}) => {
  prepareLongChange();
  const spec = {...review, chapters: [{id: 'large', title: 'Long change', summary: 'Inspect all lines.', hunks: ['a.mjs']}]};
  const r = await d.must('POST', '/api/rounds', {project: d.project, mode: 'review', spec, open: false});
  await page.goto(r.url.replace('/#', '/?lang=en#'));
  async function visit(from, to) {
    const full = page.locator('.cr-full');
    if (await full.textContent() !== 'Fold back') await full.click();
    const rows = page.locator('#cr-ch-large tr.cr-line.add, #cr-ch-large tr.cr-line.del');
    await expect(rows).toHaveCount(160);
    for (let i = from; i <= to; i += 4) {
      await rows.nth(i).evaluate(el => el.scrollIntoView({block: 'center', behavior: 'instant'}));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  }
  await visit(0, 84);
  await expect.poll(async () => (await d.round(r.id)).review.coverage.h1).toBe('part');
  await page.reload();
  await visit(76, 156);
  await expect.poll(async () => (await d.round(r.id)).review.coverage.h1).toBe('opened');
});
