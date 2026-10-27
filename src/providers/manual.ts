import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import type { Provider } from "./index.js";

export interface ManualDeps {
  isInteractive: boolean;
  print: (line: string) => void;
  /** Resolves when the user says the reply is saved. */
  waitForEnter: () => Promise<void>;
  /** Best-effort copy to the clipboard; returns whether it worked. */
  copy: (text: string) => Promise<boolean>;
}

async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  for (const [cmd, args] of candidates) {
    const res = await execa(cmd, args, { input: text, reject: false, timeout: 3000 });
    if (!res.failed) return true;
  }
  return false;
}

const defaults = (): ManualDeps => ({
  isInteractive: Boolean(process.stdin.isTTY),
  print: (line) => console.log(line),
  waitForEnter: async () => {
    const res = await prompts({ type: "text", name: "go", message: "Press Enter once the reply is saved" }, { onCancel: () => false });
    if (!("go" in res)) throw new Error("Cancelled.");
  },
  copy: copyToClipboard,
});

/** No API at all: you paste the prompt into any AI chat and save its JSON reply to a file. */
export function createManualProvider(overrides: Partial<ManualDeps> = {}): Provider {
  const deps = { ...defaults(), ...overrides };
  return {
    async complete(system, user) {
      if (!deps.isInteractive) {
        throw new Error('Provider "manual" needs an interactive terminal (you paste the model\'s reply by hand).');
      }
      const dir = await mkdtemp(join(tmpdir(), "docsync-"));
      const promptFile = join(dir, "prompt.md");
      const replyFile = join(dir, "reply.json");
      try {
        const prompt = `${system}\n\n---\n\n${user}\n`;
        await writeFile(promptFile, prompt);
        await writeFile(replyFile, "");
        const copied = await deps.copy(prompt);
        deps.print(
          `\n${pc.bold("Manual mode")}\n` +
            `  1. Give this prompt to an AI chat of your choice: ${copied ? "it is on your clipboard, and also in " : ""}${pc.cyan(promptFile)}\n` +
            `  2. Save the JSON it replies with to ${pc.cyan(replyFile)}`,
        );
        await deps.waitForEnter();
        const reply = await readFile(replyFile, "utf8");
        if (!reply.trim()) throw new Error(`No reply found in ${replyFile}.`);
        return reply;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
