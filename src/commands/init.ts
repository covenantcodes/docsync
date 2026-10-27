import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import { CONFIG_FILE, DEFAULT_ANTHROPIC_MODEL, DEFAULT_IGNORE, loadConfig, type Area, type Config } from "../core/config.js";
import { detectAreas, singleProjectArea } from "../core/detect.js";
import { headSha, isGitRepo, repoRoot } from "../core/git.js";
import { starterDoc } from "../core/sections.js";
import { STATE_FILE, readState, writeState } from "../core/state.js";
import { bestGuess, detectProviders, type Detected } from "../providers/detect.js";
import { PROVIDER_NAMES, type ProviderName } from "../providers/index.js";

export interface InitOptions {
  yes?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export type AreaChoice = "use" | "single" | "cancel";

export interface InitDeps {
  cwd: string;
  log: (line: string) => void;
  isInteractive: boolean;
  chooseAreas: (areas: Area[]) => Promise<AreaChoice>;
  detect: () => Promise<Detected>;
  chooseProvider: (detected: Detected, suggested: ProviderName | undefined) => Promise<ProviderName>;
  /** Free-text question; undefined if the user cancels. */
  ask: (question: string, initial?: string) => Promise<string | undefined>;
}

const chooseAreasPrompt: InitDeps["chooseAreas"] = async () => {
  const { choice } = await prompts(
    {
      type: "select",
      name: "choice",
      message: "Use these areas?",
      choices: [
        { title: "Yes, use them", value: "use" },
        { title: "No, use a single project area instead", value: "single" },
        { title: "Cancel", value: "cancel" },
      ],
    },
    { onCancel: () => false },
  );
  return (choice as AreaChoice | undefined) ?? "cancel";
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  ollama: "Ollama (local, no API key)",
  "openai-compatible": "Other OpenAI-compatible server (LM Studio, vLLM, OpenRouter, ...)",
  cli: "A command you already have, e.g. `claude -p` (no API key)",
  manual: "Manual: paste into any AI chat (no API key)",
};

function providerHint(name: ProviderName, d: Detected): string | undefined {
  if ((d.keys as string[]).includes(name)) return "API key found";
  if (name === "ollama" && d.ollamaModels) return `running, ${d.ollamaModels.length} model${d.ollamaModels.length === 1 ? "" : "s"}`;
  return undefined;
}

const chooseProviderPrompt: InitDeps["chooseProvider"] = async (detected, suggested) => {
  const { choice } = await prompts(
    {
      type: "select",
      name: "choice",
      message: "Which model should write your docs?",
      initial: Math.max(0, PROVIDER_NAMES.indexOf(suggested ?? "anthropic")),
      choices: PROVIDER_NAMES.map((name) => {
        const hint = providerHint(name, detected);
        return { title: PROVIDER_LABELS[name] + (hint ? ` [${hint}]` : ""), value: name };
      }),
    },
    { onCancel: () => false },
  );
  if (!choice) throw new Error("Cancelled.");
  return choice as ProviderName;
};

const askPrompt: InitDeps["ask"] = async (question, initial) => {
  const res = await prompts({ type: "text", name: "v", message: question, initial: initial ?? "" }, { onCancel: () => false });
  const v = typeof res.v === "string" ? res.v.trim() : "";
  return v || undefined;
};

const defaultDeps = (): InitDeps => ({
  cwd: process.cwd(),
  log: (line) => console.log(line),
  isInteractive: Boolean(process.stdin.isTTY),
  chooseAreas: chooseAreasPrompt,
  detect: () => detectProviders(),
  chooseProvider: chooseProviderPrompt,
  ask: askPrompt,
});

type ProviderSettings = Pick<Config, "provider" | "model" | "baseUrl">;

/** Works out provider, model and endpoint from flags, what's installed, and (if interactive) the user's answers. */
async function chooseProviderSettings(opts: InitOptions, deps: InitDeps): Promise<ProviderSettings> {
  const detected = await deps.detect();
  const suggested = bestGuess(detected);
  const canAsk = deps.isInteractive && !opts.yes;

  let provider: ProviderName;
  if (opts.provider !== undefined) {
    if (!(PROVIDER_NAMES as readonly string[]).includes(opts.provider)) {
      throw new Error(`Unknown provider "${opts.provider}" (supported: ${PROVIDER_NAMES.join(", ")})`);
    }
    provider = opts.provider as ProviderName;
  } else if (canAsk) {
    provider = await deps.chooseProvider(detected, suggested);
  } else {
    provider = suggested ?? "anthropic";
  }

  const settings: ProviderSettings = { provider, model: undefined, baseUrl: undefined };
  const need = async (what: string, flag: string, given: string | undefined, initial?: string): Promise<string> => {
    const v = given ?? (canAsk ? await deps.ask(what, initial) : undefined);
    if (!v) throw new Error(`Provider "${provider}" needs ${what.toLowerCase()}. Pass ${flag}.`);
    return v;
  };

  switch (provider) {
    case "anthropic":
      if (opts.model) settings.model = opts.model;
      break;
    case "openai":
    case "gemini":
      settings.model = await need("A model name", "--model <name>", opts.model);
      break;
    case "ollama":
      settings.model = opts.model ?? detected.ollamaModels?.[0] ?? (await need("An installed Ollama model", "--model <name>", undefined));
      if (opts.baseUrl) settings.baseUrl = opts.baseUrl;
      break;
    case "openai-compatible":
      settings.baseUrl = await need("The server's base URL (e.g. http://localhost:1234/v1)", "--base-url <url>", opts.baseUrl);
      settings.model = await need("A model name", "--model <name>", opts.model);
      break;
    case "cli":
    case "manual":
      break;
  }
  return settings;
}

function nextSteps(config: Config): string[] {
  const keyVar = config.apiKeyEnv ?? { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" }[config.provider];
  switch (config.provider) {
    case "ollama":
      return [`Make sure Ollama is running and has the model:  ${pc.cyan(`ollama pull ${config.model}`)}`];
    case "cli":
      return [`Tell docsync which command to run:  ${pc.cyan('export DOCSYNC_CLI="claude -p"')}`];
    case "manual":
      return ["No setup needed: docsync will give you a prompt to paste into any AI chat."];
    case "openai-compatible":
      return config.apiKeyEnv ? [`Set your API key:  ${pc.cyan(`export ${config.apiKeyEnv}=...`)}`] : ["Make sure the server is running."];
    default:
      return [`Set your API key:  ${pc.cyan(`export ${keyVar}=...`)}`];
  }
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Sets up config, starter docs and the state file. Safe to re-run: existing files are never overwritten. */
export async function init(opts: InitOptions = {}, overrides: Partial<InitDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  const { log } = deps;

  if (!(await isGitRepo(deps.cwd))) {
    throw new Error("Not inside a git repository. Run docsync init from your project's git repo.");
  }
  const root = await repoRoot(deps.cwd);
  let head: string;
  try {
    head = await headSha(root);
  } catch {
    throw new Error("This repository has no commits yet. Make a first commit, then run docsync init.");
  }

  // 1. config
  const configPath = join(root, CONFIG_FILE);
  let config: Config;
  if (await exists(configPath)) {
    config = await loadConfig(root);
    log(pc.dim(`${CONFIG_FILE} already exists, keeping it.`));
  } else {
    const { areas, source } = await detectAreas(root);
    let chosen: Area[];
    if (areas.length === 0) {
      log(pc.dim("No workspaces detected, using a single project area."));
      chosen = [singleProjectArea()];
    } else {
      log(`Detected ${areas.length} area${areas.length === 1 ? "" : "s"} from ${source}:`);
      for (const a of areas) log(`  ${pc.cyan(a.name.padEnd(14))} ${a.paths.join(", ")} ${pc.dim("→")} ${a.doc}`);
      let choice: AreaChoice = "use";
      if (!opts.yes) {
        if (!deps.isInteractive) {
          throw new Error("Not running in an interactive terminal. Pass --yes to accept the detected areas.");
        }
        choice = await deps.chooseAreas(areas);
      }
      if (choice === "cancel") {
        log(pc.dim("Cancelled. Nothing was written."));
        return 1;
      }
      chosen = choice === "use" ? areas : [singleProjectArea()];
    }
    const settings = await chooseProviderSettings(opts, deps);
    config = {
      provider: settings.provider,
      model: settings.model ?? (settings.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : undefined),
      baseUrl: settings.baseUrl,
      apiKeyEnv: undefined,
      contextWindow: undefined,
      maxDiffChars: undefined,
      maxSourceChars: undefined,
      areas: chosen,
      features: [],
      ignore: [...DEFAULT_IGNORE],
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    log(pc.green(`✔ Wrote ${CONFIG_FILE}`));
  }

  // 2. docs
  for (const area of config.areas) {
    const docPath = join(root, area.doc);
    if (await exists(docPath)) {
      log(pc.dim(`  ${area.doc} exists, leaving it as is.`));
      continue;
    }
    await mkdir(dirname(docPath), { recursive: true });
    await writeFile(docPath, starterDoc(titleCase(area.name)));
    log(pc.green(`✔ Created ${area.doc}`));
  }

  // 3. state
  if (await readState(root)) {
    log(pc.dim(`${STATE_FILE} already exists, keeping it.`));
  } else {
    await writeState(root, { lastSha: head });
    log(pc.green(`✔ Wrote ${STATE_FILE}`) + pc.dim(` (at ${head.slice(0, 7)})`));
  }

  log(`
${pc.bold("Next steps")}
  1. ${nextSteps(config).join("\n     ")}
  2. Make some changes, commit them, then run:  ${pc.cyan("npx docsync")}
  3. Commit ${CONFIG_FILE}, ${STATE_FILE} and your docs.`);
  return 0;
}
