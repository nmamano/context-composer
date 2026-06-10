// Conversation registry (design.md §11 Phase 2.6).
//
// A real interactive agent MULTIPLEXES independent conversations over POST
// /v1/messages: the main thread PLUS side queries (title/recap generation, quota
// probes, skills probes, …). Phases ≤2.5 had ONE FrameStore, so every request was
// reconciled into a single linear conversation and compose() emitted the MERGED
// union — the proxy silently injected side-query content into the model's context
// and let side-query heads overwrite the main preamble (the wedged-store live
// finding). That inverted the product premise. The registry fixes the *modeling*:
// one FrameStore per conversation.
//
// Conversation identity — derived, never heuristic:
//   key = first-frame anchorFp (the OPENING TURN's normalized fingerprint)
// The opening turn is the one component of a request that is byte-stable across the
// agent's own lifecycle: history only ever appends, so the first message is fixed —
// and it proved stable across process restarts/resumes in live evidence, modulo the
// relocated cache_control and string/array re-encoding that identity normalization
// already strips. The HEAD is deliberately NOT part of the key: live wiretap
// evidence shows the agent embeds a per-invocation billing hash in a system block
// (`cch=…` changes on every process start), and tools can legitimately grow
// mid-conversation (deferred/MCP tool loading) — keying on either forks the
// conversation and strands the user's edits. (User edits through OUR surface don't
// move the key either — the unaware agent keeps resending the original view;
// compose is what changes.) A request reproducing a known key routes to that
// conversation; an unknown key starts a new one. Documented limitation: two
// genuinely distinct conversations that open with a byte-identical first message
// collide (e.g. /clear then the exact same prompt, or two parallel TUIs opening
// identically through one proxy) — visible in `ctx conversations` + the wiretap;
// out of scope for the tracer.
//
// The CLI operates on the ACTIVE conversation by default: most TOTAL turn frames
// including tombstones (deletion is curation, not abandonment — deleting frames must
// never demote the conversation being curated), tie → largest live token estimate
// (a real session's preamble dwarfs one-shot probes), tie → most recent ingest.
// Every control route takes ?conv=<id> to override; /control/conversations lists
// them all, and every store-scoped response echoes the resolved conv id.
//
// Durability: ONE registry file (REGISTRY_VERSION 3) holding every conversation's
// StoreSnapshot. Same policy as before — no migrations; a foreign version fails
// loudly with instructions to move/delete the file.

import { readFileSync } from "node:fs";
import { FrameStore } from "./state.ts";
import { decompose } from "./decompose.ts";
import { canonicalStringify, stripCacheControlDeep } from "./canonical.ts";
import {
  atomicWriteFile,
  SNAPSHOT_VERSION,
  type Persistence,
  type StoreSnapshot,
} from "./store.ts";

export const REGISTRY_VERSION = 3;

/** The identity tripwire: a conversation born from a body that already carried
 *  history — the signature of a continuation we failed to match (the failure class
 *  that strands tombstones). Persisted + surfaced in summaries, never stderr-only. */
export interface ConvWarning {
  reason: "new-conversation-with-history";
  frameCount: number;
  at: string;
}

interface ConvRecord {
  id: string; // c1, c2, … — stable, user-facing
  key: string | null; // null only for the eager default store before its first ingest
  lastIngestAt: string | null;
  lastIngestSeq: number;
  suspicious: ConvWarning | null;
  snapshot: StoreSnapshot | null; // latest per-store snapshot (what the file holds)
  store: FrameStore;
}

export interface ConversationSummary {
  id: string;
  key: string | null;
  /** Live (non-deleted) turn frames — what the model currently sees. */
  turnFrames: number;
  /** ALL turn frames including tombstones — the activity measure. Deletion is
   *  curation, not abandonment: it must never demote the curated conversation. */
  totalTurnFrames: number;
  /** §11 Phase 2.7 — live turn frames NOT in this conversation's last emitted view
   *  (fork-only: stored/visible/deletable, but the next emission of the thread that
   *  didn't carry them excludes them). 0 when no view has been emitted yet — views
   *  are derived per request and never persisted. */
  forkFrames: number;
  tokenEstimate: number;
  lastIngestAt: string | null;
  active: boolean;
  suspicious: ConvWarning | null;
}

interface RegistryFile {
  version: number;
  convCounter: number;
  ingestSeq: number;
  conversations: Array<{
    id: string;
    key: string | null;
    lastIngestAt: string | null;
    lastIngestSeq: number;
    suspicious: ConvWarning | null;
    store: StoreSnapshot;
  }>;
}

/** Identity of the conversation a /v1/messages body belongs to: the opening turn's
 *  normalized anchor (see the header — the head is deliberately excluded). Exposed
 *  for tests. */
export function conversationKey(body: Record<string, unknown>): string {
  const { frames } = decompose(body);
  return frames.length > 0 ? frames[0]!.anchorFp : "<no-messages>";
}

export class ConversationRegistry {
  private convs: ConvRecord[] = [];
  private convCounter = 0;
  private ingestSeq = 0;
  private readonly path: string | null;

  constructor(path: string | null = null) {
    this.path = path;
    const file = this.loadFile();
    if (file) {
      this.convCounter = file.convCounter;
      this.ingestSeq = file.ingestSeq;
      for (const c of file.conversations) {
        const rec: ConvRecord = {
          id: c.id,
          key: c.key,
          lastIngestAt: c.lastIngestAt,
          lastIngestSeq: c.lastIngestSeq,
          suspicious: c.suspicious ?? null,
          snapshot: c.store,
          store: null as unknown as FrameStore,
        };
        // The adapter feeds the loaded snapshot into the FrameStore constructor and
        // routes its saves back into this record + the shared registry file.
        rec.store = new FrameStore(this.adapterFor(rec));
        this.convs.push(rec);
      }
    }
  }

  /** Route an incoming /v1/messages body to its conversation, creating one if the
   *  key is new (or adopting the eager default created by a pre-ingest control read). */
  route(body: Record<string, unknown>): ConvRecord {
    const { frames } = decompose(body);
    const key = frames.length > 0 ? frames[0]!.anchorFp : "<no-messages>";
    let rec = this.convs.find((r) => r.key === key);
    if (!rec) {
      rec = this.convs.find((r) => r.key === null); // adopt the eager default
      if (rec) rec.key = key;
    }
    if (!rec) {
      rec = this.create(key);
      // Identity tripwire: a BRAND-NEW conversation arriving with history already in
      // it is the signature of an identity miss (a resend we failed to match — the
      // failure mode that strands user edits). Surface it loudly AND structurally
      // (persisted, shown in `ctx conversations`); never stderr-only.
      if (frames.length > 1) {
        rec.suspicious = {
          reason: "new-conversation-with-history",
          frameCount: frames.length,
          at: new Date().toISOString(),
        };
        console.error(
          `[context-composer] WARNING: new conversation ${rec.id} created from a ` +
            `${frames.length}-frame body — a continuation we failed to match? ` +
            `Check \`ctx conversations\` + the wiretap.`,
        );
      }
    }
    rec.lastIngestSeq = ++this.ingestSeq;
    rec.lastIngestAt = new Date().toISOString();
    return rec;
  }

  /** The conversation control ops target. Explicit id wins; otherwise: most TOTAL
   *  turn frames INCLUDING tombstones (deletion is curation, not abandonment — a user
   *  deleting frames must never demote the conversation they are curating, or the
   *  next default `revert` targets the wrong store), tie → largest live token
   *  estimate (a real session's preamble dwarfs one-shot probes/title/recap queries,
   *  which would otherwise steal `active` by recency right after the first turn),
   *  tie → most recent ingest. Creates the eager default when none exist (pre-ingest
   *  control reads on a fresh daemon). Every control response carries the resolved
   *  conv id so the selection is always observable. */
  activeRecord(convId?: string | null): ConvRecord | null {
    if (convId) return this.convs.find((r) => r.id === convId) ?? null;
    if (this.convs.length === 0) return this.create(null);
    const rank = (r: ConvRecord): [number, number, number] => [
      this.totalTurnFrames(r),
      this.tokens(r),
      r.lastIngestSeq,
    ];
    let best = this.convs[0]!;
    let bestRank = rank(best);
    for (const r of this.convs.slice(1)) {
      const rr = rank(r);
      if (
        rr[0] > bestRank[0] ||
        (rr[0] === bestRank[0] &&
          (rr[1] > bestRank[1] || (rr[1] === bestRank[1] && rr[2] > bestRank[2])))
      ) {
        best = r;
        bestRank = rr;
      }
    }
    return best;
  }

  /** Convenience for the proxy handle: the active conversation's store. */
  activeStore(): FrameStore {
    return this.activeRecord()!.store;
  }

  summaries(): ConversationSummary[] {
    const active = this.convs.length > 0 ? this.activeRecord() : null;
    return this.convs.map((r) => ({
      id: r.id,
      key: r.key,
      turnFrames: this.turnFrames(r),
      totalTurnFrames: this.totalTurnFrames(r),
      forkFrames: this.forkFrames(r),
      tokenEstimate: this.tokens(r),
      lastIngestAt: r.lastIngestAt,
      active: r === active,
      suspicious: r.suspicious,
    }));
  }

  private turnFrames(rec: ConvRecord): number {
    return rec.store.list().filter((f) => f.kind === "turn" && !f.deleted).length;
  }

  /** Live turn frames outside the conversation's last emitted view (§11 Phase 2.7)
   *  — the fork-only count surfaced by `ctx conversations`. */
  private forkFrames(rec: ConvRecord): number {
    if (!rec.store.lastView()) return 0; // no view yet — annotation not applicable
    return rec.store
      .list()
      .filter((f) => f.kind === "turn" && !f.deleted && f.inLastView === false)
      .length;
  }

  private totalTurnFrames(rec: ConvRecord): number {
    return rec.store.list().filter((f) => f.kind === "turn").length;
  }

  private tokens(rec: ConvRecord): number {
    return rec.store
      .list()
      .reduce((sum, f) => sum + (f.deleted ? 0 : f.tokenEstimate), 0);
  }

  private create(key: string | null): ConvRecord {
    const rec: ConvRecord = {
      id: `c${++this.convCounter}`,
      key,
      lastIngestAt: null,
      lastIngestSeq: 0,
      suspicious: null,
      snapshot: null,
      store: null as unknown as FrameStore,
    };
    rec.store = new FrameStore(this.adapterFor(rec));
    this.convs.push(rec);
    return rec;
  }

  private adapterFor(rec: ConvRecord): Persistence | null {
    if (!this.path) return null; // pure in-memory registry (tests)
    return {
      load: () => rec.snapshot,
      save: (snap: StoreSnapshot) => {
        rec.snapshot = snap;
        this.persist();
      },
    };
  }

  private loadFile(): RegistryFile | null {
    if (!this.path) return null;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null; // fresh start
      throw new Error(
        `context-composer: cannot read store at ${this.path}: ${String(e)}`,
      );
    }
    // Corrupt/partial state must FAIL LOUDLY — never silently start from empty.
    let parsed: RegistryFile;
    try {
      parsed = JSON.parse(raw) as RegistryFile;
    } catch (e) {
      throw new Error(
        `context-composer: store at ${this.path} is corrupt (invalid JSON). ` +
          `Refusing to start from empty state — move or delete it to reset. (${String(e)})`,
      );
    }
    if (parsed.version !== REGISTRY_VERSION) {
      throw new Error(
        `context-composer: store at ${this.path} has version ${parsed.version}, ` +
          `expected ${REGISTRY_VERSION}. No migrations — move or delete it to reset.`,
      );
    }
    for (const c of parsed.conversations) {
      if (c.store.version !== SNAPSHOT_VERSION) {
        throw new Error(
          `context-composer: conversation ${c.id} in ${this.path} has snapshot version ` +
            `${c.store.version}, expected ${SNAPSHOT_VERSION}. Move or delete the file to reset.`,
        );
      }
    }
    return parsed;
  }

  private persist(): void {
    if (!this.path) return;
    const file: RegistryFile = {
      version: REGISTRY_VERSION,
      convCounter: this.convCounter,
      ingestSeq: this.ingestSeq,
      // Only conversations that have persisted content; the never-ingested eager
      // default has nothing worth writing.
      conversations: this.convs
        .filter((r) => r.snapshot !== null)
        .map((r) => ({
          id: r.id,
          key: r.key,
          lastIngestAt: r.lastIngestAt,
          lastIngestSeq: r.lastIngestSeq,
          suspicious: r.suspicious,
          store: r.snapshot!,
        })),
    };
    atomicWriteFile(this.path, canonicalStringify(stripCacheControlDeep(file)));
  }
}
