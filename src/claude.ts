// Spawning the `claude` CLI as an agentic subprocess and exposing its stdout as
// an async iterator of decoded text lines. This ports the Rust adapter's
// spawn_claude, including the exact flags and the stdin-writing strategy.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, delimiter } from "node:path";

import type { ImageContent } from "./prompt.js";

// The system prompt used in vanilla mode when the request carries no system
// message of its own. See the vanilla-mode block in spawnClaude() for why an
// empty or omitted --system-prompt is not good enough here.
const VANILLA_DEFAULT_SYSTEM_PROMPT = "You are a helpful, honest assistant.";

// Options controlling how the claude process is launched for one request.
export interface SpawnOptions {
  // Absolute path to the resolved `claude` binary.
  claudePath: string;
  // The model alias to pass to `--model` (e.g. "sonnet").
  model: string;
  // Combined system prompt from the request, or null. In agentic mode this is
  // appended to the default agent prompt; in vanilla mode it replaces it.
  system: string | null;
  // The flattened transcript to write to claude's stdin.
  stdinPayload: string;
  // Images to deliver with the prompt. When non-empty, claude is switched to
  // stream-json input so the pictures can ride along as content blocks (plain
  // text input cannot carry them). Empty/omitted keeps the default text input.
  images?: ImageContent[];
  // Working directory for the process. When set, claude loads tools, MCP
  // servers, and CLAUDE.md relative to it (agentic mode only — vanilla mode
  // disables all three regardless of cwd). Defaults to the current directory.
  cwd?: string;
  // Optional permission mode. Only forwarded when it is a non-empty, non-default
  // value, matching the Rust adapter. Meaningless in vanilla mode (there are no
  // tools to grant permission for), but still forwarded — it's harmless and it
  // keeps the flag-building logic in one place.
  permissionMode?: string;
  // Run this request as a plain model call instead of a full Claude Code agent:
  // no built-in tools, no MCP servers, no CLAUDE.md, no agent system prompt. See
  // the vanilla-mode block below for exactly what that changes and why.
  vanilla?: boolean;
}

// A running claude process together with a line iterator over its stdout.
export interface ClaudeProcess {
  child: ChildProcessWithoutNullStreams;
  // Async iterable yielding one decoded line of stdout at a time (newlines
  // stripped). Completes when claude closes stdout.
  lines: AsyncIterable<string>;
}

// Build a claude invocation and start writing the prompt to its stdin.
//
// By default this runs as a full Claude Code agent: tools, MCP servers, and
// CLAUDE.md all load based on `cwd` (we deliberately do not pass `--bare`,
// `--strict-mcp-config`, or restrict `--setting-sources`). Any system content is
// *appended* to the default agent prompt via `--append-system-prompt` so tool
// use survives. Input is a single text prompt on stdin (the CLI's default input
// format) — one prompt in, one response out.
//
// `options.vanilla` switches all of that off — see the block below. This is for
// callers (like opencode) that run their own tool loop and would otherwise end
// up fighting a second, independent agent underneath ccal.
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

  if (options.vanilla) {
    // --- Vanilla mode: a plain model call, no agent framing. ---
    //
    // Four flags, each earning its place (verified against `claude --help`,
    // not assumed):
    //
    // 1. `--tools ""` disables every built-in tool. Per the CLI's own help,
    //    "" means "disable all tools". This alone does NOT stop CLAUDE.md or
    //    MCP servers from loading (verified: with only --tools "" a CLAUDE.md
    //    in --cwd still leaked into the response) — it just means the model
    //    has nothing to call.
    //
    // 2. `--safe-mode`, NOT `--bare`. The obvious pick here is `--bare` (it
    //    turns off CLAUDE.md auto-discovery, hooks, plugins, ...), and that
    //    was the starting assumption. It's wrong: --bare's own help says
    //    Anthropic auth becomes strictly ANTHROPIC_API_KEY / apiKeyHelper,
    //    "OAuth and keychain are never read". Verified by running `claude -p
    //    --bare` on a box authenticated via subscription login (no API key
    //    set): it fails with "Not logged in - Please run /login", even though
    //    the identical prompt without --bare succeeds. That would break ccal
    //    for exactly the users it exists for — the whole point of ccal (see
    //    README) is driving the CLI's existing subscription login without an
    //    API key. `--safe-mode` gets us the part we actually need: its help
    //    text says it disables CLAUDE.md, skills, plugins, hooks, and MCP
    //    servers, while explicitly leaving "auth, model selection, built-in
    //    tools, and permissions" working normally. Verified: a CLAUDE.md that
    //    leaks under plain --tools "" no longer does under --safe-mode
    //    --tools "", and the request still succeeds against a subscription
    //    login.
    //
    // 3. `--strict-mcp-config`. In this environment --safe-mode alone already
    //    empties the MCP server list (verified via the stream-json init
    //    event), which would make this redundant. But --safe-mode's own help
    //    text carves out an exception — "Admin-managed (policy) settings
    //    still apply" — and it's not clear that carve-out excludes an
    //    org-managed MCP server. --strict-mcp-config costs nothing when there
    //    is nothing to filter (no --mcp-config is passed), so it stays as a
    //    second, explicit guarantee rather than leaning on --safe-mode's
    //    behavior alone.
    //
    // 4. `--system-prompt` instead of `--append-system-prompt`. Appending
    //    leaves Claude Code's own agent system prompt in place, and even with
    //    tools disabled the model still believes it's an agent with tools —
    //    verified: with --safe-mode --tools "" but the prompt still appended,
    //    a "list the files" request came back emitting fake
    //    `<function_calls>...` blocks instead of a plain-English answer.
    //    `--system-prompt` replaces the prompt outright, which fixes that.
    //
    //    The subtlety: when the caller sends no system message, DO NOT pass
    //    `--system-prompt ""` or omit the flag. Both were tested and both
    //    fall back to the same broken behavior as appending — the model still
    //    hallucinates tool calls (and in one run, invented files that don't
    //    exist). A single whitespace-only string is worse still — the
    //    underlying API rejects it outright ("system: text content blocks
    //    must contain non-whitespace text"). So when there's no system
    //    message from the caller, we substitute a small neutral default
    //    (VANILLA_DEFAULT_SYSTEM_PROMPT) rather than leaving the flag out.
    args.push("--tools", "", "--safe-mode", "--strict-mcp-config");
    const vanillaSystem =
      options.system !== null && options.system.length > 0
        ? options.system
        : VANILLA_DEFAULT_SYSTEM_PROMPT;
    args.push("--system-prompt", vanillaSystem);
  } else if (options.system !== null && options.system.length > 0) {
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
