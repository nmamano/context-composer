// Op menu + param form (§11 Phase 5b) — GENERATED from the shared registry
// (src/shared/ops.ts): the menu lists exactly the single-target specs; the form
// renders exactly the spec's params. No op exists here that the registry (and
// therefore the CLI) lacks — parity by construction, enforced by test.
//
// Deliberately judgment-free (reviewer condition): ops are never hidden or
// disabled because of frame STATE (offloaded/absorbed/deleted…) — presence-only
// param gating is allowed, the daemon's refusal is the source of truth for
// everything else.

import { useEffect, useRef, useState } from "react";
import type { OpSpec, ParamSpec } from "../../../src/shared/ops.ts";
import { singleTargetOps } from "../../../src/shared/ops.ts";
import type { FrameSummary } from "../../../src/engine/state.ts";
import { positionAnchors } from "../flags.ts";

export type FormValues = Record<string, string | boolean | undefined>;

/** F-061: plain-language help on form fields whose purpose confused Nil —
 *  UI-side map (presentation, not registry data; ops.ts stays untouched).
 *  Truth checked against the wire shape: build()/the daemon's compact route
 *  both let regen WIN when both are set, so "the text box is ignored". */
const PARAM_TIPS: Record<string, string> = {
  "compact.text":
    "the shorter text the model will see instead of this frame's full content — written for you from the frame's summary; edit freely",
  "compact.regen":
    "let the AI write the replacement text for you when you submit — when ticked, the text box is ignored",
  "edit.text":
    "replaces everything this frame holds with this text — when a frame holds several messages, the box starts empty",
};

/** F-061: one-line explainer inside forms that need orienting (the F-042
 *  combine-panel pattern). */
const FORM_EXPLAINERS: Record<string, string> = {
  compact:
    "Shrink what the model sees: this frame's content is replaced by a short summary in the conversation sent to the model. Undo from the history tab.",
};

/** F-067/F-068 (Nil-decided, plan-gated): ops RELOCATED to the details panel —
 *  same verbs, same routes, better-shaped entry points (title/summary edit in
 *  place; per-message editing). The verbs stay in the registry and the CLI
 *  untouched — the parity rail is registry↔CLI, and no UI-only verb may exist;
 *  the menu simply offers fewer entry points than the registry. */
export const RELOCATED_TO_PANEL: ReadonlySet<string> = new Set(["edit", "retitle"]);

/** The ops menu's verb list: every single-target registry op EXCEPT the
 *  panel-relocated ones. Exported so the menu-pin test asserts it exactly. */
export const menuOps = (): OpSpec[] =>
  singleTargetOps().filter((o) => !RELOCATED_TO_PANEL.has(o.verb));

/** F-065 (corrected truth): per-menu-item tooltips where a verb confused Nil.
 *  summarize is a WIRE op — it swaps tool results inside the frame for a
 *  summary; it does NOT touch the card's title/summary (that's the panel). */
const MENU_TIPS: Record<string, string> = {
  summarize:
    "swap chosen tool results inside this frame for a short summary the model sees instead",
};

function ParamField(props: {
  spec: ParamSpec;
  verb: string;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
  /** F-039: position params render as a dropdown fed by the loaded frames. */
  frames?: FrameSummary[];
}) {
  const { spec } = props;
  // F-039 (plans/ui-feedback.md): the free-text position field was ambiguous
  // (before or after the id?) — a dropdown makes the AFTER semantics explicit.
  // Values stay exactly what build()/position() expect: "" = end (omitted),
  // "start" = after:null, otherwise a frame id (after that frame).
  // F-061: instant CSS tooltip on fields that carry one (PARAM_TIPS).
  const tip = PARAM_TIPS[`${props.verb}.${spec.key}`];
  if (spec.kind === "position") {
    return (
      <label className="op-param" data-tip={tip}>
        insert position
        <select
          value={typeof props.value === "string" ? props.value : ""}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="">
            {props.verb === "add"
              ? "at the end"
              : props.verb === "combine"
                ? "at the first picked frame's place"
                : "(pick a position)"}
          </option>
          <option value="start">at the start</option>
          {/* F-063: only viable anchors are offered (positionAnchors —
              deleted / fork-only / preamble excluded); the daemon's refusal
              still speaks for anything else invalid. */}
          {positionAnchors(props.frames ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              after {f.id} — {f.title.slice(0, 40)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.kind === "flag") {
    return (
      <label className="op-param op-flag" data-tip={tip}>
        <input
          type="checkbox"
          checked={props.value === true}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        {spec.label}
      </label>
    );
  }
  if (spec.kind === "textarea") {
    return (
      <label className="op-param" data-tip={tip}>
        {spec.label}
        <textarea
          value={typeof props.value === "string" ? props.value : ""}
          placeholder={spec.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          rows={4}
        />
      </label>
    );
  }
  return (
    <label className="op-param" data-tip={tip}>
      {spec.label}
      <input
        type="text"
        value={typeof props.value === "string" ? props.value : ""}
        placeholder={spec.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

export function OpForm(props: {
  op: OpSpec;
  /** F-003: prefilled values (previews of engine defaults — see prefill.ts).
   *  The caller keys this component so a new target remounts with fresh state. */
  initial?: FormValues;
  /** F-039: loaded frames feed the position dropdown. */
  frames?: FrameSummary[];
  /** Presence-gating only: required params must be non-empty before POST. */
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<FormValues>(props.initial ?? {});
  const missing = props.op.params.filter(
    (p) =>
      p.required &&
      p.kind !== "flag" &&
      (typeof values[p.key] !== "string" || (values[p.key] as string).trim() === ""),
  );
  return (
    <form
      className="op-form"
      data-op={props.op.verb}
      onSubmit={(e) => {
        e.preventDefault();
        if (missing.length > 0) return; // presence-only gate; daemon judges the rest
        props.onSubmit(values);
      }}
    >
      <header>{props.op.verb}</header>
      {/* F-061: forms that confused Nil orient the user up front (the F-042
          combine-panel pattern); copy states engine truth only. */}
      {FORM_EXPLAINERS[props.op.verb] && (
        <p className="op-form-explainer">{FORM_EXPLAINERS[props.op.verb]}</p>
      )}
      {props.op.params.map((p) => (
        <ParamField
          key={p.key}
          spec={p}
          verb={props.op.verb}
          frames={props.frames}
          value={values[p.key]}
          onChange={(v) => setValues((prev) => ({ ...prev, [p.key]: v }))}
        />
      ))}
      <div className="op-form-actions">
        {/* F-040: bare verb + filled "primary" styling — the committing action
            reads as definitive; cancel stays the neutral outline. */}
        <button type="submit" className="primary" disabled={missing.length > 0}>
          {props.op.verb}
        </button>
        <button type="button" onClick={props.onCancel}>
          cancel
        </button>
      </div>
    </form>
  );
}

export function OpMenu(props: {
  frameId: string;
  /** Run a no-param op immediately; ops with params open their form. */
  onPick: (op: OpSpec) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  // F-002 (plans/ui-feedback.md): an open menu dismisses on any click outside
  // it — not only by re-clicking the summary. Capture phase, so clicks whose
  // bubbling something stops still close the menu.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const d = ref.current;
      if (d?.open && e.target instanceof Node && !d.contains(e.target)) {
        d.removeAttribute("open");
      }
    };
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  }, []);
  return (
    <details ref={ref} className="op-menu" data-frame-id={props.frameId}>
      <summary
        aria-label={`ops for ${props.frameId}`}
        data-tip="edit this frame — delete, rewrite, offload and more"
      >
        ops ▾
      </summary>
      <ul>
        {menuOps().map((op) => (
          <li key={op.verb}>
            <button
              type="button"
              data-verb={op.verb}
              data-tip={MENU_TIPS[op.verb]}
              onClick={(e) => {
                // Close the dropdown on pick — a stale open <details> floats
                // over neighboring cards and intercepts their clicks.
                e.currentTarget.closest("details")?.removeAttribute("open");
                props.onPick(op);
              }}
            >
              {op.verb}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
