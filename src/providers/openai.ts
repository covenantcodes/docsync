import { postJson, type Fetch } from "./http.js";
import type { Provider } from "./index.js";

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
}

interface ChatReply {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
}

/** Anything that speaks `/chat/completions`: OpenAI, Gemini's compat endpoint, OpenRouter, Groq, LM Studio, vLLM, ... */
export function createOpenAIProvider(
  opts: OpenAIOptions,
  deps: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {},
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
    async complete(system, user) {
      const data = (await postJson(
        `${baseUrl}/chat/completions`,
        {
          model: opts.model,
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        {
          label: preset.label,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          headers: key ? { authorization: `Bearer ${key}` } : {},
          unreachableHint: opts.provider === "openai-compatible" ? "Check baseUrl in docsync.config.json." : "Check your network connection.",
          onStatus: (status, message) => {
            if (status === 401 || status === 403) return `${preset.label} rejected the API key (${status}). Check ${keyEnv ?? "your credentials"}.`;
            if (status === 404) return `${preset.label} returned 404: ${message || "unknown model or URL"}. Check "model" and "baseUrl" in docsync.config.json.`;
            if (status === 429) return `${preset.label} rate limit hit (429). Try again shortly.`;
            return undefined;
          },
        },
      )) as ChatReply;

      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("The model's reply was cut off (output limit reached).");
      if (choice?.finish_reason === "content_filter") throw new Error("The model declined this request (content filter).");
      const text = choice?.message?.content;
      if (!text) throw new Error(`${preset.label} returned an empty reply.`);
      return text;
    },
  };
}
