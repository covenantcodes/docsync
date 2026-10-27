import { readFile } from "node:fs/promises";
import { join } from "node:path";
import picomatch from "picomatch";
import type { Feature } from "./config.js";
import { filterIgnored } from "./mapper.js";
import { redactSecrets } from "./prompt.js";

export interface SourceFile {
  path: string;
  content: string;
}

export interface Collected {
  files: SourceFile[];
  /** Matched files that didn't fit the budget, or were unreadable/binary/huge. */
  omitted: string[];
}

const MAX_FILE_BYTES = 200_000;

// Higher first. Files that define behaviour (routes, handlers, schemas, API clients) beat UI chrome, tests and styles.
const BEHAVIOUR = /(route|router|controller|handler|endpoint|api|service|usecase|use-case|resolver|schema|validat|dto|model|entity|types?|client)/i;
const UI_STATE = /(screen|page|hook|store|slice|saga|reducer|context|provider)/i;
const LOW = /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|fixtures?|stories)\/|\.(test|spec|stories)\./i;
const STYLE = /\.(css|scss|sass|less|svg|snap|md|lock)$|(^|\/)styles?\//i;

/** Heuristic importance of a path; deterministic. */
export function rankPath(path: string): number {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dir = path.slice(0, path.length - name.length);
  let score = 0;
  if (BEHAVIOUR.test(name)) score += 5;
  else if (BEHAVIOUR.test(dir)) score += 2;
  if (UI_STATE.test(name)) score += 3;
  if (LOW.test(path)) score -= 10;
  if (STYLE.test(path)) score -= 8;
  if (/\.json$/.test(path)) score -= 5;
  return score;
}

/** Files of `feature` among `tracked`, best first: not ignored, not docsync's own, matching one of the feature's paths. */
export function selectFeatureFiles(
  tracked: string[],
  feature: Feature,
  ignore: string[],
  ownFiles: string[],
): string[] {
  const matches = picomatch(feature.paths, { dot: true });
  const own = new Set(ownFiles);
  return filterIgnored(
    tracked.filter((f) => matches(f) && !own.has(f)),
    ignore,
  ).sort((a, b) => rankPath(b) - rankPath(a) || (a < b ? -1 : 1));
}

/**
 * Reads the feature's files in rank order until `maxChars` is used. Secrets are redacted in what is sent.
 * A file that doesn't fit is skipped (smaller ones after it may still fit) and reported in `omitted`.
 */
export async function collectSources(root: string, paths: string[], maxChars: number): Promise<Collected> {
  const files: SourceFile[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const path of paths) {
    let buf: Buffer;
    try {
      buf = await readFile(join(root, path));
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (buf.length > MAX_FILE_BYTES || buf.includes(0)) {
      omitted.push(path);
      continue;
    }
    const content = redactSecrets(buf.toString("utf8"));
    if (used + content.length > maxChars) {
      omitted.push(path);
      continue;
    }
    used += content.length;
    files.push({ path, content });
  }
  return { files, omitted };
}
