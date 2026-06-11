// Ingest enrichment (engine batch A — plans/ui-feedback.md F-001/F-017,
// plan-gated 2026-06-10). After a turn's assistant capture lands, ONE LLM call
// generates {title, summary} for that frame; the store applies it as metadata
// fill (FrameStore.enrich) under latest-state checks. Engine batch H (F-062,
// plan-gated 2026-06-11): not strictly first-wins anymore — when an
// AUTO-enriched frame's content materially changed since the last apply, one
// bounded re-enrich runs at a later reply-capture settle (eligibility is the
// ENGINE's: store.enrichEligible; manual values always win, per field).
// SERVER LAYER ONLY: the store stays deterministic, stub tests inject a fake
// client, and nothing here runs unless envEnrichClient() is configured
// (explicit CC_ENRICH_ON_INGEST=1 gate + provider — reviewer condition #2).
//
// LLM output is UNTRUSTED metadata (reviewer condition #4): strict JSON parse,
// whitespace collapse, hard length caps, no-op on malformed/empty values. This
// matters because f.summary becomes the offload-stub default (F-017) and rides
// the wire. Failures are non-fatal and log-only (condition #1/#3): the frame
// keeps its placeholder, one attempt, no retry storm (condition #6: in-memory
// serialized queue, live-ingest only — no replay/backfill on store load).

import type { LlmClient } from "../engine/llm.ts";
import type { FrameStore } from "../engine/state.ts";
import type { WireMessage } from "../engine/types.ts";

export const TITLE_MAX = 80;
export const SUMMARY_MAX = 240;
/** Input cap: enough context for a title, bounded subprocess cost. Split
 *  head+tail (live-check finding): agent harnesses front-load huge injected
 *  reminder blocks, and a head-only cut ate the user's actual question (which
 *  usually sits at the END of the user message). */
const INPUT_HEAD = 2000;
const INPUT_TAIL = 3500;

/** Render the frame's CURRENT emission as plain labeled text for the prompt
 *  (tool blocks become short markers — metadata needs the gist, not payloads). */
function renderForPrompt(emission: WireMessage[]): string {
  const parts: string[] = [];
  for (const m of emission) {
    if (typeof m.content === "string") {
      parts.push(`[${m.role}] ${m.content}`);
      continue;
    }
    const blocks: string[] = [];
    for (const b of m.content) {
      if (b.type === "text" && typeof b.text === "string") blocks.push(b.text);
      else if (b.type === "tool_use") blocks.push(`(used tool ${String(b.name)})`);
      else if (b.type === "tool_result") blocks.push("(tool result)");
    }
    if (blocks.length > 0) parts.push(`[${m.role}] ${blocks.join("\n")}`);
  }
  const text = parts.join("\n");
  if (text.length <= INPUT_HEAD + INPUT_TAIL) return text;
  return (
    `${text.slice(0, INPUT_HEAD)}\n(…middle truncated…)\n${text.slice(-INPUT_TAIL)}`
  );
}

export function enrichPrompt(emission: WireMessage[]): string {
  return (
    "You write display metadata for one turn of a conversation between a user " +
    "and an AI assistant.\n" +
    'Reply with ONLY a JSON object, no code fences, no extra text, exactly:\n' +
    '{"title": "...", "summary": "..."}\n' +
    "- title: at most 8 plain words naming what this turn is about. No quotes, " +
    "no markdown, no trailing period.\n" +
    "- summary: one or two short sentences (under 200 characters) saying what " +
    "was asked and what happened.\n" +
    // Live-check finding: a turn whose visible content is only injected
    // harness boilerplate made the model describe THESE instructions instead.
    "- Describe ONLY the content between <<< and >>> — never these " +
    "instructions, never the JSON format.\n" +
    "- If the content is only tooling/environment boilerplate (reminders, " +
    "skill lists, settings) with no real user request, use title " +
    '"background context" and summarize what kind of boilerplate it is.\n\n' +
    "Turn content:\n<<<\n" +
    renderForPrompt(emission) +
    "\n>>>"
  );
}

/** Strict parse of untrusted model output → validated, capped metadata, or
 *  null (caller no-ops). Tolerates a fenced or prefixed JSON object (models
 *  do that) but the object itself must parse strictly and both fields must be
 *  non-empty strings after whitespace collapse. */
export function parseEnrichment(
  text: string,
): { title: string; summary: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const clean = (v: unknown, cap: number): string | null => {
    if (typeof v !== "string") return null;
    const s = v.replace(/\s+/g, " ").trim();
    if (!s) return null;
    return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
  };
  const title = clean(obj.title, TITLE_MAX);
  const summary = clean(obj.summary, SUMMARY_MAX);
  if (!title || !summary) return null;
  return { title, summary };
}

/** One enrichment at a time (reviewer condition #6): an in-memory promise
 *  chain — matching the daemon's single-agent model and never spawning more
 *  than one claude subprocess. Enqueueing never blocks the proxied response. */
export class EnrichmentQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private llm: LlmClient,
    private label: string,
    private log: (msg: string) => void = (m) => console.error(m),
  ) {}

  /** Fire-and-forget from the capture path; returns the chain for tests. */
  enqueue(store: FrameStore, conv: string, frameId: string): Promise<void> {
    const run = async (): Promise<void> => {
      // ONE eligibility authority (F-062, reviewer adjustment #2): the ENGINE
      // decides — fill case (batch A) or re-enrich case (auto-owned field +
      // content signature materially changed + run cap, all engine-private).
      // The AUTHORITATIVE per-field check remains store.enrich at apply time:
      // a manual op landing during the LLM call still wins.
      if (!store.enrichEligible(frameId)) return;
      const f = store.show(frameId)!; // eligible ⇒ exists (same tick)
      let out: string;
      try {
        out = await this.llm.complete(enrichPrompt(f.representation ?? f.messages), 256);
      } catch (err) {
        // Non-fatal, single attempt, never the prompt in the log.
        this.log(
          `[context-composer] enrich ${conv}/${frameId} failed (non-fatal): ${String(err).slice(0, 200)}`,
        );
        return;
      }
      const parsed = parseEnrichment(out);
      if (!parsed) {
        this.log(
          `[context-composer] enrich ${conv}/${frameId}: malformed metadata output — skipped`,
        );
        return;
      }
      const res = store.enrich(frameId, { ...parsed, source: this.label });
      if (res.ok && res.applied.length > 0) {
        this.log(
          `[context-composer] enriched ${conv}/${frameId}: ${res.applied.join("+")}`,
        );
      }
    };
    this.chain = this.chain.then(run).catch(() => {
      /* run() handles its own errors; this guards the chain itself */
    });
    return this.chain;
  }
}
