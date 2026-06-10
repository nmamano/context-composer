// Response capture (design decision C).
//
// The proxy tees the upstream response: one branch streams byte-for-byte to the
// caller (true passthrough), the other is read here to reconstruct the assistant
// message so it can be captured as a frame. Token/usage accounting is intentionally
// NOT part of identity or output.
//
// FIDELITY RULE (§11 Phase 2.6 live finding): the captured assistant must equal what the
// wrapped agent will RESEND next turn, or reconcile sees two different turns. That
// includes thinking blocks: we accumulate `thinking_delta` and `signature_delta`
// (and keep `redacted_thinking` blocks, which arrive complete in their start event).
// An earlier version ignored those deltas, so capture fabricated UNSIGNED empty
// thinking husks — invalid blocks the agent never sent. Capturing reasoning here is
// reconcile-correctness, not a display feature.
//
// Both transports are handled: streaming SSE and a plain JSON response (agents
// toggle `stream`), through one capture shape.

import type { Block, WireMessage } from "./types.ts";

export interface CapturedAssistant {
  message: WireMessage; // { role: "assistant", content: Block[] }
  stopReason: string | null;
}

interface PartialBlock {
  block: Block;
  partialJson: string; // accumulates input_json_delta for tool_use blocks
}

/** Reconstruct from an Anthropic SSE event stream (raw text of the stream). */
export function reconstructFromSSE(raw: string): CapturedAssistant {
  const blocks: PartialBlock[] = [];
  let stopReason: string | null = null;

  for (const chunk of raw.split("\n\n")) {
    const dataLines = chunk
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("");
    if (payload === "[DONE]") continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload);
    } catch {
      continue; // ignore non-JSON keep-alives
    }

    switch (evt.type) {
      case "content_block_start": {
        const index = evt.index as number;
        const cb = structuredClone(evt.content_block) as Block;
        if (cb.type === "tool_use") cb.input = cb.input ?? {};
        if (cb.type === "text") cb.text = cb.text ?? "";
        if (cb.type === "thinking") cb.thinking = cb.thinking ?? "";
        blocks[index] = { block: cb, partialJson: "" };
        break;
      }
      case "content_block_delta": {
        const index = evt.index as number;
        const delta = evt.delta as Record<string, unknown>;
        const slot = blocks[index];
        if (!slot) break;
        if (delta.type === "text_delta") {
          slot.block.text = ((slot.block.text as string) ?? "") + (delta.text as string);
        } else if (delta.type === "input_json_delta") {
          slot.partialJson += (delta.partial_json as string) ?? "";
        } else if (delta.type === "thinking_delta") {
          slot.block.thinking =
            ((slot.block.thinking as string) ?? "") + (delta.thinking as string);
        } else if (delta.type === "signature_delta") {
          slot.block.signature =
            ((slot.block.signature as string) ?? "") + (delta.signature as string);
        }
        break;
      }
      case "content_block_stop": {
        const index = evt.index as number;
        const slot = blocks[index];
        if (slot && slot.block.type === "tool_use" && slot.partialJson) {
          try {
            slot.block.input = JSON.parse(slot.partialJson);
          } catch {
            /* leave input as-is on malformed json */
          }
        }
        break;
      }
      case "message_delta": {
        const delta = evt.delta as Record<string, unknown> | undefined;
        if (delta && typeof delta.stop_reason !== "undefined") {
          stopReason = (delta.stop_reason as string) ?? null;
        }
        break;
      }
      default:
        break;
    }
  }

  const content = blocks.filter(Boolean).map((b) => b.block);
  return { message: { role: "assistant", content }, stopReason };
}

/** Reconstruct from a non-streaming JSON message response. */
export function reconstructFromJSON(json: Record<string, unknown>): CapturedAssistant {
  const content = (Array.isArray(json.content) ? json.content : []) as Block[];
  return {
    message: { role: "assistant", content },
    stopReason: (json.stop_reason as string) ?? null,
  };
}
