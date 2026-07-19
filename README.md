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
  the `claude` CLI's `--model` aliases: `sonnet`, `opus`, `haiku`.
- `POST /v1/chat/completions` → OpenAI-compatible chat completions. Supports both
  `stream: true` (SSE `data: {choices:[{delta:{content}}]}` frames terminated by
  `data: [DONE]`) and the non-streaming case (a single assembled
  `choices[0].message.content`). **Images** work too: include `image_url`
  content parts (a `data:` base64 URL or a remote http(s) URL) and they are
  forwarded to `claude` as image blocks for the vision models to see.

### How messages map to the CLI

- `system` messages are combined and passed to claude via
  `--append-system-prompt` (appended to the default agent prompt, so tool use
  still works).
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
  --help                  Show this help
```

- `--cwd` controls where claude runs, which determines the tools, MCP servers,
  and `CLAUDE.md` it loads.
- `CCAL_CLAUDE_PATH` (environment variable) forces a specific `claude` binary
  when auto-detection does not find the right one.

## Documentation

- [docs/architecture.md](docs/architecture.md) — the request lifecycle end to
  end, module map, and binary resolution.
- [docs/development.md](docs/development.md) — local setup, scripts, testing, and
  publishing to npm.

## License

MIT © Rousan Ali
