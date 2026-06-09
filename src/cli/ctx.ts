// `ctx` — the CLI. It is a THIN client over the proxy's control API (design.md §3:
// the CLI is the core API surface, but it owns no state — the daemon does). Phase 1
// verbs: list, show, delete, compose.
//
//   bun run src/cli/ctx.ts list
//   bun run src/cli/ctx.ts show t1
//   bun run src/cli/ctx.ts delete t1 t2
//   bun run src/cli/ctx.ts compose --dump
//   bun run src/cli/ctx.ts compose --hash-head
//   bun run src/cli/ctx.ts history             (commit log — what you DID to the context)
//   bun run src/cli/ctx.ts timeline            (full audit log — incl. captures)
//   bun run src/cli/ctx.ts revert [<commit>]   (Phase 2 versioning verbs)

import { CONTROL_BASE_URL } from "../config.ts";

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${CONTROL_BASE_URL}${path}`);
  return res.json();
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${CONTROL_BASE_URL}${path}`, {
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
  const { frames } = (await get("/control/list")) as {
    frames: Array<{
      id: string;
      kind: string;
      role: string;
      title: string;
      tokenEstimate: number;
      deleted: boolean;
      messageCount: number;
    }>;
  };
  const visible = frames.filter((f) => showAll || !f.deleted);
  const hiddenDeleted = frames.length - visible.length;

  for (const f of visible) {
    const flag = f.deleted ? " [deleted]" : "";
    console.log(
      `${f.id.padEnd(4)} ${f.kind.padEnd(8)} ${String(f.tokenEstimate).padStart(6)}tok  ${f.title}${flag}`,
    );
  }
  if (hiddenDeleted > 0 && !showAll) {
    console.log(`(${hiddenDeleted} deleted frame(s) hidden — use --all)`);
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
  const { deleted } = (await post("/control/delete", { ids })) as {
    deleted: string[];
  };
  console.log(
    deleted.length ? `deleted: ${deleted.join(", ")}` : "nothing deleted",
  );
}

async function cmdCompose(args: string[]): Promise<void> {
  const dump = args.includes("--dump");
  const hashHead = args.includes("--hash-head");
  const qs = [dump ? "dump" : "", hashHead ? "hashHead" : ""]
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
  const [cmd, ...args] = process.argv.slice(2);
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
    default:
      fail(
        `unknown command ${cmd ?? "(none)"}. verbs: list | show <id> | delete <id...> | compose [--dump] [--hash-head] | history | timeline | revert [<commit>]`,
      );
  }
}

main().catch((e) => fail(String(e)));
