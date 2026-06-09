// Forward a composed request to the upstream model API and capture the response.
//
// The response is teed (decision C): one branch is returned to the caller byte-for-
// byte (true SSE passthrough, no buffering on the hot path), the other is drained to
// reconstruct the assistant message for frame capture. Non-streaming JSON responses
// go through the same capture shape.
//
// We forward the body as canonical bytes — the same serializer that backs the cache
// determinism guarantee, so what we hash is what we send.

import { UPSTREAM_BASE_URL } from "../config.ts";
import { canonicalStringify } from "../engine/canonical.ts";
import {
  reconstructFromJSON,
  reconstructFromSSE,
  type CapturedAssistant,
} from "../engine/sse.ts";

export interface ForwardResult {
  response: Response; // pass straight back to the caller
  capture: Promise<CapturedAssistant | null>;
}

// Hop-by-hop / length headers we must not blindly forward; fetch manages them.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "connection",
  "transfer-encoding",
]);

/** Copy headers, dropping any whose lowercased name is in `strip`. The single home for the
 *  hop-by-hop policy, shared by the owned `/v1/messages` forward and the transparent
 *  passthrough so the two can't drift. */
function stripHopByHop(incoming: Headers, strip: Set<string>): Headers {
  const h = new Headers();
  incoming.forEach((value, key) => {
    if (!strip.has(key.toLowerCase())) h.set(key, value);
  });
  return h;
}

/** Header names enumerated by an incoming `Connection:` value (RFC 7230 §6.1) — e.g.
 *  `Connection: keep-alive, X-Foo` makes `x-foo` hop-by-hop. Honored on the passthrough
 *  path only; owned forwarding keeps its fixed strip set unchanged. */
function connectionScopedNames(incoming: Headers): string[] {
  const conn = incoming.get("connection");
  if (!conn) return [];
  return conn.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function forwardRequestHeaders(incoming: Headers): Headers {
  // Owned `/v1/messages` forward: strip hop-by-hop, then force JSON (we re-serialize the
  // composed body canonically, so the content-type is always application/json here).
  const h = stripHopByHop(incoming, STRIP_REQUEST_HEADERS);
  h.set("content-type", "application/json");
  return h;
}

function passthroughResponseHeaders(upstream: Headers): Headers {
  return stripHopByHop(upstream, STRIP_RESPONSE_HEADERS);
}

export async function forward(
  body: Record<string, unknown>,
  incomingHeaders: Headers,
  upstreamBaseUrl: string = UPSTREAM_BASE_URL,
): Promise<ForwardResult> {
  const res = await fetch(`${upstreamBaseUrl}/v1/messages`, {
    method: "POST",
    headers: forwardRequestHeaders(incomingHeaders),
    body: canonicalStringify(body),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const headers = passthroughResponseHeaders(res.headers);

  if (res.body && contentType.includes("text/event-stream")) {
    const [toCaller, toCapture] = res.body.tee();
    const capture = (async (): Promise<CapturedAssistant | null> => {
      const raw = await new Response(toCapture).text();
      return reconstructFromSSE(raw);
    })();
    return {
      response: new Response(toCaller, {
        status: res.status,
        statusText: res.statusText,
        headers,
      }),
      capture,
    };
  }

  // Non-streaming (JSON) or error: buffer, capture only well-formed messages.
  const text = await res.text();
  let capture: Promise<CapturedAssistant | null> = Promise.resolve(null);
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    if (json && json.type === "message") {
      capture = Promise.resolve(reconstructFromJSON(json));
    }
  } catch {
    /* not JSON — nothing to capture (pass the error body through untouched) */
  }
  return {
    response: new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers,
    }),
    capture,
  };
}

/**
 * Transparent passthrough for any request the proxy does NOT own (anything other than the
 * rewritten `POST /v1/messages` and the local `/control/*` API). The request is piped to the
 * real upstream untouched — same method, path, query, and application headers — and the
 * upstream response is streamed straight back. This path deliberately BYPASSES the engine:
 * no ingest, no compose, no FrameStore / commit-log / capture. It exists so a real
 * interactive TUI (which hits endpoints `-p` never does, e.g. token counting) round-trips
 * cleanly instead of 404ing (design.md §11, Phase 2.5).
 *
 * Transport, not transparent-to-the-byte: `fetch` still manages hop-by-hop headers and
 * content-length, and we drop connection-scoped headers. What we guarantee is a byte-exact
 * payload plus verbatim method/path/query/auth — which is all passthrough needs. Request
 * bodies are buffered (non-owned bodies like count_tokens are tiny); the RESPONSE is always
 * streamed, never buffered, so SSE passes through live.
 */
export async function passthrough(
  req: Request,
  upstreamBaseUrl: string = UPSTREAM_BASE_URL,
): Promise<Response> {
  const url = new URL(req.url);
  // Normalize a possible trailing slash so path + query are preserved exactly.
  const base = upstreamBaseUrl.replace(/\/+$/, "");
  const target = `${base}${url.pathname}${url.search}`;

  // Strip the fixed hop-by-hop set PLUS anything named by an incoming `Connection:` header.
  const strip = new Set(STRIP_REQUEST_HEADERS);
  strip.add("connection");
  for (const name of connectionScopedNames(req.headers)) strip.add(name);
  const headers = stripHopByHop(req.headers, strip);

  // GET/HEAD carry no body; other methods forward their bytes verbatim. A 0-byte body is sent
  // as none, so we never attach an empty body where the client sent nothing.
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    const buf = await req.arrayBuffer();
    body = buf.byteLength > 0 ? buf : undefined;
  }

  let res: Response;
  try {
    res = await fetch(target, { method: req.method, headers, body });
  } catch (err) {
    // Upstream unreachable — the error path can't be transparent, so surface it cleanly
    // (mirrors the owned forward's 502) rather than as a raw 500.
    return new Response(
      JSON.stringify({ error: "upstream passthrough failed", detail: String(err) }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  // Stream the response body straight back — some upstream responses are SSE; do NOT buffer.
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: passthroughResponseHeaders(res.headers),
  });
}
