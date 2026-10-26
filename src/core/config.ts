import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_FILE = "docsync.config.json";

export const DEFAULT_IGNORE = [
  "**/*.lock",
  "**/package-lock.json",
  "**/assets/**",
  "**/.env*",
  "**/dist/**",
];

const AreaSchema = z.object({
  name: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  doc: z.string().min(1),
});

// API keys are deliberately not part of the config; they come from the environment.
export const ConfigSchema = z.object({
  provider: z.string().default("anthropic"),
  model: z.string().default("claude-sonnet-5-5"),
  areas: z.array(AreaSchema).min(1),
  ignore: z.array(z.string()).default(DEFAULT_IGNORE),
});

export type Area = z.infer<typeof AreaSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const defaultConfig = (): Config => ({
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  areas: [{ name: "project", paths: ["**"], doc: "docs/OVERVIEW.md" }],
  ignore: [...DEFAULT_IGNORE],
});

export function parseConfig(raw: unknown): Config {
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) throw new Error(`Invalid ${CONFIG_FILE}:\n${z.prettifyError(res.error)}`);
  return res.data;
}

/** Loads docsync.config.json from `root`; falls back to a single "project" area if absent. */
export async function loadConfig(root: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
