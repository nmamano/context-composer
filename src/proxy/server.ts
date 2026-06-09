// The proxy daemon — the rendered-context boundary (design.md Appendix B) AND the
// control API the CLI drives. One Bun.serve, routed by path:
//   POST /v1/messages   → intercept: ingest → compose → forward → capture
//   /control/*          → list / show / delete / compose for the `ctx` CLI
//
// Both surfaces share ONE in-memory FrameStore in this process: the CLI mutates the
// exact state the proxy composes from on the next request (locked decision — no
// disk-only coordination).

import { PROXY_PORT, STORE_PATH } from "../config.ts";
import { FrameStore } from "../engine/state.ts";
import { JsonFileStore } from "../engine/store.ts";
import type { Commit } from "../engine/commit-graph.ts";
import type { ContextEvent } from "../engine/event-log.ts";
import { forward } from "./forward.ts";

export interface ProxyHandle {
  store: FrameStore;
  port: number;
  stop: () => void;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The public op-log shape exposed over the control API: the §7 commit fields, minus the
 *  internal `seq` logical clock (bookkeeping, not part of the user-facing record). */
function publicCommit(c: Commit) {
  return {
    id: c.id,
    type: c.type,
    affectedFrameIds: c.affectedFrameIds,
    params: c.params,
    note: c.note,
    branchId: c.branchId,
    parentCommitId: c.parentCommitId,
    timestamp: c.timestamp,
  };
}

/** The public timeline-event shape, minus the internal `seq`. */
function publicEvent(e: ContextEvent) {
  return {
    id: e.id,
    type: e.type,
    frameIds: e.frameIds,
    commitId: e.commitId,
    timestamp: e.timestamp,
  };
}

export function startProxy(opts: {
  port?: number;
  upstreamBaseUrl?: string;
  /** Path to the durable JSON store. Omit for pure in-memory state (the Phase 1
   *  behavior the tests rely on); the daemon entrypoint passes a real path. */
  storePath?: string;
} = {}): ProxyHandle {
  const store = new FrameStore(
    opts.storePath ? new JsonFileStore(opts.storePath) : null,
  );
  // Tracks the in-flight response capture so control reads observe a consistent
  // state (e.g. `ctx list` right after a send reflects the captured assistant).
  let lastCapture: Promise<void> = Promise.resolve();

  async function handleMessages(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    // Apply the previous request's async capture BEFORE ingesting the next request,
    // so reconcile sees a settled state. NOTE: this is a serialization CONVENTION for
    // the single-agent model (one in-flight /v1/messages at a time, with `ctx` calls
    // interleaved between turns), NOT a lock. Two concurrent /v1/messages would need a
    // real queue — out of scope for Phase 1's single wrapped agent.
    await lastCapture;

    let composed;
    let targetId;
    try {
      store.ingest(body); // also persists (session-ingest); may throw on a disk failure
      composed = store.compose();
      // Bind the capture to the frame open RIGHT NOW (explicit target), not to
      // whatever is last when the capture promise later resolves.
      targetId = store.openFrameId();
    } catch (err) {
      // A persistence failure leaves in-memory state intact but unsaved. Surface it
      // cleanly rather than as a raw 500 with a stack trace.
      return json({ error: "failed to ingest/persist request", detail: String(err) }, 500);
    }

    let forwarded;
    try {
      forwarded = await forward(composed.body, req.headers, opts.upstreamBaseUrl);
    } catch (err) {
      // Upstream is unreachable. The just-ingested frame stays in state with no
      // captured assistant; it self-heals on the agent's resend (reconcile re-matches
      // by fingerprint), so no duplication. Return a clean error rather than a raw 500.
      return json({ error: "upstream request failed", detail: String(err) }, 502);
    }
    const { response, capture } = forwarded;

    lastCapture = capture
      .then((c) => {
        if (c) store.captureAssistant(c, targetId);
      })
      .catch(() => {
        /* capture is best-effort; the live frame self-heals on the agent's resend */
      });

    return response;
  }

  async function handleControl(req: Request, url: URL): Promise<Response> {
    await lastCapture; // observe any just-finished capture
    const path = url.pathname;

    try {
    if (path === "/control/list") return json({ frames: store.list() });

    if (path === "/control/show") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing id" }, 400);
      const frame = store.show(id);
      return frame ? json(frame) : json({ error: `no frame ${id}` }, 404);
    }

    if (path === "/control/delete" && req.method === "POST") {
      const parsed = (await req.json().catch(() => null)) as
        | { ids?: string[] }
        | null;
      const ids = parsed?.ids ?? [];
      return json({ deleted: store.delete(ids) });
    }

    if (path === "/control/compose") {
      const c = store.compose();
      const wantDump = url.searchParams.has("dump");
      const wantHash = url.searchParams.has("hashHead");
      const out: Record<string, unknown> = {};
      if (wantDump || (!wantDump && !wantHash)) out.body = c.body;
      if (wantHash || (!wantDump && !wantHash)) {
        out.headHash = c.headHash;
        out.hasCacheBreakpoint = c.hasCacheBreakpoint;
      }
      return json(out);
    }

    if (path === "/control/history") {
      return json({ commits: store.history().map(publicCommit) });
    }

    if (path === "/control/timeline") {
      return json({ events: store.timeline().map(publicEvent) });
    }

    if (path === "/control/revert" && req.method === "POST") {
      const parsed = (await req.json().catch(() => null)) as
        | { commit?: string }
        | null;
      const result = store.revert(parsed?.commit);
      return result.ok
        ? json({ reverted: publicCommit(result.commit) })
        : json({ error: result.error }, 400);
    }

    return json({ error: `unknown control route ${path}` }, 404);
    } catch (err) {
      // A mutating control op (delete/revert) failed to persist. In-memory state is
      // intact but unsaved; report it cleanly instead of as a raw 500.
      return json({ error: "control operation failed", detail: String(err) }, 500);
    }
  }

  const server = Bun.serve({
    port: opts.port ?? PROXY_PORT,
    idleTimeout: 120, // SSE round-trips can outlast the 10s default
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        return handleMessages(req);
      }
      if (url.pathname.startsWith("/control/")) {
        return handleControl(req, url);
      }
      return json({ error: "not found" }, 404);
    },
  });

  return {
    store,
    port: server.port ?? opts.port ?? PROXY_PORT,
    stop: () => server.stop(true),
  };
}

// Run as a daemon when invoked directly: `bun run src/proxy/server.ts`.
// The daemon persists to CC_STORE_PATH (default ./.ctx-store.json) so a restart resumes
// the frame state + commit graph.
if (import.meta.main) {
  const handle = startProxy({ storePath: STORE_PATH });
  console.error(
    `[context-composer] proxy + control API on http://localhost:${handle.port}\n` +
      `  point the wrapped agent at it:  ANTHROPIC_BASE_URL=http://localhost:${handle.port}\n` +
      `  durable store:                  ${STORE_PATH}\n` +
      `  drive frames with:              bun run src/cli/ctx.ts list`,
  );
}
