import { describe, expect, it } from "vitest";
import { DEFAULT_IGNORE } from "../src/core/config.js";
import { filterIgnored, groupByArea } from "../src/core/mapper.js";

const areas = [
  { name: "mobile", paths: ["apps/mobile/**"], doc: "docs/mobile.md" },
  { name: "web", paths: ["apps/web/**"], doc: "docs/web.md" },
  { name: "backend", paths: ["services/api/**"], doc: "docs/backend.md" },
];

describe("filterIgnored", () => {
  it("drops lockfiles, assets, dist and env files", () => {
    const files = [
      "src/a.ts",
      "yarn.lock",
      "apps/web/package-lock.json",
      "apps/mobile/assets/logo.png",
      "dist/cli.js",
      ".env",
      "apps/web/.env.local",
    ];
    expect(filterIgnored(files, DEFAULT_IGNORE)).toEqual(["src/a.ts"]);
  });

  it("always drops .env files even if config ignore is empty", () => {
    expect(filterIgnored([".env", "services/api/.env.production", "a.ts"], [])).toEqual(["a.ts"]);
  });

  it("applies custom ignore patterns", () => {
    expect(filterIgnored(["a.snap", "b.ts"], ["**/*.snap"])).toEqual(["b.ts"]);
  });

  it("matches dotfiles and dot-directories", () => {
    expect(filterIgnored([".github/x.yml"], [".github/**"])).toEqual([]);
  });
});

describe("groupByArea", () => {
  it("groups files by area and omits untouched areas", () => {
    const res = groupByArea(["apps/web/a.ts", "apps/web/b.ts", "services/api/s.ts"], areas);
    expect(res.map((g) => [g.area.name, g.files])).toEqual([
      ["web", ["apps/web/a.ts", "apps/web/b.ts"]],
      ["backend", ["services/api/s.ts"]],
    ]);
  });

  it("drops files that match no area", () => {
    expect(groupByArea(["README.md"], areas)).toEqual([]);
  });

  it("first matching area wins", () => {
    const overlapping = [
      { name: "web", paths: ["apps/web/**"], doc: "w.md" },
      { name: "all", paths: ["**"], doc: "o.md" },
    ];
    const res = groupByArea(["apps/web/a.ts", "x.ts"], overlapping);
    expect(res.map((g) => [g.area.name, g.files])).toEqual([
      ["web", ["apps/web/a.ts"]],
      ["all", ["x.ts"]],
    ]);
  });

  it("supports multiple path patterns per area", () => {
    const a = [{ name: "x", paths: ["a/**", "b/*.ts"], doc: "x.md" }];
    expect(groupByArea(["a/1.ts", "b/2.ts", "b/c/3.ts"], a)[0]!.files).toEqual(["a/1.ts", "b/2.ts"]);
  });
});
