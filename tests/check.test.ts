import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check } from "../src/commands/check.js";
import { update } from "../src/commands/update.js";
import { headSha } from "../src/core/git.js";
import { readState, writeState } from "../src/core/state.js";

let dir: string;
const run = (...args: string[]) => execa("git", args, { cwd: dir });
const put = async (file: string, text: string) => {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), text);
};
const commit = async (msg = "c") => {
  await run("add", "-A");
  await run("commit", "-q", "-m", msg);
  return headSha(dir);
};
const go = async () => {
  const lines: string[] = [];
  const code = await check({ cwd: dir, log: (l) => lines.push(l) });
  return { code, out: lines.join("\n") };
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docsync-check-"));
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
  await put("apps/web/a.ts", "1\n");
  await put("services/api/s.ts", "1\n");
  await put("docs/web.md", "# web\n");
  await put("docs/backend.md", "# backend\n");
  await writeState(dir, { lastSha: await commit("base") });
  await commit("state");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("check", () => {
  it("passes when nothing changed", async () => {
    expect((await go()).code).toBe(0);
  });

  it("fails when code changed but its doc did not, naming the area and files", async () => {
    await put("apps/web/a.ts", "2\n");
    await commit();
    const { code, out } = await go();
    expect(code).toBe(1);
    expect(out).toContain("web");
    expect(out).toContain("docs/web.md");
    expect(out).toContain("apps/web/a.ts");
    expect(out).not.toContain("backend");
  });

  it("also catches uncommitted code changes", async () => {
    await put("services/api/s.ts", "2\n");
    expect((await go()).code).toBe(1);
  });

  it("passes when the doc changed alongside the code", async () => {
    await put("apps/web/a.ts", "2\n");
    await put("docs/web.md", "# web\nmore\n");
    await commit();
    expect((await go()).code).toBe(0);
  });

  it("only flags the areas whose doc is stale", async () => {
    await put("apps/web/a.ts", "2\n");
    await put("services/api/s.ts", "2\n");
    await put("docs/web.md", "# web\nmore\n");
    const { code, out } = await go();
    expect(code).toBe(1);
    expect(out).toContain("backend");
    expect(out).not.toContain("✗ web");
  });

  it("ignores lockfiles, env files, unmapped files and docsync's own files", async () => {
    await put("apps/web/package-lock.json", "{}");
    await put("apps/web/.env", "A=1");
    await put("README.md", "hi");
    await put(".docsync.json", JSON.stringify({ lastSha: (await readState(dir))!.lastSha, note: 1 }));
    await commit();
    expect((await go()).code).toBe(0);
  });

  it("truncates long file lists", async () => {
    for (let i = 0; i < 8; i++) await put(`apps/web/f${i}.ts`, "x");
    await commit();
    const { out } = await go();
    expect(out).toContain("8 files changed");
    expect(out).toContain("and 3 more");
  });

  it("falls back to HEAD~1 when there is no state file", async () => {
    await rm(join(dir, ".docsync.json"));
    await commit("drop state");
    await put("apps/web/a.ts", "3\n");
    await commit();
    expect((await go()).code).toBe(1);
  });

  it("explains an unknown lastSha (e.g. shallow CI clone)", async () => {
    await writeState(dir, { lastSha: "deadbeefdeadbeef" });
    await expect(go()).rejects.toThrow(/fetch-depth: 0/);
  });

  it("errors outside a git repo", async () => {
    const plain = await mkdtemp(join(tmpdir(), "docsync-plain-"));
    try {
      await expect(check({ cwd: plain, log: () => {} })).rejects.toThrow(/Not inside a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("a code-only commit after an older doc commit is still stale", async () => {
    await put("apps/web/a.ts", "2\n");
    await put("docs/web.md", "# web\nmore\n");
    await commit("code+doc");
    expect((await go()).code).toBe(0);
    await put("apps/web/a.ts", "3\n");
    await commit("code only");
    expect((await go()).code).toBe(1);
  });

  it("doc committed after the code is fresh (separate commits)", async () => {
    await put("apps/web/a.ts", "2\n");
    await commit("code");
    await put("docs/web.md", "# web\nmore\n");
    await commit("doc");
    expect((await go()).code).toBe(0);
  });

  it("a doc created by init does not hide later code changes", async () => {
    await run("rm", "-q", "-r", "docs");
    await commit("remove docs");
    await put(".docsync.json", JSON.stringify({ lastSha: await headSha(dir) }));
    await commit("state at HEAD");
    await put("docs/web.md", "# web\n"); // what init would create
    await commit("docsync init");
    expect((await go()).code).toBe(0);
    await put("apps/web/a.ts", "9\n");
    await commit("feature");
    expect((await go()).code).toBe(1);
  });

  it("makes no LLM call and passes right after a successful update", async () => {
    await put("apps/web/a.ts", "2\n");
    const provider = { complete: async () => JSON.stringify([{ section: "overview", content: "New", reason: "r" }]) };
    await update({ yes: true }, { cwd: dir, provider, log: () => {}, isInteractive: false, confirm: async () => true });
    expect((await go()).code).toBe(0); // uncommitted
    await commit("after docsync");
    expect((await go()).code).toBe(0); // committed
  });
});
