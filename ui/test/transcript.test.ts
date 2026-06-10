// §11 Phase 5a — transcript assembly (pure unit boundary, reviewer point 5).
//
// The assembler must RE-STATE the engine's decisions, never re-make them:
// membership + order come from emittedFrameIds verbatim; content is
// representation ?? messages (the compose rule — offload stubs included).

import { describe, expect, test } from "bun:test";
import {
  assembleTranscript,
  currentEmission,
  messageBlocks,
  type FrameContent,
} from "../src/transcript.ts";

const turn = (
  id: string,
  messages: FrameContent["messages"],
  extra: Partial<FrameContent> = {},
): FrameContent => ({ id, kind: "turn", title: `frame ${id}`, messages, ...extra });

const byId = (frames: FrameContent[]) => new Map(frames.map((f) => [f.id, f]));

describe("currentEmission", () => {
  test("source messages when no override", () => {
    const f = turn("f1", [{ role: "user", content: "hi" }]);
    expect(currentEmission(f)).toEqual([{ role: "user", content: "hi" }]);
  });

  test("representation wins over source (edit/compact/offload stub)", () => {
    const f = turn("f1", [{ role: "user", content: "original" }], {
      representation: [{ role: "user", content: "[offloaded] see /tmp/x.md" }],
    });
    expect(currentEmission(f)).toEqual([
      { role: "user", content: "[offloaded] see /tmp/x.md" },
    ]);
  });
});

describe("assembleTranscript", () => {
  test("follows emittedFrameIds order, not store order", () => {
    // A moved frame: store order f1,f2 but the engine emits f2 first.
    const frames = byId([
      turn("f1", [{ role: "user", content: "first stored" }]),
      turn("f2", [{ role: "user", content: "moved ahead" }]),
    ]);
    const entries = assembleTranscript(["f2", "f1"], frames);
    expect(entries.map((e) => e.frameId)).toEqual(["f2", "f1"]);
    expect(entries[0]!.blocks[0]!.text).toBe("moved ahead");
  });

  test("ids absent from emittedFrameIds never render (deleted/absorbed/split stay hidden)", () => {
    const frames = byId([
      turn("f1", [{ role: "user", content: "kept" }]),
      turn("f2", [{ role: "user", content: "tombstoned secret" }]),
    ]);
    const entries = assembleTranscript(["f1"], frames); // engine omitted f2
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("tombstoned secret");
  });

  test("unknown ids and non-turn frames are skipped, never throw", () => {
    const preamble: FrameContent = {
      id: "p0",
      kind: "preamble",
      title: "preamble",
      messages: [],
    };
    const frames = byId([preamble, turn("f1", [{ role: "user", content: "hi" }])]);
    const entries = assembleTranscript(["ghost", "p0", "f1"], frames);
    expect(entries.map((e) => e.frameId)).toEqual(["f1"]);
  });

  test("one frame fans out to one entry per emitted message (bundled turn)", () => {
    const frames = byId([
      turn("f1", [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
      ]),
    ]);
    const entries = assembleTranscript(["f1"], frames);
    expect(entries.map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(entries.every((e) => e.frameId === "f1")).toBe(true);
  });
});

describe("messageBlocks (plain collapsed blocks — §4/§9, no widgets)", () => {
  test("string content is one text block", () => {
    expect(messageBlocks({ role: "user", content: "plain" })).toEqual([
      { kind: "text", label: null, text: "plain" },
    ]);
  });

  test("tool_use and tool_result get labels; text blocks stay plain", () => {
    const blocks = messageBlocks({
      role: "assistant",
      content: [
        { type: "text", text: "running it" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
        { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      ],
    });
    expect(blocks.map((b) => b.kind)).toEqual(["text", "tool_use", "tool_result"]);
    expect(blocks[1]!.label).toBe("tool_use · Bash");
    expect(blocks[1]!.text).toContain('"command": "ls"');
    expect(blocks[2]!.label).toBe("tool_result · tu_1");
    expect(blocks[2]!.text).toBe("file.txt");
  });

  test("unknown block types render as labeled JSON (total, §9 opaque blocks)", () => {
    const blocks = messageBlocks({
      role: "assistant",
      content: [{ type: "thinking", thinking: "hmm" }],
    });
    expect(blocks[0]!.kind).toBe("other");
    expect(blocks[0]!.label).toBe("thinking");
    expect(blocks[0]!.text).toContain('"hmm"');
  });
});
