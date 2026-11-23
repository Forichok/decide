import { test, expect } from "@playwright/test";
import { startDecide, spec } from "./helpers.mjs";
import { openRound } from "./ui.mjs";

let d, id;
test.beforeAll(async () => {
  d = await startDecide({ name: "look" });
  id = await d.open(spec());
});
test.afterAll(async () => d?.stop());

// WCAG contrast of two "rgb(...)" strings.
const contrast = (fg, bg) => {
  const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const a = lum(parse(fg));
  const b = lum(parse(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

for (const scheme of ["light", "dark"]) {
  test(`body text has contrast of at least 4.5 on its surface (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openRound(page, d, id);
    const pairs = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const solid = (name) => {
        const probe = document.createElement("div");
        probe.style.color = root.getPropertyValue(name).trim();
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      };
      return {
        title: [getComputedStyle(document.querySelector(".q-title")).color, solid("--surface-solid")],
        why: [getComputedStyle(document.querySelector(".q-why")).color, solid("--surface-solid")],
        page: [getComputedStyle(document.body).color, solid("--bg")],
      };
    });
    for (const [name, [fg, bg]] of Object.entries(pairs)) {
      expect(contrast(fg, bg), `${name}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

test("the page follows the system theme and the toggle wins", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openRound(page, d, id);
  const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bgDark).not.toBe(bgLight);
});

test("floating chrome is glass by default and solid under reduced transparency", async ({ page }) => {
  await openRound(page, d, id);
  const token = (name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  expect(await token("--glass-blur")).toContain("blur");
  const glassBg = await token("--glass-bg");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
  expect(await token("--glass-blur")).toBe("none");
  expect(await token("--glass-bg")).not.toBe(glassBg);
});

test("reduced motion shortens every transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openRound(page, d, id);
  const dur = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dur").trim());
  expect(dur).toBe("0.01ms");
});

test("a round's header on a phone is one row inside the screen, and every control in it keeps a name", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openRound(page, d, id);
  const head = page.locator(".eyebrow");
  const box = await head.boundingBox();
  expect(box.height).toBeLessThan(64);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await head.locator("a:visible, button:visible").all()) {
    const size = await control.boundingBox();
    expect(size.x + size.width).toBeLessThanOrEqual(375);
    await expect(control).toHaveAccessibleName(/\S/);
  }
});
