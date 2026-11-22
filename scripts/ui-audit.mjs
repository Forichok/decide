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

import { execFileSync } from "node:child_process";
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
    if (el.clientWidth <= 1 && (s.clipPath !== "none" || s.clip !== "auto")) continue; // hidden on purpose: a name kept for a screen reader
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
    await page.locator(".set-panel").waitFor();
    await sleep(400);
  },
  async "settings-empty"(page) {
    await page.goto(`${d.origin}/#settings`);
    await sleep(1000);
  },
  // a code review of a branch: the overview, the chapters and the bar ("review" above is the send check of a question round)
  async "code-review"(page) {
    await d.clear();
    const { lineA } = await branches();
    const r = await d.must("POST", "/api/rounds", { project: d.project, spec: reviewSpec(lineA), mode: "review", open: false, base: "main", head: "feature" });
    await page.goto(d.url(r.id));
    await ready(page, ".cr-bar");
  },
  async "code-review-verdict"(page) {
    await VIEWS["code-review"](page);
    await page.locator(".cr-bar .btn.primary").click();
    await page.locator("#overlay .btn.primary").waitFor();
    await sleep(300);
  },
  // a visual acceptance round: a task with captures on two screens and a task with none
  async visual(page) {
    await d.clear();
    await branches();
    const spec = visualSpec(await captures());
    const specFile = path.join(d.project, "audit-visual.json");
    writeFileSync(specFile, JSON.stringify(spec));
    const r = await d.must("POST", "/api/rounds", { mode: "visual", project: d.project, base: "main", head: "feature", open: false, specFile, spec });
    await page.goto(d.url(r.id));
    await ready(page, ".va-task");
  },
  async "visual-mark"(page) {
    await VIEWS.visual(page);
    await page.locator(".va-controls button", { hasText: "Mark on the screenshot" }).first().click();
    const plane = page.locator(".va-plane").first();
    await plane.scrollIntoViewIfNeeded();
    const box = await plane.boundingBox();
    await page.mouse.click(box.x + box.width * 0.75, box.y + Math.min(box.height, 300) * 0.5);
    await page.locator("#va-remark").waitFor();
    await sleep(300);
  },
};

// ---- fixtures for the code review and the visual round: a small branch in the project folder, captures made once

let branchesMade;
const branches = () =>
  (branchesMade ||= (async () => {
    const git = (...a) => execFileSync("git", ["-c", "user.name=Audit", "-c", "user.email=audit@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: d.project, encoding: "utf8" });
    const body = (n, word) => Array.from({ length: n }, (_, i) => `export const ${word}${i} = (value) => value + ${i}; // ${word} step ${i}`).join("\n") + "\n";
    git("init", "-q", "-b", "main");
    d.write("src/actions.js", body(40, "act"));
    d.write("src/card.css", Array.from({ length: 30 }, (_, i) => `.card-${i} { padding: ${i}px; }`).join("\n") + "\n");
    d.write("test/actions.test.js", body(12, "check"));
    d.write("lang/en.js", body(20, "word"));
    git("add", "src", "test", "lang");
    git("commit", "-qm", "base");
    git("switch", "-qc", "feature");
    d.write("src/actions.js", body(40, "act").replace(/value \+ 7;/, "value + 70;").replace(/value \+ 30;[^\n]*/, "value + 30 + extra(value); // a longer line that has to wrap or scroll on a phone, never push the page wider than the screen"));
    d.write("src/card.css", Array.from({ length: 30 }, (_, i) => `.card-${i} { padding: ${i * 2}px; }`).join("\n") + "\n");
    d.write("test/actions.test.js", body(14, "check"));
    d.write("lang/en.js", body(22, "word"));
    git("add", "src", "test", "lang");
    git("commit", "-qm", "simpler question actions");
    const lineA = Number((git("diff", "-U0", "main", "feature", "--", "src/actions.js").match(/^@@ -\S+ \+(\d+)/m) || [])[1] || 1);
    return { lineA };
  })());

const reviewSpec = (lineA) => ({
  previous: false,
  lang: "en",
  title: "Simpler question actions",
  summary: "Three actions under a question instead of six. Rare ones moved into a menu; Ask opens right under the card.",
  risks: [
    { level: "high", what: "The action menu closes on an outside click: check keyboard and focus", chapter: "actions" },
    { level: "medium", what: "Card styles touch the phone width", chapter: "styles" },
  ],
  checks: [{ command: "node --test test/*.test.mjs", exit: 0, seconds: 12.4 }, { command: "npx playwright test e2e/question.spec.mjs", exit: 1, seconds: 48 }, { command: "node scripts/ui-audit.mjs out question" }],
  chapters: [
    { id: "actions", title: "Actions under the question", summary: "Three buttons and a More menu.", risk: "high", watch: "Focus returns to the button when the menu closes.", hunks: ["src/actions.js"],
      focus: [{ at: `src/actions.js:${lineA}`, note: "The action row is built here.", kind: "decision", question: "Keep Later in the row or move it to the menu?", options: ["In the row", "In the menu"] }] },
    { id: "styles", title: "Card styles", summary: "The action row and the menu.", risk: "medium", hunks: ["src/card.css"] },
    { id: "tests", title: "Tests", summary: "The spec for the new actions.", hunks: ["test/"], skim: "Names only." },
  ],
  mechanical: [{ title: "Interface strings", hunks: ["lang/"] }],
  reviewers: {
    ran: [{ role: "correctness", model: "opus", summary: "The menu does not close on Escape while focus is in the note field.", verdict: "concerns" }],
    skipped: [{ role: "safety", model: "", why: "The change does not touch data or access." }, { role: "tests", model: "", why: "Outside this fixture." }],
    findings: [
      { id: "f1", role: "correctness", severity: "blocking", at: `src/actions.js:${lineA}`, text: "Escape in the note field does not close the menu: the handler sits on the button, not the document." },
      { id: "f2", role: "correctness", severity: "minor", at: "src/card.css:3", text: "The action row padding at 375px is smaller than its neighbours'." },
    ],
  },
});

let capturesMade;
const captures = () =>
  (capturesMade ||= (async () => {
    const form = (label, extra) => `<meta name="viewport" content="width=device-width"><body style="font:16px system-ui;margin:24px;background:#f6f7fb"><h1 style="font-size:22px">Notification settings</h1><p style="color:#555">Mail about new decisions, and reminders.</p><label style="display:block;margin:12px 0"><input type="checkbox"> Weekly summary</label><label style="display:block;margin:12px 0"><input type="checkbox" checked> Reminders</label>${extra}<button style="padding:10px 16px;border-radius:10px;border:0;background:#d6245f;color:#fff;font:inherit">${label}</button> <output style="color:#0a7a3d"></output><script>document.querySelector("button").onclick=()=>document.querySelector("output").textContent="Saved"</script>`;
    const caps = {};
    for (const [vp, w, h] of [["desktop", 1024, 640], ["phone", 390, 844]]) {
      caps[vp] = {};
      for (const [side, label, extra] of [["before", "Save", ""], ["after", "Save settings", '<p style="margin:12px 0;padding:10px 12px;background:#fff;border-radius:10px">The summary comes on Mondays.</p>']]) {
        const video = vp === "desktop"; // one moving capture is enough to draw the player
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...(video ? { recordVideo: { dir: d.project, size: { width: w, height: h } } } : {}) });
        const shot = await ctx.newPage();
        await shot.setContent(form(label, extra));
        await shot.screenshot({ path: path.join(d.project, `${vp}-${side}.png`) });
        caps[vp][side] = { image: `${vp}-${side}.png` };
        if (video) {
          await shot.getByRole("checkbox").first().check();
          await shot.getByRole("button").click();
          await sleep(700);
          const v = shot.video();
          await ctx.close();
          Object.assign(caps[vp][side], { video: path.basename(await v.path()), cue: 0.2 });
        } else await ctx.close();
      }
    }
    return caps;
  })());

const visualSpec = (caps) => ({
  title: "Notification settings", lang: "en", summary: ["The button names what it saves.", "A hint about the summary day sits under the checkboxes."],
  tasks: [
    { id: "save", title: "Save the mail settings", beforeText: "The button said Save.", afterText: "The button says Save settings; a hint about Monday sits under the checkboxes.",
      steps: ["Turn the weekly summary on.", "Press Save settings."], expected: "Saved appears next to the button.",
      evidence: [
        { id: "desktop", label: "Settings, desktop", viewport: "1024 × 640", theme: "light", fixture: "subscriber", state: "saved", ...caps.desktop },
        { id: "phone", label: "Settings, phone", viewport: "390 × 844", theme: "light", fixture: "subscriber", state: "saved", ...caps.phone },
      ] },
    { id: "history", title: "Open the change history", beforeText: "There was no history.", afterText: "The history opens from a link under the form.",
      steps: ["Open the history."], expected: "One change in the list.", gap: "The test environment with history is unavailable: no captures.", evidence: [] },
  ],
});

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

const unknown = names.filter((n) => !(n in VIEWS));
if (unknown.length) {
  console.error(`unknown view: ${unknown.join(", ")}. Views: ${Object.keys(VIEWS).join(", ")}`);
  process.exit(2);
}

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
          findings.push({ where, view: name, width: +widthKey, theme, kind: "audit-error", el: "", text: "", detail: String(e).slice(0, 1200) });
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
