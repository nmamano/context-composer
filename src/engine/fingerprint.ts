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

import type { Block, WireMessage } from "./types.ts";
import { canonicalStringify, sha256, stripCacheControlDeep } from "./canonical.ts";

/**
 * Normalization for IDENTITY ONLY — storage and the wire stay verbatim (fidelity rule:
 * we emit what the agent sent; we only normalize what we *hash*).
 *
 * A plain-string content is the API's documented shorthand for one text block, and a
 * real agent re-encodes between the two forms across requests (live finding, §11 Phase 2.6: the
 * same user message arrived as a string in one request and as [{type:"text",…}] in the
 * next; the fingerprint mismatch forked the frame and duplicated its tool_use on the
 * wire). Hash the canonical block form so both encodings are the same identity.
 */
function identityContent(content: string | Block[] | undefined | null): Block[] | null {
  if (content === undefined || content === null) return null;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

export function fingerprintMessage(msg: WireMessage): string {
  // Strip cache_control first: the agent attaches/relocates it between turns, so the
  // same message must hash identically with or without the marker (see live finding).
  return sha256(
    canonicalStringify(
      stripCacheControlDeep({ role: msg.role, content: identityContent(msg.content) }),
    ),
  );
}

/** Head identity: the stable cache prefix (tools + system). Used to detect head
 *  changes and to anchor the preamble frame. cache_control is normalized out so a moved
 *  provider marker doesn't read as a head change; string/array system encodings hash
 *  identically (same identity rule as message content). */
export function fingerprintHead(system: unknown, tools: unknown): string {
  const sys =
    typeof system === "string" ? [{ type: "text", text: system }] : system ?? null;
  return sha256(
    canonicalStringify(stripCacheControlDeep({ tools: tools ?? null, system: sys })),
  );
}
