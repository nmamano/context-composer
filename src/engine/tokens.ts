// Cheap, deterministic token estimate. Phase 1 only needs a stable number for the
// `list` scan view and for showing offload savings later — not accuracy. ~4 chars
// per token is the usual rough rule; we never call a tokenizer here.

export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(s.length / 4);
}
