import pc from "picocolors";
import type { ProviderEvent } from "../providers/index.js";

export interface StatusDeps {
  log: (line: string) => void;
  /** Redraw a live line in place (needs a real terminal). Otherwise only plain log lines are printed. */
  tty: boolean;
  write: (text: string) => void;
  now?: () => number;
}

export interface Status {
  start(label?: string): void;
  event(e: ProviderEvent): void;
  stop(outcome: "done" | "failed"): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR = "\r\x1b[K";

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function describe(e: Exclude<ProviderEvent, { type: "progress" }>): string {
  if (e.type === "retry") {
    return pc.yellow(`  ! ${e.reason}. Retrying in ${Math.max(1, Math.round(e.delayMs / 1000))}s (attempt ${e.attempt + 1} of ${e.maxAttempts})...`);
  }
  return pc.yellow(`  ! The reply wasn't usable (${e.message.split("\n")[0]}). Asking once more...`);
}

/**
 * "Asking the model..." with elapsed time and characters received, redrawn in place on a terminal.
 * Retries and bad-reply notices are printed as permanent lines above it.
 */
export function createStatus(d: StatusDeps): Status {
  const now = d.now ?? Date.now;
  let startedAt = 0;
  let label = "";
  let chars = 0;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const draw = () => {
    const received = chars > 0 ? ` · ${chars.toLocaleString("en-US")} chars received` : "";
    d.write(`${CLEAR}  ${pc.cyan(FRAMES[frame++ % FRAMES.length]!)} ${label} ${pc.dim(formatElapsed(now() - startedAt) + received)}`);
  };

  return {
    start(l = "Asking the model") {
      label = l;
      startedAt = now();
      chars = 0;
      if (d.tty) {
        draw();
        timer = setInterval(draw, 200);
        timer.unref?.();
      } else {
        d.log(pc.dim(`  ${label}...`));
      }
    },
    event(e) {
      if (e.type === "progress") {
        chars = e.chars;
        return;
      }
      if (d.tty) {
        d.write(CLEAR);
        d.log(describe(e));
        draw();
      } else {
        d.log(describe(e));
      }
    },
    stop(outcome) {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (d.tty) d.write(CLEAR);
      if (outcome === "done") d.log(pc.dim(`  Model replied in ${formatElapsed(now() - startedAt)}.`));
    },
  };
}
