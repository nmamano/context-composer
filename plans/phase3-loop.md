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

- [ ] 3a — edit + compact + §5.F wire-integrity sweep (handoff below)
- [ ] 3b — offload + restore (handoff to be authored after 3a)
- [ ] 3c — combine + split + move + add (handoff after 3b)
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
