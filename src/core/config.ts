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

const FeatureSchema = z.object({
  /** Used on the command line (`docsync generate <name>`), so keep it simple. */
  name: z.string().regex(/^[A-Za-z0-9_-]+$/, "use letters, digits, '-' or '_'"),
  /** Source files that implement the feature. May span several folders and overlap other features and areas. */
  paths: z.array(z.string().min(1)).min(1),
  doc: z.string().min(1),
});

const AreaSchema = z.object({
  name: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  doc: z.string().min(1),
});

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

// Providers where the user must name a model (we don't guess model ids for other vendors or local installs).
const MODEL_REQUIRED = new Set(["openai", "gemini", "ollama", "openai-compatible"]);

// API keys are deliberately not part of the config; they come from the environment.
// `apiKeyEnv` only names the environment variable to read.
const BaseSchema = z.object({
  provider: z.string().default("anthropic"),
  model: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name").optional(),
  /** Ollama only: context window in tokens (num_ctx). */
  contextWindow: z.number().int().positive().optional(),
  /** Max diff characters sent per area. Defaults depend on the provider. */
  maxDiffChars: z.number().int().positive().optional(),
  /** Max characters of source code sent per feature (`docsync generate`). Defaults depend on the provider. */
  maxSourceChars: z.number().int().positive().optional(),
  areas: z.array(AreaSchema).min(1),
  features: z.array(FeatureSchema).default([]),
  ignore: z.array(z.string()).default(DEFAULT_IGNORE),
});

export const ConfigSchema = BaseSchema.superRefine((c, ctx) => {
  if (MODEL_REQUIRED.has(c.provider) && !c.model) {
    ctx.addIssue({ code: "custom", path: ["model"], message: `required for provider "${c.provider}"` });
  }
  const seen = new Set<string>();
  c.features.forEach((f, i) => {
    if (seen.has(f.name)) ctx.addIssue({ code: "custom", path: ["features", i, "name"], message: `duplicate feature "${f.name}"` });
    seen.add(f.name);
  });
  if (c.provider === "openai-compatible" && !c.baseUrl) {
    ctx.addIssue({ code: "custom", path: ["baseUrl"], message: 'required for provider "openai-compatible"' });
  }
}).transform((c) => ({
  ...c,
  model: c.model ?? (c.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : undefined),
}));

export type Area = z.infer<typeof AreaSchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type Config = z.output<typeof ConfigSchema>;

export const defaultConfig = (): Config => ({
  provider: "anthropic",
  model: DEFAULT_ANTHROPIC_MODEL,
  areas: [{ name: "project", paths: ["**"], doc: "docs/OVERVIEW.md" }],
  features: [],
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
