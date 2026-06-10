// Wiretap — per-request raw wire evidence (design.md §11 Phase 2.6).
//
// Every owned /v1/messages exchange is appended to a JSONL file: the EXACT inbound
// body the agent sent (pre-decompose), the EXACT outbound body we composed, redacted
// headers, wire warnings, and the upstream status (+ error body on non-2xx).
// Passthrough traffic gets a light line (method/path/status, no bodies — uploads can
// be huge and they are not ours to argue about).
//
// Why this exists: the §11 Phase 2.6 investigation spent two sessions theorizing about which
// transformation made the provider reject a request, because nobody kept the bytes.
// With the tap, "what did we change?" is a diff between two fields of one log line,
// and "would the original have passed?" is a byte-exact replay of `inbound.rawBody`.
// Instrument first; debate never.
//
// Secrets: header values for authorization/x-api-key/cookie are REDACTED before they
// touch disk. Bodies are conversation content — the same content the store already
// persists locally; the tap file is gitignored like the store.

import { appendFileSync } from "node:fs";

const REDACT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

/** Belt-and-braces: any header NAME that smells secret-bearing is redacted too. */
const REDACT_NAME_PATTERN = /token|secret|credential|cookie|auth|(^|[-_])key($|[-_])/i;

export function redactHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    const k = key.toLowerCase();
    out[key] =
      REDACT_HEADERS.has(k) || REDACT_NAME_PATTERN.test(k) ? "<redacted>" : value;
  });
  return out;
}

export class Wiretap {
  constructor(private readonly path: string) {}

  /** Append one entry. Best-effort: a logging failure must never break the proxy.
   *  Created 0600 — the tap holds conversation content (including model reasoning
   *  text); it is local evidence, not something to share. */
  record(entry: Record<string, unknown>): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (e) {
      console.error(`[context-composer] wiretap write failed: ${String(e)}`);
    }
  }
}
