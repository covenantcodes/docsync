import { z } from "zod";
import type { CompleteOptions, Provider } from "../providers/index.js";
import { normalizeTables } from "./markdown.js";

export const MAX_DIFF_CHARS = 60_000;

const EditSchema = z.object({
  section: z.string().regex(/^[A-Za-z0-9_-]+$/, "section must be letters, digits, '-' or '_'"),
  content: z.string(), // markdown
  reason: z.string(), // one line, shown to the dev
});
export const EditsSchema = z.array(EditSchema);
export type Edit = z.infer<typeof EditSchema>;

// ---- diff preparation -------------------------------------------------------

const REDACTED = "[REDACTED]";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
// NAME containing KEY/SECRET/TOKEN/PASSWORD, then = or :, then a value of 8+ chars that isn't a function call
// (so `apiKey: string` and `const t = getToken(x)` survive).
const SECRET_ASSIGNMENT =
  /\b([\w.-]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)(?:[_.-][\w.-]*)?)(\s*[:=]\s*)(["'`]?)(?![\w.$]*\()[^\s"'`,;]{8,}/gi;
const KNOWN_TOKENS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // Anthropic / OpenAI style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
];

/** Best-effort masking of obvious secrets. Not a guarantee; .env files are excluded separately before diffing. */
export function redactSecrets(diff: string): string {
  // Diff "+"/" " prefixes inside the block are swallowed too; the block collapses to one marker.
  let out = diff.replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]");
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string, sep: string, quote: string) => `${name}${sep}${quote}${REDACTED}`);
  for (const re of KNOWN_TOKENS) out = out.replace(re, REDACTED);
  return out;
}

/** Cuts the diff at a line boundary once it exceeds `max` chars. */
export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): { text: string; truncated: boolean } {
  if (diff.length <= max) return { text: diff, truncated: false };
  const cut = diff.lastIndexOf("\n", max);
  return { text: diff.slice(0, cut > 0 ? cut : max) + "\n[... diff truncated ...]", truncated: true };
}

// ---- prompt building --------------------------------------------------------

export const SYSTEM_PROMPT = `You update project documentation from a git diff.

Rules:
- Document only what the diff shows.
- Never invent endpoints, env vars, functions or behaviour.
- Omit sections that need no change. If nothing needs changing, reply with [].
- The "changelog" section gets a short dated bullet per meaningful change. Keep the existing entries and add new ones at the top.
- "content" is the full new markdown body of the section (without the docsync marker comments), not a patch.
- Values in the diff shown as [REDACTED] are secrets that were masked; never try to reconstruct them.
- Reply with JSON only: an array of {"section": string, "content": string, "reason": string}, where "reason" is one line explaining the change. No prose, no code fences.`;

export interface PromptInput {
  area: string;
  doc: string;
  sections: Record<string, string>;
  files: string[];
  diff: string;
  /** YYYY-MM-DD, used for changelog entries. */
  date: string;
}

export function buildUserPrompt(input: PromptInput): string {
  const names = Object.keys(input.sections);
  const current = names.length
    ? names.map((n) => `### ${n}\n${input.sections[n] || "(empty)"}`).join("\n\n")
    : "(no managed sections yet)";
  return `Today's date: ${input.date}
Area: ${input.area}
Doc file: ${input.doc}

Current managed sections:
${current}

Changed files:
${input.files.map((f) => `- ${f}`).join("\n")}

Diff:
\`\`\`diff
${input.diff}
\`\`\``;
}

// ---- parsing ----------------------------------------------------------------

/** Pulls the JSON out of a reply that may be wrapped in a code fence. */
export function stripCodeFences(text: string): string {
  const t = text.trim();
  const fenced = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  return (fenced ? fenced[1]! : t).trim();
}

export function parseEdits(text: string): Edit[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFences(text));
  } catch (err) {
    throw new Error(`reply is not valid JSON: ${(err as Error).message}`);
  }
  const res = EditsSchema.safeParse(raw);
  if (!res.success) throw new Error(`reply does not match the expected shape:\n${z.prettifyError(res.error)}`);
  return res.data.map((e) => ({ ...e, content: normalizeTables(e.content) }));
}

/** Asks the provider for edits; on a bad reply retries once with the error appended, then throws. */
export async function requestEdits(
  provider: Provider,
  system: string,
  user: string,
  onEvent?: CompleteOptions["onEvent"],
): Promise<Edit[]> {
  const options: CompleteOptions | undefined = onEvent ? { onEvent } : undefined;
  const first = await provider.complete(system, user, options);
  try {
    return parseEdits(first);
  } catch (err) {
    onEvent?.({ type: "invalid-reply", message: (err as Error).message });
    const retry = `${user}

Your previous reply was rejected: ${(err as Error).message}

Previous reply:
${first}

Reply again with valid JSON only, matching the format described.`;
    const second = await provider.complete(system, retry, options);
    try {
      return parseEdits(second);
    } catch (err2) {
      throw new Error(`Model returned an invalid reply twice: ${(err2 as Error).message}`);
    }
  }
}
