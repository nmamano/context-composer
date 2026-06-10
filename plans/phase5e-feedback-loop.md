# Phase 5e — live UI testing: feedback triage + fix loop (standing orders)

Durable instruction set for the INTERACTIVE UI-feedback session. **Re-read
this file at the start of every working burst** — it survives compaction and
session restarts; the conversation does not. This is NOT an overnight slice
loop: Nil drives testing in real time and sets the pace; there is no
ScheduleWakeup machinery. The Phase 5 loop (plans/phase5-loop.md, 5a–5d all
shipped) defines the rails this session inherits.

Baseline at authoring time: master @ 745ab5a (Phase 5 complete: 5a 5b18570,
5b 089d175, 5c ca2d120, 5d 9fdfeeb; 172/172 tests; design.md §11 Phase 5
Status has the evidence).

## The job

Nil tests the UI extensively and reports refinements + genuine issues.
Record EVERY report in plans/ui-feedback.md (the ledger — format defined
there), triage it, fix in coherent batches, gate, review, commit. Park what
isn't yours to decide.

## Triage classes

- **bug** — behavior contradicts the design or the API truth (views
  disagree with /control responses, refusals swallowed, stale data, crash).
- **refinement** — UX/visual polish; behavior is correct but unpleasant.
- **design-question** — anything that would CHANGE design.md semantics,
  add/relax an op surface, or touch locked decisions. NEVER decided here:
  record in the ledger as `parked-for-Nil` with a crisp statement of the
  options, and move on.

## Process per BATCH (not per item)

Fix in coherent batches of ~3–6 related items (same component/surface =
same batch; a P0 bug that blocks Nil's testing may ship as a batch of one).

1. Triage incoming reports immediately (ledger status `triaged`, class set).
2. Implement the batch. Every BUG gets a regression test at the right layer
   (pure module test / component test / ui-smoke assertion); refinements
   get tests only where behavior is assertable (don't test padding).
3. Gates by what the batch touched (see matrix).
4. ONE diff-review message to Context Reviewer (agent-1780889675259-cvbv,
   POST localhost:4000/agents/<id>/message) per batch: what + why + gate
   evidence. Commit ONLY on sign-off; one focused commit per batch
   (`ui-fix batch N: <summary>` + ledger ids in the body). Update ledger
   statuses to `fixed@<commit>` in the same commit.
5. PLAN-gate (reviewer review BEFORE implementing) is required only when a
   batch would touch: src/engine/*, src/proxy/server.ts routes/semantics,
   src/shared/ops.ts surface, the CLI, or anything in design.md's locked
   set. Pure ui/ + styles + copy fixes go straight to diff review.

## Gate matrix

| Batch touched                    | Required gates                            |
|----------------------------------|-------------------------------------------|
| ui/ only (components/styles/pure) | tsc (root+ui), bun test, bun run ui:smoke |
| shared/ops.ts, cli/              | + op-parity focus, full bun test          |
| proxy/server.ts, engine/*        | + demo, live-e2e, live-phase2, real-TUI smoke (full slice ceremony + plan gate) |
| anything wire-visible (what compose emits) | + dual-client smoke (burns ~3 TUI turns — batch such changes) |

ui:smoke is the standing browser gate: extend its assertions when a fix is
render-truth (the API is the oracle, the DOM is the pane; screenshots are
evidence, never the oracle).

## Standing rails (inherited — do not relax)

- UI is a THIN WRAPPER: no op logic, no owned frame state, no second
  operation client. The UI re-states engine decisions, never re-decides
  (membership/order come from compose's emittedFrameIds; content is
  representation ?? messages).
- MECHANICAL PARITY: no UI op without a CLI verb; registry/CLI diff test
  stays green; any new control route needs a CLI verb in the same batch
  (and a plan gate).
- GUARDS SPEAK: daemon refusals render verbatim; never pre-empt, hide, or
  paraphrase them; never disable ops on frame STATE.
- Never touch a daemon you didn't start (8788 included). Test daemons get
  own ports + CC_STORE_PATH/CC_WIRETAP_PATH/CC_FRAMES_DIR under /tmp
  (8806 = ui-smoke, 8809 = dual-client, 8810 = live-regen, 8811 = Nil's
  test daemon; avoid 8796/8797/8799 fixed test ports).
- Fixture refresh ONLY via scripts/capture-ui-fixture.ts (credential scan).
- Default gates burn nothing: no API keys, no subscription, no network in
  bun test. ui:smoke scrubs all CC_LLM_* env (regen clicks must refuse).
- Scope guard: NO Phase 4 work (branching/tree/checkout), NO `send` from
  the UI, NO head-op relaxation (delete-p0 stays allowed per Nil
  2026-06-10 — known subscription foot-gun, revert heals it; see
  phase5-loop.md parked list). Anything shaped like these → design-question.
- Permission-classifier denials: legitimate workaround or queue; never
  thrash. TUI smokes burn quota; back off on 429s.

## Nil's test rig (recipe)

Daemon (fresh store; drop CC_LLM_CLAUDE_CLI=1 to make regen refuse):

    mkdir -p /tmp/cc-nil-ui/frames && bun run ui:build && \
    CC_PROXY_PORT=8811 CC_STORE_PATH=/tmp/cc-nil-ui/store.json \
    CC_WIRETAP_PATH=/tmp/cc-nil-ui/wiretap.jsonl \
    CC_FRAMES_DIR=/tmp/cc-nil-ui/frames CC_LLM_CLAUDE_CLI=1 bun run proxy

TUI: `ANTHROPIC_BASE_URL=http://localhost:8811 claude` · Browser:
http://auntie:8811/ui (tailscale). Clean-slate reset: kill the daemon,
`mktemp -d` a new dir, relaunch (no rm -rf — blocked by safety hooks).
After UI code changes: `bun run ui:build`, then Nil refreshes the browser
(the daemon serves ui/dist statically — no daemon restart needed).

Useful evidence when triaging a report: conv id + frame id (both visible in
the UI), /tmp/cc-nil-ui/wiretap.jsonl, fresh /control/list|show|compose
reads, ctx CLI cross-checks (CC_CONTROL_URL=http://localhost:8811).

## Resources

- plans/ui-feedback.md — the ledger (format + statuses defined at top).
- plans/phase5-loop.md — the shipped slices' handoffs (full context for
  every surface this session will touch) + the parked list.
- design.md §3/§4/§8 (UI architecture), §11 Phase 5 Status.
- House test patterns: ui/test/*.test.tsx (happy-dom contained per-file,
  fetch stubbed), test/ui-routes.test.ts, scripts/ui-smoke.ts.
