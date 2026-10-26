import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createProvider } from "../src/providers/index.js";

describe("providers", () => {
  it("anthropic requires ANTHROPIC_API_KEY", () => {
    expect(() => createAnthropicProvider({ model: "m" }, {})).toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it("anthropic builds a provider when the key is present", () => {
    const p = createAnthropicProvider({ model: "m" }, { ANTHROPIC_API_KEY: "sk-test" });
    expect(typeof p.complete).toBe("function");
  });

  it("rejects unknown providers", () => {
    expect(() => createProvider({ provider: "nope", model: "m" })).toThrow(/Unknown provider "nope"/);
  });
});
