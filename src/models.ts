// The model list advertised by GET /v1/models. The original Rust adapter
// exposes exactly three ids — `sonnet`, `opus`, and `haiku` — which map onto the
// `--model` aliases the `claude` CLI understands. We mirror those ids here so an
// OpenAI-compatible client sees the same choices (`owned_by` is "ccal").
//
// Each entry also carries OpenRouter-style catalog metadata (context length,
// input modalities, supported parameters, a description). Plain OpenAI clients
// ignore these extra fields, while metadata-aware clients can render context
// size and capability badges (vision / tools / reasoning) without guessing.

export const MODEL_IDS = ["sonnet", "opus", "haiku"] as const;

export type ModelId = (typeof MODEL_IDS)[number];

// The default model used when a request omits `model` (or sends an empty
// string). Matches the Rust adapter's fallback of "sonnet".
export const DEFAULT_MODEL = "sonnet";

// Catalog metadata per model. Claude models take text and images, run tools as
// a full Claude Code agent, and (sonnet/opus) support extended-thinking
// reasoning. The 200K context is the current Claude window.
interface ModelMeta {
  contextLength: number;
  inputModalities: string[];
  supportedParameters: string[];
  description: string;
}

const MODEL_META: Record<ModelId, ModelMeta> = {
  sonnet: {
    contextLength: 200000,
    inputModalities: ["text", "image"],
    supportedParameters: ["tools", "reasoning"],
    description: "Anthropic Claude Sonnet, served through the local claude CLI.",
  },
  opus: {
    contextLength: 200000,
    inputModalities: ["text", "image"],
    supportedParameters: ["tools", "reasoning"],
    description: "Anthropic Claude Opus, served through the local claude CLI.",
  },
  haiku: {
    contextLength: 200000,
    inputModalities: ["text", "image"],
    supportedParameters: ["tools"],
    description: "Anthropic Claude Haiku, served through the local claude CLI.",
  },
};

// One entry in the OpenAI /v1/models response, plus the OpenRouter-style
// metadata fields metadata-aware clients read.
export interface ModelObject {
  id: string;
  object: "model";
  owned_by: string;
  // OpenAI clients often expect a `created` timestamp; we provide a stable one
  // so responses are deterministic rather than shifting on every request.
  created: number;
  context_length: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
  supported_parameters: string[];
  description: string;
}

// Build the full OpenAI-shaped model list payload.
//
// `vanilla` mirrors the server's --vanilla flag. `supported_parameters` is
// catalog metadata about what the *backing agent* can do while producing a
// response, not a literal OpenAI tool-calling contract ccal implements itself
// (it doesn't read a `tools` field off the request at all). In vanilla mode
// the claude invocation runs with all tools disabled (see spawnClaude()'s
// vanilla block in claude.ts), so advertising "tools" there would describe a
// capability that request path cannot actually exercise. We drop it rather
// than leave a metadata-aware client to discover the gap by trying. Reasoning
// (extended thinking) is unaffected by tool availability — verified: thinking
// tokens still show up in vanilla responses from sonnet/opus — so it stays.
export function listModels(vanilla = false): { object: "list"; data: ModelObject[] } {
  return {
    object: "list",
    data: MODEL_IDS.map((id) => {
      const meta = MODEL_META[id];
      const supportedParameters = vanilla
        ? meta.supportedParameters.filter((p) => p !== "tools")
        : meta.supportedParameters;
      return {
        id,
        object: "model",
        owned_by: "ccal",
        created: 0,
        context_length: meta.contextLength,
        architecture: {
          input_modalities: meta.inputModalities,
          output_modalities: ["text"],
        },
        supported_parameters: supportedParameters,
        description: meta.description,
      };
    }),
  };
}
