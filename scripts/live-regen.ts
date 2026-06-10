// §11 Phase 5d — live-regen legs, driven by scripts/live-regen.sh (which owns
// the daemon and the explicit CC_LLM_CLAUDE_CLI=1 opt-in). Judged via the
// control API (/control/show + /control/history + /control/list), not DOM.
//
//   cli      — `ctx retitle <frame> --regen` through the control route
//              (completion #1): title+summary regenerate, a retitle commit
//              records with regen provenance.
//   browser  — the UI retitle form's regen checkbox (completion #2): same
//              judgment, plus both views refresh.

import { chromium } from "playwright";

const base = process.env.CC_SMOKE_BASE!;
const dir = process.env.CC_SMOKE_DIR!;
const mode = process.argv[2];
if (!base || !dir || !["cli", "browser"].includes(mode ?? "")) {
  console.error("usage: CC_SMOKE_BASE=… CC_SMOKE_DIR=… bun run scripts/live-regen.ts cli|browser");
  process.exit(2);
}

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

interface Conv { id: string; active: boolean }
interface Summary {
  id: string; kind: string; title: string; summary: string | null;
  deleted: boolean; offloaded: boolean; overridden: boolean;
}
interface Commit { id: string; type: string; affectedFrameIds: string[]; params: Record<string, unknown> }

const { conversations } = await getJson<{ conversations: Conv[] }>("/control/conversations");
const conv = conversations.find((c) => c.active)?.id ?? conversations[0]!.id;
const { frames } = await getJson<{ frames: Summary[] }>(`/control/list?conv=${conv}`);
// A clean captured turn frame; cli leg takes the last, browser leg the second-to-last.
const clean = frames.filter((f) => f.kind === "turn" && !f.deleted && !f.offloaded && !f.overridden);
const target = mode === "cli" ? clean.at(-1)! : clean.at(-2)!;
const before = { title: target.title, summary: target.summary };

if (mode === "cli") {
  const res = await fetch(`${base}/control/retitle?conv=${conv}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: target.id, regen: true }),
  });
  const body = (await res.json()) as { error?: string };
  check(res.ok, `regen retitle accepted (${res.status}${body.error ? `: ${body.error}` : ""})`);
}

if (mode === "browser") {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/ui`, { waitUntil: "networkidle" });
    await page.locator(".conv-switcher").selectOption(conv);
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "frames", exact: true }).click();
    await page.waitForSelector(`.frame-card[data-frame-id="${target.id}"]`);
    await page.locator(`.op-menu[data-frame-id="${target.id}"] summary`).click();
    await page.locator(`.op-menu[data-frame-id="${target.id}"] button[data-verb="retitle"]`).click();
    await page.locator('.op-form[data-op="retitle"] input[type="checkbox"]').check();
    await page.locator('.op-form[data-op="retitle"] button[type="submit"]').click();
    // The subscription completion takes a while — wait for the card title to
    // change, then screenshot as evidence (the API below is the oracle).
    await page.waitForFunction(
      ([id, oldTitle]) => {
        const el = document.querySelector(`.frame-card[data-frame-id="${id}"] .frame-title`);
        return !!el && el.textContent !== oldTitle;
      },
      [target.id, before.title] as [string, string],
      { timeout: 180_000 },
    );
    await page.screenshot({ path: `${dir}/regen-browser.png`, fullPage: true });
    check(
      (await page.locator(".op-error-banner").count()) === 0,
      "no refusal banner — the regen click succeeded",
    );
  } finally {
    await browser.close();
  }
}

// --- shared judgment: the API is the oracle ----------------------------------

const after = (await getJson<{ frames: Summary[] }>(`/control/list?conv=${conv}`)).frames.find(
  (f) => f.id === target.id,
)!;
check(
  after.title !== before.title && after.title.trim().length > 0,
  `title regenerated ("${before.title}" → "${after.title}")`,
);
check(
  !!after.summary && after.summary.trim().length > 0,
  `summary regenerated ("${after.summary ?? ""}")`,
);
const { commits } = await getJson<{ commits: Commit[] }>(`/control/history?conv=${conv}`);
const newest = commits.at(-1)!;
check(
  newest.type === "retitle" && newest.affectedFrameIds.includes(target.id),
  `newest commit is the regen retitle on ${target.id} (store mutated through the same op path)`,
);

if (failures > 0) {
  console.error(`live-regen ${mode}: FAILED`);
  process.exit(1);
}
console.log(`live-regen ${mode}: subscription regen verified via the control API`);
