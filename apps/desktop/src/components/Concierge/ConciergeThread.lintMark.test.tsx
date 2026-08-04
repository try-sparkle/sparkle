// @vitest-environment jsdom
//
// THE LINTER'S FINDINGS HAVE A VISIBLE SURFACE (bead sparkle-kr2jz, part A's UI half).
//
// `services/conciergeLint/` was complete, tested and mounted, and its findings went to an in-memory
// counter nothing in the app reads plus a JSONL only a CLI script reads. The `ask-without-action`
// check correctly detects the founder's single most-repeated complaint — "say go and I'll spawn it"
// instead of spawning it, 35 of 45 first-person promises never carried out across 1,490 measured
// turns — and the detection was invisible. These rows are the assertion that it no longer is.
//
// Asserted through the RENDERED THREAD, not through a spy on the linter: "runReplyLint was called"
// is exactly the vacuous shape AGENTS.md names as this repo's #1 finding, and it was already TRUE
// before this change while nothing was on screen. The claim under test is that a reader sees a line.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConciergeThread } from "./ConciergeThread";
import { LINT_MARK_TESTID } from "./LintMark";
import type { ConciergeMessage, MessageLintMark } from "./types";

const mark = (check: string): MessageLintMark => ({ check, severity: "warn", detail: "why" });

function thread(messages: ConciergeMessage[]) {
  render(<ConciergeThread messages={messages} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />);
}

const REPLY = "Say go and I'll spawn the worker.";

afterEach(() => cleanup());

describe("a reply carrying lint findings shows a mark", () => {
  it("renders the mark, in the founder's words rather than the check id", () => {
    thread([{ id: "s1", kind: "sparkle", text: REPLY, settled: true, lint: [mark("ask-without-action")] }]);
    const el = screen.getByTestId(LINT_MARK_TESTID);
    expect(el.textContent).toContain("Said it would do it");
    // A check id on screen is the failure this surface exists to avoid — it names the code that
    // found the problem, not the problem.
    expect(el.textContent).not.toContain("ask-without-action");
  });

  it("renders NO mark on a clean reply — the positive control", () => {
    // Without this row the one above passes against a component that marks every message, which
    // would make the affordance worthless: a mark that is always there says nothing.
    thread([{ id: "s1", kind: "sparkle", text: "Spawned the worker.", settled: true }]);
    expect(screen.queryByTestId(LINT_MARK_TESTID)).toBeNull();
  });

  it("does NOT block, hide, or rewrite the reply it marks", () => {
    // The bead's constraint, stated as an assertion: a false positive must cost a glance and nothing
    // more. The words the concierge said are still there, whole, beside the mark.
    thread([{ id: "s1", kind: "sparkle", text: REPLY, settled: true, lint: [mark("ask-without-action")] }]);
    expect(screen.getByTestId("concierge-thread").textContent).toContain(REPLY);
    expect(screen.getByTestId(LINT_MARK_TESTID)).toBeTruthy();
  });

  it("collapses several findings into ONE mark carrying the count", () => {
    thread([
      {
        id: "s1",
        kind: "sparkle",
        text: REPLY,
        settled: true,
        lint: [mark("ask-without-action"), mark("hedge-words"), mark("naked-file-ref")],
      },
    ]);
    // ONE node, not three: a stack of annotations under every reply is the flooding failure the
    // collapsed-payload field already exists to prevent, in a column this narrow.
    expect(screen.getAllByTestId(LINT_MARK_TESTID)).toHaveLength(1);
    const el = screen.getByTestId(LINT_MARK_TESTID);
    expect(el.getAttribute("data-count")).toBe("3");
    expect(el.textContent).toContain("+2 more");
  });

  it("marks a PROACTIVE push too", () => {
    // A push streams over the same events and reaches the same `concierge:done`, so it is linted
    // like a reply. It renders in a different arm of the row, and that arm was easy to miss —
    // omitting it would have left a whole channel of unprompted promises unmarked.
    thread([
      { id: "s1", kind: "sparkle", text: REPLY, proactive: true, settled: true, lint: [mark("ask-without-action")] },
    ]);
    expect(screen.getByTestId("concierge-push")).toBeTruthy();
    expect(screen.getByTestId(LINT_MARK_TESTID).textContent).toContain("Said it would do it");
  });

  it("marks the reply it was found in, and only that one", () => {
    // Guards the upsert seam from the other side: findings that leaked onto a neighbouring bubble
    // would be worse than no findings, because the reader would go looking in the wrong reply.
    thread([
      { id: "s1", kind: "sparkle", text: "First answer.", settled: true },
      { id: "s2", kind: "sparkle", text: REPLY, settled: true, lint: [mark("ask-without-action")] },
    ]);
    const marks = screen.getAllByTestId(LINT_MARK_TESTID);
    expect(marks).toHaveLength(1);
    // The mark must sit inside the SECOND bubble's own subtree, not merely somewhere in the thread.
    expect(document.querySelector('[data-message-id="s2"]')!.contains(marks[0]!)).toBe(true);
  });
});
