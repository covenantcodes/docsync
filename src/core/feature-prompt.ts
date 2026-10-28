import type { SourceFile } from "./source.js";

export interface FeatureSection {
  name: string;
  /** Heading docsync puts above the section (the model never writes it). */
  heading: string;
  guidance: string;
}

/** The fixed structure of a feature doc. Order here is the order in the file. */
export const FEATURE_SECTIONS: FeatureSection[] = [
  {
    name: "overview",
    heading: "Overview",
    guidance: "What the feature does, who uses it, and how the pieces fit together, in 2-4 sentences.",
  },
  {
    name: "flow",
    heading: "Flow",
    guidance:
      "The end-to-end flow as numbered steps across client, server and third parties, naming the function, screen or route involved in each step. Add one ```mermaid sequenceDiagram``` only if the code shows two or more actors.",
  },
  {
    name: "components",
    heading: "Components",
    guidance:
      'For UI code (screens, views, widgets): one "### ComponentName" heading per component or screen file, in the order a reader should meet them. Under each: its role in one sentence; its props or inputs as a table with columns Prop | Type | Required | Notes (names in backticks exactly as written in the code); local state, animations, side effects and navigation it triggers; and which other components it renders. Leave out anything the code does not show.',
  },
  {
    name: "endpoints",
    heading: "Endpoints",
    guidance:
      'One "### METHOD /path" heading per endpoint the code defines or calls. Under each: purpose; auth (only if visible; otherwise leave the line out); a request table with columns Parameter | In (path/query/body/header) | Type | Required | Notes, with the parameter name in backticks exactly as written in the code; the response shape; and the error cases (status or code, and when it happens). Include an example request only if it can be built from the code, using obvious placeholders for values.',
  },
  {
    name: "data-models",
    heading: "Data models",
    guidance: "Types, entities and enums used by the feature, as tables of field | type | notes with field names in backticks exactly as in the code.",
  },
  {
    name: "configuration",
    heading: "Configuration",
    guidance: "Environment variables, feature flags and constants the feature reads, in a table with the name in backticks. Names and meaning only, never values.",
  },
  {
    name: "edge-cases",
    heading: "Edge cases",
    guidance: "Validation rules, retries, idempotency, timeouts, cleanup and failure handling that are visible in the code. List only what the code shows; do not list things that are absent.",
  },
];

export const SECTION_NAMES = FEATURE_SECTIONS.map((s) => s.name);

/** The sections to write for a feature: its `sections` list if it has one, else all of them. Always in template order. */
export function sectionsFor(feature: { sections?: string[] | undefined }): FeatureSection[] {
  const wanted = feature.sections;
  return wanted ? FEATURE_SECTIONS.filter((s) => wanted.includes(s.name)) : FEATURE_SECTIONS;
}

const NOT_FOUND = /^not found in the provided code\.?$/i;

/** True if the model had nothing to say: empty, or just "Not found in the provided code." (ignoring Sources lines). */
export function isEmptySection(content: string): boolean {
  const body = content
    .split("\n")
    .filter((l) => !/^[ \t>*_-]*sources?\b[*_]*:?/i.test(l))
    .join("\n")
    .trim();
  return body === "" || NOT_FOUND.test(body);
}

/** The managed block's content: docsync's heading, then the model's body. */
export function withHeading(section: FeatureSection, body: string): string {
  return `## ${section.heading}\n\n${body.replace(/^\n+|\n+$/g, "")}`;
}

/** Inverse of withHeading, for feeding an earlier version back to the model. */
export function stripHeading(section: FeatureSection, text: string): string {
  return text.replace(new RegExp(`^##\\s+${section.heading}\\s*\\n+`), "");
}

export const FEATURE_SYSTEM_PROMPT = `You write developer documentation for one feature of a software project, from its source code.

Rules:
- Document only what the provided source code shows. Never invent endpoints, parameters, fields, env vars, functions or behaviour.
- If the code shows nothing at all for a section (for example "endpoints" for a screen that makes no network calls), leave that section out of your reply entirely. Do not write placeholders such as "Not found". Within a section that has content, simply leave out items the code doesn't show; don't list them as missing.
- Write tables as GitHub-flavoured markdown, including the |---|---| separator row under the header.
- Use identifiers (route paths, parameter names, env vars) exactly as they appear in the code.
- End each section with a line "Sources: " followed by the files it is based on, each in backticks, using the exact paths given. Only cite files you were given.
- Values shown as [REDACTED] are masked secrets; never try to reconstruct them, and never write secret values.
- Where an earlier version of a section is provided, keep its wording where it is still accurate and change only what the code requires.
- "content" is the full markdown body of the section, without the docsync marker comments and without a "##" heading for the section itself (docsync adds it). Use "###" for headings inside a section.
- Write each section listed that the code gives you something to say about. Reply with JSON only: an array of {"section": string, "content": string, "reason": string}, where "reason" is one line saying what the section covers or changed. No prose, no code fences around the JSON.`;

export interface FeaturePromptInput {
  feature: string;
  doc: string;
  /** Current managed sections, if the doc already exists. */
  sections: Record<string, string>;
  files: SourceFile[];
  omitted: string[];
  /** Which sections to ask for. Defaults to all of them. */
  wanted?: FeatureSection[];
}

export function buildFeaturePrompt(i: FeaturePromptInput): string {
  const wanted = i.wanted ?? FEATURE_SECTIONS;
  const template = wanted.map((s) => `- ${s.name}: ${s.guidance}`).join("\n");
  const previous = wanted
    .flatMap((s) => {
      const text = i.sections[s.name];
      return text && !text.startsWith("_Not documented yet") && !isEmptySection(text) ? [`### ${s.name}\n${stripHeading(s, text)}`] : [];
    })
    .join("\n\n");
  const sources = i.files.map((f) => `=== FILE: ${f.path} ===\n${f.content}`).join("\n\n");
  const omitted = i.omitted.length
    ? `\n\nFiles that exist but were NOT included (too large or over budget): ${i.omitted.join(", ")}. Do not guess their contents.`
    : "";
  return `Feature: ${i.feature}
Doc file: ${i.doc}

Sections to write:
${template}

${previous ? `Earlier version of the sections:\n${previous}\n\n` : ""}Source files:

${sources}${omitted}`;
}
