import { execa } from "execa";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { update, type UpdateDeps } from "../src/commands/update.js";
import { headSha } from "../src/core/git.js";
import { readState, writeState } from "../src/core/state.js";
import type { Provider } from "../src/providers/index.js";

let dir: string;
const run = (...args: string[]) => execa("git", args, { cwd: dir });
const put = async (file: string, text: string) => {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), text);
};
const read = (file: string) => readFile(join(dir, file), "utf8");
const commit = async (msg: string) => {
  await run("add", "-A");
  await run("commit", "-q", "-m", msg);
  return headSha(dir);
};

const edit = (section: string, content: string) => ({ section, content, reason: `update ${section}` });
const reply = (...edits: ReturnType<typeof edit>[]) => JSON.stringify(edits);

function provider(...replies: string[]) {
  const complete = vi.fn<Provider["complete"]>();
  for (const r of replies) complete.mockResolvedValueOnce(r);
  complete.mockResolvedValue("[]");
  return { complete } satisfies Provider;
}

function deps(p: Provider, extra: Partial<UpdateDeps> = {}) {
  const lines: string[] = [];
  const d: Partial<UpdateDeps> = {
    cwd: dir,
    provider: p,
    log: (l) => lines.push(l),
    isInteractive: true,
    confirm: async () => true,
    today: () => "2026-10-26",
    ...extra,
  };
  return { d, out: () => lines.join("\n") };
}

const DOC = "# Web\n\nHuman intro.\n\n<!-- docsync:start overview -->\nOld overview\n<!-- docsync:end -->\n\nHuman footer.\n";

let baseSha: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docsync-update-"));
  await run("init", "-q");
  await run("config", "user.email", "t@example.com");
  await run("config", "user.name", "T");
  await run("config", "commit.gpgsign", "false");
  await put(
    "docsync.config.json",
    JSON.stringify({
      areas: [
        { name: "web", paths: ["apps/web/**"], doc: "docs/web.md" },
        { name: "backend", paths: ["services/api/**"], doc: "docs/backend.md" },
      ],
    }),
  );
  await put("apps/web/a.ts", "export const a = 1;\n");
  await put("services/api/s.ts", "export const s = 1;\n");
  await put("docs/web.md", DOC);
  baseSha = await commit("base");
  await writeState(dir, { lastSha: baseSha });
  await commit("state");
  baseSha = await headSha(dir);
  await writeState(dir, { lastSha: baseSha });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("update", () => {
  it("edits only the managed section, keeps human text, advances lastSha", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    const p = provider(reply(edit("overview", "New overview")));
    const { d } = deps(p);

    expect(await update({ yes: true }, d)).toBe(0);

    expect(await read("docs/web.md")).toBe(DOC.replace("Old overview", "New overview"));
    expect(p.complete).toHaveBeenCalledTimes(1);
    expect((await readState(dir))?.lastSha).toBe(await headSha(dir));
  });

  it("creates a missing doc (and its folder) with the managed section", async () => {
    await put("services/api/s.ts", "export const s = 2;\n");
    const { d } = deps(provider(reply(edit("overview", "API overview"))));
    await update({ yes: true }, d);
    expect(await read("docs/backend.md")).toBe("<!-- docsync:start overview -->\nAPI overview\n<!-- docsync:end -->\n");
  });

  it("handles multiple areas independently", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    await put("services/api/s.ts", "export const s = 2;\n");
    const p = provider(reply(edit("overview", "W")), reply(edit("overview", "B")));
    await update({ yes: true }, deps(p).d);
    expect(await read("docs/web.md")).toContain("\nW\n");
    expect(await read("docs/backend.md")).toContain("\nB\n");
    expect(p.complete).toHaveBeenCalledTimes(2);
  });

  it("--dry-run shows the diff but writes nothing and keeps lastSha", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    const { d, out } = deps(provider(reply(edit("overview", "New overview"))));
    expect(await update({ dryRun: true }, d)).toBe(0);
    expect(await read("docs/web.md")).toBe(DOC);
    expect((await readState(dir))?.lastSha).toBe(baseSha);
    expect(out()).toContain("+New overview");
    expect(out()).toContain("-Old overview");
    expect(out()).toContain("update overview");
    expect(out()).toContain("Dry run");
  });

  it("declining leaves the doc alone and does not advance lastSha", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    const confirm = vi.fn(async () => false);
    const { d } = deps(provider(reply(edit("overview", "New"))), { confirm });
    await update({}, d);
    expect(confirm).toHaveBeenCalledWith("Apply changes to docs/web.md?");
    expect(await read("docs/web.md")).toBe(DOC);
    expect((await readState(dir))?.lastSha).toBe(baseSha);
  });

  it("--yes never prompts", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    const confirm = vi.fn(async () => false);
    await update({ yes: true }, deps(provider(reply(edit("overview", "New"))), { confirm }).d);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a failing area exits 1, other areas still apply, lastSha stays", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    await put("services/api/s.ts", "export const s = 2;\n");
    // web: two bad replies; backend: good
    const p = provider("junk", "junk again", reply(edit("overview", "B")));
    const { d, out } = deps(p);
    expect(await update({ yes: true }, d)).toBe(1);
    expect(await read("docs/web.md")).toBe(DOC);
    expect(await read("docs/backend.md")).toContain("\nB\n");
    expect((await readState(dir))?.lastSha).toBe(baseSha);
    expect(out()).toContain("invalid reply twice");
  });

  it("drops edits that don't change anything", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    const { d, out } = deps(provider(reply(edit("overview", "Old overview"))));
    expect(await update({ yes: true }, d)).toBe(0);
    expect(await read("docs/web.md")).toBe(DOC);
    expect(out()).toContain("No doc changes needed");
    expect((await readState(dir))?.lastSha).toBe(await headSha(dir));
  });

  it("does nothing, and makes no LLM call, when there are no relevant changes", async () => {
    await put("README.md", "unmapped file\n");
    await put("apps/web/package-lock.json", "{}");
    const p = provider();
    expect(await update({ yes: true }, deps(p).d)).toBe(0);
    expect(p.complete).not.toHaveBeenCalled();
  });

  it("ignores changes to docs themselves", async () => {
    await put("docs/web.md", DOC + "\nmore human text\n");
    const p = provider();
    await update({ yes: true }, deps(p).d);
    expect(p.complete).not.toHaveBeenCalled();
  });

  it("never sends .env files or secret values to the model", async () => {
    await put("apps/web/.env", "SECRET=topsecretvalue123\n");
    await put("apps/web/.env.local", "TOKEN=anothersecret456\n");
    await put("apps/web/a.ts", 'export const a = 2;\nconst API_KEY = "abcd1234efgh5678";\n');
    const p = provider(reply(edit("overview", "x")));
    await update({ yes: true }, deps(p).d);
    const [system, user] = p.complete.mock.calls[0]!;
    const sent = `${system}\n${user}`;
    expect(sent).toContain("apps/web/a.ts");
    expect(sent).not.toMatch(/\.env|topsecretvalue123|anothersecret456|abcd1234efgh5678/);
    expect(sent).toContain("[REDACTED]");
  });

  it("includes the current sections and today's date in the prompt", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    const p = provider("[]");
    await update({ yes: true }, deps(p).d);
    const user = p.complete.mock.calls[0]![1];
    expect(user).toContain("Old overview");
    expect(user).toContain("2026-10-26");
  });

  it("--since diffs against the given ref instead of lastSha", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    const second = await commit("second");
    await writeState(dir, { lastSha: second }); // lastSha says "nothing new"
    const p = provider(reply(edit("overview", "N")));
    await update({ yes: true, since: baseSha }, deps(p).d);
    expect(p.complete).toHaveBeenCalledTimes(1);
  });

  it("--staged only considers staged files and leaves lastSha alone", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    await put("services/api/s.ts", "export const s = 2;\n");
    await run("add", "apps/web/a.ts");
    const p = provider(reply(edit("overview", "N")));
    await update({ yes: true, staged: true }, deps(p).d);
    expect(p.complete).toHaveBeenCalledTimes(1);
    expect(p.complete.mock.calls[0]![1]).not.toContain("services/api/s.ts");
    expect((await readState(dir))?.lastSha).toBe(baseSha);
  });

  it("warns when the diff is truncated", async () => {
    await put("apps/web/a.ts", "x\n".repeat(40_000));
    const { d, out } = deps(provider("[]"));
    await update({ yes: true }, d);
    expect(out()).toContain("truncated");
  });

  it("refuses to prompt in a non-interactive shell without --yes", async () => {
    await put("apps/web/a.ts", "export const a = 2;\n");
    await expect(update({}, deps(provider(), { isInteractive: false }).d)).rejects.toThrow(/--yes/);
    await expect(update({ dryRun: true }, deps(provider(), { isInteractive: false }).d)).resolves.toBe(0);
  });

  it("errors outside a git repo", async () => {
    const plain = await mkdtemp(join(tmpdir(), "docsync-plain-"));
    try {
      await expect(update({ yes: true }, { ...deps(provider()).d, cwd: plain })).rejects.toThrow(/Not inside a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("fails before any work when the API key is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      const { provider: _omit, ...rest } = deps(provider()).d;
      await expect(update({ yes: true }, rest)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
