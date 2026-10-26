// Managed sections: only content between docsync markers is ever touched.
// Everything outside the markers is human-owned and preserved byte for byte.

const NAME = "[A-Za-z0-9_-]+";
// The tempered body stops a start marker without an end from swallowing the next section.
const BLOCK = new RegExp(
  `<!--\\s*docsync:start\\s+(${NAME})\\s*-->((?:(?!<!--\\s*docsync:start)[\\s\\S])*?)<!--\\s*docsync:end\\s*-->`,
  "g",
);

const detectEol = (md: string): string => (md.includes("\r\n") ? "\r\n" : "\n");
const toLf = (s: string): string => s.replace(/\r\n/g, "\n");
const trimBlankEdges = (s: string): string => s.replace(/^\n+|\n+$/g, "");

/** Returns each managed section's content (LF-normalised, edge newlines trimmed). First block wins on duplicate names. */
export function readSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of md.matchAll(BLOCK)) {
    const name = m[1]!;
    if (!(name in out)) out[name] = trimBlankEdges(toLf(m[2]!));
  }
  return out;
}

function renderBlock(name: string, content: string, eol: string): string {
  const body = trimBlankEdges(toLf(content)).split("\n").join(eol);
  const inner = body === "" ? eol : `${eol}${body}${eol}`;
  return `<!-- docsync:start ${name} -->${inner}<!-- docsync:end -->`;
}

/** Replaces the named block, or appends a new one at the end if it doesn't exist. */
export function writeSection(md: string, name: string, content: string): string {
  if (!new RegExp(`^${NAME}$`).test(name)) {
    throw new Error(`Invalid section name "${name}" (use letters, digits, "-" or "_")`);
  }
  const eol = detectEol(md);
  const block = renderBlock(name, content, eol);

  let replaced = false;
  const next = md.replace(BLOCK, (whole, found: string) => {
    if (replaced || found !== name) return whole;
    replaced = true;
    return block;
  });
  if (replaced) return next;

  if (md.trim() === "") return block + eol;
  const base = md.endsWith("\n") ? md : md + eol;
  const gap = /(\r?\n){2}$/.test(base) ? "" : eol;
  return base + gap + block + eol;
}

export interface SectionEdit {
  section: string;
  content: string;
}

/** Applies edits in order, skipping ones that wouldn't change anything. */
export function applyEdits(md: string, edits: SectionEdit[]): string {
  let out = md;
  for (const e of edits) out = writeSection(out, e.section, e.content);
  return out;
}

export const DEFAULT_SECTIONS = ["overview", "setup", "architecture", "changelog"] as const;

/** A new doc: a human-owned title followed by the default managed sections, each with a placeholder. */
export function starterDoc(title: string): string {
  let md = `# ${title}\n`;
  for (const name of DEFAULT_SECTIONS) md = writeSection(md, name, "_Not documented yet. Run `docsync` to fill this in._");
  return md;
}
