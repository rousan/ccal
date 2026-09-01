// The OpenAI-compatible HTTP surface, built on Hono. It mounts /v1/models and
// /v1/chat/completions (plus a /health probe) and translates between the OpenAI
// wire format and the local `claude` CLI. This is the TypeScript equivalent of
// the Rust adapter's axum router and handlers.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { stream } from "hono/streaming";

import { resolveClaude } from "./claude-binary.js";
import { listModels, DEFAULT_MODEL } from "./models.js";
import { preparePrompt, type ChatMessage } from "./prompt.js";
import { spawnClaude } from "./claude.js";
import { newStreamState, processLine } from "./stream.js";

// The shape of an incoming /v1/chat/completions request body. We only read the
// three fields the adapter cares about; everything else is ignored.
interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

// Options that influence how the adapter spawns claude, plumbed in from the CLI.
export interface AdapterConfig {
  // Working directory for the claude process. When omitted, claude runs in the
  // server's current working directory.
  cwd?: string;
  // Optional permission mode forwarded to claude (only when non-default).
  permissionMode?: string;
  // Origins allowed to reach this server from a page served over the public
  // internet — see the Private Network Access note in `createServer`. Empty or
  // omitted turns the feature off, which is the default and the safe posture.
  allowedOrigins?: string[];
  // Run every request as a plain model call instead of a full Claude Code
  // agent: no tools, no MCP servers, no CLAUDE.md, no agent system prompt. See
  // the vanilla-mode block in claude.ts's spawnClaude() for exactly what that
  // changes and why. Off by default — existing consumers rely on the agentic
  // behaviour, which stays completely unchanged when this is unset.
  vanilla?: boolean;
}

// Generate a unique-ish completion id. We use the high-resolution clock in
// nanoseconds, matching the Rust adapter's `chatcmpl-<nanos>` scheme.
function genId(): string {
  const nanos = process.hrtime.bigint();
  return `chatcmpl-${nanos.toString()}`;
}

// Build one OpenAI SSE chunk frame. Clients split the stream on "\n\n",
// JSON-parse the `data:` payload, and read choices[0].delta.content.
function sseChunk(id: string, text: string): string {
  const payload = {
    id,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: text } }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// Construct the Hono app. The claude binary is resolved once per request (cheap,
// and it lets the server recover if claude is installed after startup).
export function createServer(config: AdapterConfig = {}): Hono {
  const app = new Hono();

  const allowedOrigins = config.allowedOrigins ?? [];

  // ---------------------------------------------------------------------------
  // Private Network Access
  //
  // CORS alone is not enough for a page served from a *public* origin (say
  // https://example.com) to call this server on 127.0.0.1. Chrome applies a
  // second, separate check — Private Network Access — which requires the
  // preflight to carry `Access-Control-Request-Private-Network: true` and the
  // response to answer `Access-Control-Allow-Private-Network: true`.
  //
  // Without that answer the fetch does not fail: it HANGS. No console error, no
  // CORS message, no rejected promise. That silence is the entire reason this
  // block is commented at this length.
  //
  // WHY IT IS OFF BY DEFAULT. Answering `true` for every origin would let any
  // website you happen to visit drive your local `claude` CLI — spending your
  // subscription and running it against whatever `--cwd` points at. PNA exists
  // precisely to stop that, so ccal only waives it for origins you name
  // explicitly with `--allow-origin`. No flag, no header, no change in
  // behaviour from earlier versions.
  //
  // Note this is invisible when both ends are local: a page on localhost
  // calling 127.0.0.1 is private-to-private, so PNA never engages and the whole
  // mechanism appears not to exist. It only shows up from a deployed site.
  // ---------------------------------------------------------------------------
  if (allowedOrigins.length > 0) {
    app.use("*", async (c, next) => {
      await next();
      // Only ever answer the question the browser actually asked, and only for
      // an origin the operator named.
      if (c.req.header("Access-Control-Request-Private-Network") !== "true") {
        return;
      }
      const origin = c.req.header("Origin");
      if (origin && allowedOrigins.includes(origin)) {
        c.header("Access-Control-Allow-Private-Network", "true");
      }
    });
  }

  // Permissive CORS so browser and webview clients (like the Warren app) are not
  // blocked by same-origin policy. We allow the headers an OpenAI-style client
  // typically sends. When `--allow-origin` is given, CORS narrows to exactly
  // those origins — reflecting `*` while also waiving PNA for a named origin
  // would be an odd pair of promises to make.
  app.use(
    "*",
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  );

  // Simple liveness probe.
  app.get("/health", (c) => c.json({ ok: true }));

  // The OpenAI model list. Mirrors the ids the CLI understands. In vanilla
  // mode the `tools` capability is dropped from `supported_parameters` — see
  // the comment on listModels() in models.ts for why.
  app.get("/v1/models", (c) => c.json(listModels(config.vanilla)));

  // The OpenAI chat-completions endpoint.
  app.post("/v1/chat/completions", async (c) => {
    let body: ChatRequest;
    try {
      body = await c.req.json<ChatRequest>();
    } catch {
      return c.json({ error: { message: "Invalid JSON body" } }, 400);
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const { stdinPayload, system, images } = preparePrompt(messages);

    const model =
      typeof body.model === "string" && body.model.trim().length > 0
        ? body.model
        : DEFAULT_MODEL;

    const claudePath = resolveClaude();
    if (!claudePath) {
      return c.json(
        { error: { message: "Could not find the `claude` CLI on this system." } },
        502,
      );
    }

    const proc = spawnClaude({
      claudePath,
      model,
      system,
      stdinPayload,
      images,
      cwd: config.cwd,
      permissionMode: config.permissionMode,
      vanilla: config.vanilla,
    });

    const id = genId();

    // Surface a spawn failure as a 502 rather than a hung connection.
    let spawnFailed = false;
    proc.child.on("error", () => {
      spawnFailed = true;
    });

    if (body.stream) {
      // Streaming path: translate claude's stream-json into OpenAI SSE chunks.
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      return stream(c, async (streamApi) => {
        const state = newStreamState();
        try {
          for await (const line of proc.lines) {
            const content = processLine(line, state);
            if (content !== null) {
              await streamApi.write(sseChunk(id, content));
            }
          }
        } catch {
          // Read error mid-stream — fall through to close cleanly below.
        }
        // Reap the child so we do not leak a zombie process.
        await waitForExit(proc.child);
        await streamApi.write("data: [DONE]\n\n");
      });
    }

    // Non-streaming path: collect the full response and return a single
    // chat.completion object.
    const state = newStreamState();
    let full = "";
    try {
      for await (const line of proc.lines) {
        const content = processLine(line, state);
        if (content !== null) {
          full += content;
        }
      }
    } catch {
      // Ignore read errors; we return whatever we managed to collect.
    }
    await waitForExit(proc.child);

    if (spawnFailed) {
      return c.json({ error: { message: "Failed to launch claude" } }, 502);
    }

    return c.json({
      id,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: full },
          finish_reason: "stop",
        },
      ],
    });
  });

  return app;
}

// Resolve once the child process has exited, so callers can reap it. Resolves
// immediately if it has already exited.
function waitForExit(child: import("node:child_process").ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}
