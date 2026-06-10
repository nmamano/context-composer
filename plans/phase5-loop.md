# Phase 5 loop — standing orders + slice handoffs (UI, single-branch first)

Durable instruction set for the `/loop` run implementing the dual-view UI.
**Re-read this file at the start of every iteration** — it survives context
compaction and session restarts; the conversation does not. The Phase 3 loop
(plans/phase3-loop.md, all four slices shipped overnight with zero unresolved
findings) is the template; replicate that process exactly.

## Re-sequencing decision (Nil, 2026-06-10 — fold into design.md in slice 1)

Phase 5 (UI) now runs BEFORE Phase 4 (branching): get the UI right for the
SINGLE-BRANCH case first, extend to multi-branch later. design.md §11 itself
pre-authorizes a thinner-UI-earlier path ("acceptable earlier if momentum
demands it"). Slice 1 adds a re-sequencing note to design.md §11 (reviewed by
Context Reviewer as part of the slice-1 plan gate — implementation-shape
change, not a locked-design change). Phase 4 lands after, accepting modest
rework risk in the tree view when branches arrive.

## North star (unchanged — do not dilute)

Make the wire valid without losing any context or any ability to freely edit
that context. The UI is a THIN WRAPPER (§3, §8): it owns no state and no op
logic — every operation dispatches through the SAME control API routes the CLI
uses. CLI parity is enforced mechanically, not by principle: the UI surfaces
no operation lacking a CLI verb (diff the op registry against the CLI verb
list in a test), and any new control route added for the UI gets a CLI verb in
the same slice.

## Process per slice (the Phase 3 formula, no exceptions)

plan → Context Reviewer plan-review (agent-1780889675259-cvbv, POST to its
endpoint at localhost:4000/agents/<id>/message; it replies to your agent
endpoint) → implement → gates → diff review → reviewer sign-off → ONE focused
commit. Author each slice's handoff section in THIS file before its plan gate.

### Gates per slice

Engine gates (unchanged — the UI must never break the proxy):
`bunx tsc --noEmit` (+ `tsc --noEmit -p ui` since 5a — the UI is its own ts
project for DOM/jsx), `bun test`, `bun run demo`, `bash scripts/live-e2e.sh`,
`bash scripts/live-phase2.sh`. Run the standing real-TUI smoke (design.md §11
"Standing gate") whenever daemon/engine paths changed.

UI gates (the BROWSER EQUIVALENT of the standing TUI gate — verified
available: system Google Chrome 145 + Playwright 1.60 via bunx):
1. Component/unit layer: bun test with happy-dom (fast, deterministic).
2. REAL-BROWSER smoke per slice: Playwright driving the system Chrome
   (`channel: "chrome"`, headless) against a REAL proxy daemon on its own
   port/store/tap. Click the actual UI; assert both views update; take
   screenshots as evidence artifacts (/tmp/cc-ui-smoke-*/).
3. JUDGE VIA THE WIRETAP / control API, not the DOM — the DOM is the pane;
   the wiretap is the truth (same principle as the TUI gate).
4. The full standing beat once ops are wired (slice 2+): DUAL-CLIENT smoke —
   a real TUI session (tmux, default permission mode) AND the browser on the
   SAME daemon: perform surgery in the browser, verify the next TUI turn's
   wire via wiretap, session stays healthy. This is the product's actual
   shape: live session in one window, UI scalpel in the other.

## Standing rails (Phase 3 rails + UI additions)

- Never start the next slice before the current is committed; master only;
  tree clean between slices; commit only on reviewer sign-off.
- Never touch the 8788 daemon or its store/wiretap. Smoke daemons use their
  own ports (avoid 8796/8797/8799 — fixed test ports) + CC_STORE_PATH +
  CC_WIRETAP_PATH + CC_FRAMES_DIR under /tmp.
- "Decide with reviewer" items get decided with the reviewer; anything
  relitigating LOCKED design (faithful compose, model-unaware, no content
  heuristics, frame uniformity, view scoping) gets queued for Nil.
- Permission-classifier denials: find the legitimate workaround or queue;
  never thrash. Browsers run headless; no system-wide installs.
- TUI smokes burn subscription quota; back off on 429s.
- If fully hard-blocked, stop the loop cleanly and leave a summary.
- UI dependencies: keep them minimal and pinned (react, react-dom, vite or
  Bun-native bundling — decide with reviewer in slice 1; no UI framework
  beyond React, no state library unless the reviewer agrees it's earned).

## Slice plan (vertical tracer slices; one commit each)

- [x] 5a — SCAFFOLD + READ-ONLY VIEWS + BROWSER GATE. ui/ React app served by
  the daemon (or a dev server proxying /control — decide with reviewer);
  conversation view (chat transcript rendered from frames) ⇄ frame view
  (linear frame cards: title — summary, tokens, flags [deleted/override/
  offloaded/added/fork-only]) with a toggle; details panel (full content,
  provenance, fileReference); conversations switcher (registry). The
  Playwright harness lands IN THIS SLICE (test/ui-smoke or scripts/ui-smoke):
  browser renders real store data from a live daemon; screenshot evidence.
  Acceptance: a store populated by a real TUI session renders correctly in
  both views in a real browser.
- [x] 5b — OPS FROM THE UI + PARITY REGISTRY. Op menu per frame wired to the
  existing control routes (start delete/revert, then all: edit, compact,
  offload, restore, add, move, combine, split, strip, summarize, retitle);
  visible refusal errors (the guards speak); both views update after every op
  (THE design acceptance); shared op-registry module + a test that diffs the
  UI op list against the CLI verb list (parity enforced mechanically).
  Acceptance: design.md §11 Phase 5 — "run an op → both views update", in a
  real browser, against a real daemon.
- [ ] 5c — HISTORY/TIMELINE PANEL + DUAL-CLIENT LIVE SMOKE. Commit log with
  params/diff display, click-to-revert; timeline view; then the full beat:
  real TUI session + browser on one daemon, surgery from the browser
  (delete/edit/offload something), next TUI turn reflects it
  (wiretap-verified), session healthy. Update design.md §11 Phase 5 status.
- [ ] 5d (optional, Nil-requested) — REGEN VIA SUBSCRIPTION. Swap/extend the
  LlmClient default with a subscription-backed implementation (the Isomux
  pattern): drive `claude -p` (or the Agent SDK) as a subprocess so
  compact/summarize/retitle --regen use Nil's subscription instead of an API
  key. The 3d port makes this a drop-in (server-layer only; store stays
  deterministic; stub tests unchanged). Env-gate it; document quota burn.

## Deferred / parked (do not pick up without Nil)

- Phase 4 branching (incl. tree view) — after 5c.
- `send` from the UI (the §5.F verb — UI-originated turns): big auth/path
  decision; the wrapped agent stays the only originator for now.
- Head ops (edit/compact/offload on p0) — revisit before Phase 6.
- The §11 Phase 5 SVG git-tree view — needs branches; the 5a frame view is a
  linear list deliberately.

## Resources

- Control API surface (proxy/server.ts): /control/list|show|delete|edit|
  compact|offload|restore|add|move|combine|split|strip|summarize|retitle|
  compose|history|timeline|revert|conversations — all take ?conv=<id>; every
  response echoes the resolved conv id. FrameSummary carries title, summary,
  tokenEstimate, deleted, overridden, offloaded, fileReference, origin,
  absorbedInto, splitInto, inLastView.
- Evidence surfaces: wiretap entries (viewFrameIds, emittedFrameIds,
  omittedFrameIds, wireWarnings, wireRepairs, structureWarnings), compose
  result fields, ctx CLI for cross-checking.
- House test patterns: test/*.test.ts (stub upstream, fixed-port restart
  tests); TUI smoke mechanics in design.md §11 Standing gate.
- Phase 3 loop file (plans/phase3-loop.md) — the template for everything.

---

## PHASE 5a PICKUP (scaffold + read-only views + browser gate)

Repo: /home/nil/nil/context-composer (TS on Bun), branch master.
Baseline at authoring time: master @ fa61657 (Phase 3 complete: all 14 ops
live-validated; design.md §11 Phase 3a–3d Status has the evidence).

### Goal

Implement the read-only foundation of design.md §11 Phase 5, re-sequenced
before Phase 4 per the decision above: a `ui/` React app rendering one
conversation through BOTH views (conversation ⇄ frame) with a toggle, a
details panel, and a conversations switcher — fed exclusively by the existing
control API. NO ops in this slice (5b). The Playwright real-browser gate
harness lands IN THIS SLICE and becomes the standing UI gate for 5b/5c. This
slice also adds the re-sequencing note to design.md §11 (implementation-shape
change, reviewed via this plan gate — not a locked-design change).

### Load-bearing mechanics (get these right or the UI rots from day one)

1. **THIN WRAPPER (§3, §8 — the north star applied):** the UI owns no frame
   state and no op logic. Every pixel derives from control API responses
   (/control/conversations, /control/list, /control/show); client state is
   limited to view-toggle/selection/fetch-cache. If a component starts
   deciding what a frame "means" beyond rendering returned fields, stop.
2. **CONVERSATION VIEW = render the frames' own messages.** A frame bundles
   user turn + assistant reply + tool loop (locked granularity). The chat
   transcript is the concatenation of each live frame's messages in store
   order — rendered from frame content, NOT from a separate transcript
   source. Tool_use/tool_result render as plain collapsed blocks (§4: no
   special widgets, §9). Deleted frames: hidden in conversation view,
   visible-but-flagged in frame view (the two views genuinely differ here —
   that asymmetry is the §4 design, preserve it).
3. **FRAME VIEW = LINEAR LIST deliberately** (no SVG git-tree — needs Phase 4
   branches; parked). Cards: title — summary, tokenEstimate, flag chips
   (deleted / overridden / offloaded / added(origin) / fork-only(inLastView=
   false) / absorbedInto / splitInto). Click → details panel: full content,
   provenance, fileReference.
4. **NO ENGINE CHANGES.** proxy/server.ts may gain only static-file serving
   for ui/dist (read-only GET, no /control semantics change) IF the daemon-
   served option is chosen. Any new/extended control route triggers the
   parity rail (CLI verb same slice) — avoid in 5a if at all possible.
5. **SMOKE-DAEMON ISOLATION:** the Playwright gate boots its OWN daemon on
   its own port (never 8788; avoid fixed test ports 8796/8797/8799) with
   CC_STORE_PATH + CC_WIRETAP_PATH + CC_FRAMES_DIR under /tmp/cc-ui-smoke-*.
   Store fixture: a real store captured from a TUI session (copy a fixture
   store under /tmp, point the daemon at it) so acceptance is "real TUI data
   renders", not synthetic data.
6. **JUDGE VIA THE CONTROL API, NOT THE DOM:** the browser asserts the DOM
   matches what /control/list/show report (frame count, titles, flags,
   content presence) — the API is the truth, the DOM is the pane. Screenshots
   to /tmp/cc-ui-smoke-*/ as evidence artifacts.
7. **DEPS MINIMAL AND PINNED:** react + react-dom (pinned), playwright
   (devDep, pinned, drives system Chrome 145 via channel:"chrome" headless —
   no browser downloads), happy-dom (or equivalent) for component tests.
   Bundler: Bun-native (Bun.build / bun build, zero new deps) vs vite —
   decide with reviewer (proposal below).

### Acceptance (loop-file 5a + design.md §11 Phase 5 read-only subset)

1. A store populated by a REAL TUI session renders correctly in both views in
   a REAL browser (system Chrome via Playwright, headless): conversation view
   shows the chat transcript; frame view shows every frame card with correct
   title/summary/tokens/flags; toggle switches views; details panel shows
   full content + provenance + fileReference for an offloaded frame.
2. Conversations switcher lists registry conversations and switches.
3. Component tests (bun test, happy-dom) cover transcript assembly from
   frames, flag-chip rendering, and details-panel field mapping.
4. Playwright smoke is reproducible via one script entry (test/ui-smoke or
   scripts/ui-smoke — decide with reviewer), boots its own daemon, judges via
   control API, saves screenshots; passes headless.
5. All engine gates still green: tsc --noEmit, bun test, demo, live-e2e,
   live-phase2 (UI must never break the proxy). No real-TUI smoke needed
   UNLESS daemon/engine paths changed (static serving in server.ts counts →
   run it then).
6. design.md §11 carries the re-sequencing note (Phase 5 before Phase 4,
   single-branch UI first, §11 pre-authorization cited).

### Decide with reviewer (open, not locked)

- **Serving: daemon-served static bundle (proposal) vs separate dev server
  proxying /control.** Proposal: daemon serves ui/dist at GET /ui/* — it's
  the product shape (one process, no CORS, no second port), ~20 lines in
  server.ts; keep a `bun run ui:dev` convenience path only if it costs
  nothing. Counter-case: zero daemon changes in 5a keeps the engine-gate
  surface untouched.
- **Bundler: Bun-native build (proposal — zero new deps, bun build
  ui/index.tsx) vs vite.** Vite earns its keep on HMR/dev-server; if
  daemon-served + no dev server, Bun-native suffices.
- **How conversation view gets full content:** /control/show per frame
  (N requests, zero API changes — proposal for 5a) vs extending /control/list
  with content (touches the API + parity rail). N is small single-branch;
  optimize only when real.
- **Refresh strategy for 5a:** manual refresh / on-focus refetch (proposal)
  vs polling. "Both views update after ops" is 5b acceptance; don't pre-build
  SSE/push — but pick a shape that 5b's post-op refetch drops into.
- **Component-test stack:** happy-dom + plain render assertions vs adding
  @testing-library/react. Whichever, keep it to devDeps and house style.
- **Harness home:** test/ui-smoke.test.ts gated by an env var (house pattern:
  live tests behind flags) vs scripts/ui-smoke.sh like live-e2e. Must not run
  in the default `bun test` (needs Chrome + daemon).

### Locked — don't relitigate

- UI is a THIN wrapper: no op logic, no owned frame state, no second
  operation client (§3, §8); ops land in 5b through the same control routes.
- No `send` from the UI — the wrapped agent is the only turn originator
  (parked list). No ops at all in 5a (read-only).
- Linear frame list in 5a — the SVG git-tree needs branches (parked for
  Phase 4+).
- Faithful compose, model-unaware, no content heuristics, frame uniformity,
  per-request view scoping — engine rails unchanged; the UI renders what the
  API returns, it never reinterprets.
- Never touch the 8788 daemon or its store/wiretap.
- Scope guard: 5a is scaffold + read-only views + browser gate ONLY — no op
  menu, no history panel (5c), no timeline, no regen (5d).

### Resources

- design.md: §3 (CLI-first, UI thin wrapper), §4 (two views), §8 (UI
  architecture), §9 (no special widgets), §11 Phase 5 + Standing gate +
  Decisions, §7 (data model — FrameSummary fields).
- Control API surface: see Resources at top of this file; proxy/server.ts
  lines ~246–546 (routes), engine/registry.ts (conversations),
  engine/types.ts (Frame/FrameSummary).
- Verified available: system Google Chrome 145, Playwright 1.60 via bunx
  (channel:"chrome", headless).
- House patterns: test/*.test.ts (stub upstream, env-gated live tests),
  scripts/live-e2e.sh (scripted gate shape), phase3-loop.md handoffs (this
  format).
- Evidence: /tmp/cc-ui-smoke-*/ screenshots + the smoke daemon's wiretap/
  control responses.

---

## PHASE 5b PICKUP (ops from the UI + parity registry)

Repo: /home/nil/nil/context-composer (TS on Bun), branch master.
Baseline at authoring time: master @ 5b18570 (5a committed: read-only
dual-view UI + browser gate, reviewer-signed plan + diff, zero findings).

### What 5a learned (fold into this slice's work)

- The conversation view's ordering oracle is /control/compose?hashHead →
  emittedFrameIds (reviewer-accepted deviation). Post-op refetch via the ONE
  loadConversation path was built for exactly this slice — reuse it, don't
  add a second data path.
- Playwright innerText reflects CSS text-transform — assert case-insensitively.
- Browser-driven CONTROL ops are quota-free (only /v1/messages hits upstream):
  the op-smoke layer can run against the committed fixture daemon at zero
  cost; ONLY the dual-client beat needs a real TUI session.
- Asset URLs must stay under /ui (--public-path=/ui/); any new static asset
  follows the same rule. data: favicon suppresses the implicit root request.
- Suggestion-mode side queries fork organically onto the same conv key
  (fixture has t3/t5) — the dual-client smoke must tolerate organic side
  traffic, and tmux driving must never blind-Enter (ghost suggestions sit in
  the input box).
- scripts/capture-ui-fixture.ts (credential-shape scan) is the only sanctioned
  way to refresh the committed fixture.

### Goal

design.md §11 Phase 5 acceptance, op half: every frame op runnable FROM the
browser through the SAME control routes the CLI uses, with "run an op → both
views update" proven in a real browser against a real daemon, and CLI parity
enforced MECHANICALLY (a test that diffs the UI op surface against the CLI
verb list — the north-star rail, not a principle).

### Load-bearing mechanics

1. **SHARED OP REGISTRY:** one module describing the mutating frame ops the
   product exposes — verb, control route, HTTP shape, param spec, target
   arity (none/single/multi). The UI op menu is GENERATED from it (the UI can
   not surface an op the registry lacks), and the parity test diffs registry
   verbs against the CLI's dispatch list (export the verb list from
   cli/ctx.ts — a constant the switch is checked against, not a behavior
   change). Ops in 5b: delete, revert(last), edit, compact, offload, restore,
   add, move, combine, split, strip, summarize, retitle. (list/show/compose/
   history/timeline/conversations are reads, not menu ops; history UI is 5c.)
2. **THIN WRAPPER UNDER MUTATION:** an op handler = POST the route + refetch
   via loadConversation. NO optimistic updates, NO local mutation of frame
   state, NO client-side validation beyond presence of required params — the
   GUARDS SPEAK: control-API refusals (400s: absorbed/split/offloaded-refuse,
   bad params) render verbatim as a visible error surface, never swallowed,
   never pre-empted (pre-empting = re-implementing guard logic = leak).
3. **BOTH VIEWS UPDATE (the §11 acceptance):** after every op (success OR
   refusal) the same loadConversation runs; conversation view re-derives from
   fresh emittedFrameIds, frame view from fresh list(). No per-view patching.
4. **PARAM AFFORDANCES stay tracer-minimal** (decide exact forms with
   reviewer): edit/compact (textarea), offload (optional summary), add (text
   + after-position), move (after-position), combine (multi-select), split
   (message-boundary indices from the details panel's indexed messages),
   strip/summarize (resultIds or all + text), retitle (title/summary),
   delete (no params), revert (no params = last commit). --regen variants:
   surface the flag but let the daemon's refusal speak when no LLM is
   configured (5d wires the subscription path).
5. **REGRESSION RAILS:** read-only surfaces from 5a (transcript assembly,
   flags, details, route table) must not regress — extend, don't rewrite.
   Engine untouched except (if agreed) the exported CLI verb list constant.
6. **DUAL-CLIENT SMOKE (the standing beat from 5b on):** a real TUI session
   (tmux, default permission mode) AND the browser on the SAME fresh daemon:
   perform surgery IN THE BROWSER (delete + edit or offload), verify the next
   TUI turn's wire via the wiretap (tombstone omitted, override emitted),
   session stays healthy. Separate script from ui-smoke (it burns quota);
   judge via wiretap, screenshots as evidence.

### Acceptance (design.md §11 Phase 5, op half)

1. In a real browser against a real daemon: open a frame's op menu, run an op
   → BOTH views update (the design acceptance, verified by the Playwright
   smoke for at least delete, edit, offload, restore, retitle, revert; the
   API is the oracle: fresh list/compose confirm the mutation).
2. A refused op (e.g. edit an offloaded frame, split at an invalid boundary)
   shows the daemon's error text visibly; state unchanged after refetch.
3. Parity test: registry verbs ≡ CLI mutating verbs (both directions — no UI
   op without a CLI verb, no mutating CLI verb missing from the registry
   unless explicitly read-only/5c-deferred and listed as such IN the test).
4. Component layer covers: menu generation from the registry, param-form →
   request-body mapping, refusal rendering.
5. Dual-client smoke passes: browser surgery → next TUI turn's wiretap shows
   the op applied → session healthy.
6. All 5a gates stay green (tsc root+ui, bun test, demo, live-e2e,
   live-phase2, ui:smoke).

### Decide with reviewer (open, not locked)

- Registry home: src/shared/ops.ts (engine-adjacent, CLI could adopt it
  later) vs ui/src/ops.ts (UI-local; test imports both sides). Proposal:
  src/shared/ops.ts — it IS the product surface, not a UI detail.
- CLI verb export shape: `export const CTX_MUTATING_VERBS` in cli/ctx.ts
  asserted against the switch (zero behavior change) vs parsing the file in
  the test (no export, uglier). Proposal: the exported constant.
- Op menu UX: per-card dropdown (proposal — works for single-target ops) +
  a selection mode for combine; split parameterized from the details panel.
- Refusal surface: inline per-frame error chip vs global banner. Proposal:
  global banner (5a error-banner pattern) carrying frame id + verb + daemon
  text; per-frame chips when it's earned.
- Whether revert(last) belongs in the frame op menu or the topbar (it is
  store-scoped, not frame-scoped). Proposal: topbar, next to refresh.
- Dual-client smoke home: scripts/dual-client-smoke.sh (tmux + Playwright in
  one script) vs manual-with-checklist. Proposal: scripted, since 5a proved
  tmux driving works agent-side.

### Locked — don't relitigate

- Every UI op dispatches through an EXISTING control route; any new route
  needs a CLI verb in the same slice (none anticipated in 5b).
- No `send` from the UI; no head-op relaxation (edit/compact/offload on p0
  stay refused by the engine — the UI surfaces the refusal, period).
- No optimistic UI, no client-side op logic, no state library.
- Never touch the 8788 daemon or its store/wiretap; smoke daemons on own
  ports (avoid 8796/8797/8799; 8806 is ui-smoke's, 8807 was 5a's TUI smoke).
- Scope guard: op menu + registry + parity + refusals + dual-client smoke
  ONLY — no history/timeline panel (5c), no commit picker, no regen backend
  (5d), no branching.

### Resources

- Control routes + param shapes: proxy/server.ts lines ~246–530 (the POST
  bodies each route parses — the registry mirrors THESE, not the CLI flags).
- CLI verb list + flag parsing: src/cli/ctx.ts (switch at ~line 450).
- 5a surfaces to extend: ui/src/App.tsx (loadConversation, error banner),
  FrameView (cards → menu host), DetailsPanel (indexed messages for split),
  api.ts (GET helpers; add a postOp helper), scripts/ui-smoke.ts (op
  assertions append after the read-only checks).
- Engine refusal messages worth rendering verbatim: state.ts opTarget/
  offload/edit guards ("restore it first", "revert the combine first", …).
- Dual-client smoke mechanics: 5a's tmux recipe (trust prompt, suggestion
  ghost-text caveat) + scripts/ui-smoke.sh daemon-boot pattern.
