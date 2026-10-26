import { describe, expect, it } from "vitest";
import { update } from "../src/commands/update.js";
import { check } from "../src/commands/check.js";

describe("stub commands", () => {
  it("update resolves", async () => {
    await expect(update({})).resolves.toBeUndefined();
  });
  it("check returns exit code 0", async () => {
    await expect(check()).resolves.toBe(0);
  });
});
