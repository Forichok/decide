import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { branchLog, branchRef, checkRef, insideRepo, isAncestor, refusal, resolveCommit } from "../git.mjs";

export const BRANCH_START = "branch-start";
const policyFile = (dataDir) => join(dataDir, "visual-baseline");
const label = (ref) => ref.replace(/^refs\/(?:heads|remotes)\//, "");

function policyOf(dataDir) {
  try {
    return readFileSync(policyFile(dataDir), "utf8").trim() === BRANCH_START;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function rememberPolicy(dataDir) {
  const file = policyFile(dataDir);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${BRANCH_START}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function needsBase(reason) {
  return refusal(`${reason}. Ask the owner which revision they want for Before, then pass --base <ref> (MCP: base).`);
}

async function checkoutSource(top, target, start) {
  const entries = await branchLog(top, "HEAD");
  const candidates = new Set();
  for (const [index, entry] of entries.entries()) {
    if (entry.id !== start.id || entry.date !== start.date || entries[index + 1]?.id !== start.id) continue;
    const move = entry.action.match(/^checkout: moving from (\S+) to (\S+)$/);
    if (move && move[2] === label(target)) candidates.add(move[1]);
  }
  if (candidates.size > 1) throw needsBase(`Git records more than one possible source branch for ${label(target)} (${[...candidates].join(", ")})`);
  return candidates.values().next().value;
}

async function branchStart(top, headName) {
  const target = await branchRef(top, headName);
  if (!target?.startsWith("refs/heads/")) throw needsBase(`No local work branch found for "${headName}"`);

  const head = await resolveCommit(top, target);
  if (!head) throw needsBase(`Git cannot pin the head of ${label(target)}`);
  const start = (await branchLog(top, target)).at(-1);
  const createdFrom = start?.action.match(/^branch: Created from (\S+)$/)?.[1];
  const sourceName = createdFrom === "HEAD" ? await checkoutSource(top, target, start) : createdFrom;
  if (!sourceName) throw needsBase(`Git has no reliable branch origin for ${label(target)}`);
  const source = await branchRef(top, sourceName);
  if (!source || source === target) throw needsBase(`Git's recorded source "${sourceName}" is ambiguous or no longer names a source branch`);
  const tip = await resolveCommit(top, source);
  if (!tip || !await isAncestor(top, start.id, head) || !await isAncestor(top, start.id, tip)) {
    throw needsBase(`Git cannot verify the recorded start in the ancestry of both ${label(source)} and ${label(target)}`);
  }
  if (start.id === head) throw needsBase(`${label(target)} still points at its branch start`);
  return { base: start.id, head, baseRef: label(source), headRef: label(target) };
}

// A manual comparison pins the requested revision. Automation keeps the recorded fork even
// when the source advances or its later work has been merged into the feature branch.
export async function visualRange({ top, dataDir, base, head, baselinePolicy, preview = false }) {
  if (baselinePolicy !== undefined && baselinePolicy !== BRANCH_START) {
    throw refusal(`baselinePolicy must be "${BRANCH_START}"`);
  }
  if (!await insideRepo(top)) throw refusal("Visual acceptance needs a Git working tree to pin the two revisions.");
  const headName = checkRef(head === undefined ? "HEAD" : head, "head");
  let range;
  if (base !== undefined) {
    const headId = await resolveCommit(top, headName);
    if (!headId) throw refusal(`head "${headName}" names no commit`);
    const baseRef = checkRef(base, "base");
    const baseId = await resolveCommit(top, baseRef);
    if (!baseId) throw refusal(`base "${baseRef}" names no commit`);
    range = { base: baseId, head: headId, baseRef, headRef: headName };
  } else {
    range = await branchStart(top, headName);
    if (!preview && !baselinePolicy && !policyOf(dataDir)) {
      throw refusal(`Proposed comparison: ${range.baseRef} (${range.base}) → ${range.headRef} (${range.head}). Confirm automatic branch-start comparison with the owner, then use --baseline-policy branch-start (MCP: baselinePolicy). For this round only, pass --base <ref> (MCP: base).`);
    }
  }
  if (!preview && baselinePolicy && !policyOf(dataDir)) rememberPolicy(dataDir);
  return range;
}
