// Match whole path components or filename words (delimited by / . _ -), ignoring case.
// Both sides of a rename count. These are signals to ask for a review, not a security assessment.
const PATH_RULES = [
  ["money", /(?:^|[/._-])(?:payments?|billing|checkout|stripe|money)(?=$|[/._-])/i],
  ["auth", /(?:^|[/._-])(?:auth|oauth2?|authentication|authorization|authn|authz)(?=$|[/._-])/i],
  ["migrations", /(?:^|[/._-])migrations?(?=$|[/._-])/i],
  ["security", /(?:^|[/._-])(?:security|secrets?|permissions?|crypto)(?=$|[/._-])/i],
];

export const changedPaths = (files) => [...new Set(files.flatMap((f) => [f.path, f.oldPath].filter(Boolean)))];

export function reviewerRequirement({ stats, paths, settings, spec }) {
  const { mode, lines: threshold, roles } = settings;
  const lines = stats.added + stats.removed;
  const count = `${lines} changed lines`;
  const state = { mode, lines, threshold, roles };
  if (mode === "always") return { ...state, required: true, reason: `${count}; reviewers.mode is always` };
  if (mode === "request") return { ...state, required: false, reason: `${count}; reviewers.mode is request` };
  const rules = [];
  const large = lines >= threshold;
  if (spec?.risks?.length) rules.push("risks[] names a risk");
  for (const c of spec?.chapters ?? []) {
    if (c.risk === "high") rules.push(`chapter "${c.id}" is high risk`);
    if (c.focus?.some(f => f.kind === "risk")) rules.push(`chapter "${c.id}" names a risk key place`);
  }
  for (const [rule, pattern] of PATH_RULES) {
    const hit = paths.find(path => pattern.test(path));
    if (hit) rules.push(`the ${rule} path rule matched "${hit}"`);
  }
  const size = large ? `${count}, the threshold is ${threshold}` : count;
  return { ...state, required: large || rules.length > 0, reason: [size, ...rules, ...(!large && !rules.length ? ["no risk named"] : [])].join("; ") };
}

export const requirementLine = ({ required, reason }) => `Reviewers: ${required ? "required" : "not required"} (${reason}).`;
export const reviewerRoleLines = ({ roles }) => roles.map(({ id, model, brief }) => `- ${id} (${model || "agent default"}): ${brief}`);

export function reviewerIssues(spec, requirement) {
  const { required, roles } = requirement;
  const { ran = [], skipped = [], none } = spec.reviewers ?? {};
  const issues = [];
  if (required && !ran.length && !none) issues.push({
    level: "error", where: "reviewers", message: [
      `Independent reviewers are required (${requirement.reason}).`,
      ...reviewerRoleLines(requirement),
      "Read “The reviewer team” in skills/review/SKILL.md and start a fresh agent for each role.",
      "Copy their verdicts and findings into reviewers.ran and reviewers.findings, with unavailable roles in reviewers.skipped.",
      "If no team can run, state why in reviewers.none.",
    ].join("\n"),
  });
  if (ran.length) {
    const named = new Set([...ran, ...skipped].map(r => r.role));
    for (const { id } of roles) if (!named.has(id)) issues.push({ level: required ? "error" : "warn", where: "reviewers", message: `role "${id}" is missing from ran and skipped` });
  }
  return issues;
}
