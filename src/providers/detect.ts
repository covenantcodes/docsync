import { OLLAMA_URL } from "./ollama.js";
import type { Fetch } from "./http.js";
import type { ProviderName } from "./index.js";

export interface Detected {
  /** Providers whose API key is present in the environment. */
  keys: ("anthropic" | "openai" | "gemini")[];
  /** Models installed in a running local Ollama, or null if it isn't reachable. */
  ollamaModels: string[] | null;
}

const KEY_VARS = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" } as const;

/** Looks for keys in the environment and a running Ollama. Never throws; never sends anything anywhere but localhost. */
export async function detectProviders(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: Fetch = fetch,
): Promise<Detected> {
  const keys = (Object.keys(KEY_VARS) as (keyof typeof KEY_VARS)[]).filter((k) => Boolean(env[KEY_VARS[k]]));
  let ollamaModels: string[] | null = null;
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name?: string }[] };
      ollamaModels = (data.models ?? []).flatMap((m) => (m.name ? [m.name] : []));
    }
  } catch {
    // not running
  }
  return { keys, ollamaModels };
}

/** The provider to suggest first: a key you already have, else a local model you already run. */
export function bestGuess(d: Detected): ProviderName | undefined {
  if (d.keys.length > 0) return d.keys[0];
  if (d.ollamaModels && d.ollamaModels.length > 0) return "ollama";
  return undefined;
}
