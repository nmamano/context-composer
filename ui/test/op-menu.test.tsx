// §11 Phase 5b — op surface component tests (happy-dom, contained per-file):
// the menu is GENERATED from the shared registry; param forms map values
// through spec.build; refusals render the daemon's text verbatim and stay
// sticky; success and refusal BOTH refetch through the single data path.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { OP_REGISTRY, singleTargetOps } from "../../src/shared/ops.ts";

// --- minimal control-API fixture (one conv, two frames) ----------------------

const conversations = [
  {
    id: "conv-1",
    key: "k1",
    turnFrames: 2,
    totalTurnFrames: 2,
    forkFrames: 0,
    tokenEstimate: 50,
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

const frames = [
  { ...baseSummary, id: "f1", title: "alpha", tokenEstimate: 10 },
  { ...baseSummary, id: "f2", title: "beta", tokenEstimate: 12 },
];

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
  // f2 is MULTI-message (a realistic captured turn): F-060's edit prefill must
  // NOT fire for it — flattening would silently restructure on submit.
  f2: {
    ...baseFrame,
    id: "f2",
    title: "beta",
    tokenEstimate: 12,
    messages: [
      { role: "user", content: "two" },
      { role: "assistant", content: "two answered" },
    ],
  },
};

const composeMeta = {
  conv: "conv-1",
  emittedFrameIds: ["f1", "f2"],
  wireWarnings: [],
  wireRepairs: [],
  structureWarnings: [],
  headHash: "h",
  hasCacheBreakpoint: true,
};

// §11 Phase 5c — history/timeline fixtures (mutable per-test via push).
const history: Record<string, unknown>[] = [];
const timeline: Record<string, unknown>[] = [];

// --- recording fetch stub -----------------------------------------------------

interface PostRecord { path: string; body: Record<string, unknown> }
let posts: PostRecord[] = [];
let getCounts: Record<string, number> = {};
/** Set per-test: route → {status, body} to refuse the next matching POST. */
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
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push({ path, body });
    if (refuse && path.startsWith(`${refuse.route}?`)) {
      return reply({ error: refuse.error }, refuse.status);
    }
    return reply({ conv: "conv-1", ok: true });
  }
  const key = path.split("?")[0]!;
  getCounts[key] = (getCounts[key] ?? 0) + 1;
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

// --- harness ------------------------------------------------------------------

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
  getCounts = {};
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
  return { container, act, root };
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

async function openFrameView(container: HTMLElement, act: typeof import("react").act) {
  const tab = Array.from(container.querySelectorAll(".view-toggle button")).find(
    (b) => b.textContent === "frames",
  )!;
  await act(async () => click(tab));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // React tracks inputs via the native value setter — go around its cache so
  // dispatching `input` is seen as a real change (no testing-library, by plan).
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "value")!;
  desc.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "value")!;
  desc.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

test("op menu is GENERATED from the registry — every single-target verb, nothing else", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  const menuButtons = Array.from(
    container.querySelectorAll('.op-menu[data-frame-id="f1"] button[data-verb]'),
  ).map((b) => b.getAttribute("data-verb"));
  expect(menuButtons).toEqual(singleTargetOps().map((o) => o.verb));
  // F-029: store-scoped ops (none-arity) live in the FRAMES-VIEW toolbar —
  // deliberately not in the nav bar. F-046: revert-last is NOT here either —
  // it undoes the last commit, so it lives in the history tab (see
  // history-view.test.tsx for its placement + wiring).
  expect(container.querySelector(".frame-view .store-ops .op-add")).not.toBeNull();
  expect(container.querySelector(".frame-view .store-ops .op-revert")).toBeNull();
  expect(container.querySelector(".frame-view .store-ops .op-combine")).not.toBeNull();
  expect(container.querySelector(".topbar .op-add")).toBeNull();
  expect(container.querySelector(".topbar .op-revert")).toBeNull();
  expect(container.querySelector(".topbar .op-combine")).toBeNull();
});

test("param-less op (delete) POSTs the registry body and refetches both views' sources", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  const listBefore = getCounts["/control/list"] ?? 0;
  const composeBefore = getCounts["/control/compose"] ?? 0;
  const del = container.querySelector(
    '.op-menu[data-frame-id="f1"] button[data-verb="delete"]',
  )!;
  await act(async () => click(del));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path.startsWith("/control/delete?conv=conv-1")).toBe(true);
  expect(posts[0]!.body).toEqual({ ids: ["f1"] });
  // The single data path re-ran: both views' sources re-fetched.
  expect(getCounts["/control/list"]).toBe(listBefore + 1);
  expect(getCounts["/control/compose"]).toBe(composeBefore + 1);
});

test("param op (edit) opens the generated form and maps values via build()", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  const edit = container.querySelector(
    '.op-menu[data-frame-id="f2"] button[data-verb="edit"]',
  )!;
  await act(async () => click(edit));
  const form = container.querySelector('.op-form[data-op="edit"]')!;
  expect(form).not.toBeNull();
  // Required param empty → submit disabled (presence-only gating). f2 is
  // multi-message, so F-060's prefill correctly stayed away.
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  const ta = form.querySelector("textarea") as HTMLTextAreaElement;
  expect(ta.value).toBe("");
  await act(async () => setNativeValue(ta, "replacement text"));
  await act(async () => click(form.querySelector('button[type="submit"]')!));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path.startsWith("/control/edit?conv=conv-1")).toBe(true);
  expect(posts[0]!.body).toEqual({ id: "f2", text: "replacement text" });
});

test("refusal renders the daemon's text VERBATIM, sticky until dismissed; refetch still runs", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  refuse = {
    route: "/control/restore",
    status: 400,
    error: "frame f1 is not offloaded",
  };
  const listBefore = getCounts["/control/list"] ?? 0;
  const restore = container.querySelector(
    '.op-menu[data-frame-id="f1"] button[data-verb="restore"]',
  )!;
  await act(async () => click(restore));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  const banner = container.querySelector(".op-error-banner")!;
  expect(banner).not.toBeNull();
  expect(banner.textContent).toContain("restore");
  expect(banner.textContent).toContain("f1");
  expect(banner.textContent).toContain("frame f1 is not offloaded"); // verbatim
  // Refusal STILL refetches (state may have changed server-side regardless).
  expect(getCounts["/control/list"]).toBe(listBefore + 1);
  // Sticky: survives the successful refetch; cleared by manual dismiss.
  await act(async () => click(banner.querySelector(".dismiss")!));
  expect(container.querySelector(".op-error-banner")).toBeNull();
});

test("next SUCCESSFUL op clears the sticky refusal", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  refuse = { route: "/control/restore", status: 400, error: "nope" };
  await act(async () =>
    click(
      container.querySelector('.op-menu[data-frame-id="f1"] button[data-verb="restore"]')!,
    ),
  );
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(container.querySelector(".op-error-banner")).not.toBeNull();
  refuse = null;
  await act(async () =>
    click(
      container.querySelector('.op-menu[data-frame-id="f1"] button[data-verb="delete"]')!,
    ),
  );
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(container.querySelector(".op-error-banner")).toBeNull();
});

test("combine: selection mode collects ids in click order and POSTs {ids}", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  await act(async () => click(container.querySelector(".store-ops .op-combine")!));
  const checks = container.querySelectorAll(".combine-check");
  expect(checks.length).toBe(2);
  // Select f2 first, then f1 — order must be preserved (combine is ordered).
  const check = (id: string) =>
    container.querySelector(`.frame-card[data-frame-id="${id}"] .combine-check`)!;
  // React drives checkbox onChange from click events — dispatch real clicks.
  await act(async () => click(check("f2")));
  await act(async () => click(check("f1")));
  const run = container.querySelector(".op-combine-run") as HTMLButtonElement;
  expect(run.disabled).toBe(false);
  await act(async () => click(run));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path.startsWith("/control/combine?conv=conv-1")).toBe(true);
  expect(posts[0]!.body).toEqual({ ids: ["f2", "f1"] });
});

test("add: F-039 position DROPDOWN maps start → after:null; frames listed as 'after <id>'", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  await act(async () => click(container.querySelector(".store-ops .op-add")!));
  const form = container.querySelector('.op-form[data-op="add"]')!;
  // F-040: the committing button is the bare verb, styled primary.
  const submit = form.querySelector('button[type="submit"]')!;
  expect(submit.textContent).toBe("add");
  expect(submit.classList.contains("primary")).toBe(true);
  const ta = form.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => setNativeValue(ta, "injected note"));
  // F-039: explicit AFTER semantics in a dropdown — default end, start, per-frame.
  const pos = form.querySelector("select") as HTMLSelectElement;
  const labels = Array.from(pos.options).map((o) => o.textContent);
  expect(labels[0]).toBe("at the end");
  expect(labels[1]).toBe("at the start");
  expect(labels.some((l) => l!.startsWith("after f1"))).toBe(true);
  await act(async () => setSelectValue(pos, "start"));
  await act(async () => click(form.querySelector('button[type="submit"]')!));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ text: "injected note", after: null });
});

test("F-042: combine opens a panel with cancel inside; toolbar ops are mutually exclusive", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  // Combine opens its panel (explainer + run + cancel) — F-041 copy present.
  await act(async () => click(container.querySelector(".store-ops .op-combine")!));
  const panel = container.querySelector(".combine-panel")!;
  expect(panel).not.toBeNull();
  expect(panel.textContent).toContain("no AI rewriting");
  expect(panel.querySelector(".op-combine-run")).not.toBeNull();
  // Opening ADD auto-cancels combine (mutual exclusion)…
  await act(async () => click(container.querySelector(".store-ops .op-add")!));
  expect(container.querySelector(".combine-panel")).toBeNull();
  expect(container.querySelector('.op-form[data-op="add"]')).not.toBeNull();
  // …and opening combine auto-cancels the pending add form.
  await act(async () => click(container.querySelector(".store-ops .op-combine")!));
  expect(container.querySelector('.op-form[data-op="add"]')).toBeNull();
  expect(container.querySelector(".combine-panel")).not.toBeNull();
  // Cancel INSIDE the panel closes it.
  const cancel = Array.from(container.querySelectorAll(".combine-panel button")).find(
    (b) => b.textContent === "cancel",
  )!;
  await act(async () => click(cancel));
  expect(container.querySelector(".combine-panel")).toBeNull();
});

test("ops are never hidden by frame state (a deleted frame still offers the full menu)", async () => {
  // Same registry menu regardless of flags — the daemon's guards speak.
  frames[0]!.deleted = true;
  try {
    const { container, act } = await renderApp();
    await openFrameView(container, act);
    const verbs = Array.from(
      container.querySelectorAll('.op-menu[data-frame-id="f1"] button[data-verb]'),
    ).map((b) => b.getAttribute("data-verb"));
    expect(verbs).toEqual(singleTargetOps().map((o) => o.verb));
  } finally {
    frames[0]!.deleted = false;
  }
});

test("F-002: an open ops menu dismisses on outside click (and stays open on inside click)", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  const menu = container.querySelector('.op-menu[data-frame-id="f1"]')!;
  await act(async () => menu.setAttribute("open", ""));
  // Click INSIDE the open menu (the list padding) — stays open.
  await act(async () => click(menu.querySelector("ul")!));
  expect(menu.hasAttribute("open")).toBe(true);
  // Click OUTSIDE (another frame card) — closes.
  await act(async () => click(container.querySelector('.frame-card[data-frame-id="f2"]')!));
  expect(menu.hasAttribute("open")).toBe(false);
});

test("F-003: offload form opens with the stub summary PREFILLED (engine-default preview), submitted explicitly", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  await act(async () =>
    click(container.querySelector('.op-menu[data-frame-id="f1"] button[data-verb="offload"]')!),
  );
  const input = container.querySelector(
    '.op-form[data-op="offload"] input[type="text"]',
  ) as HTMLInputElement;
  // f1's emission is [{role:"user",content:"one"}] → deriveSummary → "one".
  expect(input.value).toBe("one");
  await act(async () =>
    click(container.querySelector('.op-form[data-op="offload"] button[type="submit"]')!),
  );
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  // The prefill rides the body verbatim — the same value the daemon would
  // have derived had the param been omitted.
  expect(posts[0]!.body).toEqual({ id: "f1", summary: "one" });
});

test("F-008/F-029: forms render next to their trigger — under the card, or under the frames toolbar", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  await act(async () =>
    click(container.querySelector('.op-menu[data-frame-id="f2"] button[data-verb="edit"]')!),
  );
  const inlineHost = container.querySelector(".op-form-host")!;
  expect(inlineHost.classList.contains("inline")).toBe(true);
  // Placed immediately after the card it targets, inside the frame view.
  const card = container.querySelector('.frame-card[data-frame-id="f2"]')!;
  expect(card.nextElementSibling).toBe(inlineHost);
  expect(inlineHost.closest(".frame-view")).not.toBeNull();
  // Cancel, then a store-scoped op (add): form renders under the toolbar,
  // still inside the frame view (F-029).
  await act(async () => click(inlineHost.querySelector('.op-form-actions button[type="button"]')!));
  await act(async () => click(container.querySelector(".store-ops .op-add")!));
  const toolbarHost = container.querySelector(".op-form-host")!;
  expect(toolbarHost.classList.contains("toolbar")).toBe(true);
  expect(toolbarHost.closest(".frame-view")).not.toBeNull();
  expect(
    container.querySelector(".frame-toolbar")!.nextElementSibling,
  ).toBe(toolbarHost);
  // F-056 (Nil): navigating away CLOSES the pending form — no carry-over
  // (replaces the old top-host fallback for view switches).
  const convTab = Array.from(container.querySelectorAll(".view-toggle button")).find(
    (b) => b.textContent === "conversation",
  )!;
  await act(async () => click(convTab));
  expect(container.querySelector(".op-form-host")).toBeNull();
  expect(container.querySelector('.op-form[data-op="add"]')).toBeNull();
  // Coming back does not resurrect it either.
  const framesTab = Array.from(container.querySelectorAll(".view-toggle button")).find(
    (b) => b.textContent === "frames",
  )!;
  await act(async () => click(framesTab));
  expect(container.querySelector(".op-form-host")).toBeNull();
});

test("every registry op with params declares only renderable kinds", () => {
  for (const op of OP_REGISTRY) {
    for (const p of op.params) {
      expect(["text", "textarea", "flag", "position", "indices", "ids"]).toContain(p.kind);
    }
  }
});

// F-047: the combine panel's position dropdown — same value semantics as the
// add form ("" omits → engine default: first pick's slot; "start" → null;
// frame id → after that frame). Default body stays {ids} (pinned above).
test("F-047: combine position dropdown — default omits after; start maps to null; id maps through", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  await act(async () => click(container.querySelector(".store-ops .op-combine")!));
  const panel = container.querySelector(".combine-panel")!;
  const pos = panel.querySelector(".combine-position select") as HTMLSelectElement;
  expect(pos).not.toBeNull();
  const labels = Array.from(pos.options).map((o) => o.textContent);
  expect(labels[0]).toBe("at the first picked frame's place"); // engine default, named
  expect(labels[1]).toBe("at the start");
  expect(labels.some((l) => l!.startsWith("after f1"))).toBe(true);

  const check = (id: string) =>
    container.querySelector(`.frame-card[data-frame-id="${id}"] .combine-check`)!;
  await act(async () => click(check("f1")));
  await act(async () => click(check("f2")));
  await act(async () => setSelectValue(pos, "start"));
  await act(async () => click(panel.querySelector(".op-combine-run")!));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ ids: ["f1", "f2"], after: null });

  // A frame-id position maps through as after:<id> (fresh panel: state reset).
  await act(async () => click(container.querySelector(".store-ops .op-combine")!));
  const panel2 = container.querySelector(".combine-panel")!;
  const pos2 = panel2.querySelector(".combine-position select") as HTMLSelectElement;
  expect(pos2.value).toBe(""); // F-047: position resets with the mode
  await act(async () => click(check("f1")));
  await act(async () => click(check("f2")));
  await act(async () => setSelectValue(pos2, "f2"));
  await act(async () => click(panel2.querySelector(".op-combine-run")!));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body).toEqual({ ids: ["f1", "f2"], after: "f2" });
});

// F-060: edit opens PREFILLED with the frame's current content when faithful
// (single text message carrying the role edit would write) — an unchanged
// submit reproduces the emission. prefill.test.ts pins the faithfulness rules;
// this pins the flow through the form.
test("F-060: edit form opens prefilled for a single-text-message frame; unchanged submit reproduces it", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  await act(async () =>
    click(container.querySelector('.op-menu[data-frame-id="f1"] button[data-verb="edit"]')!),
  );
  const form = container.querySelector('.op-form[data-op="edit"]')!;
  const ta = form.querySelector("textarea") as HTMLTextAreaElement;
  expect(ta.value).toBe("one"); // f1's lone user message, verbatim
  // Prefill satisfies the required param — submit enabled immediately.
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  await act(async () => click(submit));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ id: "f1", text: "one" });
});

// F-061: the compact form explains itself — explainer line, prefilled summary
// text (the offload chain), plain-language tips on both fields.
test("F-061: compact form opens prefilled with the summary chain, carries an explainer and jargon-free tips", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  await act(async () =>
    click(container.querySelector('.op-menu[data-frame-id="f1"] button[data-verb="compact"]')!),
  );
  const form = container.querySelector('.op-form[data-op="compact"]')!;
  // Explainer orients the user (the F-042 combine-panel pattern).
  const explainer = form.querySelector(".op-form-explainer")!;
  expect(explainer).not.toBeNull();
  expect(explainer.textContent).toContain("Shrink what the model sees");
  // Prefill: f1.summary is null → engine derive over the emission → "one".
  const ta = form.querySelector("textarea") as HTMLTextAreaElement;
  expect(ta.value).toBe("one");
  // Both fields carry instant tips, free of engine jargon (the F-028 ban).
  const tips = Array.from(form.querySelectorAll(".op-param[data-tip]")).map(
    (el) => el.getAttribute("data-tip")!,
  );
  expect(tips.length).toBe(2);
  for (const tip of tips) {
    expect(tip.length).toBeGreaterThan(0);
    for (const word of ["emission", "audit", "registry", "arity"]) {
      expect(tip.toLowerCase()).not.toContain(word);
    }
  }
  // The regen tip states the precedence truth: ticked regen ignores the box.
  expect(form.querySelector(".op-flag")!.getAttribute("data-tip")).toContain(
    "text box is ignored",
  );
});

// F-063: position dropdowns offer only viable destinations — deleted frames,
// fork-only frames and the preamble (whose anchor can ONLY refuse: the
// engine's add/move/combine lookup covers turn frames alone) are filtered
// from the OPTION list. A destination-list filter, not op hiding: the menu
// itself stays complete (pinned by the "ops are never hidden" test) and the
// daemon's refusals still render verbatim.
test("F-063: position dropdowns exclude deleted, fork-only and preamble frames", async () => {
  const extras = [
    { ...baseSummary, id: "p0", kind: "preamble", title: "preamble", tokenEstimate: 9, inLastView: null },
    { ...baseSummary, id: "f3", title: "tombstone", tokenEstimate: 5, deleted: true },
    { ...baseSummary, id: "f4", title: "side query", tokenEstimate: 7, inLastView: false },
  ];
  frames.push(...(extras as unknown as typeof frames));
  shows.p0 = { ...baseFrame, id: "p0", kind: "preamble", title: "preamble", tokenEstimate: 9, messages: [] };
  shows.f3 = { ...baseFrame, id: "f3", title: "tombstone", tokenEstimate: 5, deleted: true, messages: [{ role: "user", content: "x" }] };
  shows.f4 = { ...baseFrame, id: "f4", title: "side query", tokenEstimate: 7, messages: [{ role: "user", content: "y" }] };
  try {
    const { container, act } = await renderApp();
    await openFrameView(container, act);
    // The ADD form's dropdown (shared position renderer)…
    await act(async () => click(container.querySelector(".store-ops .op-add")!));
    const addPos = container.querySelector(
      '.op-form[data-op="add"] select',
    ) as HTMLSelectElement;
    const addValues = Array.from(addPos.options).map((o) => o.value);
    expect(addValues).toEqual(["", "start", "f1", "f2"]); // no p0/f3/f4
    // …and the combine panel's own dropdown.
    await act(async () => click(container.querySelector(".store-ops .op-combine")!));
    const combinePos = container.querySelector(
      ".combine-position select",
    ) as HTMLSelectElement;
    const combineValues = Array.from(combinePos.options).map((o) => o.value);
    expect(combineValues).toEqual(["", "start", "f1", "f2"]);
  } finally {
    frames.splice(2);
    delete shows.p0;
    delete shows.f3;
    delete shows.f4;
  }
});
