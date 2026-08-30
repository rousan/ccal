<p align="center">
  <img src="docs/assets/logo.svg" width="72" height="72" alt="ccal logo" />
</p>

<h1 align="center">ccal</h1>

<p align="center">
  <strong>Talk to your local Claude CLI through an OpenAI-compatible API.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rousan/ccal"><img src="https://img.shields.io/npm/v/@rousan/ccal.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@rousan/ccal.svg" alt="license MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/node/v/@rousan/ccal.svg" alt="node >=20" /></a>
</p>

---

**ccal** ("Claude Code Adapter for LLMs") is a small, standalone HTTP server that
proxies OpenAI-compatible requests to your local
[`claude`](https://docs.claude.com/claude-code) CLI. It lets any OpenAI-style
client — an SDK, a chat UI, `curl`, or an app like
[Warren](https://warren.rousanali.com) — talk to your Claude **subscription** as if
it were a regular model endpoint.

Under the hood it shells out to `claude -p --output-format stream-json ...` and
translates the CLI's streaming output into OpenAI Server-Sent Events.

## Why

- **Use your Claude Code subscription anywhere.** `ccal` does not call the
  Anthropic API directly — it drives the CLI you already have logged in, so no
  extra API key or billing is involved.
- **Drop-in OpenAI compatibility.** Point any OpenAI client at
  `http://127.0.0.1:8787/v1` and it just works — models, chat completions,
  streaming.
- **Local and simple.** Binds to localhost by default, no daemon, no config
  files. One command starts it.

## Requirements

- **Node 20+**
- The **`claude` CLI installed and logged in.** `ccal` drives your local Claude
  Code, so your normal Claude Code auth/subscription is what's used. Install it
  from <https://docs.claude.com/claude-code> and run `claude` once to sign in.

## Install & usage

No install required — run it straight from npm:

```sh
npx @rousan/ccal serve --port 8787
```

You should see something like:

```
ccal listening on http://127.0.0.1:8787
OpenAI-compatible base URL: http://127.0.0.1:8787/v1
Using claude CLI at /Users/you/.local/bin/claude (2.x.x ...)
```

The OpenAI-compatible base URL is:

```
http://127.0.0.1:8787/v1
```

The API key is ignored (auth is handled by your local `claude` login), so any
placeholder works.

## Use with any OpenAI client

**curl** (streaming):

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [{ "role": "user", "content": "Say hello in one word." }]
  }'
```

**OpenAI Python SDK:**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="ccal")
resp = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Say hello in one word."}],
)
print(resp.choices[0].message.content)
```

**Warren** (or any app with an OpenAI-compatible provider setting): add a custom
provider with base URL `http://127.0.0.1:8787/v1`, any API key, and pick one of
`sonnet` / `opus` / `haiku` as the model.

## Endpoints

- `GET /health` → `{ "ok": true }`
- `GET /v1/models` → the OpenAI model list. Three ids are advertised, matching
  the `claude` CLI's `--model` aliases: `sonnet`, `opus`, `haiku`. When the
  server was started with `--vanilla`, `supported_parameters` drops `"tools"`
  for every model, since the backing agent has none to use.
- `POST /v1/chat/completions` → OpenAI-compatible chat completions. Supports both
  `stream: true` (SSE `data: {choices:[{delta:{content}}]}` frames terminated by
  `data: [DONE]`) and the non-streaming case (a single assembled
  `choices[0].message.content`). **Images** work too: include `image_url`
  content parts (a `data:` base64 URL or a remote http(s) URL) and they are
  forwarded to `claude` as image blocks for the vision models to see.

### How messages map to the CLI

- `system` messages are combined and passed to claude via
  `--append-system-prompt` (appended to the default agent prompt, so tool use
  still works). In [`--vanilla`](#vanilla-mode-no-tools-no-mcp-no-claudemd)
  mode they go through `--system-prompt` instead, replacing the prompt rather
  than extending it.
- `user` / `assistant` messages are flattened into a single text transcript sent
  on stdin. A lone message is sent verbatim; a multi-turn conversation is
  rendered as a `User:` / `Assistant:` labeled transcript. This is one prompt in,
  one response out — claude's streaming JSON output is translated back into
  OpenAI chunks (assistant text plus compact one-line notes for any tool calls).

## Commands

```
ccal serve [options]   Start the OpenAI-compatible server
ccal update            Update ccal to the latest published version
ccal version           Print the installed version (also: --version, -v)
```

## Configuration

```
ccal serve [options]

  --port <n>              Port to bind (default: 8787)
  --host <addr>           Host to bind (default: 127.0.0.1)
  --cwd <dir>             Working directory for the claude process
  --permission-mode <m>   Permission mode passed to claude (non-default only)
  --allow-origin <origin> Let a site on the public internet call this server
                          (repeatable)
  --vanilla               Serve plain model calls instead of a full Claude
                          Code agent (no tools, no MCP servers, no CLAUDE.md)
  --help                  Show this help
```

- `--cwd` controls where claude runs, which determines the tools, MCP servers,
  and `CLAUDE.md` it loads (agentic mode only — `--vanilla` turns all three off
  regardless of `--cwd`).
- `CCAL_CLAUDE_PATH` (environment variable) forces a specific `claude` binary
  when auto-detection does not find the right one.

### Vanilla mode: no tools, no MCP, no CLAUDE.md

By default ccal runs `claude` as a **full Claude Code agent**: it has its
built-in tools, connects to whatever MCP servers your `claude` config defines,
and loads `CLAUDE.md` from `--cwd`. That is the right shape for most uses of
ccal — a chat UI or SDK that just wants the model to actually do things.

It is the wrong shape when the *caller* is itself an agent with its own tool
loop — for example [opencode](https://opencode.ai). Point opencode at ccal
without `--vanilla` and you get two independent agents fighting over the same
turn: opencode issues tool calls of its own while the `claude` process
underneath is separately reading files, running bash, and picking up whatever
`CLAUDE.md` sits in `--cwd`.

```sh
ccal serve --vanilla
```

turns every request into a plain model call:

- No built-in tools (`--tools ""` on the `claude` invocation).
- No `CLAUDE.md`, skills, plugins, hooks, or MCP servers (`--safe-mode`, plus
  `--strict-mcp-config` as a second guarantee against MCP).
- The caller's `system` message **replaces** the agent's default system prompt
  (`--system-prompt`) instead of being appended to it — so the model isn't
  told it's a coding agent with tools it no longer has. If a request carries
  no system message, ccal substitutes a small neutral one rather than leaving
  the agent framing in place.

Your own subscription login still works — vanilla mode does *not* use
`--bare`, which would require `ANTHROPIC_API_KEY` and stop reading your
OAuth/keychain login. `GET /v1/models` also drops `"tools"` from
`supported_parameters` in this mode, since the backing model genuinely can't
use any.

Off by default; existing consumers that rely on the agentic behaviour are
unaffected.

### Calling ccal from a website

If the page calling ccal is served over the public internet — a deployed app
pointed at your local ccal, rather than something on `localhost` — you need
`--allow-origin`:

```
ccal serve --allow-origin https://example.com
```

Chrome applies **Private Network Access** on top of ordinary CORS: a public page
reaching a private address must send a preflight and be answered
`Access-Control-Allow-Private-Network: true`. Without that, **the request does
not fail — it hangs**, with no console error and nothing to search for. If a
deployed app sits forever on "connecting", this is almost always why.

Two things worth knowing before you use it:

- **Only name sites you trust.** An allowed origin can drive your `claude` CLI,
  which means your subscription and whatever `--cwd` points at.
- **You will not reproduce the problem locally.** A page on `localhost` calling
  `127.0.0.1` is private-to-private, so PNA never engages and everything works
  without the flag. It only appears once the page is deployed.

## Documentation

- [docs/architecture.md](docs/architecture.md) — the request lifecycle end to
  end, module map, and binary resolution.
- [docs/development.md](docs/development.md) — local setup, scripts, testing, and
  publishing to npm.

## License

MIT © Rousan Ali
