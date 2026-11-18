// A real round holds screenshots and recordings from a disposable preferences form.
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { test, expect } from "@playwright/test";
import { startDecide, writeFile } from "./helpers.mjs";

let daemon, spec;
test.beforeAll(async ({ browser }) => {
  daemon = await startDecide({ name: "visual" });
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: daemon.project, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const captures = {};
  for (const [side, label] of [["before", "Save"], ["after", "Save preferences"]]) {
    if (side === "after") git("switch", "-qc", "feature");
    const form = '<meta name="viewport" content="width=device-width"><h1>Preferences</h1><label><input type="checkbox"> Weekly updates</label><button>' + label + '</button><output></output><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved"</script>';
    writeFile(daemon.project, "settings.html", form);
    git("add", "settings.html");
    git("commit", "-qm", side);
    const context = await browser.newContext({ viewport: { width: 600, height: 560 }, recordVideo: { dir: daemon.project } });
    const scene = await context.newPage();
    await scene.setContent(form);
    await scene.getByRole("checkbox").check();
    await scene.getByRole("button").click();
    await expect(scene.locator("output")).toHaveText("Saved");
    await scene.screenshot({ path: join(daemon.project, side + ".png") });
    await scene.waitForTimeout(650); // capture the saved state on the recording
    const recording = scene.video();
    await context.close();
    captures[side] = { image: side + ".png", video: basename(await recording.path()), cue: side === "after" ? 0.2 : 0.1 };
  }
  spec = {
    title: "Preferences", lang: "en", summary: ["The save button names what it saves."],
    tasks: [{ id: "save", title: "Save email preferences", beforeText: "The button said Save.", afterText: "The button says Save preferences.",
      steps: ["Select weekly updates.", "Save preferences."], expected: "Saved appears beside the button.",
      evidence: [{ id: "desktop", label: "Email settings", viewport: "600 × 560", theme: "light", fixture: "subscriber", state: "saved", ...captures }] },
    { id: "history", title: "Open the history", beforeText: "History was unavailable.", afterText: "History opens.",
      steps: ["Open history."], expected: "A visit appears.", gap: "The historical environment is offline.", evidence: [] }]
  };
});
test.afterAll(async () => daemon?.stop());

async function open(page, input = spec) {
  const { id } = await daemon.must("POST", "/api/rounds", { mode: "visual", project: daemon.project, base: "main", head: "feature", open: false, specFile: writeFile(daemon.project, "round.json", JSON.stringify(input)), spec: input });
  await page.goto(daemon.origin + "/?lang=en#r=" + id);
  return id;
}

test("settings choose the initial layout for paired screenshots", async ({ page }) => {
  await open(page);
  const divider = page.getByRole("slider", { name: "Before and after divider" });
  await expect(page.getByRole("button", { name: "Side by side", exact: true })).toBeVisible();
  await expect(divider).toBeHidden();
  const settings = page.getByRole("button", { name: "Open settings", exact: true });
  const layout = page.getByRole("combobox", { name: "Default screenshot view" });
  const back = page.getByRole("button", { name: "Back", exact: true });
  await settings.click();
  await expect(layout).toHaveText("Side by side", { timeout: 2000 });
  await layout.click();
  await page.getByRole("option", { name: "Wipe", exact: true }).click();
  await back.click();
  await expect(divider).toBeVisible();
  await page.getByRole("button", { name: "Side by side", exact: true }).click();
  await expect(divider).toBeHidden();
  await page.reload();
  await expect(divider).toBeVisible();
  await settings.click();
  await expect(layout).toHaveText("Wipe");
  await layout.click();
  await page.getByRole("option", { name: "Side by side", exact: true }).click();
  await back.click();
  await expect(page.getByRole("button", { name: "Side by side", exact: true })).toBeVisible();
  await expect(divider).toBeHidden();
});

test("compare evidence, mark a region and a recording, and return the round", async ({ page }) => {
  const id = await open(page);
  await expect(page.getByRole("heading", { name: "Save email preferences" })).toBeVisible();
  await page.getByRole("combobox", { name: "Zoom", exact: true }).click();
  await page.getByRole("option", { name: "200%", exact: true }).click();
  const viewport = page.locator('[data-side="after"] .va-scroll').first();
  const center = el => [(el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, (el.scrollTop + el.clientHeight / 2) / el.scrollHeight];
  await viewport.evaluate(el => { el.scrollLeft = el.scrollWidth * .24; el.scrollTop = el.scrollHeight * .17; });
  const focus = await viewport.evaluate(center);
  await page.getByRole("button", { name: "Wipe", exact: true }).click();
  const wiped = await viewport.evaluate(center);
  expect(wiped[0]).toBeCloseTo(focus[0], 2);
  expect(wiped[1]).toBeCloseTo(focus[1], 2);
  const divider = page.getByRole("slider", { name: "Before and after divider" });
  await divider.press("ArrowRight");
  expect(Number(await divider.inputValue())).toBeGreaterThan(50);
  await page.getByRole("button", { name: "Side by side", exact: true }).click();
  await page.getByRole("combobox", { name: "Zoom", exact: true }).click();
  await page.getByRole("option", { name: "100%", exact: true }).click();
  await page.getByRole("button", { name: "Right here", exact: true }).click();
  const frame = page.locator('[data-side="after"] .va-plane').first();
  await frame.scrollIntoViewIfNeeded();
  const rect = await frame.boundingBox();
  await page.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .4);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * .6, rect.y + rect.height * .65);
  await page.mouse.up();
  await page.getByRole("textbox", { name: "Remark" }).fill("Move this button.");
  await page.getByRole("button", { name: "Save remark" }).click();
  await expect(page.getByText("Move this button.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Recording", exact: true }).click();
  const videos = page.locator(".va-side video");
  await expect.poll(() => videos.first().evaluate(v => v.currentTime)).toBeCloseTo(0, 2);
  await expect.poll(() => videos.nth(1).evaluate(v => v.currentTime)).toBeCloseTo(.1, 2);
  await page.getByRole("button", { name: "Play both" }).click();
  await page.getByRole("button", { name: "Pause both" }).click();
  const timeline = page.getByRole("slider", { name: "Shared timeline" });
  await timeline.press("Home");
  await timeline.press("ArrowRight");
  const time = await videos.first().evaluate(v => v.currentTime);
  await page.getByLabel("Align by action").uncheck();
  await expect.poll(() => videos.first().evaluate(v => v.currentTime)).toBeCloseTo(time, 2);
  await page.getByRole("button", { name: "Mark after frame" }).click();
  await page.getByRole("textbox", { name: "Remark" }).fill("Confirmation arrives here.");
  await page.getByRole("button", { name: "Save remark" }).click();
  await page.getByLabel("I checked this myself").first().check();
  await page.reload();
  await expect(page.getByLabel("I checked this myself").first()).toBeChecked();
  await expect(page.getByText("Move this button.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Return for changes" }).click();
  await expect(page.getByText("Returned for changes", { exact: true })).toBeVisible();
  await page.getByText("Revisit the evidence", { exact: true }).click();
  const receipt = page.locator(".va-completed");
  await expect(receipt.getByText("Move this button.", { exact: true })).toBeVisible();
  await expect(receipt.getByRole("button", { name: "Right here", exact: true })).toHaveCount(0);
  await expect(receipt.locator("img").first()).toBeVisible();
  const result = (await daemon.round(id)).result;
  expect(result.marks).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "Move this button.", side: "after", w: expect.any(Number), h: expect.any(Number) }),
    expect.objectContaining({ text: "Confirmation arrives here.", side: "after", time: expect.any(Number) })
  ]));
});

test("a phone reopens original marks alongside the author's response, then gives the final verdict", async ({ page }) => {
  const first = await open(page);
  const record = body => daemon.must("POST", "/api/rounds/" + first + "/visual", { op: "mark", task: "save", evidence: "desktop", side: "after", ...body });
  await record({ x: .2, y: .3, text: "Move the button." });
  const { visual } = await record({ time: .22, text: "Delay the confirmation." });
  await daemon.must("POST", "/api/rounds/" + first + "/submit", { verdict: "return", note: "Keep the form open." });
  const input = structuredClone(spec);
  input.tasks[0].evidence.push({ ...input.tasks[0].evidence[0], id: "saved", label: "Saved confirmation" });
  input.tasks.push({ id: "persist", title: "Reopen saved preferences", beforeText: "Reload lost the choice.", afterText: "Reload keeps it.",
    manualOnly: true, evidence: [], steps: ["Save and reload the form."], expected: "The checkbox stays selected." });
  input.previous = first;
  input.replies = visual.marks.map((m, i) => ({ ref: m.id, task: "save", evidence: "desktop",
    ...(i === 0 && { x: .4, y: .35 }), text: i === 0 ? "The button moved beside the field." : "The confirmation now waits for save." }));
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await open(page, input);
  await expect(page.getByText("Keep the form open.", { exact: false })).toBeVisible();
  const rechecks = page.locator(".va-recheck");
  await expect(rechecks).toHaveCount(2);
  await expect(rechecks.first().locator(".va-pin")).toHaveCount(2);
  await expect(rechecks.nth(1).locator("video")).toHaveCount(2);
  for (const clip of await rechecks.nth(1).locator("video").all()) {
    await expect.poll(() => clip.evaluate(v => v.currentTime)).toBeCloseTo(.22, 2);
  }
  const accept = page.getByRole("button", { name: "Accept changes" });
  await expect(accept).toBeDisabled();
  await page.getByRole("combobox", { name: "Capture", exact: true }).click();
  await page.getByRole("option", { name: /Saved confirmation/ }).click();
  await expect(page.getByRole("heading", { name: "Saved confirmation", exact: true })).toBeVisible();
  const topEdges = await page.locator(".va-evidence:visible .va-side .va-scroll").evaluateAll(panes => panes.map(p => p.getBoundingClientRect().top));
  expect(Math.abs(topEdges[0] - topEdges[1])).toBeLessThan(1);
  await expect(page.getByRole("heading", { name: "Email settings", exact: true })).toHaveCount(0);
  await rechecks.first().getByRole("button", { name: "Still open" }).click();
  await page.reload();
  await expect(page.locator(".va-recheck").first().getByRole("button", { name: "Still open" })).toHaveAttribute("aria-pressed", "true");
  for (const item of await page.locator(".va-recheck").all()) await item.getByRole("button", { name: "Fixed", exact: true }).click();
  await expect(accept).toBeDisabled();
  await page.getByRole("button", { name: "Request a capture" }).click();
  await expect(page.getByRole("button", { name: "Capture requested" })).toBeDisabled();
  const manual = page.locator('[data-task="persist"]');
  await expect(manual.getByRole("heading", { name: "Missing evidence" })).toHaveCount(0);
  await manual.getByLabel("I checked this myself").check();
  await page.getByLabel("I checked this myself").nth(1).check();
  await expect(accept).toBeEnabled();
  await page.getByLabel("I checked this myself").nth(1).uncheck();
  await expect(accept).toBeDisabled();
  await page.getByLabel("I accept this gap").check();
  await expect(accept).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await accept.click();
  await expect(page.getByRole("heading", { name: "Changes accepted" })).toBeVisible();
  const result = (await daemon.round(id)).result;
  expect(result.resolutions).toEqual(Object.fromEntries(visual.marks.map(m => [m.id, "fixed"])));
  expect(result.gaps.history).toBe(true);
  const summary = page.locator(".va-result");
  await expect(summary).toContainText("Move the button. · Fixed");
  await expect(summary).toContainText("Delay the confirmation. · Fixed");
});
