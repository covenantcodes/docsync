import { describe, expect, it, vi } from "vitest";
import { resolveEnv, keyVarFor, type CredentialDeps } from "../src/core/credentials.js";
import { detectKeyStore, linuxSecretService, macKeychain, windowsDpapi, type KeyStore, type Runner } from "../src/core/keystore.js";

const ok = { exitCode: 0, stdout: "", stderr: "" };

function memoryStore(initial: Record<string, string> = {}): KeyStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    name: "test store",
    get: async (a) => data[a],
    set: async (a, s) => void (data[a] = s),
    remove: async (a) => delete data[a],
  };
}

const deps = (store: KeyStore | undefined, over: Partial<CredentialDeps> = {}): Partial<CredentialDeps> => ({
  isInteractive: true,
  confirm: vi.fn(async () => true),
  secret: vi.fn(async () => "typed-key"),
  log: vi.fn(),
  store: async () => store,
  ...over,
});

describe("keyVarFor", () => {
  it("maps providers, honours apiKeyEnv, and returns nothing for keyless providers", () => {
    expect(keyVarFor({ provider: "gemini" })?.envVar).toBe("GEMINI_API_KEY");
    expect(keyVarFor({ provider: "openai-compatible", apiKeyEnv: "MY_KEY" })?.envVar).toBe("MY_KEY");
    expect(keyVarFor({ provider: "openai-compatible" })).toBeUndefined();
    expect(keyVarFor({ provider: "ollama" })).toBeUndefined();
  });
});

describe("resolveEnv", () => {
  it("leaves the environment alone when the key is already set", async () => {
    const e = { GEMINI_API_KEY: "from-env" };
    const d = deps(memoryStore());
    expect(await resolveEnv({ provider: "gemini" }, e, d)).toBe(e);
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("never touches the key store or prompts in a non-interactive shell", async () => {
    const store = memoryStore({ GEMINI_API_KEY: "saved" });
    const out = await resolveEnv({ provider: "gemini" }, {}, deps(store, { isInteractive: false }));
    expect(out.GEMINI_API_KEY).toBeUndefined();
  });

  it("uses a stored key when the user accepts it", async () => {
    const d = deps(memoryStore({ GEMINI_API_KEY: "saved" }));
    expect((await resolveEnv({ provider: "gemini" }, {}, d)).GEMINI_API_KEY).toBe("saved");
    expect(d.secret).not.toHaveBeenCalled();
  });

  it("prompts for a new key if the stored one is declined, and saves it when asked", async () => {
    const store = memoryStore({ GEMINI_API_KEY: "old" });
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const out = await resolveEnv({ provider: "gemini" }, {}, deps(store, { confirm }));
    expect(out.GEMINI_API_KEY).toBe("typed-key");
    expect(store.data.GEMINI_API_KEY).toBe("typed-key");
  });

  it("uses a typed key without saving when the user says no", async () => {
    const store = memoryStore();
    const out = await resolveEnv({ provider: "gemini" }, {}, deps(store, { confirm: vi.fn(async () => false) }));
    expect(out.GEMINI_API_KEY).toBe("typed-key");
    expect(store.data).toEqual({});
  });

  it("still works, without offering to save, when there is no secure store", async () => {
    const d = deps(undefined);
    const out = await resolveEnv({ provider: "gemini" }, {}, d);
    expect(out.GEMINI_API_KEY).toBe("typed-key");
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("returns the env unchanged when the prompt is cancelled, and ignores keyless providers", async () => {
    expect((await resolveEnv({ provider: "gemini" }, {}, deps(memoryStore(), { secret: vi.fn(async () => undefined) }))).GEMINI_API_KEY).toBeUndefined();
    const d = deps(memoryStore());
    await resolveEnv({ provider: "ollama" }, {}, d);
    expect(d.secret).not.toHaveBeenCalled();
  });

  it("carries on if saving fails", async () => {
    const store = { ...memoryStore(), set: async () => { throw new Error("locked"); } };
    const d = deps(store);
    expect((await resolveEnv({ provider: "gemini" }, {}, d)).GEMINI_API_KEY).toBe("typed-key");
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("locked"));
  });
});

describe("OS backends build the right commands", () => {
  it("macOS: the key goes on stdin, never in argv", async () => {
    const exec = vi.fn<Runner>(async () => ok);
    await macKeychain(exec).set("GEMINI_API_KEY", "AIza-secret_1");
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("security");
    expect(args).toEqual(["-i"]);
    expect(args.join(" ")).not.toContain("AIza");
    expect(opts?.input).toContain('-s docsync -a GEMINI_API_KEY');
    expect(opts?.input).toContain('-w "AIza-secret_1"');
  });

  it("macOS: reads and deletes by service and account", async () => {
    const exec = vi.fn<Runner>(async () => ({ ...ok, stdout: "the-key\n" }));
    const s = macKeychain(exec);
    expect(await s.get("GEMINI_API_KEY")).toBe("the-key");
    expect(exec).toHaveBeenLastCalledWith("security", ["find-generic-password", "-s", "docsync", "-a", "GEMINI_API_KEY", "-w"]);
    await s.remove("GEMINI_API_KEY");
    expect(exec).toHaveBeenLastCalledWith("security", ["delete-generic-password", "-s", "docsync", "-a", "GEMINI_API_KEY"]);
  });

  it("macOS: a failed lookup means no key", async () => {
    expect(await macKeychain(async () => ({ exitCode: 44, stdout: "", stderr: "not found" })).get("X")).toBeUndefined();
  });

  it("Linux: secret-tool store takes the key on stdin", async () => {
    const exec = vi.fn<Runner>(async () => ok);
    await linuxSecretService(exec).set("GEMINI_API_KEY", "k-1");
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("secret-tool");
    expect(args).toEqual(["store", "--label=docsync GEMINI_API_KEY", "service", "docsync", "account", "GEMINI_API_KEY"]);
    expect(opts?.input).toBe("k-1");
  });

  it("Linux: lookup and clear", async () => {
    const exec = vi.fn<Runner>(async () => ({ ...ok, stdout: "v\n" }));
    const s = linuxSecretService(exec);
    expect(await s.get("A")).toBe("v");
    expect(exec).toHaveBeenLastCalledWith("secret-tool", ["lookup", "service", "docsync", "account", "A"]);
    await s.remove("A");
    expect(exec).toHaveBeenLastCalledWith("secret-tool", ["clear", "service", "docsync", "account", "A"]);
  });

  it("Windows: key on stdin, account name via the environment, DPAPI in the script", async () => {
    const exec = vi.fn<Runner>(async () => ok);
    await windowsDpapi(exec).set("GEMINI_API_KEY", "k-1");
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(args.join(" ")).not.toContain("k-1");
    expect(args.join(" ")).toContain("ConvertFrom-SecureString");
    expect(opts).toEqual({ env: { DOCSYNC_ACCOUNT: "GEMINI_API_KEY" }, input: "k-1" });
  });

  it("rejects keys and names that would need escaping", async () => {
    const s = macKeychain(async () => ok);
    await expect(s.set("GEMINI_API_KEY", 'a"b; rm -rf')).rejects.toThrow(/characters/);
    await expect(s.set("bad name", "k")).rejects.toThrow(/Invalid key name/);
    await expect(s.get("x; y")).rejects.toThrow(/Invalid key name/);
  });

  it("picks a store per platform, and none on Linux without secret-tool", async () => {
    expect((await detectKeyStore("darwin", async () => ok))?.name).toMatch(/Keychain/);
    expect((await detectKeyStore("win32", async () => ok))?.name).toMatch(/Windows/);
    expect((await detectKeyStore("linux", async () => ok))?.name).toMatch(/keyring/);
    expect(await detectKeyStore("linux", async () => ({ exitCode: 127, stdout: "", stderr: "ENOENT" }))).toBeUndefined();
    expect(await detectKeyStore("freebsd", async () => ok)).toBeUndefined();
  });
});
