import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createCliProvider, splitCommand } from "../src/providers/cli.js";
import { bestGuess, detectProviders } from "../src/providers/detect.js";
import { createManualProvider } from "../src/providers/manual.js";
import { createOllamaProvider } from "../src/providers/ollama.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { createProvider, maxDiffChars } from "../src/providers/index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch = (res: Response | (() => Response)) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (typeof res === "function" ? res() : res.clone()));
const body = (f: ReturnType<typeof fakeFetch>) => JSON.parse(f.mock.calls[0]![1]!.body as string);

describe("createProvider", () => {
  it("anthropic requires ANTHROPIC_API_KEY", () => {
    expect(() => createAnthropicProvider({ model: "m" }, {})).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(typeof createAnthropicProvider({ model: "m" }, { ANTHROPIC_API_KEY: "sk-test" }).complete).toBe("function");
  });

  it("rejects unknown providers", () => {
    expect(() => createProvider({ provider: "nope", model: "m" })).toThrow(/Unknown provider "nope"/);
  });

  it("routes every supported provider", () => {
    const env = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", GEMINI_API_KEY: "k", DOCSYNC_CLI: "echo" };
    for (const provider of ["anthropic", "openai", "gemini", "ollama", "cli", "manual"]) {
      expect(typeof createProvider({ provider, model: "m" }, env).complete).toBe("function");
    }
    expect(typeof createProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://x/v1" }, {}).complete).toBe("function");
  });

  it("keyed providers fail early with the variable name", () => {
    expect(() => createProvider({ provider: "openai", model: "m" }, {})).toThrow(/OPENAI_API_KEY/);
    expect(() => createProvider({ provider: "gemini", model: "m" }, {})).toThrow(/GEMINI_API_KEY/);
    expect(() => createProvider({ provider: "cli" }, {})).toThrow(/DOCSYNC_CLI/);
  });

  it("local providers need no key", () => {
    expect(() => createProvider({ provider: "ollama", model: "m" }, {})).not.toThrow();
    expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://x" }, {})).not.toThrow();
  });

  it("per-provider diff limits, overridable", () => {
    expect(maxDiffChars({ provider: "anthropic" })).toBe(60_000);
    expect(maxDiffChars({ provider: "ollama" })).toBe(24_000);
    expect(maxDiffChars({ provider: "ollama", maxDiffChars: 5000 })).toBe(5000);
  });
});

describe("config validation for providers", () => {
  const areas = [{ name: "a", paths: ["a/**"], doc: "a.md" }];
  it("anthropic keeps its default model; others must name one", () => {
    expect(parseConfig({ areas }).model).toBe("claude-sonnet-5-5");
    for (const provider of ["openai", "gemini", "ollama"]) {
      expect(() => parseConfig({ provider, areas })).toThrow(/model/);
    }
    expect(parseConfig({ provider: "cli", areas }).model).toBeUndefined();
    expect(parseConfig({ provider: "manual", areas }).model).toBeUndefined();
  });
  it("openai-compatible needs a baseUrl; extra fields validate", () => {
    expect(() => parseConfig({ provider: "openai-compatible", model: "m", areas })).toThrow(/baseUrl/);
    expect(() => parseConfig({ provider: "ollama", model: "m", baseUrl: "not a url", areas })).toThrow();
    expect(() => parseConfig({ provider: "openai", model: "m", apiKeyEnv: "has space", areas })).toThrow();
    expect(parseConfig({ provider: "ollama", model: "m", contextWindow: 8192, maxDiffChars: 1000, areas })).toMatchObject({
      contextWindow: 8192,
      maxDiffChars: 1000,
    });
  });
});

describe("openai / gemini / openai-compatible", () => {
  const ok = () => json({ choices: [{ message: { content: "[]" }, finish_reason: "stop" }] });

  it("calls /chat/completions with auth and returns the text", async () => {
    const f = fakeFetch(ok);
    const p = createOpenAIProvider({ provider: "openai", model: "m1" }, { env: { OPENAI_API_KEY: "sk-x" }, fetch: f });
    expect(await p.complete("sys", "usr")).toBe("[]");
    expect(f.mock.calls[0]![0]).toBe("https://api.openai.com/v1/chat/completions");
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer sk-x");
    expect(body(f)).toMatchObject({ model: "m1", messages: [{ role: "system", content: "sys" }, { role: "user", content: "usr" }] });
  });

  it("gemini uses its compat endpoint and key", async () => {
    const f = fakeFetch(ok);
    await createOpenAIProvider({ provider: "gemini", model: "g" }, { env: { GEMINI_API_KEY: "k" }, fetch: f }).complete("s", "u");
    expect(f.mock.calls[0]![0]).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  });

  it("custom endpoint: trims trailing slash, no auth unless apiKeyEnv is set", async () => {
    const f = fakeFetch(ok);
    await createOpenAIProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://localhost:1234/v1/" }, { env: {}, fetch: f }).complete("s", "u");
    expect(f.mock.calls[0]![0]).toBe("http://localhost:1234/v1/chat/completions");
    expect(f.mock.calls[0]![1]!.headers as Record<string, string>).not.toHaveProperty("authorization");
    expect(() => createOpenAIProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://x", apiKeyEnv: "MY_KEY" }, { env: {} })).toThrow(/MY_KEY/);
  });

  it("maps errors to friendly messages", async () => {
    const mk = (res: Response) =>
      createOpenAIProvider({ provider: "openai", model: "m" }, { env: { OPENAI_API_KEY: "k" }, fetch: fakeFetch(res), sleep: async () => {} });
    await expect(mk(json({ error: { message: "bad" } }, 401)).complete("s", "u")).rejects.toThrow(/rejected the API key/);
    await expect(mk(json({ error: { message: "no such model" } }, 404)).complete("s", "u")).rejects.toThrow(/no such model/);
    await expect(mk(json({}, 429)).complete("s", "u")).rejects.toThrow(/rate limit/);
    await expect(mk(json({ error: { message: "bad input" } }, 422)).complete("s", "u")).rejects.toThrow(/error 422: bad input/);
  });

  it("handles truncated, filtered, and empty replies", async () => {
    const mk = (choice: unknown) =>
      createOpenAIProvider({ provider: "openai", model: "m" }, { env: { OPENAI_API_KEY: "k" }, fetch: fakeFetch(json({ choices: [choice] })) });
    await expect(mk({ message: { content: "[" }, finish_reason: "length" }).complete("s", "u")).rejects.toThrow(/cut off/);
    await expect(mk({ message: { content: null }, finish_reason: "content_filter" }).complete("s", "u")).rejects.toThrow(/declined/);
    await expect(mk({ message: { content: "" }, finish_reason: "stop" }).complete("s", "u")).rejects.toThrow(/empty/);
  });

  it("explains an unreachable server", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const p = createOpenAIProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://localhost:1/v1" }, { env: {}, fetch: f });
    await expect(p.complete("s", "u")).rejects.toThrow(/Could not reach .*baseUrl/);
  });
});

describe("ollama", () => {
  const ok = () => json({ message: { content: "[]" }, done: true, done_reason: "stop" });

  it("uses the native API and sets num_ctx", async () => {
    const f = fakeFetch(ok);
    expect(await createOllamaProvider({ model: "llama3" }, { fetch: f }).complete("s", "u")).toBe("[]");
    expect(f.mock.calls[0]![0]).toBe("http://localhost:11434/api/chat");
    expect(body(f)).toMatchObject({ model: "llama3", stream: true, options: { num_ctx: 16384 } });
  });

  it("honours baseUrl and contextWindow", async () => {
    const f = fakeFetch(ok);
    await createOllamaProvider({ model: "m", baseUrl: "http://box:11434/", contextWindow: 4096 }, { fetch: f }).complete("s", "u");
    expect(f.mock.calls[0]![0]).toBe("http://box:11434/api/chat");
    expect(body(f).options.num_ctx).toBe(4096);
  });

  it("tells you to pull a missing model, and to start Ollama", async () => {
    const missing = createOllamaProvider({ model: "nope" }, { fetch: fakeFetch(json({ error: "model not found" }, 404)) });
    await expect(missing.complete("s", "u")).rejects.toThrow(/ollama pull nope/);
    const down = createOllamaProvider({ model: "m" }, { fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }) });
    await expect(down.complete("s", "u")).rejects.toThrow(/ollama serve/);
  });

  it("flags truncated and empty replies", async () => {
    const mk = (b: unknown) => createOllamaProvider({ model: "m" }, { fetch: fakeFetch(json(b)) });
    await expect(mk({ message: { content: "[" }, done_reason: "length" }).complete("s", "u")).rejects.toThrow(/cut off/);
    await expect(mk({ message: { content: "" } }).complete("s", "u")).rejects.toThrow(/empty/);
  });
});

describe("cli provider", () => {
  it("splitCommand handles quotes without a shell", () => {
    expect(splitCommand("claude -p")).toEqual(["claude", "-p"]);
    expect(splitCommand(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f\\", "g"]);
    expect(splitCommand('x ""')).toEqual(["x", ""]);
    expect(() => splitCommand('x "oops')).toThrow(/Unterminated/);
  });

  it("pipes the prompt to the command and returns stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docsync-cli-"));
    try {
      const script = join(dir, "echo.mjs");
      await writeFile(script, 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify([{section:"x",content:s.includes("SYS")&&s.includes("USR")?"both":"missing",reason:"r"}])));');
      const p = createCliProvider({ DOCSYNC_CLI: `${process.execPath} "${script}"` });
      expect(JSON.parse(await p.complete("SYS", "USR"))[0].content).toBe("both");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports missing commands, failures and empty output", async () => {
    await expect(createCliProvider({ DOCSYNC_CLI: "definitely-not-a-command-xyz" }).complete("s", "u")).rejects.toThrow(/Command not found/);
    const fail = createCliProvider({ DOCSYNC_CLI: `${process.execPath} -e "console.error('nope');process.exit(2)"` });
    await expect(fail.complete("s", "u")).rejects.toThrow(/exited with code 2:\nnope/);
    const empty = createCliProvider({ DOCSYNC_CLI: `${process.execPath} -e ""` });
    await expect(empty.complete("s", "u")).rejects.toThrow(/no output/);
  });

  it("never reads the command from anywhere but DOCSYNC_CLI", () => {
    expect(() => createCliProvider({})).toThrow(/DOCSYNC_CLI/);
  });
});

describe("manual provider", () => {
  it("writes the prompt, waits, then returns what you saved", async () => {
    let promptText = "";
    const print = vi.fn();
    const p = createManualProvider({
      isInteractive: true,
      print,
      copy: async () => true,
      waitForEnter: async () => {
        const [, file] = /Save the JSON it replies with to (\S+)/.exec(print.mock.calls.join("\n").replace(/\u001b\[[0-9;]*m/g, ""))!;
        promptText = await readFile(file!.replace("reply.json", "prompt.md"), "utf8");
        await writeFile(file!, '[{"section":"a","content":"b","reason":"c"}]');
      },
    });
    expect(await p.complete("SYS", "USR")).toContain('"section":"a"');
    expect(promptText).toContain("SYS");
    expect(promptText).toContain("USR");
    expect(print.mock.calls.join("\n")).toContain("clipboard");
  });

  it("errors if no reply was saved, and when not interactive", async () => {
    const empty = createManualProvider({ isInteractive: true, print: () => {}, copy: async () => false, waitForEnter: async () => {} });
    await expect(empty.complete("s", "u")).rejects.toThrow(/No reply found/);
    await expect(createManualProvider({ isInteractive: false }).complete("s", "u")).rejects.toThrow(/interactive/);
  });
});

describe("detectProviders", () => {
  it("finds keys and a running Ollama", async () => {
    const f = fakeFetch(json({ models: [{ name: "llama3:8b" }, { name: "qwen:7b" }] }));
    const d = await detectProviders({ OPENAI_API_KEY: "k", GEMINI_API_KEY: "" }, f as unknown as typeof fetch);
    expect(d).toEqual({ keys: ["openai"], ollamaModels: ["llama3:8b", "qwen:7b"] });
    expect(bestGuess(d)).toBe("openai");
  });

  it("copes with nothing available", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("refused");
    });
    const d = await detectProviders({}, f as unknown as typeof fetch);
    expect(d).toEqual({ keys: [], ollamaModels: null });
    expect(bestGuess(d)).toBeUndefined();
  });

  it("suggests Ollama when it has models and no keys exist", () => {
    expect(bestGuess({ keys: [], ollamaModels: ["m"] })).toBe("ollama");
    expect(bestGuess({ keys: [], ollamaModels: [] })).toBeUndefined();
  });
});

const sse = (...chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const delta = (content: string, finish_reason: string | null = null) => ({ choices: [{ delta: { content }, finish_reason }] });

describe("streaming", () => {
  const openai = (res: () => Response, extra: object = {}) =>
    createOpenAIProvider({ provider: "openai", model: "m", ...extra }, { env: { OPENAI_API_KEY: "k" }, fetch: fakeFetch(res) });

  it("assembles an SSE reply and reports progress", async () => {
    const onEvent = vi.fn();
    const p = openai(() => sse(delta("[{"), delta('"a":1}]'), delta("", "stop"), "[DONE]"));
    expect(await p.complete("s", "u", { onEvent })).toBe('[{"a":1}]');
    expect(onEvent.mock.calls.map((c) => c[0])).toEqual([
      { type: "progress", chars: 2 },
      { type: "progress", chars: 9 },
    ]);
  });

  it("handles events split across network chunks", async () => {
    const full = `data: ${JSON.stringify(delta("hel"))}\n\ndata: ${JSON.stringify(delta("lo", "stop"))}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(full);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const p = openai(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    expect(await p.complete("s", "u")).toBe("hello");
  });

  it("flags a truncated stream and an in-stream error", async () => {
    await expect(openai(() => sse(delta("[", "length"))).complete("s", "u")).rejects.toThrow(/cut off/);
    await expect(openai(() => sse(delta("x"), { error: { message: "quota" } })).complete("s", "u")).rejects.toThrow(/quota/);
  });

  it("still accepts a server that ignores stream:true", async () => {
    const p = openai(() => json({ choices: [{ message: { content: "[]" }, finish_reason: "stop" }] }));
    expect(await p.complete("s", "u")).toBe("[]");
  });

  it("ollama streams NDJSON and reports progress", async () => {
    const lines = [{ message: { content: "[" } }, { message: { content: "]" } }, { done: true, done_reason: "stop" }];
    const onEvent = vi.fn();
    const p = createOllamaProvider(
      { model: "m" },
      { fetch: fakeFetch(() => new Response(lines.map((l) => JSON.stringify(l)).join("\n"), { headers: { "content-type": "application/x-ndjson" } })) },
    );
    expect(await p.complete("s", "u", { onEvent })).toBe("[]");
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});

describe("retries", () => {
  const busy = (status = 503, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify([{ error: { code: status, message: "high demand" } }]), { status, headers });
  const ok = () => json({ choices: [{ message: { content: "[]" }, finish_reason: "stop" }] });
  const mk = (responses: (() => Response)[], sleep = vi.fn(async (_ms: number) => {})) => {
    let i = 0;
    const f = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!());
    const p = createOpenAIProvider({ provider: "gemini", model: "m" }, { env: { GEMINI_API_KEY: "k" }, fetch: f as unknown as typeof fetch, sleep });
    return { p, f, sleep };
  };

  it("retries 503 with a visible event, then succeeds", async () => {
    const { p, f, sleep } = mk([() => busy(), () => busy(), ok]);
    const onEvent = vi.fn();
    expect(await p.complete("s", "u", { onEvent })).toBe("[]");
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 5000]);
    expect(onEvent.mock.calls[0]![0]).toMatchObject({ type: "retry", attempt: 1, maxAttempts: 4, delayMs: 2000, reason: "Gemini is overloaded (503)" });
  });

  it("honours Retry-After (capped at a minute)", async () => {
    const { p, sleep } = mk([() => busy(429, { "retry-after": "7" }), () => busy(429, { "retry-after": "999" }), ok]);
    await p.complete("s", "u");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([7000, 60000]);
  });

  it("gives up after 4 attempts with a clear message", async () => {
    const { p, f } = mk([() => busy()]);
    await expect(p.complete("s", "u")).rejects.toThrow(/gave up after 4 attempts/);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("does not retry errors that can't succeed (401, 404, 400)", async () => {
    for (const status of [400, 401, 404]) {
      const { p, f } = mk([() => busy(status)]);
      await expect(p.complete("s", "u")).rejects.toThrow();
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("ollama retries too", async () => {
    let n = 0;
    const f = vi.fn(async () => (n++ < 1 ? busy(503) : json({ message: { content: "[]" }, done: true })));
    const sleep = vi.fn(async (_ms: number) => {});
    const p = createOllamaProvider({ model: "m" }, { fetch: f as unknown as typeof fetch, sleep });
    expect(await p.complete("s", "u")).toBe("[]");
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("reasoningEffort", () => {
  const ok = () => json({ choices: [{ message: { content: "[]" }, finish_reason: "stop" }] });

  it("is sent as reasoning_effort only when set", async () => {
    const f = fakeFetch(ok);
    await createOpenAIProvider({ provider: "gemini", model: "m", reasoningEffort: "low" }, { env: { GEMINI_API_KEY: "k" }, fetch: f }).complete("s", "u");
    expect(body(f).reasoning_effort).toBe("low");
    const g = fakeFetch(ok);
    await createOpenAIProvider({ provider: "gemini", model: "m" }, { env: { GEMINI_API_KEY: "k" }, fetch: g }).complete("s", "u");
    expect(body(g)).not.toHaveProperty("reasoning_effort");
  });

  it("explains when the server rejects it", async () => {
    const f = fakeFetch(() => json({ error: { message: "Invalid reasoning_effort value" } }, 400));
    const p = createOpenAIProvider({ provider: "gemini", model: "m", reasoningEffort: "turbo" }, { env: { GEMINI_API_KEY: "k" }, fetch: f });
    await expect(p.complete("s", "u")).rejects.toThrow(/rejected reasoningEffort "turbo"/);
  });

  it("ollama maps none to think:false and passes other values through", async () => {
    const run = async (effort?: string) => {
      const f = fakeFetch(() => json({ message: { content: "[]" }, done: true }));
      await createOllamaProvider({ model: "m", reasoningEffort: effort }, { fetch: f }).complete("s", "u");
      return body(f);
    };
    expect((await run("none")).think).toBe(false);
    expect((await run("low")).think).toBe("low");
    expect(await run()).not.toHaveProperty("think");
  });

  it("anthropic validates it; config accepts any string", () => {
    expect(() => createAnthropicProvider({ model: "m", reasoningEffort: "turbo" }, { ANTHROPIC_API_KEY: "k" })).toThrow(/isn't valid for Anthropic/);
    expect(() => createAnthropicProvider({ model: "m", reasoningEffort: "low" }, { ANTHROPIC_API_KEY: "k" })).not.toThrow();
    expect(parseConfig({ provider: "gemini", model: "m", reasoningEffort: "low", areas: [{ name: "a", paths: ["a/**"], doc: "a.md" }] }).reasoningEffort).toBe("low");
  });
});
