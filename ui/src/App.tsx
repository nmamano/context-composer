// App shell — the ONLY stateful component, and its state is strictly client
// concerns: which conversation, which view, which frame is selected, plus a
// fetch-cache of control-API responses. No frame state is owned here and no op
// logic exists here (§3/§8 thin wrapper) — 5a is read-only.
//
// ONE data path (loadConversation) feeds everything; refresh = run it again.
// 5b's post-op refetch will call the same path after each mutation.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchComposeMeta,
  fetchConversations,
  fetchFrame,
  fetchFrames,
  type ComposeMeta,
  type ConversationSummary,
  type Frame,
  type FrameSummary,
} from "./api.ts";
import { ConversationView } from "./components/ConversationView.tsx";
import { FrameView } from "./components/FrameView.tsx";
import { DetailsPanel } from "./components/DetailsPanel.tsx";

export type ViewMode = "conversation" | "frames";

interface Loaded {
  conv: string;
  frames: FrameSummary[];
  compose: ComposeMeta;
  details: Map<string, Frame>;
}

export function App() {
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [view, setView] = useState<ViewMode>("conversation");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  /** The single data path: conversations → list + compose meta → show() per
   *  frame. Explicit ?conv= on every store-scoped request (no reliance on the
   *  daemon's active-conversation side effects). */
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
      const [frames, compose] = await Promise.all([
        fetchFrames(conv),
        fetchComposeMeta(conv),
      ]);
      const shown = await Promise.all(frames.map((f) => fetchFrame(conv, f.id)));
      const details = new Map(shown.map((f) => [f.id, f]));
      setLoaded({ conv, frames, compose, details });
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

  // On-focus refetch (reviewer-chosen 5a refresh model: manual + on-focus).
  useEffect(() => {
    const onFocus = () => void loadConversation(loaded?.conv);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadConversation, loaded?.conv]);

  const selected =
    loaded && selectedId ? (loaded.details.get(selectedId) ?? null) : null;
  const selectedSummary =
    loaded && selectedId
      ? (loaded.frames.find((f) => f.id === selectedId) ?? null)
      : null;

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
        </div>
        <button
          className="refresh"
          onClick={() => void loadConversation(loaded?.conv)}
        >
          refresh
        </button>
      </header>

      {error && <div className="error-banner">control API error: {error}</div>}

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
        ) : (
          <FrameView
            frames={loaded.frames}
            selectedId={selectedId}
            onSelect={setSelectedId}
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
