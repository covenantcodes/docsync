import { execa } from "execa";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, type InitDeps } from "../src/commands/init.js";
import { parseConfig } from "../src/core/config.js";
import { detectAreas, dirsToAreas, parsePnpmWorkspace } from "../src/core/detect.js";
import { headSha } from "../src/core/git.js";
import { readSections, starterDoc } from "../src/core/sections.js";
import { readState } from "../src/core/state.js";

let dir: string;
const put = async (file: string, text = "x") => {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), text);
};
const read = (file: string) => readFile(join(dir, file), "utf8");
const run = (...args: string[]) => execa("git", args, { cwd: dir });
const commit = async () => {
  await run("add", "-A");
  await run("commit", "-q", "-m", "c");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docsync-init-"));
  await run("init", "-q");
  await run("config", "user.email", "t@example.com");
  await run("config", "user.name", "T");
  await run("config", "commit.gpgsign", "false");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(extra: Partial<InitDeps> = {}) {
  const lines: string[] = [];
  const d: Partial<InitDeps> = { cwd: dir, log: (l) => lines.push(l), isInteractive: true, chooseAreas: async () => "use", ...extra };
  return { d, out: () => lines.join("\n") };
}

describe("detectAreas", () => {
  it("reads package.json workspaces (array)", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["apps/*", "packages/ui"] }));
    await put("apps/web/a.ts");
    await put("apps/mobile/a.ts");
    await put("packages/ui/a.ts");
    await put("packages/other/a.ts");
    const { areas, source } = await detectAreas(dir);
    expect(source).toBe("package.json workspaces");
    expect(areas.map((a) => a.name)).toEqual(["mobile", "web", "ui"]);
    expect(areas[0]).toEqual({ name: "mobile", paths: ["apps/mobile/**"], doc: "docs/mobile.md" });
  });

  it("reads package.json workspaces ({ packages })", async () => {
    await put("package.json", JSON.stringify({ workspaces: { packages: ["libs/*"] } }));
    await put("libs/core/a.ts");
    expect((await detectAreas(dir)).areas.map((a) => a.name)).toEqual(["core"]);
  });

  it("reads pnpm-workspace.yaml", async () => {
    await put("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"!apps/legacy\"\n  # c\n  - tools # trailing\ncatalog:\n  - nope\n");
    await put("apps/web/a.ts");
    await put("tools/a.ts");
    const { areas, source } = await detectAreas(dir);
    expect(source).toBe("pnpm-workspace.yaml");
    expect(areas.map((a) => a.name)).toEqual(["web", "tools"]);
  });

  it("falls back to apps/ packages/ services/ folders", async () => {
    await put("services/api/main.go");
    await put("packages/shared/a.ts");
    await put("apps/.hidden/a.ts");
    await put("apps/node_modules/a.ts");
    const { areas, source } = await detectAreas(dir);
    expect(source).toContain("folders");
    expect(areas.map((a) => a.name)).toEqual(["shared", "api"]);
  });

  it("finds nothing in a plain repo", async () => {
    await put("main.py");
    expect(await detectAreas(dir)).toEqual({ areas: [], source: null });
  });

  it("ignores workspace patterns that match no directory", async () => {
    await put("package.json", JSON.stringify({ workspaces: ["nope/*"] }));
    await put("main.py");
    expect((await detectAreas(dir)).areas).toEqual([]);
  });

  it("disambiguates duplicate names", () => {
    expect(dirsToAreas(["apps/web", "packages/web", "services/api"]).map((a) => a.name)).toEqual([
      "apps-web",
      "packages-web",
      "api",
    ]);
  });

  it("parsePnpmWorkspace handles CRLF and empty files", () => {
    expect(parsePnpmWorkspace("packages:\r\n  - a/*\r\n")).toEqual(["a/*"]);
    expect(parsePnpmWorkspace("")).toEqual([]);
  });
});

describe("starterDoc", () => {
  it("has the four default sections and a human title", () => {
    const md = starterDoc("Web");
    expect(md.startsWith("# Web\n")).toBe(true);
    expect(Object.keys(readSections(md))).toEqual(["overview", "setup", "architecture", "changelog"]);
  });
});

describe("init", () => {
  it("sets up config, docs and state for a monorepo", async () => {
    await put("apps/web/a.ts");
    await put("services/api/s.ts");
    await commit();

    expect(await init({}, deps().d)).toBe(0);

    const config = parseConfig(JSON.parse(await read("docsync.config.json")));
    expect(config.areas.map((a) => a.name)).toEqual(["web", "api"]);
    expect(config.provider).toBe("anthropic");
    expect(JSON.parse(await read("docsync.config.json"))).not.toHaveProperty("apiKey");
    expect(Object.keys(readSections(await read("docs/web.md")))).toEqual(["overview", "setup", "architecture", "changelog"]);
    expect(await read("docs/api.md")).toContain("# Api");
    expect((await readState(dir))?.lastSha).toBe(await headSha(dir));
  });

  it("uses one project area when nothing is detected", async () => {
    await put("main.py");
    await commit();
    const { d, out } = deps();
    await init({}, d);
    expect(parseConfig(JSON.parse(await read("docsync.config.json"))).areas).toEqual([
      { name: "project", paths: ["**"], doc: "docs/OVERVIEW.md" },
    ]);
    expect(await read("docs/OVERVIEW.md")).toContain("docsync:start overview");
    expect(out()).toContain("ANTHROPIC_API_KEY");
  });

  it("asks the user, and honours 'single'", async () => {
    await put("apps/web/a.ts");
    await commit();
    const chooseAreas = vi.fn(async () => "single" as const);
    await init({}, deps({ chooseAreas }).d);
    expect(chooseAreas).toHaveBeenCalledOnce();
    expect(parseConfig(JSON.parse(await read("docsync.config.json"))).areas[0]!.name).toBe("project");
  });

  it("cancel writes nothing and exits 1", async () => {
    await put("apps/web/a.ts");
    await commit();
    expect(await init({}, deps({ chooseAreas: async () => "cancel" }).d)).toBe(1);
    await expect(read("docsync.config.json")).rejects.toThrow();
    expect(await readState(dir)).toBeNull();
  });

  it("--yes skips the question", async () => {
    await put("apps/web/a.ts");
    await commit();
    const chooseAreas = vi.fn(async () => "cancel" as const);
    await init({ yes: true }, deps({ chooseAreas }).d);
    expect(chooseAreas).not.toHaveBeenCalled();
    expect(await read("docs/web.md")).toBeTruthy();
  });

  it("refuses to ask in a non-interactive shell without --yes", async () => {
    await put("apps/web/a.ts");
    await commit();
    await expect(init({}, deps({ isInteractive: false }).d)).rejects.toThrow(/--yes/);
  });

  it("never overwrites existing config, docs or state", async () => {
    await put("docsync.config.json", JSON.stringify({ areas: [{ name: "x", paths: ["x/**"], doc: "docs/x.md" }] }));
    await put("docs/x.md", "# My own doc\n");
    await put(".docsync.json", JSON.stringify({ lastSha: "keepme" }));
    await commit();

    expect(await init({}, deps().d)).toBe(0);

    expect(JSON.parse(await read("docsync.config.json")).areas[0].name).toBe("x");
    expect(await read("docs/x.md")).toBe("# My own doc\n");
    expect((await readState(dir))?.lastSha).toBe("keepme");
  });

  it("creates docs for an existing config's missing files", async () => {
    await put("docsync.config.json", JSON.stringify({ areas: [{ name: "x", paths: ["**"], doc: "deep/er/x.md" }] }));
    await commit();
    await init({}, deps().d);
    expect(await read("deep/er/x.md")).toContain("docsync:start overview");
  });

  it("reports an invalid existing config", async () => {
    await put("docsync.config.json", "{}");
    await commit();
    await expect(init({}, deps().d)).rejects.toThrow(/Invalid docsync\.config\.json/);
  });

  it("errors outside a git repo and in a repo with no commits", async () => {
    await expect(init({}, deps().d)).rejects.toThrow(/no commits/);
    const plain = await mkdtemp(join(tmpdir(), "docsync-plain-"));
    try {
      await expect(init({}, { ...deps().d, cwd: plain })).rejects.toThrow(/Not inside a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
