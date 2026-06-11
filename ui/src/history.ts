// History/timeline mapping — PURE (the 5a flags/details pattern): public
// commit/event payloads become display rows. The only derivation allowed is
// DIRECT revert marking (a commit of type "revert" whose params.revertedCommitId
// names a target marks THAT target as reverted) — this is derived DISPLAY
// state mirroring CommitGraph.isReverted(), not a new source of truth; no
// deeper graph semantics are inferred here (reviewer condition). Unknown or
// missing targets are rendered as data, never thrown on.

import type { PublicCommit, PublicEvent } from "./api.ts";

/** Faithful, safe rendering of an unknown param value: strings verbatim,
 *  everything else pretty JSON. Total — never throws. */
export function renderValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface CommitRow {
  id: string;
  type: string;
  note: string | null;
  affectedFrameIds: string[];
  timestamp: string;
  /** Marked when a LATER revert commit names this commit as its target. */
  reverted: boolean;
  /** Side-by-side §8 tracer diff: present when params carry before/after. */
  diff: { before: string; after: string } | null;
  /** Remaining params (before/after excluded), pretty-printed; null if none. */
  paramsText: string | null;
}

export function commitRows(commits: PublicCommit[]): CommitRow[] {
  const revertedIds = new Set<string>();
  for (const c of commits) {
    if (c.type === "revert" && typeof c.params.revertedCommitId === "string") {
      revertedIds.add(c.params.revertedCommitId);
    }
  }
  return commits.map((c) => {
    const { before, after, ...rest } = c.params;
    const hasDiff = before !== undefined && after !== undefined;
    const restKeys = Object.keys(rest);
    return {
      id: c.id,
      type: c.type,
      note: c.note,
      affectedFrameIds: c.affectedFrameIds,
      timestamp: c.timestamp,
      reverted: revertedIds.has(c.id),
      diff: hasDiff ? { before: renderValue(before), after: renderValue(after) } : null,
      paramsText: restKeys.length > 0 ? renderValue(rest) : null,
    };
  });
}

export interface EventRow {
  id: string;
  type: string;
  frameIds: string[];
  commitId: string | null;
  timestamp: string;
  /** F-050: the event's own annotation (e.g. how a frame was enriched) —
   *  reported by the daemon; the view must not drop it. */
  note: string | null;
  /** F-052: capture subtype reported by the daemon (request|reply); null on
   *  non-capture events and on events recorded before the field existed —
   *  those render exactly as before. */
  direction: "request" | "reply" | null;
}

export function eventRows(events: PublicEvent[]): EventRow[] {
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    frameIds: e.frameIds,
    commitId: e.commitId ?? null,
    timestamp: e.timestamp,
    note: e.note ?? null,
    direction: e.direction ?? null,
  }));
}
