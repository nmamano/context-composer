// §11 Phase 5d — subscription-backed LlmClient (claude CLI subprocess) +
// envLlmClient gating/precedence. ZERO quota: the subprocess tests drive a
// STUB executable via CC_CLAUDE_BIN (never the real `claude`), and the API
// precedence test stubs globalThis.fetch (never the network).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCliClient, envLlmClient, regenUnavailable } from "../src/engine/llm.ts";

let tmp: string;
const ENV_KEYS = [
  "CC_LLM_API_KEY",
  "CC_LLM_MODEL",
  "CC_LLM_BASE_URL",
  "CC_LLM_CLAUDE_CLI",
  "CC_CLAUDE_BIN",
  "CC_LLM_CLI_MODEL",
  "CC_LLM_CLI_TIMEOUT_MS",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-llm-cli-"));
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** Write an executable stub that records argv + stdin to side files, then
 *  behaves per the body (default: echo canned output). */
function stubBin(body: string): string {
  const path = join(tmp, "claude-stub");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$@" > "${tmp}/argv.txt"
cat > "${tmp}/stdin.txt"
${body}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const argv = () => readFileSync(join(tmp, "argv.txt"), "utf8");
const stdin = () => readFileSync(join(tmp, "stdin.txt"), "utf8");

describe("claudeCliClient subprocess discipline", () => {
  test("prompt arrives on STDIN, never argv; output is trimmed", async () => {
    const bin = stubBin(`printf '  generated title\\n\\n'`);
    const client = claudeCliClient({ bin });
    const out = await client.complete("PROMPT-ON-STDIN with spaces");
    expect(out).toBe("generated title");
    expect(stdin()).toBe("PROMPT-ON-STDIN with spaces");
    expect(argv()).not.toContain("PROMPT-ON-STDIN");
  });

  test("invocation is the reviewed non-interactive tool-less flag set", async () => {
    const bin = stubBin(`echo ok`);
    await claudeCliClient({ bin }).complete("x");
    const args = argv();
    for (const flag of [
      "-p",
      "--input-format",
      "--output-format",
      "--no-session-persistence",
      "--safe-mode",
      "--no-chrome",
      "--prompt-suggestions",
      "--tools",
      "--permission-mode",
      "dontAsk",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).not.toContain("--bare"); // --bare skips OAuth — the wrong auth
    expect(args).not.toContain("--model"); // only when configured
  });

  test("--model is passed only when configured", async () => {
    const bin = stubBin(`echo ok`);
    await claudeCliClient({ bin, model: "some-model" }).complete("x");
    expect(argv()).toContain("--model");
    expect(argv()).toContain("some-model");
  });

  test("empty output is an error", async () => {
    const bin = stubBin(`printf '   \\n'`);
    expect(claudeCliClient({ bin }).complete("x")).rejects.toThrow(/no text/);
  });

  test("nonzero exit throws with a bounded stderr excerpt, prompt NOT included", async () => {
    const bin = stubBin(`echo "auth expired: run claude login" >&2; exit 3`);
    try {
      await claudeCliClient({ bin }).complete("SECRET-PROMPT-CONTENT");
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("exit 3");
      expect(msg).toContain("auth expired");
      expect(msg).not.toContain("SECRET-PROMPT-CONTENT");
    }
  });

  test("timeout kills the subprocess and refuses promptly", async () => {
    // sleep is a GRANDCHILD holding the stdout pipe — the killed path must not
    // block on pipe close (the orphan keeps it open for 30s).
    const bin = stubBin(`sleep 30; echo too-late`);
    const start = Date.now();
    expect(claudeCliClient({ bin, timeoutMs: 300 }).complete("x")).rejects.toThrow(
      /timed out after 300ms/,
    );
    expect(Date.now() - start).toBeLessThan(4_000);
  });
});

describe("envLlmClient gating + precedence", () => {
  test("no config at all → null", () => {
    expect(envLlmClient()).toBeNull();
  });

  test("CLI gate off (CC_CLAUDE_BIN set but no opt-in) → null: PATH presence never activates", () => {
    process.env.CC_CLAUDE_BIN = stubBin(`echo never-run`);
    expect(envLlmClient()).toBeNull();
  });

  test("CC_LLM_CLAUDE_CLI=1 activates the subprocess client (stub bin, env timeout)", async () => {
    process.env.CC_LLM_CLAUDE_CLI = "1";
    process.env.CC_CLAUDE_BIN = stubBin(`echo from-subscription-stub`);
    process.env.CC_LLM_CLI_MODEL = "cli-model-x";
    const client = envLlmClient();
    expect(client).not.toBeNull();
    expect(await client!.complete("hi")).toBe("from-subscription-stub");
    expect(argv()).toContain("cli-model-x");
  });

  test("API config WINS over CLI opt-in — selected without any network call", async () => {
    process.env.CC_LLM_API_KEY = "k";
    process.env.CC_LLM_MODEL = "api-model";
    process.env.CC_LLM_CLAUDE_CLI = "1";
    process.env.CC_CLAUDE_BIN = stubBin(`echo cli-should-not-run`);
    const client = envLlmClient();
    expect(client).not.toBeNull();
    // Prove the API path without the network: stub fetch, assert it is used.
    const realFetch = globalThis.fetch;
    let fetched = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      fetched = String(url);
      expect(JSON.parse(String(init?.body)).model).toBe("api-model");
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "api-text" }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      expect(await client!.complete("x")).toBe("api-text");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toContain("/v1/messages");
    // The CLI stub never ran (no argv side file written).
    expect(() => argv()).toThrow();
  });
});

describe("regenUnavailable refusal", () => {
  test("names BOTH config paths + the op's manual fallback", () => {
    const msg = regenUnavailable("--text");
    expect(msg).toContain("CC_LLM_API_KEY + CC_LLM_MODEL");
    expect(msg).toContain("CC_LLM_CLAUDE_CLI=1");
    expect(msg).toContain("--text");
    expect(regenUnavailable("--title")).toContain("--title");
  });
});
