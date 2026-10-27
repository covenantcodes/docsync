import { describeFailure, postRaw, readLines, type Fetch } from "./http.js";
import type { Provider } from "./index.js";
import { withRetry } from "./retry.js";

export const OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_CONTEXT_WINDOW = 16384;

export interface OllamaOptions {
  model: string;
  baseUrl?: string | undefined;
  contextWindow?: number | undefined;
  /** "none" turns thinking off; other values are passed to Ollama's `think` option as they are. */
  reasoningEffort?: string | undefined;
}

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

function thinkOption(effort: string | undefined): { think?: boolean | string } {
  if (!effort) return {};
  return { think: effort === "none" ? false : effort };
}

/**
 * Native /api/chat rather than the OpenAI-compatible route, because only the native API lets us set num_ctx.
 * Ollama's default context is small and silently truncates long prompts.
 */
export function createOllamaProvider(opts: OllamaOptions, deps: { fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {}): Provider {
  const base = (opts.baseUrl ?? OLLAMA_URL).replace(/\/+$/, "");
  return {
    async complete(system, user, options) {
      const res = await withRetry(
        () =>
          postRaw(
            `${base}/api/chat`,
            {
              model: opts.model,
              stream: true,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              options: { num_ctx: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
              ...thinkOption(opts.reasoningEffort),
            },
            {
              label: "Ollama",
              ...(deps.fetch ? { fetch: deps.fetch } : {}),
              unreachableHint: "Is Ollama running? Start it with `ollama serve`.",
              onStatus: (status, message) => {
                if (status === 404) return `Ollama doesn't have the model "${opts.model}". Run: ollama pull ${opts.model}`;
                if (status === 400 && /think/i.test(message)) return `Ollama rejected reasoningEffort "${opts.reasoningEffort}": ${message}`;
                return undefined;
              },
            },
          ),
        {
          label: "Ollama",
          ...(options?.onEvent ? { onEvent: options.onEvent } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        },
      );

      let text = "";
      let doneReason: string | undefined;
      try {
        // NDJSON when streaming; a single JSON line if the server answered all at once.
        for await (const line of readLines(res)) {
          if (!line.trim()) continue;
          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(line) as OllamaChunk;
          } catch {
            continue;
          }
          if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
          if (chunk.message?.content) {
            text += chunk.message.content;
            options?.onEvent?.({ type: "progress", chars: text.length });
          }
          if (chunk.done_reason) doneReason = chunk.done_reason;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Ollama error")) throw err;
        const failure = describeFailure(err, "Ollama");
        if (failure !== err) throw failure;
        throw new Error("The connection to Ollama dropped while the reply was streaming.", { cause: err });
      }

      if (doneReason === "length") {
        throw new Error("The model's reply was cut off. Try a larger contextWindow or a smaller maxDiffChars.");
      }
      if (!text) throw new Error("Ollama returned an empty reply.");
      return text;
    },
  };
}
