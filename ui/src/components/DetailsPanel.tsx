// Details panel (§8) — full content for one frame, explicit about SOURCE vs
// CURRENT EMISSION (reviewer condition): the current emission is what the model
// sees next send (representation ?? messages — for offloaded frames that's the
// stub, with fileReference shown as a path, NOT the artifact bytes: no file-read
// API exists and 5a adds none); the source section appears when an override
// makes them differ (it's what the agent's resend keeps refreshing).
//
// F-067/F-068 (Nil-decided, plan-gated): the panel is also the METADATA and
// PER-MESSAGE editing surface — title/summary edit in place (retitle verb;
// regen buttons pin the other field's current value so each button scopes to
// its own field), and each plain-text message of the CURRENT emission carries
// an edit affordance (edit verb with a programmatic {raw} body — built in
// App/transcript.ts; mixed/tool-block messages are read-only with a tooltip,
// reviewer option (a)). Same verbs, same routes, refusals verbatim.

import { useEffect, useState } from "react";
import type { Block, Frame } from "../../../src/engine/types.ts";
import type { FrameSummary } from "../../../src/engine/state.ts";
import { detailsFields } from "../details.ts";
import { frameFlags } from "../flags.ts";
import {
  currentEmission,
  editableMessageText,
  messageBlocks,
} from "../transcript.ts";
import type { WireMessage } from "../../../src/engine/types.ts";

// Type alias (not interface) on purpose: aliases get the implicit index
// signature, so these values flow into FormValues/runOp without casts.
export type RetitleValues = {
  title?: string;
  summary?: string;
  regen?: boolean;
};

/** F-036: a preamble's content lives in system/tools/injectedSystem, not
 *  messages — render it as readable text (counts alone hid it; Nil: "why is
 *  preamble content not shown?"). */
function blockText(b: Block): string {
  return typeof b.text === "string" ? b.text : JSON.stringify(b);
}

function PreambleContent({ f }: { f: Frame }) {
  return (
    <section className="details-messages">
      <h3>preamble content</h3>
      {f.system !== undefined && (
        <div className="details-message system">
          <span className="bubble-role">system prompt</span>
          {typeof f.system === "string" ? (
            <p className="block-text">{f.system}</p>
          ) : (
            f.system.map((b, i) => (
              <p key={i} className="block-text">
                {blockText(b)}
              </p>
            ))
          )}
        </div>
      )}
      {f.injectedSystem && f.injectedSystem.length > 0 && (
        <div className="details-message system">
          <span className="bubble-role">injected system (added by the agent)</span>
          {f.injectedSystem.map((b, i) => (
            <p key={i} className="block-text">
              {blockText(b)}
            </p>
          ))}
        </div>
      )}
      {f.tools && f.tools.length > 0 && (
        <details className="block-collapsed tools">
          <summary>
            {f.tools.length} tool definition{f.tools.length === 1 ? "" : "s"}:{" "}
            {f.tools
              .map((t) => (typeof t.name === "string" ? t.name : "(unnamed)"))
              .join(", ")}
          </summary>
          <pre>{JSON.stringify(f.tools, null, 1)}</pre>
        </details>
      )}
      {f.system === undefined &&
        (!f.injectedSystem || f.injectedSystem.length === 0) &&
        (!f.tools || f.tools.length === 0) && (
          <p className="empty">(empty preamble)</p>
        )}
    </section>
  );
}

/** F-067: one in-place editor for a metadata field — opens PREFILLED with the
 *  current value (the F-066 standing principle). */
function InlineEditor(props: {
  field: "title" | "summary";
  initial: string;
  multiline?: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  return (
    <span className={`inline-editor ${props.field}-editor`}>
      {props.multiline ? (
        <textarea
          aria-label={`${props.field} editor`}
          value={draft}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <input
          type="text"
          aria-label={`${props.field} editor`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <span className="inline-editor-actions">
        <button type="button" className="primary save" onClick={() => props.onSave(draft)}>
          save
        </button>
        <button type="button" onClick={props.onCancel}>
          cancel
        </button>
      </span>
    </span>
  );
}

function Messages(props: {
  messages: WireMessage[];
  label: string;
  /** F-068: only the CURRENT-emission section is editable (never the source). */
  editable?: boolean;
  editingIndex?: number | null;
  onStartEdit?: (index: number, text: string) => void;
  onSaveEdit?: (index: number, text: string) => void;
  onCancelEdit?: () => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <section className="details-messages">
      <h3>{props.label}</h3>
      {/* F-068 (reviewer-required note): editing is whole-frame in effect —
          say so before the affordances, small and plain. */}
      {props.editable && props.messages.length > 0 && (
        <p className="freeze-note">
          editing a message changes what the model sees for this whole frame —
          the original text is kept, and the change can be undone from the
          history tab
        </p>
      )}
      {props.messages.length === 0 && <p className="empty">(no messages)</p>}
      {props.messages.map((m, i) => {
        const text = props.editable ? editableMessageText(m) : null;
        const editingThis = props.editable && props.editingIndex === i;
        return (
          <div key={i} className={`details-message ${m.role}`}>
            {/* §11 Phase 5b — message indices are split's boundary coordinates. */}
            <span className="msg-index">#{i}</span>
            <span className="bubble-role">{m.role}</span>
            {props.editable &&
              !editingThis &&
              (text !== null ? (
                <button
                  type="button"
                  className="icon msg-edit"
                  aria-label={`edit message ${i}`}
                  data-tip="edit this message's text"
                  onClick={() => {
                    setDraft(text);
                    props.onStartEdit?.(i, text);
                  }}
                >
                  ✎
                </button>
              ) : (
                <span
                  className="icon msg-edit-disabled"
                  data-tip="this message carries tool data — it can't be edited as plain text"
                >
                  ✎
                </span>
              ))}
            {editingThis ? (
              <span className="inline-editor message-editor">
                <textarea
                  aria-label={`message ${i} editor`}
                  value={draft}
                  rows={5}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <span className="inline-editor-actions">
                  <button
                    type="button"
                    className="primary save"
                    onClick={() => props.onSaveEdit?.(i, draft)}
                  >
                    save
                  </button>
                  <button type="button" onClick={() => props.onCancelEdit?.()}>
                    cancel
                  </button>
                </span>
              </span>
            ) : (
              messageBlocks(m).map((b, j) =>
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
              )
            )}
          </div>
        );
      })}
    </section>
  );
}

export function DetailsPanel(props: {
  frame: Frame;
  summary: FrameSummary | null;
  onClose: () => void;
  /** F-067: save/regen dispatch the retitle verb (App owns the op plumbing). */
  onRetitle?: (values: RetitleValues) => void;
  /** F-068: per-message edit — App builds the {raw} body and POSTs edit. */
  onEditMessage?: (index: number, text: string) => void;
}) {
  const f = props.frame;
  const overridden = f.representation != null;
  // F-015: beginner-friendly default — core rows only; the toggle reveals the
  // full set. Deliberately NOT keyed per frame: the mode sticks while the user
  // walks frames, which is exactly when stable rows (F-016) matter.
  const [showAll, setShowAll] = useState(false);
  // F-067/F-068 editing state — RESET when the panel moves to another frame
  // (the panel itself stays mounted so showAll sticks, per F-015).
  const [editingField, setEditingField] = useState<"title" | "summary" | null>(null);
  const [editingMsg, setEditingMsg] = useState<number | null>(null);
  useEffect(() => {
    setEditingField(null);
    setEditingMsg(null);
  }, [f.id]);
  const rows = detailsFields(f);
  const visible = showAll ? rows : rows.filter((r) => r.tier === "core");
  const hiddenCount = rows.length - visible.length;
  const canEdit = props.onRetitle !== undefined;
  return (
    <aside className="details-panel" aria-label="frame details">
      <header>
        {editingField === "title" ? (
          <InlineEditor
            field="title"
            initial={f.title}
            onSave={(t) => {
              setEditingField(null);
              props.onRetitle?.({ title: t });
            }}
            onCancel={() => setEditingField(null)}
          />
        ) : (
          <>
            <h2>{f.title}</h2>
            {canEdit && (
              <span className="meta-actions">
                <button
                  type="button"
                  className="icon edit-title"
                  aria-label="edit title"
                  data-tip="edit this frame's title"
                  onClick={() => setEditingField("title")}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="icon regen-title"
                  aria-label="regenerate title"
                  data-tip="let the AI write the title again (the description stays)"
                  // Regen produces BOTH fields server-side; pinning the other
                  // field's CURRENT value scopes this button to the title
                  // (explicit values win over regen — route contract).
                  onClick={() =>
                    props.onRetitle?.({ regen: true, summary: f.summary ?? undefined })
                  }
                >
                  ↻
                </button>
              </span>
            )}
          </>
        )}
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
      {/* F-067: the summary is an editable field, not an op. */}
      <div className="details-summary">
        {editingField === "summary" ? (
          <InlineEditor
            field="summary"
            multiline
            initial={f.summary ?? ""}
            onSave={(t) => {
              setEditingField(null);
              props.onRetitle?.({ summary: t });
            }}
            onCancel={() => setEditingField(null)}
          />
        ) : (
          <>
            <p className={`summary-text${f.summary ? "" : " empty"}`}>
              {f.summary ?? "(no description yet)"}
            </p>
            {canEdit && (
              <span className="meta-actions">
                <button
                  type="button"
                  className="icon edit-summary"
                  aria-label="edit summary"
                  data-tip="edit this frame's description"
                  onClick={() => setEditingField("summary")}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="icon regen-summary"
                  aria-label="regenerate summary"
                  data-tip="let the AI write the description again (the title stays)"
                  onClick={() => props.onRetitle?.({ regen: true, title: f.title })}
                >
                  ↻
                </button>
              </span>
            )}
          </>
        )}
      </div>
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
      {/* F-036: preambles carry their content in system/tools/injectedSystem —
          show THAT, and skip the misleading empty "current emission". */}
      {f.kind === "preamble" ? (
        <PreambleContent f={f} />
      ) : (
        <>
          <Messages
            messages={currentEmission(f)}
            label={
              f.deleted
                ? "current emission (suppressed — tombstone)"
                : "current emission"
            }
            editable={props.onEditMessage !== undefined && !f.deleted}
            editingIndex={editingMsg}
            onStartEdit={(i) => setEditingMsg(i)}
            onSaveEdit={(i, text) => {
              setEditingMsg(null);
              props.onEditMessage?.(i, text);
            }}
            onCancelEdit={() => setEditingMsg(null)}
          />
          {overridden && (
            <Messages messages={f.messages} label="source (agent's resend baseline)" />
          )}
        </>
      )}
    </aside>
  );
}
