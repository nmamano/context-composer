# Phase 3 overnight loop — standing orders + slice handoffs

This file is the durable instruction set for the `/loop` run implementing
design.md §11 Phase 3 (3a → 3b → 3c → 3d). The loop prompt references this file;
**re-read it at the start of every iteration** — it survives context compaction
and session restarts, the conversation does not.

## North star (corrected framing — do not dilute)

The goal is NOT merely "make the wire valid." It is: **make the wire valid
without losing any context or any ability to freely edit that context.**
Validity is a constraint; zero-loss and free-editability are the actual goals.
Any slice that achieves validity by discarding content or restricting what the
user may edit has failed, even if every gate is green.

## Process per slice (no exceptions)

plan → Context Reviewer plan-review (agent-1780889675259-cvbv, POST to its
endpoint; it replies to yours) → implement → gates → diff review → reviewer
sign-off → ONE focused commit. Gates: `bunx tsc --noEmit`, `bun test`,
`bun run demo`, `bash scripts/live-e2e.sh`, `bash scripts/live-phase2.sh`, and
the standing real-TUI smoke (design.md §11 "Standing gate": tmux-driven real
TUI, fresh proxy on its own port + CC_STORE_PATH + tap, default permission
mode — never blanket-bypass, judge via the wiretap not the pane).

## Standing rails

- Never start the next slice before the current one is committed.
- Never touch the 8788 daemon or its store/wiretap files.
- Commit only on reviewer sign-off; master only; tree clean between slices. A
  slice that can't pass gates doesn't get committed — write up why instead.
- "Decide with reviewer" items get decided with the reviewer. Anything that
  would relitigate a LOCKED design decision gets queued for Nil — never decided
  unilaterally overnight.
- If a permission classifier denial blocks an action, find the legitimate
  workaround (e.g. default-permission TUI instead of bypassPermissions) or
  queue it; never thrash against it.
- If the reviewer is unresponsive, prepare-but-hold at the review gate (author
  the next plan, write tests) — never skip a review gate.
- TUI smokes burn Nil's subscription quota; on 429s, back off smoke frequency.
- If fully hard-blocked (all paths need Nil), stop the loop cleanly and leave a
  morning summary as the latest chat message.
- Before each subsequent slice (3b, 3c, 3d): author its handoff section in this
  file FIRST, following the 3a template below, derived from design.md §11 +
  what the previous slice learned. The handoff is part of the plan the reviewer
  reviews. Commit it with the slice.

## Slice status

- [x] 3a — edit + compact + §5.F wire-integrity sweep — committed, reviewer-signed-off (see design.md §11 Phase 3a Status)
- [x] 3b — offload + restore — committed, reviewer-signed-off (see design.md §11 Phase 3b Status)
- [x] 3c — combine + split + move + add — committed, reviewer-signed-off (see design.md §11 Phase 3c Status)
- [ ] 3d — strip + summarize + retitle (handoff after 3c)

---

## PHASE 3a PICKUP (edit + compact + wire-integrity sweep)

Repo: /home/nil/nil/context-composer (TS on Bun), branch master.
Baseline at authoring time: master @ f79579d (Phase 2.7 committed at 35ec416,
live-validated; design.md §11 Phase 2.7 Status has the evidence).

### Goal

Implement design.md §11 "Phase 3a — edit, compact" + the §5.F compose
wire-integrity sweep that ships WITH edit (first op that can mutate a frame
into a provider-invalid state). Each op = a commit type + CLI verb + compose
handling, demoable end-to-end through the proxy rewrite. Read §5 (op catalog),
§5.E, §5.F, §7 (data model), §9, Appendix C before planning. Remember the
north star above: the sweep exists so free editing stays free — validity is
the constraint it maintains, not the goal it serves.

### Load-bearing mechanics (get these right or 3a corrupts 1–2.7)

1. **REFRESH GATE (Appendix C):** today reconcile REFRESHES a live matched
   frame's content from the unaware agent's resend
   (`frame.messages = inc.messages`). Once a user edits/compacts a frame, the
   resend carries the OLD content — the gate must stop the refresh from
   clobbering the user's representation. `types.ts` Frame.provenance doc
   already reserves this: "the general representation-override gate that reads
   it arrives in Phase 3 with edit/compact."
2. **IDENTITY vs REPRESENTATION:** anchorFp/occurrence are SOURCE identity —
   they must keep matching the agent's resend even after an edit changes what
   we emit. Trap: `state.restore()` recomputes anchorFp from `messages[0]`; if
   edit mutates messages in place, identity silently forks after a restart and
   every frame duplicates. Keep the edited representation separate from (or
   restore-safe against) the source anchor. Decide the storage shape with the
   reviewer.
3. **(view, store) SPLIT (the 2.7 generalization guardrail, built for exactly
   this):** the request supplies membership + order; the store supplies each
   member's REPRESENTATION. edit/compact transform the representation — they
   must drop into compose's existing pure (view, store) emission without
   touching matching or view derivation. If you find yourself editing
   reconcile, stop and re-read the guardrail.
4. **OPS ARE COMMITS (§5.E):** edit/compact record implicit commits with
   params + provenance, visible in `ctx history`/`timeline`. Check §5.E/§7 for
   whether revert must extend beyond delete commits in 3a or stays delete-only
   — decide with the reviewer, don't assume.
5. **WIRE-INTEGRITY SWEEP (§5.F):** user-edit-induced invalidity (orphaned
   tool_use/tool_result, dangling reply) is swept at compose so the emitted
   body stays provider-valid. This is the PRODUCT rendering a user's edit — a
   different category from the deleted un-asked-for repair (2.6 evidence
   rule); keep detection-only wireWarnings for everything not caused by a user
   op. Per the north star: sweep the minimum necessary for validity, lose
   nothing the user didn't remove, restrict no future edit.
6. **PERSISTENCE:** representation overrides must survive restart. If the
   snapshot shape changes, bump SNAPSHOT_VERSION/REGISTRY_VERSION — no
   migrations, fail loudly (existing policy).

### Acceptance (design.md §11 Phase 3a; tests + live)

1. `ctx edit <frame> --text ...` → `compose --dump` shows the replacement; the
   next send reflects it; head-hash unchanged when the frame is in the tail.
2. `ctx compact <frame>` → summary in place of full text in the dump.
3. The agent's next unaware resend does NOT clobber the edit (refresh gate);
   restart does not fork identity (trap #2).
4. Wire-integrity: edit/delete a frame into an orphaned tool_use (or delete
   the user turn under an assistant reply) → compose still emits a
   provider-valid request and the live send succeeds — no 400.
5. `ctx history` shows edit/compact commits with provenance on the frame.

Live: standing real-TUI smoke — edit a frame mid-session from a second
terminal, verify the next turn reflects it via the wiretap, session stays
healthy.

### Decide with reviewer (open, not locked)

- compact's summary source: LLM-backed (engine/llm) vs manual --text tracer
  first. §11 lists engine/llm but flags LLM determinism as the risk — a
  manual/deterministic tracer first with --regen later is a legitimate slice;
  agree on scope before building an LLM client.
- revert breadth (mechanic #4) and the representation storage shape (#2).

### Locked — don't relitigate

- Compose stays faithful EXCEPT user-commanded ops; the §5.F sweep only
  repairs invalidity the user's own edit induced. No content heuristics, ever.
- Views stay derived per request, no persistence (2.7) — do not regress fork
  isolation; fork frames remain editable/deletable like any frame.
- Frame granularity (user turn + reply + tool loop bundled), no frame types.
- One owned cache breakpoint on the stable head; deterministic canonical bytes.
- Scope guard: edit + compact + sweep ONLY — no offload/split/strip (3b–3d),
  no branching, no UI.

### Resources

- design.md: §5 op catalog (edit/compact entries), §5.E commits, §5.F sweep,
  §7 data model, §9 cache duties, §11 Phase 3a + Standing gate, Appendix C.
- Key files: engine/state.ts (ingest/refresh path, snapshot),
  engine/reconcile.ts (DO NOT change matching), engine/compose.ts (pure
  (view, store) emission — representation resolution goes here),
  engine/types.ts (Frame), engine/wire-integrity.ts (detection today; sweep
  lands beside it), cli/ctx.ts, proxy/server.ts. Tests:
  test/fork-isolation.test.ts + test/versioning.test.ts show the house
  patterns; test/stub-upstream.ts for SSE.
- Wiretap first, debate never: .ctx-wiretap.jsonl / per-smoke tap files.

---

## PHASE 3b PICKUP (offload + restore)

Baseline at authoring time: master @ a5fcc68 (3a committed: representation
overrides + structural sweep, live-validated).

### Goal

design.md §11 "Phase 3b — offload, restore": validate file-read retrieval
(provider assumption 5) — the live token-reclamation beat. `offload <frame>`
swaps the frame's emission for a short stub (note + summary + absolute file
path) and writes the full content to a file the wrapped agent can read with its
OWN file-read tool on demand; `restore <frame>` re-injects the full text inline
(user convenience — the model never needs it). Read §5.D + §11 3b before
planning.

### Mechanics (build ON 3a — no new categories)

1. Offload IS a representation override: representation = [stub message],
   commit `offload` with { before, after } like edit/compact. The token drop
   falls out of the 3a invariant (tokenEstimate tracks emission). The sweep
   already handles stub-induced role adjacency (live-proven).
2. The FILE renders the frame's pre-offload EMISSION (representation ??
   messages) as readable role-labeled markdown — deterministic bytes. The
   store remains the durable truth; the file is a rendering for the model to
   read. Frame gains `fileReference` (path) — SNAPSHOT_VERSION 3→4.
3. The stub must carry an ABSOLUTE path (the agent's cwd is not ours) and a
   summary: deterministic derivation for the tracer (manual `--summary <s>`,
   default = first text line truncated). No LLM in 3b.
4. `restore` sets representation back to the offload commit's `before` (which
   may be null → source emits again, or a prior edit/compact override). Its own
   commit type; file left on disk (harmless rendering; the store is the truth).
5. File namespace: frame ids collide across conversations (t1 exists in every
   store) — the file name must be namespaced (conv id or store-scoped dir).
   Registry knows the conv id; the store does not. Decide shape with reviewer.
6. Same guards as 3a: deleted frames refuse offload; preamble offload deferred
   (temporary phrasing — the Phase 6 money shot offloads the head, but not in
   3b); offload-of-offloaded refused (restore first).

### Acceptance (design.md §11 3b)

- `ctx offload <frame>` → `compose --dump` shows the stub + file path, NOT the
  full text; the frame's token estimate drops; `ctx list` flags it.
- The wrapped agent reading that path yields a new tool-result frame
  (continuation capture — normal 2.6/2.7 machinery, nothing special).
- `ctx restore <frame>` → full text emits inline again; commits/timeline show
  offload and restore; revert works on both.
- Restart: fileReference + stub survive (snapshot v4); file still readable.
- Live TUI smoke: plant a fact, offload the frame, ask about the fact → the
  model READS THE FILE on its own (wiretap shows the Read tool_use on the
  offloaded path) and answers correctly; restore → answers without reading.

### Locked / scope guard

- No automatic offload; opt-in per frame (§5.D). No LLM summaries (3d).
- Files are local-only evidence-grade artifacts: 0600, gitignored dir.
- reconcile matching untouched; views untouched; no UI.

### Resources

3a machinery: setRepresentation/effectiveTokens in engine/state.ts, sweep in
engine/wire-integrity.ts, RepInput pattern, content-ops tests as the template.
New: engine/offload file-rendering helper (or inline in state), config for the
frames dir (CC_FRAMES_DIR, default ./.ctx-frames). CLI: offload/restore verbs.

---

## PHASE 3c PICKUP (combine + split + move + add — structural reshaping)

Baseline at authoring time: master @ e80089b (3a + 3b committed).

### Why this slice is different

The first ops that change the SET/ORDER of frames, not a member's content.
Two structural extensions, both anticipated by the locked design:

1. MEMBERSHIP BEYOND THE REQUEST (add, move): the 2.7 guardrail reserved this —
   "user-COMMIT-originated frames emit per the user's op even when unmatched."
   An added frame has NO agent source: it never appears in any resend, so it is
   never in a request's view — compose must still emit it at its place.
2. MANY-TO-MANY SOURCE IDENTITY (combine, split): Appendix C prescribes the
   many-to-many source map (fp → ordered list of (frame, sub-range)).

### Proposed architecture (CONVERGE WITH REVIEWER BEFORE CODE)

KEEP RECONCILE MATCHING 1:1 AND UNTOUCHED. Structure lives in resolution
layers, preserving every locked invariant:

- PLACEMENT (add/move): Frame gains `placement?: { after: string | null }`
  (null = start; absent = natural order). Compose builds the emission order:
  view (or full-store) baseline order, minus placement-overridden members,
  with placed frames spliced after their anchor frame (chains allowed, cycle
  guard falls back to store order + warning). Added frames: `origin: "added"`
  (vs "captured"), unmatchable sentinel anchor, anchor recompute SKIPPED on
  snapshot restore (manufactured anchors must never match a future resend),
  content via { text } | { raw } like edit. revert(add) = tombstone the added
  frame (append-only un-create). revert(move) = restore prior placement.
- ABSORPTION (combine/split): parts/original stay in store as 1:1 match
  targets; combine creates a new frame (messages = concatenation, in order)
  and marks each part `absorbedInto: <combinedId>`; split creates child
  frames (sub-ranges) and marks the original `splitInto: [childIds]`.
  Compose resolves each emission member through the absorption table:
  absorbed part → emit the absorbing frame ONCE at the first part's slot
  (Appendix C); split original → emit the children in order. Children /
  combined frames are ordinary frames (edit/compact/offload/delete all work).
  Reconcile still matches the PARTS/ORIGINAL (their source identity is
  unchanged) and their SOURCES may keep refreshing from resends (RC4 option a:
  matching AND refresh untouched); compose simply ignores their content while
  the structural state is active. Combined frames / split children refuse
  combine/split/move (nested absorption and move-over-absorption are separate
  models); they stay ordinary for edit/compact/offload/delete.
- Tombstones: deleted wins at every layer (deleted combined frame emits
  nothing even though parts are matched; deleted child emits nothing).
- Sweep (§5.F) covers any structural fallout — already load-bearing.

### Acceptance (design.md §11 3c: "compose --dump shows the new frame set/order")

- combine: N frames → one; emitted once at first slot; resend of parts does
  not duplicate or un-combine; revert(combine) restores parts.
- split: one frame → N at the original slot; each child independently
  editable/deletable; resend of the original matches; revert(split) restores.
- move: emitted order changes, view membership unchanged; head-hash stable;
  revert(move) restores order.
- add: emitted at the requested place on the NEXT request (and in full-store
  compose) despite never being matched; survives restart (anchor never
  manufactured); revert(add) tombstones it.
- All ops are commits with restorable params; timeline/history complete.
- Restart: placements/absorptions survive (SNAPSHOT_VERSION 4→5).
- Live TUI smoke: add an instruction frame mid-session and see the model obey
  it next turn; combine two old frames and verify the wire emits the merged
  frame once; move a frame and verify order on the wire.

### Locked / scope guard

- reconcile.ts matching stays byte-identical; resolution layers only.
- No --summarize on combine (LLM, 3d); no branch import (Phase 4).
- Same guards pattern: preamble refuses structural ops (deferred phrasing);
  offloaded frames refuse combine/split/move (restore first — coherence);
  deleted frames refuse all ops except revert.
