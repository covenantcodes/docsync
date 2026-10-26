import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFiles, diffFor, headSha, isGitRepo, resolveBase } from "../src/core/git.js";

let dir: string;
const run = (...args: string[]) => execa("git", args, { cwd: dir });
const put = async (file: string, text: string) => {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), text);
};
const commit = async (msg: string) => {
  await run("add", "-A");
  await run("commit", "-q", "-m", msg);
  return headSha(dir);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docsync-git-"));
  await run("init", "-q");
  await run("config", "user.email", "t@example.com");
  await run("config", "user.name", "T");
  await run("config", "commit.gpgsign", "false");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("git", () => {
  it("detects repos", async () => {
    expect(await isGitRepo(dir)).toBe(true);
    const plain = await mkdtemp(join(tmpdir(), "docsync-plain-"));
    try {
      expect(await isGitRepo(plain)).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("lists changed files since a sha, including uncommitted edits", async () => {
    await put("a.ts", "1");
    const first = await commit("one");
    await put("b/c.ts", "2");
    await commit("two");
    await put("a.ts", "changed");
    expect((await changedFiles(dir, first)).sort()).toEqual(["a.ts", "b/c.ts"]);
  });

  it("handles unusual file names", async () => {
    await put("a.ts", "1");
    const first = await commit("one");
    await put("sp ace/ünï.ts", "2");
    await commit("two");
    expect(await changedFiles(dir, first)).toEqual(["sp ace/ünï.ts"]);
  });

  it("--staged only sees the index", async () => {
    await put("a.ts", "1");
    const first = await commit("one");
    await put("staged.ts", "s");
    await put("unstaged.ts", "u");
    await run("add", "staged.ts");
    expect(await changedFiles(dir, first, true)).toEqual(["staged.ts"]);
  });

  it("diffs only the requested files", async () => {
    await put("a.ts", "1\n");
    await put("b.ts", "1\n");
    const first = await commit("one");
    await put("a.ts", "2\n");
    await put("b.ts", "2\n");
    const d = await diffFor(dir, first, ["a.ts"]);
    expect(d).toContain("a.ts");
    expect(d).not.toContain("b.ts");
    expect(d).toContain("+2");
    expect(await diffFor(dir, first, [])).toBe("");
  });

  it("treats pathspecs literally", async () => {
    await put("a.ts", "1\n");
    await put("b.ts", "1\n");
    const first = await commit("one");
    await put("a.ts", "2\n");
    await put("b.ts", "2\n");
    expect(await diffFor(dir, first, ["*.ts"])).toBe("");
  });

  it("resolves the base ref", async () => {
    await put("a.ts", "1");
    const first = await commit("one");
    // root commit only: diff from the empty tree
    const rootBase = await resolveBase(dir, {});
    expect(await changedFiles(dir, rootBase)).toEqual(["a.ts"]);

    await put("b.ts", "2");
    await commit("two");
    expect(await resolveBase(dir, {})).toBe("HEAD~1");
    expect(await resolveBase(dir, { lastSha: first })).toBe(first);
    expect(await resolveBase(dir, { lastSha: first, since: "HEAD~1" })).toBe("HEAD~1");
  });

  it("gives a friendly error for an unknown ref", async () => {
    await put("a.ts", "1");
    await commit("one");
    await expect(resolveBase(dir, { lastSha: "deadbeef" })).rejects.toThrow(/--since/);
    await expect(resolveBase(dir, { since: "nope" })).rejects.toThrow(/Cannot find git ref "nope"/);
  });
});
