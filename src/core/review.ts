import { createTwoFilesPatch } from "diff";
import pc from "picocolors";
import prompts from "prompts";

/** Unified diff of a doc, old vs new. Empty string when nothing changed. */
export function renderPatch(doc: string, oldText: string, newText: string): string {
  if (oldText === newText) return "";
  return createTwoFilesPatch(`a/${doc}`, `b/${doc}`, oldText, newText, undefined, undefined, { context: 3 });
}

export function colorizePatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("Index:") || line.startsWith("===")) {
        return pc.bold(line);
      }
      if (line.startsWith("@@")) return pc.cyan(line);
      if (line.startsWith("+")) return pc.green(line);
      if (line.startsWith("-")) return pc.red(line);
      return line;
    })
    .join("\n");
}

export type Confirm = (question: string) => Promise<boolean>;

/** Interactive y/n prompt. Ctrl-C counts as "no". */
export const confirmPrompt: Confirm = async (question) => {
  const { ok } = await prompts({ type: "confirm", name: "ok", message: question, initial: true }, { onCancel: () => false });
  return ok === true;
};
