// Op menu + param form (§11 Phase 5b) — GENERATED from the shared registry
// (src/shared/ops.ts): the menu lists exactly the single-target specs; the form
// renders exactly the spec's params. No op exists here that the registry (and
// therefore the CLI) lacks — parity by construction, enforced by test.
//
// Deliberately judgment-free (reviewer condition): ops are never hidden or
// disabled because of frame STATE (offloaded/absorbed/deleted…) — presence-only
// param gating is allowed, the daemon's refusal is the source of truth for
// everything else.

import { useState } from "react";
import type { OpSpec, ParamSpec } from "../../../src/shared/ops.ts";
import { singleTargetOps } from "../../../src/shared/ops.ts";

export type FormValues = Record<string, string | boolean | undefined>;

function ParamField(props: {
  spec: ParamSpec;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const { spec } = props;
  if (spec.kind === "flag") {
    return (
      <label className="op-param op-flag">
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
      <label className="op-param">
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
    <label className="op-param">
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
  /** Presence-gating only: required params must be non-empty before POST. */
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<FormValues>({});
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
      {props.op.params.map((p) => (
        <ParamField
          key={p.key}
          spec={p}
          value={values[p.key]}
          onChange={(v) => setValues((prev) => ({ ...prev, [p.key]: v }))}
        />
      ))}
      <div className="op-form-actions">
        <button type="submit" disabled={missing.length > 0}>
          run {props.op.verb}
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
  return (
    <details className="op-menu" data-frame-id={props.frameId}>
      <summary aria-label={`ops for ${props.frameId}`}>ops ▾</summary>
      <ul>
        {singleTargetOps().map((op) => (
          <li key={op.verb}>
            <button
              type="button"
              data-verb={op.verb}
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
