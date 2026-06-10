// The proxy daemon — the rendered-context boundary (design.md Appendix B) AND the
// control API the CLI drives. One Bun.serve, routed by path:
//   POST /v1/messages   → intercept: route to conversation → ingest → compose →
//                         forward → capture (+ wiretap evidence, §11 Phase 2.6)
//   /control/*          → list / show / delete / compose / conversations for `ctx`
//   (anything else)     → transparent passthrough to the real upstream (design.md §11,
//                         Phase 2.5): a dumb pipe that bypasses the engine entirely
//
// A real interactive agent multiplexes SEVERAL conversations over /v1/messages (main
// thread + title/recap/quota side queries), so the engine state is a
// ConversationRegistry — one FrameStore per conversation (§11 Phase 2.6). The CLI mutates the
// exact store the proxy composes from on the next request (locked decision — no
// disk-only coordination); by default it targets the ACTIVE conversation, with
// ?conv=<id> to override.

import { PROXY_PORT, STORE_PATH, WIRETAP_PATH } from "../config.ts";
import { ConversationRegistry } from "../engine/registry.ts";
import type { FrameStore } from "../engine/state.ts";
import type { Commit } from "../engine/commit-graph.ts";
import type { ContextEvent } from "../engine/event-log.ts";
import { forward, passthrough } from "./forward.ts";
import { redactHeaders, Wiretap } from "./wiretap.ts";

export interface ProxyHandle {
  /** The ACTIVE conversation's store (the curated main thread) — the single-store
   *  Phase ≤2.5 surface, preserved for tests and library callers. */
  readonly store: FrameStore;
  registry: ConversationRegistry;
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
  /** Path to the durable JSON registry. Omit for pure in-memory state (the Phase 1
   *  behavior the tests rely on); the daemon entrypoint passes a real path. */
  storePath?: string;
  /** JSONL raw-evidence log (§11 Phase 2.6). Omit to disable (tests default off; daemon on). */
  wiretapPath?: string;
} = {}): ProxyHandle {
  const registry = new ConversationRegistry(opts.storePath ?? null);
  const wiretap = opts.wiretapPath ? new Wiretap(opts.wiretapPath) : null;
  // Tracks the in-flight response capture so control reads observe a consistent
  // state (e.g. `ctx list` right after a send reflects the captured assistant).
  let lastCapture: Promise<void> = Promise.resolve();

  async function handleMessages(req: Request): Promise<Response> {
    // Keep the RAW inbound bytes: the wiretap's purpose is byte-exact replay evidence
    // ("would the original have passed?"), so we log what arrived, not our re-parse.
    const rawBody = await req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    // Apply the previous request's async capture BEFORE ingesting the next request,
    // so reconcile sees a settled state. NOTE: this is a serialization CONVENTION for
    // the single-agent model (one in-flight /v1/messages at a time, with `ctx` calls
    // interleaved between turns), NOT a lock. Two concurrent /v1/messages would need a
    // real queue — out of scope for the single wrapped agent.
    await lastCapture;

    const conv = registry.route(body);
    const store = conv.store;

    let composed;
    let targetId;
    let view;
    let omittedFrameIds: string[];
    try {
      view = store.ingest(body); // also persists (session-ingest); may throw on a disk failure
      // §11 Phase 2.7: compose THIS REQUEST'S view — frames another request forked
      // into the store never ride along. Record the attempted-outbound view right
      // after composing (before forward, so even a 502'd request counts — it is
      // what we composed for the wire, and the wiretap entry below matches it).
      composed = store.compose(view);
      store.noteEmittedView(view);
      // Bind the capture to the VIEW's open frame (explicit target) — not the store
      // tail, and not whatever is last when the capture promise later resolves: a
      // fork's reply must land on the fork's own open frame.
      targetId = view.openFrameId;
      // Store turn frames OUTSIDE this request's view — unmatched: fork-only frames
      // and tombstones the request didn't resend. NOT "every frame omitted from
      // messages": tombstones INSIDE the view are also omitted from the body but
      // are matched, so they don't appear here.
      const inView = new Set(view.frameIds);
      omittedFrameIds = store
        .list()
        .filter((f) => f.kind === "turn" && !inView.has(f.id))
        .map((f) => f.id);
    } catch (err) {
      // A persistence failure leaves in-memory state intact but unsaved. Surface it
      // cleanly rather than as a raw 500 with a stack trace.
      return json({ error: "failed to ingest/persist request", detail: String(err) }, 500);
    }

    if (composed.wireWarnings.length > 0) {
      console.error(
        `[context-composer] wire warnings (conv ${conv.id}, forwarding faithfully): ` +
          composed.wireWarnings
            .map((w) => `${w.issue}@msg${w.messageIndex}.${w.blockIndex}${w.signed ? "(signed)" : "(UNSIGNED)"}`)
            .join(" "),
      );
    }

    let forwarded;
    try {
      forwarded = await forward(composed.body, req.headers, opts.upstreamBaseUrl);
    } catch (err) {
      // Upstream is unreachable. The just-ingested frame stays in state with no
      // captured assistant; it self-heals on the agent's resend (reconcile re-matches
      // by fingerprint), so no duplication. Return a clean error rather than a raw 500.
      wiretap?.record({
        ts: new Date().toISOString(),
        kind: "messages",
        conv: conv.id,
        inbound: { headers: redactHeaders(req.headers), rawBody },
        outboundBody: composed.body,
        wireWarnings: composed.wireWarnings,
        viewFrameIds: view.frameIds,
        omittedFrameIds,
        upstreamStatus: null,
        upstreamError: String(err),
      });
      return json({ error: "upstream request failed", detail: String(err) }, 502);
    }
    const { response, capture, upstreamStatus, upstreamErrorBody } = forwarded;

    wiretap?.record({
      ts: new Date().toISOString(),
      kind: "messages",
      conv: conv.id,
      inbound: { headers: redactHeaders(req.headers), rawBody },
      outboundBody: composed.body,
      wireWarnings: composed.wireWarnings,
      // §11 Phase 2.7 live-validation surface: the frames this request's view
      // emitted vs the stored frames the request didn't carry (fork-only frames +
      // tombstones not resent) — the fork-isolation diff, visible per request.
      viewFrameIds: view.frameIds,
      omittedFrameIds,
      upstreamStatus,
      upstreamErrorBody,
    });

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
      if (path === "/control/conversations") {
        return json({ conversations: registry.summaries() });
      }

      // Every store-scoped route targets the ACTIVE conversation unless ?conv=<id>.
      const convId = url.searchParams.get("conv");
      const conv = registry.activeRecord(convId);
      if (!conv) return json({ error: `no conversation ${convId}` }, 404);
      const store = conv.store;

      if (path === "/control/list") return json({ conv: conv.id, frames: store.list() });

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
        return json({ conv: conv.id, deleted: store.delete(ids) });
      }

      if (path === "/control/compose") {
        // §11 Phase 2.7 semantics: the DEFAULT stays the full-store compose (stable
        // for tooling/scripts) with a viewNote stating fork-only frames may be
        // present that the next emission will exclude. ?view=last composes the last
        // emitted ("attempted outbound") view against the CURRENT store — a
        // view-scoped current representation, NOT a byte snapshot of the prior
        // outbound request (captures/edits that landed since are reflected).
        const viewParam = url.searchParams.get("view");
        const out: Record<string, unknown> = { conv: conv.id };
        let c;
        if (viewParam === "last") {
          const view = store.lastView();
          if (!view) {
            return json(
              {
                error:
                  `no emitted view for conversation ${conv.id} — views are derived ` +
                  `per request and never persisted (nothing emitted since startup)`,
              },
              404,
            );
          }
          c = store.compose(view);
          out.view = "last";
          out.viewFrameIds = view.frameIds;
        } else if (viewParam !== null) {
          return json({ error: `unknown view '${viewParam}' (supported: last)` }, 400);
        } else {
          c = store.compose();
          out.viewNote =
            "full-store compose: fork-only frames may be present that the next " +
            "emission will exclude; use ?view=last for the last emitted view";
        }
        const wantDump = url.searchParams.has("dump");
        const wantHash = url.searchParams.has("hashHead");
        if (wantDump || (!wantDump && !wantHash)) out.body = c.body;
        if (wantHash || (!wantDump && !wantHash)) {
          out.headHash = c.headHash;
          out.hasCacheBreakpoint = c.hasCacheBreakpoint;
        }
        out.wireWarnings = c.wireWarnings; // always surfaced (§11 Phase 2.6)
        return json(out);
      }

      if (path === "/control/history") {
        return json({ conv: conv.id, commits: store.history().map(publicCommit) });
      }

      if (path === "/control/timeline") {
        return json({ conv: conv.id, events: store.timeline().map(publicEvent) });
      }

      if (path === "/control/revert" && req.method === "POST") {
        const parsed = (await req.json().catch(() => null)) as
          | { commit?: string }
          | null;
        const result = store.revert(parsed?.commit);
        return result.ok
          ? json({ conv: conv.id, reverted: publicCommit(result.commit) })
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
      // Owned routes FIRST — they must never fall through to the transparent forward.
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        return handleMessages(req); // intercept → ingest → compose → forward → capture
      }
      if (url.pathname.startsWith("/control/")) {
        return handleControl(req, url); // local control API (its own 404 for unknown routes)
      }
      // Everything else is NOT ours: pipe it to the real upstream untouched and stream the
      // response back (Phase 2.5). No ingest, no compose, no engine touch. The wiretap
      // notes method/path/status only (no bodies — not ours to argue about).
      return passthrough(req, opts.upstreamBaseUrl).then((res) => {
        wiretap?.record({
          ts: new Date().toISOString(),
          kind: "passthrough",
          method: req.method,
          path: url.pathname + url.search,
          status: res.status,
        });
        return res;
      });
    },
  });

  return {
    get store() {
      return registry.activeStore();
    },
    registry,
    port: server.port ?? opts.port ?? PROXY_PORT,
    stop: () => server.stop(true),
  };
}

// Run as a daemon when invoked directly: `bun run src/proxy/server.ts`.
// The daemon persists to CC_STORE_PATH (default ./.ctx-store.json) so a restart resumes
// the conversation registry + commit graphs, and taps raw wire evidence to
// CC_WIRETAP_PATH (default ./.ctx-wiretap.jsonl).
if (import.meta.main) {
  const handle = startProxy({
    storePath: STORE_PATH,
    wiretapPath: WIRETAP_PATH,
  });
  console.error(
    `[context-composer] proxy + control API on http://localhost:${handle.port}\n` +
      `  point the wrapped agent at it:  ANTHROPIC_BASE_URL=http://localhost:${handle.port}\n` +
      `  durable store (registry):       ${STORE_PATH}\n` +
      `  wiretap (raw wire evidence):    ${WIRETAP_PATH}\n` +
      `  drive frames with:              bun run src/cli/ctx.ts list`,
  );
}
