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
import {
  detectWireIssues,
  sweepWire,
  type WireRepair,
  type WireWarning,
} from "./wire-integrity.ts";

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
  /** Structural repairs the §5.F sweep applied to the EMITTED messages (§11
   *  Phase 3a) — projection-time only, the store is untouched. Always surfaced
   *  (control API / wiretap / stderr); empty when nothing needed repair (the
   *  agent's own resends are structurally valid — repairs fire on user-op-
   *  induced states). */
  wireRepairs: WireRepair[];
  /** §11 Phase 3c — placement/structure anomalies (e.g. a placement cycle whose
   *  frames were appended in store order). Deliberately separate from
   *  wireWarnings, which is reserved for provider-wire issues. */
  structureWarnings: StructureWarning[];
  /** §11 Phase 3c — the frame ids actually emitted, in emission order (post
   *  placement; post resolution once absorption lands). Separate evidence from
   *  the view: viewFrameIds stays the honest pre-resolution MATCH mapping. */
  emittedFrameIds: string[];
}

export interface StructureWarning {
  kind: "placement-cycle" | "resolution-depth";
  detail: string;
}

/**
 * Build the EMISSION ORDER (§11 Phase 3c). Baseline membership+order comes from
 * the request view (owned path) or the store (control default); `placement`
 * overrides re-splice members, and ADDED frames (origin "added") are members of
 * EVERY emission — membership by user op, the one deliberate extension beyond
 * what the request carried (the 2.7 guardrail reserved exactly this).
 *
 * Deterministic anchor-absence rules (reviewer RC3):
 *  - a MOVED member whose `after` anchor is not emitting keeps its natural
 *    baseline position (membership is never created by `move`);
 *  - an ADDED frame whose anchor is not emitting is placed after the nearest
 *    PRECEDING store-order frame that is emitting, or at the start if none.
 * Siblings placed after the same anchor emit in store order; chains resolve
 * recursively; a placement cycle appends its frames at the end in store order
 * and surfaces a structure warning — never silent.
 */
function buildEmissionOrder(
  members: Frame[],
  allFrames: Frame[],
): { ordered: Frame[]; warnings: StructureWarning[] } {
  const storeIndex = new Map(allFrames.map((f, i) => [f.id, i]));
  const byStoreOrder = (a: Frame, b: Frame) =>
    (storeIndex.get(a.id) ?? 0) - (storeIndex.get(b.id) ?? 0);

  // Partition: base (natural order) vs placed (re-spliced). Added frames are
  // always placed members regardless of path (the view never contains them;
  // the full-store baseline does — excluded here, injected as placed).
  let base: Frame[] = [];
  const placed: Frame[] = [];
  const memberIds = new Set(members.map((m) => m.id));
  for (const m of members) {
    if (m.origin === "added") continue;
    if (m.origin === "combined" && m.placement) continue; // F-047: injected below
    if (m.placement) placed.push(m);
    else base.push(m);
  }
  for (const a of allFrames) {
    if (a.deleted) continue;
    if (a.origin === "added") {
      placed.push(a);
      continue;
    }
    // F-047: a combined frame with EXPLICIT placement emits via this splice
    // (resolution at the part slots skips it — see resolve()). Placement is
    // an ORDERING override, not membership creation (the move precedent):
    // inject only when a live part is a member of this emission — or when
    // the combined frame is itself a member (full-store mode).
    if (a.origin === "combined" && a.placement) {
      if (memberIds.has(a.id) || members.some((m) => m.absorbedInto === a.id)) {
        placed.push(a);
      }
    }
  }
  placed.sort(byStoreOrder);

  const emitting = new Set([...base.map((f) => f.id), ...placed.map((f) => f.id)]);

  // Resolve each placed frame's effective anchor.
  const startBucket: Frame[] = [];
  const afterBucket = new Map<string, Frame[]>();
  const memberFallback = new Set<string>();
  for (const p of placed) {
    let after = p.placement?.after ?? null;
    if (after !== null && (!emitting.has(after) || after === p.id)) {
      // F-047: placed combined frames take the added-frame fallback (nearest
      // preceding emitting frame) — they are not members, so the member
      // natural-order fallback would silently drop them.
      if (p.origin !== "added" && p.origin !== "combined") {
        memberFallback.add(p.id); // moved member, absent anchor → natural order
        continue;
      }
      // Added frame, absent anchor → nearest preceding emitting store-order frame.
      let idx = (storeIndex.get(after) ?? 0) - 1;
      let found: string | null = null;
      while (idx >= 0) {
        const cand = allFrames[idx]!;
        if (emitting.has(cand.id) && cand.id !== p.id) {
          found = cand.id;
          break;
        }
        idx--;
      }
      after = found;
    }
    if (after === null) startBucket.push(p);
    else {
      const arr = afterBucket.get(after) ?? [];
      arr.push(p);
      afterBucket.set(after, arr);
    }
  }
  if (memberFallback.size > 0) {
    // Rebuild base in member order with the fallback members back in place.
    base = members.filter(
      (m) => m.origin !== "added" && (!m.placement || memberFallback.has(m.id)),
    );
  }

  const ordered: Frame[] = [];
  const emittedIds = new Set<string>();
  const emitWithDependents = (f: Frame) => {
    if (emittedIds.has(f.id)) return;
    emittedIds.add(f.id);
    ordered.push(f);
    for (const dep of afterBucket.get(f.id) ?? []) emitWithDependents(dep);
  };
  for (const f of startBucket) emitWithDependents(f);
  for (const f of base) emitWithDependents(f);

  const warnings: StructureWarning[] = [];
  const leftovers = placed.filter((f) => !emittedIds.has(f.id)).sort(byStoreOrder);
  if (leftovers.length > 0) {
    warnings.push({
      kind: "placement-cycle",
      detail: `placement cycle: ${leftovers.map((f) => f.id).join(", ")} appended in store order`,
    });
    for (const f of leftovers) emitWithDependents(f);
  }
  return { ordered, warnings };
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
  const visibleMembers = view
    ? view.frameIds
        .map((id) => byId.get(id))
        // Defensive: view ids always resolve today (frames are tombstoned, never
        // removed) — the filter simply makes a future removal op fail safe.
        .filter((f): f is Frame => f !== undefined && !f.deleted)
    : frames.filter((f) => !f.deleted);

  // Emission order (§11 Phase 3c): baseline membership+order from the view (or
  // store), placement overrides re-spliced, added frames injected (membership
  // by user op). Deterministic; anomalies surface as structureWarnings.
  const { ordered, warnings } = buildEmissionOrder(visibleMembers, frames);
  const structureWarnings = [...warnings];

  // Structural resolution (§11 Phase 3c, Appendix C's many-to-many emission as
  // indirection): an absorbed part resolves to its combined frame (emitted ONCE,
  // at the first part's slot); a split original resolves to its children, in
  // order. Combined frames / children are ordinary frames and may themselves be
  // absorbed/split — recursion with a depth guard (ops prevent cycles; the
  // guard surfaces rather than hangs if state is ever corrupted). Deleted wins
  // at every layer: a deleted absorber/child emits nothing.
  const emitted: Frame[] = [];
  const seen = new Set<string>();
  const resolve = (f: Frame | undefined, depth: number) => {
    if (!f || f.deleted || seen.has(f.id)) return;
    if (depth > 16) {
      structureWarnings.push({
        kind: "resolution-depth",
        detail: `resolution depth exceeded at ${f.id} — emitting nothing for this chain`,
      });
      return;
    }
    if (f.absorbedInto) {
      const absorber = byId.get(f.absorbedInto);
      // F-047: an absorber with EXPLICIT placement emits via the placement
      // splice (buildEmissionOrder injected it) — never at a part's slot.
      if (absorber?.placement) return;
      resolve(absorber, depth + 1);
      return;
    }
    if (f.splitInto && f.splitInto.length > 0) {
      seen.add(f.id);
      for (const cid of f.splitInto) resolve(byId.get(cid), depth + 1);
      return;
    }
    seen.add(f.id);
    emitted.push(f);
  };
  for (const m of ordered) resolve(m, 0);
  const emittedFrameIds = emitted.map((f) => f.id);

  // Representation resolution (§5.C / §11 Phase 3a): each member emits its
  // override when one is set (edit/compact), else its source messages. The store
  // supplies REPRESENTATION; the view supplied MEMBERSHIP above.
  const resolved = stripCacheControlDeep(
    emitted.flatMap((f) => f.representation ?? f.messages),
  );

  // §5.F structural sweep (§11 Phase 3a): free editing can leave the resolved
  // payload provider-invalid (orphaned tool pairs, role-grammar artifacts);
  // sweep it into a valid shape — projection-time only, loudly surfaced.
  const { messages, repairs: wireRepairs } = sweepWire(resolved);

  // Wire-integrity (§11 Phase 2.6): DETECT facially-suspect blocks (e.g. empty
  // thinking husks) on what is actually emitted and surface them — content is
  // never altered (the sweep above is structural grammar only).
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

  return {
    body,
    headHash,
    hasCacheBreakpoint: placed,
    wireWarnings,
    wireRepairs,
    structureWarnings,
    emittedFrameIds,
  };
}
