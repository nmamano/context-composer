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

/** The unconfigured-regen refusal, shared so the three regen routes cannot
 *  drift (§11 Phase 5d): names BOTH config paths plus the op's manual
 *  fallback (e.g. "--text", "--title"). */
export function regenUnavailable(manualFallback: string): string {
  return (
    "regen unavailable: set CC_LLM_API_KEY + CC_LLM_MODEL, " +
    `set CC_LLM_CLAUDE_CLI=1, or use ${manualFallback}`
  );
}

/** §11 Phase 5d — subscription-backed client: drives the local `claude` CLI in
 *  print mode as a subprocess (the Isomux pattern), so --regen runs on the
 *  user's subscription instead of an API key.
 *
 *  Seam notes (reviewer-locked):
 *  - EXPLICIT opt-in only (CC_LLM_CLAUDE_CLI=1, via envLlmClient below) — the
 *    CLI being on PATH must never silently burn subscription quota.
 *  - `maxTokens` has NO CLI equivalent and is deliberately ignored here; the
 *    regen prompts already instruct brevity. Temperature is likewise not
 *    controllable, so regen output may churn more than the API client —
 *    acceptable for an explicitly user-commanded op; the resulting TEXT still
 *    flows through the same deterministic store mutation path.
 *  - Prompt travels via STDIN (argv would hit length limits and leak through
 *    process lists); spawn uses an argv ARRAY (no shell, no quoting surface);
 *    errors carry a bounded stderr excerpt and NEVER the prompt.
 *  - Invocation is non-interactive and tool-less: -p print mode, explicit
 *    text stdio formats, no session persistence, --safe-mode (skips project
 *    customizations/hooks/plugins while preserving normal auth — NOT --bare,
 *    which would skip the OAuth/keychain auth this path exists to use),
 *    --tools "" + --permission-mode dontAsk (belt and suspenders), no Chrome
 *    integration, no prompt suggestions.
 */
export function claudeCliClient(opts: {
  bin?: string;
  model?: string;
  timeoutMs?: number;
} = {}): LlmClient {
  const bin = opts.bin ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return {
    async complete(prompt: string, _maxTokens?: number): Promise<string> {
      const argv = [
        bin,
        "-p",
        "--input-format", "text",
        "--output-format", "text",
        "--no-session-persistence",
        "--safe-mode",
        "--no-chrome",
        "--prompt-suggestions", "false",
        "--tools", "",
        "--permission-mode", "dontAsk",
      ];
      if (opts.model) argv.push("--model", opts.model);
      const proc = Bun.spawn(argv, {
        stdin: new TextEncoder().encode(prompt),
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const killer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
      // Wait on EXIT first and throw immediately on timeout — never block on
      // the pipes in the killed path (an orphaned grandchild can hold the
      // stdout pipe open long after the direct child is dead).
      const exitCode = await proc.exited;
      clearTimeout(killer);
      if (timedOut) {
        throw new Error(`claude CLI regen failed: timed out after ${timeoutMs}ms (killed)`);
      }
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (exitCode !== 0) {
        // Bounded stderr excerpt; never the prompt.
        const excerpt = stderr.trim().slice(0, 400);
        throw new Error(
          `claude CLI regen failed (exit ${exitCode})` + (excerpt ? `: ${excerpt}` : ""),
        );
      }
      const text = stdout.trim();
      if (!text) throw new Error("claude CLI regen returned no text");
      return text;
    },
  };
}

/** Env-configured client, or null when nothing is configured (the caller
 *  surfaces regenUnavailable()). Precedence (§11 Phase 5d, reviewer-locked):
 *  API config (CC_LLM_API_KEY + CC_LLM_MODEL) wins; else the EXPLICIT
 *  subscription opt-in CC_LLM_CLAUDE_CLI=1 activates the claude-CLI client
 *  (CC_CLAUDE_BIN overrides the binary, CC_LLM_CLI_MODEL → --model,
 *  CC_LLM_CLI_TIMEOUT_MS overrides the 120s default); else null. Deliberately
 *  NO default model id and NO auto-activation from `claude` on PATH. */
export function envLlmClient(): LlmClient | null {
  const apiKey = process.env.CC_LLM_API_KEY;
  const model = process.env.CC_LLM_MODEL;
  const baseUrl = process.env.CC_LLM_BASE_URL ?? "https://api.anthropic.com";
  if (!apiKey || !model) {
    if (process.env.CC_LLM_CLAUDE_CLI === "1") {
      const timeout = Number(process.env.CC_LLM_CLI_TIMEOUT_MS);
      return claudeCliClient({
        bin: process.env.CC_CLAUDE_BIN,
        model: process.env.CC_LLM_CLI_MODEL,
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
      });
    }
    return null;
  }
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
