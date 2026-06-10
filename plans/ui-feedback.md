# UI feedback ledger (Phase 5e live testing)

Intake for Nil's UI test reports. The session agent records every report
here IMMEDIATELY (this file is the durable truth; chat is not). Process and
gates: plans/phase5e-feedback-loop.md.

Format per item:

    ## F-NNN — <one-line title>
    - reported: <date> · class: bug | refinement | design-question
    - status: new | triaged | in-batch-N | fixed@<commit> | parked-for-Nil | wontfix (Nil)
    - what: <what Nil saw — verbatim where possible>
    - where: <view/tab + conv id + frame id if known>
    - expected: <what should happen>
    - evidence: <wiretap ts / control API reads / screenshot path — filled at triage>
    - resolution: <fix summary + regression test, or the parked options>

Batches: group 3–6 related items; one reviewer diff-review + one commit per
batch (`ui-fix batch N: <summary>`); update statuses in the same commit.
`fixed@batch-N` is written atomically in the batch commit; the short hash is
backfilled (`fixed@<hash>`) in the next commit that touches this file.

---

## F-001 — Frame titles should be auto-generated and auto-populated (not "frame t1" fallback)
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "frames should have auto-generated titles automatically populated, instead of 'frame t1'. there's already 't1' as a left-aligned label. that's good"
- where: frame view, all frame cards
- expected: every frame carries a meaningful auto-generated title; the t-id label covers identity already
- evidence: title is engine-side metadata; auto-populating touches capture/engine and burns LLM quota per turn
- resolution: NEEDS PLAN GATE (engine-touching) + Nil's call on trigger/cost: (a) auto-retitle at ingest (LLM call per turn — quota burn), (b) explicit "title untitled frames" batch action (one click, explicit burn), (c) deterministic engine-side title from content (no LLM, weaker titles). Asked Nil in chat.

## F-002 — Ops menu should dismiss on outside click
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-1
- what: "when i open the 'ops' menu, it should be dismissable when clicking outside of it, rather than having to click 'ops' again to close it"
- where: frame view, op menu per frame card
- expected: click outside the open menu closes it
- evidence: pure UI behavior
- resolution: fixed: OpMenu capture-phase document listener closes any open menu on outside click; inside clicks unaffected; cleans up on unmount. Regression: ui/test/op-menu.test.tsx "F-002".

## F-003 — Offload form should come with the stub pre-generated
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-1
- what: "offload should autogenerate the stub. offering to edit it is fine, but it should come with one ready"
- where: frame view, offload op form
- expected: stub field pre-populated with a ready stub; editable before submit
- evidence: recon pending — thin-wrapper constraint: the default stub must be the ENGINE's default (UI must not own stub-generation logic); if `ctx offload` without --stub already defaults, the UI should surface/prefill that same default
- resolution: fixed: new ui/src/prefill.ts — form opens with a PREVIEW of the engine default (engine's own deriveSummary over currentEmission; offload.ts is pure/browser-safe); clearing the field omits the param, daemon derives identically. Regression: ui/test/prefill.test.ts (4 tests) + op-menu.test.tsx "F-003".

## F-004 — Client-side guard around preamble ops (maybe later)
- reported: 2026-06-10 · class: design-question
- status: parked-for-Nil
- what: "save this as a maybe for later: client-side guard around messing with the preamble, as it can make sessions invalid"
- where: frame view, ops on p0/preamble frames
- expected: TBD by Nil — related to the 2026-06-10 keep-as-is decision on delete-p0 (phase5-loop.md parked list: known subscription foot-gun, revert heals)
- evidence: prior live testing: deleted p0 → upstream 429 every turn; revert healed in place
- resolution: parked per Nil's own words ("maybe for later"). Options when revisited: confirm-dialog on preamble-frame mutations (UI-only, guards still speak) vs. nothing (current). Engine stays faithful either way.

## F-005 — Observation: 400-failed turns duplicated messages into next frames; fork-only marking correct
- reported: 2026-06-10 · class: observation
- status: recorded (no action)
- what: "when t2 and t3 ran into an api error (400) because i had messed with the preamble, the consequence was that messages got duplicated to next frames. But confirmed this doesn't happen when not hitting a 400 error... t2 and t3 are marked as fork-only... those didn't make it to the main thread so the messages got accumulated and picked up once in the main thread."
- where: conv ba5a..., frames t2/t3
- expected: exactly what happened — per-request-view compose accumulates unacked turns and the main thread picks them up once; Nil confirms correct
- evidence: Nil's own cross-check; fork-only flags on t2/t3
- resolution: no action; recorded so the 400-path behavior is documented

## F-006 — Default-hide fork-only frames in frame view (with a toggle to show)
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "most users may not want to even see fork frames... nice to be able to see them and inspect. maybe the ui should default to hiding those frames?"
- where: frame view, fork-only frame cards (e.g. t6 "[SUGGESTION MODE:...")
- expected: fork-only frames hidden by default; toggle reveals them
- evidence: pure display filter — frame membership truth stays the engine's; nothing op-related is hidden by frame STATE (the rail concerns op availability, not card visibility, and the toggle keeps them reachable)
- resolution: (batch 2) implement toggle, default hidden per Nil's lean; flip-back is trivial if it feels wrong in practice

## F-007 — Distinct numbering for fork frames so the main thread reads continuous
- reported: 2026-06-10 · class: design-question
- status: parked-for-Nil
- what: "maybe their numbering should be distinct as well, so the main thread has continuous numbers?"
- where: frame ids (t1, t2, ...) shared across turn + fork frames
- expected: TBD by Nil
- evidence: t-ids are engine-assigned identity shared with the CLI and the store — not a display string
- resolution: parked; options: (1) keep ids as-is and let F-006's hiding make the main thread read clean; (2) engine-side separate id-spaces for turn vs fork frames (id-scheme change: engine + CLI + store, plan-gated); (3) UI shows an ordinal position label next to the true id (display-only, but two numbering systems on screen). NOT deciding here — id semantics are engine truth and CLI parity is a rail.

## F-008 — Op forms (e.g. offload) render at the top of the page; anchor near the trigger instead
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-1
- what: "the 'offload' menu appears at the top of the page. would it make more sense if this kind of menus appeared at the bottom?"
- where: frame view, op forms
- expected: form appears near the frame/menu that triggered it (or bottom — Nil has no strong position; near-trigger is the lean)
- evidence: pure UI placement
- resolution: fixed: single-target forms render inline under the triggering card (FrameView slot; App owns the form); store-scoped forms (topbar add) and other-view cases keep the top host so a pending form is never invisible. Regression: op-menu.test.tsx "F-008".

## F-009 — Conversation id selectable/copyable
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "make the conversation id (ba5a...) selectable/copy-able"
- where: topbar / conversation switcher
- expected: id text selectable; ideally click-to-copy
- evidence: pure UI
- resolution: (batch 2)

## F-010 — Conversation-level auto-generated summary
- reported: 2026-06-10 · class: design-question
- status: parked-for-Nil
- what: "add a conversation level auto-gen summary"
- where: topbar / conversation switcher
- expected: TBD by Nil — adds a new surface
- evidence: conversations carry no summary field today; parity rail: a regen-able conv summary needs an engine/store field + control route + CLI verb in the same batch (plan gate), plus LLM quota for the regen
- resolution: parked; options: (a) conv.summary in the store + `summarize` grows a conv-level mode (CLI + route + UI together, plan-gated); (b) display-only digest derived in the UI from existing frame summaries (no engine change but the UI would own logic — thin-wrapper smell, noted not endorsed); (c) defer past 5e

## F-011 — Nav bar robustness on thin screens (min widths, overflow handling; consider 2-row)
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "make the nav bar a bit more robust. For thinner screens, 'history' button and even 'frames' can be hidden. They need minimum width with some explicit overflow-handling mechanism (no strong opinion)... consider if having a 2-row nav bar is better."
- where: topbar
- expected: explicit overflow handling at narrow widths; no strong mechanism preference
- evidence: pure UI/CSS
- resolution: (batch 2)

## F-012 — Action buttons (add frame, revert last, …) wrap to two lines → uneven heights
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "the buttons, 'add frame', 'revert last', ... don't look too nice either, as they may get split into 2 lines, giving them uneven heights"
- where: topbar action buttons
- expected: buttons keep one line / even heights at all widths
- evidence: pure UI/CSS
- resolution: (batch 2, same surface as F-011)

## F-013 — Run ops on a frame from the conversation view (open question)
- reported: 2026-06-10 · class: design-question
- status: parked-for-Nil
- what: "I love that selecting a message in the chat UI shows you the frame. Would it be possible to do operations on that frame from the chat UI itself? more of an open question."
- where: conversation view
- expected: TBD by Nil
- evidence: mechanically safe — same op registry + same control routes, just a second entry point (no parity violation); but design.md §4 names the frame view "the manipulation surface", so this shifts a design statement
- resolution: parked; feasibility is a clear yes if Nil wants it

## F-014 — Hide the frame details side panel while in history view
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-1
- what: "when switching to history view, keeping the frame side panel open for a frame that is not tied to the history view is a bit confusing. maybe it should be hidden for history view, and reopened on the other views?"
- where: history tab + details panel
- expected: details panel hidden in history view; restored (same frame) on switching back
- evidence: pure UI state
- resolution: fixed: App.switchView stashes the selection entering history and restores on exit; selecting inside history (frame links, 5c flow) still opens the panel. Regression: app-render.test.tsx "F-014".

## F-015 — Metadata: beginner-friendly subset with a "show all" toggle
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-1
- what: "frames have a lot of metadata fields. I like them. But maybe we should consider a 'beginner-friendly subset' and a toggle to show the full subset."
- where: details panel
- expected: curated default subset; toggle reveals everything
- evidence: pure UI; which fields land in the default subset is a taste call — will propose, Nil adjusts live
- resolution: fixed: details.ts rows carry tier core|advanced; panel defaults to core with "show all fields (N more)" toggle. Regression: details.test.ts "F-015" + app-render.test.tsx "F-015".

## F-016 — Stable metadata field placement across frames
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-1
- what: "when looking at different frames, metadata fields with the same name stay in place. this is not happening right now because 'fork only' pushes fields down, and the set of fields is not fixed, like the tools can appear... maybe fields that are always there should be moved above fields that only appear sometimes. and maybe the space for 'fork only' can be prereserved"
- where: details panel
- expected: fixed field order — always-present fields first; sometimes-present fields (tools, flags) in a stable lower region; reserve space for flags where cheap
- evidence: pure UI
- resolution: fixed: always-present fields lead in a fixed block, sometimes-present follow in fixed relative order; chips row always rendered (reserved height). Regression: details.test.ts "F-016".
