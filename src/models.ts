// The model list advertised by GET /v1/models. The original Rust adapter
// exposes exactly three ids — `sonnet`, `opus`, and `haiku` — which map onto the
// `--model` aliases the `claude` CLI understands. We mirror those ids here so an
// OpenAI-compatible client sees the same choices. The only difference from the
// Rust version is `owned_by`, which we set to "ccal" to reflect this package.

export const MODEL_IDS = ["sonnet", "opus", "haiku"] as const;

export type ModelId = (typeof MODEL_IDS)[number];

// The default model used when a request omits `model` (or sends an empty
// string). Matches the Rust adapter's fallback of "sonnet".
export const DEFAULT_MODEL = "sonnet";

// One entry in the OpenAI /v1/models response.
export interface ModelObject {
  id: string;
  object: "model";
  owned_by: string;
  // OpenAI clients often expect a `created` timestamp; we provide a stable one
  // so responses are deterministic rather than shifting on every request.
  created: number;
}

// Build the full OpenAI-shaped model list payload.
export function listModels(): { object: "list"; data: ModelObject[] } {
  return {
    object: "list",
    data: MODEL_IDS.map((id) => ({
      id,
      object: "model",
      owned_by: "ccal",
      created: 0,
    })),
  };
}
