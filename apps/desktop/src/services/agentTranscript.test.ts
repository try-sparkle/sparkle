// The SEMANTIC half of the transcript filter, and the merge the live tail depends on.
//
// Every assertion here is written to fail against the code as it was BEFORE this feature: each one
// names a specific record that must be absent, or a specific ordering that must hold. "The list is
// non-empty" would pass against anything and is deliberately never asserted.
import { describe, expect, it } from "vitest";

import {
  RESUME_PROMPT_MARKER,
  GOAL_EXPIRY_PROMPT_MARKER,
  TASK_NOTIFICATION_MARKER,
} from "../engine/agentOriginated";
import {
  filterSystemAuthored,
  mergeEntries,
  type ActivityEntry,
  type AgentEntry,
  type HumanEntry,
  type TranscriptEntry,
} from "./agentTranscript";

function human(id: string, text: string, timestamp = "2026-07-30T10:00:00.000Z"): HumanEntry {
  return {
    kind: "human",
    id,
    text,
    timestamp,
    sessionId: "s1",
    promptSource: "typed",
    raw: "{}",
    cursor: { file: "/a.jsonl", line: 0 },
  };
}

function agent(id: string, text: string, timestamp = "2026-07-30T10:00:01.000Z"): AgentEntry {
  return {
    kind: "agent",
    id,
    text,
    timestamp,
    sessionId: "s1",
    raw: "{}",
    cursor: { file: "/a.jsonl", line: 1 },
  };
}

function activity(id: string, items: number, timestamp = "2026-07-30T10:00:02.000Z"): ActivityEntry {
  return {
    kind: "activity",
    id,
    summary: "ran 1 test",
    items: Array.from({ length: items }, () => ({ verb: "ran", target: "vitest", detail: "ok" })),
    timestamp,
    endTimestamp: "2026-07-30T10:00:40.000Z",
    sessionId: "s1",
    raw: "{}",
    cursor: { file: "/a.jsonl", line: 2 },
  };
}

describe("filterSystemAuthored", () => {
  // THE BANNER IS THE WHOLE REASON THIS LAYER EXISTS. It reaches the transcript as a real `typed`
  // submission with `origin.kind:"human"` — because Sparkle genuinely types it into the PTY — so it
  // is structurally indistinguishable from the founder's own turn and Rust deliberately lets it
  // through. If this stops filtering, the pane fills with the same paragraph repeated verbatim.
  it("drops Sparkle's auto-resume banner while keeping a real turn from the same session", () => {
    const kept = human("real", "try again");
    const out = filterSystemAuthored([
      human("banner", `${RESUME_PROMPT_MARKER} automatically. Do not stop to acknowledge this.`),
      kept,
    ]);
    expect(out).toEqual([kept]);
  });

  it("drops the goal-expiry banner", () => {
    const out = filterSystemAuthored([
      human("expiry", `${GOAL_EXPIRY_PROMPT_MARKER} — nothing is coming to finish this on its own.`),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a task-notification block", () => {
    const out = filterSystemAuthored([
      human("task", `${TASK_NOTIFICATION_MARKER}\n<task-id>b4shdddfs</task-id>`),
    ]);
    expect(out).toEqual([]);
  });

  // ANCHORED AT THE START, so an agent QUOTING the banner keeps its turn. That is a real message
  // about the agent's own behaviour and suppressing it would hide the agent discussing its own loop.
  it("keeps an agent turn that merely quotes a banner", () => {
    const quoting = agent("a1", `I keep seeing "${RESUME_PROMPT_MARKER}" — I think I am looping.`);
    expect(filterSystemAuthored([quoting])).toEqual([quoting]);
  });

  it("drops entries with no renderable text but keeps an activity that folded real calls", () => {
    const withItems = activity("act", 3);
    const out = filterSystemAuthored([
      agent("empty", "   "),
      human("blank", ""),
      activity("hollow", 0),
      withItems,
    ]);
    expect(out).toEqual([withItems]);
  });
});

describe("mergeEntries", () => {
  // The tail re-reads a line that was partial last tick, and the first tail read overlaps the first
  // page. Both produce the SAME record twice; a duplicate would render as the founder's message
  // appearing twice in their own conversation.
  it("does not duplicate a record the tail returns twice", () => {
    const a = human("dup", "hello", "2026-07-30T10:00:00.000Z");
    const merged = mergeEntries([a], [{ ...a, text: "hello" }]);
    expect(merged.map((e) => e.id)).toEqual(["dup"]);
  });

  it("orders by timestamp, not arrival order", () => {
    const late = agent("late", "second", "2026-07-30T10:00:05.000Z");
    const early = human("early", "first", "2026-07-30T10:00:01.000Z");
    // Fed newest-first, which is how a page arrives relative to entries already held.
    const merged = mergeEntries([late], [early]);
    expect(merged.map((e) => e.id)).toEqual(["early", "late"]);
  });

  // Two records inside the same millisecond is ordinary for a fast tool run. Without the id
  // tiebreak the sort is unstable across renders and the thread visibly reshuffles while it works.
  it("breaks a timestamp tie deterministically so the order cannot flip between renders", () => {
    const same = "2026-07-30T10:00:00.000Z";
    const b = agent("bbb", "b", same);
    const a = agent("aaa", "a", same);
    expect(mergeEntries([], [b, a]).map((e) => e.id)).toEqual(["aaa", "bbb"]);
    expect(mergeEntries([], [a, b]).map((e) => e.id)).toEqual(["aaa", "bbb"]);
  });

  it("returns the SAME array identity when nothing new arrived, so an idle poll causes no re-render", () => {
    const existing: TranscriptEntry[] = [human("x", "hi")];
    expect(mergeEntries(existing, [])).toBe(existing);
  });
});
