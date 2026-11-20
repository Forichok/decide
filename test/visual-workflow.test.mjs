import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store/rounds.mjs";
import { normalizeVisual } from "../lib/visual/spec.mjs";

test("visual evidence survives source changes, restart and a returned mark", (t) => {
  const home = mkdtempSync(join(tmpdir(), "decide-visual-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "authored");
  mkdirSync(dir);
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  writeFileSync(join(dir, "app.png"), png);
  const range = { base: "a".repeat(40), head: "b".repeat(40), baseRef: "old", headRef: "new" };
  const raw = {
    title: "Theme",
    summary: ["Choose a theme"],
    tasks: [
      {
        id: "pick",
        title: "Choose dark",
        beforeText: "A select",
        afterText: "A tile",
        steps: ["Select Dark"],
        expected: "The page is dark",
        evidence: [
          {
            id: "desktop",
            label: "Desktop",
            viewport: "1200x800",
            theme: "light",
            state: "ready",
            fixture: "sample",
            before: { image: "app.png" },
            after: { image: "app.png" },
          },
        ],
      },
    ],
  };
  const project = { root: dir, top: dir, dataDir: join(home, "projects", "fixture") };
  const roots = { within: (_id, fn) => fn(), publishFile: (p) => p, release() {} };
  let store = createStore({ home, roots });
  const open = (spec) =>
    store.create({
      project,
      spec: normalizeVisual(spec, range),
      mode: "visual",
      specFile: join(dir, "spec.json"),
    });
  const round = open(raw);
  const decide = (value, note) => store.changeVisual(round, { op: "decision", task: "pick", value, note });
  assert.throws(() => decide("conditional", " "), /condition/);
  assert.throws(() => decide("unknown"), /decision/);
  decide("later", "After the phone test");
  assert.throws(() => store.finish(round, { verdict: "approve" }), /deferred/);
  decide(null);
  decide("conditional", "Keep the keyboard shortcut");
  const copy = round.spec.tasks[0].evidence[0].after.image;
  writeFileSync(join(dir, "app.png"), Buffer.concat([png, Buffer.from("new")]));
  assert.deepEqual(readFileSync(copy), png);
  store.changeVisual(round, {
    op: "mark",
    task: "pick",
    evidence: "desktop",
    side: "after",
    x: 0.4,
    y: 0.7,
    text: "Move the label",
  });
  store.close();
  store = createStore({ home, roots });
  const old = store.get(round.id);
  const result = store.finish(old, { verdict: "return" });
  assert.deepEqual(result.taskDecisions.pick, { choice: "conditional", note: "Keep the keyboard shortcut" });
  assert.match(result.digest, /pick: conditional — Keep the keyboard shortcut/);
  const [mark] = result.marks;
  assert.equal(mark.revision, range.head);
  assert.throws(() => open({ ...raw, previous: old.id }), /reply|remark/i);
  const next = open({
    ...raw,
    previous: old.id,
    replies: [{ ref: mark.id, task: "pick", evidence: "desktop", text: "Moved" }],
  });
  assert.deepEqual(readFileSync(next.spec.replies[0].original.image), png);
  assert.throws(() => store.finish(next, { verdict: "approve" }), /recheck|resolv/i);
  store.changeVisual(next, { op: "resolve", ref: mark.id, value: "open" });
  const returned = store.finish(next, { verdict: "return" });
  assert.match(returned.digest, /open.*Move the label/);
  assert.equal(returned.replies[0].original.text, mark.text);
  assert.throws(() => open({ ...raw, previous: next.id }), /remark/);
  const final = open({
    ...raw,
    previous: next.id,
    replies: [{ ref: mark.id, task: "pick", text: "The control has been removed" }],
  });
  assert.equal(final.spec.replies[0].original.round, round.id);
  assert.deepEqual(readFileSync(final.spec.replies[0].original.image), png);
  store.changeVisual(final, { op: "resolve", ref: mark.id, value: "fixed" });
  assert.equal(store.finish(final, { verdict: "approve" }).verdict, "approve");
  const pair = raw.tasks[0].evidence[0];
  assert.throws(
    () =>
      open({
        ...raw,
        tasks: [{ ...raw.tasks[0], evidence: [{ ...pair, after: { image: "app.png", theme: "dark" } }] }],
      }),
    /differs/,
  );
  assert.throws(
    () => open({ ...raw, tasks: [{ ...raw.tasks[0], evidence: [{ ...pair, before: undefined }] }] }),
    /gap/,
  );
  const gap = open({ ...raw, tasks: [{ ...raw.tasks[0], evidence: [], gap: "Old screen removed" }] });
  assert.throws(() => store.finish(gap, { verdict: "approve" }), /gap/i);
  store.changeVisual(gap, { op: "gap", task: "pick", value: true });
  assert.equal(store.finish(gap, { verdict: "approve" }).gaps.pick, true);
  const manualGap = open({ ...raw, tasks: [{ ...raw.tasks[0], evidence: [], gap: "Missing capture" }] });
  store.changeVisual(manualGap, { op: "check", task: "pick", value: true });
  assert.equal(store.finish(manualGap, { verdict: "approve" }).gaps.pick, undefined);
  const claim = open({ ...raw, tasks: [{ ...raw.tasks[0], manualOnly: true, evidence: [] }] });
  assert.throws(() => store.finish(claim, { verdict: "approve" }), /manual/i);
  store.changeVisual(claim, { op: "check", task: "pick", value: true });
  assert.equal(store.finish(claim, { verdict: "approve" }).checks.pick, true);
  store.close();
});
