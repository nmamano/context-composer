// Frame view (§4/§8) — the manipulation surface, 5a read-only form: a LINEAR
// list of frame cards in store order (the SVG git-tree is parked until branches
// exist — Phase 4). Shows EVERYTHING list() returns, deleted/absorbed/split
// included, each flagged via the shared chip mapping; the op menu arrives in 5b.

import type { FrameSummary } from "../../../src/engine/state.ts";
import { frameFlags } from "../flags.ts";

export function FrameView(props: {
  frames: FrameSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (props.frames.length === 0) {
    return <p className="empty">no frames yet</p>;
  }
  return (
    <section className="frame-view" aria-label="frame view">
      {props.frames.map((f) => {
        const chips = frameFlags(f);
        return (
          <article
            key={f.id}
            data-frame-id={f.id}
            className={[
              "frame-card",
              f.kind,
              f.deleted ? "is-deleted" : "",
              props.selectedId === f.id ? "selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => props.onSelect(f.id)}
          >
            <header>
              <span className="frame-id">{f.id}</span>
              <span className="frame-title">{f.title}</span>
              <span className="frame-tokens">{f.tokenEstimate} tok</span>
            </header>
            {f.summary && <p className="frame-summary">{f.summary}</p>}
            {chips.length > 0 && (
              <ul className="chips">
                {chips.map((c) => (
                  <li key={c.key} className={`chip chip-${c.key}`}>
                    {c.label}
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </section>
  );
}
