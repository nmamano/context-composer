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
  /** F-006: fork-only cards hidden by default (display filter; engine list is
   *  still the truth — strictly inLastView === false, null is NOT fork-only). */
  showForkOnly?: boolean;
  onToggleForkOnly?: () => void;
  /** F-029: store-scoped ops live HERE, on the manipulation surface — not in
   *  the nav bar (Nil). Same registry verbs, same routes; placement only. */
  onAddFrame?: () => void;
  onRevertLast?: () => void;
  onToggleCombineMode?: () => void;
  onRunCombine?: () => void;
  /** Zero-target op form (add/revert) renders right under the toolbar. */
  toolbarForm?: ReactNode;
}) {
  const forkCount = props.frames.filter((f) => f.inLastView === false).length;
  const visible = props.showForkOnly
    ? props.frames
    : props.frames.filter((f) => f.inLastView !== false);
  return (
    <section className="frame-view" aria-label="frame view">
      <div className="store-ops frame-toolbar">
        <button
          className="op-add"
          data-tip="insert a new block of text into the conversation"
          onClick={() => props.onAddFrame?.()}
        >
          add frame
        </button>
        <button
          className="op-revert"
          data-tip="undo the latest change"
          onClick={() => props.onRevertLast?.()}
        >
          revert last
        </button>
        <button
          className={`op-combine ${props.combineMode ? "on" : ""}`}
          data-tip="merge several frames into one — pick the frames, then run"
          onClick={() => props.onToggleCombineMode?.()}
        >
          {props.combineMode ? "cancel combine" : "combine…"}
        </button>
        {props.combineMode && (
          <button
            className="op-combine-run"
            disabled={props.combineIds.length < 2}
            data-tip="merge the selected frames, in selection order"
            onClick={() => props.onRunCombine?.()}
          >
            combine {props.combineIds.length} selected
          </button>
        )}
        {forkCount > 0 && (
          <label
            className="fork-toggle"
            title="show frames from side requests (e.g. sub-agents) that aren't part of the main conversation"
          >
            <input
              type="checkbox"
              checked={props.showForkOnly === true}
              onChange={() => props.onToggleForkOnly?.()}
            />
            show fork-only frames ({forkCount})
          </label>
        )}
      </div>
      {props.toolbarForm}
      {props.frames.length === 0 && <p className="empty">no frames yet</p>}
      {visible.map((f) => {
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
