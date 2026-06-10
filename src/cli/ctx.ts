// `ctx` — the CLI. It is a THIN client over the proxy's control API (design.md §3:
// the CLI is the core API surface, but it owns no state — the daemon does). Phase 1
// verbs: list, show, delete, compose.
//
//   bun run src/cli/ctx.ts list
//   bun run src/cli/ctx.ts show t1
//   bun run src/cli/ctx.ts delete t1 t2
//   bun run src/cli/ctx.ts compose --dump
//   bun run src/cli/ctx.ts compose --hash-head
//   bun run src/cli/ctx.ts compose --view-last   (§11 Phase 2.7: the last emitted view)
//   bun run src/cli/ctx.ts history             (commit log — what you DID to the context)
//   bun run src/cli/ctx.ts timeline            (full audit log — incl. captures)
//   bun run src/cli/ctx.ts revert [<commit>]   (Phase 2 versioning verbs)
//   bun run src/cli/ctx.ts conversations       (§11 Phase 2.6: one store per conversation)
//
// Every store-scoped verb targets the ACTIVE conversation (most total turn frames
// incl. tombstones, so deleting frames never demotes it; ties → largest token
// estimate, then most recent ingest). Pass `--conv <id>` to target another one.

import { CONTROL_BASE_URL } from "../config.ts";

/** Set by main() from a global `--conv <id>` flag; appended to every control call. */
let convId: string | null = null;

function withConv(path: string): string {
  if (!convId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}conv=${encodeURIComponent(convId)}`;
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${CONTROL_BASE_URL}${withConv(path)}`);
  return res.json();
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CONTROL_BASE_URL}${withConv(path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function fail(msg: string): never {
  console.error(`ctx: ${msg}`);
  process.exit(1);
}

async function cmdList(args: string[]): Promise<void> {
  const showAll = args.includes("--all");
  const { conv, frames } = (await get("/control/list")) as {
    conv: string;
    frames: Array<{
      id: string;
      kind: string;
      role: string;
      title: string;
      summary: string | null;
      tokenEstimate: number;
      deleted: boolean;
      messageCount: number;
      overridden: boolean;
      offloaded: boolean;
      origin: string;
      absorbedInto: string | null;
      splitInto: string[] | null;
      inLastView: boolean | null;
    }>;
  };
  // §11 Phase 3c: absorbed parts / split originals are structurally hidden by
  // default (their absorber/children emit instead); --all reveals them flagged.
  const visible = frames.filter(
    (f) => showAll || (!f.deleted && !f.absorbedInto && !f.splitInto),
  );
  const hiddenDeleted = frames.filter((f) => f.deleted && !showAll).length;
  const hiddenStructural = frames.length - visible.length - hiddenDeleted;

  console.log(`(conversation ${conv} — see \`ctx conversations\`; target another with --conv <id>)`);
  let sawForkOnly = false;
  for (const f of visible) {
    const flags =
      (f.deleted ? " [deleted]" : "") +
      (f.offloaded ? " [offloaded]" : f.overridden ? " [override]" : "") +
      (f.origin !== "captured" && f.kind === "turn" ? ` [${f.origin}]` : "") +
      (f.absorbedInto ? ` [absorbed->${f.absorbedInto}]` : "") +
      (f.splitInto ? ` [split->${f.splitInto.join(",")}]` : "") +
      (f.inLastView === false ? " [fork-only]" : "");
    if (f.inLastView === false) sawForkOnly = true;
    const summary = f.summary ? ` — ${f.summary}` : "";
    console.log(
      `${f.id.padEnd(4)} ${f.kind.padEnd(8)} ${String(f.tokenEstimate).padStart(6)}tok  ${f.title}${summary}${flags}`,
    );
  }
  if (hiddenDeleted > 0 && !showAll) {
    console.log(`(${hiddenDeleted} deleted frame(s) hidden — use --all)`);
  }
  if (hiddenStructural > 0 && !showAll) {
    console.log(`(${hiddenStructural} absorbed/split frame(s) hidden — use --all)`);
  }
  if (sawForkOnly) {
    console.log(
      "(fork-only = not in the last emitted view: stored but not sent — a side query forked it in; delete or just leave it)",
    );
  }
}

async function cmdShow(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) fail("usage: ctx show <id>");
  console.log(JSON.stringify(await get(`/control/show?id=${encodeURIComponent(id!)}`), null, 2));
}

async function cmdDelete(args: string[]): Promise<void> {
  const ids = args.filter((a) => !a.startsWith("-"));
  if (ids.length === 0) fail("usage: ctx delete <id...>");
  const { conv, deleted } = (await post("/control/delete", { ids })) as {
    conv: string;
    deleted: string[];
  };
  console.log(
    deleted.length
      ? `deleted: ${deleted.join(", ")} (conversation ${conv})`
      : `nothing deleted (conversation ${conv})`,
  );
}

/** §11 Phase 3a content ops. `--text` replaces the frame's emission with one
 *  message in the frame opener's role; `edit --raw <json>` is the advanced form
 *  (full authorship of the emitted WireMessage[] — the §5.F sweep keeps the wire
 *  valid). The frame's SOURCE is never touched; `revert` undoes the op. */
async function cmdContentOp(op: "edit" | "compact", args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) fail(`usage: ctx ${op} <frame> --text <t>${op === "edit" ? " | --raw <json>" : ""}`);
  const textIdx = args.indexOf("--text");
  const rawIdx = args.indexOf("--raw");
  const body: Record<string, unknown> = { id };
  if (op === "compact" && args.includes("--regen")) {
    body.regen = true; // §11 Phase 3d: LLM-backed via the server's port
  } else if (textIdx >= 0 && args[textIdx + 1] !== undefined) {
    body.text = args[textIdx + 1];
  } else if (op === "edit" && rawIdx >= 0 && args[rawIdx + 1] !== undefined) {
    try {
      body.raw = JSON.parse(args[rawIdx + 1]!);
    } catch (e) {
      fail(`--raw must be valid JSON (a WireMessage[]): ${String(e)}`);
    }
  } else {
    fail(
      op === "edit"
        ? "usage: ctx edit <frame> --text <t> | --raw <json>"
        : "usage: ctx compact <frame> --text <summary> | --regen",
    );
  }
  const result = (await post(`/control/${op}`, body)) as {
    conv?: string;
    commit?: { id: string };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(`${op === "edit" ? "edited" : "compacted"} ${id} (commit ${result.commit!.id}, conversation ${result.conv})`);
}

/** §11 Phase 3b memory ops. offload swaps the frame's emission for a stub +
 *  artifact file the wrapped agent reads back on demand; restore re-injects the
 *  pre-offload emission inline (user convenience — the model reads the file
 *  itself). Both are commits; `revert` undoes either. */
async function cmdOffload(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) fail("usage: ctx offload <frame> [--summary <s>]");
  const sIdx = args.indexOf("--summary");
  const body: Record<string, unknown> = { id };
  if (sIdx >= 0 && args[sIdx + 1] !== undefined) body.summary = args[sIdx + 1];
  const result = (await post("/control/offload", body)) as {
    conv?: string;
    commit?: { id: string; params: { fileReference?: string } };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(
    `offloaded ${id} (commit ${result.commit!.id}, conversation ${result.conv})\n  -> ${result.commit!.params.fileReference}`,
  );
}

async function cmdRestore(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) fail("usage: ctx restore <frame>");
  const result = (await post("/control/restore", { id })) as {
    conv?: string;
    commit?: { id: string };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(`restored ${id} inline (commit ${result.commit!.id}, conversation ${result.conv})`);
}

/** §11 Phase 3c structural ops. */
async function cmdAdd(args: string[]): Promise<void> {
  const body: Record<string, unknown> = {};
  const textIdx = args.indexOf("--text");
  const rawIdx = args.indexOf("--raw");
  if (textIdx >= 0 && args[textIdx + 1] !== undefined) body.text = args[textIdx + 1];
  else if (rawIdx >= 0 && args[rawIdx + 1] !== undefined) {
    try {
      body.raw = JSON.parse(args[rawIdx + 1]!);
    } catch (e) {
      fail(`--raw must be valid JSON (a WireMessage[]): ${String(e)}`);
    }
  } else fail("usage: ctx add --text <t> | --raw <json> [--after <id> | --start]");
  const afterIdx = args.indexOf("--after");
  if (afterIdx >= 0 && args[afterIdx + 1] !== undefined) body.after = args[afterIdx + 1];
  else if (args.includes("--start")) body.after = null;
  const result = (await post("/control/add", body)) as {
    conv?: string;
    commit?: { id: string; affectedFrameIds: string[] };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(
    `added ${result.commit!.affectedFrameIds[0]} (commit ${result.commit!.id}, conversation ${result.conv})`,
  );
}

async function cmdMove(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) fail("usage: ctx move <frame> --after <id> | --start");
  const afterIdx = args.indexOf("--after");
  let after: string | null;
  if (afterIdx >= 0 && args[afterIdx + 1] !== undefined) after = args[afterIdx + 1]!;
  else if (args.includes("--start")) after = null;
  else { fail("usage: ctx move <frame> --after <id> | --start"); return; }
  const result = (await post("/control/move", { id, after })) as {
    conv?: string;
    commit?: { id: string };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(`moved ${id} (commit ${result.commit!.id}, conversation ${result.conv})`);
}

async function cmdCombine(args: string[]): Promise<void> {
  const ids = args.filter((a) => !a.startsWith("-"));
  if (ids.length < 2) fail("usage: ctx combine <id> <id> [...]");
  const result = (await post("/control/combine", { ids })) as {
    conv?: string;
    commit?: { id: string; params: { combinedId?: string } };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(
    `combined ${ids.join("+")} -> ${result.commit!.params.combinedId} (commit ${result.commit!.id}, conversation ${result.conv})`,
  );
}

async function cmdSplit(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  const atIdx = args.indexOf("--at");
  if (!id || atIdx < 0 || args[atIdx + 1] === undefined) {
    fail("usage: ctx split <frame> --at <i[,i...]>  (message-boundary indices)");
  }
  const at = args[atIdx + 1]!.split(",").map((x) => Number(x.trim()));
  const result = (await post("/control/split", { id, at })) as {
    conv?: string;
    commit?: { id: string; params: { childIds?: string[] } };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(
    `split ${id} -> ${result.commit!.params.childIds!.join("+")} (commit ${result.commit!.id}, conversation ${result.conv})`,
  );
}

/** §11 Phase 3d sub-frame ops: strip/summarize target tool_result blocks
 *  inside a frame (content stubbed/summarized; tool structure preserved);
 *  retitle is display metadata only. --regen goes through the daemon's LLM
 *  port (CC_LLM_API_KEY + CC_LLM_MODEL). */
async function cmdStrip(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) fail("usage: ctx strip <frame> --result <id[,id...]> | --all-results");
  const body: Record<string, unknown> = { id };
  const rIdx = args.indexOf("--result");
  if (rIdx >= 0 && args[rIdx + 1] !== undefined) {
    body.resultIds = args[rIdx + 1]!.split(",").map((x) => x.trim());
  } else if (args.includes("--all-results")) {
    body.all = true;
  } else fail("usage: ctx strip <frame> --result <id[,id...]> | --all-results");
  const result = (await post("/control/strip", body)) as {
    conv?: string;
    commit?: { id: string; params: { blocks?: number } };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(
    `stripped ${result.commit!.params.blocks} result block(s) in ${id} (commit ${result.commit!.id}, conversation ${result.conv})`,
  );
}

async function cmdSummarize(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) fail("usage: ctx summarize <frame> [--result <ids>|--all-results] --text <s> | --regen");
  const body: Record<string, unknown> = { id };
  const rIdx = args.indexOf("--result");
  if (rIdx >= 0 && args[rIdx + 1] !== undefined) {
    body.resultIds = args[rIdx + 1]!.split(",").map((x) => x.trim());
  } else body.all = true; // default: all results in the frame
  const tIdx = args.indexOf("--text");
  if (tIdx >= 0 && args[tIdx + 1] !== undefined) body.text = args[tIdx + 1];
  else if (args.includes("--regen")) body.regen = true;
  else fail("usage: ctx summarize <frame> [--result <ids>|--all-results] --text <s> | --regen");
  const result = (await post("/control/summarize", body)) as {
    conv?: string;
    commit?: { id: string; params: { blocks?: number } };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(
    `summarized ${result.commit!.params.blocks} result block(s) in ${id} (commit ${result.commit!.id}, conversation ${result.conv})`,
  );
}

async function cmdRetitle(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) fail("usage: ctx retitle <frame> --title <t> [--summary <s>] | --regen");
  const body: Record<string, unknown> = { id };
  const tIdx = args.indexOf("--title");
  const sIdx = args.indexOf("--summary");
  if (tIdx >= 0 && args[tIdx + 1] !== undefined) body.title = args[tIdx + 1];
  if (sIdx >= 0 && args[sIdx + 1] !== undefined) body.summary = args[sIdx + 1];
  if (args.includes("--regen")) body.regen = true;
  if (body.title === undefined && body.summary === undefined && !body.regen) {
    fail("usage: ctx retitle <frame> --title <t> [--summary <s>] | --regen");
  }
  const result = (await post("/control/retitle", body)) as {
    conv?: string;
    commit?: { id: string };
    error?: string;
  };
  if (result.error) fail(result.error);
  console.log(`retitled ${id} (commit ${result.commit!.id}, conversation ${result.conv})`);
}

async function cmdCompose(args: string[]): Promise<void> {
  const dump = args.includes("--dump");
  const hashHead = args.includes("--hash-head");
  // §11 Phase 2.7: --view-last composes the last emitted view (what the wire
  // actually got scoped to), vs the default full-store compose (debug surface).
  const viewLast = args.includes("--view-last");
  const qs = [dump ? "dump" : "", hashHead ? "hashHead" : "", viewLast ? "view=last" : ""]
    .filter(Boolean)
    .join("&");
  const result = await get(`/control/compose${qs ? `?${qs}` : ""}`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdHistory(_args: string[]): Promise<void> {
  const { commits } = (await get("/control/history")) as {
    commits: Array<{
      id: string;
      type: string;
      affectedFrameIds: string[];
      note: string | null;
      timestamp: string;
    }>;
  };
  if (commits.length === 0) {
    console.log("(no commits yet)");
    return;
  }
  for (const c of commits) {
    console.log(
      `${c.id.padEnd(4)} ${c.type.padEnd(7)} ${c.affectedFrameIds.join(",").padEnd(10)}  ${c.note ?? ""}  ${c.timestamp}`,
    );
  }
}

async function cmdTimeline(_args: string[]): Promise<void> {
  const { events } = (await get("/control/timeline")) as {
    events: Array<{
      id: string;
      type: string;
      frameIds: string[];
      commitId: string | null;
      timestamp: string;
    }>;
  };
  if (events.length === 0) {
    console.log("(no events yet)");
    return;
  }
  for (const e of events) {
    const commit = e.commitId ? ` (${e.commitId})` : "";
    console.log(
      `${e.id.padEnd(4)} ${e.type.padEnd(8)} ${e.frameIds.join(",").padEnd(10)}${commit}  ${e.timestamp}`,
    );
  }
}

async function cmdConversations(_args: string[]): Promise<void> {
  const { conversations } = (await get("/control/conversations")) as {
    conversations: Array<{
      id: string;
      turnFrames: number;
      totalTurnFrames: number;
      forkFrames: number;
      tokenEstimate: number;
      lastIngestAt: string | null;
      active: boolean;
      suspicious: { reason: string; frameCount: number; at: string } | null;
    }>;
  };
  if (conversations.length === 0) {
    console.log("(no conversations yet)");
    return;
  }
  for (const c of conversations) {
    const mark = c.active ? "*" : " ";
    const turns =
      c.turnFrames === c.totalTurnFrames
        ? `${c.turnFrames} turn-frames`
        : `${c.turnFrames} live / ${c.totalTurnFrames} total turn-frames`;
    const fork = c.forkFrames > 0 ? `  (${c.forkFrames} fork-only — see \`ctx list\`)` : "";
    const warn = c.suspicious ? `  ⚠ ${c.suspicious.reason} (${c.suspicious.frameCount} frames at first contact)` : "";
    console.log(
      `${mark} ${c.id.padEnd(4)} ${turns.padEnd(34)} ${String(c.tokenEstimate).padStart(7)}tok  last ingest ${c.lastIngestAt ?? "(never)"}${fork}${warn}`,
    );
  }
  console.log("(* = active — the conversation store-scoped verbs target; override with --conv <id>)");
}

async function cmdRevert(args: string[]): Promise<void> {
  const commit = args.find((a) => !a.startsWith("-")); // optional; defaults to HEAD
  const result = (await post("/control/revert", commit ? { commit } : {})) as {
    reverted?: { id: string; params: { revertedCommitId?: string } };
    error?: string;
  };
  if (result.error) fail(result.error);
  const r = result.reverted!;
  console.log(`reverted ${r.params.revertedCommitId} (new commit ${r.id})`);
}

// §11 Phase 5b — the CLI's verb surface as DATA, exported for the mechanical
// UI-parity gate (design.md §11 Phase 5: the UI surfaces no operation lacking a
// CLI verb, verified by diffing lists, not by principle). The dispatch table
// below is BUILT FROM these constants, so they cannot drift from what the CLI
// actually accepts.
export const CTX_MUTATING_VERBS = [
  "delete",
  "edit",
  "compact",
  "offload",
  "restore",
  "add",
  "move",
  "combine",
  "split",
  "strip",
  "summarize",
  "retitle",
  "revert",
] as const;

export const CTX_READONLY_VERBS = [
  "list",
  "show",
  "compose",
  "history",
  "timeline",
  "conversations",
] as const;

type Verb =
  | (typeof CTX_MUTATING_VERBS)[number]
  | (typeof CTX_READONLY_VERBS)[number];

/** Dispatch table keyed by the exported verb union — adding a verb to a
 *  constant without a handler (or vice versa) is a TYPE error, not drift. */
const COMMANDS: Record<Verb, (args: string[]) => Promise<void>> = {
  list: cmdList,
  show: cmdShow,
  delete: cmdDelete,
  edit: (args) => cmdContentOp("edit", args),
  compact: (args) => cmdContentOp("compact", args),
  offload: cmdOffload,
  restore: cmdRestore,
  add: cmdAdd,
  move: cmdMove,
  combine: cmdCombine,
  split: cmdSplit,
  strip: cmdStrip,
  summarize: cmdSummarize,
  retitle: cmdRetitle,
  compose: cmdCompose,
  history: cmdHistory,
  timeline: cmdTimeline,
  revert: cmdRevert,
  conversations: cmdConversations,
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Global --conv <id>: target a specific conversation instead of the active one.
  const convIdx = argv.indexOf("--conv");
  if (convIdx >= 0) {
    const id = argv[convIdx + 1];
    if (!id || id.startsWith("-")) fail("--conv requires a conversation id (see `ctx conversations`)");
    convId = id!;
    argv.splice(convIdx, 2);
  }
  const [cmd, ...args] = argv;
  const handler = cmd !== undefined ? COMMANDS[cmd as Verb] : undefined;
  if (!handler) {
    fail(
      `unknown command ${cmd ?? "(none)"}. verbs: list | show <id> | delete <id...> | edit <id> --text <t>|--raw <json> | compact <id> --text <s> | offload <id> [--summary <s>] | restore <id> | add --text <t> [--after <id>|--start] | move <id> --after <id>|--start | combine <id...> | split <id> --at <i,...> | strip <id> --result <ids>|--all-results | summarize <id> --text <s>|--regen | retitle <id> --title <t>|--regen | compose [--dump] [--hash-head] [--view-last] | history | timeline | revert [<commit>] | conversations  (global: --conv <id>)`,
    );
  }
  return handler!(args);
}

// Run only as a CLI entrypoint — importing this module (the parity test does)
// must never execute a command.
if (import.meta.main) {
  main().catch((e) => fail(String(e)));
}
