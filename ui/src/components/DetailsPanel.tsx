// Details panel (§8) — full content for one frame, explicit about SOURCE vs
// CURRENT EMISSION (reviewer condition): the current emission is what the model
// sees next send (representation ?? messages — for offloaded frames that's the
// stub, with fileReference shown as a path, NOT the artifact bytes: no file-read
// API exists and 5a adds none); the source section appears when an override
// makes them differ (it's what the agent's resend keeps refreshing).

import { useState } from "react";
import type { Frame } from "../../../src/engine/types.ts";
import type { FrameSummary } from "../../../src/engine/state.ts";
import { detailsFields } from "../details.ts";
import { frameFlags } from "../flags.ts";
import { currentEmission, messageBlocks } from "../transcript.ts";
import type { WireMessage } from "../../../src/engine/types.ts";

function Messages({ messages, label }: { messages: WireMessage[]; label: string }) {
  return (
    <section className="details-messages">
      <h3>{label}</h3>
      {messages.length === 0 && <p className="empty">(no messages)</p>}
      {messages.map((m, i) => (
        <div key={i} className={`details-message ${m.role}`}>
          {/* §11 Phase 5b — message indices are split's boundary coordinates. */}
          <span className="msg-index">#{i}</span>
          <span className="bubble-role">{m.role}</span>
          {messageBlocks(m).map((b, j) =>
            b.kind === "text" ? (
              <p key={j} className="block-text">
                {b.text}
              </p>
            ) : (
              <details key={j} className={`block-collapsed ${b.kind}`}>
                <summary>{b.label}</summary>
                <pre>{b.text}</pre>
              </details>
            ),
          )}
        </div>
      ))}
    </section>
  );
}

export function DetailsPanel(props: {
  frame: Frame;
  summary: FrameSummary | null;
  onClose: () => void;
}) {
  const f = props.frame;
  const overridden = f.representation != null;
  // F-015: beginner-friendly default — core rows only; the toggle reveals the
  // full set. Deliberately NOT keyed per frame: the mode sticks while the user
  // walks frames, which is exactly when stable rows (F-016) matter.
  const [showAll, setShowAll] = useState(false);
  const rows = detailsFields(f);
  const visible = showAll ? rows : rows.filter((r) => r.tier === "core");
  const hiddenCount = rows.length - visible.length;
  return (
    <aside className="details-panel" aria-label="frame details">
      <header>
        <h2>{f.title}</h2>
        <button
          className="close"
          onClick={props.onClose}
          aria-label="close details"
          data-tip="close"
        >
          ×
        </button>
      </header>
      {/* F-016: the chips row is ALWAYS rendered (reserved height) so the
          field rows below sit at the same position on flagged and clean
          frames alike. */}
      <ul className="chips chips-reserved">
        {props.summary
          ? frameFlags(props.summary).map((c) => (
              <li key={c.key} className={`chip chip-${c.key}`}>
                {c.label}
              </li>
            ))
          : null}
      </ul>
      <dl className="details-fields">
        {visible.map((row) => (
          <div key={row.label} className="details-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        className="fields-toggle"
        data-tip="show more or fewer details about this frame"
        onClick={() => setShowAll((s) => !s)}
      >
        {showAll ? "show fewer fields" : `show all fields (${hiddenCount} more)`}
      </button>
      <Messages
        messages={currentEmission(f)}
        label={
          f.deleted
            ? "current emission (suppressed — tombstone)"
            : "current emission"
        }
      />
      {overridden && (
        <Messages messages={f.messages} label="source (agent's resend baseline)" />
      )}
    </aside>
  );
}
