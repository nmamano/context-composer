// Conversation view (§4) — the chat rendering of the engine's current emission.
// Deleted frames are hidden here BY CONSTRUCTION (the engine's emittedFrameIds
// already exclude tombstones); tool traffic renders as plain collapsed blocks
// (no permission/question widgets — §4/§9). Clicking a bubble selects its frame
// (the bridge into the details panel / frame view).

import { useEffect, useRef } from "react";
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
  const sectionRef = useRef<HTMLElement>(null);
  // F-018/F-020 (plans/ui-feedback.md): on ENTERING the view (it remounts on
  // every tab switch), jump to the selected frame's first bubble; with no
  // selection (or a selection not in the emission), start at the bottom —
  // the most recent activity. Mount-only by design: deliberately unclever,
  // never fights the user's scrolling afterwards (Nil: don't overengineer).
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    // Engine ids are plain [a-z0-9]+ (t1, p0, …) — no selector escaping needed.
    const target = props.selectedId
      ? el.querySelector(`[data-frame-id="${props.selectedId}"]`)
      : null;
    if (target && typeof (target as HTMLElement).scrollIntoView === "function") {
      (target as HTMLElement).scrollIntoView({ block: "center" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only jump
  }, []);
  if (entries.length === 0) {
    return <p className="empty">nothing emitted yet</p>;
  }
  return (
    <section
      ref={sectionRef}
      className="conversation-view"
      aria-label="conversation view"
    >
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
      {/* F-020: discreet jump-to-latest (sticky, bottom-right). */}
      <button
        type="button"
        className="jump-bottom"
        aria-label="scroll to latest turn"
        data-tip="jump to the latest message"
        onClick={() => {
          const el = sectionRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }}
      >
        ↓
      </button>
    </section>
  );
}
