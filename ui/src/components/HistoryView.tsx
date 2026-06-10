// History tab (§8 operation/history panel, single-branch tracer form; §11
// Phase 5c): commits | timeline sub-toggle. Commit cards carry type + note +
// affected frames (links select EXISTING frames into the details panel; ids
// without a loaded frame render inert — the daemon is the authority) + a
// collapsed two-column before/after diff + remaining params. EVERY card offers
// revert — already-reverted commits and revert commits included: the marking
// is derived display state, and the daemon's refusal catalog must stay
// reachable (the guards speak).

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
  onSelectFrame: (id: string) => void;
}) {
  const rows = commitRows(props.commits);
  const evRows = eventRows(props.events);
  return (
    <section className="history-view" aria-label="history view">
      <div className="history-subtoggle" role="tablist">
        <button
          role="tab"
          aria-selected={props.subView === "commits"}
          className={props.subView === "commits" ? "on" : ""}
          onClick={() => props.onSubView("commits")}
        >
          commits ({rows.length})
        </button>
        <button
          role="tab"
          aria-selected={props.subView === "timeline"}
          className={props.subView === "timeline" ? "on" : ""}
          onClick={() => props.onSubView("timeline")}
        >
          timeline ({evRows.length})
        </button>
      </div>

      {props.subView === "commits" ? (
        rows.length === 0 ? (
          <p className="empty">no commits yet — ops record here</p>
        ) : (
          // Newest first: the op you just ran is the one you look for.
          [...rows].reverse().map((c) => (
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
        [...evRows].reverse().map((e) => (
          <article key={e.id} data-event-id={e.id} className="event-row">
            <span className="event-id">{e.id}</span>
            <span className={`event-type event-type-${e.type}`}>{e.type}</span>
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
            {e.commitId && <span className="event-commit">{e.commitId}</span>}
            <span className="event-ts">{e.timestamp}</span>
          </article>
        ))
      )}
    </section>
  );
}
