// Frame view (§4/§8) — the manipulation surface. 5a: linear cards in store
// order, everything list() returns, flagged. 5b: each card hosts the op menu
// GENERATED from the shared registry, plus a combine selection mode. Ops are
// never hidden/disabled by frame STATE — the daemon's guards speak (reviewer
// condition); the SVG git-tree stays parked until branches exist (Phase 4).

import { Fragment, type ReactNode } from "react";
import type { FrameSummary } from "../../../src/engine/state.ts";
import type { OpSpec } from "../../../src/shared/ops.ts";
import { frameFlags } from "../flags.ts";
import { OpMenu } from "./OpMenu.tsx";

export function FrameView(props: {
  frames: FrameSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPickOp: (op: OpSpec, frameId: string) => void;
  combineMode: boolean;
  combineIds: string[];
  onToggleCombine: (id: string) => void;
  /** F-008: a pending frame-scoped op form renders INLINE, directly under the
   *  card it targets (App owns the form; this is just the placement slot). */
  opFormFrameId?: string | null;
  opForm?: ReactNode;
}) {
  if (props.frames.length === 0) {
    return <p className="empty">no frames yet</p>;
  }
  return (
    <section className="frame-view" aria-label="frame view">
      {props.frames.map((f) => {
        const chips = frameFlags(f);
        return (
          <Fragment key={f.id}>
          <article
            data-frame-id={f.id}
            className={[
              "frame-card",
              f.kind,
              f.deleted ? "is-deleted" : "",
              props.selectedId === f.id ? "selected" : "",
              props.combineIds.includes(f.id) ? "combine-selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => props.onSelect(f.id)}
          >
            <header>
              {props.combineMode && (
                <input
                  type="checkbox"
                  className="combine-check"
                  aria-label={`combine ${f.id}`}
                  checked={props.combineIds.includes(f.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => props.onToggleCombine(f.id)}
                />
              )}
              <span className="frame-id">{f.id}</span>
              <span className="frame-title">{f.title}</span>
              <span className="frame-tokens">{f.tokenEstimate} tok</span>
              <span onClick={(e) => e.stopPropagation()}>
                <OpMenu frameId={f.id} onPick={(op) => props.onPickOp(op, f.id)} />
              </span>
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
          {props.opFormFrameId === f.id && props.opForm}
          </Fragment>
        );
      })}
    </section>
  );
}
