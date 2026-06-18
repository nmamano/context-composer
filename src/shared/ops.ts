// The shared OP REGISTRY (§11 Phase 5b) — the product's mutating operation
// surface as DATA. One source of truth consumed by:
//   - the UI op menu (generated from this — the UI cannot surface an op this
//     registry lacks), and
//   - the CLI-parity test (registry verbs diffed against cli/ctx.ts's exported
//     verb list, both directions — design.md §11 Phase 5: parity is enforced
//     mechanically, not by principle).
//
// PURE DATA + pure functions: no React, no DOM, no fetch, no server imports
// (reviewer condition). Each spec mirrors the CONTROL ROUTE's request body
// (proxy/server.ts), not the CLI's flag spelling — the wire shape is the
// contract; the CLI and UI are two skins over it.

/** How an op targets frames: none (store-scoped), one frame, or several. */
export type TargetArity = "none" | "single" | "multi";

export interface ParamSpec {
  key: string;
  label: string;
  /** Form affordance hint for the UI — string kinds only, the UI decides the
   *  widget. "position" = an after-anchor (frame id, "start", or absent=end);
   *  "indices" = comma-separated message-boundary indices; "ids" =
   *  comma-separated tool_use_ids; "flag" = boolean checkbox. */
  kind: "text" | "textarea" | "flag" | "position" | "indices" | "ids";
  required?: boolean;
  placeholder?: string;
}

export interface OpSpec {
  /** The product verb — MUST equal the CLI verb (the parity invariant). */
  verb: string;
  route: string;
  arity: TargetArity;
  params: ParamSpec[];
  /** Build the POST body from the selected target id(s) and raw form values.
   *  Presence-only validation belongs to the daemon (the guards speak) — this
   *  maps values, it never judges frame state. */
  build: (
    targets: string[],
    values: Record<string, string | boolean | undefined>,
  ) => Record<string, unknown>;
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

/** "start" → null (head), "" / undefined → end (key omitted), else a frame id.
 *  The UI always sends `after` EXPLICITLY for add/move when a position was
 *  chosen, so tests can prove no reliance on daemon defaults. */
const position = (
  v: string | boolean | undefined,
): { after?: string | null } => {
  const s = str(v);
  if (s === undefined || s === "end") return {};
  return { after: s === "start" ? null : s };
};

const idList = (v: string | boolean | undefined): string[] | undefined => {
  const s = str(v);
  if (!s) return undefined;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
};

export const OP_REGISTRY: OpSpec[] = [
  {
    verb: "delete",
    route: "/control/delete",
    arity: "single",
    params: [],
    build: (targets) => ({ ids: targets }),
  },
  {
    verb: "edit",
    route: "/control/edit",
    arity: "single",
    params: [
      { key: "text", label: "replacement text", kind: "textarea", required: true },
    ],
    build: (targets, v) => ({ id: targets[0], text: str(v.text) }),
  },
  {
    verb: "compact",
    route: "/control/compact",
    arity: "single",
    params: [
      { key: "text", label: "summary text", kind: "textarea" },
      { key: "regen", label: "regen (LLM)", kind: "flag" },
    ],
    build: (targets, v) => ({
      id: targets[0],
      ...(v.regen === true ? { regen: true } : { text: str(v.text) }),
    }),
  },
  {
    verb: "offload",
    route: "/control/offload",
    arity: "single",
    params: [{ key: "summary", label: "stub summary (optional)", kind: "text" }],
    build: (targets, v) => {
      const summary = str(v.summary);
      return { id: targets[0], ...(summary !== undefined ? { summary } : {}) };
    },
  },
  {
    verb: "restore",
    route: "/control/restore",
    arity: "single",
    params: [],
    build: (targets) => ({ id: targets[0] }),
  },
  {
    verb: "add",
    route: "/control/add",
    arity: "none",
    params: [
      { key: "text", label: "frame text", kind: "textarea", required: true },
      { key: "after", label: "position (frame id / start / end)", kind: "position" },
    ],
    build: (_targets, v) => ({ text: str(v.text), ...position(v.after) }),
  },
  {
    verb: "move",
    route: "/control/move",
    arity: "single",
    params: [
      {
        key: "after",
        label: "after (frame id or start)",
        kind: "position",
        required: true,
      },
    ],
    build: (targets, v) => {
      // move REQUIRES after (id, or null for start). An empty form value omits
      // the key so the daemon's "move needs id and after" refusal speaks.
      const s = str(v.after);
      return { id: targets[0], ...(s === undefined ? {} : { after: s === "start" ? null : s }) };
    },
  },
  {
    verb: "combine",
    route: "/control/combine",
    arity: "multi",
    // F-047: optional insert position, same kind as add's (the combine PANEL
    // renders its own dropdown — default label there is "at the first picked
    // frame's place", the engine default when the key is omitted).
    params: [
      { key: "after", label: "insert position", kind: "position" },
    ],
    build: (targets, v) => ({ ids: targets, ...position(v.after) }),
  },
  {
    verb: "split",
    route: "/control/split",
    arity: "single",
    params: [
      {
        key: "at",
        label: "message-boundary indices (comma-separated)",
        kind: "indices",
        required: true,
        placeholder: "e.g. 1 or 1,3",
      },
    ],
    build: (targets, v) => ({
      id: targets[0],
      // Map to numbers but do NOT range-check — invalid boundaries must reach
      // the daemon so its refusal renders (reviewer condition).
      at: (str(v.at) ?? "")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n)),
    }),
  },
  {
    verb: "drop-results",
    route: "/control/drop-results",
    arity: "single",
    params: [
      { key: "resultIds", label: "tool_use_id(s), comma-separated", kind: "ids" },
      { key: "all", label: "all results", kind: "flag" },
    ],
    build: (targets, v) => ({
      id: targets[0],
      ...(v.all === true ? { all: true } : { resultIds: idList(v.resultIds) }),
    }),
  },
  {
    verb: "summarize-results",
    route: "/control/summarize-results",
    arity: "single",
    params: [
      { key: "resultIds", label: "tool_use_id(s), comma-separated", kind: "ids" },
      { key: "all", label: "all results", kind: "flag" },
      { key: "text", label: "summary text", kind: "textarea" },
      { key: "regen", label: "regen (LLM)", kind: "flag" },
    ],
    build: (targets, v) => ({
      id: targets[0],
      ...(v.all === true ? { all: true } : { resultIds: idList(v.resultIds) }),
      ...(v.regen === true ? { regen: true } : { text: str(v.text) }),
    }),
  },
  {
    verb: "retitle",
    route: "/control/retitle",
    arity: "single",
    params: [
      { key: "title", label: "title", kind: "text" },
      { key: "summary", label: "summary", kind: "text" },
      { key: "regen", label: "regen (LLM)", kind: "flag" },
    ],
    build: (targets, v) => ({
      id: targets[0],
      ...(str(v.title) !== undefined ? { title: str(v.title) } : {}),
      ...(str(v.summary) !== undefined ? { summary: str(v.summary) } : {}),
      ...(v.regen === true ? { regen: true } : {}),
    }),
  },
  {
    verb: "revert",
    route: "/control/revert",
    arity: "none",
    // params stays EMPTY: revert never opens a form (the 5b topbar button
    // reverts HEAD immediately). §11 Phase 5c passes `commit` PROGRAMMATICALLY
    // from history cards — same route, same CLI verb (ctx revert [<commit>]),
    // parity intact.
    params: [],
    build: (_targets, v) => {
      const commit = str(v.commit);
      return commit !== undefined ? { commit } : {};
    },
  },
];

export const opByVerb = (verb: string): OpSpec | undefined =>
  OP_REGISTRY.find((o) => o.verb === verb);

export const singleTargetOps = (): OpSpec[] =>
  OP_REGISTRY.filter((o) => o.arity === "single");

export const storeScopedOps = (): OpSpec[] =>
  OP_REGISTRY.filter((o) => o.arity === "none");
