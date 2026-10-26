import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Area } from "./config.js";

export interface Detection {
  areas: Area[];
  /** Where the areas came from, for display. Null when nothing was found. */
  source: string | null;
}

const CONVENTIONAL = ["apps/*", "packages/*", "services/*"];
const SKIP_DIRS = new Set(["node_modules"]);

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function subdirs(root: string, rel: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, rel), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => `${rel}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

async function isDir(root: string, rel: string): Promise<boolean> {
  try {
    await readdir(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

/** Turns workspace patterns into directories. Handles `dir`, `dir/*` and `dir/**`; anything fancier is skipped. */
export async function expandPatterns(root: string, patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const raw of patterns) {
    if (raw.startsWith("!")) continue;
    const p = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    const m = /^(.*)\/\*{1,2}$/.exec(p);
    if (m) {
      if (!/[*?[\]{}]/.test(m[1]!)) for (const d of await subdirs(root, m[1]!)) found.add(d);
    } else if (!/[*?[\]{}]/.test(p) && p !== "" && p !== "." && (await isDir(root, p))) {
      found.add(p);
    }
  }
  return [...found].sort();
}

/** Pulls the `packages:` list out of pnpm-workspace.yaml without a YAML parser. */
export function parsePnpmWorkspace(yaml: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item) out.push(item[1]!.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, ""));
    else if (/^\S/.test(line)) break; // next top-level key
  }
  return out;
}

function packageJsonWorkspaces(text: string): string[] {
  try {
    const ws = (JSON.parse(text) as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** One area per directory, with unique names (`apps-web` if two dirs are both called `web`). */
export function dirsToAreas(dirs: string[]): Area[] {
  const counts = new Map<string, number>();
  for (const d of dirs) {
    const base = d.split("/").pop()!;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return dirs.map((d) => {
    const base = d.split("/").pop()!;
    const name = counts.get(base)! > 1 ? d.replace(/\//g, "-") : base;
    return { name, paths: [`${d}/**`], doc: `docs/${name}.md` };
  });
}

export const singleProjectArea = (): Area => ({ name: "project", paths: ["**"], doc: "docs/OVERVIEW.md" });

/** Looks for workspaces in package.json, then pnpm-workspace.yaml, then apps/*, packages/*, services/*. */
export async function detectAreas(root: string): Promise<Detection> {
  const pkg = await readText(join(root, "package.json"));
  const fromPkg = pkg ? await expandPatterns(root, packageJsonWorkspaces(pkg)) : [];
  if (fromPkg.length) return { areas: dirsToAreas(fromPkg), source: "package.json workspaces" };

  const pnpm = await readText(join(root, "pnpm-workspace.yaml"));
  const fromPnpm = pnpm ? await expandPatterns(root, parsePnpmWorkspace(pnpm)) : [];
  if (fromPnpm.length) return { areas: dirsToAreas(fromPnpm), source: "pnpm-workspace.yaml" };

  const conventional = await expandPatterns(root, CONVENTIONAL);
  if (conventional.length) return { areas: dirsToAreas(conventional), source: "apps/, packages/, services/ folders" };

  return { areas: [], source: null };
}
