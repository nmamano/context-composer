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
`bunx tsc --noEmit`, `bun test`, `bun run demo`, `bash scripts/live-e2e.sh`,
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

- [ ] 5a — SCAFFOLD + READ-ONLY VIEWS + BROWSER GATE. ui/ React app served by
  the daemon (or a dev server proxying /control — decide with reviewer);
  conversation view (chat transcript rendered from frames) ⇄ frame view
  (linear frame cards: title — summary, tokens, flags [deleted/override/
  offloaded/added/fork-only]) with a toggle; details panel (full content,
  provenance, fileReference); conversations switcher (registry). The
  Playwright harness lands IN THIS SLICE (test/ui-smoke or scripts/ui-smoke):
  browser renders real store data from a live daemon; screenshot evidence.
  Acceptance: a store populated by a real TUI session renders correctly in
  both views in a real browser.
- [ ] 5b — OPS FROM THE UI + PARITY REGISTRY. Op menu per frame wired to the
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
