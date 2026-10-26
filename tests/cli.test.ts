import { describe, expect, it } from "vitest";
import { check } from "../src/commands/check.js";

describe("stub commands", () => {
  it("check returns exit code 0", async () => {
    await expect(check()).resolves.toBe(0);
  });
});
