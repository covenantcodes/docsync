import { execa } from "execa";
import type { Provider } from "./index.js";

const TIMEOUT_MS = 10 * 60_000;

/** Splits a command line into argv: whitespace separated, with '...' and "..." quoting. No shell is involved. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) throw new Error(`Unterminated quote in DOCSYNC_CLI: ${cmd}`);
  if (started || cur) out.push(cur);
  return out;
}

/**
 * Pipes the prompt to a command you already have (for example `claude -p`) and reads its stdout.
 * The command comes from the DOCSYNC_CLI environment variable, never from the committed config, so a
 * repository can't make docsync run a program on your machine.
 */
export function createCliProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const raw = env.DOCSYNC_CLI?.trim();
  if (!raw) {
    throw new Error(
      'Provider "cli" needs the DOCSYNC_CLI environment variable, for example:\n  export DOCSYNC_CLI="claude -p"',
    );
  }
  const [cmd, ...args] = splitCommand(raw);
  if (!cmd) throw new Error("DOCSYNC_CLI is empty.");

  return {
    async complete(system, user) {
      let stdout: string;
      try {
        ({ stdout } = await execa(cmd, args, { input: `${system}\n\n---\n\n${user}`, timeout: TIMEOUT_MS }));
      } catch (err) {
        const e = err as { code?: string; timedOut?: boolean; exitCode?: number; stderr?: string };
        if (e.code === "ENOENT") throw new Error(`Command not found: ${cmd} (from DOCSYNC_CLI).`, { cause: err });
        if (e.timedOut) throw new Error(`${cmd} did not answer within 10 minutes.`, { cause: err });
        const detail = (e.stderr ?? "").trim().split("\n").slice(-5).join("\n");
        throw new Error(`${cmd} exited with code ${e.exitCode ?? "?"}${detail ? `:\n${detail}` : ""}`, { cause: err });
      }
      if (!stdout.trim()) throw new Error(`${cmd} produced no output.`);
      return stdout;
    },
  };
}
