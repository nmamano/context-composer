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

function forwardRequestHeaders(incoming: Headers): Headers {
  const h = new Headers();
  incoming.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) h.set(key, value);
  });
  h.set("content-type", "application/json");
  return h;
}

function passthroughResponseHeaders(upstream: Headers): Headers {
  const h = new Headers();
  upstream.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) h.set(key, value);
  });
  return h;
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
