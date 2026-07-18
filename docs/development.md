# Development

How to set up, run, test, and publish **ccal** locally.

## Prerequisites

- **Node 20+**
- **pnpm** (the package manager this repo uses)
- The **`claude` CLI** installed and logged in — ccal spawns it as a subprocess,
  so you need it to exercise `/v1/chat/completions` end to end. Install from
  <https://docs.claude.com/claude-code> and run `claude` once to sign in.

## Setup

```sh
git clone https://github.com/rousan/ccal.git
cd ccal
pnpm install
```

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Run the server directly from `src/` with `tsx` (no build step). Equivalent to `tsx src/cli.ts serve`. |
| `pnpm typecheck` | `tsc --noEmit` — type-check without emitting. |
| `pnpm build` | `tsc` — compile `src/` to `dist/` (this is what `prepublishOnly` runs). |
| `pnpm start` | Run the compiled server: `node dist/cli.js serve`. |

During development, `pnpm dev` is usually all you need. Pass flags after the
script, e.g.:

```sh
pnpm dev -- --port 8788
```

## Testing locally with curl

Start the server (source or compiled):

```sh
pnpm dev -- --port 8787
# or, after pnpm build:
node dist/cli.js serve --port 8787
```

**Health probe:**

```sh
curl http://127.0.0.1:8787/health
# {"ok":true}
```

**Model list:**

```sh
curl http://127.0.0.1:8787/v1/models
# {"object":"list","data":[{"id":"sonnet",...},{"id":"opus",...},{"id":"haiku",...}]}
```

**Chat completion (non-streaming):**

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "sonnet",
    "messages": [{ "role": "user", "content": "Say hello in one word." }]
  }'
```

**Chat completion (streaming):**

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [{ "role": "user", "content": "Say hello in one word." }]
  }'
```

You should see `data: {...}` SSE frames followed by `data: [DONE]`.

> The `/v1/models` and `/health` endpoints work without the `claude` CLI. The
> chat endpoint needs `claude` installed and logged in; if it can't be found you
> get a `502` with a clear message.

If auto-detection doesn't find your binary, set the override:

```sh
CCAL_CLAUDE_PATH=/path/to/claude pnpm dev
```

## Code layout

See [architecture.md](architecture.md) for the full request lifecycle and
[../CLAUDE.md](../CLAUDE.md) for the `src/` module map and conventions. In short:
`cli.ts` (entry) → `server.ts` (routes) → `prompt.ts` (flatten) →
`claude-binary.ts` (resolve) → `claude.ts` (spawn) → `stream.ts` (translate).

## Publishing to npm

ccal is published as the scoped, public package **`@rousan/ccal`**.

1. Make sure you're logged in to npm and have publish rights to the `@rousan`
   scope:

   ```sh
   npm whoami
   npm login   # if needed
   ```

2. Bump the version and update the changelog:
   - Update `version` in `package.json` (follow [SemVer](https://semver.org)).
   - Move the relevant notes from `Unreleased` to a new version section in
     [../CHANGELOG.md](../CHANGELOG.md).

3. Build and publish. `prepublishOnly` runs `pnpm build` automatically, so
   `dist/` is always freshly compiled:

   ```sh
   pnpm build
   npm publish --access public
   ```

   `--access public` is also set via `publishConfig` in `package.json`, so scoped
   publishes default to public rather than private.

4. Verify the published bin works end to end:

   ```sh
   npx @rousan/ccal serve --port 8787
   ```

### Publishing via a git tag (optional)

If you wire up a release workflow, tag the release to match the version and let CI
run the publish:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The `files` field in `package.json` limits the published tarball to `dist`,
`README.md`, and `LICENSE`, so source and dev files are not shipped.
