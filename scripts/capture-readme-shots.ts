// F-074 (plans/ui-feedback.md, Nil request): capture README screenshots of
// every view, populated by a REAL scripted conversation — fully self-driven.
//
// What it does:
//   1. boots a THROWAWAY daemon (own port 8813, fresh tmp store — never
//      touches a daemon it didn't start) with live enrichment ON;
//   2. drives a small real Claude Code session through the proxy
//      (`claude -p --session-id/--resume`, subscription auth — the
//      live-e2e.sh pattern; ~4 sonnet turns + sonnet@low enrichment,
//      Nil-authorized quota);
//   3. runs a few ops via the control API so every view has something to
//      show (delete+revert for history, offload, an added note, a split
//      with derived part titles);
//   4. screenshots each view with Playwright at a fixed viewport into
//      docs/screenshots/.
//
// Usage: bun run scripts/capture-readme-shots.ts
// Idempotent: fresh store every run; overwrites the pngs.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const PORT = 8813;
const BASE = `http://localhost:${PORT}`;
const CLAUDE = process.env.CC_CLAUDE_BIN ?? "/home/nil/.local/bin/claude";
const OUT = join(import.meta.dir, "..", "docs", "screenshots");
const VIEWPORT = { width: 1360, height: 850 };

const work = mkdtempSync(join(tmpdir(), "cc-readme-shots-"));
mkdirSync(join(work, "frames"), { recursive: true });
mkdirSync(OUT, { recursive: true });

function log(msg: string) {
  console.log(`[readme-shots] ${msg}`);
}

// ── 1. throwaway daemon — with OWNERSHIP GUARDS (reviewer P1) ─────────────────
// The safety property is "never touch a daemon this script did not start". A
// naive HTTP readiness probe can succeed against a PRE-EXISTING daemon on the
// port while our spawn dies on bind — and the destructive ops below would hit
// someone else's store. Guards, in order:
//   (a) fail FAST if anything already serves the port BEFORE we spawn;
//   (b) readiness requires OUR CHILD to still be alive AND to have printed its
//       own startup banner on the stderr WE pipe (a child that lost the bind
//       race exits — Bun.serve throws on EADDRINUSE — and its stderr is
//       surfaced instead of being mistaken for readiness);
//   (c) only then is HTTP-responds accepted as ready — alive child + its
//       banner + the pre-spawn free check means the responder is our child.

async function portAlreadyServing(): Promise<boolean> {
  try {
    await fetch(`${BASE}/control/conversations`, {
      signal: AbortSignal.timeout(750),
    });
    return true; // ANY response means someone else owns the port
  } catch {
    return false; // connection refused/timeout — port is free
  }
}

if (await portAlreadyServing()) {
  rmSync(work, { recursive: true, force: true });
  throw new Error(
    `something already serves :${PORT} — refusing to touch a daemon this script did not start`,
  );
}

const daemon = Bun.spawn(["bun", "run", "src/proxy/server.ts"], {
  env: {
    ...process.env,
    CC_PROXY_PORT: String(PORT),
    CC_STORE_PATH: join(work, "store.json"),
    CC_WIRETAP_PATH: join(work, "wiretap.jsonl"),
    CC_FRAMES_DIR: join(work, "frames"),
    CC_LLM_CLAUDE_CLI: "1",
    CC_ENRICH_ON_INGEST: "1",
    CC_CLAUDE_BIN: CLAUDE,
  },
  stdout: "ignore",
  stderr: "pipe",
});

// Accumulate the child's stderr — both the ownership banner check and the
// failure diagnostics read from here.
let daemonStderr = "";
void (async () => {
  const reader = daemon.stderr.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    daemonStderr += dec.decode(value);
  }
})();

async function waitForDaemon(): Promise<void> {
  const banner = `proxy + control API on http://localhost:${PORT}`;
  for (let i = 0; i < 50; i++) {
    if (daemon.exitCode !== null) {
      throw new Error(
        `daemon exited (${daemon.exitCode}) before readiness — bind failure? stderr:\n${daemonStderr.slice(0, 600)}`,
      );
    }
    if (daemonStderr.includes(banner)) {
      try {
        const r = await fetch(`${BASE}/control/conversations`);
        if (r.ok) return; // our live child printed the banner AND answers
      } catch {
        /* serving not settled yet */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `daemon did not come up on :${PORT}; stderr:\n${daemonStderr.slice(0, 600)}`,
  );
}

// ── 2. a real scripted session through the proxy ─────────────────────────────
const SID = crypto.randomUUID();

async function turn(prompt: string, first = false): Promise<void> {
  log(`turn: ${prompt.slice(0, 60)}…`);
  const proc = Bun.spawn(
    [
      CLAUDE,
      "-p",
      prompt,
      ...(first ? ["--session-id", SID] : ["--resume", SID]),
      "--output-format",
      "text",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "sonnet",
    ],
    {
      cwd: work, // a neutral empty dir — no project context noise
      env: { ...process.env, ANTHROPIC_BASE_URL: BASE },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`claude turn failed (${code}): ${err.slice(0, 300)}`);
  }
}

async function controlOp(route: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/control/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: string };
  if (json.error) throw new Error(`${route} refused: ${json.error}`);
  log(`op: ${route} ${JSON.stringify(body).slice(0, 60)}`);
}

async function timelineCount(type: string): Promise<number> {
  const tl = (await (await fetch(`${BASE}/control/timeline`)).json()) as {
    events: Array<{ type: string }>;
  };
  return tl.events.filter((e) => e.type === type).length;
}

try {
  await waitForDaemon();
  log(`daemon up on :${PORT} (store in ${work})`);

  await turn(
    "I'm building a small Python CLI that renames photos using their EXIF date " +
      "(e.g. IMG_4982.jpg -> 2026-06-11_14-02-33.jpg). Sketch the approach in a " +
      "few bullet points — libraries, steps, no code yet.",
    true,
  );
  await turn(
    "What edge cases should I handle? Think missing EXIF data, name collisions, " +
      "and non-JPEG files. Keep it to a short list.",
  );
  await turn(
    "Now write the core rename function (just the function, with type hints and " +
      "a docstring).",
  );
  await turn(
    "How do I test this safely without touching my real photo library? Give me " +
      "a quick pytest plan.",
  );

  // Let the serialized enrichment queue finish titling the four turns. Count
  // TITLES, not enriched events — F-062 re-enrichment can produce a second
  // event for an early frame while a later frame is still queued (a race this
  // script hit live: split children inherited a placeholder title).
  log("waiting for enrichment to settle…");
  const placeholdersLeft = async (): Promise<number> => {
    const l = (await (await fetch(`${BASE}/control/list`)).json()) as {
      frames: Array<{ id: string; kind: string; title: string }>;
    };
    return l.frames.filter((f) => f.kind === "turn" && f.title === `frame ${f.id}`)
      .length;
  };
  for (let i = 0; i < 120; i++) {
    if ((await placeholdersLeft()) === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(
    `enriched events: ${await timelineCount("enriched")}; placeholders left: ${await placeholdersLeft()}`,
  );

  // ── 3. ops so every view has a story ───────────────────────────────────────
  const list = (await (await fetch(`${BASE}/control/list`)).json()) as {
    frames: Array<{ id: string; kind: string }>;
  };
  const turns = list.frames.filter((f) => f.kind === "turn").map((f) => f.id);
  if (turns.length < 4) throw new Error(`expected 4 turn frames, got ${turns.length}`);
  const [t1, t2, t3, t4] = turns as [string, string, string, string];

  await controlOp("delete", { ids: [t2] }); // a tombstone…
  await controlOp("revert", {}); // …reverted (history shows both, linked)
  await controlOp("offload", { id: t3 }); // the big code turn -> stub + artifact
  await controlOp("add", {
    text: "NOTE TO MODEL: prefer pathlib over os.path in all code for this project.",
    after: t1,
  });
  await controlOp("split", { id: t4, at: [1] }); // derived "(part i/2)" titles

  // ── 4. screenshots ──────────────────────────────────────────────────────────
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page: Page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(`${BASE}/ui`);
  await page.waitForSelector(".conversation-view [data-frame-id]");

  const shot = async (name: string) => {
    await page.mouse.move(8, 500); // park the cursor — no stray hover tooltips
    await page.waitForTimeout(250); // let layout/scroll settle
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    log(`shot: ${name}.png`);
  };

  await shot("conversation");

  await page.getByRole("tab", { name: "frames" }).click();
  await page.waitForSelector(".frame-view .frame-card");
  await shot("frames");

  // Details panel: pick the first live turn frame (auto-titled, summarized).
  await page.locator(`.frame-card[data-frame-id="${t1}"]`).click();
  await page.waitForSelector(".details-panel");
  await shot("details");

  await page.getByRole("tab", { name: "history" }).click();
  await page.waitForSelector(".commit-card");
  await shot("history-commits");

  await page.locator(".history-subtoggle button", { hasText: "timeline" }).click();
  await page.waitForSelector(".event-row");
  await shot("history-timeline");

  await browser.close();
  log(`done — shots in ${OUT}`);
} finally {
  daemon.kill();
  rmSync(work, { recursive: true, force: true });
}
