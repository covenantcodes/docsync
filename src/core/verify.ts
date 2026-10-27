import type { Edit } from "./prompt.js";
import type { SourceFile } from "./source.js";

export type FindingKind = "route" | "field" | "env" | "source";

export interface Finding {
  section: string;
  kind: FindingKind;
  value: string;
  /** Why it was flagged. */
  detail: string;
}

const FENCE = /```[\s\S]*?```/g;
const ROUTE = /(?:^|[\s`(])((?:\/[A-Za-z0-9_\-.:{}<>$]+)+)/g;
const TABLE_FIRST_CELL = /^\|\s*`([^`]+)`\s*\|/gm;
const ENV_VAR = /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;
const SOURCES_LINE = /^[ \t>*_-]*sources?\b[*_]*:?[*_]*(.*)$/gim;
const BACKTICKED = /`([^`]+)`/g;

const isParamSegment = (s: string): boolean => /^[:{<$]/.test(s);

/**
 * Cheap, mechanical grounding check. Flags things the generated doc states that don't appear in the source
 * that was sent: route segments, parameter / field / env names, and cited files. It can't prove a doc is right,
 * but an invented endpoint or field almost always shows up here.
 */
export function verifyEdits(edits: Edit[], files: SourceFile[]): Finding[] {
  const haystack = files.map((f) => f.content).join("\n");
  const provided = new Set(files.map((f) => f.path));
  const findings: Finding[] = [];

  for (const { section, content } of edits) {
    const seen = new Set<string>();
    const add = (kind: FindingKind, value: string, detail: string) => {
      const key = `${kind}\0${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ section, kind, value, detail });
    };
    const prose = content.replace(FENCE, ""); // diagrams and examples aren't claims about the code

    for (const m of prose.matchAll(ROUTE)) {
      const route = m[1]!;
      const missing = route
        .split("/")
        .filter((seg) => seg.length > 2 && !isParamSegment(seg))
        .find((seg) => !haystack.includes(seg));
      if (missing) add("route", route, `"${missing}" not found in the source`);
    }

    for (const m of prose.matchAll(TABLE_FIRST_CELL)) {
      const cell = m[1]!;
      const missing = cell
        .split(/[.[\]]/)
        .filter((p) => p.length > 2 && /^[A-Za-z_$][\w$-]*$/.test(p)) // 1-2 char names match almost anything
        .find((p) => !haystack.includes(p));
      if (missing) add("field", cell, `"${missing}" not found in the source`);
    }

    for (const m of prose.matchAll(ENV_VAR)) {
      if (!haystack.includes(m[1]!)) add("env", m[1]!, "not found in the source");
    }

    for (const line of prose.matchAll(SOURCES_LINE)) {
      for (const c of line[1]!.matchAll(BACKTICKED)) {
        const path = c[1]!.replace(/:\d+(-\d+)?$/, "");
        if (!provided.has(path)) add("source", c[1]!, "not one of the files that were sent");
      }
    }
  }
  return findings;
}
