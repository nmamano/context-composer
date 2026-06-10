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
      tokenEstimate: number;
      deleted: boolean;
      messageCount: number;
      inLastView: boolean | null;
    }>;
  };
  const visible = frames.filter((f) => showAll || !f.deleted);
  const hiddenDeleted = frames.length - visible.length;

  console.log(`(conversation ${conv} — see \`ctx conversations\`; target another with --conv <id>)`);
  let sawForkOnly = false;
  for (const f of visible) {
    const flags =
      (f.deleted ? " [deleted]" : "") +
      (f.inLastView === false ? " [fork-only]" : "");
    if (f.inLastView === false) sawForkOnly = true;
    console.log(
      `${f.id.padEnd(4)} ${f.kind.padEnd(8)} ${String(f.tokenEstimate).padStart(6)}tok  ${f.title}${flags}`,
    );
  }
  if (hiddenDeleted > 0 && !showAll) {
    console.log(`(${hiddenDeleted} deleted frame(s) hidden — use --all)`);
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
  switch (cmd) {
    case "list":
      return cmdList(args);
    case "show":
      return cmdShow(args);
    case "delete":
      return cmdDelete(args);
    case "compose":
      return cmdCompose(args);
    case "history":
      return cmdHistory(args);
    case "timeline":
      return cmdTimeline(args);
    case "revert":
      return cmdRevert(args);
    case "conversations":
      return cmdConversations(args);
    default:
      fail(
        `unknown command ${cmd ?? "(none)"}. verbs: list | show <id> | delete <id...> | compose [--dump] [--hash-head] [--view-last] | history | timeline | revert [<commit>] | conversations  (global: --conv <id>)`,
      );
  }
}

main().catch((e) => fail(String(e)));
