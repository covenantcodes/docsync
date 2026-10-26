import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pc from "picocolors";
import prompts from "prompts";
import { CONFIG_FILE, DEFAULT_IGNORE, loadConfig, type Area, type Config } from "../core/config.js";
import { detectAreas, singleProjectArea } from "../core/detect.js";
import { headSha, isGitRepo, repoRoot } from "../core/git.js";
import { starterDoc } from "../core/sections.js";
import { STATE_FILE, readState, writeState } from "../core/state.js";

export interface InitOptions {
  yes?: boolean;
}

export type AreaChoice = "use" | "single" | "cancel";

export interface InitDeps {
  cwd: string;
  log: (line: string) => void;
  isInteractive: boolean;
  chooseAreas: (areas: Area[]) => Promise<AreaChoice>;
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

const defaultDeps = (): InitDeps => ({
  cwd: process.cwd(),
  log: (line) => console.log(line),
  isInteractive: Boolean(process.stdin.isTTY),
  chooseAreas: chooseAreasPrompt,
});

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
    config = { provider: "anthropic", model: "claude-sonnet-5-5", areas: chosen, ignore: [...DEFAULT_IGNORE] };
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
  1. Set your API key:  ${pc.cyan("export ANTHROPIC_API_KEY=...")}
  2. Make some changes, commit them, then run:  ${pc.cyan("npx docsync")}
  3. Commit ${CONFIG_FILE}, ${STATE_FILE} and your docs.`);
  return 0;
}
