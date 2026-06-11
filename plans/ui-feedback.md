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
- status: fixed@16b4062 (batch A; reviewer-signed 2026-06-10; all gates incl. live)
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
- live-gate evidence (2026-06-10, Nil green-lit quota): demo PASS; live-e2e PASS; live-phase2 PASS; dual-client PASS on retry (first attempt was a marker-phrasing flake — turn-1 upstream 200, exact-string marker missing; retry clean) incl. the F-017 stub-on-wire checks. LIVE ENRICHMENT end-to-end on a throwaway daemon (:8812, fresh store): real `claude --model claude-sonnet-4-6 --effort low` call → t1 titled "User asks tallest mountain on Earth" + faithful summary + audited note "title+summary via claude-cli:claude-sonnet-4-6@low" through /control/timeline. The failure path proved itself live too (claude not on the daemon shell's PATH → non-fatal log line, placeholder kept, no event; CC_CLAUDE_BIN fixes it).
- confirmed: Nil confirmed live 2026-06-10 ("good" on auto-titles populating new frames; "that's fine" on old frames keeping placeholders). Follow-up spawned F-050 (enriched timeline entry looks like any other — the UI drops the note).
- live-check findings FIXED pre-review: (1) publicEvent route mapper silently dropped the new `note` field → added (+ ui PublicEvent type, + route-level regression assert); (2) head-only input truncation ate the user's real question behind Claude Code's front-loaded skills reminder, making the model describe the enrichment instructions themselves → head+tail truncation (2000+3500) + prompt hardening (never describe the instructions; "background context" fallback for boilerplate-only turns) + regression test.

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
- status: fixed@c84aecf
- what: "most users may not want to even see fork frames... nice to be able to see them and inspect. maybe the ui should default to hiding those frames?"
- where: frame view, fork-only frame cards (e.g. t6 "[SUGGESTION MODE:...")
- expected: fork-only frames hidden by default; toggle reveals them
- evidence: pure display filter — frame membership truth stays the engine's; nothing op-related is hidden by frame STATE (the rail concerns op availability, not card visibility, and the toggle keeps them reachable)
- resolution: fixed: frame view filters inLastView === false cards by default (strictly false — null is not fork-only); "show fork-only frames (N)" toggle (App-level state, survives tab switches); a pending inline op form on a card that gets hidden falls back to the top host. ui:smoke extended (API-oracle: non-fork list default, toggle reveals all / no-toggle-when-none). Regression: app-render.test.tsx "F-006".
- confirmed: Nil confirmed live ("looks good").

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
- status: fixed@16b4062 (batch A; reviewer-signed 2026-06-10; all gates incl. live)
- what: "the summary seems to just be the user's message verbatim. that's not a summary" (on the F-003 prefill)
- where: offload form prefill / engine deriveSummary default
- expected: the default stub reads like a summary of the frame, not its first line
- evidence: engine deriveSummary (src/engine/offload.ts) is deliberately deterministic-no-LLM from Phase 3b; the prefill faithfully previews it — the default itself is what underwhelms
- resolution: fold into engine batch A with F-001: auto-summaries at ingest (sonnet, low thinking) become the offload default (summary ?? f.summary ?? deriveSummary ?? fallback); UI prefill mirrors the same chain. Plan-gated.
- confirmed: Nil confirmed live 2026-06-10 ("good" — offload prefills the auto-summary, not the first line).

## F-018 — Switching to conversation view should jump to the selected frame
- reported: 2026-06-10 · class: refinement
- status: fixed@c84aecf
- what: "when selecting a frame in frames or history view, and then switching to conversation view, it would be nice to jump/autoscroll to it. I know autoscroll can be tricky so do not try to overengineer this"
- where: conversation view on entry with a selection
- expected: view opens scrolled to the selected frame's first bubble; no scroll-fighting afterwards
- evidence: pure UI
- resolution: fixed: ConversationView mount-time jump — scrollIntoView(center) on the selected frame's first bubble; mount-only, never fights user scrolling (per Nil: not overengineered). Regression: app-render.test.tsx "F-018/F-020".
- confirmed: Nil confirmed live ("good").

## F-019 — History sub-toggle (commits|timeline) overlaps entries when scrolling
- reported: 2026-06-10 · class: refinement
- status: fixed@c84aecf
- what: "commits and timeline buttons should never overlap with the entries below them"
- where: history tab, sticky sub-toggle
- expected: entries never show through/around the sticky toggle row
- evidence: sticky toggle is content-width; entries scroll past beside/above it
- resolution: fixed: sub-toggle wrapped in a full-width sticky backdrop row (top:-16px cancels scrollport padding) — entries can no longer show beside/above it. CSS+markup; visually verified in smoke shots.
- confirmed: Nil confirmed ("good") but follow-up spawned F-026: it should be a FIXED sub-nav below the topbar, not a sticky element that moves; whitespace above it too generous.

## F-020 — Conversation view should open scrolled to the bottom (+ discreet jump button)
- reported: 2026-06-10 · class: refinement
- status: fixed@c84aecf
- what: "going to the conversation view should default to scrolling to the bottom, since that's the most recent activity. a discreet button to scroll to the bottom may also be helpful"
- where: conversation view
- expected: opens at latest activity when nothing is selected (F-018 wins when a selection exists); small jump-to-bottom control
- evidence: pure UI
- resolution: fixed: with no selection the conversation view opens scrolled to the bottom; discreet sticky ↓ button (bottom-right) jumps to latest. Regression: app-render.test.tsx "F-018/F-020".
- confirmed: Nil confirmed live ("good").

## F-021 — Explanation tooltips for all buttons
- reported: 2026-06-10 · class: refinement
- status: fixed@5868672
- what: "add explanation tooltips for all the buttons, it's not clear what they do. e.g., what does refresh do? not clear"
- where: topbar + view controls + op surfaces
- expected: title tooltips describing each control's action
- evidence: pure UI
- resolution: fixed: title tooltips on every topbar control (tabs, store ops, switcher, copy, refresh), the per-frame ops menu trigger, details close/fields toggle, history sub-toggle. Regression: app-render.test.tsx "F-021" (non-empty title on all topbar controls).
- confirmed: Nil follow-ups: copy too jargony (F-028) and tooltips should appear quicker (F-031).

## F-022 — "combine…" button is cut off
- reported: 2026-06-10 · class: refinement
- status: fixed@967fe4c
- what: "'combine...' button is cut off"
- where: topbar store-ops
- expected: button renders fully at all widths
- evidence: store-ops buttons can flex-shrink below content width
- resolution: resolved via F-029: the store-ops buttons moved into the frames-view toolbar with room to render at natural width; flex-shrink:0 retained. Nil to confirm visually.
- confirmed: Nil confirmed ("good"); 4.1 clarified the original report — the "…" was the literal label, not clipping. Label change is F-032.

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
- status: fixed@5868672
- what: "add a favicon and capitalization on the tab name"
- where: ui/index.html (<title>context composer</title>, icon is the deliberate empty data: URI that suppresses /favicon.ico passthrough hits)
- expected: real icon + "Context Composer"
- evidence: must stay a data: URI (or /ui-scoped asset) so no implicit /favicon.ico request leaks into the transparent passthrough
- resolution: fixed: <title>Context Composer</title> + real favicon as inline SVG data URI (two stacked frame cards) — stays a data: URI so no implicit request leaks past /ui into the passthrough. ui:smoke asserts both.
- confirmed: Nil confirmed live ("looks good").

## F-025 — Conversation identity appears twice (switcher + copy span), inconsistent lengths
- reported: 2026-06-10 · class: refinement
- status: fixed@5868672
- what: "now the ui is a bit awkward. the convo id appears twice in close proximity... one is long form and one is prefix only. not clear why. maybe use short in both? not sure"
- where: topbar conv switcher + F-009 conv-key span
- expected: identity shown once coherently; short form preferred
- evidence: switcher options carry key.slice(0,24); the span carries key.slice(0,8)
- resolution: fixed: switcher options now carry id + turns + active only; the conv-key span is the single key surface (8-char prefix, full key in tooltip, copy-full button). Regression: app-render.test.tsx "F-025".
- confirmed: Nil confirmed ("looks good"); follow-up spawned F-030 (drop the duplicated dim id from the span).

## F-026 — History sub-toggle should be a FIXED sub-nav below the topbar
- reported: 2026-06-10 · class: refinement
- status: fixed@967fe4c
- what: "why does it move at all? why can't it be fixed to below the nav bar. it's essentially a sub-nav-bar. it may have too much white space above it, between it and the nav bar"
- where: history tab
- expected: commits|timeline row pinned below the topbar (non-scrolling), tighter spacing above
- evidence: pure UI — batch-3 sticky backdrop (F-019) was the half-measure
- resolution: fixed: commits|timeline row is now a true FIXED sub-nav — rendered outside the scroll area (.history-scroll owns scrolling), tighter top padding (8px). The F-019 sticky-backdrop hack is gone.
- confirmed: Nil confirmed live ("good").

## F-027 — Auto-generated topic per conversation in the selector
- reported: 2026-06-10 · class: design-question
- status: parked-for-Nil
- what: "consider for later: add auto generated topic for the session selector. the implementation is a bit tricky as session topics evolve over time"
- where: topbar conversation switcher
- expected: TBD by Nil — "consider for later" per his words
- evidence: sibling of F-010 (conv-level summary); both need conv-level metadata + a regen path (engine/store field + control route + CLI verb + plan gate). Topic drift over time is the hard part Nil flagged
- resolution: parked; natural candidate to fold into the engine-batch-A enrichment machinery later (re-enrich conv topic as turns arrive), but ONLY with Nil's go and its own plan gate

## F-028 — Tooltip copy is jargon — rewrite as intuitive guidance
- reported: 2026-06-10 · class: refinement
- status: fixed@967fe4c
- what: "'(the emission)' doesn't mean anything to a user; 'what the model currently sees' is not exactly accurate for the conversation view; 'every frame as a card with its ops menu' doesn't belong in the tooltip; 'commit log', 'audit' is ambiguous. Drop the jargon. Use intuitive guidance."
- where: all batch-4 tooltips
- expected: plain-language, user-intent-first tooltip copy
- evidence: pure UI copy
- resolution: fixed: full tooltip copy pass — plain language, no emission/commit/audit/frame-card jargon (e.g. history tab: "review past changes and undo them"; ops menu: "edit this frame — delete, rewrite, offload and more"). Regression: app-render "F-021/F-028" bans jargon words across all tips.

## F-029 — Store-scoped ops (add frame / revert last / combine) out of the nav bar
- reported: 2026-06-10 · class: refinement
- status: fixed@967fe4c
- what: "'revert last' shouldn't be at the nav bar level. that's an action that should be placed very intentionally, maybe close to the thing being updated by it. Generally speaking, it feels like add frame/revert last/combine frames are operations that should only appear in the frames view, and not in the nav bar."
- where: topbar store-ops cluster
- expected: these ops live in the frames view (the manipulation surface), not global chrome
- evidence: pure UI placement — same registry verbs, same routes, zero op-surface change (history view keeps its per-commit revert)
- resolution: fixed: add/revert/combine (+ fork toggle) moved to a frames-view toolbar; zero-target forms open under that toolbar; pending forms still fall back to the top host on other views (never invisible); history keeps per-commit revert. Regressions: op-menu "F-008/F-029" placement chain + topbar-absence assertions; history-view revert test updated; ui:smoke wording updated (same flow).

## F-030 — Conv-key span repeats the id shown in the selector
- reported: 2026-06-10 · class: refinement
- status: fixed@967fe4c
- what: "remove the dim 'c1' outside the selector, it's repeated to the right of it"
- where: topbar conv-key span
- expected: span shows the key prefix + copy button only
- evidence: pure UI
- resolution: fixed: conv-key span shows the 8-char key prefix only (id lives in the switcher alone); span hidden entirely when a conversation has no key. Regression: app-render "F-009" updated.
- confirmed: Nil confirmed live ("good").

## F-031 — Tooltips should appear quicker
- reported: 2026-06-10 · class: refinement
- status: fixed@967fe4c
- what: "can you make them show up quicker?"
- where: all tooltips (native title attrs have an OS-controlled ~1s delay, not adjustable)
- expected: near-instant tooltip on hover
- evidence: requires CSS tooltips (attr-based ::after) instead of native title
- resolution: fixed: data-tip + CSS ::after tooltips — instant on hover, right-edge-aware positioning; native title kept only on the <select>; view-toggle/sub-toggle overflow switched to visible so tips are not clipped (corner rounding moved to first/last buttons).
- confirmed: Nil confirmed live ("good").

## F-032 — "combine…" label should just say "combine"
- reported: 2026-06-10 · class: refinement
- status: fixed@7b46b02
- what: "oh i finally understood. 'combine...' is the actual text, not a trim. just make the text 'combine'."
- where: frames toolbar
- expected: label "combine" (cancel state unchanged)
- evidence: pure UI copy
- resolution: fixed: label is "combine" (cancel state unchanged).

## F-033 — Capitalize "Context Composer" in the nav bar
- reported: 2026-06-10 · class: refinement
- status: fixed@7b46b02
- what: "Capitalize Context Composer in the nav bar"
- where: topbar h1
- expected: "Context Composer" (matches the tab title from F-024)
- evidence: pure UI copy
- resolution: fixed: topbar h1 reads "Context Composer" (matches the F-024 tab title). Regression: app-render copy test.

## F-034 — Frames-tab tooltip: Nil's exact copy
- reported: 2026-06-10 · class: refinement
- status: fixed@7b46b02
- what: "copy for 'frames': inspect and edit the context frames"
- where: frames tab tooltip
- expected: verbatim Nil copy
- evidence: pure UI copy
- resolution: fixed: frames tab tooltip is Nil's verbatim copy ("inspect and edit the context frames"). Regression: app-render copy test.

## F-035 — Refresh tooltip: say WHEN to click it, clearer on-focus phrasing
- reported: 2026-06-10 · class: refinement
- status: fixed@7b46b02
- what: "'(also refreshes when you return to this window)' could be said in a more clear way. more importantly: when is the user supposed to click this button? not clear."
- where: refresh tooltip
- expected: copy that names the actual use case — the conversation advanced (AI replied in the terminal) while this window stayed focused; everything else refreshes automatically (focus + after every op)
- evidence: pure UI copy
- resolution: fixed: refresh tooltip names the actual use case — "load what's new — use it if the conversation advanced while you kept this window open; switching back to the window refreshes on its own".

## F-036 — Preamble content is not viewable in the details panel
- reported: 2026-06-10 · class: bug
- status: fixed@7b46b02
- what: "Question: why is preamble content not shown?"
- where: details panel for p0
- expected: §8 — the details panel shows full text; preamble's content lives in system/tools/injectedSystem (not messages), which today surface only as advanced-tier COUNT rows ("2 definition(s)"), and the emission section shows "(no messages)" — so the actual content is unreachable in the UI (the CLI shows it)
- evidence: DetailsPanel renders currentEmission (empty for preamble) + count-only field rows; data is already in show()
- resolution: fixed: DetailsPanel renders a preamble-content section — full system prompt text, injected system blocks (labeled "added by the agent"), tool definitions as names + collapsible JSON; the misleading empty "(no messages)" emission section is skipped for preambles. Regression: app-render "F-036" (fixture p0 extended with tools + injectedSystem).

## F-037 — Combine tooltip: drop "pick the frames, then run"
- reported: 2026-06-10 · class: refinement
- status: fixed@7b46b02
- what: "'then run'? not clear. 'merge several frames into one' is enough"
- where: combine button tooltip
- expected: verbatim Nil copy
- evidence: pure UI copy
- resolution: fixed: combine tooltip is exactly "merge several frames into one".

## F-038 — Add-frame tooltip copy
- reported: 2026-06-10 · class: refinement
- status: fixed@f45a163 (batch 7)
- what: "add frame copy: insert text anywhere in the context"
- where: frames toolbar, add button tooltip
- expected: verbatim Nil copy
- resolution: fixed: add tooltip is Nil's verbatim copy ("insert text anywhere in the context").
- confirmed: Nil confirmed live ("good").

## F-039 — Add form position field: ambiguous (before/after?) — dropdown wanted
- reported: 2026-06-10 · class: refinement
- status: fixed@f45a163 (batch 7)
- what: "'position (frame id / start / end)' -> it's not clear if it appears before or after the frame id. i think also a drop down menu may be better. maybe as alternative?"
- where: add form, position param
- expected: explicit AFTER semantics; a dropdown (at the end / at the start / after <each frame>) instead of free text
- evidence: pure UI — the registry param kind "position" gets a dedicated renderer fed by the already-loaded frame list; build() mapping unchanged (ops.ts untouched)
- resolution: fixed: position renders as a dropdown — "at the end" (default) / "at the start" / "after <id> — <title>" per loaded frame; explicit AFTER semantics; values map unchanged through ops.ts position() ("" omit / start→null / id). ops.ts untouched. Regression: op-menu add test rewritten for the dropdown.
- confirmed: Nil confirmed live ("good").

## F-040 — Submit buttons: "run add" → "add"; visual style for committing actions
- reported: 2026-06-10 · class: refinement
- status: fixed@f45a163 (batch 7)
- what: "'run add' -> 'add' (maybe we can have a unique visual style for buttons that commit transactions)... it would look a bit more 'definitive' or 'serious'."
- where: op form submit buttons
- expected: bare verb label + filled "primary action" styling (the standard pattern: filled = commits, outline = neutral/cancel)
- resolution: fixed: submit buttons are the bare verb ("add"), styled as filled primary (accent bg) — committing actions read definitive; cancel stays outline. Regression: op-menu add test asserts label+class.
- confirmed: Nil confirmed live ("good").

## F-041 — Combine: unclear where the merged frame lands and what the merge logic is
- reported: 2026-06-10 · class: refinement
- status: fixed@f45a163 (batch 7)
- what: "'combine 2 selected' ... doesn't make clear where the merged frame lands, or what the merge logic is. straight append or llm rewrite? Need more clarity"
- where: combine flow copy
- expected: copy states the truth (verify against engine: mechanical append in selection order, no LLM; landing position per engine semantics) in the combine panel + run-button tooltip
- resolution: fixed: combine panel + run tooltip state the engine truth (verified in state.ts combine()): contents joined AS-IS in pick order, no LLM rewriting, result takes the first pick's slot. Copy only — semantics untouched.
- confirmed: Nil confirmed copy ("good"); follow-up spawned F-047 (combine wants an insert-position menu — engine change).

## F-042 — Homogenize combine with the other toolbar ops: panel + cancel; mutual exclusion
- reported: 2026-06-10 · class: refinement
- status: fixed@f45a163 (batch 7)
- what: "'add frame' opens its own panel, with a cancel button. 'combine' doesn't have a panel, and the button itself becomes the way to cancel. let's homogenize. both should have a panel with a cancel button inside. also, clicking one of the 3 buttons should close/auto-cancel the panel for the one that is opened, if any."
- where: frames toolbar
- expected: combine mode renders a panel (explainer + run + cancel inside); opening any toolbar op cancels the other open one
- resolution: fixed: combine gets the same panel treatment (explainer + primary run + cancel INSIDE); toolbar button is open-only; the three toolbar ops are mutually exclusive (opening one auto-cancels the other's panel). Regression: op-menu "F-042".
- confirmed: Nil confirmed live ("good").

## F-043 — Real-time updates (websocket/SSE) instead of fetch-on-demand
- reported: 2026-06-10 · class: design-question
- status: decided-deferred (SSE chosen by Nil; out of 5e scope)
- what: "don't updates get sent in real time via websocket? this is making it sound like refresh is necessary every time, as opposed to the occasional desync."
- where: UI data freshness model
- expected: TBD by Nil — today there is NO push channel: the UI fetches on load, focus, and after each op (5a decision); a turn arriving while the window stays focused IS the desync case the refresh button exists for
- evidence: adding push = new proxy surface (SSE/websocket route) + UI subscription — engine/proxy work with a plan gate; polling is a lighter alternative
- resolution: Nil decided 2026-06-10: SSE (option a) — but DEFERRED, not in 5e scope ("refresh is good for our current scope"). When picked up: control-surface addition, plan gate required.

## F-044 — Long tool names force horizontal scrolling in the details panel
- reported: 2026-06-10 · class: bug
- status: fixed@f45a163 (batch 7)
- what: "two tools ... longer than the side panel (mcp__claude_ai_Vercel__change_toolbar_thread_resolve_status,) added horizontal scrolling to the side panel, which is not good UI. i don't want horizontal scrolling there... i'm more ok with it just clipping"
- where: details panel, F-036 preamble tool list
- expected: no horizontal scroll — long unbroken tokens wrap (break-anywhere) or clip
- resolution: fixed: details panel overflow-x hidden + overflow-wrap anywhere on collapsed summaries/pre/text — long tool names wrap instead of forcing horizontal scroll.
- confirmed: Nil confirmed live ("good").

## F-045 — Mark the latest frame fork-only when it starts with *[SUGGESTION MODE*
- reported: 2026-06-10 · class: refinement (engine, Nil-decided exception to a locked principle)
- status: fixed@895be62 (batch B; reviewer-signed 2026-06-10: no blocking findings, focused 10/10; live gates waived — compose pinned byte-identical)
- follow-up: F-055 (2026-06-11) — the gated literal `*[SUGGESTION MODE` was transcribed from Nil's prose; the live wire sends plain `[SUGGESTION MODE:` so the check never fired in production. Fixed in batch F.
- what: "the final frame is often suggestion, but we have no way mechanically to know it's going to become a fork-only frame. i think we may want to make a one-off exception for this, and mark the latest frame as fork-only if it starts with *[SUGGESTION MODE*. I'm aware that this is brittle and can stop working if claude changes the format. i'm ok with that, as the downside is basically what we have now."
- where: engine fork-only classification (inLastView), frame view filtering
- expected: a frame whose content starts with the suggestion-mode marker is treated as fork-only immediately (not only after the next main-thread request reveals it wasn't in the view)
- evidence: TENSION WITH LOCKED DESIGN ("no content heuristics") — Nil explicitly authorizes a narrow one-off exception and accepts the brittleness (graceful degradation = today's behavior). Engine-touching → plan gate; decide exact mechanism with reviewer (classification at ingest vs display-layer-only marking; display-only would be a pure-UI alternative worth proposing — it avoids touching engine truth entirely)
- resolution: engine batch B: summarize() flips inLastView true→false for any captured turn frame whose first message's first text content (trimmed) starts with the literal `*[SUGGESTION MODE` — derived annotation only (no persistence, no reconcile/compose/membership change); marked in code as the engine's single authorized content heuristic. UI/CLI pick it up for free (F-006 hiding, forkFrames count). Regressions (fork-isolation.test.ts, 5): immediate marking, no-marker control, ANY-not-latest, exact scope (blocks + trim + mid-text negative), compose-unchanged oracle.

## F-046 — "revert last" belongs in the history tab, not the frames toolbar
- reported: 2026-06-10 · class: refinement
- status: fixed@19761d6 (batch 8; reviewer-signed 2026-06-10: no blocking findings, focused tests 29/29)
- confirmed: Nil confirmed live ("good").
- what: "the 'revert last' button seems a bit different than 'add frame' and 'combine'. is it about undoing the last operation in the history, rather than undoing the last frame? if so, i think it should go in the history tab, not this one."
- where: frames toolbar / history tab
- expected: ANSWERED: yes — revert undoes the last OPERATION (commit), not the last frame. Move the button to the history tab (next to the commit list it operates on), out of the frames toolbar
- evidence: pure UI placement; history already has per-commit revert
- resolution: in batch 8: button moved to the history sub-nav row (beside the commits|timeline toggle, next to the list it undoes); same registry verb, `{}` = HEAD, placement only; frames toolbar keeps add/combine (F-029). Regressions: history-view "F-046" (placement + POST wiring), op-menu placement asserts updated, app-render tooltip scan covers the history sub-nav, ui:smoke revert flow goes through the history tab.

## F-047 — Combine should offer the same insert-position menu as add
- reported: 2026-06-10 · class: refinement (engine + op surface)
- status: fixed@78c9cab (batch E; reviewer-signed 2026-06-11: one blocking CLI finding — `--after` with no value silently ran a default combine — fixed pre-commit with a subprocess parser harness, re-signed, focused 11/11; all gates green incl. live: demo/live-e2e/live-phase2 PASS, dual-client PASS on retry — first attempt was the documented marker-timeout flake)
- plan-gate GO 2026-06-10, reviewer adjustments all adopted: compose skips part-slot emission ONLY when the absorber has explicit placement; after may point at absorbed parts; ops.ts position() unchanged ('' → omit); combine panel renders its own dropdown with default label "at the first picked frame's place"
- implementation (batch E): engine combine(ids, {after}) validates like add (id exists / null = start), sets combined.placement, commit params record it; compose injects placed combined frames into the placement splice when a live part is a member (or the combined frame itself is — full-store mode; placement = ordering override, not membership creation, the move precedent), anchor-absence falls back like added frames, resolve() skips a placed absorber at part slots; revert pristine-check fixed (the combine's OWN placement is not downstream state — only a DIFFERING one blocks); route /control/combine passes after through; CLI: ctx combine <ids> [--after <id> | --start]; UI: combine panel position dropdown (default omits → engine default), resets with the mode, F-041 copy extended truthfully. Regressions: structural-ops F-047 ×4 (placement + once-only, start + absorbed-part anchor, bad-anchor refusal + byte-identical default, placed-combine revert), op-menu F-047 (dropdown labels, default {ids} only, start → null, id maps through, reset)
- what: "i want to add the same 'insert position' menu as the 'add frame' button" (on combine)
- where: combine op — engine placement, ops.ts param, control route, CLI flag, UI dropdown
- expected: combine accepts an optional position (default stays: first pick's slot)
- evidence: op-surface change → parity rail: ops.ts param + CLI flag + control route param in the SAME batch + plan gate; engine combine() placement support
- resolution: (next session) plan-gate with Context Reviewer first

## F-048 — Refresh button gives no feedback that anything happened
- reported: 2026-06-10 (Nil's "7.1") · class: refinement
- status: fixed@8d07063 (batch 9; reviewer-signed 2026-06-10: one finding — ✓ could flash on skipped/failed refetch — fixed pre-commit; focused tests 26/26)
- what: "the refresh button has no feedback when you click it that anything happened"
- where: topbar refresh button
- expected: clicking refresh visibly acknowledges the click (and ideally distinguishes "refetched, nothing new" from "refetched, updated")
- evidence: pure UI — loadConversation refetches silently; when nothing changed the render is identical, so a successful click is indistinguishable from a dead button
- resolution: in batch 9: clicking refresh flashes "✓ refreshed" for 1.2s once the re-fetch lands (the copy-button pattern); min-width keeps the topbar from shifting (F-012). Reviewer finding folded in: flash only on an actually-landed refetch (loadConversation returns success). Regression: app-render "F-048" success+failure legs; ui:smoke check.
- confirmed: Nil confirmed live ("good").

## F-049 — History view: commits and timeline should grow downward like the other views
- reported: 2026-06-10 (Nil's "7.2") · class: refinement
- status: fixed@8d07063 (batch 9; reviewer-signed 2026-06-10: one finding — ✓ could flash on skipped/failed refetch — fixed pre-commit; focused tests 26/26)
- what: "for history view, commits and timeline should grow downward, just like conversatino and frames views"
- where: history tab, both sub-views
- expected: chronological order — oldest at top, newest at bottom (matching conversation + frames); newest stays reachable, likely via open-scrolled-to-bottom + the discreet jump button (the F-020 pattern)
- evidence: pure UI — both lists deliberately render newest-first since 5c ("the op you just ran is the one you look for"); Nil's report supersedes that lean. Order is derived display state; commit/event truth unchanged
- resolution: in batch 9: commits + timeline render chronologically (oldest top, newest bottom); the scroller opens at the bottom and re-snaps on sub-view switch; discreet ↓ jump button (the F-020 pattern, mount-only, never fights user scrolling). Regressions: history-view order tests rewritten; ui:smoke order checks for both sub-views.
- confirmed: Nil confirmed live ("good").

## F-050 — "enriched" timeline entry indistinguishable; the UI drops the event's note
- reported: 2026-06-10 · class: bug
- status: fixed@8d07063 (batch 9; reviewer-signed 2026-06-10: one finding — ✓ could flash on skipped/failed refetch — fixed pre-commit; focused tests 26/26)
- what: "i don't know what 'enriched' means in this context. it looks like the others, afaict"
- where: history tab, timeline sub-view, event rows
- expected: the enriched event should explain itself — the engine RECORDS a note ("title+summary via claude-cli:claude-sonnet-4-6@low", per the F-001 plan: "audited not silent") and the route exposes it (batch-A live-check fix), but ui/src/history.ts eventRows() drops `note` and HistoryView never renders it — the view shows less than the API reports (same render-truth class as F-036)
- evidence: api.ts PublicEvent carries note; eventRows() maps id/type/frameIds/commitId/timestamp only
- resolution: in batch 9: event rows render the daemon's note (dim, beside the type); the enriched type carries a plain-language tooltip ("a title and summary were written for this frame automatically" — Nil adjusts live). Regressions: history.test.ts note mapping; history-view "F-050" (note rendered, tip jargon-free, non-enriched rows untouched).
- confirmed: Nil confirmed live ("good. i like the hover explanation. maybe do that for 'capture' too (the two subtypes)") — the capture-subtype tooltips fold into F-052 (they need the engine-side direction distinction).
- clarified (Nil, 2026-06-10): his original confusion was different — he expected enrichment to change how a CAPTURE entry looks and didn't spot that "enriched" is its own standalone row. Confusion resolved by the F-051 answer. The note-drop gap is still real (view < API); kept queued since rendering the note makes the row self-explanatory — Nil to confirm he still wants it

## F-051 — Question: why does a capture with p0 alternate after every frame / look duplicated? (answered)
- reported: 2026-06-10 · class: observation
- status: answered-in-chat
- what: "why is there a capture frame with the p0 frame alternative after every other frame? and why does it look like duplicate timeline entries?" (timeline excerpt e1–e29)
- expected: n/a — question; behavior is by design
- evidence: two engine capture sites: ingest (state.ts ~226, records all frames the request touched — p0 is in every request because the client RESENDS the full system prompt + tools each call, so reconcile refreshes it) and captureReply (state.ts 372, the turn frame alone). A turn with a tool loop = several request/reply pairs, all bundled into ONE turn frame (locked granularity) but each wire event logged (timeline = complete audit trail, 5c). So `capture [p0, tN]` = request arrived, `capture [tN]` = reply arrived; pairs repeat per tool round. Not duplicates.
- resolution: answered; if Nil wants friendlier rows (e.g. distinguishing request/reply captures, grouping a turn's tool rounds), labeling needs engine-side event detail → design-question + plan gate; say the word
- follow-up (Nil, 2026-06-10): "shouldn't they have different names then?" → spawned F-052

## F-052 — Request-arrival and reply-arrival events share the name "capture" — distinct names?
- reported: 2026-06-10 · class: design-question
- status: fixed@6c5072b (batch C; reviewer-signed 2026-06-11: no blocking findings, focused 58/58; all gates incl. live — demo/live-e2e/live-phase2 PASS under Nil's standing quota grant; reviewer nuance recorded: CLI legacy rows semantically unchanged but type-column spacing widened 8→15, not byte-identical — UI legacy IS pinned unchanged)
- what: "Two different things get logged as capture ... shouldn't they have different names then?"
- where: engine event types (state.ts recordEvent), /control/timeline, CLI timeline, UI timeline rows
- expected: TBD by Nil — event type vocabulary is engine truth (persisted in the store, shared by CLI and UI), so this is not a display-only rename
- evidence: ingest-side capture (state.ts ~226: all frames the request touched) vs reply-side capture (state.ts 372: the turn frame alone) are genuinely different moments sharing one type string
- resolution: options: (a) split the TYPE at record time (e.g. "request" / "reply", or keep "capture" + new "reply") — cleanest vocabulary but old stores carry legacy "capture" events forever, and every consumer (CLI, UI, tests) updates; (b) ADDITIVE detail field on the event (e.g. direction: request|reply) — old events simply lack it, store stays compatible, UI/CLI render friendlier labels from it; (c) leave engine as-is, UI infers from event shape (p0-in-frameIds heuristic) — rejected lean: brittle content-shape inference in the display layer. Lean (b). Nil picks; plan gate before any implementation
- decided (Nil, 2026-06-10): option (b). Methodology note from Nil: no backward-compat concerns at this point (test data only, no user data) — recorded; (b) stays the pick (his "two subtypes" framing matches it). Scope: engine direction on capture events + route exposure + CLI timeline display + UI subtype labels AND plain-language hover tooltips for both (his F-050 follow-up). Plan-gate GO 2026-06-10 (reviewer: capture-only field, mapper regression per the F-050 lesson, CLI display-only, legacy renders unchanged, dual-client NOT required).
- confirmed: Nil confirmed live 2026-06-11 ("looks good" — request/reply labels + tooltips on new captures e30+; noted p0 still riding request captures, which is expected until F-053 lands).
- implementation (batch C): ContextEvent.direction ('request'|'reply', capture-only, additive); ingest records request, captureAssistant records reply; publicEvent mapper exposes it; ctx timeline shows capture:request|capture:reply; UI renders a dim subtype label beside the type + per-subtype plain tooltips (request: "the app sent the conversation to the model — anything new or changed is recorded here"; reply: "the model's answer arrived and was added to the frame"); legacy events (no direction) render exactly as before. Regressions: versioning "F-052" (engine: request/reply/ops-none + restart durability), enrich proxy test (mapper), history.test.ts mapping, history-view "F-052" (labels, distinct jargon-free tips, legacy leg).

## F-053 — p0 "grows" on every request: a volatile billing line in the resent system prompt
- reported: 2026-06-10 (found while answering Nil's F-051 follow-up) · class: design-question
- status: fixed@952748c (batch D; reviewer-signed 2026-06-11: no blocking findings, focused 23/23; live waived — detection-only)
- confirmed: Nil confirmed live 2026-06-11 ("confirmed" — his store shows e32 pre-restart with p0 riding the request capture vs e35/e36 post-restart with p0 gone: capture request t11 / reply t11 / enriched, clean).
- plan-gate boundaries (GO 2026-06-10): preamble signature ONLY — never turn frames/stored content/compose/tokens; exact line-prefix after line split; stored p0 stays byte-faithful incl. the volatile line; real head changes still audit; comment as Nil-authorized brittle exception #2; extra required test: after a cch-only resend, show(p0) reflects the NEWER header while NO capture event was recorded; live gates waived, no dual-client
- implementation (batch D): stripVolatileHeaderLines() drops lines starting with the exact literal `x-anthropic-billing-header:` (string + block-array system forms) inside contentSig's PREAMBLE branch only. Regressions (versioning.test.ts, 5): cch-only rotation → no event + p0 stores the NEWER line (reviewer's required assert); real system edit still audits p0; turn growth lists the turn frame not p0; mid-line mention still counts; block-array form normalizes identically
- what: every request's capture event lists p0 — investigation showed the engine rule is "created or content-changed only", so p0 appearing every time means its content really changes every request
- where: engine ingest (preamble refresh + grown detection); visible as timeline noise (F-051)
- expected: TBD by Nil
- evidence: wiretap (conv c3, all 16 requests): tools hash IDENTICAL across requests; system hash DIFFERENT on every request; unified diff between consecutive requests = exactly one line, an "x-anthropic-billing-header: ... cch=XXXXX" line embedded in the system text whose cch value rotates per request. Consequences: (1) p0 rides every request capture event, (2) the "no change -> no event" suppression never fires in practice for CC sessions, (3) p0's stored content churns each ingest.
- resolution: parked — any fix means ignoring/normalizing specific content (a content heuristic, LOCKED by design; would need Nil's explicit one-off exception like F-045). Options if revisited: (a) keep as-is (the timeline tells the truth: the head really does change); (b) Nil-authorized exception: exclude volatile telemetry line(s) from the preamble content signature so "grown" means meaningful growth (signature-only — stored content stays faithful); (c) broader normalization — rejected lean, heuristic creep
- mechanism confirmed by CC Expert (office agent, 2026-06-10): constants/system.ts getAttributionHeader() builds the line with a cch=00000 placeholder; utils/api.ts splitSysPromptPrefix() makes it the FIRST system block (cacheScope null); Bun's native HTTP stack overwrites the placeholder in the serialized body with a per-request ATTESTATION token before send (proves the request came from a real CC client) — hence the per-request rotation seen on the wire.
- expectation corrected (told to Nil): this saves NO tokens and no wire I/O — the proxy forwards faithfully, the attestation line still rides upstream (it must; it's the client's attestation), API cost unchanged. What it saves: timeline noise (p0 off every routine capture event), marginal store-write size, and user confusion. A clarity fix, not a cost fix.
- proposal (2026-06-10, after Nil's workaround request): option (b), SIGNATURE-ONLY — the preamble's change-detection signature ignores lines starting with the literal `x-anthropic-billing-header:`; stored content + the wire stay byte-faithful (the latest line still rides; compose untouched); only "did the head meaningfully change" stops counting it. Second narrow authorized content heuristic, same brittleness contract as F-045 (header renamed → degrades to today's noise). Rejected: dropping preamble from grown-detection entirely (real system/tool changes would go unaudited). Precedent: conversation identity hit this same line and was fixed structurally (opening-turn fingerprint) — no structural fix exists here because change-detection must read content. Awaiting Nil's go → plan gate → implement


## F-054 — CC side-call conversations (title generation, probes) clutter the conversation switcher
- reported: 2026-06-11 · class: design-question
- status: closed — keep as-is (Nil 2026-06-11, after the mechanism was explained: "ok that makes sense, fine with me"); reopen if the clutter bothers him later
- what: "i think i found a bug: context composer created 2 sessions... [c4] only has my first message... then it seems like it continued in a different session? [c5]"
- where: conversation switcher; convs c4 (also c1, c2 — same species)
- expected: NOT a bug — wiretap-verified: c4 is Claude Code's own session-TITLE generator (system prompt: "Generate a concise, sentence-case title (3-7 words)..."; 1 message wrapped in <session> tags; fired 23ms after c5's real first request; reply = {"title": ...}). A genuinely separate API conversation → own opening fingerprint → own conversation. Faithful capture; the UX is the question
- evidence: wiretap c4: sysbytes 1334 vs c5's 7592, msgs=1, ts 09:09:33.617 vs c5 09:09:33.594; existing `suspicious` flag does NOT cover this (it only marks new-conversation-with-history)
- resolution: parked; options: (a) keep as-is — the switcher tells the truth; (b) display-layer: de-emphasize/group 1-turn stale conversations in the switcher ("side calls (N)"), no engine change but shape-inference lives in the UI; (c) engine classification by content (title-gen system-prompt prefix) — would be brittle exception #3, needs Nil's explicit authorization like F-045/F-053; (d) conversation-level hide/archive op — new op surface, parity batch + plan gate. Side note recorded: ingest enrichment also auto-titled c4's lone frame (one wasted sonnet@low call per side-call) — any classification chosen could also gate enrichment


## F-055 — F-045's marker literal never matched live content (leading `*` from prose, wire sends plain `[SUGGESTION MODE:`)
- reported: 2026-06-11 · class: bug
- status: fixed@299679b (batch F; reviewer-signed 2026-06-11: no blocking findings, focused 11/11; asterisk-strip accepted as within the F-045 exception; live waived — annotation-only)
- what: "the last frame is a suggestion mode frame but it is not marked as fork-only"
- where: conv c5, frame t6 (live store evidence: t6 first-40 chars = `[SUGGESTION MODE: Suggest what the user` with inLastView true; t2 false only via the OLD late path)
- expected: F-045 marks it fork-only immediately
- evidence: SUGGESTION_MARKER was `*[SUGGESTION MODE` — taken verbatim from Nil's original report phrasing ("starts with *[SUGGESTION MODE*"); the asterisks were emphasis/markdown, not wire content. Both live sightings (ba5a t6, c5 t2/t6) start with the plain bracket
- resolution: batch F: marker literal corrected to `[SUGGESTION MODE`; matching now also strips optional LEADING asterisks after the whitespace trim (covers markdown-italic-wrapped variants; nothing wider — still an exact prefix check). Regression: fork-isolation "F-055" pins the exact live form verbatim + the italic variant. Lesson recorded: marker literals come from the WIRE (wiretap/store), never from prose


## F-056 — Pending op form (e.g. add frame) should close when navigating away, not carry over
- reported: 2026-06-11 (Nil's "9.1") · class: refinement
- status: fixed@batch-10 (reviewer-signed 2026-06-11: no blocking findings, focused 25/25)
- what: "'add frame' menu should close automatically when navigating away from 'frames' view. not carry over."
- where: any pending op form + view switching
- expected: navigating to another view closes the pending form
- evidence: pure UI — the old F-008/F-029 design carried pending forms to a top host on other views ("never invisible"); Nil's report supersedes that lean for view switches. The top host still serves same-view fallbacks (F-006 hiding the form's card)
- resolution: in batch 10: switchView clears the pending op form; coming back does not resurrect it. Regression: op-menu placement test rewritten (form gone after switch, both directions).

## F-057 — Page reload snaps back to the "active" conversation instead of the one being viewed
- reported: 2026-06-11 (Nil's "9.2") · class: refinement
- status: fixed@batch-10 (reviewer-signed 2026-06-11: no blocking findings, focused 25/25)
- what: "why does context composer go back to session c3 when i reload the page? that's annoying"
- where: conversation switcher / initial load
- expected: reload reopens the conversation you were on
- evidence: pure UI — the default pick is the engine's "active" ranking (most total turn frames → c3); the UI never remembered the selection. Engine ranking untouched (CLI default targeting keeps its semantics)
- resolution: in batch 10: the UI stores the loaded conversation id (localStorage, single data path writes it) and the initial load passes it back; stale/unknown stored ids fall through to the active default; storage failures degrade silently. Regression: app-render "F-057" (record on switch, reopen on fresh mount, stale-id fallback).

## UX-note — restart-reset of view annotations bit twice (no F-number, recorded for context)
- 2026-06-11: after a daemon restart, inLastView resets to null until the next request re-establishes a view (by design — views are derived per request, never persisted; pinned since Phase 2.7). Surfaced as Nil's "show fork-only frames button does not even appear now, regression?" — not a regression; the toggle renders only when fork-only frames exist. If this keeps confusing, candidate refinement: an empty-state hint in the frames view after restart ("frame roles appear after the next message"). Not building unprompted.


## F-058 — "Active" conversation ranking contradicts intuition ("the active one is c5, that's who i'm talking to")
- reported: 2026-06-11 · class: design-question
- status: awaiting Nil's pick (then plan gate — engine ranking + CLI default targeting)
- what: "what does active even mean? the active one is c5, that's who im talking to in claude now. if active is meaningless, just remove that concept i guess?"
- where: engine registry "active" ranking (most TOTAL turn frames incl. tombstones → live tokens → recency); consumed by CLI default targeting (every store-scoped verb without --conv) and the switcher's "· active" badge
- expected: TBD by Nil — to him active should mean "the conversation I'm talking to right now"
- evidence: c3 (11 turns, idle) outranks c5 (his live session). The turns-first ranking exists for a reason (P1 fix: deleting frames must never demote the active conversation — live-frame counting caused exactly that), but turns-first makes long-idle conversations sticky
- resolution: options: (a) REDEFINE active = most recent ingest (lastIngestAt), tombstone-safe by construction (deletes don't touch ingest time) — matches intuition; small race: a session's title side-call ingests ms before the real first turn, self-heals on the first reply capture; (b) REMOVE the concept — CLI would always require --conv (worse for the terminal-scalpel flow), F-057 already freed the UI from it; (c) keep as-is. My lean: (a). Engine+CLI semantics → Nil picks, then plan gate
- decided (Nil, 2026-06-11): option (a) — redefine active = most recent ingest. Plan-gate next

## F-059 — Should refresh re-establish view annotations after a daemon restart?
- reported: 2026-06-11 · class: design-question
- status: awaiting Nil's pick (touches a LOCKED decision — views derived per request, never persisted)
- what: "it works, but confusing..? i feel like the refresh button should also trigger this annotation, or does that break the flow?"
- where: inLastView after daemon restart; refresh button
- expected: TBD by Nil
- evidence: refresh CAN'T recompute it today: "which frames rode the last wire request" lives only in RAM — locked out of persistence to protect fork isolation (Phase 2.7/3a). The annotation genuinely returns on the next request. BUT: persisting the last view's frame-id list as DISPLAY-ONLY metadata would not touch emission (compose keeps deriving views per request) — fork isolation stays intact; it is still a locked-decision amendment
- resolution: options: (a) keep — annotations return on the next turn (zero risk); (b) persist lastEmittedView as display-only metadata so restarts don't blank annotations (engine+store change, plan gate; compose untouched — explicitly NOT used for emission); (c) pure-UI empty-state hint after restart ("frame roles appear after the next message"). Nil picks; (b) needs a plan gate
- decided (Nil, 2026-06-11): option (c) — empty-state hint. In batch 11


## F-060 — Edit form should be prefilled with the frame's current content
- reported: 2026-06-11 (Nil's "10.1") · class: refinement
- status: triaged (batch 11)
- what: "the edit menu should be pre-filled with the current content."
- where: edit op form
- evidence: pure UI (prefill.ts, the F-003 pattern). Care: --text replaces the frame's emission with ONE message — prefill must be faithful-on-unchanged-submit. Single text-bearing-message emissions prefill verbatim; multi-message emissions get no text prefill (a flattened prefill would silently restructure on submit)
- resolution: (batch 11)

## F-061 — Compact form is confusing; should work like offload (prefilled editable summary)
- reported: 2026-06-11 (Nil's "10.2") · class: refinement
- status: triaged (batch 11, UI side; param-surface change only if Nil asks after)
- what: "I don't understand the compact menu. What is 'summary text'? what does 'regen (LLM)' do? (tooltip would be good.) What happens if you use both? How is 'summary text' different than just 'edit'? ... maybe: the LLM summary is generated automatically, and optionally the user can edit it. Note: the offloading op does this correctly."
- evidence: pure-UI fix available: prefill compact's text with the same chain offload uses (frame auto-summary ?? deterministic derive) + plain tooltips (text wins over regen when both; regen = the model writes it server-side at op time)
- resolution: (batch 11)

## F-062 — Enrichment produced wrong metadata for t15 (fallback title on a real question) — enriches too early
- reported: 2026-06-11 (Nil's "10.3") · class: bug
- status: diagnosed — fix needs a plan gate (engine enrich policy)
- what: "t15: a non-fork-only frame where I asked 'can yu tell me about the incident where you got the math wrong?' but the summary ... is 'Boilerplate system prompt and environment context only; no real user request was made in this turn.' Is this a bug?"
- evidence: DIAGNOSED 2026-06-11: t15's CURRENT content rebuilds into a clean 1.6KB prompt (question first, no truncation), and a controlled sonnet@low call on that exact prompt returns perfect metadata ("Incident where math error went uncorrected"). So the live enrichment saw DIFFERENT content: enrichment fires at FIRST capture and applies first-wins (title-still-placeholder check), but frames grow/refresh afterward (tool loops; ephemeral reminder blocks replaced on resend). t15's enrich-time content was evidently volatile boilerplate
- resolution: fix direction (plan-gate): re-enrich when an auto-enriched frame's content has materially changed (the engine already computes "grown") — e.g. once at reply-capture settle; manual retitles still win (existing race rule); quota note: bounded re-runs, not per-ingest
- ALSO root-causes the long-standing "background context" titles on other frames (t2, t6 — suggestion frames enriched from partial content)

## F-063 — Position dropdowns offer destinations that can only refuse (deleted frames; fork-only questionable)
- reported: 2026-06-11 (Nil's "10.4") · class: refinement
- status: triaged (batch 11)
- what: "trying to move a frame after a deleted frame fails. that's ok, but maybe it shouldn't be an option ... i think fork-only frames should be excluded as well"
- evidence: pure UI — the shared position dropdown lists every loaded frame. RAIL NOTE: ops are never hidden by frame state (guards speak), but this filters a DESTINATION list, not an op; same distinction as F-006 (card visibility ≠ op availability). Refusals still render verbatim for anything else invalid
- resolution: (batch 11) filter deleted + fork-only frames from position options (add/move/combine)

## F-064 — Split: confusing form; children appear at the end with placeholder titles; original remains visible
- reported: 2026-06-11 (Nil's "10.5") · class: design-question (display + engine metadata)
- status: parked-for-Nil — options below, needs his picks
- what: "split menu is confusing ... needs more hand holding. also, the two frames resulting from split appear at the end of the convo, instead of where the previous frame was. and the previous frame still exists, leading to duplication. more reasonable would be to split in place, old one disappears. also, the new ones should carry over the title and summary, edited to show that it's been split (like 'part 1/2')."
- evidence: the WIRE is already right (children emit AT the original's slot via resolution; the original emits nothing — pinned by structural-ops tests). What Nil sees is the FRAME VIEW, which lists STORE order: children are new frames (appended), the split original remains as the match target (flagged). Same presentation applies to combine parts. Children get placeholder titles because enrichment is live-ingest-only and split is an op
- resolution: options: (1) DISPLAY — frame view hides structurally-hidden frames (absorbed parts / split originals) by default behind the existing-style toggle, and/or orders cards by emission order; (2) ENGINE metadata — split() derives children titles/summaries deterministically from the original ("<title> (part 1/2)", summary carried), no LLM; cheap, plan-gated; (3) FORM — hand-holding copy: show the frame's messages with indices so "--at" is pickable rather than guessed (bigger form work). Nil picks any/all
- note: t18-era complaint "frame t18, no summary" = (2)

## F-065 — Compact vs summarize: difference unclear
- reported: 2026-06-11 (Nil's "10.6") · class: refinement
- status: triaged (batch 11)
- what: "what is the difference between compact and summarize?"
- evidence: compact CHANGES WHAT THE MODEL SEES (replaces the frame's emission with a summary — representation override); summarize only rewrites the CARD's description (display metadata, never emitted). Pure-UI copy/tooltips
- resolution: (batch 11) tooltips/labels state the split plainly: compact = "shrink what the model sees"; summarize = "rewrite this card's description (display only)"

## F-066 — Retitle (and forms generally) should prefill current values
- reported: 2026-06-11 (Nil's "10.7") · class: refinement
- status: triaged (batch 11)
- what: "retitle menu should be prefilled with current title and summary. that's as a general principle, a fully empty field is not usually the most convenient starting point."
- evidence: pure UI (prefill.ts); recorded as a STANDING PRINCIPLE for future forms
- resolution: (batch 11) retitle prefills title + summary from the frame


## F-067 — Summarize/retitle shouldn't look like frame operations — make title/summary editable in the details panel
- reported: 2026-06-11 · class: design-question (UI surface reshape; Nil leaning yes)
- status: awaiting Nil's confirm, then implement (likely replaces the F-065/F-066 copy/prefill work — do NOT do both)
- what: "summarize and retitle shouldn't *look* like frame operations if they just modify metadata. We could just make the title and summary fields editable in the frame side panel"
- where: details panel + per-frame ops menu
- evidence: parity rail is SAFE: inline editing dispatches the SAME registry verbs (retitle/summarize) to the SAME routes — a different entry point, not a new op (the F-013 feasibility argument). Open sub-questions: (a) do retitle/summarize leave the ops menu once inline editing exists, or stay in both? (b) where do the regen-(LLM) variants live — small "regenerate" buttons beside the fields? (c) commits still record per change (each inline save = one retitle/summarize commit)
- resolution: on Nil's confirm: details panel title + summary become editable-in-place (save dispatches the registry verb; refusals verbatim as always); regen buttons beside fields; ops menu entries dropped per his (a) answer. INTERACTION: F-065's tooltip copy and F-066's retitle prefill are superseded by this if confirmed — sequence the decision BEFORE batch 11's copy work on those two items
