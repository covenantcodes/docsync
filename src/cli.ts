import { Command } from "commander";
import pc from "picocolors";
import { check } from "./commands/check.js";
import { init } from "./commands/init.js";
import { update, type UpdateOptions } from "./commands/update.js";

const program = new Command();

program
  .name("docsync")
  .description("Keep project docs up to date from your git changes.")
  .version("0.1.0");

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
  .action(async () => {
    await init();
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
