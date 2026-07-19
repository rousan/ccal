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

// An image pulled out of an OpenAI `image_url` content part, in the Anthropic
// content-block `source` shape claude's stream-json input expects. A `data:` URL
// becomes a base64 source; a plain http(s) URL is passed through as a url source.
export interface ImageContent {
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}

// The result of preparing a request: the flattened user/assistant transcript to
// send on stdin, the combined system prompt (if any system messages were
// present), and any images extracted from the messages. When `images` is
// non-empty the caller switches claude to stream-json input so the pictures are
// actually delivered (plain text input has no way to carry them).
export interface PreparedPrompt {
  stdinPayload: string;
  system: string | null;
  images: ImageContent[];
}

// Parse one OpenAI `image_url` value into an Anthropic image source. Handles both
// `data:<mime>;base64,<data>` URLs (what browser/webview clients send after a
// paste or file pick) and remote http(s) URLs. Returns null for anything else.
function parseImageUrl(url: string): ImageContent | null {
  const dataMatch = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataMatch) {
    return {
      source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { source: { type: "url", url } };
  }
  return null;
}

// Pull every image out of a message's content. Only array content can carry
// images; a string contributes none.
function extractImages(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) return [];
  const out: ImageContent[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; image_url?: unknown };
    if (p.type !== "image_url") continue;
    const url =
      p.image_url && typeof p.image_url === "object"
        ? (p.image_url as { url?: unknown }).url
        : undefined;
    if (typeof url !== "string") continue;
    const parsed = parseImageUrl(url);
    if (parsed) out.push(parsed);
  }
  return out;
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
  // Images from every message, collected so they can be delivered on the single
  // user turn we send to claude. We don't track which turn each image came from:
  // it's one-prompt-in, so the model sees the full text transcript plus all the
  // pictures together, which is what a "look at this image" request needs.
  const images: ImageContent[] = [];

  for (const message of messages) {
    const text = contentText(message.content);
    images.push(...extractImages(message.content));
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

  return { stdinPayload, system, images };
}
