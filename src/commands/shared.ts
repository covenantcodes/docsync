import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pc from "picocolors";
import { colorizePatch, renderPatch, type Confirm } from "../core/review.js";

export interface ReviewInput {
  doc: string;
  docPath: string;
  oldDoc: string;
  newDoc: string;
  reasons: { section: string; reason: string }[];
  /** Lines shown after the diff, before the question (e.g. grounding warnings). */
  warnings?: string[];
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
  confirm: Confirm;
  log: (line: string) => void;
}

export type ReviewOutcome = "applied" | "declined" | "dry-run" | "unchanged";

/** Shows reasons and a colored diff, asks to apply (unless --yes), and writes the doc. Nothing is written on --dry-run. */
export async function reviewAndApply(i: ReviewInput): Promise<ReviewOutcome> {
  const patch = renderPatch(i.doc, i.oldDoc, i.newDoc);
  if (i.reasons.length === 0 || patch === "") {
    i.log(pc.dim("  No doc changes needed."));
    return "unchanged";
  }
  for (const r of i.reasons) i.log(`  ${pc.yellow("•")} ${pc.bold(r.section)}: ${r.reason}`);
  i.log("\n" + colorizePatch(patch));
  for (const w of i.warnings ?? []) i.log(w);

  if (i.dryRun) return "dry-run";
  if (!i.yes && !(await i.confirm(`Apply changes to ${i.doc}?`))) {
    i.log(pc.dim("  Skipped."));
    return "declined";
  }
  await mkdir(dirname(i.docPath), { recursive: true });
  await writeFile(i.docPath, i.newDoc);
  i.log(pc.green(`  ✔ Wrote ${i.doc}`));
  return "applied";
}
