import { loadConfig } from "../core/config.js";
import { forgetKey, storeKey } from "../core/credentials.js";
import { repoRoot, isGitRepo } from "../core/git.js";

/** Provider from the argument, else from this repo's config, else anthropic. */
async function pickProvider(arg: string | undefined): Promise<{ provider: string; apiKeyEnv?: string | undefined }> {
  if (arg) return { provider: arg };
  if (await isGitRepo(process.cwd())) {
    const c = await loadConfig(await repoRoot(process.cwd()));
    return { provider: c.provider, apiKeyEnv: c.apiKeyEnv };
  }
  return { provider: "anthropic" };
}

export async function login(provider?: string): Promise<number> {
  const p = await pickProvider(provider);
  await storeKey(p.provider, p.apiKeyEnv);
  return 0;
}

export async function logout(provider?: string): Promise<number> {
  const p = await pickProvider(provider);
  await forgetKey(p.provider, p.apiKeyEnv);
  return 0;
}
