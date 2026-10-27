import type { SourceFile } from "./source.js";

export interface FeatureSection {
  name: string;
  guidance: string;
}

/** The fixed structure of a feature doc. Order here is the order in the file. */
export const FEATURE_SECTIONS: FeatureSection[] = [
  {
    name: "overview",
    guidance: "What the feature does, who uses it, and how the pieces fit together, in 2-4 sentences.",
  },
  {
    name: "flow",
    guidance:
      "The end-to-end flow as numbered steps across client, server and third parties, naming the function, screen or route involved in each step. Add one ```mermaid sequenceDiagram``` only if the code shows two or more actors.",
  },
  {
    name: "endpoints",
    guidance:
      'One "### METHOD /path" heading per endpoint the code defines or calls. Under each: purpose; auth (only if visible); a request table with columns Parameter | In (path/query/body/header) | Type | Required | Notes, with the parameter name in backticks exactly as written in the code; the response shape; and the error cases (status or code, and when it happens). Include an example request only if it can be built from the code, using obvious placeholders for values.',
  },
  {
    name: "data-models",
    guidance: "Types, entities and enums used by the feature, as tables of field | type | notes with field names in backticks exactly as in the code.",
  },
  {
    name: "configuration",
    guidance: "Environment variables, feature flags and constants the feature reads, in a table with the name in backticks. Names and meaning only, never values.",
  },
  {
    name: "edge-cases",
    guidance: "Validation rules, retries, idempotency, timeouts, and failure handling that are visible in the code.",
  },
];

export const FEATURE_SYSTEM_PROMPT = `You write developer documentation for one feature of a software project, from its source code.

Rules:
- Document only what the provided source code shows. Never invent endpoints, parameters, fields, env vars, functions or behaviour.
- If the code doesn't show something a section asks for, write exactly: Not found in the provided code.
- Use identifiers (route paths, parameter names, env vars) exactly as they appear in the code.
- End each section with a line "Sources: " followed by the files it is based on, each in backticks, using the exact paths given. Only cite files you were given.
- Values shown as [REDACTED] are masked secrets; never try to reconstruct them, and never write secret values.
- Where an earlier version of a section is provided, keep its wording where it is still accurate and change only what the code requires.
- "content" is the full markdown body of the section, without the docsync marker comments and without a heading for the section itself.
- Write every section listed. Reply with JSON only: an array of {"section": string, "content": string, "reason": string}, where "reason" is one line saying what the section covers or changed. No prose, no code fences around the JSON.`;

export interface FeaturePromptInput {
  feature: string;
  doc: string;
  /** Current managed sections, if the doc already exists. */
  sections: Record<string, string>;
  files: SourceFile[];
  omitted: string[];
}

export function buildFeaturePrompt(i: FeaturePromptInput): string {
  const template = FEATURE_SECTIONS.map((s) => `- ${s.name}: ${s.guidance}`).join("\n");
  const previous = Object.entries(i.sections)
    .filter(([name, text]) => FEATURE_SECTIONS.some((s) => s.name === name) && text && !text.startsWith("_Not documented yet"))
    .map(([name, text]) => `### ${name}\n${text}`)
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
