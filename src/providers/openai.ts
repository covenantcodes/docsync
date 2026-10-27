import { describeFailure, postRaw, readLines, type Fetch } from "./http.js";
import type { Provider } from "./index.js";
import { withRetry } from "./retry.js";

interface Preset {
  label: string;
  baseUrl?: string;
  keyEnv?: string;
  keyRequired: boolean;
}

const PRESETS: Record<string, Preset> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", keyRequired: true },
  gemini: {
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnv: "GEMINI_API_KEY",
    keyRequired: true,
  },
  "openai-compatible": { label: "the OpenAI-compatible server", keyRequired: false },
};

export interface OpenAIOptions {
  provider: "openai" | "gemini" | "openai-compatible";
  model: string;
  baseUrl?: string | undefined;
  apiKeyEnv?: string | undefined;
  /** Sent as `reasoning_effort` when set. */
  reasoningEffort?: string | undefined;
}

interface Choice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}
interface ChatChunk {
  choices?: Choice[];
  error?: { message?: string };
}

/** Anything that speaks `/chat/completions`: OpenAI, Gemini's compat endpoint, OpenRouter, Groq, LM Studio, vLLM, ... */
export function createOpenAIProvider(
  opts: OpenAIOptions,
  deps: { env?: NodeJS.ProcessEnv; fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {},
): Provider {
  const env = deps.env ?? process.env;
  const preset = PRESETS[opts.provider]!;
  const baseUrl = (opts.baseUrl ?? preset.baseUrl ?? "").replace(/\/+$/, "");
  const keyEnv = opts.apiKeyEnv ?? preset.keyEnv;
  const key = keyEnv ? env[keyEnv] : undefined;
  if ((preset.keyRequired || opts.apiKeyEnv) && !key) {
    throw new Error(`${keyEnv} is not set. Export it in your shell, then run docsync again.`);
  }

  return {
    async complete(system, user, options) {
      const body = {
        model: opts.model,
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      };
      const res = await withRetry(
        () =>
          postRaw(`${baseUrl}/chat/completions`, body, {
            label: preset.label,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            headers: key ? { authorization: `Bearer ${key}` } : {},
            unreachableHint: opts.provider === "openai-compatible" ? "Check baseUrl in docsync.config.json." : "Check your network connection.",
            onStatus: (status, message) => {
              if (status === 401 || status === 403) return `${preset.label} rejected the API key (${status}). Check ${keyEnv ?? "your credentials"}.`;
              if (status === 404) return `${preset.label} returned 404: ${message || "unknown model or URL"}. Check "model" and "baseUrl" in docsync.config.json.`;
              if (status === 429) return `${preset.label} rate limit hit (429). Try again shortly.`;
              if (status === 400 && opts.reasoningEffort && /reasoning|effort/i.test(message)) {
                return `${preset.label} rejected reasoningEffort "${opts.reasoningEffort}": ${message}`;
              }
              return undefined;
            },
          }),
        {
          label: preset.label,
          ...(options?.onEvent ? { onEvent: options.onEvent } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        },
      );

      let text = "";
      let finish: string | null | undefined;
      try {
        if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
          for await (const line of readLines(res)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") break;
            let chunk: ChatChunk;
            try {
              chunk = JSON.parse(data) as ChatChunk;
            } catch {
              continue;
            }
            if (chunk.error) throw new Error(`${preset.label} error: ${chunk.error.message ?? "unknown"}`);
            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) {
              text += choice.delta.content;
              options?.onEvent?.({ type: "progress", chars: text.length });
            }
            if (choice?.finish_reason) finish = choice.finish_reason;
          }
        } else {
          // Some servers ignore `stream: true` and send one JSON document.
          const choice = ((await res.json()) as ChatChunk).choices?.[0];
          text = choice?.message?.content ?? "";
          finish = choice?.finish_reason;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(`${preset.label} error`)) throw err;
        const failure = describeFailure(err, preset.label);
        if (failure !== err) throw failure;
        throw new Error(`The connection to ${preset.label} dropped while the reply was streaming.`, { cause: err });
      }

      if (finish === "length") throw new Error("The model's reply was cut off (output limit reached).");
      if (finish === "content_filter") throw new Error("The model declined this request (content filter).");
      if (!text) throw new Error(`${preset.label} returned an empty reply.`);
      return text;
    },
  };
}
