import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { startDecide, spec } from './helpers.mjs';

const swipeDeck = {
  title: 'E2E deck',
  goal: 'Pick features for the next release',
  cards: [
    { id: 'c1', title: 'Dark mode first?', left: { label: 'Light only' }, right: { label: 'Ship dark' }, then: 'The chosen theme ships first.' },
    { id: 'c2', title: 'Weekly digest?', left: { label: 'No digest' }, right: { label: 'Weekly' }, then: 'The weekly digest goes out on Mondays.' },
    { id: 'c3', title: 'Offline support?', left: { label: 'Online only' }, right: { label: 'Offline too' }, then: 'Offline edits sync when the connection returns.' },
  ],
};

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: 'thread' });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=decide-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: d.project, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(d.project, 'a.js'), 'old\n');
  git('add', 'a.js'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  writeFileSync(path.join(d.project, 'a.js'), 'new\n');
  git('add', 'a.js'); git('commit', '-qm', 'change');
});
test.afterAll(async () => d?.stop());
async function open(mode) {
  if (mode !== 'review') return d.open(mode === 'swipe' ? swipeDeck : spec(), { mode });
  return (await d.must('POST', '/api/rounds', { project: d.project, mode, open: false, spec: {
    title: 'Thread review', summary: 'One line.', chapters: [{ id: 'line', title: 'Line', summary: 'New word.', hunks: ['a.js'] }],
  } })).id;
}

for (const mode of ['questions', 'swipe', 'review']) for (const [theme, width] of [['light', 1440], ['dark', 1100]]) {
  test(`${mode}: round conversation in ${theme} at ${width}`, async ({ page }) => {
    const id = await open(mode);
    const idle = d.must('GET', `/api/rounds/${id}/next?timeout=30000&waiter=not-live`);
    await expect.poll(async () => (await d.must('GET', `/api/rounds/${id}/thread`)).listening).toBe(false);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem('decide-theme', theme), theme);
    await page.goto(`${d.origin}/?lang=en#r=${id}`);
    const button = page.getByRole('button', { name: 'Write to the agent', exact: true });
    await expect(button).toBeVisible();
    await button.click();
    const panel = page.getByRole('dialog', { name: 'The conversation' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('The agent is not listening now. Your message is saved and it gets it when it comes back.');
    await expect.poll(() => panel.evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0)).toBe(true);
    const input = panel.getByRole('textbox', { name: 'Message to the agent' });
    await expect(input).toBeFocused();
    await expect(panel.getByRole('textbox')).toHaveCount(1);
    await input.fill('Rewrite the summary');
    await input.press('Shift+Enter');
    await input.press('End');
    await input.type('with fewer words');
    await input.press('Enter');
    await expect(panel.locator('.round-thread-status')).toHaveText('Saved and waiting');
    const item = await d.next(id);
    await idle;
    expect(item.kind).toBe('message');
    expect(item.payload.message.text).toBe('Rewrite the summary\nwith fewer words');
    await expect.poll(() => panel.locator('[data-from="user"] .msg-who').evaluate(el => el.firstChild.textContent)).toBe('You');
    await d.ack(id, item.seq);
    await expect(panel.locator('.round-thread-status')).toHaveText('Delivered to the agent');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    const extra = { askId: item.payload.message.id, text: mode === 'review' ? 'Changed the working tree. It will be in the next review round.' : '**Summary rewritten.**', code: 'const changed = true;', choice: { text: 'Where should we settle the doubt?', options: ['Here in the dialog', 'As a card'] } };
    const before = mode === 'review' ? (await d.round(id)).review.snapshot : null;
    await d.must('POST', `/api/rounds/${id}/explain`, extra);
    await expect(page.locator('.round-thread-button')).toHaveClass(/unread/);
    await page.reload();
    const unread = page.getByRole('button', { name: 'Write to the agent · unread reply' });
    await expect(unread).toBeVisible();
    await unread.click();
    await expect(panel.locator('.round-thread-status')).toHaveText('Answered');
    await expect(panel.locator('.code')).toContainText('const changed = true;');
    const option = panel.getByRole('button', { name: 'As a card', exact: true });
    await expect.poll(() => option.evaluate(el => getComputedStyle(el).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');
    await option.click();
    await expect(panel.getByRole('button', { name: 'Chosen: As a card' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('[data-from="user"] .msg-text').last()).toHaveText('You picked: “As a card”');
    const pick = await d.next(id);
    expect(pick.kind).toBe('message');
    expect(pick.payload.message.text).toContain('user picked «As a card»');
    await expect(page.locator('.round-thread-button')).not.toHaveClass(/unread/);
    if (before) expect((await d.round(id)).review.snapshot).toEqual(before);
    await page.screenshot({ path: test.info().outputPath(`${mode}-${theme}-${width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await page.reload();
    await page.locator('.round-thread-button').click();
    await expect(panel.getByRole('button', { name: 'Chosen: As a card' })).toBeVisible();
    await expect(panel.locator('[data-from="user"] .msg-text').last()).toHaveText('You picked: “As a card”');
  });
}

test('a held waiter without live events is shown as not listening; the draft survives closing', async ({ page }) => {
  const id = await open('questions');
  const waiter = d.must('GET', `/api/rounds/${id}/next?timeout=30000&waiter=no-events`);
  await page.goto(`${d.origin}/?lang=en#r=${id}`);
  await page.locator('.round-thread-button').click();
  const panel = page.getByRole('dialog', { name: 'The conversation' });
  await expect(panel).toContainText('The agent is not listening now.');
  await panel.getByRole('textbox').fill('Keep my draft');
  await page.keyboard.press('Escape');
  await page.locator('.round-thread-button').click();
  await expect(panel.getByRole('textbox')).toHaveValue('Keep my draft');
  await d.next(id, { timeout: 1000 });
  await waiter;
});

test('an exported offline page has no write-to-agent button', async ({ page }) => {
  const id = await open('questions');
  const { file } = await d.must('POST', `/api/rounds/${id}/export`, { out: path.join(d.project, 'thread-offline.decide.html') });
  await page.goto('file://' + file);
  await expect(page.locator('h1.title')).toHaveText('E2E round');
  await expect(page.locator('.round-thread-button')).toHaveCount(0);
});

test('the conversation control fits a phone without side scrolling', async ({ page }) => {
  const id = await open('swipe');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${d.origin}/?lang=ru#r=${id}`);
  const button = page.getByRole('button', { name: 'Написать агенту', exact: true });
  await expect(button).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await button.click();
  const panel = page.getByRole('dialog', { name: 'Переписка' });
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.evaluate(el => el.getBoundingClientRect().right <= innerWidth && el.getBoundingClientRect().left >= 0)).toBe(true);
  await d.must('POST', `/api/rounds/${id}/explain`, {
    text: 'Можно обсудить здесь.',
    choice: { text: 'Где решим про доску и список?', options: ['Здесь', 'Отдельным вопросом'] },
  });
  await panel.getByRole('button', { name: 'Отдельным вопросом', exact: true }).click();
  const pick = panel.locator('[data-from="user"]');
  await expect.poll(() => pick.locator('.msg-who').evaluate(el => el.firstChild.textContent)).toBe('Вы');
  await expect(pick.locator('.msg-text')).toHaveText('Вы выбрали: «Отдельным вопросом»');
});
