import type { Config } from "../core/config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createCliProvider } from "./cli.js";
import { createManualProvider } from "./manual.js";
import { createOllamaProvider } from "./ollama.js";
import { createOpenAIProvider } from "./openai.js";

export interface Provider {
  complete(system: string, user: string): Promise<string>;
}

export const PROVIDER_NAMES = ["anthropic", "openai", "gemini", "ollama", "openai-compatible", "cli", "manual"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

type ProviderConfig = Pick<Config, "provider"> &
  Partial<Pick<Config, "model" | "baseUrl" | "apiKeyEnv" | "contextWindow" | "maxDiffChars" | "maxSourceChars">>;

// Small local models have small context windows, and a human pasting into a chat UI has limits too.
const DEFAULT_MAX_DIFF_CHARS: Record<string, number> = { ollama: 24_000, manual: 30_000 };
const FALLBACK_MAX_DIFF_CHARS = 60_000;

/** Max diff characters sent per area for this config. */
export function maxDiffChars(config: Pick<Config, "provider" | "maxDiffChars">): number {
  return config.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS[config.provider] ?? FALLBACK_MAX_DIFF_CHARS;
}

// Whole-feature source is bigger than a diff, so its budget is larger.
const DEFAULT_MAX_SOURCE_CHARS: Record<string, number> = { ollama: 30_000, manual: 40_000 };
const FALLBACK_MAX_SOURCE_CHARS = 120_000;

/** Max source-code characters sent per feature for this config. */
export function maxSourceChars(config: Pick<Config, "provider" | "maxSourceChars">): number {
  return config.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS[config.provider] ?? FALLBACK_MAX_SOURCE_CHARS;
}

function requireModel(config: ProviderConfig): string {
  if (!config.model) throw new Error(`Set "model" in docsync.config.json for provider "${config.provider}".`);
  return config.model;
}

/** Builds the provider named in the config. Fails early (before any git work) if credentials are missing. */
export function createProvider(config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): Provider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicProvider({ model: requireModel(config) }, env);
    case "openai":
    case "gemini":
    case "openai-compatible":
      return createOpenAIProvider(
        { provider: config.provider, model: requireModel(config), baseUrl: config.baseUrl, apiKeyEnv: config.apiKeyEnv },
        { env },
      );
    case "ollama":
      return createOllamaProvider({
        model: requireModel(config),
        baseUrl: config.baseUrl,
        contextWindow: config.contextWindow,
      });
    case "cli":
      return createCliProvider(env);
    case "manual":
      return createManualProvider();
    default:
      throw new Error(`Unknown provider "${config.provider}" (supported: ${PROVIDER_NAMES.join(", ")})`);
  }
}
