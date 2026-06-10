// §11 Phase 5c — history tab component tests (happy-dom, contained per-file):
// third tab renders commits from the fetched log; click-to-revert dispatches
// the registry revert with a PROGRAMMATIC {commit}; the topbar button still
// sends {}; reverted marking is derived display state; refusals render
// verbatim; frame links select only known frames; timeline sub-toggle works.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const conversations = [
  {
    id: "conv-1",
    key: "k1",
    turnFrames: 1,
    totalTurnFrames: 1,
    forkFrames: 0,
    tokenEstimate: 20,
    lastIngestAt: null,
    active: true,
    suspicious: false,
  },
];

const baseSummary = {
  kind: "turn",
  role: "user",
  summary: null,
  messageCount: 1,
  overridden: false,
  offloaded: false,
  fileReference: null,
  origin: "captured",
  absorbedInto: null,
  splitInto: null,
  inLastView: true,
  deleted: false,
};
const frames = [{ ...baseSummary, id: "f1", title: "alpha", tokenEstimate: 10 }];

const baseFrame = {
  kind: "turn",
  role: "user",
  summary: null,
  anchorFp: "fp",
  occurrence: 0,
  stopReason: null,
  deleted: false,
  origin: "captured",
  offloaded: false,
  fileReference: null,
  provenance: [],
  createdEventId: "e1",
  createdAt: 1,
  modifiedAt: 1,
};
const shows: Record<string, unknown> = {
  f1: { ...baseFrame, id: "f1", title: "alpha", tokenEstimate: 10, messages: [{ role: "user", content: "one" }] },
};

const composeMeta = {
  conv: "conv-1",
  emittedFrameIds: ["f1"],
  wireWarnings: [],
  wireRepairs: [],
  structureWarnings: [],
  headHash: "h",
  hasCacheBreakpoint: true,
};

const history = [
  {
    id: "c1",
    type: "retitle",
    affectedFrameIds: ["f1"],
    params: { before: "old title", after: "new title" },
    note: "retitle f1",
    branchId: null,
    parentCommitId: null,
    timestamp: "ts1",
  },
  {
    id: "c2",
    type: "revert",
    affectedFrameIds: ["f1"],
    params: { revertedCommitId: "c1" },
    note: "revert c1",
    branchId: null,
    parentCommitId: "c1",
    timestamp: "ts2",
  },
  {
    id: "c3",
    type: "delete",
    affectedFrameIds: ["ghost-frame"], // unknown frame id — must render inert
    params: {},
    note: null,
    branchId: null,
    parentCommitId: "c2",
    timestamp: "ts3",
  },
];

const timeline = [
  { id: "e1", type: "capture", frameIds: ["f1"], commitId: null, timestamp: "ts0" },
  { id: "e2", type: "retitle", frameIds: ["f1"], commitId: "c1", timestamp: "ts1" },
];

interface PostRecord { path: string; body: Record<string, unknown> }
let posts: PostRecord[] = [];
let refuse: { route: string; status: number; error: string } | null = null;

const realFetch = globalThis.fetch;
function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input);
  const reply = (data: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  if (init?.method === "POST") {
    posts.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (refuse && path.startsWith(`${refuse.route}?`)) {
      return reply({ error: refuse.error }, refuse.status);
    }
    return reply({ conv: "conv-1", ok: true });
  }
  if (path.startsWith("/control/conversations")) return reply({ conversations });
  if (path.startsWith("/control/list")) return reply({ conv: "conv-1", frames });
  if (path.startsWith("/control/show")) {
    const id = new URL(path, "http://x").searchParams.get("id")!;
    return reply(shows[id]);
  }
  if (path.startsWith("/control/compose")) return reply(composeMeta);
  if (path.startsWith("/control/history")) return reply({ conv: "conv-1", commits: history });
  if (path.startsWith("/control/timeline")) return reply({ conv: "conv-1", events: timeline });
  throw new Error(`unexpected fetch in test: ${path}`);
}

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = stubFetch as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});
beforeEach(() => {
  posts = [];
  refuse = null;
  document.body.innerHTML = "";
});

async function renderApp() {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(App));
  });
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  return { container, act };
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function flush(act: typeof import("react").act) {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function openHistory(container: HTMLElement, act: typeof import("react").act) {
  const tab = Array.from(container.querySelectorAll(".view-toggle button")).find(
    (b) => b.textContent === "history",
  )!;
  await act(async () => click(tab));
}

test("history tab renders every commit (newest first) with derived reverted marking", async () => {
  const { container, act } = await renderApp();
  await openHistory(container, act);
  const cards = Array.from(container.querySelectorAll(".commit-card"));
  expect(cards.map((c) => c.getAttribute("data-commit-id"))).toEqual([
    "c3",
    "c2",
    "c1",
  ]);
  const c1 = container.querySelector('.commit-card[data-commit-id="c1"]')!;
  expect(c1.className).toContain("is-reverted");
  expect(c1.textContent).toContain("reverted");
  // The revert commit itself is a normal row of type revert.
  const c2 = container.querySelector('.commit-card[data-commit-id="c2"]')!;
  expect(c2.className).not.toContain("is-reverted");
  expect(c2.textContent).toContain("revert");
});

test("before/after params render as a two-column diff", async () => {
  const { container, act } = await renderApp();
  await openHistory(container, act);
  const c1 = container.querySelector('.commit-card[data-commit-id="c1"]')!;
  expect(c1.querySelector(".diff-before")!.textContent).toBe("old title");
  expect(c1.querySelector(".diff-after")!.textContent).toBe("new title");
});

test("click-to-revert posts the registry revert with a programmatic {commit}", async () => {
  const { container, act } = await renderApp();
  await openHistory(container, act);
  await act(async () =>
    click(container.querySelector('.commit-revert[data-commit-id="c1"]')!),
  );
  await flush(act);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path.startsWith("/control/revert?conv=conv-1")).toBe(true);
  expect(posts[0]!.body).toEqual({ commit: "c1" });
  // No form opened (revert has zero renderable params).
  expect(container.querySelector(".op-form")).toBeNull();
});

test("frames-toolbar revert-last still posts {} (5b behavior preserved; F-029 moved it off the topbar)", async () => {
  const { container, act } = await renderApp();
  const framesTab = Array.from(container.querySelectorAll(".view-toggle button")).find(
    (b) => b.textContent === "frames",
  )!;
  await act(async () => click(framesTab));
  await act(async () => click(container.querySelector(".store-ops .op-revert")!));
  await flush(act);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({});
});

test("already-reverted cards still offer revert; the daemon's refusal renders verbatim", async () => {
  const { container, act } = await renderApp();
  await openHistory(container, act);
  refuse = {
    route: "/control/revert",
    status: 400,
    error: "commit c1 was already reverted",
  };
  await act(async () =>
    click(container.querySelector('.commit-revert[data-commit-id="c1"]')!),
  );
  await flush(act);
  const banner = container.querySelector(".op-error-banner")!;
  expect(banner).not.toBeNull();
  expect(banner.textContent).toContain("commit c1 was already reverted");
});

test("frame links: known frames select into details; unknown ids render inert", async () => {
  const { container, act } = await renderApp();
  await openHistory(container, act);
  // c3 names ghost-frame — rendered as a non-clickable span, no crash.
  const c3 = container.querySelector('.commit-card[data-commit-id="c3"]')!;
  const ghost = c3.querySelector(".frame-link.unknown")!;
  expect(ghost).not.toBeNull();
  expect(ghost.tagName.toLowerCase()).toBe("span");
  // c1 names f1 — clicking opens the details panel for it.
  const c1 = container.querySelector('.commit-card[data-commit-id="c1"]')!;
  await act(async () => click(c1.querySelector("button.frame-link")!));
  const panel = container.querySelector(".details-panel")!;
  expect(panel).not.toBeNull();
  expect(panel.textContent).toContain("alpha");
});

test("timeline sub-toggle lists events (captures included) with commit links", async () => {
  const { container, act } = await renderApp();
  await openHistory(container, act);
  const tlTab = Array.from(
    container.querySelectorAll(".history-subtoggle button"),
  ).find((b) => (b.textContent ?? "").startsWith("timeline"))!;
  await act(async () => click(tlTab));
  const rows = Array.from(container.querySelectorAll(".event-row"));
  expect(rows.map((r) => r.getAttribute("data-event-id"))).toEqual(["e2", "e1"]);
  expect(rows[1]!.textContent).toContain("capture");
  expect(rows[0]!.textContent).toContain("c1");
});
