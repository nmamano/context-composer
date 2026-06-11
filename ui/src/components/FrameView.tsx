// Frame view (§4/§8) — the manipulation surface. 5a: linear cards in store
// order, everything list() returns, flagged. 5b: each card hosts the op menu
// GENERATED from the shared registry, plus a combine selection mode. Ops are
// never hidden/disabled by frame STATE — the daemon's guards speak (reviewer
// condition); the SVG git-tree stays parked until branches exist (Phase 4).

import { Fragment, type ReactNode } from "react";
import type { FrameSummary } from "../../../src/engine/state.ts";
import type { OpSpec } from "../../../src/shared/ops.ts";
import { frameFlags, positionAnchors } from "../flags.ts";
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
   *  the nav bar (Nil). Same registry verbs, same routes; placement only.
   *  F-046: revert-last moved to the history tab — it undoes the last COMMIT,
   *  so it lives next to the commit list it operates on, not here. */
  onAddFrame?: () => void;
  onToggleCombineMode?: () => void;
  onRunCombine?: () => void;
  /** F-047: combine's optional insert position — same value semantics as the
   *  add form's dropdown ("" = engine default: the first picked frame's
   *  place; "start" = after:null; otherwise a frame id). App owns the state;
   *  build()/position() map the value, the UI decides nothing. */
  combineAfter?: string;
  onCombineAfter?: (v: string) => void;
  /** Zero-target op form (add) renders right under the toolbar. */
  toolbarForm?: ReactNode;
  /** F-070 (Nil-decided, plan-gated): restore lives ON the offloaded chip —
   *  the action attached to the state it undoes (the commit-card-revert
   *  grammar), not a menu entry suppressed by state. */
  onRestoreFrame?: (id: string) => void;
}) {
  // F-064(1) (Nil: "they literally dont exist anymore after being replaced,
  // thats what replaced means"): structurally-replaced frames — combine parts
  // and split originals — are REMOVED from this view, no toggle (unlike
  // F-006's fork-only hiding). The engine still holds them as match targets;
  // reverting the combine/split from the history tab brings them back live.
  const present = props.frames.filter(
    (f) => !f.absorbedInto && !(f.splitInto && f.splitInto.length > 0),
  );
  const forkCount = present.filter((f) => f.inLastView === false).length;
  const visible = props.showForkOnly
    ? present
    : present.filter((f) => f.inLastView !== false);
  return (
    <section className="frame-view" aria-label="frame view">
      <div className="store-ops frame-toolbar">
        <button
          className="op-add"
          data-tip="insert text anywhere in the context"
          onClick={() => props.onAddFrame?.()}
        >
          add frame
        </button>
        <button
          className={`op-combine ${props.combineMode ? "on" : ""}`}
          data-tip="merge several frames into one"
          onClick={() => {
            // F-042: open-only — cancel lives inside the panel below.
            if (!props.combineMode) props.onToggleCombineMode?.();
          }}
        >
          combine
        </button>
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
      {/* F-042: combine gets the same panel treatment as the other toolbar
          ops — explainer + committing action + cancel INSIDE the panel.
          F-041: the copy states the actual semantics (engine combine():
          contents joined as-is in pick order, no LLM; the result takes the
          first picked frame's slot). */}
      {props.combineMode && (
        <div className="op-form-host toolbar combine-panel">
          <header>combine</header>
          <p className="combine-explainer">
            Tick 2 or more frames below, in the order they should be joined.
            Their text is kept as-is (no AI rewriting); the combined frame
            takes the place of the first one you pick, unless you choose a
            different spot below.
          </p>
          {/* F-047: optional insert position — mirrors the add form's
              dropdown (values: "" = default, "start", or a frame id). */}
          <label className="op-param combine-position">
            insert position
            <select
              value={props.combineAfter ?? ""}
              onChange={(e) => props.onCombineAfter?.(e.target.value)}
            >
              <option value="">at the first picked frame's place</option>
              <option value="start">at the start</option>
              {/* F-063: only viable anchors (deleted / fork-only / preamble
                  excluded — see positionAnchors); refusals still speak. */}
              {positionAnchors(props.frames).map((f) => (
                <option key={f.id} value={f.id}>
                  after {f.id} — {f.title.slice(0, 40)}
                </option>
              ))}
            </select>
          </label>
          <div className="op-form-actions">
            <button
              type="button"
              className="op-combine-run primary"
              disabled={props.combineIds.length < 2}
              onClick={() => props.onRunCombine?.()}
            >
              combine {props.combineIds.length} selected
            </button>
            <button type="button" onClick={() => props.onToggleCombineMode?.()}>
              cancel
            </button>
          </div>
        </div>
      )}
      {props.toolbarForm}
      {props.frames.length === 0 && <p className="empty">no frames yet</p>}
      {/* F-059 (Nil picked option c): after a daemon restart every frame's
          inLastView is null until the next request re-establishes a view
          (derived per request, never persisted — locked since Phase 2.7).
          The blank state read as a regression ("show fork-only frames button
          does not even appear now") — this hint names what's pending. The
          all-null condition is exactly "no view established": with a view, at
          least one captured turn frame is true/false. */}
      {props.frames.length > 0 &&
        props.frames.every((f) => f.inLastView === null) && (
          <p className="frames-hint">
            frame roles (like fork-only) appear after the next message
          </p>
        )}
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
                    {/* F-070: the restore affordance rides the offloaded
                        indicator itself; the daemon still judges (refusals
                        verbatim on stale races). */}
                    {c.key === "offloaded" && props.onRestoreFrame && (
                      <button
                        type="button"
                        className="chip-restore"
                        data-tip="bring this frame's full content back from the file"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onRestoreFrame!(f.id);
                        }}
                      >
                        restore
                      </button>
                    )}
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
