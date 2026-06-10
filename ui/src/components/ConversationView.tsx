// Conversation view (§4) — the chat rendering of the engine's current emission.
// Deleted frames are hidden here BY CONSTRUCTION (the engine's emittedFrameIds
// already exclude tombstones); tool traffic renders as plain collapsed blocks
// (no permission/question widgets — §4/§9). Clicking a bubble selects its frame
// (the bridge into the details panel / frame view).

import type { Frame } from "../../../src/engine/types.ts";
import { assembleTranscript, type TranscriptBlock } from "../transcript.ts";

function BlockBody({ block }: { block: TranscriptBlock }) {
  if (block.kind === "text") {
    return <p className="block-text">{block.text}</p>;
  }
  return (
    <details className={`block-collapsed ${block.kind}`}>
      <summary>{block.label}</summary>
      <pre>{block.text}</pre>
    </details>
  );
}

export function ConversationView(props: {
  emittedFrameIds: string[];
  details: ReadonlyMap<string, Frame>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const entries = assembleTranscript(props.emittedFrameIds, props.details);
  if (entries.length === 0) {
    return <p className="empty">nothing emitted yet</p>;
  }
  return (
    <section className="conversation-view" aria-label="conversation view">
      {entries.map((e, i) => (
        <article
          key={`${e.frameId}-${i}`}
          data-frame-id={e.frameId}
          className={`bubble ${e.role} ${props.selectedId === e.frameId ? "selected" : ""}`}
          title={`${e.frameTitle} (${e.frameId})`}
          onClick={() => props.onSelect(e.frameId)}
        >
          <span className="bubble-role">{e.role}</span>
          {e.blocks.map((b, j) => (
            <BlockBody key={j} block={b} />
          ))}
        </article>
      ))}
    </section>
  );
}
