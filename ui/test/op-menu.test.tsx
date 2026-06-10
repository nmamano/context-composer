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
  f2: { ...baseFrame, id: "f2", title: "beta", tokenEstimate: 12, messages: [{ role: "user", content: "two" }] },
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

test("op menu is GENERATED from the registry — every single-target verb, nothing else", async () => {
  const { container, act } = await renderApp();
  await openFrameView(container, act);
  const menuButtons = Array.from(
    container.querySelectorAll('.op-menu[data-frame-id="f1"] button[data-verb]'),
  ).map((b) => b.getAttribute("data-verb"));
  expect(menuButtons).toEqual(singleTargetOps().map((o) => o.verb));
  // Store-scoped ops (none-arity) live in the topbar instead.
  expect(container.querySelector(".store-ops .op-add")).not.toBeNull();
  expect(container.querySelector(".store-ops .op-revert")).not.toBeNull();
  expect(container.querySelector(".store-ops .op-combine")).not.toBeNull();
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
  // Required param empty → submit disabled (presence-only gating).
  const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  const ta = form.querySelector("textarea") as HTMLTextAreaElement;
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

test("revert(last) from the topbar POSTs {} to /control/revert with explicit conv", async () => {
  const { container, act } = await renderApp();
  await act(async () => click(container.querySelector(".store-ops .op-revert")!));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path.startsWith("/control/revert?conv=conv-1")).toBe(true);
  expect(posts[0]!.body).toEqual({});
});

test("add: explicit position mapping (start → after:null) via the topbar form", async () => {
  const { container, act } = await renderApp();
  await act(async () => click(container.querySelector(".store-ops .op-add")!));
  const form = container.querySelector('.op-form[data-op="add"]')!;
  const ta = form.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => setNativeValue(ta, "injected note"));
  const pos = form.querySelector('input[type="text"]') as HTMLInputElement;
  await act(async () => setNativeValue(pos, "start"));
  await act(async () => click(form.querySelector('button[type="submit"]')!));
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ text: "injected note", after: null });
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

test("every registry op with params declares only renderable kinds", () => {
  for (const op of OP_REGISTRY) {
    for (const p of op.params) {
      expect(["text", "textarea", "flag", "position", "indices", "ids"]).toContain(p.kind);
    }
  }
});
