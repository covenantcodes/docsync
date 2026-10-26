import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const STATE_FILE = ".docsync.json";

const StateSchema = z.object({ lastSha: z.string().min(1) });
export type State = z.infer<typeof StateSchema>;

/** Returns null when the state file doesn't exist yet. */
export async function readState(root: string): Promise<State | null> {
  let text: string;
  try {
    text = await readFile(join(root, STATE_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${STATE_FILE} is not valid JSON`);
  }
  const res = StateSchema.safeParse(raw);
  if (!res.success) throw new Error(`Invalid ${STATE_FILE}:\n${z.prettifyError(res.error)}`);
  return res.data;
}

export async function writeState(root: string, state: State): Promise<void> {
  await writeFile(join(root, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}
