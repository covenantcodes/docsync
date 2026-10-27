import { postJson, type Fetch } from "./http.js";
import type { Provider } from "./index.js";

export const OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_CONTEXT_WINDOW = 16384;

export interface OllamaOptions {
  model: string;
  baseUrl?: string | undefined;
  contextWindow?: number | undefined;
}

interface OllamaReply {
  message?: { content?: string };
  done_reason?: string;
}

/**
 * Native /api/chat rather than the OpenAI-compatible route, because only the native API lets us set num_ctx.
 * Ollama's default context is small and silently truncates long prompts.
 */
export function createOllamaProvider(opts: OllamaOptions, deps: { fetch?: Fetch } = {}): Provider {
  const base = (opts.baseUrl ?? OLLAMA_URL).replace(/\/+$/, "");
  return {
    async complete(system, user) {
      const data = (await postJson(
        `${base}/api/chat`,
        {
          model: opts.model,
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          options: { num_ctx: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
        },
        {
          label: "Ollama",
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          unreachableHint: "Is Ollama running? Start it with `ollama serve`.",
          onStatus: (status) =>
            status === 404 ? `Ollama doesn't have the model "${opts.model}". Run: ollama pull ${opts.model}` : undefined,
        },
      )) as OllamaReply;

      if (data.done_reason === "length") {
        throw new Error("The model's reply was cut off. Try a larger contextWindow or a smaller maxDiffChars.");
      }
      const text = data.message?.content;
      if (!text) throw new Error("Ollama returned an empty reply.");
      return text;
    },
  };
}
