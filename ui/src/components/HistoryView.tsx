// History tab (§8 operation/history panel, single-branch tracer form; §11
// Phase 5c): commits | timeline sub-toggle. Commit cards carry type + note +
// affected frames (links select EXISTING frames into the details panel; ids
// without a loaded frame render inert — the daemon is the authority) + a
// collapsed two-column before/after diff + remaining params. EVERY card offers
// revert — already-reverted commits and revert commits included: the marking
// is derived display state, and the daemon's refusal catalog must stay
// reachable (the guards speak).
// F-049: both lists grow DOWNWARD (oldest top, newest bottom) like the other
// views; the scroller opens at the bottom and a discreet ↓ jumps to latest
// (the F-020 pattern). Order is derived display state; the log is the truth.

import { useEffect, useRef } from "react";
import type { Frame } from "../../../src/engine/types.ts";
import type { PublicCommit, PublicEvent } from "../api.ts";
import { commitRows, eventRows } from "../history.ts";

export type HistorySubView = "commits" | "timeline";

function FrameLink(props: {
  id: string;
  known: boolean;
  onSelect: (id: string) => void;
}) {
  if (!props.known) return <span className="frame-link unknown">{props.id}</span>;
  return (
    <button className="frame-link" onClick={() => props.onSelect(props.id)}>
      {props.id}
    </button>
  );
}

export function HistoryView(props: {
  commits: PublicCommit[];
  events: PublicEvent[];
  details: ReadonlyMap<string, Frame>;
  subView: HistorySubView;
  onSubView: (v: HistorySubView) => void;
  onRevert: (commitId: string) => void;
  /** F-046: revert-last lives HERE (it undoes the newest entry in the list
   *  below, not the latest frame) — moved out of the frames toolbar (Nil).
   *  Same registry verb, same route, `{}` body = HEAD; placement only. */
  onRevertLast: () => void;
  onSelectFrame: (id: string) => void;
}) {
  const rows = commitRows(props.commits);
  const evRows = eventRows(props.events);
  const scrollRef = useRef<HTMLDivElement>(null);
  // F-049: open at the newest entry (bottom). Re-snaps when the sub-view
  // switches (different list, same intent); never fights scrolling afterwards.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.subView]);
  return (
    <section className="history-view" aria-label="history view">
      {/* F-026: a FIXED sub-nav — the toggle row sits OUTSIDE the scroll area
          (entries scroll in .history-scroll below), so it never moves and
          nothing can pass it. Replaces the F-019 sticky-backdrop approach. */}
      <div className="history-subtoggle-row">
      <div className="history-subtoggle" role="tablist">
        <button
          role="tab"
          aria-selected={props.subView === "commits"}
          className={props.subView === "commits" ? "on" : ""}
          data-tip="changes you've made, with before/after — click revert to undo one"
          onClick={() => props.onSubView("commits")}
        >
          commits ({rows.length})
        </button>
        <button
          role="tab"
          aria-selected={props.subView === "timeline"}
          className={props.subView === "timeline" ? "on" : ""}
          data-tip="everything that happened in this conversation, in order"
          onClick={() => props.onSubView("timeline")}
        >
          timeline ({evRows.length})
        </button>
      </div>
      <button
        className="op-revert"
        data-tip="undo the latest change — same as undoing the newest entry below"
        onClick={() => props.onRevertLast()}
      >
        revert last
      </button>
      </div>

      <div className="history-scroll" ref={scrollRef}>
      {props.subView === "commits" ? (
        rows.length === 0 ? (
          <p className="empty">no commits yet — ops record here</p>
        ) : (
          // F-049: chronological — newest at the bottom, like every other view.
          rows.map((c) => (
            <article
              key={c.id}
              data-commit-id={c.id}
              className={`commit-card ${c.reverted ? "is-reverted" : ""}`}
            >
              <header>
                <span className="commit-id">{c.id}</span>
                <span className={`commit-type commit-type-${c.type}`}>{c.type}</span>
                {c.reverted && <span className="chip chip-reverted">reverted</span>}
                <span className="commit-ts">{c.timestamp}</span>
                <button
                  className="commit-revert"
                  data-commit-id={c.id}
                  data-tip="undo this change"
                  onClick={() => props.onRevert(c.id)}
                >
                  revert
                </button>
              </header>
              {c.note && <p className="commit-note">{c.note}</p>}
              {c.affectedFrameIds.length > 0 && (
                <p className="commit-frames">
                  frames:{" "}
                  {c.affectedFrameIds.map((id) => (
                    <FrameLink
                      key={id}
                      id={id}
                      known={props.details.has(id)}
                      onSelect={props.onSelectFrame}
                    />
                  ))}
                </p>
              )}
              {c.diff && (
                <details className="commit-diff">
                  <summary>diff (before ⇄ after)</summary>
                  <div className="diff-columns">
                    <pre className="diff-before">{c.diff.before}</pre>
                    <pre className="diff-after">{c.diff.after}</pre>
                  </div>
                </details>
              )}
              {c.paramsText && (
                <details className="commit-params">
                  <summary>params</summary>
                  <pre>{c.paramsText}</pre>
                </details>
              )}
            </article>
          ))
        )
      ) : evRows.length === 0 ? (
        <p className="empty">no events yet</p>
      ) : (
        evRows.map((e) => (
          <article key={e.id} data-event-id={e.id} className="event-row">
            <span className="event-id">{e.id}</span>
            <span
              className={`event-type event-type-${e.type}`}
              // F-050/F-052: non-obvious types explain themselves in plain
              // words — enriched, and the two capture subtypes the daemon
              // reports (Nil). Legacy capture events without a direction
              // render exactly as before (no tip, no suffix).
              data-tip={
                e.type === "enriched"
                  ? "a title and summary were written for this frame automatically"
                  : e.direction === "request"
                    ? "the app sent the conversation to the model — anything new or changed is recorded here"
                    : e.direction === "reply"
                      ? "the model's answer arrived and was added to the frame"
                      : undefined
              }
            >
              {e.type}
            </span>
            {e.direction && (
              <span className={`event-direction event-direction-${e.direction}`}>
                {e.direction}
              </span>
            )}
            <span className="event-frames">
              {e.frameIds.map((id) => (
                <FrameLink
                  key={id}
                  id={id}
                  known={props.details.has(id)}
                  onSelect={props.onSelectFrame}
                />
              ))}
            </span>
            {/* F-050: render the event's own note (e.g. how a frame was
                enriched) — the daemon reports it; the view must not drop it. */}
            {e.note && <span className="event-note">{e.note}</span>}
            {e.commitId && <span className="event-commit">{e.commitId}</span>}
            <span className="event-ts">{e.timestamp}</span>
          </article>
        ))
      )}
      <button
        type="button"
        className="jump-bottom"
        aria-label="scroll to latest entry"
        data-tip="jump to the latest entry"
        onClick={() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }}
      >
        ↓
      </button>
      </div>
    </section>
  );
}
