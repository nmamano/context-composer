// Durable store (design.md §11 Phase 2, §5.D `persist`). JSON-on-disk via the SAME
// canonical serializer that backs the cache story — so store bytes are deterministic
// and `cache_control` stays normalized OUT of serialization (Phase 1 gotcha), keeping
// stored wire content consistent with what compose emits. Reload → compose is therefore
// byte-identical to pre-restart compose.
//
// Scope guard: one snapshot file, full rewrite on each mutation. No migrations, no
// incremental log, no indexing — the tracer slice doesn't need them, and the daemon is
// single-agent so a tiny sync write per turn is negligible.

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalStringify, stripCacheControlDeep } from "./canonical.ts";
import type { Commit } from "./commit-graph.ts";
import type { ContextEvent } from "./event-log.ts";
import type { Frame, RequestEnvelope } from "./types.ts";

/** Bump only with an explicit migration. Phase 2 refuses to load a foreign version
 *  rather than guessing (no migrations in scope). v2 added the event log. */
// v3 (§11 Phase 3a): Frame gains the optional `representation` override.
// v4 (§11 Phase 3b): Frame gains `offloaded` + `fileReference`.
// v5 (§11 Phase 3c): Frame gains `origin` + `placement` + `absorbedInto` +
// `splitInto`.
// v6 (§11 Phase 3d): Frame gains `summary` display metadata. No migrations —
// older stores fail loudly per policy.
// v6 ALSO carries (additive optional, no version bump per the F-052 precedent):
// ContextEvent.direction (F-052) and Frame.enrichment (F-062, the auto-metadata
// ownership record) — older v6 files simply lack them and degrade gracefully
// (legacy event rendering; fill-only enrichment).
// v7 (op rename, task 97ad0626): commit/event op-kind values strip → drop-results,
// summarize → summarize-results. Persisted commits/events carry these strings, so a
// v6 store holding a historical strip/summarize commit would load but then refuse to
// revert/round-trip it (unknown kind). Bump so older stores fail loudly per policy,
// not silently. No migrations — move or delete the file to reset.
export const SNAPSHOT_VERSION = 7;

/** The whole durable state. Internal seq fields (createdAt/modifiedAt/seq) live here —
 *  they belong in the store but never on the wire (compose strips them out already). */
export interface StoreSnapshot {
  version: number;
  preamble: Frame | null;
  frames: Frame[];
  envelope: RequestEnvelope;
  commits: Commit[];
  head: string | null;
  events: ContextEvent[];
  seq: number;
  turnCounter: number;
  commitCounter: number;
  eventCounter: number;
}

/** The port FrameStore persists through. `null` (no persistence) = pure in-memory,
 *  which is the Phase 1 behavior and the default for tests. */
export interface Persistence {
  load(): StoreSnapshot | null;
  save(snap: StoreSnapshot): void;
}

export class JsonFileStore implements Persistence {
  constructor(private readonly path: string) {}

  load(): StoreSnapshot | null {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null; // fresh start
      throw new Error(
        `context-composer: cannot read store at ${this.path}: ${String(e)}`,
      );
    }
    // Corrupt/partial state must FAIL LOUDLY — never silently start from empty (which
    // would look like "all your frames vanished"). Tell the user how to reset.
    let parsed: StoreSnapshot;
    try {
      parsed = JSON.parse(raw) as StoreSnapshot;
    } catch (e) {
      throw new Error(
        `context-composer: store at ${this.path} is corrupt (invalid JSON). ` +
          `Refusing to start from empty state — move or delete it to reset. (${String(e)})`,
      );
    }
    if (parsed.version !== SNAPSHOT_VERSION) {
      throw new Error(
        `context-composer: store at ${this.path} has version ${parsed.version}, ` +
          `expected ${SNAPSHOT_VERSION}. No migrations in Phase 2 — move or delete it to reset.`,
      );
    }
    return parsed;
  }

  save(snap: StoreSnapshot): void {
    // Deterministic bytes + cache_control normalized out (the field is the provider's,
    // not semantic). Source fingerprints are already cache-control-free, so this only
    // normalizes STORED wire content and leaves identity stable across reload.
    atomicWriteFile(this.path, canonicalStringify(stripCacheControlDeep(snap)));
  }
}

/** Atomic-ish durable write, shared by the single-store file and the conversation
 *  registry file: write a same-dir temp, fsync, rename over the target. Same-dir keeps
 *  the rename on one filesystem (atomic); a crash mid-write leaves the old file intact.
 *  Throws a CLEAR error (in-memory state stays intact, callers turn it into a clean 5xx). */
export function atomicWriteFile(path: string, bytes: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  try {
    // 0600: the store holds conversation content (including captured model reasoning).
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    // Never leave a partial temp behind.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort — the temp is gitignored and pid-scoped */
    }
    throw new Error(`context-composer: failed to persist store at ${path}: ${String(e)}`);
  }
}
