// Decompose a rendered /v1/messages body into frames (design.md §2.1, Appendix B).
//
// - The non-conversational head (system + tools) is carved off separately; the
//   FrameStore turns it into the single preamble frame (§2.7 — it's just a frame).
// - The `messages` array is grouped into logical turn frames by the peer-agreed
//   rule (decision B):
//     * a user-role message whose content is ENTIRELY tool_result blocks is a
//       continuation of the open frame (the tool loop, §2.1 — tool calls/results
//       bundle into the same frame);
//     * any other user message opens a new frame;
//     * assistant messages attach to the open frame.
// - Agent-injected `system`-role entries inside `messages` (the spike's injected
//   block, decision F) are NOT turn frames: Anthropic's `messages` array only allows
//   user/assistant, so forwarding a `system` role would be invalid. We lift them into
//   the head (`injectedSystem`), in order, to be folded into the preamble at compose.

import type { Block, DecomposedFrame, RequestEnvelope, WireMessage } from "./types.ts";
import { fingerprintMessage } from "./fingerprint.ts";

function isAllToolResult(content: string | Block[]): boolean {
  if (typeof content === "string") return false;
  return content.length > 0 && content.every((b) => (b as Block).type === "tool_result");
}

function toBlocks(content: string | Block[]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function toFrame(messages: WireMessage[]): DecomposedFrame {
  const opener = messages[0]!;
  return {
    anchorFp: fingerprintMessage(opener),
    role: opener.role,
    messages,
  };
}

export interface Decomposed {
  system: string | Block[] | undefined;
  tools: Block[] | undefined;
  /** Agent-injected system-role blocks lifted out of `messages`, in order. */
  injectedSystem: Block[];
  /** Runtime knobs preserved verbatim (model, max_tokens, temperature, stream, …). */
  envelope: RequestEnvelope;
  frames: DecomposedFrame[];
}

export function decompose(body: Record<string, unknown>): Decomposed {
  const { system, tools, messages, ...envelope } = body;
  const msgs = (Array.isArray(messages) ? messages : []) as Array<
    WireMessage | { role: string; content: string | Block[] }
  >;

  const frames: DecomposedFrame[] = [];
  const injectedSystem: Block[] = [];
  let current: WireMessage[] | null = null;

  for (const m of msgs) {
    // Lift injected system-role entries to the head (never a turn frame).
    if (m.role === "system") {
      injectedSystem.push(...toBlocks(m.content));
      continue;
    }
    const msg = m as WireMessage;
    // Inline condition (not an intermediate boolean) so TS narrows `current` in else.
    if (current === null || (msg.role === "user" && !isAllToolResult(msg.content))) {
      if (current) frames.push(toFrame(current));
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current) frames.push(toFrame(current));

  return {
    system: system as string | Block[] | undefined,
    tools: tools as Block[] | undefined,
    injectedSystem,
    envelope: envelope as RequestEnvelope,
    frames,
  };
}
