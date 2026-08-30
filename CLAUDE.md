# CLAUDE.md — working in the ccal repo

This file orients an AI or human contributor working on **ccal**. Read it before
making changes.

## What ccal is

ccal ("Claude Code Adapter for LLMs") is a small, standalone HTTP server that
exposes an **OpenAI-compatible API** and proxies each request to the local
[`claude`](https://docs.claude.com/claude-code) CLI. It does not call the
Anthropic API directly — it spawns the `claude` binary as a subprocess and
translates its streaming output into OpenAI Server-Sent Events. The point is to
let any OpenAI-style client use a Claude Code subscription as a normal model
endpoint.

## Stack

- **Runtime:** Node 20+ (ESM). The published `ccal` bin runs under plain `node`.
- **HTTP framework:** [Hono](https://hono.dev) with `@hono/node-server`.
- **Language:** TypeScript, compiled with `tsc` to `dist/`.
- **Package manager:** pnpm.
- **Dependencies are intentionally minimal** — just Hono and the Node server
  adapter. Argument parsing and everything else is hand-rolled. Prefer small,
  dependency-free helpers over new packages.

## Source module map (`src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | The `ccal` entry point (has the `#!/usr/bin/env node` shebang). Parses the `serve` subcommand flags (`--port`, `--host`, `--cwd`, `--permission-mode`, `--allow-origin`, `--vanilla`, `--help`), probes for the `claude` binary at startup, and starts the Hono server via `@hono/node-server`. |
| `server.ts` | Builds the Hono app. Mounts `GET /health`, `GET /v1/models`, and `POST /v1/chat/completions`; sets up permissive CORS; orchestrates prompt prep → spawn → stream translation for both the streaming (SSE) and non-streaming paths; reaps the child process. |
| `prompt.ts` | Flattens an OpenAI `messages` array into a single stdin text payload plus a combined system prompt. System messages are joined; user/assistant turns become a labeled `User:` / `Assistant:` transcript (a lone message is sent verbatim). |
| `claude.ts` | Spawns the `claude` CLI subprocess with the exact agentic (or, in vanilla mode, plain-model) flags, writes the prompt to stdin, ensures the binary's directory is on `PATH`, and exposes stdout as an async iterator of decoded lines. |
| `stream.ts` | Translates the CLI's `stream-json` events into user-visible text: text deltas pass through; tool calls are accumulated and rendered as a compact one-line italic note. Holds the per-response `StreamState`. |
| `models.ts` | The static model list for `GET /v1/models` — `sonnet`, `opus`, `haiku` — and the default model (`sonnet`). In vanilla mode, drops `"tools"` from each model's `supported_parameters`. |
| `claude-binary.ts` | Resolves the absolute path to the `claude` binary across several strategies (see below), and probes its `--version` at startup. |

## The `claude` CLI contract ccal depends on

ccal spawns claude (see `claude.ts`) with these flags:

```
claude -p \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --model <id> \
  --no-session-persistence \
  [--append-system-prompt <system>]         # agentic mode, system content only
  [--tools "" --safe-mode --strict-mcp-config --system-prompt <text>]   # vanilla mode only
  [--permission-mode <mode>]
```

- `-p` runs headless (print mode), reading one prompt from **stdin**.
- `--output-format stream-json --include-partial-messages --verbose` makes claude
  emit one JSON object per line, including the incremental Anthropic
  `stream_event` lines that `stream.ts` consumes.
- `--model` takes the alias from the request (`sonnet` / `opus` / `haiku`).
- `--no-session-persistence` keeps each request stateless.
- `--append-system-prompt` is added only when the request has system content, so
  the default agent prompt (and tool use) is preserved. **Agentic mode only.**
- `--permission-mode` is forwarded only for an explicit non-default value.

It runs as a **full Claude Code agent by default** — tools, MCP servers, and
`CLAUDE.md` load based on `--cwd`. `--bare`, `--strict-mcp-config`, and
`--setting-sources` are deliberately not passed in this mode.

**Vanilla mode** (`--vanilla` on `ccal serve`, `vanilla: true` in `SpawnOptions`)
runs a plain model call instead, for callers (opencode being the motivating one)
that run their own tool loop and would otherwise end up with two agents fighting
over the same turn. Four flags change, each verified against `claude --help`
rather than assumed — the reasoning lives in the comment on the vanilla block in
`spawnClaude()` (`claude.ts`), and is worth reading in full before touching any
of them:

- **`--tools ""`** disables every built-in tool. On its own this does *not* stop
  `CLAUDE.md` or MCP servers from loading.
- **`--safe-mode`, not `--bare`.** `--bare` looks like the obvious flag for
  killing `CLAUDE.md` auto-discovery, but its own help text says Anthropic auth
  becomes strictly `ANTHROPIC_API_KEY` / `apiKeyHelper` — OAuth and keychain are
  never read. Verified: `claude -p --bare` on a subscription-logged-in box fails
  with "Not logged in - Please run /login", which would break ccal for exactly
  the users it exists for. `--safe-mode` disables `CLAUDE.md`, skills, plugins,
  hooks and MCP servers while explicitly leaving auth working normally.
- **`--strict-mcp-config`** is mostly redundant with what `--safe-mode` already
  does (verified via the `stream-json` init event's `mcp_servers` field), but is
  kept as a second, low-cost guarantee — `--safe-mode`'s own help text carves out
  an exception for admin-managed settings, and it's unclear whether that could
  include a managed MCP server.
- **`--system-prompt`, not `--append-system-prompt`.** Appending leaves the
  agent's default system prompt in place, and even with zero tools available the
  model still believes it's an agent with tools — verified: it emitted fake
  `<function_calls>...` text instead of a plain answer. `--system-prompt`
  replaces the prompt outright. When the request has no system message, ccal
  substitutes a small neutral default rather than passing `--system-prompt ""`
  or omitting the flag — both were tested and both fall back to the same broken
  agent-framing behaviour (and a whitespace-only prompt is rejected outright by
  the API).

**Binary resolution order** (`claude-binary.ts`): `CCAL_CLAUDE_PATH` →
scan `PATH` → ask the login shell (`$SHELL -lic 'command -v claude'`) →
common install locations (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`,
`/usr/bin`).

## Run / build / typecheck

```sh
pnpm install
pnpm dev          # run from source with tsx (src/cli.ts serve)
pnpm typecheck    # tsc --noEmit
pnpm build        # compile to dist/
pnpm start        # run the compiled server (node dist/cli.js serve)
```

There is no automated test suite yet. Validate changes by typechecking, building,
and manually exercising the endpoints — see [docs/development.md](docs/development.md)
for `curl` recipes.

## Conventions

- **Plain, well-commented code.** Comments explain *why*, not just *what*. Match
  the existing style — each file opens with a comment describing its role.
- **No emoji in source.** Tasteful emoji are acceptable in Markdown docs, used
  sparingly.
- **Keep the dependency surface tiny.** Don't add a library for something a small
  helper can do.
- **Don't break the build.** `pnpm typecheck` and `pnpm build` must stay green,
  and `dist/cli.js` must remain a runnable Node script with its shebang.
- **Keep OpenAI compatibility intact.** The request/response shapes on
  `/v1/models` and `/v1/chat/completions` are the contract clients rely on.

## Further reading

- [docs/architecture.md](docs/architecture.md) — the full request lifecycle.
- [docs/development.md](docs/development.md) — setup, testing, and publishing.
