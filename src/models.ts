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
export function listModels(): { object: "list"; data: ModelObject[] } {
  return {
    object: "list",
    data: MODEL_IDS.map((id) => {
      const meta = MODEL_META[id];
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
        supported_parameters: meta.supportedParameters,
        description: meta.description,
      };
    }),
  };
}
