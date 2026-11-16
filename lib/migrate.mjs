// migrate.mjs — format numbers of what decide keeps on disk, and the steps that bring an older
// spec, answers file or journal entry up to the current one when it is read. Pure: nothing here
// reads or writes a file, and nothing changes its input. Old files stay as they were.
//
// Spec steps: 1→2 holds the spellings 2.0 still read in their old form; 2→3 only stamps the number
// (milestones 2 and 3 add to it). The format numbers are not the plugin's version.

export const SPEC_FORMAT = 3;
export const ANSWERS_FORMAT = 3;
export const JOURNAL_FORMAT = 3;

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const validFormat = (n) => Number.isInteger(n) && n >= 1 && n <= SPEC_FORMAT;
const optionsOf = (spec) => (Array.isArray(spec.questions) ? spec.questions : []).flatMap((q) => (isObject(q) && Array.isArray(q.options) ? q.options.filter(isObject) : []));

// A spec with no number is a 2.x spec, unless it still spells a picture the 1.x way (`image` on an option).
const formatOf = (raw) => (validFormat(raw.format) ? raw.format : optionsOf(raw).some((o) => "image" in o) ? 1 : 2);

// The older singular `image` of an option is `images`: the same pictures, image first, as the engine always read them.
function step1to2(spec) {
  const questions = spec.questions.map((q) => {
    if (!isObject(q) || !Array.isArray(q.options)) return q;
    const options = q.options.map((o) => {
      if (!isObject(o) || !("image" in o)) return o;
      const { image, ...rest } = o;
      return { ...rest, images: [...list(image), ...list(o.images)] };
    });
    return { ...q, options };
  });
  return { ...spec, questions };
}

// A spec not shaped like a spec (no object, no questions list) is handed back as it is: telling the
// author what is wrong with it is the engine's job.
export function migrateSpec(raw) {
  if (!isObject(raw) || !Array.isArray(raw.questions)) return { spec: raw, from: validFormat(raw?.format) ? raw.format : 2 };
  const from = formatOf(raw);
  let spec = { ...raw };
  if (from < 2) spec = step1to2(spec);
  // A number that is not one of ours stays, so it is reported like any other name nobody reads.
  if (!("format" in raw) || validFormat(raw.format)) spec.format = SPEC_FORMAT;
  return { spec, from };
}

// A 2.x answers file (`version: 2`) is read as format 3: same answers, stamped.
export function migrateAnswers(file) {
  if (!isObject(file) || file.format === ANSWERS_FORMAT) return file;
  return { ...file, format: ANSWERS_FORMAT };
}

const LINE = /^\d+\. \[([^\]]+)\] (.*?) → (.*)$/;

// The questions of an older entry, as far as its digest shows them: one line per answered question.
function recordsOf(entry) {
  const out = [];
  for (const line of String(entry.digest || "").split("\n")) {
    const m = LINE.exec(line);
    if (m) out.push({ id: `${entry.round}/${m[1]}`, title: m[2], answer: m[3].replace(/\s*\n\s*/g, " / ") });
  }
  return out;
}

// A journal line of format 3 holds `records`; an older one gets them from its digest. Supersede lines
// are not entries and pass through.
export function migrateEntry(entry) {
  if (!isObject(entry) || entry.type === "supersede" || entry.format === JOURNAL_FORMAT) return entry;
  return { ...entry, format: JOURNAL_FORMAT, records: Array.isArray(entry.records) ? entry.records : recordsOf(entry) };
}
