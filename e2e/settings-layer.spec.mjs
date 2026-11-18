// Wave 4: settings entry points, inheritance, reviewer editing and browser theme.
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { startDecide, spec, swipeSpec, writeFile } from "./helpers.mjs";

let d;
test.beforeAll(async () => { d = await startDecide({ name: "settings-layer" }); });
test.afterAll(async () => d?.stop());
const settings = (page) => page.getByRole("button", { name: "Open settings", exact: true });
const globalLevel = (page) => page.locator('[data-setting="level"][data-scope="global"]');
const projectLevel = (page) => page.locator('[data-setting="level"][data-scope="project"]');
const globalReviewers = (page) => page.locator('[data-setting="reviewers"][data-scope="global"]');
const read = () => d.must("GET", `/api/settings?project=${encodeURIComponent(d.project)}`);
const enter = async (page, id) => {
  await page.goto(`${d.origin}/?lang=en${id ? `#r=${id}` : ""}`);
  await settings(page).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
};
async function choose(control, value) {
  await control.click();
  await control.locator("..").locator(`[role=option][data-value="${value}"]`).click();
}
const scope = (page, name) => page.getByRole("group", { name: "Apply settings to" }).getByRole("button", { name, exact: true }).click();
const save = async (form) => {
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("Saved");
};

test("gear opens from the inbox, a questions round, swipe, journal and done; Back returns", async ({ page }) => {
  await enter(page);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(settings(page)).toBeVisible();
  await expect(page).not.toHaveURL(/#settings/);
  const id = await d.open(spec());
  await page.goto(`${d.origin}/?lang=en#r=${id}`);
  await expect(page.locator(".card")).toHaveCount(3);
  // The round re-renders its cards once after load: retry until the last one stays attached.
  await expect(async () => page.locator(".card").last().scrollIntoViewIfNeeded({ timeout: 1000 })).toPass();
  const y = await page.evaluate(() => scrollY);
  // A DOM click keeps the scroll origin at the card, as a keyboard activation would.
  await settings(page).evaluate((button) => button.click());
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#r=${id}$`));
  await expect(page.locator(".card")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, -1);
  const deck = await d.open(swipeSpec(), { mode: "swipe" });
  await enter(page, deck);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#r=${deck}$`));
  await expect(page.locator(".sw")).toBeVisible();
  await page.goto(`${d.origin}/?lang=en#journal`);
  await settings(page).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(/#journal$/);
  await d.must("POST", `/api/rounds/${id}/cancel`, {});
  await enter(page, id);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#r=${id}$`));
  await expect(page.locator(".done-view")).toBeVisible();
});

test("global level, project override, clear, and a failed save keeps the choice", async ({ page }) => {
  const id = await d.open(spec());
  await enter(page, id);
  await expect(page.getByRole("heading", { name: "How much to ask", exact: true })).toBeVisible();
  await expect(globalLevel(page).locator(".set-source")).toHaveText("The default value is in force.");
  await choose(globalLevel(page).getByRole("combobox", { name: "Level", exact: true }), "mine");
  await save(globalLevel(page));
  expect((await read()).settings.level).toMatchObject({ value: "mine", from: "global" });
  await scope(page, "In this project");
  await expect(projectLevel(page).locator(".set-source")).toContainText("From all projects:");
  await choose(projectLevel(page).getByLabel("Use settings from"), "own");
  await choose(projectLevel(page).getByRole("combobox", { name: "Level", exact: true }), "irreversible");
  await save(projectLevel(page));
  expect((await read()).settings.level).toMatchObject({ value: "irreversible", from: "project" });
  await expect(projectLevel(page).getByLabel("Use settings from")).toHaveJSProperty("value", "own");
  await choose(projectLevel(page).getByLabel("Use settings from"), "inherit");
  await save(projectLevel(page));
  expect((await read()).settings.level).toMatchObject({ value: "mine", from: "global" });
  await scope(page, "Everywhere");
  await page.route("**/api/settings", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' }));
  await choose(globalLevel(page).getByRole("combobox", { name: "Level", exact: true }), "everything");
  await globalLevel(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(globalLevel(page).getByRole("status")).toContainText("Could not save");
  await expect(globalLevel(page).getByRole("combobox", { name: "Level", exact: true })).toHaveJSProperty("value", "everything");
});

test("Russian settings localize the default role summaries and show stored text in the editor", async ({ page }) => {
  const id = await d.open(spec());
  await page.goto(`${d.origin}/?lang=ru#r=${id}`);
  const gear = page.getByRole("button", { name: "Открыть настройки" });
  await expect(gear.locator("svg")).toHaveAttribute("viewBox", "0 0 24 24");
  await gear.click();
  await expect(page.getByRole("heading", { name: "Настройки", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Когда агент задаёт вопросы", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "В этом проекте", exact: true }).click();
  for (const name of ["level", "reviewers"]) {
    const project = page.locator(`[data-setting="${name}"][data-scope="project"]`);
    await expect(project.getByRole("combobox", { name: "Какие настройки использовать" })).toBeVisible();
  }
  const form = globalReviewers(page);
  await page.getByRole("button", { name: "Во всех проектах", exact: true }).click();
  await form.locator(".set-advanced > summary").click();
  await expect(form.locator(".set-role-title")).toHaveText([
    "Ошибки и регрессии", "Безопасность и данные", "Что доказывают проверки",
  ]);
  const first = form.locator("details.set-role").first();
  await first.locator("summary").click();
  const role = (await read()).defaults.reviewers.roles[0];
  const title = first.getByRole("textbox", { name: "Название" });
  await expect(title).toHaveValue(role.title);
  await expect(first.getByRole("textbox", { name: "Что проверить" })).toHaveValue(role.brief);
  await title.fill("Моя проверка");
  await expect(first.locator(".set-role-title")).toHaveText("Моя проверка");
  await title.fill(role.title);
  await expect(first.locator(".set-role-title")).toHaveText("Ошибки и регрессии");
});

test("roles expand to edit model, add, reorder, remove and reset to defaults", async ({ page }) => {
  const id = await d.open(spec());
  await enter(page, id);
  const form = globalReviewers(page);
  await form.locator(".set-advanced > summary").click();
  await form.locator("details.set-role").first().locator("summary").click();
  await form.locator("details.set-role").first().getByLabel("Model", { exact: true }).fill("my-review-model");
  await save(form);
  expect((await read()).settings.reviewers.value.roles[0].model).toBe("my-review-model");
  await form.getByRole("button", { name: "Add role", exact: true }).click();
  const last = form.locator("details.set-role").last();
  await last.getByLabel("Title", { exact: true }).fill("Accessibility");
  await last.getByLabel("Brief", { exact: true }).fill("Check keyboard access");
  await last.getByRole("button", { name: "Move up", exact: true }).click();
  await save(form);
  expect((await read()).settings.reviewers.value.roles[2].title).toBe("Accessibility");
  await form.locator("details.set-role").nth(2).getByRole("button", { name: "Remove role", exact: true }).click();
  await save(form);
  expect((await read()).settings.reviewers.value.roles).toHaveLength(3);
  await form.getByRole("button", { name: "Reset roles to defaults", exact: true }).click();
  await save(form);
  expect((await read()).settings.reviewers.value.roles.map((r) => [r.id, r.model])).toEqual([["correctness", ""], ["safety", ""], ["tests", ""]]);
  await scope(page, "In this project");
  const project = page.locator('[data-setting="reviewers"][data-scope="project"]');
  await choose(project.getByLabel("Use settings from"), "own");
  await choose(project.getByLabel("When to review"), "request");
  await save(project);
  expect((await read()).settings.reviewers.from).toBe("project");
  await choose(project.getByLabel("Use settings from"), "inherit");
  await save(project);
  expect((await read()).settings.reviewers.from).toBe("global");
});

test("rules stay with the project and are removed on Save", async ({ page }) => {
  const id = await d.open(spec());
  await d.must("POST", "/api/rules", { project: d.project, mode: "never", text: "Use the existing formatter" });
  await enter(page, id);
  await scope(page, "In this project");
  const form = page.locator('[data-setting="rules"]');
  await expect(form).toContainText("These rules belong to this project");
  await form.getByRole("checkbox", { name: "Remove rule: Use the existing formatter", exact: true }).check();
  expect((await read()).rules).toHaveLength(1);
  await save(form);
  await expect(form).toContainText("No rules yet");
  expect((await read()).rules).toHaveLength(0);
});

for (const width of [1440, 1100]) for (const theme of ["light", "dark"]) {
  test(`theme follows the top bar and settings fit at ${width}, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await enter(page, await d.open(spec()));
    const section = page.locator('[data-setting="theme"]');
    const select = section.getByLabel("Theme", { exact: true });
    await expect(section.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await choose(select, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("decide-theme"))).toBe(theme);
    await expect(section.getByRole("status")).toHaveText("Saved");
    await page.locator("button.theme").click();
    const other = theme === "dark" ? "light" : "dark";
    await expect(select).toHaveJSProperty("value", other);
    await expect(section.getByRole("status")).toHaveText("Saved");
    await choose(select, "system");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("decide-theme"))).toBeNull();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`settings-${width}-${theme}.png`), fullPage: true });
  });
}

test("a theme storage failure keeps the choice and Try again applies it", async ({ page }) => {
  await enter(page);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "decide-theme") {
        Storage.prototype.setItem = setItem;
        throw new Error("Storage unavailable");
      }
      return setItem.call(this, key, value);
    };
  });
  const section = page.locator('[data-setting="theme"]');
  const select = section.getByLabel("Theme", { exact: true });
  const retry = section.getByRole("button", { name: "Try again", exact: true });
  await choose(select, "dark");
  await expect(page.locator("#toast.show")).toHaveText("Could not save the theme in this browser.");
  await expect(select).toHaveJSProperty("value", "dark");
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(section.getByRole("status")).toHaveText("Saved");
  await expect(retry).toBeHidden();
});

test("gear opens from a review and returns to that review", async ({ page }) => {
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: d.project, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "-q", "-b", "main");
  writeFile(d.project, "file.txt", "before\n");
  git("add", "file.txt"); git("commit", "-qm", "base");
  git("checkout", "-qb", "change");
  writeFile(d.project, "file.txt", "after\n");
  git("add", "file.txt"); git("commit", "-qm", "change");
  const { id } = await d.must("POST", "/api/rounds", { project: d.project, mode: "review", open: false, base: "main", head: "change", spec: { title: "Settings review", summary: "One line changed.", chapters: [{ id: "one", title: "One line", summary: "The changed text.", hunks: ["file.txt"] }] } });
  await enter(page, id);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#r=${id}$`));
  await expect(page.locator("h1.cr-title")).toHaveText("Settings review");
});

test("settings show one scope and the picker supports keyboard preview and cancellation", async ({ page }) => {
  await enter(page, await d.open(spec()));
  await expect(globalLevel(page)).toBeVisible();
  await expect(projectLevel(page)).toBeHidden();
  const control = globalLevel(page).getByRole("combobox");
  await control.focus();
  await control.press("ArrowDown");
  const list = globalLevel(page).getByRole("listbox");
  await expect(list).toBeVisible();
  const initial = await control.textContent();
  await control.press("End");
  await control.press("Escape");
  await expect(list).toBeHidden();
  await expect(control).toHaveText(initial);
  await control.press("Enter");
  await control.press("Home");
  await control.press("Enter");
  await expect(control).toHaveJSProperty("value", "everything");
  await page.getByRole("button", { name: "In this project", exact: true }).click();
  await expect(projectLevel(page)).toBeVisible();
  await expect(globalLevel(page)).toBeHidden();
});
