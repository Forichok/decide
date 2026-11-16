#!/usr/bin/env node
// ui-audit.mjs: opens every view of the page at 375, 768 and 1440 in both themes, measures it and writes a
// report. It checks what a look at a screenshot misses or misjudges: horizontal scroll, text cut by its box,
// touch targets under 44px on a phone, text contrast under 4.5:1 (3:1 for large text), type under 12px,
// keyboard focus with no visible ring, and content the floating bar can never uncover.
//
//   node scripts/ui-audit.mjs <out-dir>            report.json, report.txt and one png per view
//   node scripts/ui-audit.mjs <out-dir> swipe tune only the named views
//
// Exit code 1 when there is at least one finding. Runs its own server in a scratch home (scripts/harness.mjs).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { sleep, startServer } from "./harness.mjs";

const [outArg, ...names] = process.argv.slice(2);
if (!outArg) {
  console.error("usage: node scripts/ui-audit.mjs <out-dir> [view ...]");
  process.exit(2);
}
const OUT = path.resolve(outArg);
mkdirSync(OUT, { recursive: true });
const only = new Set(names);
const wanted = (v) => !only.size || only.has(v);

const WIDTHS = { 375: { width: 375, height: 812 }, 768: { width: 768, height: 1024 }, 1440: { width: 1440, height: 900 } };
const THEMES = ["light", "dark"];

// ---- the measurements, run inside the page

function measure({ phone }) {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const sig = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    const id = el.id && !/^q-|^\d/.test(el.id) ? "#" + el.id : "";
    return el.tagName.toLowerCase() + id + cls;
  };
  const text = (el) => (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const add = (kind, el, detail) => out.push({ kind, el: sig(el), text: text(el), detail });
  const shown = (el) => {
    if (!el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // An element some ancestor clips or scrolls is not the page's own overflow.
  const clippedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true;
      if (s.position === "fixed") return false;
    }
    return false;
  };
  const all = [...document.body.querySelectorAll("*")].filter((el) => !el.closest("svg") || el.tagName.toLowerCase() === "svg").filter(shown);

  // 1. horizontal scroll
  if (document.documentElement.scrollWidth > vw + 1) {
    out.push({ kind: "h-scroll", el: "html", text: "", detail: `page is ${document.documentElement.scrollWidth}px wide in a ${vw}px window` });
  }
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !clippedByAncestor(el) && getComputedStyle(el).position !== "fixed") add("off-screen", el, `left ${Math.round(r.left)} right ${Math.round(r.right)} of ${vw}`);
    else if ((r.right > vw + 1 || r.left < -1) && getComputedStyle(el).position === "fixed") add("off-screen-fixed", el, `left ${Math.round(r.left)} right ${Math.round(r.right)} of ${vw}`);
  }

  // 2. text cut by its own box
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length > 1);
  for (const el of all) {
    if (!ownText(el)) continue;
    const s = getComputedStyle(el);
    if (s.overflowX === "visible") continue;
    if (el.scrollWidth > el.clientWidth + 1) add("cut-text", el, `${el.scrollWidth}px of text in ${el.clientWidth}px${s.textOverflow === "ellipsis" ? " (ellipsis)" : ""}`);
  }

  // 3. touch targets on a phone
  if (phone) {
    const hit = "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=radio], [role=checkbox], [role=tab], [tabindex='0']";
    // Not counted: a link or a term inside a sentence (WCAG 2.5.8 leaves inline targets out), the progress
    // segments, which only repeat what scrolling does, and the divider of a before/after picture.
    const inline = (el) => el.matches("a, abbr") && el.parentElement && getComputedStyle(el).display.startsWith("inline") && [...el.parentElement.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    for (const el of document.querySelectorAll(hit)) {
      if (!shown(el) || el.disabled || inline(el) || el.matches(".seg-dot, .cmp-handle, iframe")) continue; // .cmp-handle: the whole picture drags it
      let r = el.getBoundingClientRect();
      // a control inside a label is as large as the label
      const label = el.closest("label");
      if (label && shown(label)) r = label.getBoundingClientRect();
      // ::before / ::after stretched over the control count as its hit area
      let w = r.width;
      let h = r.height;
      for (const pseudo of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === "none" || ps.position !== "absolute") continue;
        const inset = ["top", "right", "bottom", "left"].map((k) => parseFloat(ps[k]));
        if (inset.every((v) => Number.isFinite(v) && v < 0)) {
          w = Math.max(w, r.width - inset[1] - inset[3]);
          h = Math.max(h, r.height - inset[0] - inset[2]);
        }
      }
      if (w < 43.5 || h < 43.5) add("small-target", el, `${Math.round(w)}×${Math.round(h)}`);
    }
  }

  // 4. contrast and 5. small type
  const parse = (c) => {
    const m = c.match(/[\d.]+/g);
    if (!m) return [0, 0, 0, 0];
    if (c.startsWith("color(srgb")) return [m[0] * 255, m[1] * 255, m[2] * 255, m[3] === undefined ? 1 : +m[3]];
    return [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]];
  };
  const over = (top, under) => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const pageBg = parse(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().startsWith("#") ? hex(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()) : getComputedStyle(document.body).backgroundColor);
  function hex(h) {
    const n = h.length === 4 ? [...h.slice(1)].map((c) => c + c).join("") : h.slice(1);
    return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
  }
  // The colour under an element: its ancestors' backgrounds laid over the page. Gradients and pictures are
  // skipped (returns null): a number there would be a guess.
  const backdrop = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.backgroundImage !== "none" && /url\(/.test(s.backgroundImage)) return null;
      const c = parse(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      else if (s.backgroundImage !== "none" && p !== document.body && p !== document.documentElement) {
        // a gradient with no colour under it: take its first stop
        const stop = s.backgroundImage.match(/rgba?\([^)]+\)/);
        if (stop) {
          const g = parse(stop[0]);
          if (g[3] > 0.5) layers.push(g);
        }
      }
      if (c[3] >= 0.999) break;
    }
    let bg = pageBg;
    for (const layer of layers.reverse()) bg = over(layer, bg);
    return bg;
  };
  const seen = new Set();
  for (const el of all) {
    if (!ownText(el) || el.closest("iframe, .lightbox img")) continue;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    if (size < 11.9) add("small-type", el, `${size}px`);
    if (el.closest("[disabled], [aria-disabled=true], .st-ghost .q-head")) continue; // inactive items are dimmed on purpose
    const bg = backdrop(el);
    if (!bg) continue;
    let fg = parse(s.color);
    let op = 1;
    for (let p = el; p; p = p.parentElement) op *= parseFloat(getComputedStyle(p).opacity);
    fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const cr = ratio(fg, bg);
    const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need - 0.05) {
      const key = sig(el) + "|" + cr.toFixed(1);
      if (seen.has(key)) continue;
      seen.add(key);
      add("contrast", el, `${cr.toFixed(2)}:1, needs ${need} (${size}px)`);
    }
  }

  // 7. the last piece of content must be able to scroll clear of the floating bar
  const bar = document.getElementById("bar");
  if (bar && shown(bar) && getComputedStyle(bar).position === "fixed") {
    const main = document.getElementById("main");
    const last = main && [...main.children].filter(shown).pop();
    if (last) {
      const docBottom = document.documentElement.scrollHeight;
      const lastBottom = last.getBoundingClientRect().bottom + scrollY;
      const barH = innerHeight - bar.getBoundingClientRect().top;
      if (docBottom - lastBottom < barH - 1) add("under-bar", last, `${Math.round(docBottom - lastBottom)}px of room under the last block, the bar takes ${Math.round(barH)}px`);
    }
  }
  return out;
}

// Tab through the page: every stop must show a ring (an outline, or a box-shadow that focus changed).
async function focusRings(page, stops = 30) {
  const bad = [];
  const seen = new Set();
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
      const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1.5) || /rgba?\(/.test(s.boxShadow) && el.matches(":focus-visible") && s.boxShadow !== "none";
      // a ring drawn on a wrapper (label:has(:focus-visible), :focus-within) counts too
      let wrap = false;
      for (let p = el.parentElement, n = 0; p && n < 3; p = p.parentElement, n++) {
        const ps = getComputedStyle(p);
        if (ps.outlineStyle !== "none" && parseFloat(ps.outlineWidth) >= 1.5) wrap = true;
      }
      // or on a part of it (the knob of a divider)
      for (const c of [...el.querySelectorAll("*")].slice(0, 6)) {
        const cs = getComputedStyle(c);
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1.5) wrap = true;
      }
      const outlineOk = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 1.5;
      return { el: el.tagName.toLowerCase() + cls, text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40), ok: outlineOk || wrap, soft: ring };
    });
    if (!r || r.el.startsWith("iframe")) continue;
    if (seen.has(r.el)) continue;
    seen.add(r.el);
    if (!r.ok) bad.push({ kind: "no-focus-ring", el: r.el, text: r.text, detail: r.soft ? "box-shadow only" : "no outline" });
  }
  return bad;
}

// ---- the views

const SCREEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560" viewBox="0 0 900 560"><rect width="900" height="560" fill="#eef0f6"/><rect x="0" y="0" width="900" height="64" fill="#fff"/><rect x="32" y="22" width="120" height="20" rx="6" fill="#c9ced9"/><rect x="48" y="104" width="804" height="120" rx="14" fill="#fff"/><rect x="48" y="248" width="390" height="260" rx="14" fill="#fff"/><rect x="462" y="248" width="390" height="260" rx="14" fill="#fff"/><circle cx="110" cy="164" r="30" fill="#d6245f"/></svg>';

let d;
const ready = async (page, sel = ".card") => {
  await page.locator(sel).first().waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts?.ready);
  await sleep(600);
};
const openRound = async (page, spec, opts) => {
  await d.clear();
  const id = await d.open(spec, opts);
  await page.goto(d.url(id));
  await ready(page);
  return id;
};
const swipeDeck = () => d.readSpec("examples/swipe.deck.json");

const VIEWS = {
  async showcase(page) {
    await openRound(page, d.readSpec("examples/showcase.questions.json"), { live: true });
    await page.locator("#q-layout .opt").nth(1).click();
  },
  async "showcase-ru"(page) {
    d.copy("examples/showcase.ru.assets");
    await openRound(page, d.readSpec("examples/showcase.ru.questions.json"), { live: true });
  },
  async long(page) {
    await openRound(page, d.readSpec("examples/v3/long.questions.json"));
  },
  async forms(page) {
    const spec = d.readSpec("examples/v3/forms.questions.json");
    spec.questions.find((x) => x.id === "where").images[0].src = "screen.svg";
    d.write("screen.svg", SCREEN_SVG);
    await openRound(page, spec);
  },
  async evidence(page) {
    await openRound(page, d.readSpec("examples/v3/evidence.questions.json"));
  },
  async reactive(page) {
    await openRound(page, d.readSpec("examples/v3/reactive.questions.json"), { live: true });
  },
  async tune(page) {
    await openRound(page, d.readSpec("examples/v3/tune.questions.json"));
    await page.locator("#q-card iframe").first().waitFor();
    await page.locator('#q-card .tn-chip[data-preset="Packed"]').click();
    await page.locator('#q-card [data-act="remember"]').click();
    await sleep(900);
  },
  async ask(page) {
    const id = await openRound(page, d.readSpec("examples/showcase.questions.json"), { live: true });
    const goal = page.locator("#q-goal");
    await goal.locator('[data-flag="explain"]').click();
    await goal.locator("textarea.ask-input").fill("Does the reminder need a server, or can the phone do it alone?");
    await goal.locator(".ask-row .btn.primary").click();
    await d.explain(id, "goal", "Local reminders work without a server: the phone schedules them itself. A server is only needed to sync them between two devices, and that is a later question.");
    await goal.locator(".msg.agent .msg-text").waitFor({ timeout: 10_000 });
  },
  async review(page) {
    await openRound(page, d.readSpec("examples/showcase.questions.json"), { live: true });
    await page.locator("#q-layout .opt").first().click();
    await page.locator("#bar .bar-done").click();
    await page.locator("#overlay .btn.primary").waitFor();
  },
  async done(page) {
    await VIEWS.review(page);
    await page.locator("#overlay .btn.primary").first().click();
    await sleep(900);
  },
  async keys(page) {
    await openRound(page, d.readSpec("examples/showcase.questions.json"));
    await page.keyboard.press("?");
    await sleep(400);
  },
  async lightbox(page) {
    await openRound(page, d.readSpec("examples/showcase.questions.json"));
    await page.locator("#q-layout .shot-btn").first().click();
    await sleep(600);
  },
  async swipe(page) {
    await d.clear();
    const id = await d.open(swipeDeck(), { mode: "swipe" });
    await page.goto(d.url(id));
    await page.locator(".sw-card.front").waitFor();
    await sleep(900);
  },
  async "swipe-own"(page) {
    await VIEWS.swipe(page);
    await page.keyboard.press("Enter");
    await page.locator(".sw-own-input").fill("Both: one person now, sharing later without a rewrite");
  },
  async "swipe-end"(page) {
    await d.clear();
    const end = await d.open({ ...swipeDeck(), cards: swipeDeck().cards.slice(0, 2) }, { mode: "swipe" });
    await page.goto(d.url(end));
    await page.locator(".sw-card.front").waitFor();
    await page.keyboard.press("ArrowLeft");
    await sleep(400);
    await page.keyboard.press("ArrowRight");
    await page.locator(".sw-end").waitFor();
    await d.must("POST", `/api/rounds/${end}/push`, { done: true });
    await sleep(500);
  },
  async inbox(page) {
    await openRound(page, d.readSpec("examples/showcase.questions.json"), { live: true });
    for (const title of ["Pricing page copy", "Which database for the sync service, and where does it run in the first year?"])
      await d.open({ title, questions: [{ id: "a", type: "single", title: "Pick one", why: "Needed.", options: [{ id: "x", label: "Yes", then: "Goes on." }, { id: "y", label: "No", then: "Stops." }] }] });
    await sleep(1500);
  },
  async home(page) {
    await d.clear();
    await page.goto(d.origin + "/");
    await sleep(1200);
  },
  async journal(page) {
    await page.goto(`${d.origin}/#journal`);
    await page.locator(".jp-list").waitFor();
    await sleep(600);
  },
  async "journal-map"(page) {
    await page.goto(`${d.origin}/#journal`);
    await page.locator(".jp-list").waitFor();
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await page.locator(".jp-map .map-note").first().waitFor({ timeout: 20_000 });
    await sleep(2000);
  },
  // the rule line under an answer, open for editing
  async "done-rule"(page) {
    await VIEWS.done(page);
    await page.locator(".rule-row .link-btn").first().click();
    await sleep(300);
  },
  // the settings of a project: its level and one saved rule
  async settings(page) {
    await VIEWS["done-rule"](page);
    await page.locator(".rule-row .btn.primary").click();
    await page.locator('.rule-row a[href="#settings"]').click();
    await page.locator(".set-levels").waitFor();
    await sleep(400);
  },
  async "settings-empty"(page) {
    await page.goto(`${d.origin}/#settings`);
    await sleep(1000);
  },
};

async function seedJournal() {
  const make = async (title, qid, dependsOn) => {
    const id = await d.open({ title, questions: [{ id: qid, type: "single", title: `${title}?`, why: "It comes first.", ...(dependsOn ? { dependsOn } : {}), options: [{ id: "a", label: "Yes", then: "Goes on." }, { id: "b", label: "No", then: "Stops." }] }] });
    await d.must("POST", `/api/rounds/${id}/submit`, { answers: { [qid]: { selected: ["a"] } } });
    return id;
  };
  const first = await make("Who is the first version for", "who");
  await make("Where does sync run", "sync", ["who"]);
  const price = await make("What does Pro cost", "price", [first]);
  await make("Which payment provider", "pay", ["price"]);
  await make("Keep the free plan", "free", ["price"]);
}

const CARD_SHOTS = new Set(["showcase", "forms", "evidence", "reactive", "tune"]);

// ---- main

d = await startServer({ name: "ui-audit" });
const findings = [];
let browser;
try {
  for (const rel of ["examples/showcase.assets", "examples/swipe.assets", "examples/v3/tune.assets"]) d.copy(rel);
  await seedJournal();
  browser = await chromium.launch({ args: ["--mute-audio"] });
  for (const widthKey of Object.keys(WIDTHS)) {
    for (const theme of THEMES) {
      const v = WIDTHS[widthKey];
      const phone = v.width < 500;
      const ctx = await browser.newContext({ viewport: v, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: "reduce", locale: "en-US", hasTouch: phone, isMobile: phone });
      ctx.setDefaultTimeout(8000);
      for (const [name, build] of Object.entries(VIEWS)) {
        if (!wanted(name)) continue;
        const where = `${name}@${widthKey}-${theme}`;
        // a page of its own for every view: nothing one view left open reaches the next
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
        page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname.replace(/[0-9a-f]{8,}/g, ":id")}`));
        try {
          await build(page);
          await sleep(400);
          await page.evaluate(() => {
            const t = document.getElementById("toast");
            if (t) t.style.display = "none";
          });
          const found = await page.evaluate(measure, { phone });
          await page.screenshot({ path: path.join(OUT, `${name}-${widthKey}-${theme}.png`) });
          // every card on its own, where the view is a list of cards
          if (CARD_SHOTS.has(name) && widthKey !== "768" && (theme === "light" || widthKey === "1440")) {
            await page.evaluate(() => {
              document.getElementById("bar").style.visibility = "hidden";
              document.activeElement?.blur?.(); // the skip link shows while it has focus
            });
            await sleep(150); // the bar is gone from the frame before the first shot
            for (const card of await page.locator(".card").all()) {
              const qid = ((await card.getAttribute("id")) || "x").replace(/^q-/, "");
              await card.screenshot({ path: path.join(OUT, `${name}.${qid}-${widthKey}-${theme}.png`) }).catch(() => {});
            }
            await page.evaluate(() => (document.getElementById("bar").style.visibility = ""));
          }
          if (!phone && theme === "light") found.push(...(await focusRings(page)));
          for (const e of errors) found.push({ kind: "console-error", el: "", text: "", detail: e.slice(0, 200) });
          for (const f of found) findings.push({ where, view: name, width: +widthKey, theme, ...f });
          console.log(`${where}: ${found.length}`);
        } catch (e) {
          findings.push({ where, view: name, width: +widthKey, theme, kind: "audit-error", el: "", text: "", detail: String(e).slice(0, 300) });
          console.log(`${where}: ERROR ${String(e).slice(0, 160)}`);
        }
        await page.close();
      }
      await ctx.close();
    }
  }
} finally {
  await browser?.close().catch(() => {});
  await d.stop();
}

// One line per distinct defect: the same element at several widths, themes and views folds into one.
const groups = new Map();
for (const f of findings) {
  const key = `${f.kind}|${f.el}|${f.kind === "contrast" ? f.theme : ""}|${f.kind === "contrast" || f.kind === "small-type" ? f.detail : ""}`;
  const g = groups.get(key) || { kind: f.kind, el: f.el, text: f.text, detail: f.detail, where: new Set() };
  g.where.add(f.where);
  groups.set(key, g);
}
const lines = [...groups.values()]
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.el.localeCompare(b.el))
  .map((g) => `${g.kind.padEnd(16)} ${g.el.padEnd(44)} ${g.detail}  «${g.text}»  [${[...g.where].slice(0, 4).join(", ")}${g.where.size > 4 ? ` +${g.where.size - 4}` : ""}]`);
writeFileSync(path.join(OUT, "report.json"), JSON.stringify(findings, null, 1));
writeFileSync(path.join(OUT, "report.txt"), lines.join("\n") + "\n");
console.log(`\n${findings.length} findings, ${groups.size} distinct. Report: ${path.join(OUT, "report.txt")}`);
process.exit(findings.length ? 1 : 0);
