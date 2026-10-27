import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { CONFIG_FILE, loadConfig } from "../core/config.js";
import { changedFiles, diffFor, headSha, isGitRepo, repoRoot, resolveBase } from "../core/git.js";
import { groupChanges } from "../core/mapper.js";
import { SYSTEM_PROMPT, buildUserPrompt, redactSecrets, requestEdits, truncateDiff } from "../core/prompt.js";
import { confirmPrompt, type Confirm } from "../core/review.js";
import { applyEdits, readSections } from "../core/sections.js";
import { STATE_FILE, readState, writeState } from "../core/state.js";
import { createProvider, maxDiffChars, type Provider } from "../providers/index.js";
import { reviewAndApply } from "./shared.js";

export interface UpdateOptions {
  since?: string;
  staged?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/** Injectable pieces, so the flow can be tested without a TTY or a real LLM. */
export interface UpdateDeps {
  cwd: string;
  provider?: Provider;
  confirm: Confirm;
  log: (line: string) => void;
  isInteractive: boolean;
  today: () => string;
}

const localDate = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const defaultDeps = (): UpdateDeps => ({
  cwd: process.cwd(),
  confirm: confirmPrompt,
  log: (line) => console.log(line),
  isInteractive: Boolean(process.stdin.isTTY),
  today: localDate,
});

async function readDoc(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

type AreaOutcome = "applied" | "unchanged" | "declined" | "dry-run" | "failed";

/** Runs the full update flow. Returns the process exit code (1 if any area failed). */
export async function update(opts: UpdateOptions, overrides: Partial<UpdateDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const { log } = deps;

  if (!(await isGitRepo(deps.cwd))) {
    throw new Error("Not inside a git repository. Run docsync from your project's git repo.");
  }
  const root = await repoRoot(deps.cwd);
  const config = await loadConfig(root);
  // Created up front so a missing API key fails before any git work.
  const provider = deps.provider ?? createProvider(config);

  if (!opts.yes && !opts.dryRun && !deps.isInteractive) {
    throw new Error("Not running in an interactive terminal. Pass --yes to apply changes, or --dry-run to preview.");
  }

  const state = await readState(root);
  const staged = opts.staged === true;
  const base = staged ? "HEAD" : await resolveBase(root, { since: opts.since, lastSha: state?.lastSha });
  const baseLabel = staged ? "staged changes" : `${base.slice(0, 7)}`;

  // Docs and docsync's own files are outputs, not inputs.
  const groups = groupChanges(await changedFiles(root, base, staged), config, [STATE_FILE, CONFIG_FILE]);

  if (groups.length === 0) {
    log(pc.green("Docs are up to date: no relevant code changes since ") + baseLabel + ".");
    return 0;
  }

  const outcomes: AreaOutcome[] = [];
  for (const { area, files: areaFiles } of groups) {
    log(`\n${pc.bold(pc.cyan(`▸ ${area.name}`))} ${pc.dim(`(${areaFiles.length} changed file${areaFiles.length === 1 ? "" : "s"} → ${area.doc})`)}`);

    const docPath = join(root, area.doc);
    let outcome: AreaOutcome;
    try {
      outcome = await updateArea({ area, areaFiles, docPath, root, base, staged, provider, opts, deps, maxChars: maxDiffChars(config) });
    } catch (err) {
      log(pc.red(`  ✗ ${area.name}: ${err instanceof Error ? err.message : String(err)}`));
      if (process.env.DEBUG === "docsync" && err instanceof Error) log(String(err.stack));
      outcome = "failed";
    }
    outcomes.push(outcome);
  }

  // Only move the marker when nothing was skipped or failed, otherwise those changes would be forgotten.
  const complete = outcomes.every((o) => o === "applied" || o === "unchanged");
  const wroteAny = outcomes.includes("applied");
  const failed = outcomes.includes("failed");

  if (opts.dryRun) {
    log(pc.dim("\nDry run: nothing was written."));
  } else if (staged) {
    log(pc.dim("\nStaged mode: lastSha not advanced."));
  } else if (complete) {
    await writeState(root, { lastSha: await headSha(root) });
    if (wroteAny) log(pc.green("\n✔ Docs updated. ") + pc.dim(`Recorded HEAD in ${STATE_FILE}.`));
    else log(pc.green("\n✔ Docs already match the changes. ") + pc.dim(`Recorded HEAD in ${STATE_FILE}.`));
  } else {
    log(pc.yellow(`\nSome areas were skipped or failed, so ${STATE_FILE} was not advanced.`));
  }
  return failed ? 1 : 0;
}

async function updateArea(a: {
  area: { name: string; doc: string };
  areaFiles: string[];
  docPath: string;
  root: string;
  base: string;
  staged: boolean;
  provider: Provider;
  opts: UpdateOptions;
  deps: UpdateDeps;
  maxChars: number;
}): Promise<AreaOutcome> {
  const { log } = a.deps;

  const raw = await diffFor(a.root, a.base, a.areaFiles, a.staged);
  if (raw.trim() === "") {
    log(pc.dim("  No textual changes (binary or mode-only)."));
    return "unchanged";
  }
  const { text: diff, truncated } = truncateDiff(redactSecrets(raw), a.maxChars);
  if (truncated) log(pc.yellow("  ! Diff is large and was truncated; the docs may miss some changes."));

  const oldDoc = await readDoc(a.docPath);
  const sections = readSections(oldDoc);
  const user = buildUserPrompt({
    area: a.area.name,
    doc: a.area.doc,
    sections,
    files: a.areaFiles,
    diff,
    date: a.deps.today(),
  });

  log(pc.dim("  Asking the model..."));
  const proposed = await requestEdits(a.provider, SYSTEM_PROMPT, user);
  const edits = proposed.filter((e) => (sections[e.section] ?? null) !== e.content.replace(/^\n+|\n+$/g, ""));
  const outcome = await reviewAndApply({
    doc: a.area.doc,
    docPath: a.docPath,
    oldDoc,
    newDoc: applyEdits(oldDoc, edits),
    reasons: edits,
    dryRun: a.opts.dryRun,
    yes: a.opts.yes,
    confirm: a.deps.confirm,
    log,
  });
  return outcome;
}
