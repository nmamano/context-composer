// Canonical serialization — the single serializer that feeds both the cache story
// and (later, Phase 2) the store. Determinism is the whole point: identical logical
// content must produce identical bytes every turn, so we never bust the provider
// cache by accident (design.md §9 "composer cache duties").
//
// Normalization is deliberately NARROW: sort object keys recursively, preserve array
// order (array order is semantically meaningful in messages/content/tools). We strip
// nothing here — callers decide what goes on the wire.

import { createHash } from "node:crypto";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // undefined never reaches the wire
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: sorted keys, preserved array order, stable bytes. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Recursively remove every `cache_control` key, returning a fresh structure (never
 * mutates the input). `cache_control` is a provider caching HINT, not semantic content:
 * a real agent (e.g. Claude Code) attaches it to message/system/tool blocks and MOVES
 * it between turns as the conversation grows. It must be normalized out before both
 * (a) fingerprinting — or the same message resent with the marker relocated looks like a
 * different frame and reconciliation misses — and (b) re-serialization, where we own the
 * single outgoing breakpoint.
 */
export function stripCacheControlDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripCacheControlDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control") continue;
      out[k] = stripCacheControlDeep(v);
    }
    return out as T;
  }
  return value;
}
