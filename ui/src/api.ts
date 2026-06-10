// Control-API client — the UI's ONLY data source (design.md §3/§8: thin wrapper).
//
// Every function is a plain fetch of an EXISTING /control route the CLI already
// drives (`ctx conversations` / `list` / `show` / `compose`) — no UI-only routes,
// no second operation client. Store-scoped requests carry an EXPLICIT ?conv=<id>
// (never relying on active-conversation side effects), and types are imported
// from the engine so the UI cannot silently drift from the API's real shapes.

import type { Frame } from "../../src/engine/types.ts";
import type { FrameSummary } from "../../src/engine/state.ts";
import type { ConversationSummary } from "../../src/engine/registry.ts";

export type { Frame, FrameSummary, ConversationSummary };

/** The compose metadata the UI reads: emission order + integrity surfaces.
 *  (Subset of GET /control/compose?hashHead — the body dump is not requested.) */
export interface ComposeMeta {
  conv: string;
  emittedFrameIds: string[];
  wireWarnings: unknown[];
  wireRepairs: unknown[];
  structureWarnings: unknown[];
  headHash: string;
  hasCacheBreakpoint: boolean;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok || data === null) {
    throw new Error(data?.error ?? `${path} failed (${res.status})`);
  }
  return data;
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const data = await get<{ conversations: ConversationSummary[] }>(
    "/control/conversations",
  );
  return data.conversations;
}

export async function fetchFrames(conv: string): Promise<FrameSummary[]> {
  const data = await get<{ frames: FrameSummary[] }>(
    `/control/list?conv=${encodeURIComponent(conv)}`,
  );
  return data.frames;
}

export async function fetchFrame(conv: string, id: string): Promise<Frame> {
  return get<Frame>(
    `/control/show?conv=${encodeURIComponent(conv)}&id=${encodeURIComponent(id)}`,
  );
}

/** Emission order + integrity surfaces for the conversation view. The engine's
 *  compose is the ordering oracle (placement applied, absorption/split resolved)
 *  — the UI must never re-derive emission order from store order (§3: the UI
 *  re-states, never re-decides). ?hashHead skips the full body dump. */
export async function fetchComposeMeta(conv: string): Promise<ComposeMeta> {
  return get<ComposeMeta>(
    `/control/compose?conv=${encodeURIComponent(conv)}&hashHead`,
  );
}

/** §11 Phase 5c — UI-facing mirrors of the control API's public op-log shapes
 *  (proxy/server.ts publicCommit/publicEvent). Deliberately NOT imported from
 *  server internals: the wire shape is the boundary, these types document it. */
export interface PublicCommit {
  id: string;
  type: string;
  affectedFrameIds: string[];
  params: Record<string, unknown>;
  note: string | null;
  branchId: string | null;
  parentCommitId: string | null;
  timestamp: string;
}

export interface PublicEvent {
  id: string;
  type: string;
  frameIds: string[];
  commitId: string | null;
  timestamp: string;
}

export async function fetchHistory(conv: string): Promise<PublicCommit[]> {
  const data = await get<{ commits: PublicCommit[] }>(
    `/control/history?conv=${encodeURIComponent(conv)}`,
  );
  return data.commits;
}

export async function fetchTimeline(conv: string): Promise<PublicEvent[]> {
  const data = await get<{ events: PublicEvent[] }>(
    `/control/timeline?conv=${encodeURIComponent(conv)}`,
  );
  return data.events;
}

/** §11 Phase 5b — dispatch one op through its control route. ALWAYS an explicit
 *  ?conv= (never the daemon's active-conversation default); on a non-2xx the
 *  daemon's own error text is thrown VERBATIM — the guards speak, the UI never
 *  paraphrases or pre-empts them. */
export async function postOp(
  conv: string,
  route: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${route}?conv=${encodeURIComponent(conv)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | { error?: string }
    | null;
  if (!res.ok) {
    throw new Error(data?.error ?? `${route} failed (${res.status})`);
  }
  return data;
}
