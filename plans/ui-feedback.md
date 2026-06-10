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
- status: plan-approved (engine batch A; implement after the UI batches commit — tree clean between batches)
- what: "frames should have auto-generated titles automatically populated, instead of 'frame t1'. there's already 't1' as a left-aligned label. that's good"
- where: frame view, all frame cards
- expected: every frame carries a meaningful auto-generated title; the t-id label covers identity already
- evidence: title is engine-side metadata; auto-populating touches capture/engine and burns LLM quota per turn
- resolution: Nil decided 2026-06-10: option (a) auto-generate at ingest — "this demo is not about cost saving"; model: SONNET with LOW thinking effort (explicitly not haiku). Plan-gate sent to Context Reviewer before implementing (engine batch with F-017).
- plan-adjustments (Context Reviewer GO, 2026-06-10 — all adopted):
  1. audited not silent: `enriched` timeline EVENT on successful apply (frame id, fields filled, provider/model; no raw prompt/output); failures log-only.
  2. separate enable gate CC_ENRICH_ON_INGEST=1 — provider activation (CC_LLM_CLAUDE_CLI=1 etc.) alone must NOT start per-turn burns; default daemon + tests stay quota-free.
  3. provider/model precedence explicit; regen ops keep CC_LLM_*; CC_ENRICH_MODEL for enrichment. VERIFIED 2026-06-10 against installed claude CLI 2.1.170 (`claude --help`) + claude-api skill: `--model` accepts alias or full id, `--effort` accepts low|medium|high|xhigh|max → enrichment invocation: `--model claude-sonnet-4-6 --effort low` (exact alias id per model catalog — never date-suffixed); same model id is valid on the API-key path (`output_config.effort: "low"` equivalent).
  4. LLM output = untrusted metadata: strict JSON parse, whitespace collapse, length caps, no-op on malformed/empty (summary rides the wire post-F-017).
  5. apply under LATEST-store checks per field (exists, still turn, not deleted, title still placeholder / summary still null); skip per-field, no event if nothing applied.
  6. in-memory non-blocking queue; live-ingest only, NO replay/backfill on store load in this slice.
  7. risk precision: post-F-017 the auto-summary also rides CLI/control offload without --summary (intended; not UI-preview-only).

## F-002 — Ops menu should dismiss on outside click
- reported: 2026-06-10 · class: refinement
- status: fixed@65dabc7
- what: "when i open the 'ops' menu, it should be dismissable when clicking outside of it, rather than having to click 'ops' again to close it"
- where: frame view, op menu per frame card
- expected: click outside the open menu closes it
- evidence: pure UI behavior
- resolution: fixed: OpMenu capture-phase document listener closes any open menu on outside click; inside clicks unaffected; cleans up on unmount. Regression: ui/test/op-menu.test.tsx "F-002".
- confirmed: Nil confirmed live 2026-06-10.

## F-003 — Offload form should come with the stub pre-generated
- reported: 2026-06-10 · class: refinement
- status: fixed@65dabc7
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
- status: fixed@batch-3
- what: "most users may not want to even see fork frames... nice to be able to see them and inspect. maybe the ui should default to hiding those frames?"
- where: frame view, fork-only frame cards (e.g. t6 "[SUGGESTION MODE:...")
- expected: fork-only frames hidden by default; toggle reveals them
- evidence: pure display filter — frame membership truth stays the engine's; nothing op-related is hidden by frame STATE (the rail concerns op availability, not card visibility, and the toggle keeps them reachable)
- resolution: fixed: frame view filters inLastView === false cards by default (strictly false — null is not fork-only); "show fork-only frames (N)" toggle (App-level state, survives tab switches); a pending inline op form on a card that gets hidden falls back to the top host. ui:smoke extended (API-oracle: non-fork list default, toggle reveals all / no-toggle-when-none). Regression: app-render.test.tsx "F-006".

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
- status: fixed@65dabc7
- what: "the 'offload' menu appears at the top of the page. would it make more sense if this kind of menus appeared at the bottom?"
- where: frame view, op forms
- expected: form appears near the frame/menu that triggered it (or bottom — Nil has no strong position; near-trigger is the lean)
- evidence: pure UI placement
- resolution: fixed: single-target forms render inline under the triggering card (FrameView slot; App owns the form); store-scoped forms (topbar add) and other-view cases keep the top host so a pending form is never invisible. Regression: op-menu.test.tsx "F-008".
- confirmed: Nil confirmed live ("looks good").

## F-009 — Conversation id selectable/copyable
- reported: 2026-06-10 · class: refinement
- status: fixed@2a0a35c
- what: "make the conversation id (ba5a...) selectable/copy-able"
- where: topbar / conversation switcher
- expected: id text selectable; ideally click-to-copy
- evidence: pure UI
- resolution: fixed: topbar shows the active conversation identity as selectable text (user-select: all) with a one-click copy button for the FULL key (new ui/src/copy.ts; execCommand fallback because navigator.clipboard needs a secure context and the daemon is plain http). Regression: app-render.test.tsx "F-009".

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
- status: fixed@2a0a35c
- what: "make the nav bar a bit more robust. For thinner screens, 'history' button and even 'frames' can be hidden. They need minimum width with some explicit overflow-handling mechanism (no strong opinion)... consider if having a 2-row nav bar is better."
- where: topbar
- expected: explicit overflow handling at narrow widths; no strong mechanism preference
- evidence: pure UI/CSS
- resolution: fixed: topbar flex-wraps onto a second row when thin (2-row only when needed); conv switcher gets min/max width; view toggle never crushes. CSS-only — not unit-assertable, verified in ui:smoke + live.
- confirmed: Nil confirmed live ("looks good, at least on desktop; not worrying about mobile").

## F-012 — Action buttons (add frame, revert last, …) wrap to two lines → uneven heights
- reported: 2026-06-10 · class: refinement
- status: fixed@2a0a35c
- what: "the buttons, 'add frame', 'revert last', ... don't look too nice either, as they may get split into 2 lines, giving them uneven heights"
- where: topbar action buttons
- expected: buttons keep one line / even heights at all widths
- evidence: pure UI/CSS
- resolution: fixed: white-space nowrap on all topbar/store-ops buttons — no mid-button line breaks, even heights. CSS-only.

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
- status: fixed@65dabc7
- what: "when switching to history view, keeping the frame side panel open for a frame that is not tied to the history view is a bit confusing. maybe it should be hidden for history view, and reopened on the other views?"
- where: history tab + details panel
- expected: details panel hidden in history view; restored (same frame) on switching back
- evidence: pure UI state
- resolution: fixed: App.switchView stashes the selection entering history and restores on exit; selecting inside history (frame links, 5c flow) still opens the panel. Regression: app-render.test.tsx "F-014".
- confirmed: Nil confirmed live ("looks good"); follow-up spawned F-018 (autoscroll).

## F-015 — Metadata: beginner-friendly subset with a "show all" toggle
- reported: 2026-06-10 · class: refinement
- status: fixed@65dabc7
- what: "frames have a lot of metadata fields. I like them. But maybe we should consider a 'beginner-friendly subset' and a toggle to show the full subset."
- where: details panel
- expected: curated default subset; toggle reveals everything
- evidence: pure UI; which fields land in the default subset is a taste call — will propose, Nil adjusts live
- resolution: fixed: details.ts rows carry tier core|advanced; panel defaults to core with "show all fields (N more)" toggle. Regression: details.test.ts "F-015" + app-render.test.tsx "F-015".
- confirmed: Nil confirmed live ("very nice").

## F-016 — Stable metadata field placement across frames
- reported: 2026-06-10 · class: refinement
- status: fixed@65dabc7
- what: "when looking at different frames, metadata fields with the same name stay in place. this is not happening right now because 'fork only' pushes fields down, and the set of fields is not fixed, like the tools can appear... maybe fields that are always there should be moved above fields that only appear sometimes. and maybe the space for 'fork only' can be prereserved"
- where: details panel
- expected: fixed field order — always-present fields first; sometimes-present fields (tools, flags) in a stable lower region; reserve space for flags where cheap
- evidence: pure UI
- resolution: fixed: always-present fields lead in a fixed block, sometimes-present follow in fixed relative order; chips row always rendered (reserved height). Regression: details.test.ts "F-016".
- confirmed: Nil confirmed live ("very nice").

## F-017 — Offload stub default is the first line verbatim, not a summary
- reported: 2026-06-10 · class: refinement
- status: plan-approved (engine batch A; implement after the UI batches commit — tree clean between batches)
- what: "the summary seems to just be the user's message verbatim. that's not a summary" (on the F-003 prefill)
- where: offload form prefill / engine deriveSummary default
- expected: the default stub reads like a summary of the frame, not its first line
- evidence: engine deriveSummary (src/engine/offload.ts) is deliberately deterministic-no-LLM from Phase 3b; the prefill faithfully previews it — the default itself is what underwhelms
- resolution: fold into engine batch A with F-001: auto-summaries at ingest (sonnet, low thinking) become the offload default (summary ?? f.summary ?? deriveSummary ?? fallback); UI prefill mirrors the same chain. Plan-gated.

## F-018 — Switching to conversation view should jump to the selected frame
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-3
- what: "when selecting a frame in frames or history view, and then switching to conversation view, it would be nice to jump/autoscroll to it. I know autoscroll can be tricky so do not try to overengineer this"
- where: conversation view on entry with a selection
- expected: view opens scrolled to the selected frame's first bubble; no scroll-fighting afterwards
- evidence: pure UI
- resolution: fixed: ConversationView mount-time jump — scrollIntoView(center) on the selected frame's first bubble; mount-only, never fights user scrolling (per Nil: not overengineered). Regression: app-render.test.tsx "F-018/F-020".

## F-019 — History sub-toggle (commits|timeline) overlaps entries when scrolling
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-3
- what: "commits and timeline buttons should never overlap with the entries below them"
- where: history tab, sticky sub-toggle
- expected: entries never show through/around the sticky toggle row
- evidence: sticky toggle is content-width; entries scroll past beside/above it
- resolution: fixed: sub-toggle wrapped in a full-width sticky backdrop row (top:-16px cancels scrollport padding) — entries can no longer show beside/above it. CSS+markup; visually verified in smoke shots.

## F-020 — Conversation view should open scrolled to the bottom (+ discreet jump button)
- reported: 2026-06-10 · class: refinement
- status: fixed@batch-3
- what: "going to the conversation view should default to scrolling to the bottom, since that's the most recent activity. a discreet button to scroll to the bottom may also be helpful"
- where: conversation view
- expected: opens at latest activity when nothing is selected (F-018 wins when a selection exists); small jump-to-bottom control
- evidence: pure UI
- resolution: fixed: with no selection the conversation view opens scrolled to the bottom; discreet sticky ↓ button (bottom-right) jumps to latest. Regression: app-render.test.tsx "F-018/F-020".

## F-021 — Explanation tooltips for all buttons
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "add explanation tooltips for all the buttons, it's not clear what they do. e.g., what does refresh do? not clear"
- where: topbar + view controls + op surfaces
- expected: title tooltips describing each control's action
- evidence: pure UI
- resolution: (batch 4)

## F-022 — "combine…" button is cut off
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "'combine...' button is cut off"
- where: topbar store-ops
- expected: button renders fully at all widths
- evidence: store-ops buttons can flex-shrink below content width
- resolution: (batch 4) flex-shrink: 0 + verify in browser

## F-023 — Why is refresh right-aligned? (question)
- reported: 2026-06-10 · class: observation
- status: answered-in-chat
- what: "why is refresh right aligned? just a question"
- where: topbar
- expected: n/a — question
- evidence: margin-left:auto since 5a — refresh is the global re-fetch, visually separated from the store-MUTATING ops cluster
- resolution: answered; will move it if Nil prefers — say the word

## F-024 — Favicon + capitalized tab title
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "add a favicon and capitalization on the tab name"
- where: ui/index.html (<title>context composer</title>, icon is the deliberate empty data: URI that suppresses /favicon.ico passthrough hits)
- expected: real icon + "Context Composer"
- evidence: must stay a data: URI (or /ui-scoped asset) so no implicit /favicon.ico request leaks into the transparent passthrough
- resolution: (batch 4) inline SVG data-URI favicon + title case

## F-025 — Conversation identity appears twice (switcher + copy span), inconsistent lengths
- reported: 2026-06-10 · class: refinement
- status: triaged
- what: "now the ui is a bit awkward. the convo id appears twice in close proximity... one is long form and one is prefix only. not clear why. maybe use short in both? not sure"
- where: topbar conv switcher + F-009 conv-key span
- expected: identity shown once coherently; short form preferred
- evidence: switcher options carry key.slice(0,24); the span carries key.slice(0,8)
- resolution: (batch 4) plan: drop the key from switcher options (id · turns · active); the span stays the single key surface (short prefix, selectable, copy-FULL button + full key in tooltip) — Nil can veto
