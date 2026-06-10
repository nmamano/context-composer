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
// The planned §5.F sweep for USER-EDIT-induced invalidity (orphaned
// tool_use/tool_result after edit/delete) is a different category — rendering a
// user's edit faithfully is the product working — and lands with Phase 3a.

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
