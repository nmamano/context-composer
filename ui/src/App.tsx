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

  /** Menu pick: param-less ops run immediately; others open the generated form. */
  const pickOp = useCallback(
    (op: OpSpec, targets: string[]) => {
      if (op.params.length === 0) {
        void runOp(op, targets, {});
      } else {
        setPendingOp({ op, targets });
      }
    },
    [runOp],
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

  return (
    <div className="app">
      <header className="topbar">
        <h1>context composer</h1>
        <select
          aria-label="conversation"
          className="conv-switcher"
          value={loaded?.conv ?? ""}
          onChange={(e) => {
            setSelectedId(null);
            setCombineMode(false);
            setCombineIds([]);
            void loadConversation(e.target.value);
          }}
        >
          {convs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
              {c.key ? ` · ${c.key.slice(0, 24)}` : ""} · {c.turnFrames} turns
              {c.active ? " · active" : ""}
            </option>
          ))}
        </select>
        <div className="view-toggle" role="tablist">
          <button
            role="tab"
            aria-selected={view === "conversation"}
            className={view === "conversation" ? "on" : ""}
            onClick={() => setView("conversation")}
          >
            conversation
          </button>
          <button
            role="tab"
            aria-selected={view === "frames"}
            className={view === "frames" ? "on" : ""}
            onClick={() => setView("frames")}
          >
            frames
          </button>
          <button
            role="tab"
            aria-selected={view === "history"}
            className={view === "history" ? "on" : ""}
            onClick={() => setView("history")}
          >
            history
          </button>
        </div>
        {loaded && (
          <div className="store-ops">
            {/* Store-scoped ops (arity none) live in the topbar, not on cards. */}
            <button className="op-add" onClick={() => pickOp(addOp, [])}>
              add frame
            </button>
            <button className="op-revert" onClick={() => pickOp(revertOp, [])}>
              revert last
            </button>
            <button
              className={`op-combine ${combineMode ? "on" : ""}`}
              onClick={() => {
                setCombineMode((m) => !m);
                setCombineIds([]);
              }}
            >
              {combineMode ? "cancel combine" : "combine…"}
            </button>
            {combineMode && (
              <button
                className="op-combine-run"
                disabled={combineIds.length < 2}
                onClick={() => void runOp(combineOp, combineIds, {})}
              >
                combine {combineIds.length} selected
              </button>
            )}
          </div>
        )}
        <button
          className="refresh"
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

      {pendingOp && (
        <div className="op-form-host">
          <OpForm
            op={pendingOp.op}
            onSubmit={(values) => void runOp(pendingOp.op, pendingOp.targets, values)}
            onCancel={() => setPendingOp(null)}
          />
          {pendingOp.targets.length > 0 && (
            <p className="op-form-target">target: {pendingOp.targets.join(", ")}</p>
          )}
        </div>
      )}

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
