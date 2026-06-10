// Composition (design.md §5.F) + the composer's two cache duties (§9).
//
// compose() reassembles the exact request body the next send will use: preserved
// runtime knobs (envelope) + head (system/tools + injected system) + messages.
// Since §11 Phase 2.7 the emitted turn frames are scoped by the optional
// RequestView — the owned /v1/messages path always composes the CURRENT REQUEST'S
// view (fork isolation); the full-store walk remains for control/debug surfaces.
// Deleted frames are omitted either way. It is the inspection surface every later
// phase relies on (`ctx compose --dump`/`--hash-head`).
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

import type { Block, Frame, RequestEnvelope, RequestView } from "./types.ts";
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
  view?: RequestView,
): ComposeResult {
  // Emission scope (§11 Phase 2.7). With a view, the REQUEST supplies membership +
  // baseline order (the frames its reconcile matched or appended) and the STORE
  // supplies each member's current representation; tombstones in the view are
  // matched-but-omitted (deleted wins). Without a view — control/debug surfaces
  // only — emit the full-store union as before. Emission stays a PURE function of
  // (view, store) so the long-term rule slots in without rework: future ops
  // (edit/compact/strip/merge/split) transform a member's representation, and
  // future user-commit-originated frames (add/insert/reorder) extend membership
  // beyond what the request carried.
  const byId = new Map(frames.map((f) => [f.id, f]));
  const emitted = view
    ? view.frameIds
        .map((id) => byId.get(id))
        // Defensive: view ids always resolve today (frames are tombstoned, never
        // removed) — the filter simply makes a future removal op fail safe.
        .filter((f): f is Frame => f !== undefined && !f.deleted)
    : frames.filter((f) => !f.deleted);

  // Wire-integrity (§11 Phase 2.6): DETECT facially-suspect blocks (e.g. empty
  // thinking husks) and surface them — never alter the wire. Compose is faithful.
  const messages = stripCacheControlDeep(emitted.flatMap((f) => f.messages));
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
