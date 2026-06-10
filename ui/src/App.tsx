// App shell — the ONLY stateful component, and its state is strictly client
// concerns: which conversation, which view, which frame is selected, which op
// form is open, plus a fetch-cache of control-API responses. No frame state is
// owned here and no op LOGIC exists here (§3/§8 thin wrapper).
//
// §11 Phase 5b: ops dispatch through the shared registry (src/shared/ops.ts) to
// the SAME control routes the CLI uses — postOp + the ONE loadConversation
// refetch on success AND refusal (both views re-derive; no optimistic state, no
// per-view patching). Refusals render the daemon's text VERBATIM in a sticky
// banner (cleared by the next successful op or manual dismiss — never by a
// refetch).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchComposeMeta,
  fetchConversations,
  fetchFrame,
  fetchFrames,
  fetchHistory,
  fetchTimeline,
  postOp,
  type ComposeMeta,
  type ConversationSummary,
  type Frame,
  type FrameSummary,
  type PublicCommit,
  type PublicEvent,
} from "./api.ts";
import type { OpSpec } from "../../src/shared/ops.ts";
import { opByVerb } from "../../src/shared/ops.ts";
import { ConversationView } from "./components/ConversationView.tsx";
import { FrameView } from "./components/FrameView.tsx";
import { DetailsPanel } from "./components/DetailsPanel.tsx";
import { OpForm, type FormValues } from "./components/OpMenu.tsx";
import { HistoryView, type HistorySubView } from "./components/HistoryView.tsx";
import { opPrefill } from "./prefill.ts";
import { copyText } from "./copy.ts";

export type ViewMode = "conversation" | "frames" | "history";

interface Loaded {
  conv: string;
  frames: FrameSummary[];
  compose: ComposeMeta;
  details: Map<string, Frame>;
  /** §11 Phase 5c — op log + audit log ride the SAME data path: a post-op
   *  refetch refreshes frames, compose, history and timeline together (no
   *  separately-stale caches). */
  history: PublicCommit[];
  timeline: PublicEvent[];
}

/** A registry op opened against 0..n targets, awaiting form params. */
interface PendingOp {
  op: OpSpec;
  targets: string[];
  /** F-003: prefilled form values — previews of engine defaults (prefill.ts). */
  initial: FormValues;
}

interface OpError {
  conv: string;
  verb: string;
  frameIds: string[];
  message: string;
}

export function App() {
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [view, setView] = useState<ViewMode>("conversation");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingOp, setPendingOp] = useState<PendingOp | null>(null);
  const [opError, setOpError] = useState<OpError | null>(null);
  const [combineMode, setCombineMode] = useState(false);
  const [combineIds, setCombineIds] = useState<string[]>([]);
  const [historySubView, setHistorySubView] = useState<HistorySubView>("commits");
  /** F-014: a selection carried INTO the history tab is stale context there —
   *  it's stashed on entry and restored on exit. Selecting a frame WHILE in
   *  history (frame links) still opens the panel. */
  const [stashedId, setStashedId] = useState<string | null>(null);
  /** F-009: brief "copied" feedback on the conv-key copy button. */
  const [copied, setCopied] = useState(false);
  /** F-006 (Nil-confirmed): fork-only frames are HIDDEN in the frame view by
   *  default — a display filter only; the engine's frame list stays the truth
   *  and the toggle keeps them inspectable. App-level so it survives tab
   *  switches. */
  const [showForkOnly, setShowForkOnly] = useState(false);
  const inFlight = useRef(false);

  /** The single data path: conversations → list + compose meta → show() per
   *  frame. Explicit ?conv= on every store-scoped request. 5b's post-op
   *  refetch is THIS function — there is no second path. */
  const loadConversation = useCallback(async (convId?: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const conversations = await fetchConversations();
      setConvs(conversations);
      const conv =
        (convId && conversations.some((c) => c.id === convId) ? convId : null) ??
        conversations.find((c) => c.active)?.id ??
        conversations[0]?.id ??
        null;
      if (!conv) {
        setLoaded(null);
        setError(null);
        return;
      }
      const [frames, compose, history, timeline] = await Promise.all([
        fetchFrames(conv),
        fetchComposeMeta(conv),
        fetchHistory(conv),
        fetchTimeline(conv),
      ]);
      const shown = await Promise.all(frames.map((f) => fetchFrame(conv, f.id)));
      const details = new Map(shown.map((f) => [f.id, f]));
      setLoaded({ conv, frames, compose, details, history, timeline });
      setError(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  // On-focus refetch (5a refresh model: manual + on-focus).
  useEffect(() => {
    const onFocus = () => void loadConversation(loaded?.conv);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadConversation, loaded?.conv]);

  /** Dispatch one registry op: build body → POST the op's own control route →
   *  refetch via the single path. Success clears the sticky refusal; a refusal
   *  replaces it with the daemon's text verbatim. */
  const runOp = useCallback(
    async (op: OpSpec, targets: string[], values: FormValues) => {
      if (!loaded) return;
      setPendingOp(null);
      try {
        await postOp(loaded.conv, op.route, op.build(targets, values));
        setOpError(null);
        if (op.verb === "combine") {
          setCombineMode(false);
          setCombineIds([]);
        }
      } catch (err) {
        setOpError({
          conv: loaded.conv,
          verb: op.verb,
          frameIds: targets,
          message: String(err instanceof Error ? err.message : err),
        });
      }
      await loadConversation(loaded.conv);
    },
    [loaded, loadConversation],
  );

  /** Menu pick: param-less ops run immediately; others open the generated form
   *  (prefilled where prefill.ts previews an engine default — F-003). */
  const pickOp = useCallback(
    (op: OpSpec, targets: string[]) => {
      if (op.params.length === 0) {
        void runOp(op, targets, {});
      } else {
        const frames = targets
          .map((id) => loaded?.details.get(id))
          .filter((f): f is Frame => f != null);
        setPendingOp({ op, targets, initial: opPrefill(op, frames) });
      }
    },
    [runOp, loaded],
  );

  /** F-014: tab switch with the details-selection stash (see state above). */
  const switchView = useCallback(
    (v: ViewMode) => {
      if (v === view) return;
      if (v === "history") {
        setStashedId(selectedId);
        setSelectedId(null);
      } else if (view === "history") {
        if (selectedId === null && stashedId !== null) setSelectedId(stashedId);
        setStashedId(null);
      }
      setView(v);
    },
    [view, selectedId, stashedId],
  );

  const toggleCombine = useCallback((id: string) => {
    setCombineIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const selected =
    loaded && selectedId ? (loaded.details.get(selectedId) ?? null) : null;
  const selectedSummary =
    loaded && selectedId
      ? (loaded.frames.find((f) => f.id === selectedId) ?? null)
      : null;

  const addOp = opByVerb("add")!;
  const revertOp = opByVerb("revert")!;
  const combineOp = opByVerb("combine")!;
  const activeKey = (loaded && convs.find((c) => c.id === loaded.conv)?.key) || null;

  // F-008/F-029: where does the pending form live this render? Single-target
  // forms sit under their card (only if that card is visible — F-006 can hide
  // fork-only cards); zero-target forms (add/revert) sit under the frames-view
  // toolbar that triggered them. Any other view: the top host — a pending form
  // is never invisible.
  const targetVisible = (id: string) =>
    showForkOnly ||
    loaded?.frames.find((f) => f.id === id)?.inLastView !== false;
  const inlineFormFrameId =
    pendingOp &&
    view === "frames" &&
    pendingOp.targets.length === 1 &&
    targetVisible(pendingOp.targets[0]!)
      ? pendingOp.targets[0]!
      : null;
  const toolbarFormActive =
    pendingOp !== null && view === "frames" && pendingOp.targets.length === 0;
  const opFormHost = pendingOp ? (
    <div
      className={`op-form-host${inlineFormFrameId ? " inline" : ""}${toolbarFormActive ? " toolbar" : ""}`}
    >
      <OpForm
        // Remount per op+target so prefilled values reset with the target.
        key={`${pendingOp.op.verb}:${pendingOp.targets.join(",")}`}
        op={pendingOp.op}
        initial={pendingOp.initial}
        frames={loaded?.frames}
        onSubmit={(values) => void runOp(pendingOp.op, pendingOp.targets, values)}
        onCancel={() => setPendingOp(null)}
      />
      {pendingOp.targets.length > 0 && (
        <p className="op-form-target">target: {pendingOp.targets.join(", ")}</p>
      )}
    </div>
  ) : null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>Context Composer</h1>
        <select
          aria-label="conversation"
          title="switch conversation"
          className="conv-switcher"
          value={loaded?.conv ?? ""}
          onChange={(e) => {
            setSelectedId(null);
            setStashedId(null);
            setCombineMode(false);
            setCombineIds([]);
            void loadConversation(e.target.value);
          }}
        >
          {/* F-025: options carry id + turns only — the conv-key span beside
              the switcher is the SINGLE key surface (short prefix, copy-full). */}
          {convs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} · {c.turnFrames} turns
              {c.active ? " · active" : ""}
            </option>
          ))}
        </select>
        {loaded && activeKey && (
          <span
            className="conv-key"
            title={`conversation key: ${activeKey}`}
          >
            {/* F-009/F-030: the key prefix only (the id already sits in the
                selector) — selectable (user-select: all), copy button puts the
                FULL key on the clipboard (plain-http fallback in copy.ts). */}
            <code>{activeKey.slice(0, 8)}</code>
            <button
              type="button"
              className="copy-key"
              aria-label="copy conversation key"
              data-tip="copy this conversation's full ID"
              onClick={() => {
                copyText(activeKey);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "✓" : "⧉"}
            </button>
          </span>
        )}
        <div className="view-toggle" role="tablist">
          {/* F-021/F-028: every control explains itself — plain language, no
              engine jargon (Nil). F-031: data-tip renders instantly via CSS. */}
          <button
            role="tab"
            aria-selected={view === "conversation"}
            className={view === "conversation" ? "on" : ""}
            data-tip="read the conversation as a chat"
            onClick={() => switchView("conversation")}
          >
            conversation
          </button>
          <button
            role="tab"
            aria-selected={view === "frames"}
            className={view === "frames" ? "on" : ""}
            data-tip="inspect and edit the context frames"
            onClick={() => switchView("frames")}
          >
            frames
          </button>
          <button
            role="tab"
            aria-selected={view === "history"}
            className={view === "history" ? "on" : ""}
            data-tip="review past changes and undo them"
            onClick={() => switchView("history")}
          >
            history
          </button>
        </div>
        {/* F-029: store-scoped ops (add/revert/combine) moved INTO the frames
            view — they edit the conversation, so they live on the
            manipulation surface, not in global chrome. */}
        <button
          className="refresh"
          data-tip="load what's new — use it if the conversation advanced while you kept this window open; switching back to the window refreshes on its own"
          onClick={() => void loadConversation(loaded?.conv)}
        >
          refresh
        </button>
      </header>

      {error && <div className="error-banner">control API error: {error}</div>}
      {opError && (
        <div className="op-error-banner" role="alert">
          <strong>{opError.verb}</strong>
          {opError.frameIds.length > 0 && <> on {opError.frameIds.join(", ")}</>} (
          {opError.conv}) refused: {opError.message}
          <button
            className="dismiss"
            aria-label="dismiss error"
            onClick={() => setOpError(null)}
          >
            ×
          </button>
        </div>
      )}

      {/* F-008/F-029: forms render next to their trigger in the frames view
          (under the card, or under the toolbar for store-scoped ops); from any
          other view the top host keeps a pending form visible. */}
      {pendingOp && !inlineFormFrameId && !toolbarFormActive && opFormHost}

      <main className={selected ? "with-details" : ""}>
        {!loaded ? (
          <p className="empty">
            no conversations yet — point the wrapped agent at the proxy and send
            a turn
          </p>
        ) : view === "conversation" ? (
          <ConversationView
            emittedFrameIds={loaded.compose.emittedFrameIds}
            details={loaded.details}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : view === "frames" ? (
          <FrameView
            frames={loaded.frames}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onPickOp={(op, frameId) => pickOp(op, [frameId])}
            combineMode={combineMode}
            combineIds={combineIds}
            onToggleCombine={toggleCombine}
            opFormFrameId={inlineFormFrameId}
            opForm={opFormHost}
            toolbarForm={toolbarFormActive ? opFormHost : null}
            showForkOnly={showForkOnly}
            onToggleForkOnly={() => setShowForkOnly((s) => !s)}
            // F-042: the three toolbar ops are mutually exclusive — opening
            // one auto-cancels whichever panel is already open.
            onAddFrame={() => {
              setCombineMode(false);
              setCombineIds([]);
              pickOp(addOp, []);
            }}
            onRevertLast={() => {
              setCombineMode(false);
              setCombineIds([]);
              pickOp(revertOp, []);
            }}
            onToggleCombineMode={() => {
              setPendingOp(null);
              setCombineMode((m) => !m);
              setCombineIds([]);
            }}
            onRunCombine={() => void runOp(combineOp, combineIds, {})}
          />
        ) : (
          <HistoryView
            commits={loaded.history}
            events={loaded.timeline}
            details={loaded.details}
            subView={historySubView}
            onSubView={setHistorySubView}
            // §11 Phase 5c click-to-revert: the SAME registry revert op, with
            // the commit id passed programmatically (no form; {} stays HEAD
            // for the topbar). Refusals ride the standing banner verbatim.
            onRevert={(commitId) => void runOp(revertOp, [], { commit: commitId })}
            onSelectFrame={setSelectedId}
          />
        )}
        {selected && (
          <DetailsPanel
            frame={selected}
            summary={selectedSummary}
            onClose={() => setSelectedId(null)}
          />
        )}
      </main>
    </div>
  );
}
