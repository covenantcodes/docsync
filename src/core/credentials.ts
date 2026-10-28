import prompts from "prompts";
import { detectKeyStore, NO_KEYSTORE_HINT, type KeyStore } from "./keystore.js";

const DEFAULT_KEY_VARS: Record<string, { envVar: string; label: string }> = {
  anthropic: { envVar: "ANTHROPIC_API_KEY", label: "Anthropic" },
  openai: { envVar: "OPENAI_API_KEY", label: "OpenAI" },
  gemini: { envVar: "GEMINI_API_KEY", label: "Gemini" },
};

/** The environment variable that holds this provider's API key, or undefined if it needs none. */
export function keyVarFor(config: { provider: string; apiKeyEnv?: string | undefined }): { envVar: string; label: string } | undefined {
  const preset = DEFAULT_KEY_VARS[config.provider];
  if (config.apiKeyEnv) return { envVar: config.apiKeyEnv, label: preset?.label ?? config.apiKeyEnv };
  return preset;
}

export interface CredentialDeps {
  isInteractive: boolean;
  confirm: (message: string) => Promise<boolean>;
  secret: (message: string) => Promise<string | undefined>;
  log: (line: string) => void;
  store: () => Promise<KeyStore | undefined>;
}

export const defaultCredentialDeps = (): CredentialDeps => ({
  isInteractive: Boolean(process.stdin.isTTY),
  confirm: async (message) => {
    const { ok } = await prompts({ type: "confirm", name: "ok", message, initial: true }, { onCancel: () => false });
    return ok === true;
  },
  secret: async (message) => {
    const { v } = await prompts({ type: "password", name: "v", message }, { onCancel: () => false });
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  },
  log: (line) => console.log(line),
  store: () => detectKeyStore(),
});

/**
 * Returns an environment containing the provider's API key if one can be found.
 * Order: the real environment, then (interactive terminals only) a key in the OS secret store, then a prompt
 * that can save the key there. Non-interactive runs such as CI only ever use the environment. If nothing is
 * found the env is returned unchanged, so the provider raises its usual "KEY is not set" error.
 */
export async function resolveEnv(
  config: { provider: string; apiKeyEnv?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CredentialDeps> = {},
): Promise<NodeJS.ProcessEnv> {
  const target = keyVarFor(config);
  if (!target || env[target.envVar]) return env;
  const deps = { ...defaultCredentialDeps(), ...overrides };
  if (!deps.isInteractive) return env;

  const store = await deps.store();
  const saved = await store?.get(target.envVar).catch(() => undefined);
  if (store && saved && (await deps.confirm(`Use your ${target.label} API key saved in ${store.name}?`))) {
    return { ...env, [target.envVar]: saved };
  }

  deps.log(`${target.envVar} is not set.`);
  const key = await deps.secret(`Paste your ${target.label} API key (leave empty to cancel)`);
  if (!key) return env;
  if (store) {
    if (await deps.confirm(`Save it in ${store.name} for future projects?`)) {
      try {
        await store.set(target.envVar, key);
        deps.log(`Saved. Remove it any time with: docsync logout ${config.provider}`);
      } catch (err) {
        deps.log(`Could not save the key: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    deps.log(`Not saved. ${NO_KEYSTORE_HINT[process.platform] ?? "No secure key store is available on this system."}`);
  }
  return { ...env, [target.envVar]: key };
}

export async function storeKey(provider: string, apiKeyEnv: string | undefined, deps: Partial<CredentialDeps> = {}): Promise<void> {
  const d = { ...defaultCredentialDeps(), ...deps };
  const target = keyVarFor({ provider, apiKeyEnv });
  if (!target) throw new Error(`"${provider}" doesn't use an API key. Providers with keys: ${Object.keys(DEFAULT_KEY_VARS).join(", ")}.`);
  const store = await d.store();
  if (!store) throw new Error(NO_KEYSTORE_HINT[process.platform] ?? "No secure key store is available on this system. Use the environment variable instead.");
  const key = await d.secret(`Paste your ${target.label} API key`);
  if (!key) throw new Error("No key entered.");
  await store.set(target.envVar, key);
  d.log(`Saved ${target.envVar} in ${store.name}.`);
}

export async function forgetKey(provider: string, apiKeyEnv: string | undefined, deps: Partial<CredentialDeps> = {}): Promise<boolean> {
  const d = { ...defaultCredentialDeps(), ...deps };
  const target = keyVarFor({ provider, apiKeyEnv });
  if (!target) throw new Error(`"${provider}" doesn't use an API key.`);
  const store = await d.store();
  const removed = (await store?.remove(target.envVar)) ?? false;
  d.log(removed ? `Removed ${target.envVar} from ${store!.name}.` : `No saved ${target.envVar} found.`);
  return removed;
}
