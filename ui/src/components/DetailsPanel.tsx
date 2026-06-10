// Details panel (§8) — full content for one frame, explicit about SOURCE vs
// CURRENT EMISSION (reviewer condition): the current emission is what the model
// sees next send (representation ?? messages — for offloaded frames that's the
// stub, with fileReference shown as a path, NOT the artifact bytes: no file-read
// API exists and 5a adds none); the source section appears when an override
// makes them differ (it's what the agent's resend keeps refreshing).

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
  return (
    <aside className="details-panel" aria-label="frame details">
      <header>
        <h2>{f.title}</h2>
        <button className="close" onClick={props.onClose} aria-label="close details">
          ×
        </button>
      </header>
      {props.summary && (
        <ul className="chips">
          {frameFlags(props.summary).map((c) => (
            <li key={c.key} className={`chip chip-${c.key}`}>
              {c.label}
            </li>
          ))}
        </ul>
      )}
      <dl className="details-fields">
        {detailsFields(f).map((row) => (
          <div key={row.label} className="details-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
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
