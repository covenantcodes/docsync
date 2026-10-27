export type Fetch = typeof fetch;

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
    const e = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof e === "string") return e;
    if (e && typeof (e as { message?: unknown }).message === "string") return (e as { message: string }).message;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 300);
}

/** POSTs JSON and returns the parsed reply. Throws errors that say what to do next. */
export async function postJson(url: string, body: unknown, o: PostOptions): Promise<unknown> {
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
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`${o.label} did not answer within ${Math.round(timeoutMs / 60_000)} minutes.`, { cause: err });
    }
    throw new Error(`Could not reach ${o.label} at ${url}.${o.unreachableHint ? " " + o.unreachableHint : ""}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    const message = errorMessage(await res.text().catch(() => ""));
    throw new Error(o.onStatus?.(res.status, message) ?? `${o.label} error ${res.status}: ${message}`);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${o.label} returned a reply that isn't JSON.`, { cause: err });
  }
}
