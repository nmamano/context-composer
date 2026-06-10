// Event log (design.md §7 ContextEvent, Appendix C). The complete, append-only,
// ordered record of EVERYTHING that happened to the context store — captures/ingests
// AND user operations (delete/revert). This is the audit/timeline surface.
//
// It is deliberately DISTINCT from the commit graph (commit-graph.ts):
//   • Event   = anything that happened to the store. Non-revertible by default. The
//               timeline Nil asked for — `ctx timeline` reads this.
//   • Commit  = the SUBSET of events that are intentional representation-changing
//               operations with version-control semantics (revert/branch/checkout).
//               `ctx history` reads the commit graph.
// A `delete`/`revert` event carries the `commitId` of the commit it also produced; a
// `capture` event carries only frame ids (no commit). Raw capture is source material
// entering the stream, NOT a representation override — so it never becomes a commit and
// never lands in `Frame.provenance` (that stays operation lineage; see Appendix C).

export type ContextEventType =
  | "capture" | "delete" | "revert" | "edit" | "compact" | "offload" | "restore"
  | "add" | "move" | "combine" | "split"
  | "strip" | "summarize" | "retitle"
  // Engine batch A (plans/ui-feedback.md F-001): async ingest enrichment filled
  // title/summary metadata. Audited-not-silent (reviewer condition) — an event,
  // never a commit (metadata fill mirrors the capture-time placeholder).
  | "enriched";

export interface ContextEvent {
  id: string;
  type: ContextEventType;
  /** Frames created/affected by this event. */
  frameIds: string[];
  /** Set when this event also produced a commit (delete/revert); null for capture. */
  commitId: string | null;
  /** Shared logical clock (comparable with frame createdAt/modifiedAt and commit seq). */
  seq: number;
  /** Display-only wall-clock. */
  timestamp: string;
  /** Optional audit detail (e.g. `enriched`: which fields + provider/model —
   *  never raw prompt/output). Additive; absent on older snapshots. */
  note?: string | null;
}

export class EventLog {
  private events: ContextEvent[] = [];

  append(e: ContextEvent): void {
    this.events.push(e);
  }

  /** The complete timeline, in record order. */
  list(): ContextEvent[] {
    return [...this.events];
  }

  snapshot(): ContextEvent[] {
    return [...this.events];
  }

  restore(events: ContextEvent[]): void {
    this.events = [...events];
  }
}
