// Turning an OpenAI `messages` array into the single text prompt (plus optional
// system prompt) that we feed to the `claude` CLI. This faithfully reproduces
// the logic from the Rust adapter's chat_completions handler.
//
// The key design decision, carried over verbatim: we flatten the whole
// conversation into ONE stable text transcript and hand it to claude as a single
// prompt on stdin. We deliberately do not use claude's stream-json *input* mode
// (which would treat the array as a realtime stream where claude answers every
// user turn), because we want exactly one prompt in and one response out. Keeping
// the transcript append-only also means the cached prefix stays byte-identical
// across follow-up turns.

// An OpenAI-style chat message. `content` can be either a plain string or an
// array of content parts (each part typically `{ type: "text", text: "..." }`).
export interface ChatMessage {
  role?: string;
  content?: unknown;
}

// The result of preparing a request: the flattened user/assistant transcript to
// send on stdin, and the combined system prompt (if any system messages were
// present).
export interface PreparedPrompt {
  stdinPayload: string;
  system: string | null;
}

// OpenAI message content may be a plain string or an array of content parts.
// Pull out the text either way. Anything that is neither a string nor an array
// of text parts contributes the empty string, matching the Rust behavior.
export function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

// Split the messages into system parts and user/assistant turns, then render the
// turns into the stdin payload. A lone message goes in verbatim; a multi-turn
// conversation is rendered as a labeled `User:` / `Assistant:` transcript with
// the latest user question last.
export function preparePrompt(messages: ChatMessage[]): PreparedPrompt {
  const systemParts: string[] = [];
  // Each turn is a [label, text] pair where label is "User" or "Assistant".
  const turns: Array<[string, string]> = [];

  for (const message of messages) {
    const text = contentText(message.content);
    switch (message.role) {
      case "system":
        systemParts.push(text);
        break;
      case "assistant":
        turns.push(["Assistant", text]);
        break;
      default:
        // Any non-system, non-assistant role (typically "user") is treated as a
        // user turn, matching the Rust adapter's catch-all arm.
        turns.push(["User", text]);
        break;
    }
  }

  let stdinPayload: string;
  if (turns.length === 1) {
    // A single message is sent as-is, without a role label.
    stdinPayload = turns[0][1];
  } else {
    stdinPayload = turns
      .map(([label, text]) => `${label}: ${text}`)
      .join("\n\n");
  }

  const system = systemParts.length > 0 ? systemParts.join("\n\n") : null;

  return { stdinPayload, system };
}
