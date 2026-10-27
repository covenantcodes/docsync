import { HttpError } from "./http.js";
import type { CompleteOptions } from "./index.js";

// Overloaded / rate limited / transient server trouble. Not 400, 401, 403 or 404: retrying those can't help.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);
const BASE_DELAYS_MS = [2_000, 5_000, 15_000];
const MAX_RETRY_AFTER_MS = 60_000;

export interface RetryOptions {
  /** e.g. "Gemini" */
  label: string;
  onEvent?: CompleteOptions["onEvent"];
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: number[];
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function reasonFor(label: string, status: number): string {
  const name = label.charAt(0).toUpperCase() + label.slice(1);
  if (status === 429) return `${name} rate limit hit (429)`;
  if (status === 503 || status === 529) return `${name} is overloaded (${status})`;
  return `${name} returned an error (${status})`;
}

/** Runs `fn`, retrying transient HTTP failures with a visible message each time. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const delays = o.delaysMs ?? BASE_DELAYS_MS;
  const maxAttempts = delays.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof HttpError) || !RETRYABLE.has(err.status)) throw err;
      if (attempt >= maxAttempts) {
        throw new Error(`${err.message} (gave up after ${maxAttempts} attempts)`, { cause: err });
      }
      const delayMs = Math.min(err.retryAfterMs ?? delays[attempt - 1]!, MAX_RETRY_AFTER_MS);
      o.onEvent?.({ type: "retry", attempt, maxAttempts, delayMs, reason: reasonFor(o.label, err.status) });
      await (o.sleep ?? sleepFor)(delayMs);
    }
  }
}
