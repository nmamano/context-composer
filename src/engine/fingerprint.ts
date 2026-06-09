// Frame identity (design decision A, peer-sharpened).
//
// We stay model-unaware: we cannot inject echo markers the agent would carry back,
// so identity is derived purely from observable content. A frame is anchored to its
// OPENING message — fingerprint = sha256(role + narrowly-normalized content). The
// opening message is immutable while the frame grows (assistant reply, tool loop),
// so this anchor is stable across turns.
//
// Known Phase 1 limitation (documented, peer-accepted): two *identical* opening
// messages collide on fingerprint and are disambiguated only by occurrence order
// (see reconcile.ts). If you delete one of two byte-identical frames, the greedy
// ordered match may bind the survivor's resend to the tombstone. Acceptable for the
// tracer bullet; revisited if/when it bites.

import type { WireMessage } from "./types.ts";
import { canonicalStringify, sha256, stripCacheControlDeep } from "./canonical.ts";

export function fingerprintMessage(msg: WireMessage): string {
  // Strip cache_control first: the agent attaches/relocates it between turns, so the
  // same message must hash identically with or without the marker (see live finding).
  return sha256(canonicalStringify(stripCacheControlDeep({ role: msg.role, content: msg.content })));
}

/** Head identity: the stable cache prefix (tools + system). Used to detect head
 *  changes and to anchor the preamble frame. cache_control is normalized out so a moved
 *  provider marker doesn't read as a head change. */
export function fingerprintHead(system: unknown, tools: unknown): string {
  return sha256(
    canonicalStringify(stripCacheControlDeep({ tools: tools ?? null, system: system ?? null })),
  );
}
