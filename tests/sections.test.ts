import { describe, expect, it } from "vitest";
import { readSections, writeSection } from "../src/core/sections.js";

const doc = (name: string, body: string) =>
  `<!-- docsync:start ${name} -->\n${body}\n<!-- docsync:end -->`;

describe("readSections", () => {
  it("returns {} when there are no markers", () => {
    expect(readSections("# Title\n\nhello")).toEqual({});
  });

  it("reads multiple sections", () => {
    const md = `# T\n${doc("overview", "A")}\ntext\n${doc("setup", "B\nC")}\n`;
    expect(readSections(md)).toEqual({ overview: "A", setup: "B\nC" });
  });

  it("reads empty sections", () => {
    expect(readSections("<!-- docsync:start a --><!-- docsync:end -->")).toEqual({ a: "" });
    expect(readSections("<!-- docsync:start a -->\n<!-- docsync:end -->")).toEqual({ a: "" });
  });

  it("normalises CRLF to LF", () => {
    const md = "<!-- docsync:start a -->\r\nline1\r\nline2\r\n<!-- docsync:end -->\r\n";
    expect(readSections(md)).toEqual({ a: "line1\nline2" });
  });

  it("ignores a start marker with no end and still reads the next section", () => {
    const md = `<!-- docsync:start broken -->\nx\n${doc("ok", "y")}`;
    expect(readSections(md)).toEqual({ ok: "y" });
  });

  it("ignores an end marker with no start", () => {
    expect(readSections("hi\n<!-- docsync:end -->")).toEqual({});
  });

  it("first block wins on duplicate names", () => {
    expect(readSections(`${doc("a", "1")}\n${doc("a", "2")}`)).toEqual({ a: "1" });
  });

  it("tolerates extra whitespace in markers", () => {
    expect(readSections("<!--   docsync:start   a   -->\nx\n<!--docsync:end-->")).toEqual({ a: "x" });
  });
});

describe("writeSection", () => {
  it("replaces an existing block and leaves surrounding text untouched", () => {
    const md = `# Title\n\nhuman text\n\n${doc("a", "old")}\n\nmore human text\n`;
    expect(writeSection(md, "a", "new")).toBe(
      `# Title\n\nhuman text\n\n${doc("a", "new")}\n\nmore human text\n`,
    );
  });

  it("only touches the named section", () => {
    const md = `${doc("a", "1")}\n${doc("b", "2")}\n`;
    expect(writeSection(md, "b", "3")).toBe(`${doc("a", "1")}\n${doc("b", "3")}\n`);
  });

  it("appends when the section doesn't exist", () => {
    expect(writeSection("# Title\n", "a", "x")).toBe(`# Title\n\n${doc("a", "x")}\n`);
  });

  it("appends after text with no trailing newline", () => {
    expect(writeSection("# Title", "a", "x")).toBe(`# Title\n\n${doc("a", "x")}\n`);
  });

  it("doesn't add extra blank lines when one already exists", () => {
    expect(writeSection("# Title\n\n", "a", "x")).toBe(`# Title\n\n${doc("a", "x")}\n`);
  });

  it("writes into an empty document", () => {
    expect(writeSection("", "a", "x")).toBe(`${doc("a", "x")}\n`);
  });

  it("writes empty content", () => {
    expect(writeSection("", "a", "")).toBe("<!-- docsync:start a -->\n<!-- docsync:end -->\n");
    expect(readSections(writeSection(doc("a", "x"), "a", ""))).toEqual({ a: "" });
  });

  it("preserves CRLF documents", () => {
    const md = "# T\r\n\r\n<!-- docsync:start a -->\r\nold\r\n<!-- docsync:end -->\r\ntail\r\n";
    const out = writeSection(md, "a", "l1\nl2");
    expect(out).toBe("# T\r\n\r\n<!-- docsync:start a -->\r\nl1\r\nl2\r\n<!-- docsync:end -->\r\ntail\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("appends with CRLF in a CRLF document", () => {
    const out = writeSection("# T\r\n", "a", "x");
    expect(out).toBe("# T\r\n\r\n<!-- docsync:start a -->\r\nx\r\n<!-- docsync:end -->\r\n");
  });

  it("is not confused by $ patterns in content", () => {
    const out = writeSection(doc("a", "old"), "a", "cost $& $1 $$");
    expect(readSections(out)).toEqual({ a: "cost $& $1 $$" });
  });

  it("round-trips through readSections", () => {
    const out = writeSection(writeSection("", "a", "one"), "b", "two\n\nthree");
    expect(readSections(out)).toEqual({ a: "one", b: "two\n\nthree" });
  });

  it("replaces the right block when a broken start precedes it", () => {
    const md = `<!-- docsync:start a -->\nlost\n${doc("a", "real")}\n`;
    expect(readSections(writeSection(md, "a", "new")).a).toBe("new");
    expect(writeSection(md, "a", "new")).toContain("lost");
  });

  it("rejects invalid section names", () => {
    expect(() => writeSection("", "bad name", "x")).toThrow(/Invalid section name/);
    expect(() => writeSection("", "a-->", "x")).toThrow();
  });
});
