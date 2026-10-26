import { describe, expect, it, vi } from "vitest";
import {
  buildUserPrompt,
  parseEdits,
  redactSecrets,
  requestEdits,
  stripCodeFences,
  truncateDiff,
} from "../src/core/prompt.js";
import type { Provider } from "../src/providers/index.js";

const good = JSON.stringify([{ section: "overview", content: "# Hi", reason: "added thing" }]);

const fake = (...replies: string[]): Provider & { complete: ReturnType<typeof vi.fn> } => {
  const complete = vi.fn();
  for (const r of replies) complete.mockResolvedValueOnce(r);
  return { complete };
};

describe("redactSecrets", () => {
  it("masks KEY/SECRET/TOKEN assignments but keeps the name", () => {
    const out = redactSecrets(
      '+API_KEY=abcdef123456\n+const secret = "hunter2hunter2";\n+  token: abcdefghijkl,\n+DB_PASSWORD = supersecret1',
    );
    expect(out).toContain("API_KEY=[REDACTED]");
    expect(out).toContain('secret = "[REDACTED]');
    expect(out).toContain("token: [REDACTED]");
    expect(out).toContain("DB_PASSWORD = [REDACTED]");
    expect(out).not.toMatch(/abcdef123456|hunter2|abcdefghijkl|supersecret1/);
  });

  it("keeps harmless code that mentions keys", () => {
    const code = "+  apiKey: string;\n+const keys = Object.keys(x);\n+process.env.API_KEY";
    expect(redactSecrets(code)).toBe(code);
  });

  it("masks private key blocks across diff lines", () => {
    const diff = "+-----BEGIN RSA PRIVATE KEY-----\n+MIIEabc\n+defGHI\n+-----END RSA PRIVATE KEY-----\n+after";
    const out = redactSecrets(diff);
    expect(out).toBe("+[REDACTED PRIVATE KEY]\n+after");
  });

  it("masks an unterminated private key block", () => {
    expect(redactSecrets("+-----BEGIN PRIVATE KEY-----\n+MIIE")).not.toContain("MIIE");
  });

  it("masks well-known token formats", () => {
    const out = redactSecrets(
      "sk-ant-api03-abcdefghijklmnop ghp_abcdefghijklmnopqrstuvwx AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abc Bearer abcdefghijklmnopqrstu",
    );
    expect(out).not.toMatch(/sk-ant|ghp_|AKIA|xoxb|abcdefghijklmnopqrstu/);
  });
});

describe("truncateDiff", () => {
  it("leaves small diffs alone", () => {
    expect(truncateDiff("abc", 10)).toEqual({ text: "abc", truncated: false });
  });
  it("cuts at a line boundary and flags it", () => {
    const r = truncateDiff("line1\nline2\nline3", 8);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("line1\n[...")).toBe(true);
    expect(r.text).not.toContain("line2");
  });
  it("handles a single huge line", () => {
    const r = truncateDiff("x".repeat(100), 10);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("x".repeat(10))).toBe(true);
  });
});

describe("buildUserPrompt", () => {
  it("includes area, date, sections, files and diff", () => {
    const p = buildUserPrompt({
      area: "web",
      doc: "docs/web.md",
      sections: { overview: "Old text", setup: "" },
      files: ["a.ts", "b.ts"],
      diff: "+new",
      date: "2026-10-26",
    });
    for (const s of ["2026-10-26", "Area: web", "docs/web.md", "### overview\nOld text", "### setup\n(empty)", "- a.ts", "+new"]) {
      expect(p).toContain(s);
    }
  });
  it("copes with no sections", () => {
    const p = buildUserPrompt({ area: "a", doc: "d", sections: {}, files: [], diff: "", date: "2026-01-01" });
    expect(p).toContain("(no managed sections yet)");
  });
});

describe("stripCodeFences / parseEdits", () => {
  it("strips json fences", () => {
    expect(stripCodeFences("```json\n[1]\n```")).toBe("[1]");
    expect(stripCodeFences("```\n[1]\n```")).toBe("[1]");
    expect(stripCodeFences("  [1] ")).toBe("[1]");
  });
  it("parses fenced and bare replies", () => {
    expect(parseEdits(good)).toHaveLength(1);
    expect(parseEdits("```json\n" + good + "\n```")).toHaveLength(1);
  });
  it("accepts an empty array", () => {
    expect(parseEdits("[]")).toEqual([]);
  });
  it("rejects bad JSON, wrong shape and invalid section names", () => {
    expect(() => parseEdits("nope")).toThrow(/not valid JSON/);
    expect(() => parseEdits('{"section":"a"}')).toThrow(/expected shape/);
    expect(() => parseEdits('[{"section":"a"}]')).toThrow(/expected shape/);
    expect(() => parseEdits('[{"section":"bad name","content":"","reason":""}]')).toThrow(/expected shape/);
  });
});

describe("requestEdits", () => {
  it("returns on the first valid reply with one call", async () => {
    const p = fake(good);
    expect(await requestEdits(p, "sys", "user")).toHaveLength(1);
    expect(p.complete).toHaveBeenCalledTimes(1);
  });

  it("retries once with the error appended", async () => {
    const p = fake("not json", good);
    expect(await requestEdits(p, "sys", "user")).toHaveLength(1);
    expect(p.complete).toHaveBeenCalledTimes(2);
    const retryPrompt = p.complete.mock.calls[1]![1] as string;
    expect(retryPrompt).toContain("user");
    expect(retryPrompt).toContain("not valid JSON");
    expect(retryPrompt).toContain("not json");
  });

  it("throws after a second failure, without a third call", async () => {
    const p = fake("bad", "worse");
    await expect(requestEdits(p, "s", "u")).rejects.toThrow(/invalid reply twice/);
    expect(p.complete).toHaveBeenCalledTimes(2);
  });

  it("propagates provider errors without retrying", async () => {
    const p: Provider = { complete: vi.fn().mockRejectedValue(new Error("network down")) };
    await expect(requestEdits(p, "s", "u")).rejects.toThrow("network down");
    expect(p.complete).toHaveBeenCalledTimes(1);
  });
});
