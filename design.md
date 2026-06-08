# Context Composer — Design Document

*Semantic Frame Context Management System*

> Status: design draft. Background material: [`raw_transcript.md`](./raw_transcript.md).

---

## 1. Summary

**Context Composer** reimagines LLM context as a sequence of composable **semantic
frames** rather than a flat, append-only token stream. Instead of accepting whatever
accumulates in the window during a conversation, the user (or an agent) can
**surgically manipulate** that context: delete tangents, compact stale turns, strip
noisy tool output, combine related turns, branch, and offload to external memory —
all while a real LLM keeps running the conversation against the mutated state.

Three properties define the system:

1. **Frames** — the context is segmented into semantic units you can address and operate on.
2. **A rich operation toolkit** — not just "compact the whole thing," but a broad set of targeted operations on individual frames or groups.
3. **Git-style versioning** — every operation is a commit; full history, rollback, and branching apply to *context itself*.

The deliverable is a **portfolio demo** that makes the paradigm tangible and starts a
conversation about context architecture. Practicality matters only insofar as the
mechanism is *theoretically grounded* (see [§9](#9-provider-assumptions--constraints)).

### 1.1 Positioning (the one-line identity)

The core, differentiating idea is **live, in-conversation, model-unaware surgery on
the active working window at the turn/frame level.** The running model never sees the
operations — only the resulting context. This is context engineering performed
*during* a task on the *live* window, distinct from tools that assemble and version a
persistent knowledge/memory base *before/around* a task.

---

## 2. Core Concepts

### 2.1 Frame

A **frame** is a semantic unit of conversation — the addressable object the whole
system operates on.

- **Default extraction:** each user turn and its corresponding assistant turn form a
  frame. **All of the assistant turn's tool calls and their results are bundled into
  the same frame** — tool calls are *not* their own frames.
  *(Rationale: splitting on tool-call boundaries produces meaningless fragments — e.g.
  a 3-word "and now let me check this repo" frame wedged between two tool calls.
  Keeping the assistant turn whole keeps frames semantically coherent. Nesting
  frames-within-frames is rejected: the model is **flattened**.)*
- **Granularity is a starting point, not a commitment.** Rather than trying to get
  boundaries perfect upfront, the system gives you operations (`combine`, `split`) to
  reshape frames after the fact. This is the central design bet.
- Each frame carries: an **auto-generated title**, an **auto-generated summary** (for
  scanning in frame view), the **full text**, and metadata (see [§7](#7-data-model)).
- **Sub-agent calls** are treated exactly like tool calls: the assistant invokes a
  sub-agent, gets a result back within its turn, and it all stays in the same frame.
  Sub-agents are *not* separate conversation trees.
- **Large pasted blobs are not auto-split.** A big file pasted into a turn stays inside
  that turn's frame; the user reshapes it on demand with `split` or `offload`. This
  keeps extraction dumb-and-simple and is consistent with the reshape-after-the-fact bet
  above — no size heuristics at creation time.
- **The system prompt is itself a frame** — a pinned **system frame**. See
  [§2.7](#27-the-system-frame).

### 2.2 Operation

An **operation** is a transformation applied to one or more frames (or to the branch
structure). Operations are the heart of the product — see the exhaustive catalog in
[§5](#5-operation-catalog-the-core).

### 2.3 Git-style versioning

Every mutating operation is a **commit**. The system keeps the full revision history
of the context, enabling rollback to any prior state, branching from any point, and
cherry-picking frames across branches and conversations. Context is treated like a
Git repository whose "files" are frames.

### 2.4 Branching

Context can fork into a tree of branches from any frame. Two semantics are supported,
chosen per operation:

- **Shared-ancestor frames** — an operation on a shared frame ripples forward to all
  descendant branches.
- **Isolated frames** — branch-specific; changes don't affect other branches.

So when you operate on a past frame, **you choose per operation** whether the change
ripples forward to descendant branches.

Two related scope boundaries:
- **No git-style branch merge.** Combining two *frames* is
  [`combine`](#5b-structural-operations); combining two *branch histories* is out of
  scope (see [future work](#10-future-work)).
- **Cross-branch combination is only via explicit `import`** — see
  [§5.F](#5f-composition--runtime). Branches are isolated timelines; `import`
  (cherry-pick) is the single bridge between them.

### 2.5 External memory

Frames are **always persisted durably** the moment they're created (for session
resume — same as Isomux saving every message). Separately, an explicit **offload**
operation swaps a frame's full text *in the active context* for a **summary + file
reference**, freeing window space while keeping the content reachable on demand. The
data already exists in storage; offload only changes how the frame is *represented* in
the working context.

**Retrieval needs no special mechanism.** The offload stub carries the
file path, and — assuming the agent has a file-read tool ([§9](#9-provider-assumptions--constraints)) —
the model simply **reads the file** when it needs the content; no custom fetch tool, no
heuristic intent-detection. When it does, the content re-enters the conversation as a
normal **file-read tool-result frame**, which is itself a fully manageable frame (you
can re-`offload`/`compact` it). A user-facing `restore` exists only as a convenience for
putting content back inline without a model round-trip.

### 2.6 The model is unaware (key principle)

When the user performs an operation, the **running LLM does not see the operation** —
it only ever sees the resulting mutated context. From the model's perspective, the
context simply *is* whatever it now is. The operation history is **metadata for the
user, not signal for the model.** ("We're doing surgery on its brain; it doesn't know
what's going on.")

### 2.7 The system frame

The non-conversational scaffolding at the head of the context — the
base system prompt, tool definitions, and project instructions — is represented as a
single **pinned system frame** at the top of the frame view, **fully part of the model
context** and operable like any other frame. In particular you can `compact` or
`offload` it to reclaim tokens; `delete` is guarded (allowed but warned, since it strips
the model's scaffolding).

This makes the paradigm fully visible — *the whole context is frames, even the parts
you didn't write* — and yields a strong demo beat: offloading the system frame to show
live token reclamation. (Assumes the system prompt is composable by the harness, not a
fixed opaque preamble — see [§9](#9-provider-assumptions--constraints).)

---

## 3. Architecture: CLI-first, UI as a thin wrapper

The **CLI is the core API**; the UI is a wrapper that calls the same commands. This
keeps logic decoupled from presentation, makes every operation scriptable and
testable independently, and means the UI can never do something the CLI can't.

```
┌──────────────────────────────┐      ┌──────────────────────────────┐
│            UI                │      │       External scripts        │
│  (conversation ⇄ frame view) │      │      / agents / tests         │
└───────────────┬──────────────┘      └───────────────┬──────────────┘
                │  invokes                              │  invokes
                ▼                                       ▼
        ┌───────────────────────────────────────────────────┐
        │            ctx CLI  (core operation API)           │
        │  list · show · add · delete · combine · split     │
        │  edit · compact · strip · summarize · offload     │
        │  restore · import · branch · checkout · revert    │
        │  tag · history · diff · status · compose · send    │
        └───────────────────────┬───────────────────────────┘
                                 ▼
        ┌───────────────────────────────────────────────────┐
        │  Engine: frame store · commit graph · composer     │
        └───────────────────────┬───────────────────────────┘
                                 ▼
        ┌──────────────────────┐   ┌──────────────────────────┐
        │  Durable frame store  │   │  LLM / agent runtime     │
        │  + external memory    │   │  (see §9 assumptions)    │
        └──────────────────────┘   └──────────────────────────┘
```

Each CLI command emits JSON (machine-readable for the UI/scripts) or plain text.

> **Implementation note (not design surface):** the reference prototype realizes the
> backend by wrapping an existing coding agent — Claude Code, driven via its SDK. It
> manages the message history the agent sees and reuses the agent's **native
> facilities** rather than reimplementing them: tools, sub-agents (its Task tool),
> permissions, and the file-read tool that powers offload retrieval
> ([§5.D](#5d-memory-operations)). This is an implementation choice, not part of the
> design — any runtime satisfying the assumptions in
> [§9](#9-provider-assumptions--constraints) would work.

---

## 4. Two views

A single conversation is presented through two interchangeable views, toggled at any time.

- **Conversation view** — standard ChatGPT-style chat. This is where you *talk to the
  model*. Questions the model asks, tool calls, etc., pass through as plain text/turns
  (no special permission or question widgets — see [§9](#9-provider-assumptions--constraints)).
- **Frame view** — the manipulation surface. Frames are shown as a **Git-style tree**:
  nodes are frame states (title + summary), edges are the operations that transformed
  them. You expand a node for full text, right-click for the operation menu, drag to
  branch. A side panel shows the operation/commit history and filters by type.

---

## 5. Operation Catalog (the core)

This is the exhaustive list of operations. They fall into six groups:

- **A. Read / navigation** — non-mutating; no commit.
- **B. Structural** — change the *set/order* of frames; each is a commit.
- **C. Content** — change a frame's *contents*; each is a commit.
- **D. Memory** — move content between active context and external storage.
- **E. Version control** — operate on the commit graph / branches.
- **F. Composition / runtime** — assemble and send context to the model.

> **Commit rule:** every operation in groups B, C, D (and the structural VC ops in E)
> produces a commit `{ id, type, affectedFrameIds, params, timestamp, note }`.
> Group A produces none. Composition ([§5.F](#5f-composition--runtime)) is
> non-mutating to history but determines what the model receives.

### Quick reference

| Op | Group | One-liner |
|---|---|---|
| `list` | A | List frames in the current state |
| `show` | A | Show a frame's full content |
| `history` | A | Show the commit log |
| `diff` | A | Compare two frames/commits/branches |
| `status` | A | Active branch, HEAD, pending state |
| `add` | B | Create a new frame manually |
| `delete` | B | Remove a frame from active context |
| `combine` | B | Merge ≥2 frames into one |
| `split` | B | Split one frame into several |
| `move` | B | Reorder a frame in the sequence |
| `import` | B | Cherry-pick a frame from another branch/conversation |
| `edit` | C | Manually replace a frame's text |
| `compact` | C | LLM-summarize a whole frame to cut tokens |
| `strip` | C | Remove specific tool-call results inside a frame |
| `summarize` | C | LLM-summarize tool results / sub-parts inside a frame |
| `retitle` | C | (Re)generate or set a frame's title/summary |
| `offload` | D | Swap full text for summary + file reference |
| `restore` | D | Re-inject an offloaded frame's full text |
| `branch` | E | Create a branch from a frame/commit |
| `checkout` | E | Move HEAD to a branch or commit |
| `revert` | E | Roll back to a previous commit |
| `tag` | E | Name a checkpoint state (optional) |
| `compose` | F | Build the exact context payload for the next call |
| `send` | F | Run the next model turn against composed context |

---

### 5.A Read / navigation (non-mutating)

**`list`** — List all frames in the current branch state, with index, id, title, token
estimate, and flags (offloaded?, edited?, compacted?). The scan view for frame mode.

**`show <frame>`** — Display a single frame's full text, summary, and metadata
(linked tool calls, file reference if offloaded, provenance).

**`history [--frame <id>] [--type <op>]`** — Show the commit log: every operation,
its type, affected frames, timestamp, note. Filterable by frame or operation type.

**`diff <a> <b>`** — Compare two states: two commits, two branches, or a frame before
and after an operation. Powers the side-by-side previews in frame view.

**`status`** — Current branch, HEAD commit, current frame position, count of
offloaded frames, and any uncommitted/pending changes.

---

### 5.B Structural operations

**`add [--text <t>] [--at <pos>]`** — Manually create a new frame, either from pasted
text or empty for editing. Use cases: inject an instruction/note, seed context, or
paste content the conversation didn't produce.

**`delete <frame...>`** — Remove one or more frames from the active context. The
canonical use case: prune a tangent so the model stops attending to noise. The frame
remains in durable storage and history (recoverable via `revert`); it's just no longer
in the composed window.

**`combine <frame...> [--summarize]`** — Merge multiple frames into a single frame.
Canonical use case: collapse five iterations of a code file into one "previous
attempts" frame (optionally `--summarize` to compact while merging). Reduces
fragmentation and the model's burden of tracking which version is current.

**`split <frame> --at <marker|index>`** — Split one frame into several. The inverse of
`combine`; lets you separate out a sub-part you want to manipulate independently
(e.g., peel a distinct topic off a long turn).

**`move <frame> --to <pos>`** — Reorder a frame within the sequence ("rearrange
blocks"). Note the caching cost (see [§9](#9-provider-assumptions--constraints)):
moving early frames invalidates the tail.

**`import <source> <frame...>`** — Cherry-pick frames from **another conversation or
branch** into the current branch. The Git analogy made literal: cross-repo cherry-pick
for context. Source can be another session, a sub-agent branch, or a search across all
conversations.

---

### 5.C Content operations

**`edit <frame> [--text <t>]`** — Manually replace or modify a frame's text, giving
the user full authorship over what the model sees. Tracked as an `edit` commit.
*Semantics:* editing keeps `createdAt` **immutable** (it marks when the
frame entered the conversation — relevant to ordering and caching) and bumps
`modifiedAt`; it is **non-destructive downstream** — later frames are not regenerated,
only what the next `compose`/`send` uses changes (the cache cost is paid at next
`send`). Diffs render as a standard text diff (`fullText` before vs after) in the
history panel. *(UX nudge: prefer editing recent frames — see
[§9](#9-provider-assumptions--constraints).)*

**`compact <frame>`** — Use the LLM to **summarize an entire frame** down to its
essence ("user asked X, assistant explained Y") while preserving its semantic
contribution. This is *frame-level compaction* — the key insight that compaction
should be granular and targeted, not an all-or-nothing operation on the whole window.

**`strip <frame> [--result <id...>|--all-results]`** — Remove specific tool-call
**results** inside a frame without deleting the frame. Canonical use case: an assistant
turn made three API calls with long outputs; keep the reasoning, drop the raw output
bloat.

**`summarize <frame> [--results|--range ...]`** — LLM-summarize a *part* of a frame
(e.g., compress long tool results in place) rather than the whole frame. The
finer-grained sibling of `compact`/`strip`.

**`retitle <frame> [--title <t>] [--summary <s>] [--regen]`** — Set or regenerate a
frame's title/summary. Titles/summaries are auto-generated on creation; this lets the
user correct them or refresh after edits.

> **Why so many content ops?** There isn't a single `compact` primitive — there's a
> *rich toolkit* for reshaping the part of the context you care about. `compact`,
> `strip`, `summarize`, `edit`, `combine`, `split` are all facets of "reshape this
> region of context to be exactly as useful as it needs to be."

---

### 5.D Memory operations

**`offload <frame>`** — Replace a frame's full text *in the active context* with a
**reference**: a short note ("here was a chunk where the user discussed X — summary:
…; full content in `frames/<id>.md`") plus the file path. Frees window tokens while
keeping content reachable. *(The frame's data is already persisted; offload only
changes its representation in the working context. It is opt-in / on-demand, not
automatic.)* The model retrieves it on demand by **reading the file with its file-read
tool** — the stub gives it the path. No custom fetch tool, no intent-guessing.

**`restore <frame>`** — Re-inject a previously offloaded frame's full text inline. This
is a **user convenience only**; the *model* doesn't need it, since it can just read the
offloaded file directly. Note that when the model reads an offloaded file, the content
re-enters the conversation as a normal **file-read tool-result frame** — itself a fully
manageable frame you can re-`offload`/`compact`.

**`persist` (automatic, not a user command)** — Every frame is written to durable
storage on creation, so a user can close the tab and resume later. This underpins
both session resume and the offload/restore mechanism (offload is cheap precisely
because the data is already saved).

---

### 5.E Version-control operations

**`commit` (implicit)** — Every mutating operation records a commit
`{ id, type, affectedFrameIds, params, timestamp, note }`. There is no separate manual
commit step in the default flow; the operation *is* the commit.

**`branch <name> [--from <frame|commit>]`** — Fork a new branch from any frame or
commit. Use cases: explore an alternative direction while keeping the original intact;
test prompt/strategy variations side by side.

**`checkout <branch|commit>`** — Move HEAD to a branch or a past commit, switching the
active context to that state.

> **No branch `merge` (out of scope).** Git-style branch merging — combining two
> *histories* with conflict resolution when shared-ancestor frames diverge — is
> deferred to [future work](#10-future-work). Merging two *frames* is
> [`combine`](#5b-structural-operations); pulling frames across branches is
> [`import`](#5b-structural-operations).

**`revert <commit>`** — Roll the active context back to a previous commit state.
Nothing is lost — you can move forward again or branch from the reverted point.

**`tag <name> [--at <commit>]`** *(optional)* — Name a checkpoint for easy reference
("good-baseline", "pre-refactor").

---

### 5.F Composition / runtime

**`compose [--branch <b>]`** — Build the **exact context payload** that will be sent
to the model, by walking the active branch path to HEAD and resolving every frame's
current representation: deletions omitted, compactions/edits applied, offloaded frames
rendered as references. This is where the abstract frame graph becomes a concrete
prompt. Output is inspectable (you can see precisely what the model will receive).

- **Branch selection:** `compose` **always walks a single branch path**
  to HEAD. Cross-branch combination is done *only* via explicit
  [`import`](#5b-structural-operations)/cherry-pick (a real commit) — never by composing
  across branches. This keeps provenance honest (everything in the payload literally
  exists on the active branch) and preserves the model-unaware principle. Native
  multi-branch compose is [future work](#10-future-work).

**`send [--text <t>]`** — Issue the next model turn: `compose` the context, append the
new user input, hand it to the backend, and capture the response as a new frame. The
model sees only the composed (mutated) state — never the operation history.

---

## 6. Worked use cases

1. **Tangent pruning.** You wander off-topic. Switch to frame view, `delete` the
   tangent frames. The next turn flows cleaner; the model never re-reads the noise.
2. **Code iteration cleanup.** Five versions of a file sit in context. `combine` the
   old ones into a "previous attempts" frame, optionally `compact` it. Context now
   holds the current version + a pointer to what was tried.
3. **Tool-call spam.** An assistant turn made three calls with huge outputs. `strip`
   two results and `summarize` the third; reasoning stays, bloat goes.
4. **Branch to explore.** `branch` from an earlier frame, try a different direction,
   keep the original. Later `import` the best frames from one branch back into another.
5. **Offload to external memory.** A big but maybe-needed frame: `offload` it to a
   file; the window keeps a summary + path; the model reads the file with its native
   tool if it needs the detail (or you `restore` it manually).
6. **Cross-conversation reuse.** Found a great explanation in another chat? `import`
   that frame into the current branch — cherry-pick across "repos."

---

## 7. Data Model

```
Frame {
  id            : string
  title         : string          // auto-generated, user-overridable
  summary       : string          // auto-generated, for frame-view scanning
  fullText      : string
  role          : "user" | "assistant" | "system" | "imported"
  toolCalls     : ToolCall[]      // bundled with the assistant turn; flattened
  tokenEstimate : int
  createdAt     : timestamp
  modifiedAt    : timestamp
  branchId      : string
  parentFrameId : string | null
  isOffloaded   : bool
  fileReference : string | null   // path when offloaded
  pinned        : bool            // true for the system frame; delete is guarded
  provenance    : OpRef[]         // operations that produced this frame state
}

Operation /* = Commit */ {
  id              : string
  type            : "add" | "delete" | "combine" | "split" | "move" |
                    "import" | "edit" | "compact" | "strip" | "summarize" |
                    "retitle" | "offload" | "restore" | "branch" |
                    "checkout" | "revert" | "tag"
  affectedFrameIds: string[]
  params          : object        // op-specific (e.g., split marker, summarize range)
  timestamp       : timestamp
  note            : string | null
  branchId        : string
  parentCommitId  : string | null
}

Branch {
  id            : string
  name          : string
  headCommitId  : string
  parentBranchId: string | null
  createdAt     : timestamp
}

Session {
  id              : string
  activeBranchId  : string
  headFramePos    : int
  externalMemRefs : string[]
  pendingChanges  : bool
}
```

---

## 8. UI Architecture

- **Dual view** with a toggle: conversation view ⇄ frame view.
- **Frame view = Git-style tree.** Nodes = frame states (title + summary, color-coded
  by branch and/or frame type); edges = operations (labeled with op type). Click a
  node → expand full text; right-click → operation menu; drag → create a branch.
- **Pinned system frame** at the top of the tree (system prompt / tool definitions /
  project instructions), visually distinct and operable like any frame — with `delete`
  guarded.
- **Frame details panel** — full text with inline edit, summary, linked tool calls,
  file reference if offloaded, and provenance.
- **Operation/history panel** — the commit log with filtering and side-by-side diffs;
  click a commit to `checkout`/`revert`.
- **Tree visualization** — start minimal (hand-drawn SVG nodes/edges) for control and
  cleanliness; graduate to Cytoscape.js / Vis.js if the tree gets large. For a demo,
  minimal usually looks cleaner than a heavy library.

---

## 9. Provider assumptions & constraints

**Assumptions about the LLM backend:**

1. Messages have a standard structure: user / assistant (with optional tool calls and
   results) / system.
2. Tool calls are discrete, inspectable units within an assistant message — not opaque
   blobs. *If this holds*, tool calls are first-class within frames (enabling `strip`
   / `summarize` on individual results); *if not*, they degrade gracefully to plain
   text.
3. The API supports **editing an earlier message and re-running from that point** —
   which Claude and ChatGPT both already do. Context Composer's frame editing is just
   leveraging this existing capability; it asks for **nothing new** from the provider.
4. The full message structure is readable, not just rendered text.
5. The agent has a **file-reading tool**, so an offloaded frame can be retrieved by the
   model simply reading its file on demand ([§5.D](#5d-memory-operations)) — no bespoke
   fetch mechanism needed.
6. The **system prompt is composable** by the harness (not a fixed opaque preamble), so
   it can be represented and operated on as the pinned system frame
   ([§2.7](#27-the-system-frame)).

**Caching / efficiency:**

- Editing a frame keeps everything **before** it cached (prefix caching) but
  **re-tokenizes everything after** it. So edits near the *end* of the context are
  cheap; edits to *early* frames invalidate the tail.
- **UX consequence:** nudge users to edit/operate on **recent** frames and let early
  frames "settle" into stable context. Keep the tail hot, the head stable.
- For a demo, full re-tokenization on each mutation is acceptable and honest — nobody
  is watching inference cost. The pitch is "here's the UX we want; here's how a
  provider *could* support it efficiently," not "we solved the infra."

**Scope simplifications (demo):**

- **No permission system.** Run with permissions effectively skipped
  (`--dangerously-skip-permissions`-style). Optionally a single global "ask before
  tool calls" toggle, but no full permission UI.
- **No special question/planning widgets.** If the model asks the user something, it
  appears as plain text in conversation view; the user answers as the next turn. No
  bespoke interaction UI — this avoids the "adapter hell" of replicating every native
  agent feature.

---

## 10. Future work

- **Smarter frame extraction.** Use the LLM to detect true semantic boundaries and
  auto-merge/split, instead of the default turn-based segmentation.
- **Cross-branch composition** as a first-class compose mode.
- **Git-style branch merge** with frame-level conflict resolution.
- **Auto-restore on detected intent** — heuristically re-inject an offloaded frame when
  the model's output implies it's needed.
- **Collaboration.** Shared contexts, visible operation history, suggested operations,
  rollback by others.
- **Agentic operations.** The model itself proposes operations ("this tangent should
  be compacted") that the user accepts/rejects — surfacing agentic reasoning *about
  context*. A strong demo beat.
- **Deeper feature parity** with native agent systems (planning, permissions) once the
  core is stable.

---

## Appendix A — Glossary

- **Frame** — addressable semantic unit of context (default: a user+assistant turn,
  tool calls bundled).
- **System frame** — the pinned frame holding the system prompt / tool definitions /
  project instructions; operable (notably `compact`/`offload`) with `delete` guarded.
- **Operation** — a transformation on frames/branches; each mutating one is a commit.
- **Compose** — assembling the concrete context payload sent to the model.
- **Offload / Restore** — swap a frame for a reference to free window space / bring it
  back.
- **Shared vs isolated** — whether an operation on a frame ripples to descendant
  branches or stays branch-local.
- **Model-unaware principle** — the running model sees only the mutated context, never
  the operations.
