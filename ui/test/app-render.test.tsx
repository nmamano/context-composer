// §11 Phase 5a — App render test: the React path end-to-end under happy-dom
// with a stubbed control API. Proves the wiring (fetch → state → both views →
// details), not the engine; the REAL-browser/real-daemon proof is the
// Playwright smoke (scripts/ui-smoke.sh). happy-dom registration is contained
// to this file (register in beforeAll, unregister in afterAll) so the engine
// tests' Bun fetch/Response globals are untouched.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// --- control-API fixtures (engine-shaped; see state.ts/registry.ts) ---------

const conversations = [
  {
    id: "conv-1",
    key: "k1",
    turnFrames: 2,
    totalTurnFrames: 3,
    forkFrames: 0,
    tokenEstimate: 120,
    lastIngestAt: "2026-06-10T00:00:00Z",
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
};

const frames = [
  {
    ...baseSummary,
    id: "p0",
    kind: "preamble",
    role: "system",
    title: "preamble",
    tokenEstimate: 30,
    deleted: false,
    inLastView: null,
  },
  { ...baseSummary, id: "f1", title: "greeting", tokenEstimate: 40, deleted: false },
  {
    ...baseSummary,
    id: "f2",
    title: "secret turn",
    tokenEstimate: 25,
    deleted: true,
  },
  {
    ...baseSummary,
    id: "f3",
    title: "big dump",
    tokenEstimate: 25,
    deleted: false,
    overridden: true,
    offloaded: true,
    fileReference: "/tmp/cc-frames/f3-abc.md",
  },
  // F-006: a fork-only frame (inLastView STRICTLY false) — hidden by default
  // in the frame view, revealed by the toggle.
  {
    ...baseSummary,
    id: "f4",
    title: "fork side call",
    tokenEstimate: 9,
    deleted: false,
    inLastView: false,
  },
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
  p0: {
    ...baseFrame,
    id: "p0",
    kind: "preamble",
    role: "system",
    title: "preamble",
    tokenEstimate: 30,
    messages: [],
    system: "You are a test agent",
  },
  f1: {
    ...baseFrame,
    id: "f1",
    title: "greeting",
    tokenEstimate: 40,
    messages: [
      { role: "user", content: "hello from the TUI" },
      { role: "assistant", content: "hello from the model" },
    ],
  },
  f2: {
    ...baseFrame,
    id: "f2",
    title: "secret turn",
    tokenEstimate: 25,
    deleted: true,
    provenance: ["c1"],
    messages: [{ role: "user", content: "TOMBSTONED-CONTENT" }],
  },
  f3: {
    ...baseFrame,
    id: "f3",
    title: "big dump",
    tokenEstimate: 25,
    offloaded: true,
    fileReference: "/tmp/cc-frames/f3-abc.md",
    provenance: ["c2"],
    messages: [{ role: "user", content: "ORIGINAL-HUGE-SOURCE" }],
    representation: [
      { role: "user", content: "[offloaded] read /tmp/cc-frames/f3-abc.md" },
    ],
  },
  f4: {
    ...baseFrame,
    id: "f4",
    title: "fork side call",
    tokenEstimate: 9,
    messages: [{ role: "user", content: "FORK-ONLY-CONTENT" }],
  },
};

const composeMeta = {
  conv: "conv-1",
  emittedFrameIds: ["f1", "f3"], // engine truth: f2 tombstoned, preamble is head
  wireWarnings: [],
  wireRepairs: [],
  structureWarnings: [],
  headHash: "h",
  hasCacheBreakpoint: true,
};

// --- fetch stub --------------------------------------------------------------

const realFetch = globalThis.fetch;
function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const path = String(input);
  const reply = (data: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  if (path.startsWith("/control/conversations")) return reply({ conversations });
  if (path.startsWith("/control/list")) {
    if (!path.includes("conv=conv-1")) throw new Error(`list without explicit conv: ${path}`);
    return reply({ conv: "conv-1", frames });
  }
  if (path.startsWith("/control/show")) {
    if (!path.includes("conv=conv-1")) throw new Error(`show without explicit conv: ${path}`);
    const id = new URL(path, "http://x").searchParams.get("id")!;
    return reply(shows[id]);
  }
  if (path.startsWith("/control/compose")) {
    if (!path.includes("conv=conv-1")) throw new Error(`compose without explicit conv: ${path}`);
    return reply(composeMeta);
  }
  if (path.startsWith("/control/history")) {
    if (!path.includes("conv=conv-1")) throw new Error(`history without explicit conv: ${path}`);
    return reply({ conv: "conv-1", commits: [] });
  }
  if (path.startsWith("/control/timeline")) {
    if (!path.includes("conv=conv-1")) throw new Error(`timeline without explicit conv: ${path}`);
    return reply({ conv: "conv-1", events: [] });
  }
  throw new Error(`unexpected fetch in test: ${path}`);
}

// --- harness ------------------------------------------------------------------

let root: import("react-dom/client").Root | null = null;

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = stubFetch as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

async function flush(act: (cb: () => Promise<void>) => Promise<void>) {
  // Let the loadConversation promise chain settle (a few microtask+timer hops).
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

test("App: conversation view hides tombstones, frame view flags them, details panel maps offload", async () => {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  const { App } = await import("../src/App.tsx");

  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(App));
  });
  await flush(act);

  // Conversation view (default): emitted content present, in engine order…
  const text = container.textContent ?? "";
  expect(text).toContain("hello from the TUI");
  expect(text).toContain("hello from the model");
  expect(text).toContain("[offloaded] read /tmp/cc-frames/f3-abc.md");
  // …tombstoned frame hidden, and the offloaded frame's SOURCE not in this view.
  expect(text).not.toContain("TOMBSTONED-CONTENT");
  expect(text).not.toContain("ORIGINAL-HUGE-SOURCE");
  // Switcher shows the conversation.
  expect(text).toContain("conv-1");

  // Toggle to the frame view: every NON-FORK frame is a card, deleted flagged
  // not hidden; the fork-only f4 is hidden by default (F-006 — asserted by
  // this exact list and exercised further in the dedicated test below).
  const tabs = Array.from(container.querySelectorAll(".view-toggle button"));
  const framesTab = tabs.find((b) => b.textContent === "frames")!;
  await act(async () => click(framesTab));
  const cards = Array.from(container.querySelectorAll(".frame-card"));
  expect(cards.map((c) => c.getAttribute("data-frame-id"))).toEqual([
    "p0",
    "f1",
    "f2",
    "f3",
  ]);
  const f2card = cards.find((c) => c.getAttribute("data-frame-id") === "f2")!;
  expect(f2card.textContent).toContain("deleted");
  const f3card = cards.find((c) => c.getAttribute("data-frame-id") === "f3")!;
  expect(f3card.textContent).toContain("offloaded");

  // Click the offloaded card → details panel: fileReference + explicit
  // source-vs-current sections (stub as current, source preserved).
  await act(async () => click(f3card));
  const panel = container.querySelector(".details-panel")!;
  expect(panel).not.toBeNull();
  const ptext = panel.textContent ?? "";
  expect(ptext).toContain("/tmp/cc-frames/f3-abc.md");
  expect(ptext).toContain("current emission");
  expect(ptext).toContain("[offloaded] read /tmp/cc-frames/f3-abc.md");
  expect(ptext).toContain("source (agent's resend baseline)");
  expect(ptext).toContain("ORIGINAL-HUGE-SOURCE");

  // Tombstone details: source content reachable from the frame view card.
  const f2cardAgain = container.querySelector('[data-frame-id="f2"]')!;
  await act(async () => click(f2cardAgain));
  const ptext2 = container.querySelector(".details-panel")!.textContent ?? "";
  expect(ptext2).toContain("tombstone");
  expect(ptext2).toContain("TOMBSTONED-CONTENT");

  await act(async () => {
    root?.unmount();
  });
});

async function renderApp() {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("../src/App.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const r = createRoot(container);
  await act(async () => {
    r.render(createElement(App));
  });
  await flush(act);
  const tab = (name: string) =>
    Array.from(container.querySelectorAll(".view-toggle button")).find(
      (b) => b.textContent === name,
    )!;
  return { container, act, tab, unmount: () => act(async () => r.unmount()) };
}

// F-014 (plans/ui-feedback.md): a details selection carried INTO history is
// stale context — hidden there, restored on exit; an explicit selection made
// inside history (frame links) still opens the panel.
test("F-014: details panel is stashed entering history and restored on leaving", async () => {
  const { container, act, tab, unmount } = await renderApp();
  await act(async () => click(tab("frames")));
  await act(async () => click(container.querySelector('.frame-card[data-frame-id="f1"]')!));
  expect(container.querySelector(".details-panel")).not.toBeNull();

  await act(async () => click(tab("history")));
  expect(container.querySelector(".details-panel")).toBeNull();

  await act(async () => click(tab("frames")));
  const panel = container.querySelector(".details-panel");
  expect(panel).not.toBeNull();
  expect(panel!.querySelector("h2")!.textContent).toBe("greeting"); // f1 restored
  await unmount();
});

// F-009 (plans/ui-feedback.md): the active conversation's identity is shown as
// selectable text and the copy button puts the FULL key on the clipboard.
test("F-009: conv identity rendered selectable; copy button copies the full key", async () => {
  const { container, act, unmount } = await renderApp();
  const code = container.querySelector(".conv-key code")!;
  expect(code).not.toBeNull();
  // F-030: the span carries the KEY only — the id already sits in the switcher.
  expect(code.textContent).not.toContain("conv-1");
  expect(code.textContent).toContain("k1");
  expect(container.querySelector(".conv-key")!.getAttribute("title")).toContain("k1");
  // Stub the clipboard API; the button must copy the FULL key.
  const copied: { text: string | null } = { text: null };
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: {
      writeText: (t: string) => {
        copied.text = t;
        return Promise.resolve();
      },
    },
    configurable: true,
  });
  try {
    await act(async () => click(container.querySelector(".copy-key")!));
    expect(copied.text).toBe("k1");
    expect(container.querySelector(".copy-key")!.textContent).toBe("✓");
  } finally {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
  }
  await unmount();
});

// F-006 (Nil-confirmed): fork-only frames are hidden in the frame view by
// default; the toggle reveals them (strictly inLastView === false — null/true
// frames are never filtered).
test("F-006: fork-only frames hidden by default; toggle reveals and re-hides", async () => {
  const { container, act, tab, unmount } = await renderApp();
  await act(async () => click(tab("frames")));
  const ids = () =>
    Array.from(container.querySelectorAll(".frame-card")).map((c) =>
      c.getAttribute("data-frame-id"),
    );
  expect(ids()).toEqual(["p0", "f1", "f2", "f3"]); // f4 hidden
  const toggle = container.querySelector(".fork-toggle input")!;
  expect(container.querySelector(".fork-toggle")!.textContent).toContain("(1)");
  await act(async () => click(toggle));
  expect(ids()).toEqual(["p0", "f1", "f2", "f3", "f4"]); // store order kept
  // The revealed card carries the fork-only chip (flag truth untouched).
  expect(
    container.querySelector('.frame-card[data-frame-id="f4"] .chip-fork-only'),
  ).not.toBeNull();
  await act(async () => click(toggle));
  expect(ids()).toEqual(["p0", "f1", "f2", "f3"]);
  await unmount();
});

// F-018: entering the conversation view with a selection jumps to its bubble;
// F-020: without one, the view offers the jump-to-latest control.
test("F-018/F-020: conversation view jumps to the selected frame on entry; jump button present", async () => {
  // happy-dom has no layout — record scrollIntoView calls on the prototype.
  const jumped: string[] = [];
  const proto = Element.prototype as unknown as Record<string, unknown>;
  const prevScroll = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element) {
    jumped.push(this.getAttribute("data-frame-id") ?? "?");
  };
  try {
    const { container, act, tab, unmount } = await renderApp();
    // No selection: no jump-to-frame, but the discreet button exists (F-020).
    expect(container.querySelector(".jump-bottom")).not.toBeNull();
    expect(jumped).toEqual([]);
    // Select f1 in the frame view, return to conversation: jump to f1.
    await act(async () => click(tab("frames")));
    await act(async () => click(container.querySelector('.frame-card[data-frame-id="f1"]')!));
    await act(async () => click(tab("conversation")));
    expect(jumped).toEqual(["f1"]);
    // Clicking the jump button is a no-throw scroll-to-bottom.
    await act(async () => click(container.querySelector(".jump-bottom")!));
    await unmount();
  } finally {
    if (prevScroll === undefined) delete proto.scrollIntoView;
    else proto.scrollIntoView = prevScroll;
  }
});

// F-021/F-028/F-031: every interactive control explains itself via data-tip
// (instant CSS tooltip; the <select> keeps native title) — and the copy is
// plain language: no engine jargon (Nil's F-028 words: emission/audit).
test("F-021/F-028: all controls carry tooltips, free of jargon", async () => {
  const { container, act, tab, unmount } = await renderApp();
  const tipOf = (el: Element) =>
    el.getAttribute("data-tip") ?? el.getAttribute("title") ?? "";
  const topbarControls = Array.from(
    container.querySelectorAll(".topbar button, .topbar select"),
  );
  expect(topbarControls.length).toBeGreaterThanOrEqual(5); // 3 tabs, copy, refresh (+switcher)
  for (const el of topbarControls) expect(tipOf(el).length).toBeGreaterThan(0);
  // Frames view: toolbar store-ops + the per-frame ops trigger.
  await act(async () => click(tab("frames")));
  for (const sel of [".store-ops .op-add", ".store-ops .op-revert", ".store-ops .op-combine", ".op-menu summary"]) {
    expect(tipOf(container.querySelector(sel)!).length).toBeGreaterThan(0);
  }
  // F-028: jargon words banned from every tooltip in the app.
  const allTips = Array.from(container.querySelectorAll("[data-tip], [title]")).map(tipOf);
  for (const word of ["emission", "audit", "registry", "arity"]) {
    for (const tip of allTips) {
      expect(tip.toLowerCase()).not.toContain(word);
    }
  }
  await unmount();
});

// F-025: the switcher options carry id + turns only — the key lives ONLY in
// the conv-key span (single surface, short prefix, copy-full).
test("F-025: conversation identity appears once — options have no key, the span has it", async () => {
  const { container, unmount } = await renderApp();
  const option = container.querySelector(".conv-switcher option")!;
  expect(option.textContent).toContain("conv-1");
  expect(option.textContent).toContain("turns");
  expect(option.textContent).not.toContain("k1");
  expect(container.querySelector(".conv-key code")!.textContent).toContain("k1");
  await unmount();
});

// F-015/F-016: the panel defaults to the core subset with the chips row
// reserved; show-all reveals the advanced fields.
test("F-015: details panel shows core fields by default; toggle reveals advanced", async () => {
  const { container, act, tab, unmount } = await renderApp();
  await act(async () => click(tab("frames")));
  await act(async () => click(container.querySelector('.frame-card[data-frame-id="f3"]')!));
  const labels = () =>
    Array.from(container.querySelectorAll(".details-row dt")).map((e) => e.textContent);
  // Core subset: identity + emission-state fields.
  expect(labels()).toContain("id");
  expect(labels()).toContain("offloaded");
  expect(labels()).toContain("fileReference");
  // Audit fields hidden by default…
  expect(labels()).not.toContain("provenance");
  expect(labels()).not.toContain("origin");
  // …revealed by the toggle.
  await act(async () => click(container.querySelector(".fields-toggle")!));
  expect(labels()).toContain("provenance");
  expect(labels()).toContain("origin");
  expect(labels()).toContain("kind");
  // F-016: chips row exists even for a clean frame (reserved space).
  await act(async () => click(container.querySelector('.frame-card[data-frame-id="f1"]')!));
  expect(container.querySelector(".details-panel .chips-reserved")).not.toBeNull();
  await unmount();
});
