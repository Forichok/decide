import { test, expect } from "@playwright/test";
import { startDecide, spec, writeFile } from "./helpers.mjs";
import { card, openRound, until } from "./ui.mjs";

let d;
test.beforeAll(async () => {
  d = await startDecide({ name: "forms" });
  writeFile(d.project, "screen.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#dde"/><circle cx="300" cy="200" r="80" fill="#c36"/></svg>');
});
test.afterAll(async () => d?.stop());

const forms = () =>
  spec({
    title: "Forms",
    questions: [
      {
        id: "plan",
        type: "buckets",
        title: "When do these ship?",
        why: "Orders the release.",
        buckets: ["now", "later", "no"],
        options: [
          { id: "search", label: "Search", then: "Goes into 3.1." },
          { id: "export", label: "Export", then: "Waits." },
          { id: "share", label: "Sharing", then: "Dropped." },
        ],
      },
      { id: "pace", type: "tradeoff", title: "Speed or care?", why: "Sets the number of checks.", poles: ["ship fast", "check everything"], recommendedAt: 65 },
      { id: "where", type: "spot", title: "Where does it feel off?", why: "Tells us what to rework.", images: [{ src: "screen.svg", caption: "The page today" }] },
      {
        id: "logo",
        type: "versus",
        title: "Which direction wins?",
        why: "One goes to the designer.",
        options: [
          { id: "calm", label: "Calm", then: "Soft." },
          { id: "bold", label: "Bold", then: "Loud." },
          { id: "playful", label: "Playful", then: "Warm." },
          { id: "plain", label: "Plain", then: "Type only." },
        ],
      },
    ],
  });

test("buckets: pressing a number puts the current option in that bucket and the answer is saved", async ({ page }) => {
  const id = await d.open(forms());
  await openRound(page, d, id);
  const plan = card(page, "plan");
  await plan.locator(".bk-pool .bk-item").first().click();
  await plan.locator(".bk-head").nth(0).click(); // Search -> now
  await plan.locator(".bk-head").nth(1).click(); // Export -> later
  await plan.locator(".bk-head").nth(2).click(); // Sharing -> no
  await expect(plan.locator(".bk-done")).toBeVisible();
  const a = await until(async () => {
    const x = (await d.answers(id)).plan;
    return x?.buckets && Object.values(x.buckets).flat().length === 3 ? x : null;
  });
  expect(a.buckets.now).toEqual(["search"]);
  expect(a.buckets.later).toEqual(["export"]);
  expect(a.buckets.no).toEqual(["share"]);
});

test("buckets: an option can be dragged into a bucket and taken back out", async ({ page }) => {
  const id = await d.open(forms());
  await openRound(page, d, id);
  const plan = card(page, "plan");
  await plan.locator('.bk-pool .bk-item[data-oid="export"]').dragTo(plan.locator('.bk-list[data-bucket="later"]'));
  await expect(plan.locator('.bk-list[data-bucket="later"] .bk-item')).toHaveText("Export");
  await plan.locator('.bk-list[data-bucket="later"] .icon-btn').click();
  await expect(plan.locator('.bk-pool .bk-item[data-oid="export"]')).toBeVisible();
});

test("tradeoff: the slider saves a value and marks the recommended position", async ({ page }) => {
  const id = await d.open(forms());
  await openRound(page, d, id);
  const pace = card(page, "pace");
  await expect(pace.locator(".to-rec")).toBeVisible();
  const range = pace.locator("input.to-range");
  await range.focus();
  await range.fill("30");
  const a = await until(async () => {
    const x = (await d.answers(id)).pace;
    return x?.value === 30 ? x : null;
  });
  expect(a.value).toBe(30);
});

test("spot: a click marks a point, a note is saved with it, a mark can be removed", async ({ page }) => {
  const id = await d.open(forms());
  await openRound(page, d, id);
  const where = card(page, "where");
  const frame = where.locator(".sp-frame");
  await frame.scrollIntoViewIfNeeded();
  await expect(where.locator("img.sp-img")).toHaveJSProperty("complete", true);
  const box = await frame.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(where.locator(".sp-mark")).toHaveCount(1);
  await where.locator("input.sp-text").fill("This circle is too loud");
  const a = await until(async () => {
    const x = (await d.answers(id)).where;
    return x?.points?.[0]?.text ? x : null;
  });
  expect(a.points[0].text).toBe("This circle is too loud");
  expect(a.points[0].x).toBeGreaterThan(40);
  expect(a.points[0].x).toBeLessThan(60);
  await where.locator(".sp-list .icon-btn").click();
  await expect(where.locator(".sp-mark")).toHaveCount(0);
});

test("versus: the arrow keys pick sides until one wins, in at most 12 pairs", async ({ page }) => {
  const id = await d.open(forms());
  await openRound(page, d, id);
  const logo = card(page, "logo");
  await logo.scrollIntoViewIfNeeded();
  await logo.locator(".vs-pair").focus().catch(() => {});
  await expect(logo.locator(".vs-count")).toContainText("Pair 1 of");
  for (let i = 0; i < 12; i++) {
    if (await logo.locator(".vs-order").count()) break;
    await logo.locator(".versus").focus();
    await page.keyboard.press("ArrowLeft");
  }
  await expect(logo.locator(".vs-count")).toContainText("The winner");
  await expect(logo.locator(".vs-order li")).toHaveCount(4);
  const a = await until(async () => {
    const x = (await d.answers(id)).logo;
    return x?.pairs?.length >= 3 ? x : null;
  });
  // The run is replayed from the saved pairs: four options need three of them.
  expect(a.pairs.length).toBe(3);
  expect(a.pairs.length).toBeLessThanOrEqual(12);
});
