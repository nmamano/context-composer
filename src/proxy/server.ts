// The proxy daemon — the rendered-context boundary (design.md Appendix B) AND the
// control API the CLI drives. One Bun.serve, routed by path:
//   POST /v1/messages   → intercept: ingest → compose → forward → capture
//   /control/*          → list / show / delete / compose for the `ctx` CLI
//
// Both surfaces share ONE in-memory FrameStore in this process: the CLI mutates the
// exact state the proxy composes from on the next request (locked decision — no
// disk-only coordination).

import { PROXY_PORT } from "../config.ts";
import { FrameStore } from "../engine/state.ts";
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

export function startProxy(opts: {
  port?: number;
  upstreamBaseUrl?: string;
} = {}): ProxyHandle {
  const store = new FrameStore();
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

    store.ingest(body);
    const composed = store.compose();
    // Bind the capture to the frame open RIGHT NOW (explicit target), not to
    // whatever is last when the capture promise later resolves.
    const targetId = store.openFrameId();

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

    return json({ error: `unknown control route ${path}` }, 404);
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
if (import.meta.main) {
  const handle = startProxy();
  console.error(
    `[context-composer] proxy + control API on http://localhost:${handle.port}\n` +
      `  point the wrapped agent at it:  ANTHROPIC_BASE_URL=http://localhost:${handle.port}\n` +
      `  drive frames with:              bun run src/cli/ctx.ts list`,
  );
}
