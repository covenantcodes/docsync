import { execa } from "execa";

// Read-only git helpers. Nothing here mutates the repo.

// Hash of git's empty tree: lets a repo with a single commit be diffed "from nothing".
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["--literal-pathspecs", ...args], { cwd });
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const { failed } = await execa("git", args, { cwd, reject: false });
  return !failed;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]);
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Resolves the ref to diff against: explicit `since`, else `lastSha`, else HEAD~1 (or the empty tree for a root commit). */
export async function resolveBase(
  cwd: string,
  { since, lastSha }: { since?: string | undefined; lastSha?: string | undefined },
): Promise<string> {
  const requested = since ?? lastSha;
  if (requested) {
    if (!(await gitOk(cwd, ["cat-file", "-e", `${requested}^{commit}`]))) {
      const hint = since ? "" : " (history may have been rewritten; pass --since <ref>)";
      throw new Error(`Cannot find git ref "${requested}"${hint}`);
    }
    return requested;
  }
  return (await gitOk(cwd, ["rev-parse", "--verify", "--quiet", "HEAD~1"])) ? "HEAD~1" : EMPTY_TREE;
}

function diffArgs(base: string, staged: boolean): string[] {
  return staged ? ["--cached"] : [base];
}

/** Changed tracked files (repo-relative, forward slashes) between `base` and the working tree, or the index with `staged`. */
export async function changedFiles(cwd: string, base: string, staged = false): Promise<string[]> {
  const out = await git(cwd, ["diff", "--name-only", "--no-renames", "-z", ...diffArgs(base, staged)]);
  return out.split("\0").filter(Boolean);
}

/** Unified diff restricted to `files`. */
export async function diffFor(cwd: string, base: string, files: string[], staged = false): Promise<string> {
  if (files.length === 0) return "";
  return git(cwd, ["diff", "--no-color", "--no-renames", "--no-ext-diff", ...diffArgs(base, staged), "--", ...files]);
}
