# Architecture

This document traces a request through **ccal** end to end, so you can see exactly
how an OpenAI-compatible call becomes a `claude` CLI invocation and back.

## Overview

ccal is a thin adapter. It speaks the OpenAI wire format on the front and the
`claude` CLI's `stream-json` protocol on the back, translating between the two per
request. There is no persistence and no background state — each chat request
spawns a fresh `claude` subprocess and streams its output straight to the client.

```
                         ccal (Hono server, localhost)
                ┌───────────────────────────────────────────────┐
  OpenAI        │  server.ts                                     │
  client   ───► │   POST /v1/chat/completions                    │
 (SDK/curl/     │        │                                       │
  Warren)       │        ▼                                       │
                │   prompt.ts   flatten messages                 │
                │        │      → stdin payload + system prompt   │
                │        ▼                                        │
                │   claude-binary.ts  resolve `claude` path       │
                │        │                                        │
                │        ▼                        spawn + stdin   │
                │   claude.ts  ───────────────────────────────►  claude -p
                │        ▲                        stdout lines    │  (subprocess,
                │        │                        (stream-json)   │   full agent)
                │        ▼                                        │
                │   stream.ts  translate events → text chunks     │
                │        │                                        │
                │        ▼                                        │
  OpenAI    ◄── │   server.ts  SSE `data:` frames  /  JSON body   │
  response      └───────────────────────────────────────────────┘
```

## The request lifecycle

### 1. HTTP entry (`server.ts`)

`createServer()` builds a Hono app with permissive CORS (any origin;
`Content-Type` and `Authorization` headers; `GET`/`POST`/`OPTIONS`) so browser and
webview clients aren't blocked. It mounts three routes:

- `GET /health` → `{ ok: true }`
- `GET /v1/models` → the static model list (see below)
- `POST /v1/chat/completions` → the main handler

The chat handler parses the JSON body (returning `400` on invalid JSON) and reads
just three fields: `model`, `messages`, and `stream`. Everything else is ignored.

### 2. Prompt preparation (`prompt.ts`)

`preparePrompt(messages)` splits the OpenAI `messages` array into:

- **System prompt** — all `system` messages' text joined with blank lines
  (`null` if there are none).
- **stdin payload** — the user/assistant turns flattened into one text transcript.
  A message's `content` may be a plain string or an array of `{ type, text }`
  parts; `contentText()` extracts the text either way.

The flattening rule:

- **One turn only** → sent verbatim, with no role label.
- **Multiple turns** → rendered as a labeled transcript, each turn as
  `User: ...` or `Assistant: ...`, joined by blank lines, with the latest user
  question last.

This is a deliberate design choice: ccal sends **one prompt in, one response
out**. It does *not* use claude's stream-json *input* mode (which would treat the
array as a realtime stream and answer every user turn). Keeping the transcript
append-only also keeps the cached prefix byte-identical across follow-up turns.

### 3. Binary resolution (`claude-binary.ts`)

`resolveClaude()` finds the absolute path to the `claude` binary, trying in order:

1. `CCAL_CLAUDE_PATH` environment override (if it exists on disk).
2. A scan of the current `PATH`.
3. The user's login shell: `$SHELL -lic 'command -v claude'` — this recovers
   rc-managed additions like `~/.local/bin` when ccal was launched with a stripped
   `PATH` (common for GUI apps and editor-spawned processes). Capped at a 5s
   timeout so a misbehaving rc file can't hang the request.
4. Common absolute install locations: `~/.local/bin/claude`,
   `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude`.

If none resolve, the handler returns `502` with a clear message. `checkClaude()`
runs the same resolution once at startup (plus a `--version` probe) to log the
binary location or warn early — but resolution also happens per request, so the
server recovers if claude is installed after startup.

### 4. Spawning claude (`claude.ts`)

`spawnClaude()` launches the CLI as a full agentic subprocess with these exact
flags:

```
claude -p \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --model <id> \
  --no-session-persistence \
  [--append-system-prompt <system>]   # only when system content exists
  [--permission-mode <mode>]          # only for an explicit non-default mode
```

What each flag does:

- **`-p`** — headless/print mode; claude reads a single prompt from **stdin**
  (the CLI's default input format) and produces one response.
- **`--output-format stream-json --include-partial-messages --verbose`** — makes
  claude emit one JSON object per line, including the incremental Anthropic
  `stream_event` lines that carry text and tool deltas.
- **`--model <id>`** — the alias from the request (`sonnet` / `opus` / `haiku`),
  defaulting to `sonnet`.
- **`--no-session-persistence`** — every request is stateless; nothing is written
  to session history.
- **`--append-system-prompt <system>`** — added only when the request carried
  system content. It *appends* to the default agent prompt (rather than replacing
  it) so tool use still works.
- **`--permission-mode <mode>`** — forwarded only when the CLI was given an
  explicit non-empty, non-`default` mode.

Notably, `--bare`, `--strict-mcp-config`, and `--setting-sources` are **not**
passed. ccal runs claude as a full Claude Code agent: tools, MCP servers, and
`CLAUDE.md` all load relative to `--cwd`.

Two practical details:

- **PATH augmentation.** claude shells out to helper binaries that may live
  alongside it, so ccal prepends the binary's own directory to `PATH` for the
  child (if not already present).
- **stdin handling.** The prompt is written to the child's stdin and stdin is
  closed. Writes are buffered and drained asynchronously (so a large prompt can't
  deadlock against stdout back-pressure), and EPIPE-style errors are swallowed in
  case claude exits before reading all of stdin.

stdout is wrapped in a `readline` interface and exposed as an async iterable of
decoded lines (`ClaudeProcess.lines`).

### 5. Stream translation (`stream.ts`)

`processLine(line, state)` parses each stdout line and returns any user-visible
content, or `null`. It only acts on lines carrying an `event` field (the
incremental Anthropic streaming events); the full `assistant` snapshot messages
and `tool_result` `user` messages are ignored so tool activity isn't emitted
twice. The event shapes handled:

- **`content_block_start`** with `content_block.type === "tool_use"` → open a
  `ToolBlock` (tracked by content-block index), start accumulating its input JSON.
  Returns `null`.
- **`content_block_delta`**:
  - `delta.type === "text_delta"` → return `delta.text` (plain assistant text).
  - `delta.type === "input_json_delta"` → append `partial_json` to the open tool
    block's buffer. Returns `null`.
- **`content_block_stop`** → close the tool block and return a compact one-line
  italic note describing the completed tool call, e.g.
  `\n\n*↳ Read src/server.ts*\n\n`.

`toolLabel(name, inputJson)` renders those notes: `Read`/`Edit`/`Write` show the
last path segments, `Bash` shows a truncated command, `Grep`/`Glob`/`WebSearch`
show the pattern/query, `Task` shows the subagent description, and `mcp__*` tools
render as `<server> · <tool>`. Unknown tools fall back to a cleaned name.

### 6. Response back to the client (`server.ts`)

- **Streaming (`stream: true`)** — the handler sets `text/event-stream` headers
  and, for each non-null `processLine` result, writes an OpenAI SSE chunk:
  `data: {"id","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":...}}]}\n\n`.
  When claude's stdout closes, it reaps the child and writes `data: [DONE]\n\n`.
- **Non-streaming** — the handler accumulates all content into one string and
  returns a single `chat.completion` object with
  `choices[0].message.content`. If the spawn itself failed, it returns `502`.

The completion `id` is `chatcmpl-<hrtime-nanoseconds>`. In both paths the child is
reaped via `waitForExit()` so no zombie processes leak.

## `GET /v1/models` (`models.ts`)

Returns a static OpenAI-shaped list of exactly three ids — `sonnet`, `opus`,
`haiku` — matching the `claude` CLI's `--model` aliases. Each entry has
`object: "model"`, `owned_by: "ccal"`, and a stable `created: 0` so responses are
deterministic. The default model when a request omits `model` is `sonnet`.

## CORS

CORS is intentionally permissive (`origin: "*"`) so local browser apps and
webviews (such as Warren) can call ccal without same-origin friction. Since ccal
binds to `127.0.0.1` by default and performs no auth of its own, this is a local
convenience — see [SECURITY.md](../SECURITY.md) before exposing it more widely.
