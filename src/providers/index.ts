import type { Config } from "../core/config.js";
import { createAnthropicProvider } from "./anthropic.js";

export interface Provider {
  complete(system: string, user: string): Promise<string>;
}

/** Builds the provider named in the config. Fails early (before any git work) if credentials are missing. */
export function createProvider(config: Pick<Config, "provider" | "model">): Provider {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicProvider({ model: config.model });
    default:
      throw new Error(`Unknown provider "${config.provider}" (supported: anthropic)`);
  }
}
