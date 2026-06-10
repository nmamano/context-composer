// §11 Phase 5b — dual-client smoke, browser side + wiretap judge.
// Orchestrated by scripts/dual-client-smoke.sh (which owns the daemon and the
// real TUI in tmux). Two modes:
//
//   surgery  — drive the REAL browser against the live daemon WHILE the TUI
//              session is open: delete the turn-1 frame, edit the turn-2 frame
//              through the UI op menu. Judged via the control API; writes the
//              chosen ids to $CC_SMOKE_DIR/surgery.json for the judge.
//   judge    — after the TUI's post-surgery turn: find that turn's wiretap
//              entry and assert the wire reflects the browser surgery
//              (tombstone matched-but-omitted, override emitted, deleted
//              content gone, upstream 200). The WIRETAP is the oracle — never
//              the pane, never the DOM (design.md §11 standing-gate rule).
//
// Env: CC_SMOKE_BASE, CC_SMOKE_DIR, CC_WIRETAP (judge), markers below.

import { chromium } from "playwright";

const base = process.env.CC_SMOKE_BASE!;
const dir = process.env.CC_SMOKE_DIR!;
const mode = process.argv[2];
if (!base || !dir || !["surgery", "judge"].includes(mode ?? "")) {
  console.error("usage: CC_SMOKE_BASE=… CC_SMOKE_DIR=… bun run scripts/dual-client-smoke.ts surgery|judge");
  process.exit(2);
}

export const MARKER_TURN1 = "dual alpha ack";
export const MARKER_TURN2 = "dual bravo ack";
export const MARKER_TURN3 = "Say done";
export const MARKER_EDIT = "edited in the browser during the live session (dual smoke)";

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

interface Conv { id: string; totalTurnFrames: number }
interface Summary { id: string; kind: string; deleted: boolean; overridden: boolean }
interface Shown { id: string; messages: { content: unknown }[] }

function frameText(f: Shown): string {
  return JSON.stringify(f.messages);
}

async function mainConvAndFrames(): Promise<{
  conv: string;
  frames: Summary[];
  shown: Map<string, Shown>;
}> {
  const { conversations } = await getJson<{ conversations: Conv[] }>(
    "/control/conversations",
  );
  const conv = [...conversations].sort(
    (a, b) => b.totalTurnFrames - a.totalTurnFrames,
  )[0]!.id;
  const { frames } = await getJson<{ frames: Summary[] }>(
    `/control/list?conv=${conv}`,
  );
  const shown = new Map<string, Shown>();
  for (const f of frames) {
    shown.set(f.id, await getJson<Shown>(`/control/show?conv=${conv}&id=${f.id}`));
  }
  return { conv, frames, shown };
}

if (mode === "surgery") {
  const { conv, frames, shown } = await mainConvAndFrames();
  const byMarker = (marker: string) =>
    frames.find(
      (f) => f.kind === "turn" && frameText(shown.get(f.id)!).includes(marker),
    );
  const A = byMarker(MARKER_TURN1);
  const B = byMarker(MARKER_TURN2);
  check(!!A, `found turn-1 frame by marker (${A?.id})`);
  check(!!B, `found turn-2 frame by marker (${B?.id})`);
  if (!A || !B) process.exit(1);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/ui`, { waitUntil: "networkidle" });
    // Deterministic conversation targeting: select the main conv explicitly.
    await page.locator(".conv-switcher").selectOption(conv);
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "frames" }).click();
    await page.waitForSelector(`.frame-card[data-frame-id="${A.id}"]`);

    // Browser surgery 1: delete the turn-1 frame.
    await page.locator(`.op-menu[data-frame-id="${A.id}"] summary`).click();
    await page
      .locator(`.op-menu[data-frame-id="${A.id}"] button[data-verb="delete"]`)
      .click();
    await page.waitForSelector(`.frame-card[data-frame-id="${A.id}"] .chip-deleted`);

    // Browser surgery 2: edit the turn-2 frame.
    await page.locator(`.op-menu[data-frame-id="${B.id}"] summary`).click();
    await page
      .locator(`.op-menu[data-frame-id="${B.id}"] button[data-verb="edit"]`)
      .click();
    await page.locator('.op-form[data-op="edit"] textarea').fill(MARKER_EDIT);
    await page.locator('.op-form[data-op="edit"] button[type="submit"]').click();
    await page.waitForSelector(`.frame-card[data-frame-id="${B.id}"] .chip-override`);
    await page.screenshot({ path: `${dir}/surgery.png`, fullPage: true });

    // API oracle: the live store now carries the surgery.
    const after = await getJson<{ frames: Summary[] }>(`/control/list?conv=${conv}`);
    check(
      after.frames.find((f) => f.id === A.id)!.deleted,
      `browser delete of ${A.id} persisted in the LIVE daemon`,
    );
    check(
      after.frames.find((f) => f.id === B.id)!.overridden,
      `browser edit of ${B.id} persisted in the LIVE daemon`,
    );
  } finally {
    await browser.close();
  }
  await Bun.write(
    `${dir}/surgery.json`,
    JSON.stringify({ conv, deletedId: A.id, editedId: B.id }),
  );
  if (failures > 0) process.exit(1);
  console.log("dual-client surgery: done");
}

if (mode === "judge") {
  const wiretapPath = process.env.CC_WIRETAP ?? `${dir}/wiretap.jsonl`;
  const surgery = (await Bun.file(`${dir}/surgery.json`).json()) as {
    conv: string;
    deletedId: string;
    editedId: string;
  };
  interface Entry {
    kind: string;
    conv?: string;
    inbound?: { rawBody: string };
    outboundBody?: unknown;
    viewFrameIds?: string[];
    emittedFrameIds?: string[];
    upstreamStatus?: number | null;
  }
  const lines = (await Bun.file(wiretapPath).text()).trim().split("\n");
  const entries = lines.map((l) => JSON.parse(l) as Entry);
  // The post-surgery turn: the LAST main-conv messages entry carrying the
  // turn-3 marker in its INBOUND body (suggestion-mode side queries fork onto
  // the same conv — the marker filter keeps the judge honest).
  const turn3 = entries
    .filter(
      (e) =>
        e.kind === "messages" &&
        e.conv === surgery.conv &&
        (e.inbound?.rawBody ?? "").includes(MARKER_TURN3),
    )
    .at(-1);
  check(!!turn3, "found the post-surgery TUI turn in the wiretap");
  if (!turn3) process.exit(1);

  const outbound = JSON.stringify(turn3.outboundBody);
  check(
    (turn3.viewFrameIds ?? []).includes(surgery.deletedId),
    `tombstone ${surgery.deletedId} still MATCHED the unaware resend (view)`,
  );
  check(
    !(turn3.emittedFrameIds ?? []).includes(surgery.deletedId),
    `tombstone ${surgery.deletedId} OMITTED from the emission`,
  );
  check(
    !outbound.includes(MARKER_TURN1),
    "deleted turn-1 content is GONE from the wire",
  );
  check(
    (turn3.emittedFrameIds ?? []).includes(surgery.editedId),
    `edited ${surgery.editedId} still emits`,
  );
  check(
    outbound.includes(MARKER_EDIT),
    "browser-edited representation is ON THE WIRE",
  );
  check(
    !outbound.includes(MARKER_TURN2),
    "edited frame's pre-edit source text left the wire",
  );
  check(turn3.upstreamStatus === 200, `upstream accepted the rewritten body (200)`);

  if (failures > 0) {
    console.error("dual-client judge: FAILED");
    process.exit(1);
  }
  console.log("dual-client judge: the next TUI turn's wire reflects the browser surgery");
}
