// Offload rendering (§5.D, §11 Phase 3b).
//
// The artifact file is a deterministic, role-labeled markdown rendering of the
// frame's PRE-OFFLOAD EMISSION (representation ?? messages — what the model was
// seeing, not necessarily the source). The STORE remains the durable truth; the
// file exists so the wrapped agent can retrieve the content on demand with its
// own file-read tool (provider assumption 5) — no bespoke fetch mechanism.
//
// Determinism matters twice: (a) the artifact filename embeds a content hash, so
// identical content re-offloads to the identical path (idempotent) while changed
// content gets a NEW file — a committed fileReference keeps pointing at the bytes
// rendered for THAT offload forever (append-only revert semantics, reviewer
// invariant); (b) byte-stable rendering keeps tests and diffs honest.

import type { Block, WireMessage } from "./types.ts";

function blockToMarkdown(b: Block): string {
  if (b.type === "text" && typeof b.text === "string") return b.text;
  if (b.type === "tool_use") {
    return `[tool_use ${String(b.id)} ${String(b.name)}]\n\`\`\`json\n${JSON.stringify(b.input)}\n\`\`\``;
  }
  if (b.type === "tool_result") {
    const content =
      typeof b.content === "string" ? b.content : JSON.stringify(b.content);
    return `[tool_result ${String(b.tool_use_id)}]\n${content}`;
  }
  // Unknown block types render as canonical JSON — total, never throws.
  return `[${String(b.type)}]\n\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
}

/** Render a frame's emitted messages as readable markdown. Pure + deterministic. */
export function renderFrameMarkdown(
  frameId: string,
  title: string,
  emission: WireMessage[],
): string {
  const parts: string[] = [`# Offloaded frame ${frameId} — ${title}`, ""];
  for (const m of emission) {
    parts.push(`## ${m.role}`, "");
    if (typeof m.content === "string") {
      parts.push(m.content, "");
    } else {
      for (const b of m.content) parts.push(blockToMarkdown(b), "");
    }
  }
  return parts.join("\n");
}

/** Deterministic summary fallback (no LLM in 3b): the first text content's first
 *  line, truncated; null when the emission has no text at all (caller falls back
 *  to `offloaded frame <id>`). */
export function deriveSummary(emission: WireMessage[]): string | null {
  for (const m of emission) {
    if (typeof m.content === "string") {
      const line = m.content.split("\n")[0]!.trim();
      if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text" && typeof b.text === "string") {
        const line = b.text.split("\n")[0]!.trim();
        if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
      }
    }
  }
  return null;
}
