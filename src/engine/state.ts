// FrameStore — the authoritative, in-memory frame state (design.md §11 "long-lived
// proxy daemon holds the authoritative frame state"). The proxy mutates it on every
// /v1/messages; the CLI mutates it through the control API. There is ONE live state;
// CLI and proxy share it in-process, not through disk (locked decision). Phase 2
// adds the durable JSON store + commit graph on top of this — deliberately not here.

import type {
  DecomposedFrame,
  Frame,
  RequestEnvelope,
  WireMessage,
} from "./types.ts";
import { decompose } from "./decompose.ts";
import { reconcile } from "./reconcile.ts";
import { compose, type ComposeResult } from "./compose.ts";
import { fingerprintHead } from "./fingerprint.ts";
import { estimateTokens } from "./tokens.ts";
import type { CapturedAssistant } from "./sse.ts";

export interface FrameSummary {
  id: string;
  kind: Frame["kind"];
  role: Frame["role"];
  title: string;
  tokenEstimate: number;
  deleted: boolean;
  messageCount: number;
}

export class FrameStore {
  private preamble: Frame | null = null;
  private frames: Frame[] = []; // turn frames in order, including tombstones
  private envelope: RequestEnvelope = {};
  private seq = 0;
  private turnCounter = 0;

  /** Ingest one rendered request: decompose → refresh head → reconcile turn frames. */
  ingest(body: Record<string, unknown>): void {
    const { system, tools, injectedSystem, envelope, frames } = decompose(body);
    this.envelope = envelope;

    const headFp = fingerprintHead(system, tools);
    if (!this.preamble) {
      this.preamble = {
        id: "p0",
        kind: "preamble",
        role: "system",
        title: "preamble (system + tools)",
        anchorFp: headFp,
        occurrence: 0,
        messages: [],
        system,
        tools,
        injectedSystem,
        tokenEstimate: estimateTokens(system) + estimateTokens(tools),
        deleted: false,
        createdAt: ++this.seq,
        modifiedAt: this.seq,
      };
    } else if (!this.preamble.deleted) {
      // Refresh head content. In practice the head is stable (that's the cache
      // contract); refreshing simply captures any change the agent makes.
      this.preamble.system = system;
      this.preamble.tools = tools;
      this.preamble.injectedSystem = injectedSystem;
      this.preamble.anchorFp = headFp;
      this.preamble.tokenEstimate =
        estimateTokens(system) + estimateTokens(tools);
    }

    reconcile(this.frames, frames, {
      makeFrame: (inc) => this.makeFrame(inc),
      estimate: (m) => estimateTokens(m),
      nextSeq: () => ++this.seq,
    });
  }

  private makeFrame(inc: DecomposedFrame): Frame {
    const occurrence = this.frames.filter(
      (f) => f.anchorFp === inc.anchorFp,
    ).length;
    return {
      id: `t${++this.turnCounter}`,
      kind: "turn",
      role: inc.role,
      title: `frame t${this.turnCounter}`, // placeholder; titling deferred (Phase 3)
      anchorFp: inc.anchorFp,
      occurrence,
      messages: inc.messages,
      stopReason: null,
      tokenEstimate: estimateTokens(inc.messages),
      deleted: false,
      createdAt: ++this.seq,
      modifiedAt: this.seq,
    };
  }

  compose(): ComposeResult {
    return compose(this.preamble, this.frames, this.envelope);
  }

  /** The frame currently awaiting an assistant response (last non-deleted turn
   *  frame). Captured at forward time so the capture has an EXPLICIT target and can't
   *  attach to whatever frame happens to be last when the async capture resolves. */
  openFrameId(): string | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (!this.frames[i]!.deleted) return this.frames[i]!.id;
    }
    return null;
  }

  /** Attach a captured assistant response to a SPECIFIC frame (its id captured at
   *  forward time), so `list`/`show` reflect it immediately — before the agent resends
   *  it next turn. On that resend, reconcile refreshes the frame from the authoritative
   *  copy. No-op if the target vanished or was deleted meanwhile. */
  captureAssistant(captured: CapturedAssistant, targetId: string | null): void {
    if (!targetId) return;
    const target = this.frames.find((f) => f.id === targetId);
    if (!target || target.deleted) return;
    target.messages = [...target.messages, captured.message];
    target.stopReason = captured.stopReason;
    target.tokenEstimate = estimateTokens(target.messages);
    target.modifiedAt = ++this.seq;
  }

  // ---- control surface (CLI calls these via the proxy's /control/* routes) ----

  list(): FrameSummary[] {
    const out: FrameSummary[] = [];
    if (this.preamble) out.push(this.summarize(this.preamble));
    for (const f of this.frames) out.push(this.summarize(f));
    return out;
  }

  private summarize(f: Frame): FrameSummary {
    return {
      id: f.id,
      kind: f.kind,
      role: f.role,
      title: f.title,
      tokenEstimate: f.tokenEstimate,
      deleted: f.deleted,
      messageCount: f.messages.length,
    };
  }

  show(id: string): Frame | null {
    if (this.preamble && this.preamble.id === id) return this.preamble;
    return this.frames.find((f) => f.id === id) ?? null;
  }

  /** Delete = tombstone. Returns the ids actually marked. */
  delete(ids: string[]): string[] {
    const marked: string[] = [];
    for (const id of ids) {
      const f = this.show(id);
      if (f && !f.deleted) {
        f.deleted = true;
        f.modifiedAt = ++this.seq;
        marked.push(id);
      }
    }
    return marked;
  }
}
