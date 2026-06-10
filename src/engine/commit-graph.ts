// Commit graph (design.md §2.3 "git-style versioning", §5.E, §7 Operation).
//
// Phase 2 scope: a single linear branch ("main") of LIGHTWEIGHT DELTA commits for the
// tracer ops only (`delete`, and `revert` of a delete). A commit records WHAT changed
// (affected frame ids + op type), not a full state snapshot — enough to invert a tracer
// `delete`, and small enough to stay inside the Phase 2 scope guard (no history
// materialization, no branch records, no query APIs — those are Phase 3/4).
//
// IMPORTANT (naming, per review): the commit graph is the OPERATION LINEAGE. It is NOT
// the reconciliation source-identity index. Source identity lives on the frames
// (`anchorFp` + `occurrence` + the ordered frame list / tombstones). Keeping these
// separate now prevents Phase 3 combine/split (many-to-one / one-to-many) from getting
// conceptually muddy.

// §11 Phase 3a adds the first content ops (representation overrides).
export type CommitType =
  | "delete" | "revert" | "edit" | "compact" | "offload" | "restore"
  | "add" | "move" | "combine" | "split";

/** A commit = a mutating operation, per §7 Operation. `branchId` is constant "main" in
 *  Phase 2; `parentCommitId` chains the linear history; `seq` is the shared logical
 *  clock (comparable with frame createdAt/modifiedAt); `timestamp` is display-only. */
export interface Commit {
  id: string;
  type: CommitType;
  affectedFrameIds: string[];
  params: Record<string, unknown>;
  note: string | null;
  branchId: string;
  parentCommitId: string | null;
  seq: number;
  timestamp: string;
}

export interface CommitGraphSnapshot {
  commits: Commit[];
  head: string | null;
}

export class CommitGraph {
  private commits: Commit[] = [];
  private head: string | null = null;

  /** Append a commit and advance HEAD (append-only; history is never rewritten). */
  record(c: Commit): void {
    this.commits.push(c);
    this.head = c.id;
  }

  get(id: string): Commit | null {
    return this.commits.find((c) => c.id === id) ?? null;
  }

  headId(): string | null {
    return this.head;
  }

  getHead(): Commit | null {
    return this.head ? this.get(this.head) : null;
  }

  /** Every commit, in record order. All commits here are USER ops (`delete`/`revert`) —
   *  session-ingest/capture never records, so this IS the user history. */
  history(): Commit[] {
    return [...this.commits];
  }

  /** Has `commitId` already been undone by a later `revert` commit? Guards against a
   *  double-revert producing a misleading "restored" entry for already-live frames. */
  isReverted(commitId: string): boolean {
    return this.commits.some(
      (c) => c.type === "revert" && c.params.revertedCommitId === commitId,
    );
  }

  snapshot(): CommitGraphSnapshot {
    return { commits: [...this.commits], head: this.head };
  }

  restore(s: CommitGraphSnapshot): void {
    this.commits = [...s.commits];
    this.head = s.head;
  }
}
