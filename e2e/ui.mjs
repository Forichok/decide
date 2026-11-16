// Locators and waits shared by the specs.

export const card = (page, qid) => page.locator(`#q-${qid}`);
export const opt = (page, qid, oid) => page.locator(`#q-${qid} .opt[data-oid="${oid}"]`);
export const saved = (page) => page.locator("#bar .bar-save");

export async function openRound(page, d, id) {
  await page.goto(d.url(id));
  await page.locator(".card").first().waitFor();
}

// Waits until the server holds an answer for the question; null when none arrives in time.
export async function serverAnswer(d, id, qid, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const a = (await d.answers(id))[qid];
    if (a !== undefined && a !== null) return a;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// Waits until a condition on the round, read from the server, holds.
export async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}
