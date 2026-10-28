import { Command } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { check } from "./commands/check.js";
import { generate } from "./commands/generate.js";
import { login, logout } from "./commands/login.js";
import { init, type InitOptions } from "./commands/init.js";
import { update, type UpdateOptions } from "./commands/update.js";

const program = new Command();

program
  .name("docsync")
  .description("Keep project docs up to date from your git changes.")
  .version(pkg.version);

function addUpdateOptions(cmd: Command): Command {
  return cmd
    .option("--since <ref>", "diff against this git ref instead of the last synced commit")
    .option("--staged", "only consider staged changes")
    .option("--dry-run", "show proposed changes without writing anything")
    .option("-y, --yes", "apply changes without asking");
}

addUpdateOptions(program.command("update", { isDefault: true }))
  .description("update managed doc sections from recent changes (default)")
  .action(async (opts: UpdateOptions) => {
    process.exitCode = await update(opts);
  });

program
  .command("init")
  .description("detect project structure, write config and starter docs")
  .option("-y, --yes", "accept detected areas and provider without asking")
  .option("--provider <name>", "anthropic, openai, gemini, ollama, openai-compatible, cli or manual")
  .option("--model <name>", "model to use (required for most non-Anthropic providers)")
  .option("--base-url <url>", "endpoint for openai-compatible (or a non-default Ollama)")
  .action(async (opts: InitOptions) => {
    process.exitCode = await init(opts);
  });

program
  .command("generate [feature]")
  .description("write feature docs from the source code itself (features are listed in the config)")
  .option("--dry-run", "show the proposed doc without writing anything")
  .option("-y, --yes", "apply without asking")
  .action(async (feature: string | undefined, opts: { dryRun?: boolean; yes?: boolean }) => {
    process.exitCode = await generate(feature, opts);
  });

program
  .command("login [provider]")
  .description("save an API key in your system's secure store (provider defaults to the one in your config)")
  .action(async (provider: string | undefined) => {
    process.exitCode = await login(provider);
  });

program
  .command("logout [provider]")
  .description("delete the API key saved by `docsync login`")
  .action(async (provider: string | undefined) => {
    process.exitCode = await logout(provider);
  });

program
  .command("check")
  .description("exit 1 if mapped code changed but its doc did not (no LLM call)")
  .action(async () => {
    process.exitCode = await check();
  });

program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(pc.red(`error: ${msg}`));
  if (process.env.DEBUG === "docsync" && err instanceof Error) console.error(err.stack);
  process.exit(1);
});
