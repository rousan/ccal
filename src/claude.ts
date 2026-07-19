// Spawning the `claude` CLI as an agentic subprocess and exposing its stdout as
// an async iterator of decoded text lines. This ports the Rust adapter's
// spawn_claude, including the exact flags and the stdin-writing strategy.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, delimiter } from "node:path";

import type { ImageContent } from "./prompt.js";

// Options controlling how the claude process is launched for one request.
export interface SpawnOptions {
  // Absolute path to the resolved `claude` binary.
  claudePath: string;
  // The model alias to pass to `--model` (e.g. "sonnet").
  model: string;
  // Combined system prompt to append via `--append-system-prompt`, or null.
  system: string | null;
  // The flattened transcript to write to claude's stdin.
  stdinPayload: string;
  // Images to deliver with the prompt. When non-empty, claude is switched to
  // stream-json input so the pictures can ride along as content blocks (plain
  // text input cannot carry them). Empty/omitted keeps the default text input.
  images?: ImageContent[];
  // Working directory for the process. When set, claude loads tools, MCP
  // servers, and CLAUDE.md relative to it. Defaults to the current directory.
  cwd?: string;
  // Optional permission mode. Only forwarded when it is a non-empty, non-default
  // value, matching the Rust adapter.
  permissionMode?: string;
}

// A running claude process together with a line iterator over its stdout.
export interface ClaudeProcess {
  child: ChildProcessWithoutNullStreams;
  // Async iterable yielding one decoded line of stdout at a time (newlines
  // stripped). Completes when claude closes stdout.
  lines: AsyncIterable<string>;
}

// Build an agentic claude invocation and start writing the prompt to its stdin.
//
// Runs as a full Claude Code agent: tools, MCP servers, and CLAUDE.md all load
// based on `cwd` (we deliberately do not pass `--bare`, `--strict-mcp-config`,
// or restrict `--setting-sources`). Any system content is *appended* to the
// default agent prompt via `--append-system-prompt` so tool use survives. Input
// is a single text prompt on stdin (the CLI's default input format) — one prompt
// in, one response out.
export function spawnClaude(options: SpawnOptions): ClaudeProcess {
  const hasImages = !!options.images && options.images.length > 0;

  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    options.model,
    "--no-session-persistence",
  ];

  // With images we must use stream-json input, the only input format that can
  // carry content blocks. It's still one user message in, one response out — we
  // send a single `user` event with a text block plus the image blocks, then
  // close stdin.
  if (hasImages) {
    args.push("--input-format", "stream-json");
  }

  if (options.system !== null && options.system.length > 0) {
    args.push("--append-system-prompt", options.system);
  }

  // Only pass --permission-mode for an explicit non-default mode. Empty or
  // "default" leaves the CLI in its normal (read-only in headless) mode.
  const pm = options.permissionMode?.trim();
  if (pm && pm !== "default") {
    args.push("--permission-mode", pm);
  }

  // Ensure claude's own directory is on PATH, because it shells out to helper
  // binaries that may live alongside it. We prepend it if it is not already
  // present, mirroring the Rust adapter's PATH handling.
  const env = { ...process.env };
  const claudeDir = dirname(options.claudePath);
  const currentPath = env.PATH ?? "";
  const alreadyPresent = currentPath
    .split(delimiter)
    .some((p) => p === claudeDir);
  if (claudeDir && !alreadyPresent) {
    env.PATH = currentPath.length > 0 ? `${claudeDir}${delimiter}${currentPath}` : claudeDir;
  }

  const child = spawn(options.claudePath, args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  // Write the prompt then close stdin. Node buffers writes and drains
  // asynchronously, so a large prompt cannot deadlock against stdout
  // back-pressure the way a synchronous write could. We swallow EPIPE-style
  // errors that occur if claude exits before reading all of stdin.
  child.stdin.on("error", () => {
    // Ignore write errors on stdin; the process may have already exited.
  });
  if (hasImages) {
    // One stream-json `user` event: the transcript as a text block (omitted when
    // empty, e.g. an images-only turn) followed by each image as an Anthropic
    // image content block. A trailing newline delimits the JSONL line.
    const content: Array<Record<string, unknown>> = [];
    if (options.stdinPayload.length > 0) {
      content.push({ type: "text", text: options.stdinPayload });
    }
    for (const img of options.images!) {
      content.push({ type: "image", source: img.source });
    }
    const event = { type: "user", message: { role: "user", content } };
    child.stdin.write(`${JSON.stringify(event)}\n`);
  } else {
    child.stdin.write(options.stdinPayload);
  }
  child.stdin.end();

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  return { child, lines: rl };
}
