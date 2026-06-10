// LLM port (§11 Phase 3d) — the pluggable backend for `--regen` on
// summarize/retitle/compact.
//
// Boundary rules (reviewer-locked):
//  - FrameStore stays DETERMINISTIC: the proxy/control layer calls this client
//    and feeds the resulting TEXT into the same manual store op path. A failed
//    or unconfigured regen fails BEFORE any commit/event/state mutation.
//  - Gates never depend on an API key: tests inject a stub client; the env
//    default below activates only when both variables are present.
//  - Determinism care (§11 Phase 3 risk note): temperature 0, capped tokens,
//    fixed prompt shape — regen output should not gratuitously churn.

export interface LlmClient {
  complete(prompt: string, maxTokens?: number): Promise<string>;
}

/** Env-configured Anthropic-backed client, or null when not configured (the
 *  caller surfaces a clear "set CC_LLM_API_KEY/CC_LLM_MODEL or use --text"
 *  error). Deliberately NO default model id — explicit configuration only. */
export function envLlmClient(): LlmClient | null {
  const apiKey = process.env.CC_LLM_API_KEY;
  const model = process.env.CC_LLM_MODEL;
  const baseUrl = process.env.CC_LLM_BASE_URL ?? "https://api.anthropic.com";
  if (!apiKey || !model) return null;
  return {
    async complete(prompt: string, maxTokens = 512): Promise<string> {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        throw new Error(`LLM call failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (json.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (!text) throw new Error("LLM returned no text content");
      return text.trim();
    },
  };
}

/** Fixed regen prompt shapes — deterministic instructions over the frame's
 *  CURRENT emission rendered as markdown (the 3b renderer). */
export function summarizePrompt(rendered: string): string {
  return (
    "Summarize the following tool results concisely, preserving every fact a " +
    "later reader might need. Reply with ONLY the summary text.\n\n" +
    rendered
  );
}

/** Two-line contract (parsed by the server): line 1 = title, line 2 = summary.
 *  Both fields per the §11 3d acceptance — `retitle --regen` must set title AND
 *  summary. */
export function retitlePrompt(rendered: string): string {
  return (
    "For the following conversation frame, reply with EXACTLY two lines: " +
    "line 1 is a short title (max 8 words), line 2 is a one-sentence summary. " +
    "No other text.\n\n" +
    rendered
  );
}

/** Parse the two-line retitle regen output (tolerant of extra blank lines). */
export function parseRetitleOutput(raw: string): { title: string; summary: string | null } {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    title: lines[0] ?? raw.trim(),
    summary: lines.length > 1 ? lines.slice(1).join(" ") : null,
  };
}

export function compactPrompt(rendered: string): string {
  return (
    "Compact the following conversation frame into a brief summary of the form " +
    "'user asked X; assistant did/answered Y', preserving every fact a later " +
    "reader might need. Reply with ONLY the summary text.\n\n" +
    rendered
  );
}
