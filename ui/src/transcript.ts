// Transcript assembly — PURE functions, no React, no fetch (the §8 unit boundary).
//
// The conversation view is the engine's CURRENT EMISSION rendered as chat:
//   - MEMBERSHIP + ORDER come from compose's emittedFrameIds (the engine already
//     omitted tombstones, resolved placement, absorption and splits) — the UI
//     never re-decides which frames emit or where.
//   - CONTENT per frame is the frame's current representation when one exists,
//     otherwise its source messages (`representation ?? messages` — the same rule
//     compose applies; offload stubs ARE representations, so offloaded frames
//     show their stub here and their source in the details panel).
// Deleted frames are therefore hidden in this view by construction (the engine
// excludes tombstones from emission); the frame view shows them, flagged — that
// asymmetry is the §4 design.

import type { Frame, WireMessage, Block } from "../../src/engine/types.ts";

/** The slice of a show() payload the assembler reads. */
export type FrameContent = Pick<Frame, "id" | "kind" | "title" | "messages"> &
  Partial<Pick<Frame, "representation">>;

export interface TranscriptBlock {
  kind: "text" | "tool_use" | "tool_result" | "other";
  /** Collapsed-block label for non-text kinds; null for plain text. */
  label: string | null;
  text: string;
}

export interface TranscriptEntry {
  frameId: string;
  frameTitle: string;
  role: "user" | "assistant";
  blocks: TranscriptBlock[];
}

/** A frame's current emission: representation ?? messages. Exposed for the
 *  details panel's "current vs source" sections. */
export function currentEmission(f: FrameContent): WireMessage[] {
  return f.representation ?? f.messages;
}

function blockToTranscript(b: Block): TranscriptBlock {
  if (b.type === "text" && typeof b.text === "string") {
    return { kind: "text", label: null, text: b.text };
  }
  if (b.type === "tool_use") {
    return {
      kind: "tool_use",
      label: `tool_use · ${String(b.name ?? "?")}`,
      text: JSON.stringify(b.input ?? null, null, 2),
    };
  }
  if (b.type === "tool_result") {
    const content =
      typeof b.content === "string"
        ? b.content
        : JSON.stringify(b.content ?? null, null, 2);
    return {
      kind: "tool_result",
      label: `tool_result · ${String(b.tool_use_id ?? "?")}`,
      text: content,
    };
  }
  // Unknown block types render as labeled JSON — total, never throws (§9: blocks
  // are opaque to us; tool traffic passes through as plain collapsed blocks, §4).
  return {
    kind: "other",
    label: String(b.type ?? "unknown"),
    text: JSON.stringify(b, null, 2),
  };
}

export function messageBlocks(m: WireMessage): TranscriptBlock[] {
  if (typeof m.content === "string") {
    return [{ kind: "text", label: null, text: m.content }];
  }
  return m.content.map(blockToTranscript);
}

/**
 * Assemble the chat transcript: walk the engine's emission order, render each
 * emitted TURN frame's current emission. Ids without a loaded frame are skipped
 * (a refresh races a mutation — the next refetch settles it); the preamble never
 * chats (head representation, not a turn — and not in emission order anyway).
 */
export function assembleTranscript(
  emittedFrameIds: string[],
  byId: ReadonlyMap<string, FrameContent>,
): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const id of emittedFrameIds) {
    const f = byId.get(id);
    if (!f || f.kind !== "turn") continue;
    for (const m of currentEmission(f)) {
      out.push({
        frameId: f.id,
        frameTitle: f.title,
        role: m.role,
        blocks: messageBlocks(m),
      });
    }
  }
  return out;
}
