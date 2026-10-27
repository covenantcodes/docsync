# docsync

Keep your project docs up to date from your git changes. `docsync` reads what changed in your repo, asks an LLM to update the **managed sections** of your markdown docs, shows you a diff, and writes it only when you say yes.

Works in any git repo (JS, Python, Go, ...) and in monorepos. It never commits for you.

## Quick start

Requires Node 20+ and a git repo with at least one commit.

```bash
npx docsync init                      # detect areas and a model, write config + starter docs
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY / GEMINI_API_KEY; never stored by docsync

# ...make and commit some changes...
npx docsync                           # propose doc updates, review the diff, apply
npx docsync check                     # exit 1 if docs are stale (no LLM call), for CI
```

**No API key?** You can still use docsync: run a local model with Ollama, pipe to a CLI you already use (like `claude -p`), or paste into any AI chat. See [Providers](#providers).

Commit `docsync.config.json`, `.docsync.json` and your docs.

## How it works

1. Finds files changed since the last sync (`lastSha` in `.docsync.json`).
2. Drops noise: lockfiles, assets, `dist`, anything in `ignore`, and always `.env*`.
3. Groups the remaining files into **areas** (for example `mobile`, `web`, `backend`).
4. Per area, sends the diff and the doc's current managed sections to the model.
5. Validates the JSON reply (one automatic retry on a bad reply; an area that still fails is skipped and the rest continue).
6. Prints each edit's reason and a colored diff, then asks `Apply changes to <doc>?`.
7. Writes the doc and records the current `HEAD` in `.docsync.json`.

## Commands

| Command | What it does |
|---|---|
| `docsync` / `docsync update` | Run the update flow. |
| `docsync init` | Detect workspaces, write `docsync.config.json`, create missing docs with starter sections, write `.docsync.json`. Safe to re-run: existing files are never overwritten. |
| `docsync generate [feature]` | Write feature docs from the **source code itself**, not a diff. See [Feature docs](#feature-docs). |
| `docsync check` | No LLM call. Exit 1 if an area's code changed after its doc did. |

`update` flags:

| Flag | Meaning |
|---|---|
| `--since <ref>` | Diff against this git ref instead of `lastSha`. |
| `--staged` | Only consider staged changes. `lastSha` is not advanced. |
| `--dry-run` | Show everything, write nothing. |
| `-y, --yes` | Apply without asking (required in non-interactive shells such as CI). |

`init` flags: `-y, --yes` accepts the detected areas and provider without asking; `--provider <name>`, `--model <name>` and `--base-url <url>` skip the provider questions. `init` looks for API keys in your environment and a running Ollama, and suggests what it finds.

Exit codes: `0` success, `1` an error, a failed area (`update`), or stale docs (`check`). Set `DEBUG=docsync` for stack traces.

## Feature docs

`update` documents *what changed*. `generate` documents *how a feature works*: the endpoints to call, the parameters to send, and the flow. It reads the feature's source files in full, which can span several folders (a mobile app and its API, say).

List features in `docsync.config.json`:

```json
"features": [
  {
    "name": "bills-payment",
    "paths": ["apps/mobile/src/bills/**", "services/api/src/bills/**"],
    "doc": "docs/features/bills-payment.md"
  }
]
```

```bash
npx docsync generate bills-payment --dry-run   # preview
npx docsync generate bills-payment             # review the diff, apply
npx docsync generate                           # every feature
```

Each feature doc has the same managed sections:

| Section | Contents |
|---|---|
| `overview` | What the feature does and how the pieces fit. |
| `flow` | Numbered end-to-end steps, plus a Mermaid sequence diagram when the code shows two or more actors. |
| `endpoints` | One entry per endpoint: purpose, auth, a request table (parameter, where it goes, type, required), the response, and error cases. |
| `data-models` | Types, entities and enums. |
| `configuration` | Env var and flag names (never values). |
| `edge-cases` | Validation, retries, idempotency, failure handling. |

**How it stays honest.** The model is told to document only what the code shows, to write "Not found in the provided code." when it can't tell, and to cite the files each section comes from. After it replies, docsync mechanically checks that every route, parameter or field name, env var and cited file in the doc actually appears in the source that was sent, and warns about anything that doesn't. This catches most invented endpoints and fields, but it can't prove a doc is *correct*: read the diff before you apply it. (With `--yes` the warnings are printed but the doc is still written.)

Notes:
- Only git-tracked files are read, ranked so routes, handlers, schemas and API clients come before UI code, then tests and styles. Files that don't fit the budget (`maxSourceChars`, 120,000 characters by default, less for Ollama and `manual`) are left out, with a warning naming them.
- This sends **complete source files** (not just diffs) to your provider. `ignore`, `.env*` and secret redaction still apply. Use `ollama` if the code can't leave your machine.
- Feature docs need a strong model with a large context window. Small local models will struggle.
- `generate` doesn't change `.docsync.json`. In this first version `update` and `check` don't track feature docs yet.

## Managed sections

docsync only edits text between markers. Everything outside them is yours and is never touched.

```md
# My service

Hand-written intro that docsync will never change.

<!-- docsync:start overview -->
...generated...
<!-- docsync:end -->
```

`init` creates `overview`, `setup`, `architecture` and `changelog`. The model may also propose a new section name; it's appended at the end of the doc. Section names use letters, digits, `-` and `_`.

## Configuration

`docsync.config.json` (committed). Without one, docsync uses a single area covering the whole repo and writing to `docs/OVERVIEW.md`.

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-5-5",
  "areas": [
    { "name": "mobile",  "paths": ["apps/mobile/**"],  "doc": "docs/mobile.md" },
    { "name": "web",     "paths": ["apps/web/**"],     "doc": "docs/web.md" },
    { "name": "backend", "paths": ["services/api/**"], "doc": "docs/backend.md" }
  ],
  "ignore": ["**/*.lock", "**/package-lock.json", "**/assets/**", "**/.env*", "**/dist/**"]
}
```

- `areas[].paths` are glob patterns relative to the repo root. A file belongs to the **first** area that matches it; files matching no area are ignored.
- `ignore` globs are applied before anything is sent. `**/.env*` is always ignored, even if you remove it from the list.
- There is no place for API keys in the config, by design. Keys come from the environment.

Provider settings (all optional unless a provider needs them, see below):

| Field | Meaning |
|---|---|
| `provider` | Which backend to use. Default `anthropic`. |
| `model` | Model name. Defaults to `claude-sonnet-5-5` for `anthropic`; required for `openai`, `gemini`, `ollama` and `openai-compatible`. |
| `baseUrl` | Endpoint. Required for `openai-compatible`; optional for `ollama` (default `http://localhost:11434`). |
| `apiKeyEnv` | Name of the environment variable that holds the key, if not the default. |
| `contextWindow` | Ollama only: context size in tokens (default 16384). |
| `maxDiffChars` | Most diff characters sent per area. Default 60,000 (24,000 for Ollama, 30,000 for `manual`). |
| `maxSourceChars` | Most source characters sent per feature (`generate`). Default 120,000 (30,000 for Ollama, 40,000 for `manual`). |

`init` detects areas from `package.json` `workspaces`, `pnpm-workspace.yaml`, or `apps/*`, `packages/*`, `services/*` folders.

## Providers

| `provider` | Needs | Notes |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | |
| `openai` | `OPENAI_API_KEY`, `model` | |
| `gemini` | `GEMINI_API_KEY`, `model` | Uses Google's OpenAI-compatible endpoint. |
| `openai-compatible` | `baseUrl`, `model` (key optional via `apiKeyEnv`) | OpenRouter, Groq, Together, LM Studio, llama.cpp, vLLM, anything that serves `/chat/completions`. |
| `ollama` | a running Ollama and `model` | **No API key, nothing leaves your machine.** |
| `cli` | `DOCSYNC_CLI` | **No API key.** Runs a command you already have. |
| `manual` | an interactive terminal | **No API key.** You paste into any AI chat. |

Examples:

```jsonc
{ "provider": "openai", "model": "<a model your key can use>" }
{ "provider": "ollama", "model": "qwen2.5-coder:14b" }
{ "provider": "openai-compatible", "baseUrl": "http://localhost:1234/v1", "model": "local-model" }
{ "provider": "cli" }
{ "provider": "manual" }
```

### Without an API key

- **Ollama** (recommended): install [Ollama](https://ollama.com), `ollama pull <model>`, set `"provider": "ollama"`. docsync sets the context window for you (Ollama's default silently truncates long prompts) and sends smaller diffs.
- **`cli`**: docsync pipes the prompt to a command and reads its output. Because the command runs on your machine, it comes **only from your environment, never from the committed config**, so a repository can't make docsync run a program for you:

  ```bash
  export DOCSYNC_CLI="claude -p"
  npx docsync
  ```

  Any command that reads a prompt on stdin and prints the reply on stdout works. The command is split into arguments and run without a shell.
- **`manual`**: docsync writes the prompt to a temp file (and copies it to your clipboard when it can). Give it to any AI chat, save the JSON reply to the file it names, press Enter. Slow, but it works with nothing installed.

Small local models write weaker docs and sometimes break the JSON format. docsync validates every reply and retries once, and you always review the diff before anything is written.

The provider interface is one method, `complete(system, user): Promise<string>`, so new providers don't touch the core.

## CI

`check` is meant for pull requests. It needs the full git history so it can find `lastSha`:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx docsync check
```

A doc counts as up to date when it was changed *after* the area's latest code change (in the same commit, a later commit, or uncommitted edits). A code-only commit after an older doc update makes the area stale again.

## Privacy

- The **diff of changed code files and the current text of the managed doc sections are sent to the provider you configure** (Anthropic by default). Don't run docsync on code you can't share with that provider. With `ollama`, or an `openai-compatible` server on your own machine, nothing leaves your computer. With `cli` and `manual`, the prompt goes wherever that command or chat sends it.
- Files matching `ignore` and every `.env*` file are removed *before* the diff is built, so they are never sent.
- Obvious secrets in the remaining diff lines (`*KEY=`, `*SECRET=`, `*TOKEN=`, `*PASSWORD=` values, private key blocks, and well-known token formats) are replaced with `[REDACTED]`. This is best-effort pattern matching, not a guarantee: review your `ignore` list for anything sensitive.
- Diffs over about 60,000 characters per area are truncated, with a warning.
- docsync has no telemetry. `init` only talks to `localhost` (to look for Ollama). It never commits, pushes, or runs destructive git commands, and it only writes the doc files, `docsync.config.json` and `.docsync.json`.

## Known limitations

- Only **tracked** files are seen. Brand-new files appear once they are staged or committed.
- `update` includes uncommitted edits in its diff and then records the current `HEAD`. If you run it on uncommitted work and commit afterwards, the next run sees those same changes again, so run `docsync` after committing for the cleanest changelog.
- If `lastSha` no longer exists (rewritten history, shallow clone), pass `--since <ref>`.
- Generated docs reflect only what the diff shows. Review the diff before you apply it.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build      # dist/cli.js
```

## License

MIT
