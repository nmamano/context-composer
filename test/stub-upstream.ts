// A stub Anthropic upstream for tests — no API key, fully deterministic. It records
// every request body it receives (so tests can assert exactly what the proxy
// forwarded after rewriting) and replies with a programmed SSE stream from a queue.

export interface RespSpec {
  /** Emit a thinking block: start event, then a thinking_delta per non-empty `text`,
   *  then a signature_delta per non-empty `signature`. A start with NO deltas (text:""
   *  and no signature) reproduces the real husk-producing stream shape (§11 Phase 2.6). */
  thinking?: { text?: string; signature?: string };
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
  stopReason: string;
}

function ev(obj: Record<string, unknown>): string {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

export function makeSSE(spec: RespSpec): string {
  let out = ev({
    type: "message_start",
    message: {
      id: "msg_stub",
      type: "message",
      role: "assistant",
      content: [],
      model: "stub",
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  let idx = 0;
  if (spec.thinking) {
    out += ev({
      type: "content_block_start",
      index: idx,
      content_block: { type: "thinking", thinking: "" },
    });
    if (spec.thinking.text) {
      out += ev({
        type: "content_block_delta",
        index: idx,
        delta: { type: "thinking_delta", thinking: spec.thinking.text },
      });
    }
    if (spec.thinking.signature) {
      out += ev({
        type: "content_block_delta",
        index: idx,
        delta: { type: "signature_delta", signature: spec.thinking.signature },
      });
    }
    out += ev({ type: "content_block_stop", index: idx });
    idx++;
  }
  if (spec.text !== undefined) {
    out += ev({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    out += ev({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: spec.text } });
    out += ev({ type: "content_block_stop", index: idx });
    idx++;
  }
  if (spec.toolUse) {
    out += ev({
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id: spec.toolUse.id, name: spec.toolUse.name, input: {} },
    });
    out += ev({
      type: "content_block_delta",
      index: idx,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(spec.toolUse.input) },
    });
    out += ev({ type: "content_block_stop", index: idx });
    idx++;
  }
  out += ev({ type: "message_delta", delta: { stop_reason: spec.stopReason }, usage: { output_tokens: 1 } });
  out += ev({ type: "message_stop" });
  return out;
}

/** A non-owned request the stub received via the proxy's transparent passthrough — recorded
 *  so Phase 2.5 tests can assert exactly what the proxy forwarded (method/path/query/body and
 *  the full header map, since header fidelity is the contract). */
export interface NonOwnedRecord {
  method: string;
  path: string;
  search: string;
  body: string;
  headers: Record<string, string>;
}

/** A canned response the stub returns for the next non-owned request. */
export interface PassthroughResp {
  status?: number;
  contentType?: string;
  body: string;
}

export interface StubUpstream {
  baseUrl: string;
  received: Array<Record<string, unknown>>;
  /** Non-owned requests that arrived via passthrough (anything but `POST /v1/messages`). */
  nonOwned: NonOwnedRecord[];
  enqueue: (spec: RespSpec) => void;
  /** Program the response the stub returns for the next non-owned (passthrough) request. */
  enqueuePassthrough: (resp: PassthroughResp) => void;
  stop: () => void;
}

export function startStubUpstream(): StubUpstream {
  const received: Array<Record<string, unknown>> = [];
  const nonOwned: NonOwnedRecord[] = [];
  const queue: RespSpec[] = [];
  const passthroughQueue: PassthroughResp[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        received.push((await req.json()) as Record<string, unknown>);
        const spec = queue.shift() ?? { text: "(no programmed response)", stopReason: "end_turn" };
        return new Response(makeSSE(spec), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      // Non-owned route: this is what the proxy's transparent passthrough hits. Record the
      // request verbatim, then reply with the next programmed passthrough response.
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      nonOwned.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        body: await req.text(),
        headers,
      });
      const resp = passthroughQueue.shift() ?? { body: "" };
      return new Response(resp.body, {
        status: resp.status ?? 200,
        headers: { "content-type": resp.contentType ?? "application/json" },
      });
    },
  });

  return {
    baseUrl: `http://localhost:${server.port}`,
    received,
    nonOwned,
    enqueue: (spec) => queue.push(spec),
    enqueuePassthrough: (resp) => passthroughQueue.push(resp),
    stop: () => server.stop(true),
  };
}
