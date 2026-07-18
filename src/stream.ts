// Translating the `claude` CLI's stream-json output into user-visible text.
//
// When invoked with `--output-format stream-json --include-partial-messages
// --verbose`, claude emits one JSON object per line. We only care about the
// `stream_event` lines (the ones carrying an `event` field): those are the
// incremental Anthropic streaming events. The full `assistant` snapshot messages
// and the `tool_result` `user` messages repeat the same tool_use blocks, so we
// ignore them to avoid emitting tool activity twice.
//
// This module is a direct port of the Rust adapter's process_line / tool_label
// helpers.

// An in-progress tool_use block, tracked by its content-block index while the
// `input` JSON streams in over successive `input_json_delta` fragments.
interface ToolBlock {
  name: string;
  json: string;
}

// The running state threaded through process line calls for one response. It
// holds the set of tool blocks currently open, keyed by content-block index.
export interface StreamState {
  tools: Map<number, ToolBlock>;
}

// Create a fresh stream state for a new response.
export function newStreamState(): StreamState {
  return { tools: new Map() };
}

// Process one stream-json line against the running state, returning any assistant
// *content* to surface to the client (plain text, or a compact one-line note
// describing a tool call). Returns null for lines that carry no user-visible
// content.
//
// Observed event shapes:
//   text:       event.type=content_block_delta, delta.type=text_delta, delta.text
//   tool open:  event.type=content_block_start, content_block.type=tool_use (name,id)
//   tool args:  event.type=content_block_delta, delta.type=input_json_delta, partial_json
//   tool close: event.type=content_block_stop, index
export function processLine(line: string, state: StreamState): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Non-JSON line (blank line, stray log output). Nothing to surface.
    return null;
  }

  if (!isObject(parsed)) return null;
  const event = parsed.event;
  if (!isObject(event)) return null;

  const eventType = asString(event.type);
  if (eventType === null) return null;

  switch (eventType) {
    case "content_block_start": {
      const contentBlock = event.content_block;
      if (!isObject(contentBlock)) return null;
      if (asString(contentBlock.type) !== "tool_use") return null;
      const index = asNumber(event.index);
      if (index === null) return null;
      const name = asString(contentBlock.name) ?? "";
      state.tools.set(index, { name, json: "" });
      return null;
    }

    case "content_block_delta": {
      const delta = event.delta;
      if (!isObject(delta)) return null;
      const deltaType = asString(delta.type);
      if (deltaType === "text_delta") {
        return asString(delta.text);
      }
      if (deltaType === "input_json_delta") {
        const index = asNumber(event.index);
        const partial = asString(delta.partial_json);
        if (index !== null && partial !== null) {
          const tool = state.tools.get(index);
          if (tool) {
            tool.json += partial;
          }
        }
        return null;
      }
      return null;
    }

    case "content_block_stop": {
      const index = asNumber(event.index);
      if (index === null) return null;
      const tool = state.tools.get(index);
      if (!tool) return null;
      state.tools.delete(index);
      // Render a compact italic note describing the completed tool call, framed
      // by blank lines so it reads as its own paragraph in the output.
      return `\n\n*↳ ${toolLabel(tool.name, tool.json)}*\n\n`;
    }

    default:
      return null;
  }
}

// Render a compact, single-line label for a completed tool call from its name
// and assembled input JSON. Falls back to the cleaned raw tool name.
export function toolLabel(name: string, inputJson: string): string {
  let input: unknown = null;
  try {
    input = JSON.parse(inputJson);
  } catch {
    input = null;
  }
  const arg = (key: string): string => {
    if (isObject(input)) {
      const value = input[key];
      if (typeof value === "string") return clean(value);
    }
    return "";
  };

  if (name.startsWith("mcp__")) {
    // mcp__<server>__<tool> -> "<server> · <tool>"
    const rest = name.slice("mcp__".length);
    const parts = rest.split("__");
    if (parts.length >= 2) {
      return `${parts[0]} · ${parts[1]}`;
    }
    return clean(name);
  }

  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const path = lastSegments(arg("file_path"), 2);
      return `${name} ${path}`;
    }
    case "Bash":
      return `Bash: ${truncate(arg("command"), 60)}`;
    case "Grep":
      return `Search "${truncate(arg("pattern"), 60)}"`;
    case "Glob":
      return `Glob ${truncate(arg("pattern"), 60)}`;
    case "Task": {
      let description = arg("description");
      if (description.length === 0) {
        description = truncate(arg("prompt"), 60);
      }
      return `Subagent: ${description}`;
    }
    case "WebFetch":
      return `Fetch ${arg("url")}`;
    case "WebSearch":
      return `Web search "${truncate(arg("query"), 60)}"`;
    default:
      return clean(name);
  }
}

// Collapse all whitespace (including newlines) to single spaces and trim.
function clean(s: string): string {
  return s.split(/\s+/).filter((part) => part.length > 0).join(" ");
}

// Truncate to at most `max` characters, appending an ellipsis when cut. We count
// by code points (spread into an array) so multi-byte characters are handled the
// same way Rust's char-based truncation did.
function truncate(s: string, max: number): string {
  const chars = [...s];
  if (chars.length > max) {
    return chars.slice(0, max).join("") + "…";
  }
  return s;
}

// Keep the last `n` non-empty path segments (e.g. "a/b/c.txt" -> "b/c.txt").
function lastSegments(path: string, n: number): string {
  const segments = path
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length === 0) {
    return path;
  }
  const start = Math.max(0, segments.length - n);
  return segments.slice(start).join("/");
}

// Narrow an unknown value to a plain object with string keys.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Return the value as a string, or null if it is not a string.
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Return the value as a number, or null if it is not a finite number.
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
