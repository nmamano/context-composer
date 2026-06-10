// Compose-time wire-integrity DETECTION (design.md §5.F, §11 Phase 2.6).
//
// Compose is FAITHFUL: nothing is added to or removed from the model's context
// except the user's explicit edits. This module only *detects* blocks that look
// provider-invalid and surfaces them (compose result → control API, wiretap,
// stderr) — it never alters the wire.
//
// History (recorded so the repair idea doesn't get re-invented): an earlier
// Phase 2.6 draft DROPPED empty thinking husks ({thinking:"", signature}) at
// compose time, on the theory that our re-serialization invalidated their
// signatures. Live evidence killed that theory: once compose was actually
// faithful (no conversation merging, no duplicated turns, no capture-fabricated
// unsigned husks), a real interactive session carried multiple agent-signed
// empty husks through our full rewrite — canonical re-serialization,
// cache_control ownership and all — and the API accepted every request. The
// rejections that motivated the sweep were caused by OUR corruption, not by the
// husks. The sweep was deleted; detection remains because an UNSIGNED empty
// husk on the wire would indicate a capture bug on our side (the agent never
// produces them), and that must be loud.
//
// §11 Phase 3a adds the §5.F STRUCTURAL SWEEP alongside detection. The boundary
// (locked, the 2.6 evidence rule): the sweep repairs structural GRAMMAR only —
// tool_use/tool_result pairing and role ordering — never content. Facial content
// suspicion (thinking husks) stays detect-only above. The sweep exists so free
// editing stays free: the user may mutate frames into any intermediate state and
// compose still emits a provider-valid request (validity is a constraint; the
// store loses nothing — repairs are projection-time only and always SURFACED via
// ComposeResult.wireRepairs, never silent). In practice the agent's own resend
// is structurally valid, so repairs fire only on user-op-induced states.

import type { Block, WireMessage } from "./types.ts";

/** A `thinking` block whose `thinking` text is missing, non-string, or blank.
 *  `redacted_thinking` (a different type, no `thinking` field) is NOT matched. */
function isEmptyThinking(block: Block): boolean {
  if (block.type !== "thinking") return false;
  const text = block.thinking;
  return typeof text !== "string" || text.trim() === "";
}

/** One facially-suspect block found in the composed messages. */
export interface WireWarning {
  issue: "empty-thinking";
  messageIndex: number;
  blockIndex: number;
  /** Signed husks are normal agent behavior (live-verified as accepted by the
   *  provider). An UNSIGNED husk would mean we fabricated it — a proxy bug. */
  signed: boolean;
}

/** Detect suspect blocks WITHOUT changing anything. Always runs at compose
 *  time; the result is surfaced, never silently acted on. */
export function detectWireIssues(messages: WireMessage[]): WireWarning[] {
  const warnings: WireWarning[] = [];
  messages.forEach((m, mi) => {
    if (m.role !== "assistant" || typeof m.content === "string") return;
    m.content.forEach((b, bi) => {
      if (isEmptyThinking(b)) {
        warnings.push({
          issue: "empty-thinking",
          messageIndex: mi,
          blockIndex: bi,
          signed: typeof b.signature === "string" && b.signature.length > 0,
        });
      }
    });
  });
  return warnings;
}

// ── §5.F structural sweep (§11 Phase 3a) ────────────────────────────────────

/** One projection-time repair the sweep applied to the emitted messages. The
 *  store is untouched; repairs are surfaced (control API, wiretap, stderr) so
 *  they are never silent. */
export interface WireRepair {
  kind:
    | "orphan-tool-use" // tool_use with no tool_result anywhere after it
    | "orphan-tool-result" // tool_result with no preceding tool_use
    | "empty-message" // message left with no content (by edits or block drops)
    | "merged-same-role" // adjacent same-role messages merged into one
    | "leading-assistant"; // assistant message(s) before any user turn, dropped
  detail: string;
}

function toBlocks(content: string | Block[]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/**
 * Sweep the EMITTED messages into a provider-valid shape (§5.F: "compose must
 * emit a provider-valid request unconditionally" — the single place that
 * guarantees validity, so no individual op needs guard rails). Structural
 * grammar only; content is never inspected or altered:
 *
 *  1. drop tool_use blocks whose id has no tool_result later in the emission,
 *     and tool_result blocks whose id has no earlier tool_use (the firm
 *     Anthropic pairing constraint, both directions);
 *  2. drop messages left with empty content;
 *  3. drop leading assistant message(s) — a conversation must open with user;
 *  4. merge adjacent same-role runs (non-lossy: contents concatenate).
 *
 * Returns the swept messages plus the repair list. No repairs → the input
 * array is returned unchanged (byte-stable for the cache determinism story).
 */
export function sweepWire(messages: WireMessage[]): {
  messages: WireMessage[];
  repairs: WireRepair[];
} {
  const repairs: WireRepair[] = [];

  // Pass 0: SEQUENTIAL pair matching — a tool block survives only as one half
  // of a confirmed (use, later result) pair. Walking in order with a pending-use
  // FIFO is what makes retention depend on a SURVIVING counterpart: a result
  // with no pending use is an orphan even if a use with that id appears later,
  // and that later use is then an orphan too (a global id-set lookup gets this
  // wrong — reviewer-caught). Duplicate ids match one-to-one in order.
  // Position-exact adjacency (result in the immediately-next message) is not
  // enforced — bundled frames make cross-frame pairs structurally impossible
  // today; the live gates will say if the provider wants more.
  const key = (mi: number, bi: number) => `${mi}:${bi}`;
  const dropBlocks = new Set<string>();
  const pendingUses = new Map<string, Array<{ mi: number; bi: number }>>();
  messages.forEach((m, mi) => {
    if (typeof m.content === "string") return;
    m.content.forEach((b, bi) => {
      if (b.type === "tool_use" && typeof b.id === "string") {
        // Tentatively orphaned until a later result confirms the pair.
        dropBlocks.add(key(mi, bi));
        const q = pendingUses.get(b.id) ?? [];
        q.push({ mi, bi });
        pendingUses.set(b.id, q);
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const q = pendingUses.get(b.tool_use_id);
        const use = q?.shift();
        if (use) {
          dropBlocks.delete(key(use.mi, use.bi)); // pair confirmed — keep both
        } else {
          dropBlocks.add(key(mi, bi));
          repairs.push({
            kind: "orphan-tool-result",
            detail: `dropped tool_result ${b.tool_use_id} (no preceding tool_use in emission)`,
          });
        }
      }
    });
  });
  for (const q of pendingUses.values()) {
    for (const use of q) {
      const b = (messages[use.mi]!.content as Block[])[use.bi]!;
      repairs.push({
        kind: "orphan-tool-use",
        detail: `dropped tool_use ${b.id} (no paired tool_result after it in emission)`,
      });
    }
  }

  // Pass 1: rebuild messages without the dropped blocks; drop emptied messages.
  let out: WireMessage[] = [];
  messages.forEach((m, mi) => {
    if (typeof m.content === "string") {
      out.push(m);
      return;
    }
    const kept = m.content.filter((_, bi) => !dropBlocks.has(key(mi, bi)));
    if (kept.length === 0) {
      repairs.push({ kind: "empty-message", detail: `dropped empty ${m.role} message` });
      return;
    }
    out.push(kept.length === m.content.length ? m : { ...m, content: kept });
  });

  // Pass 2: drop leading assistant run (a request must open with a user turn).
  while (out.length > 0 && out[0]!.role === "assistant") {
    repairs.push({
      kind: "leading-assistant",
      detail: "dropped assistant message before any user turn",
    });
    out = out.slice(1);
  }

  // Pass 3: merge adjacent same-role runs (non-lossy concatenation; string
  // content normalizes to a text block only when a merge actually happens).
  const merged: WireMessage[] = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      repairs.push({
        kind: "merged-same-role",
        detail: `merged adjacent ${m.role} messages`,
      });
      merged[merged.length - 1] = {
        role: prev.role,
        content: [...toBlocks(prev.content), ...toBlocks(m.content)],
      };
    } else {
      merged.push(m);
    }
  }

  return repairs.length === 0 ? { messages, repairs } : { messages: merged, repairs };
}
