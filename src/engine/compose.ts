// Composition (design.md §5.F) + the composer's two cache duties (§9).
//
// compose() walks the authoritative frame list in order, OMITS deleted frames, and
// reassembles the exact request body the next send will use: preserved runtime
// knobs (envelope) + head (system/tools + injected system) + messages. It is the
// inspection surface every later phase relies on (`ctx compose --dump`/`--hash-head`).
//
// Cache duties:
//  (a) deterministic bytes — via canonicalStringify, so unchanged frames serialize
//      identically every turn and never bust the cache by accident;
//  (b) keep ONE provider cache-prefix marker on the STABLE HEAD. Anthropic's cache
//      prefix runs tools → system → messages, so we mark the last block of the stable
//      head (last base-system block; or last tool if there's no system). We strip EVERY
//      inherited cache_control (head AND messages) first, then place exactly one owned
//      breakpoint — so the outgoing request always has a single, deterministic marker we
//      control. (A real agent like Claude Code sets its own markers with mixed TTLs;
//      leaving them in place lets our added breakpoint violate Anthropic's ordering rule
//      "a 1h block must not come after a 5m block" across tools→system→messages. Caching
//      the big head is the win; the small tail is reprocessed — acceptable for the demo.)
//
// Agent-injected system blocks (decision F) are folded into `system` AFTER the stable
// head and AFTER the breakpoint — they may be volatile (retrieved memory), so they sit
// outside the cached prefix and outside the head hash.

import type { Block, Frame, RequestEnvelope } from "./types.ts";
import { canonicalStringify, sha256, stripCacheControlDeep } from "./canonical.ts";
import { detectWireIssues, type WireWarning } from "./wire-integrity.ts";

export interface ComposeResult {
  body: Record<string, unknown>;
  /** sha256 of the canonical stable head (tools + base system, with the breakpoint) —
   *  the determinism witness; excludes volatile injected blocks. */
  headHash: string;
  /** Whether the single owned cache_control breakpoint was placed. */
  hasCacheBreakpoint: boolean;
  /** Facially suspect blocks found in the composed messages — always detected and
   *  surfaced (control API / wiretap / stderr), never silently acted on (§11
   *  Phase 2.6: compose is faithful). */
  wireWarnings: WireWarning[];
}

function toSystemBlocks(system: unknown): Block[] {
  if (system === undefined || system === null) return [];
  if (typeof system === "string") return [{ type: "text", text: system }];
  if (Array.isArray(system)) return system as Block[];
  return [system as Block];
}

export function compose(
  preamble: Frame | null,
  frames: Frame[],
  envelope: RequestEnvelope,
): ComposeResult {
  // Wire-integrity (§11 Phase 2.6): DETECT facially-suspect blocks (e.g. empty
  // thinking husks) and surface them — never alter the wire. Compose is faithful.
  const messages = stripCacheControlDeep(
    frames.filter((f) => !f.deleted).flatMap((f) => f.messages),
  );
  const wireWarnings = detectWireIssues(messages);

  const headPresent = !!preamble && !preamble.deleted;
  const baseSystem = stripCacheControlDeep(
    toSystemBlocks(headPresent ? preamble!.system : undefined),
  );
  const rawTools = headPresent ? preamble!.tools : undefined;
  const tools = Array.isArray(rawTools)
    ? stripCacheControlDeep(rawTools as Block[])
    : rawTools;
  const injected = stripCacheControlDeep(
    headPresent ? preamble!.injectedSystem ?? [] : [],
  );

  // Place the single owned breakpoint on the last stable-head block.
  let placed = false;
  if (baseSystem.length > 0) {
    baseSystem[baseSystem.length - 1] = {
      ...baseSystem[baseSystem.length - 1],
      cache_control: { type: "ephemeral" },
    };
    placed = true;
  } else if (Array.isArray(tools) && tools.length > 0) {
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      cache_control: { type: "ephemeral" },
    };
    placed = true;
  }

  const finalSystem = [...baseSystem, ...injected];

  const body: Record<string, unknown> = { ...envelope };
  if (finalSystem.length > 0) body.system = finalSystem;
  if (rawTools !== undefined) body.tools = tools;
  body.messages = messages;

  const headHash = sha256(
    canonicalStringify({
      tools: tools ?? null,
      system: baseSystem.length > 0 ? baseSystem : null,
    }),
  );

  return { body, headHash, hasCacheBreakpoint: placed, wireWarnings };
}
