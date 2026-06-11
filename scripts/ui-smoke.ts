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
  inLastView: boolean | null;
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
    // Intentional refusal POSTs (4xx) emit Chrome's "Failed to load resource"
    // console error — those statuses are asserted explicitly via the banner +
    // API below, so /control resource errors are not page defects.
    if (m.type() !== "error") return;
    if (
      m.text().includes("Failed to load resource") &&
      m.location().url.includes("/control/")
    ) {
      return;
    }
    consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${base}/ui`, { waitUntil: "networkidle" });

  // F-024: capitalized tab title + a real (data:-URI) favicon declared.
  check((await page.title()) === "Context Composer", "tab title is 'Context Composer'");
  check(
    await page
      .locator('link[rel="icon"]')
      .evaluate((el) => (el.getAttribute("href") ?? "").startsWith("data:image/svg+xml")),
    "favicon is an inline SVG data URI (no request outside /ui)",
  );

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

  // -- toggle to frame view: every non-fork frame visible, flagged; fork-only
  //    frames are hidden by default behind the F-006 toggle (API = oracle:
  //    strictly inLastView === false).
  await page.getByRole("tab", { name: "frames" }).click();
  await page.waitForSelector(".frame-view .frame-card");
  const nonFork = frames.filter((f) => f.inLastView !== false);
  const forkOnly = frames.filter((f) => f.inLastView === false);
  const cardIds = await page
    .locator(".frame-view .frame-card")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-frame-id")));
  check(
    JSON.stringify(cardIds) === JSON.stringify(nonFork.map((f) => f.id)),
    `frame view shows all ${nonFork.length} non-fork frames in store order (${forkOnly.length} fork-only hidden)`,
  );
  if (forkOnly.length > 0) {
    await page.locator(".fork-toggle input").check();
    const allIds = await page
      .locator(".frame-view .frame-card")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-frame-id")));
    check(
      JSON.stringify(allIds) === JSON.stringify(frames.map((f) => f.id)),
      `fork toggle reveals ALL ${frames.length} frames in store order`,
    );
  } else {
    check(
      (await page.locator(".fork-toggle").count()) === 0,
      "no fork-only frames → no fork toggle rendered",
    );
  }
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

  // -- F-059c: the restart hint renders exactly when NO view annotation
  //    exists (every inLastView null — the daemon-restart shape); any
  //    established view hides it (API = oracle).
  const viewEstablished = frames.some((f) => f.inLastView !== null);
  const hintCount = await page.locator(".frames-hint").count();
  check(
    viewEstablished ? hintCount === 0 : hintCount === 1,
    viewEstablished
      ? "view annotations exist → no restart hint in the frame view"
      : "no view annotations (restart shape) → frame view shows the hint",
  );

  // -- F-063: the add form's position dropdown offers only viable anchors —
  //    deleted / fork-only / preamble excluded (API = oracle; the engine's
  //    anchor lookup covers live turn frames, and fork-only is Nil's call).
  await page.locator(".store-ops .op-add").click();
  const viable = frames.filter(
    (f) => f.kind !== "preamble" && !f.deleted && f.inLastView !== false,
  );
  const expectedAnchors = ["", "start", ...viable.map((f) => f.id)];
  const anchorValues = await page
    .locator('.op-form[data-op="add"] select option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  check(
    JSON.stringify(anchorValues) === JSON.stringify(expectedAnchors),
    `add position dropdown offers only viable anchors (${viable.length} of ${frames.length} frames)`,
  );
  await page
    .locator('.op-form[data-op="add"] button:has-text("cancel")')
    .click();

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

  // ===========================================================================
  // §11 Phase 5b — OPS FROM THE BROWSER (quota-free: control routes never hit
  // upstream; the daemon is started with LLM env scrubbed so regen REFUSES).
  // Every mutation is judged by fresh /control/list + /control/compose; the
  // acceptance is the design line: run an op → BOTH views update.
  // ===========================================================================

  const freshList = async () =>
    (await getJson<{ frames: Summary[] }>(`/control/list?conv=${conv}`)).frames;
  const freshCompose = async () =>
    await getJson<{ emittedFrameIds: string[] }>(
      `/control/compose?conv=${conv}&hashHead`,
    );
  /** Wait until the app finishes its post-op refetch (banner or card change is
   *  awaited explicitly per-step; this just yields the network a beat). */
  const settle = () => page.waitForLoadState("networkidle");

  // Targets: last three clean captured emitted turn frames + the offloaded one.
  const clean = turnFrames.filter(
    (f) =>
      !f.deleted &&
      !f.offloaded &&
      !f.overridden &&
      compose.emittedFrameIds.includes(f.id),
  );
  check(clean.length >= 3, `fixture has >=3 clean emitted frames (${clean.length})`);
  const [A, C, B] = clean.slice(-3) as [Summary, Summary, Summary];
  console.log(
    `  ops targets: delete=${A.id} edit/offload/restore=${C.id} retitle/revert=${B.id} refusal=${offloadedFrames[0]!.id}`,
  );

  await page.getByRole("tab", { name: "frames" }).click();
  await page.waitForSelector(".frame-view .frame-card");

  const openMenuAndPick = async (frameId: string, verb: string) => {
    await page.locator(`.op-menu[data-frame-id="${frameId}"] summary`).click();
    await page
      .locator(`.op-menu[data-frame-id="${frameId}"] button[data-verb="${verb}"]`)
      .click();
  };
  // F-067/F-068: edit + retitle relocated to the details panel — same verbs,
  // same routes, panel entry points (the menu no longer offers them).
  const openPanel = async (frameId: string) => {
    await page.locator(`.frame-card[data-frame-id="${frameId}"]`).click();
    await page.waitForSelector(".details-panel");
  };
  const panelEditMessage = async (frameId: string, idx: number, text: string) => {
    await openPanel(frameId);
    await page.locator(`.details-panel [aria-label="edit message ${idx}"]`).click();
    await page
      .locator(`.details-panel textarea[aria-label="message ${idx} editor"]`)
      .fill(text);
    await page.locator(".details-panel .message-editor .save").click();
  };
  const panelEditTitle = async (frameId: string, text: string) => {
    await openPanel(frameId);
    await page.locator(".details-panel .edit-title").click();
    await page.locator('.details-panel input[aria-label="title editor"]').fill(text);
    await page.locator(".details-panel .inline-editor-actions .save").click();
  };

  // -- REFUSAL 1: edit the OFFLOADED frame (panel message edit, F-068) — the
  //    daemon's guard speaks; the stub is a single text message, so the panel
  //    offers the affordance and the refusal still renders verbatim.
  await panelEditMessage(off.id, 0, "should be refused");
  await page.waitForSelector(".op-error-banner");
  const bannerText = await page.locator(".op-error-banner").innerText();
  check(
    bannerText.includes(off.id) && bannerText.toLowerCase().includes("edit"),
    `refusal banner names the verb+frame (${off.id})`,
  );
  check(
    /restore|offload/i.test(bannerText),
    "refusal banner carries the daemon's own guard text",
  );
  const offAfterRefusal = (await freshList()).find((f) => f.id === off.id)!;
  check(
    offAfterRefusal.offloaded && offAfterRefusal.fileReference === off.fileReference,
    "refused edit changed nothing (API oracle)",
  );
  await page.locator(".op-error-banner .dismiss").click();

  // -- REFUSAL 2: regen with LLM unavailable (env scrubbed by ui-smoke.sh) ----
  //    F-067: regen is a panel button beside the title now.
  await openPanel(B.id);
  await page.locator(".details-panel .regen-title").click();
  await page.waitForSelector(".op-error-banner");
  check(
    /regen unavailable/i.test(await page.locator(".op-error-banner").innerText()),
    "regen refusal surfaces the daemon's 'regen unavailable' text",
  );
  await page.locator(".op-error-banner .dismiss").click();

  // -- delete A: tombstoned in frame view, GONE from conversation view --------
  await openMenuAndPick(A.id, "delete");
  await page.waitForSelector(
    `.frame-card[data-frame-id="${A.id}"] .chip-deleted`,
  );
  const afterDelete = (await freshList()).find((f) => f.id === A.id)!;
  check(afterDelete.deleted, `delete ${A.id} persisted (API oracle)`);
  check(
    !(await freshCompose()).emittedFrameIds.includes(A.id),
    `deleted ${A.id} left the emission (compose oracle)`,
  );
  check(
    (await page.locator(`.frame-card[data-frame-id="${A.id}"] .chip-deleted`).count()) === 1,
    "frame view flags the tombstone",
  );
  await page.getByRole("tab", { name: "conversation" }).click();
  await settle();
  check(
    (await page.locator(`.conversation-view [data-frame-id="${A.id}"]`).count()) === 0,
    "conversation view dropped the deleted frame (both views updated)",
  );
  await page.getByRole("tab", { name: "frames" }).click();

  // -- edit C: PANEL message edit (F-068) — override visible in BOTH views ----
  const editedText = "edited from the browser (5b op smoke)";
  await panelEditMessage(C.id, 0, editedText);
  await page.waitForSelector(`.frame-card[data-frame-id="${C.id}"] .chip-override`);
  const afterEdit = (await freshList()).find((f) => f.id === C.id)!;
  check(afterEdit.overridden, `edit ${C.id} set a representation override (API oracle)`);
  await page.getByRole("tab", { name: "conversation" }).click();
  await settle();
  check(
    (await page.locator(".conversation-view").innerText()).includes(editedText),
    "conversation view shows the edited emission (both views updated)",
  );
  await page.getByRole("tab", { name: "frames" }).click();

  // -- offload C, then restore C ------------------------------------------------
  await openMenuAndPick(C.id, "offload");
  await page.locator('.op-form[data-op="offload"] button[type="submit"]').click();
  await page.waitForSelector(`.frame-card[data-frame-id="${C.id}"] .chip-offloaded`);
  const afterOffload = (await freshList()).find((f) => f.id === C.id)!;
  check(
    afterOffload.offloaded && !!afterOffload.fileReference,
    `offload ${C.id} produced a fileReference (API oracle)`,
  );
  await openMenuAndPick(C.id, "restore");
  await page.waitForSelector(
    `.frame-card[data-frame-id="${C.id}"] .chip-offloaded`,
    { state: "detached" },
  );
  const afterRestore = (await freshList()).find((f) => f.id === C.id)!;
  check(!afterRestore.offloaded, `restore ${C.id} re-inlined the emission (API oracle)`);

  // -- retitle B, then revert(last) from the HISTORY sub-nav (F-046: it undoes
  //    the last commit, so it lives next to the commit list — NOT in the
  //    frames toolbar; F-029 keeps add/combine there) ------------------------
  const oldTitle = B.title;
  await panelEditTitle(B.id, "smoke-retitled-5b");
  await page.waitForSelector(
    `.frame-card[data-frame-id="${B.id}"]:has-text("smoke-retitled-5b")`,
  );
  check(
    (await freshList()).find((f) => f.id === B.id)!.title === "smoke-retitled-5b",
    `retitle ${B.id} persisted (API oracle)`,
  );
  check(
    (await page.locator(".store-ops .op-revert").count()) === 0,
    "F-046: revert-last is NOT in the frames toolbar",
  );
  await page.getByRole("tab", { name: "history" }).click();
  await page.waitForSelector(".history-subtoggle-row .op-revert");
  await page.locator(".history-subtoggle-row .op-revert").click();
  await page.getByRole("tab", { name: "frames" }).click();
  await page.waitForSelector(
    `.frame-card[data-frame-id="${B.id}"]:has-text("smoke-retitled-5b")`,
    { state: "detached" },
  );
  check(
    (await freshList()).find((f) => f.id === B.id)!.title === oldTitle,
    "revert(last) undid the retitle (F-046: history sub-nav)",
  );

  await shot(page, "ops");

  // ===========================================================================
  // §11 Phase 5c — HISTORY/TIMELINE PANEL + CLICK-TO-REVERT (quota-free).
  // Judged by fresh /control/history + /control/timeline + /control/list, not
  // DOM text alone. The op section above already populated the log.
  // ===========================================================================

  interface PubCommit {
    id: string;
    type: string;
    params: Record<string, unknown>;
  }
  const freshHistory = async () =>
    (await getJson<{ commits: PubCommit[] }>(`/control/history?conv=${conv}`)).commits;
  const freshTimeline = async () =>
    (await getJson<{ events: { id: string; type: string }[] }>(
      `/control/timeline?conv=${conv}`,
    )).events;

  /** Tab clicks can race a refetch re-render (the clicked node gets replaced
   *  before React sees the event) — click-and-verify with retries. */
  const switchTab = async (name: string, readySelector: string) => {
    for (let i = 0; i < 3; i++) {
      await page.getByRole("tab", { name, exact: true }).first().click();
      try {
        await page.waitForSelector(readySelector, { timeout: 3000 });
        return;
      } catch {
        /* tab click lost to a re-render — retry */
      }
    }
    throw new Error(`tab "${name}" did not activate (${readySelector})`);
  };

  // F-048: a manual refresh acknowledges itself with a brief ✓.
  await page.locator(".topbar .refresh").click();
  await page.waitForSelector('.topbar .refresh:has-text("✓")');
  check(true, "F-048: refresh flashed ✓ after the re-fetch");

  await switchTab("history", ".commit-card");
  const commits = await freshHistory();
  const cardIdsHist = await page
    .locator(".commit-card")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-commit-id")));
  check(
    JSON.stringify(cardIdsHist) === JSON.stringify(commits.map((c) => c.id)),
    `F-049: history lists all ${commits.length} commits chronologically, newest at the bottom (API oracle)`,
  );
  // Derived reverted marking: the op section's revert names its target.
  const revertCommit = commits.find(
    (c) => c.type === "revert" && typeof c.params.revertedCommitId === "string",
  );
  check(!!revertCommit, "log contains the op section's revert commit");
  if (revertCommit) {
    const targetId = revertCommit.params.revertedCommitId as string;
    check(
      (await page
        .locator(`.commit-card[data-commit-id="${targetId}"] .chip-reverted`)
        .count()) === 1,
      `reverted target ${targetId} is visibly marked (derived display state)`,
    );

    // -- REFUSAL: revert the already-reverted commit — the daemon speaks ------
    await page.locator(`.commit-revert[data-commit-id="${targetId}"]`).click();
    await page.waitForSelector(".op-error-banner");
    check(
      /already reverted/i.test(await page.locator(".op-error-banner").innerText()),
      "already-reverted refusal renders the daemon's text verbatim",
    );
    await page.locator(".op-error-banner .dismiss").click();
  }

  // -- panel revert SUCCESS: retitle B again, revert it FROM THE HISTORY CARD -
  await switchTab("frames", ".frame-view .frame-card");
  await panelEditTitle(B.id, "retitled-for-history-smoke");
  await page.waitForSelector(
    `.frame-card[data-frame-id="${B.id}"]:has-text("retitled-for-history-smoke")`,
  );
  const newest = (await freshHistory()).at(-1)!;
  check(newest.type === "retitle", "newest commit is the fresh retitle (API oracle)");
  await switchTab("history", ".commit-card");
  await page.locator(`.commit-revert[data-commit-id="${newest.id}"]`).click();
  await page.waitForSelector(
    `.commit-card[data-commit-id="${newest.id}"].is-reverted`,
  );
  check(
    (await freshList()).find((f) => f.id === B.id)!.title === oldTitle,
    "click-to-revert from the history panel restored the title (API oracle)",
  );

  // -- timeline sub-view -------------------------------------------------------
  await page.locator(".history-subtoggle button", { hasText: "timeline" }).click();
  await page.waitForSelector(".event-row");
  const events = await freshTimeline();
  check(
    (await page.locator(".event-row").count()) === events.length,
    `timeline lists all ${events.length} events (API oracle)`,
  );
  check(
    JSON.stringify(
      await page
        .locator(".event-row")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-event-id"))),
    ) === JSON.stringify(events.map((e) => e.id)),
    "F-049: timeline grows downward (chronological, API oracle)",
  );
  check(
    events.some((e) => e.type === "capture"),
    "timeline includes capture events (the audit log, not just ops)",
  );
  await shot(page, "history");

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
