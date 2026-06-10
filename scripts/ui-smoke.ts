// §11 Phase 5a — REAL-BROWSER smoke (the browser equivalent of the standing
// TUI gate). Drives the system Chrome (Playwright channel:"chrome", headless)
// against a REAL proxy daemon and judges via the CONTROL API, not the DOM: every
// expected value is read fresh from /control/* at runtime (the fixture only
// guarantees the *kinds* of states exist — deleted, offloaded, override).
// Screenshots land in CC_SMOKE_DIR as evidence artifacts; they are not the oracle.
//
// Invoked by scripts/ui-smoke.sh with:
//   CC_SMOKE_BASE  http://localhost:<port> of the smoke daemon (never 8788)
//   CC_SMOKE_DIR   evidence dir (/tmp/cc-ui-smoke-*)

import { chromium, type Page } from "playwright";

const base = process.env.CC_SMOKE_BASE;
const dir = process.env.CC_SMOKE_DIR;
if (!base || !dir) {
  console.error("ui-smoke: CC_SMOKE_BASE and CC_SMOKE_DIR are required");
  process.exit(2);
}

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

interface Conv { id: string; active: boolean; turnFrames: number }
interface Summary {
  id: string; kind: string; title: string; deleted: boolean; offloaded: boolean;
  overridden: boolean; fileReference: string | null; tokenEstimate: number;
}
interface ShownFrame {
  id: string; messages: { role: string; content: unknown }[];
  representation?: { role: string; content: unknown }[] | null;
}

function firstText(msgs: { content: unknown }[] | null | undefined): string | null {
  for (const m of msgs ?? []) {
    if (typeof m.content === "string" && m.content.trim()) return m.content;
    if (Array.isArray(m.content)) {
      for (const b of m.content as Record<string, unknown>[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          return b.text;
        }
      }
    }
  }
  return null;
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  console.log(`  shot ${dir}/${name}.png`);
}

// ---- fresh control-API truths (the oracle) ----------------------------------

const { conversations } = await getJson<{ conversations: Conv[] }>(
  "/control/conversations",
);
check(conversations.length > 0, "daemon has conversations");
const conv =
  conversations.find((c) => c.active)?.id ?? conversations[0]!.id;
const { frames } = await getJson<{ conv: string; frames: Summary[] }>(
  `/control/list?conv=${conv}`,
);
const compose = await getJson<{ emittedFrameIds: string[] }>(
  `/control/compose?conv=${conv}&hashHead`,
);
const turnFrames = frames.filter((f) => f.kind === "turn");
const deletedFrames = turnFrames.filter((f) => f.deleted);
const offloadedFrames = turnFrames.filter((f) => f.offloaded);
check(turnFrames.length >= 2, `fixture has >=2 turn frames (${turnFrames.length})`);
check(deletedFrames.length >= 1, "fixture exercises a deleted frame");
check(offloadedFrames.length >= 1, "fixture exercises an offloaded frame");

const shown = new Map<string, ShownFrame>();
for (const f of frames) {
  shown.set(f.id, await getJson<ShownFrame>(`/control/show?conv=${conv}&id=${f.id}`));
}

// ---- drive the real browser --------------------------------------------------

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${base}/ui`, { waitUntil: "networkidle" });

  // -- conversation view (default): the engine's emission, rendered -----------
  await page.waitForSelector(".conversation-view .bubble");
  for (const id of compose.emittedFrameIds) {
    const f = frames.find((x) => x.id === id);
    if (!f || f.kind !== "turn") continue;
    const s = shown.get(id)!;
    const bubbles = await page
      .locator(`.conversation-view [data-frame-id="${id}"]`)
      .count();
    check(bubbles > 0, `conversation view renders emitted frame ${id}`);
    const emission = s.representation ?? s.messages;
    const sample = firstText(emission);
    if (sample) {
      const viewText = await page.locator(".conversation-view").innerText();
      check(
        viewText.includes(sample.slice(0, 60).trim()),
        `conversation view shows ${id}'s current emission text`,
      );
    }
  }
  for (const f of deletedFrames) {
    const bubbles = await page
      .locator(`.conversation-view [data-frame-id="${f.id}"]`)
      .count();
    check(bubbles === 0, `conversation view hides deleted frame ${f.id}`);
    const sample = firstText(shown.get(f.id)!.messages);
    if (sample) {
      const viewText = await page.locator(".conversation-view").innerText();
      check(
        !viewText.includes(sample.slice(0, 60).trim()),
        `deleted frame ${f.id}'s content absent from conversation view`,
      );
    }
  }
  await shot(page, "conversation");

  // -- toggle to frame view: everything visible, flagged ----------------------
  await page.getByRole("tab", { name: "frames" }).click();
  await page.waitForSelector(".frame-view .frame-card");
  const cardIds = await page
    .locator(".frame-view .frame-card")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-frame-id")));
  check(
    JSON.stringify(cardIds) === JSON.stringify(frames.map((f) => f.id)),
    `frame view shows ALL ${frames.length} frames in store order`,
  );
  for (const f of frames) {
    const card = page.locator(`.frame-card[data-frame-id="${f.id}"]`);
    const text = await card.innerText();
    check(
      text.includes(f.title.slice(0, 40)),
      `card ${f.id} shows its API title`,
    );
    check(
      text.includes(`${f.tokenEstimate} tok`),
      `card ${f.id} shows tokenEstimate`,
    );
    if (f.deleted) check(text.includes("deleted"), `card ${f.id} flagged deleted`);
    if (f.offloaded) check(text.includes("offloaded"), `card ${f.id} flagged offloaded`);
    if (f.overridden && !f.offloaded) {
      check(text.includes("override"), `card ${f.id} flagged override`);
    }
  }
  await shot(page, "frames");

  // -- details panel for an offloaded frame: fileReference + source vs current
  const off = offloadedFrames[0]!;
  await page.locator(`.frame-card[data-frame-id="${off.id}"]`).click();
  await page.waitForSelector(".details-panel");
  const panelText = await page.locator(".details-panel").innerText();
  // innerText reflects CSS text-transform (headings render uppercased) — compare
  // case-insensitively; the DOM is the pane, the API is the oracle.
  const panelLower = panelText.toLowerCase();
  check(
    panelText.includes(off.fileReference ?? "<missing>"),
    `details shows ${off.id}'s fileReference from show()`,
  );
  check(
    panelLower.includes("current emission"),
    "details labels the current emission",
  );
  check(
    panelLower.includes("source (agent's resend baseline)"),
    "details exposes the source section for the override",
  );
  const srcSample = firstText(shown.get(off.id)!.messages);
  if (srcSample) {
    check(
      panelText.includes(srcSample.slice(0, 60).trim()),
      `details shows ${off.id}'s SOURCE messages`,
    );
  }
  await shot(page, "details");

  // -- toggle back: both views render after switching --------------------------
  await page.getByRole("tab", { name: "conversation" }).click();
  await page.waitForSelector(".conversation-view .bubble");
  check(true, "toggle conversation ⇄ frames round-trips");

  check(
    consoleErrors.length === 0,
    `no browser console errors (${consoleErrors.length === 0 ? "clean" : consoleErrors.join(" | ")})`,
  );
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`ui-smoke: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("ui-smoke: all checks passed");
