// x3-usage.mjs: the four usage numbers from "How we check", read-only.
// Reads DECIDE_HOME (default ~/.decide). Uses only readFileSync/readdirSync/statSync/existsSync.
// Prints aggregate numbers only: no titles, no question or answer text, no project names.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.DECIDE_HOME || join(homedir(), ".decide");
const root = join(home, "projects");
const json = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const out = {
  v3: { rounds: 0, answered: 0, uncollected: 0, asks: 0, yesBut: 0, none: 0 },
  v2: { rounds: 0, answersFile: 0, answersMissing: 0, asks: 0, yesBut: 0, none: 0, answers: 0, askRounds: 0 },
  projects: 0, first: "", last: "",
};
const stamp = (t) => { if (typeof t !== "string") return; if (!out.first || t < out.first) out.first = t; if (t > out.last) out.last = t; };

for (const p of readdirSync(root)) {
  const dir = join(root, p);
  if (!statSync(dir).isDirectory()) continue;
  out.projects++;
  // 3.0 rounds: rounds/<id>/meta.json (format 3) + events.jsonl
  const rdir = join(dir, "rounds");
  if (existsSync(rdir)) for (const id of readdirSync(rdir)) {
    const d = join(rdir, id);
    if (!statSync(d).isDirectory() || json(join(d, "meta.json"))?.format !== 3) continue;
    const ev = lines(join(d, "events.jsonl")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const t = out.v3; t.rounds++;
    ev.forEach((e) => stamp(e.at));
    if (ev.some((e) => e.type === "sent")) { t.answered++; if (!ev.some((e) => e.type === "acked")) t.uncollected++; }
    t.asks += ev.filter((e) => e.type === "ask").length;
    t.yesBut += ev.filter((e) => e.type === "note").length;
  }
  // 2.x rounds: one journal line per answered round; the answers file is named by the line
  for (const l of lines(join(dir, "journal.jsonl"))) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!j.answers) continue; // supersede lines
    const t = out.v2; t.rounds++; stamp(j.at);
    const a = existsSync(j.answers) ? json(j.answers) : null;
    if (!a) { t.answersMissing++; continue; }
    t.answersFile++;
    const n = Array.isArray(a.dialog) ? a.dialog.length : 0;
    t.asks += n; if (n) t.askRounds++;
    for (const v of Object.values(a.answers || {})) {
      t.answers++;
      if (v && typeof v === "object") {
        if (typeof v.note === "string" && v.note.trim()) t.yesBut++;
        if (typeof v.other === "string" && v.other.trim()) t.none++;
      }
    }
  }
}
console.log(JSON.stringify(out, null, 2));
