import pc from "picocolors";
import { CONFIG_FILE, loadConfig } from "../core/config.js";
import { changedFiles, isGitRepo, lastCommitTouching, repoRoot, resolveBase, touchedSince } from "../core/git.js";
import { groupChanges, type AreaChange } from "../core/mapper.js";
import { STATE_FILE, readState } from "../core/state.js";

export interface CheckDeps {
  cwd: string;
  log: (line: string) => void;
}

const MAX_LISTED = 5;

/** Exit code 1 if any area's code changed since lastSha without its doc changing. Makes no LLM call. */
export async function check(overrides: Partial<CheckDeps> = {}): Promise<number> {
  const { cwd, log }: CheckDeps = { cwd: process.cwd(), log: (l) => console.log(l), ...overrides };

  if (!(await isGitRepo(cwd))) {
    throw new Error("Not inside a git repository. Run docsync from your project's git repo.");
  }
  const root = await repoRoot(cwd);
  const config = await loadConfig(root);
  const state = await readState(root);

  let base: string;
  try {
    base = await resolveBase(root, { lastSha: state?.lastSha });
  } catch (err) {
    throw new Error(`${(err as Error).message}. In CI, make sure the full history is checked out (e.g. fetch-depth: 0).`, {
      cause: err,
    });
  }

  const groups = groupChanges(await changedFiles(root, base), config, [STATE_FILE, CONFIG_FILE]);
  const dirty = new Set(await changedFiles(root, "HEAD")); // uncommitted edits to tracked files
  const stale: AreaChange[] = [];
  for (const g of groups) if (await isStale(root, base, g, dirty)) stale.push(g);
  if (stale.length === 0) {
    log(pc.green("✔ Docs are up to date."));
    return 0;
  }

  for (const { area, files } of stale) {
    log(`${pc.red("✗")} ${pc.bold(area.name)}: ${files.length} file${files.length === 1 ? "" : "s"} changed, ${pc.cyan(area.doc)} was not updated`);
    for (const f of files.slice(0, MAX_LISTED)) log(pc.dim(`    ${f}`));
    if (files.length > MAX_LISTED) log(pc.dim(`    ...and ${files.length - MAX_LISTED} more`));
  }
  log(`\n${stale.length} doc${stale.length === 1 ? " is" : "s are"} out of date. Run ${pc.cyan("docsync")} and commit the result.`);
  return 1;
}

/**
 * An area is stale when its code changed after its doc did. Order matters: a doc edit made long ago
 * (or by `docsync init`) must not hide newer code-only commits.
 */
async function isStale(root: string, base: string, { area, files }: AreaChange, dirty: Set<string>): Promise<boolean> {
  if (dirty.has(area.doc)) return false; // doc is being edited right now
  if (files.some((f) => dirty.has(f))) return true; // newer, uncommitted code
  const docCommit = await lastCommitTouching(root, base, [area.doc]);
  if (docCommit === null) return true;
  return touchedSince(root, docCommit, files);
}
