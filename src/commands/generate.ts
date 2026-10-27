import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { CONFIG_FILE, loadConfig, type Feature } from "../core/config.js";
import { FEATURE_SECTIONS, FEATURE_SYSTEM_PROMPT, buildFeaturePrompt } from "../core/feature-prompt.js";
import { isGitRepo, repoRoot, trackedFiles } from "../core/git.js";
import { requestEdits } from "../core/prompt.js";
import { applyEdits, readSections } from "../core/sections.js";
import { collectSources, selectFeatureFiles } from "../core/source.js";
import { STATE_FILE } from "../core/state.js";
import { verifyEdits, type Finding } from "../core/verify.js";
import { createProvider, maxSourceChars } from "../providers/index.js";
import { reviewAndApply } from "./shared.js";
import type { UpdateDeps } from "./update.js";
import { confirmPrompt } from "../core/review.js";

export interface GenerateOptions {
  dryRun?: boolean;
  yes?: boolean;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]+/g, " ");

const EXAMPLE = `"features": [
    { "name": "bills-payment", "paths": ["apps/mobile/src/bills/**", "services/api/src/bills/**"], "doc": "docs/features/bills-payment.md" }
  ]`;

async function readDoc(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function describeFindings(findings: Finding[]): string[] {
  if (findings.length === 0) return [pc.dim("  ✓ Every route, field, env var and cited file in the doc appears in the source that was sent.")];
  return [
    pc.yellow(`  ⚠ ${findings.length} item${findings.length === 1 ? "" : "s"} in the doc could not be matched to the source. Check before applying:`),
    ...findings.map((f) => pc.yellow(`    - ${f.section}: ${f.kind} ${pc.bold(f.value)} (${f.detail})`)),
  ];
}

/**
 * Writes feature docs from the source code itself (not from a diff).
 * Returns the process exit code. Does not touch .docsync.json: that cursor belongs to `update`.
 */
export async function generate(
  featureName: string | undefined,
  opts: GenerateOptions,
  overrides: Partial<UpdateDeps> = {},
): Promise<number> {
  const deps: UpdateDeps = {
    cwd: process.cwd(),
    confirm: confirmPrompt,
    log: (line) => console.log(line),
    isInteractive: Boolean(process.stdin.isTTY),
    today: () => "",
    ...overrides,
  };
  const { log } = deps;

  if (!(await isGitRepo(deps.cwd))) {
    throw new Error("Not inside a git repository. Run docsync from your project's git repo.");
  }
  const root = await repoRoot(deps.cwd);
  const config = await loadConfig(root);
  if (config.features.length === 0) {
    throw new Error(`No features configured. Add some to ${CONFIG_FILE}, for example:\n  ${EXAMPLE}`);
  }

  let features: Feature[] = config.features;
  if (featureName !== undefined) {
    features = config.features.filter((f) => f.name === featureName);
    if (features.length === 0) {
      throw new Error(`Unknown feature "${featureName}". Configured: ${config.features.map((f) => f.name).join(", ")}`);
    }
  }

  const provider = deps.provider ?? createProvider(config);
  if (!opts.yes && !opts.dryRun && !deps.isInteractive) {
    throw new Error("Not running in an interactive terminal. Pass --yes to apply changes, or --dry-run to preview.");
  }

  const tracked = await trackedFiles(root);
  const own = [STATE_FILE, CONFIG_FILE, ...config.areas.map((a) => a.doc), ...config.features.map((f) => f.doc)];
  const budget = maxSourceChars(config);
  let failed = false;

  for (const feature of features) {
    log(`\n${pc.bold(pc.cyan(`▸ ${feature.name}`))} ${pc.dim(`→ ${feature.doc}`)}`);
    try {
      const matched = selectFeatureFiles(tracked, feature, config.ignore, own);
      const { files, omitted } = await collectSources(root, matched, budget);
      if (files.length === 0) {
        throw new Error(`No readable source files match ${feature.paths.join(", ")} (only git-tracked files are read).`);
      }
      log(pc.dim(`  Reading ${files.length} file${files.length === 1 ? "" : "s"} (${files.reduce((n, f) => n + f.content.length, 0).toLocaleString()} chars).`));
      if (omitted.length > 0) {
        log(pc.yellow(`  ! ${omitted.length} file${omitted.length === 1 ? "" : "s"} left out (too large or over the ${budget.toLocaleString()}-char budget); the doc may miss behaviour in: ${omitted.slice(0, 3).join(", ")}${omitted.length > 3 ? ", ..." : ""}`));
      }

      const docPath = join(root, feature.doc);
      const existing = await readDoc(docPath);
      const oldDoc = existing ?? `# ${titleCase(feature.name)}\n`;
      const sections = readSections(oldDoc);

      log(pc.dim("  Asking the model..."));
      const proposed = await requestEdits(
        provider,
        FEATURE_SYSTEM_PROMPT,
        buildFeaturePrompt({ feature: feature.name, doc: feature.doc, sections, files, omitted }),
      );

      const order = FEATURE_SECTIONS.map((s) => s.name);
      const known = proposed.filter((e) => order.includes(e.section));
      if (known.length < proposed.length) log(pc.dim(`  Ignored ${proposed.length - known.length} section(s) outside the feature template.`));
      const edits = known
        .filter((e) => (sections[e.section] ?? null) !== e.content.replace(/^\n+|\n+$/g, ""))
        .sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));

      await reviewAndApply({
        doc: feature.doc,
        docPath,
        oldDoc,
        newDoc: applyEdits(oldDoc, edits),
        reasons: edits,
        warnings: edits.length ? describeFindings(verifyEdits(edits, files)) : [],
        dryRun: opts.dryRun,
        yes: opts.yes,
        confirm: deps.confirm,
        log,
      });
    } catch (err) {
      failed = true;
      log(pc.red(`  ✗ ${feature.name}: ${err instanceof Error ? err.message : String(err)}`));
      if (process.env.DEBUG === "docsync" && err instanceof Error) log(String(err.stack));
    }
  }

  if (opts.dryRun) log(pc.dim("\nDry run: nothing was written."));
  return failed ? 1 : 0;
}
