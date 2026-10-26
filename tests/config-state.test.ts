import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE, DEFAULT_IGNORE, defaultConfig, loadConfig, parseConfig } from "../src/core/config.js";
import { STATE_FILE, readState, writeState } from "../src/core/state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docsync-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("falls back to a single project area when no config exists", async () => {
    expect(await loadConfig(dir)).toEqual(defaultConfig());
    expect(defaultConfig().areas).toEqual([{ name: "project", paths: ["**"], doc: "docs/OVERVIEW.md" }]);
  });

  it("applies defaults for provider, model and ignore", () => {
    const c = parseConfig({ areas: [{ name: "a", paths: ["a/**"], doc: "a.md" }] });
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-sonnet-5-5");
    expect(c.ignore).toEqual(DEFAULT_IGNORE);
  });

  it("loads a config file", async () => {
    const cfg = { model: "m", areas: [{ name: "a", paths: ["a/**"], doc: "a.md" }], ignore: ["x"] };
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify(cfg));
    expect(await loadConfig(dir)).toMatchObject({ model: "m", ignore: ["x"] });
  });

  it("reports schema errors with the file name", async () => {
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ areas: [{ name: "a" }] }));
    await expect(loadConfig(dir)).rejects.toThrow(/Invalid docsync\.config\.json/);
  });

  it("reports invalid JSON", async () => {
    await writeFile(join(dir, CONFIG_FILE), "{nope");
    await expect(loadConfig(dir)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects empty areas", () => {
    expect(() => parseConfig({ areas: [] })).toThrow();
  });
});

describe("state", () => {
  it("returns null when missing", async () => {
    expect(await readState(dir)).toBeNull();
  });

  it("round-trips lastSha", async () => {
    await writeState(dir, { lastSha: "abc123" });
    expect(await readState(dir)).toEqual({ lastSha: "abc123" });
    expect(JSON.parse(await readFile(join(dir, STATE_FILE), "utf8"))).toEqual({ lastSha: "abc123" });
  });

  it("rejects malformed state", async () => {
    await writeFile(join(dir, STATE_FILE), "{}");
    await expect(readState(dir)).rejects.toThrow(/Invalid \.docsync\.json/);
    await writeFile(join(dir, STATE_FILE), "nope");
    await expect(readState(dir)).rejects.toThrow(/not valid JSON/);
  });
});
