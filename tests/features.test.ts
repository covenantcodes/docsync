import { execa } from "execa";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generate } from "../src/commands/generate.js";
import { parseConfig } from "../src/core/config.js";
import { FEATURE_SECTIONS, buildFeaturePrompt } from "../src/core/feature-prompt.js";
import { groupChanges } from "../src/core/mapper.js";
import { collectSources, rankPath, selectFeatureFiles } from "../src/core/source.js";
import { readSections } from "../src/core/sections.js";
import { verifyEdits } from "../src/core/verify.js";
import { normalizeTables } from "../src/core/markdown.js";
import { parseEdits } from "../src/core/prompt.js";
import type { Provider } from "../src/providers/index.js";

const edit = (section: string, content: string) => ({ section, content, reason: `covers ${section}` });

describe("config: features", () => {
  const areas = [{ name: "a", paths: ["a/**"], doc: "a.md" }];
  it("defaults to none, validates names, rejects duplicates", () => {
    expect(parseConfig({ areas }).features).toEqual([]);
    const f = { name: "bills-payment", paths: ["x/**"], doc: "docs/f.md" };
    expect(parseConfig({ areas, features: [f] }).features).toEqual([f]);
    expect(() => parseConfig({ areas, features: [{ ...f, name: "has space" }] })).toThrow(/letters, digits/);
    expect(() => parseConfig({ areas, features: [f, f] })).toThrow(/duplicate feature/);
    expect(() => parseConfig({ areas, features: [{ ...f, paths: [] }] })).toThrow();
  });
  it("accepts an optional title", () => {
    const f = { name: "download-api", title: "Download API", paths: ["x/**"], doc: "d.md" };
    expect(parseConfig({ areas, features: [f] }).features[0]!.title).toBe("Download API");
  });
  it("feature docs are never treated as code changes", () => {
    const config = { areas: [{ name: "all", paths: ["**"], doc: "docs/all.md" }], ignore: [], features: [{ name: "f", paths: ["x/**"], doc: "docs/f.md" }] };
    expect(groupChanges(["docs/f.md", "a.ts"], config).flatMap((g) => g.files)).toEqual(["a.ts"]);
  });
});

describe("normalizeTables", () => {
  const sep = "|---|---|---|";
  it("adds the missing separator row under a header", () => {
    expect(normalizeTables("| A | B | C |\n| `x` | 1 | 2 |")).toBe(`| A | B | C |\n${sep}\n| \`x\` | 1 | 2 |`);
  });
  it("leaves valid tables, fences and single rows alone", () => {
    const ok = "| A | B |\n|---|---|\n| 1 | 2 |";
    expect(normalizeTables(ok)).toBe(ok);
    const aligned = "| A | B |\n| :--- | ---: |\n| 1 | 2 |";
    expect(normalizeTables(aligned)).toBe(aligned);
    const fenced = "```\n| A | B |\n| 1 | 2 |\n```";
    expect(normalizeTables(fenced)).toBe(fenced);
    expect(normalizeTables("| only |\ntext")).toBe("| only |\ntext");
  });
  it("fixes several tables in one document and keeps the text around them", () => {
    const md = "Intro\n\n| A | B |\n| 1 | 2 |\n\nMiddle\n\n| C |\n| 3 |\nEnd";
    expect(normalizeTables(md)).toBe("Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nMiddle\n\n| C |\n|---|\n| 3 |\nEnd");
  });
  it("is applied to every reply", () => {
    const reply = JSON.stringify([{ section: "s", content: "| A | B |\n| 1 | 2 |", reason: "r" }]);
    expect(parseEdits(reply)[0]!.content).toContain("|---|---|");
  });
});

describe("rankPath / selectFeatureFiles", () => {
  it("puts behaviour first, tests and styles last", () => {
    const paths = ["a/styles/x.css", "a/routes.ts", "a/routes.test.ts", "a/BillScreen.tsx", "a/util.ts", "a/data.json"];
    const sorted = [...paths].sort((x, y) => rankPath(y) - rankPath(x));
    expect(sorted[0]).toBe("a/routes.ts");
    expect(sorted.indexOf("a/BillScreen.tsx")).toBeLessThan(sorted.indexOf("a/util.ts"));
    expect(rankPath("a/routes.test.ts")).toBeLessThan(rankPath("a/util.ts")); // tests after real code
    expect(rankPath("a/styles/x.css")).toBeLessThan(rankPath("a/routes.test.ts")); // styles last
  });

  it("matches the feature's paths across folders, minus ignored and own files", () => {
    const tracked = ["apps/m/bills/a.ts", "svc/bills/b.ts", "svc/other/c.ts", "svc/bills/.env", "svc/bills/yarn.lock", "docs/f.md"];
    const f = { name: "f", paths: ["apps/m/bills/**", "svc/bills/**", "docs/**"], doc: "docs/f.md" };
    expect(selectFeatureFiles(tracked, f, ["**/*.lock"], ["docs/f.md"]).sort()).toEqual(["apps/m/bills/a.ts", "svc/bills/b.ts"]);
  });

  it("is deterministic", () => {
    const f = { name: "f", paths: ["**"], doc: "d.md" };
    const t = ["b.ts", "a.ts", "c.ts"];
    expect(selectFeatureFiles(t, f, [], [])).toEqual(selectFeatureFiles([...t].reverse(), f, [], []));
  });
});

describe("collectSources", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "docsync-src-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const put = (f: string, c: string | Buffer) => writeFile(join(dir, f), c);

  it("reads in order within the budget, reports what didn't fit, redacts secrets", async () => {
    await put("a.ts", "const API_KEY = 'abcd1234efgh5678';\n");
    await put("big.ts", "x".repeat(500));
    await put("small.ts", "ok");
    const r = await collectSources(dir, ["a.ts", "big.ts", "small.ts"], 100);
    expect(r.files.map((f) => f.path)).toEqual(["a.ts", "small.ts"]);
    expect(r.omitted).toEqual(["big.ts"]);
    expect(r.files[0]!.content).not.toContain("abcd1234efgh5678");
  });

  it("skips binary and missing files", async () => {
    await put("bin.dat", Buffer.from([1, 0, 2]));
    const r = await collectSources(dir, ["bin.dat", "gone.ts"], 1000);
    expect(r.files).toEqual([]);
    expect(r.omitted).toEqual(["bin.dat"]);
  });
});

describe("verifyEdits", () => {
  const files = [
    {
      path: "svc/bills/routes.ts",
      content: 'router.post("/pay", h); app.use("/api/v1/bills", router); const url = process.env.BILLS_API_URL; interface Req { accountNumber: string; amount: number; meta: { currency: string } }',
    },
  ];

  it("passes a doc that matches the source (routes may be composed from prefixes)", () => {
    const content = [
      "### POST /api/v1/bills/pay",
      "| Parameter | In | Type | Required |",
      "|---|---|---|---|",
      "| `accountNumber` | body | string | yes |",
      "| `meta.currency` | body | string | yes |",
      "| `id` | path | string | yes |",
      "Reads `BILLS_API_URL`.",
      "Sources: `svc/bills/routes.ts`",
    ].join("\n");
    expect(verifyEdits([edit("endpoints", content)], files)).toEqual([]);
  });

  it("flags an invented endpoint, field, env var and source file", () => {
    const content = [
      "### POST /api/v1/bills/refund",
      "| `refundReason` | body | string | no |",
      "Uses `REFUND_SECRET_NAME`.",
      "Sources: `svc/bills/routes.ts`, `svc/bills/ghost.ts`",
    ].join("\n");
    const kinds = verifyEdits([edit("endpoints", content)], files).map((f) => [f.kind, f.value]);
    expect(kinds).toEqual([
      ["route", "/api/v1/bills/refund"],
      ["field", "refundReason"],
      ["env", "REFUND_SECRET_NAME"],
      ["source", "svc/bills/ghost.ts"],
    ]);
  });

  it("ignores :id / {id} params, code fences, URLs and plain words", () => {
    const content = "GET /bills/:id and /bills/{id}\nSee https://example.com/whatever and a/b.\n```mermaid\nA->>B: /nothere\n```";
    expect(verifyEdits([edit("flow", content)], files)).toEqual([]);
  });

  it("accepts a cited file with a line range", () => {
    expect(verifyEdits([edit("flow", "Sources: `svc/bills/routes.ts:10-20`")], files)).toEqual([]);
  });

  it("reports each problem once per section", () => {
    const c = "`/bills/zzzz` and `/bills/zzzz`";
    expect(verifyEdits([edit("flow", c)], files)).toHaveLength(1);
  });
});

describe("buildFeaturePrompt", () => {
  it("lists every section, the files, omissions and the earlier version", () => {
    const p = buildFeaturePrompt({
      feature: "bills",
      doc: "docs/bills.md",
      sections: { overview: "Old overview", flow: "_Not documented yet. Run `docsync` to fill this in._" },
      files: [{ path: "a.ts", content: "code" }],
      omitted: ["huge.ts"],
    });
    for (const s of FEATURE_SECTIONS) expect(p).toContain(`- ${s.name}:`);
    expect(p).toContain("=== FILE: a.ts ===\ncode");
    expect(p).toContain("huge.ts");
    expect(p).toContain("### overview\nOld overview");
    expect(p).not.toContain("### flow");
  });
});

describe("generate", () => {
  let dir: string;
  const run = (...args: string[]) => execa("git", args, { cwd: dir });
  const put = async (file: string, text: string) => {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), text);
  };
  const read = (f: string) => readFile(join(dir, f), "utf8");
  const provider = (...replies: string[]) => {
    const complete = vi.fn<Provider["complete"]>();
    for (const r of replies) complete.mockResolvedValueOnce(r);
    complete.mockResolvedValue("[]");
    return { complete } satisfies Provider;
  };
  const go = async (feature: string | undefined, opts: { dryRun?: boolean; yes?: boolean }, p: Provider, extra = {}) => {
    const lines: string[] = [];
    const code = await generate(feature, opts, { cwd: dir, provider: p, log: (l) => lines.push(l), isInteractive: true, confirm: async () => true, ...extra });
    return { code, out: lines.join("\n") };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "docsync-gen-"));
    await run("init", "-q");
    await run("config", "user.email", "t@example.com");
    await run("config", "user.name", "T");
    await run("config", "commit.gpgsign", "false");
    await put(
      "docsync.config.json",
      JSON.stringify({
        areas: [{ name: "all", paths: ["**"], doc: "docs/OVERVIEW.md" }],
        features: [
          { name: "bills-payment", paths: ["apps/mobile/src/bills/**", "services/api/src/bills/**"], doc: "docs/features/bills-payment.md" },
          { name: "empty", paths: ["nothing/**"], doc: "docs/features/empty.md" },
        ],
      }),
    );
    await put("services/api/src/bills/routes.ts", 'router.post("/bills/pay", pay); // body: accountNumber, amount\nconst key = "SECRET_TOKEN=abcdefgh12345678";\n');
    await put("services/api/src/bills/routes.test.ts", "test('x')");
    await put("services/api/src/bills/.env", "SECRET=topsecretvalue123");
    await put("apps/mobile/src/bills/PayScreen.tsx", 'fetch("/bills/pay", { body: { accountNumber, amount } })');
    await run("add", "-A");
    await run("commit", "-q", "-m", "base");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const good = JSON.stringify([
    edit("endpoints", "### POST /bills/pay\n| Parameter | In | Type | Required |\n|---|---|---|---|\n| `accountNumber` | body | string | yes |\nSources: `services/api/src/bills/routes.ts`"),
    edit("overview", "Pay bills from the app.\nSources: `apps/mobile/src/bills/PayScreen.tsx`"),
  ]);

  it("writes a structured doc from source: title, template order, no warnings", async () => {
    const p = provider(good);
    const { code, out } = await go("bills-payment", { yes: true }, p);
    expect(code).toBe(0);
    const doc = await read("docs/features/bills-payment.md");
    expect(doc.startsWith("# Bills payment\n")).toBe(true);
    expect(Object.keys(readSections(doc))).toEqual(["overview", "endpoints"]); // template order, not reply order
    expect(out).toContain("Every route, field");
    expect(out).toContain("Reading 3 files"); // routes, screen, test; .env excluded
  });

  it("sends whole files, never .env content or secrets", async () => {
    const p = provider(good);
    await go("bills-payment", { yes: true }, p);
    const [system, user] = p.complete.mock.calls[0]!;
    const sent = `${system}\n${user}`;
    expect(sent).toContain('router.post("/bills/pay"');
    expect(sent).toContain("PayScreen.tsx");
    expect(sent).not.toMatch(/topsecretvalue123|abcdefgh12345678/);
    expect(sent).not.toContain("=== FILE: services/api/src/bills/.env");
    expect(user.indexOf("routes.ts")).toBeLessThan(user.indexOf("routes.test.ts")); // ranked before tests
  });

  it("warns about invented endpoints and fields", async () => {
    const bad = JSON.stringify([edit("endpoints", "### POST /bills/refund\n| `refundReason` | body | string | no |\nSources: `ghost.ts`")]);
    const { out } = await go("bills-payment", { yes: true }, provider(bad));
    expect(out).toContain("could not be matched");
    expect(out).toContain("/bills/refund");
    expect(out).toContain("refundReason");
    expect(out).toContain("ghost.ts");
  });

  it("--dry-run writes nothing; declining writes nothing", async () => {
    await go("bills-payment", { dryRun: true }, provider(good));
    await expect(read("docs/features/bills-payment.md")).rejects.toThrow();
    await go("bills-payment", {}, provider(good), { confirm: async () => false });
    await expect(read("docs/features/bills-payment.md")).rejects.toThrow();
  });

  it("uses the configured title for a new doc", async () => {
    await put("docsync.config.json", JSON.stringify({
      areas: [{ name: "a", paths: ["**"], doc: "a.md" }],
      features: [{ name: "bills-payment", title: "Bills Payment API", paths: ["services/**"], doc: "docs/b.md" }],
    }));
    await go("bills-payment", { yes: true }, provider(good));
    expect((await read("docs/b.md")).startsWith("# Bills Payment API\n")).toBe(true);
  });

  it("repairs tables the model wrote without a separator row", async () => {
    const reply = JSON.stringify([edit("endpoints", "### POST /bills/pay\n| Parameter | In |\n| `accountNumber` | body |")]);
    await go("bills-payment", { yes: true }, provider(reply));
    expect(await read("docs/features/bills-payment.md")).toContain("| Parameter | In |\n|---|---|\n| `accountNumber` | body |");
  });

  it("keeps human text outside markers and leaves lastSha alone", async () => {
    await put("docs/features/bills-payment.md", "# Bills\n\nMy own notes.\n\n<!-- docsync:start overview -->\nold\n<!-- docsync:end -->\n\nFooter.\n");
    await go("bills-payment", { yes: true }, provider(good));
    const doc = await read("docs/features/bills-payment.md");
    expect(doc).toContain("My own notes.");
    expect(doc).toContain("Footer.");
    expect(doc).toContain("Pay bills from the app.");
    await expect(read(".docsync.json")).rejects.toThrow();
  });

  it("includes the earlier version of a section in the prompt", async () => {
    await put("docs/features/bills-payment.md", "<!-- docsync:start overview -->\nHand-tuned wording\n<!-- docsync:end -->\n");
    const p = provider("[]");
    await go("bills-payment", { yes: true }, p);
    expect(p.complete.mock.calls[0]![1]).toContain("Hand-tuned wording");
  });

  it("ignores sections outside the template and drops unchanged ones", async () => {
    const reply = JSON.stringify([edit("changelog", "x"), edit("overview", "same")]);
    await put("docs/features/bills-payment.md", "<!-- docsync:start overview -->\nsame\n<!-- docsync:end -->\n");
    const { out } = await go("bills-payment", { yes: true }, provider(reply));
    expect(out).toContain("Ignored 1 section");
    expect(out).toContain("No doc changes needed");
  });

  it("runs every feature when none is named; a failing one gives exit 1 but others still run", async () => {
    const { code, out } = await go(undefined, { yes: true }, provider(good));
    expect(code).toBe(1);
    expect(out).toContain("No readable source files match nothing/**");
    expect(await read("docs/features/bills-payment.md")).toContain("Pay bills");
  });

  it("explains missing features and unknown names", async () => {
    await expect(go("nope", { yes: true }, provider())).rejects.toThrow(/Unknown feature "nope".*bills-payment/);
    await put("docsync.config.json", JSON.stringify({ areas: [{ name: "a", paths: ["**"], doc: "a.md" }] }));
    await expect(go(undefined, { yes: true }, provider())).rejects.toThrow(/No features configured.*"features"/s);
  });

  it("warns when files are left out of the budget", async () => {
    await put("docsync.config.json", JSON.stringify({
      maxSourceChars: 120,
      areas: [{ name: "a", paths: ["**"], doc: "a.md" }],
      features: [{ name: "bills-payment", paths: ["services/**", "apps/**"], doc: "docs/b.md" }],
    }));
    const { out } = await go("bills-payment", { yes: true }, provider("[]"));
    expect(out).toContain("left out");
  });

  it("needs --yes or a terminal", async () => {
    await expect(go("bills-payment", {}, provider(good), { isInteractive: false })).rejects.toThrow(/--yes/);
  });
});
