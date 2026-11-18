import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { startDecide } from './helpers.mjs';

test('a deleted-file fix jumps to the old diff line and keeps the original side', async ({ page }, info) => {
  const d = await startDecide({ name: 'deleted-followup' });
  try {
    const git = (...args) => {
      const out = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', ...args], { cwd: d.project, encoding: 'utf8' });
      expect(out.status, out.stderr).toBe(0); return out.stdout.trim();
    };
    git('init', '-qb', 'main');
    writeFileSync(join(d.project, 'a.js'), 'old\n'); git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
    writeFileSync(join(d.project, 'a.js'), 'bad\n'); git('commit', '-qam', 'change');
    const spec = { reviewers: { none: 'This fixture has no independent reviewer.' }, chapters: [{ id: 'code', title: 'Code', hunks: ['a.js'] }] };
    const first = await d.must('POST', '/api/rounds', { mode: 'review', open: false, project: d.project, spec });
    await d.must('POST', `/api/rounds/${first.id}/comment`, { hunk: 'h1', side: 'old', line: 1, kind: 'fix', text: 'Remove this file.' });
    const returned = await d.must('POST', `/api/rounds/${first.id}/submit`, { verdict: 'return' });
    const ref = returned.result.comments[0].id;
    git('rm', 'a.js'); git('commit', '-qm', 'delete');
    const follow = await d.must('POST', '/api/rounds', { mode: 'review', open: false, project: d.project, spec: { ...spec, previous: first.id, resolved: [{ ref, how: 'fixed', at: 'a.js:1', note: 'Removed the file.' }] } });
    await page.goto(`${d.origin}/?lang=en#r=${follow.id}`);
    const row = page.locator(`#cr-resolutions [data-resolution="${ref}"]`);
    await expect(row).toContainText('line 1, removed');
    await row.getByRole('button', { name: 'Go to change' }).click();
    const mark = page.locator(`tr.cr-resolution-mark [data-resolution="${ref}"]`);
    await expect(mark).toBeInViewport();
    await expect(mark.locator('xpath=ancestor::tr/following-sibling::tr[1]')).toHaveAttribute('data-key', 'old:1');
    await mark.getByRole('button', { name: 'Accepted', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Accepted', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: info.outputPath('deleted-file-fix.png') });
  } finally { await d.stop(); }
});
