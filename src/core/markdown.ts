const ROW = /^\s*\|.*\|\s*$/;
const FENCE = /^\s*```/;

const cellCount = (row: string): number => row.trim().replace(/^\||\|$/g, "").split("|").length;

/**
 * Models often write GitHub-flavoured tables without the `|---|---|` row under the header, which then
 * don't render. Inserts the missing separator. Code fences and single-row "tables" are left alone.
 */
export function normalizeTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !ROW.test(line)) continue;
    const startsTable = i === 0 || !ROW.test(lines[i - 1]!);
    const next = lines[i + 1];
    if (startsTable && next !== undefined && ROW.test(next) && !/^[\s|:-]+$/.test(next)) {
      out.push(`|${Array(cellCount(line)).fill("---").join("|")}|`);
    }
  }
  return out.join("\n");
}
