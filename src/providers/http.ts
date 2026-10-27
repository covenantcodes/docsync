export type Fetch = typeof fetch;

/** An HTTP error status from a provider. `retryAfterMs` comes from the Retry-After header when present. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface PostOptions {
  /** Shown in messages, e.g. "OpenAI" or "Ollama". */
  label: string;
  headers?: Record<string, string>;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Hint appended when the server can't be reached. */
  unreachableHint?: string;
  /** Map an HTTP error status to a friendly message; return undefined for the generic one. */
  onStatus?: (status: number, message: string) => string | undefined;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Pulls a human message out of the usual `{error: {message}}` / `{error: "..."}` bodies. */
export function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | { error?: unknown }[];
    const e = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (typeof e === "string") return e;
    if (e && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 300);
}

/** Retry-After as milliseconds (seconds or an HTTP date), or undefined. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function describeFailure(err: unknown, label: string, timeoutMs = DEFAULT_TIMEOUT_MS): Error {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new Error(`${label} did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`, { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** POSTs JSON and returns the live response. Throws `HttpError` for error statuses, plain errors otherwise. */
export async function postRaw(url: string, body: unknown, o: PostOptions): Promise<Response> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...o.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw describeFailure(err, o.label, timeoutMs);
    throw new Error(`Could not reach ${o.label} at ${url}.${o.unreachableHint ? " " + o.unreachableHint : ""}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    const message = errorMessage(await res.text().catch(() => ""));
    throw new HttpError(
      o.onStatus?.(res.status, message) ?? `${o.label} error ${res.status}: ${message}`,
      res.status,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
  return res;
}

/** Lines of a streamed response body, as they arrive. */
export async function* readLines(res: Response): AsyncGenerator<string> {
  if (!res.body) {
    yield* (await res.text()).split("\n");
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}
