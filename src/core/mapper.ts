import picomatch from "picomatch";
import type { Area, Config } from "./config.js";

// Never sent to an LLM, regardless of what the user's config says.
const ALWAYS_IGNORE = ["**/.env*"];

const opts = { dot: true } as const;

/** Drops files matching the config's ignore list or the built-in secret patterns. */
export function filterIgnored(files: string[], ignore: string[]): string[] {
  const isIgnored = picomatch([...ALWAYS_IGNORE, ...ignore], opts);
  return files.filter((f) => !isIgnored(f));
}

export interface AreaChange {
  area: Area;
  files: string[];
}

/** Groups files by area. A file belongs to the first area whose paths match it; unmatched files are dropped. */
export function groupByArea(files: string[], areas: Area[]): AreaChange[] {
  const matchers = areas.map((area) => picomatch(area.paths, opts));
  const groups = areas.map((area): AreaChange => ({ area, files: [] }));
  for (const file of files) {
    const i = matchers.findIndex((m) => m(file));
    if (i !== -1) groups[i]!.files.push(file);
  }
  return groups.filter((g) => g.files.length > 0);
}

/**
 * The code changes that docs should reflect: ignored files and docsync's own files (docs, config, state)
 * are removed, then the rest is grouped by area.
 */
export function groupChanges(
  files: string[],
  config: Pick<Config, "areas" | "ignore">,
  ownFiles: string[] = [],
): AreaChange[] {
  const own = new Set([...ownFiles, ...config.areas.map((a) => a.doc)]);
  return groupByArea(
    filterIgnored(files, config.ignore).filter((f) => !own.has(f)),
    config.areas,
  );
}

/** Areas whose code changed while their doc file did not. */
export function findStale(
  files: string[],
  config: Pick<Config, "areas" | "ignore">,
  ownFiles: string[] = [],
): AreaChange[] {
  const changed = new Set(files);
  return groupChanges(files, config, ownFiles).filter((g) => !changed.has(g.area.doc));
}
