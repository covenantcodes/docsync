import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStatus, formatElapsed } from "../src/core/progress.js";
import { requestEdits } from "../src/core/prompt.js";
import type { Provider, ProviderEvent } from "../src/providers/index.js";

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");

describe("formatElapsed", () => {
  it("formats seconds and minutes", () => {
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(300_000)).toBe("5m 00s");
  });
});

describe("createStatus (plain output)", () => {
  it("prints start, retry notices and the finish line as plain lines", () => {
    let t = 0;
    const lines: string[] = [];
    const s = createStatus({ log: (l) => lines.push(strip(l)), tty: false, write: () => {}, now: () => t });
    s.start();
    s.event({ type: "progress", chars: 100 });
    s.event({ type: "retry", attempt: 1, maxAttempts: 4, delayMs: 5000, reason: "Gemini is overloaded (503)" });
    s.event({ type: "invalid-reply", message: "reply is not valid JSON: x\nmore" });
    t = 48_000;
    s.stop("done");
    expect(lines).toEqual([
      "  Asking the model...",
      "  ! Gemini is overloaded (503). Retrying in 5s (attempt 2 of 4)...",
      "  ! The reply wasn't usable (reply is not valid JSON: x). Asking once more...",
      "  Model replied in 48s.",
    ]);
  });

  it("prints no 'replied' line on failure", () => {
    const lines: string[] = [];
    const s = createStatus({ log: (l) => lines.push(l), tty: false, write: () => {} });
    s.start();
    s.stop("failed");
    expect(lines).toHaveLength(1);
  });
});

describe("createStatus (terminal)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("redraws elapsed time and characters received in place", () => {
    let t = 0;
    const writes: string[] = [];
    const lines: string[] = [];
    const s = createStatus({ log: (l) => lines.push(strip(l)), tty: true, write: (w) => writes.push(strip(w)), now: () => t });
    s.start("Asking the model");
    expect(writes.at(-1)).toContain("Asking the model 0s");
    t = 12_000;
    s.event({ type: "progress", chars: 1234 });
    vi.advanceTimersByTime(250);
    expect(writes.at(-1)).toContain("12s · 1,234 chars received");
    s.stop("done");
    expect(lines.at(-1)).toBe("  Model replied in 12s.");
    const before = writes.length;
    vi.advanceTimersByTime(2000);
    expect(writes.length).toBe(before); // timer stopped
  });

  it("clears the line, prints the retry notice, then redraws", () => {
    const writes: string[] = [];
    const lines: string[] = [];
    const s = createStatus({ log: (l) => lines.push(strip(l)), tty: true, write: (w) => writes.push(w), now: () => 0 });
    s.start();
    const before = writes.length;
    s.event({ type: "retry", attempt: 1, maxAttempts: 4, delayMs: 2000, reason: "X is overloaded (503)" });
    expect(lines).toEqual(["  ! X is overloaded (503). Retrying in 2s (attempt 2 of 4)..."]);
    expect(writes.length).toBe(before + 2); // clear + redraw
    s.stop("failed");
  });
});

describe("requestEdits events", () => {
  it("tells the caller about a bad reply before asking again", async () => {
    const events: ProviderEvent[] = [];
    const complete = vi.fn<Provider["complete"]>().mockResolvedValueOnce("nope").mockResolvedValueOnce("[]");
    await requestEdits({ complete }, "s", "u", (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "invalid-reply" });
    expect(complete.mock.calls[0]![2]).toEqual({ onEvent: expect.any(Function) });
  });
});
