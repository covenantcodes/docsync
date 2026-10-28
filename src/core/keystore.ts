import { execa } from "execa";

/** Where docsync keeps API keys: the operating system's own secret store, never a plain-text file. */
export interface KeyStore {
  /** Human name, e.g. "macOS Keychain". */
  name: string;
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<boolean>;
}

export type Runner = (
  file: string,
  args: string[],
  opts?: { input?: string; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const run: Runner = async (file, args, opts) => {
  const r = await execa(file, args, { reject: false, timeout: 15_000, ...(opts?.input !== undefined ? { input: opts.input } : {}), ...(opts?.env ? { env: opts.env } : {}) });
  return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
};

export const SERVICE = "docsync";
const ACCOUNT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// API keys are printable ASCII without quotes or backslashes. Refusing anything else lets us avoid all escaping.
const SECRET_RE = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function check(account: string, secret?: string): void {
  if (!ACCOUNT_RE.test(account)) throw new Error(`Invalid key name "${account}".`);
  if (secret !== undefined && !SECRET_RE.test(secret)) {
    throw new Error("That key contains characters (spaces, quotes or backslashes) that API keys don't use. Check you pasted just the key.");
  }
}

const fail = (what: string, r: { stderr: string }) => new Error(`${what}: ${r.stderr.trim() || "unknown error"}`);

export function macKeychain(exec: Runner = run): KeyStore {
  return {
    name: "macOS Keychain",
    async get(account) {
      check(account);
      const r = await exec("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
      return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
    },
    async set(account, secret) {
      check(account, secret);
      // `security -i` reads the command from stdin, so the key never appears in the process list.
      const r = await exec("security", ["-i"], {
        input: `add-generic-password -U -s ${SERVICE} -a ${account} -l "docsync ${account}" -w "${secret}"\n`,
      });
      if (r.exitCode !== 0 || /error|fail/i.test(r.stderr)) throw fail("Could not save to the macOS Keychain", r);
    },
    async remove(account) {
      check(account);
      return (await exec("security", ["delete-generic-password", "-s", SERVICE, "-a", account])).exitCode === 0;
    },
  };
}

export function linuxSecretService(exec: Runner = run): KeyStore {
  return {
    name: "the system keyring (Secret Service)",
    async get(account) {
      check(account);
      const r = await exec("secret-tool", ["lookup", "service", SERVICE, "account", account]);
      return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
    },
    async set(account, secret) {
      check(account, secret);
      const r = await exec("secret-tool", ["store", `--label=docsync ${account}`, "service", SERVICE, "account", account], { input: secret });
      if (r.exitCode !== 0) throw fail("Could not save to the system keyring", r);
    },
    async remove(account) {
      check(account);
      return (await exec("secret-tool", ["clear", "service", SERVICE, "account", account])).exitCode === 0;
    },
  };
}

// The secret travels on stdin and the account name through the environment, so neither is spliced into the script.
const PS = (body: string) => ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $f = Join-Path $env:APPDATA ('docsync\\' + $env:DOCSYNC_ACCOUNT + '.dpapi'); ${body}`];

/** Windows: a DPAPI-encrypted file, usable only by the same Windows user on the same machine. */
export function windowsDpapi(exec: Runner = run): KeyStore {
  const ps = (account: string, body: string, input?: string) =>
    exec("powershell.exe", PS(body), { env: { DOCSYNC_ACCOUNT: account }, ...(input !== undefined ? { input } : {}) });
  return {
    name: "Windows (DPAPI-encrypted, current user only)",
    async get(account) {
      check(account);
      const r = await ps(
        account,
        "if (-not (Test-Path $f)) { exit 3 }; $s = Get-Content -Raw $f | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))",
      );
      return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
    },
    async set(account, secret) {
      check(account, secret);
      const r = await ps(
        account,
        "$k = [Console]::In.ReadToEnd().Trim(); New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null; ConvertTo-SecureString $k -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -NoNewline $f",
        secret,
      );
      if (r.exitCode !== 0) throw fail("Could not save the key", r);
    },
    async remove(account) {
      check(account);
      return (await ps(account, "if (Test-Path $f) { Remove-Item $f -Force } else { exit 3 }")).exitCode === 0;
    },
  };
}

/** Picks the secret store for this OS, or undefined if none is usable (e.g. no `secret-tool` on a headless Linux box). */
export async function detectKeyStore(platform: NodeJS.Platform = process.platform, exec: Runner = run): Promise<KeyStore | undefined> {
  try {
    if (platform === "darwin") return macKeychain(exec);
    if (platform === "win32") return windowsDpapi(exec);
    if (platform === "linux") {
      const r = await exec("secret-tool", ["--version"]);
      // `secret-tool` prints its version (exit 0) when installed; a missing binary makes execa report a non-zero exit.
      return r.exitCode === 0 || /secret-tool/i.test(r.stdout + r.stderr) ? linuxSecretService(exec) : undefined;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export const NO_KEYSTORE_HINT: Record<string, string> = {
  linux: "Install libsecret-tools (e.g. `sudo apt install libsecret-tools`) and a keyring such as GNOME Keyring to save keys.",
};
