// @vitest-environment jsdom
//
// THE CONTRADICTION THE FOUNDER CAUGHT (bead sparkle-y2p4f).
//
// One screenshot held both of these, about the same agent, at the same instant:
//   • this dialog: "Its work has landed, but nothing has been recorded about what it learned."
//     …offering "Retire anyway — record the gap"
//   • that agent's own sidebar row: a pill reading "FEEDBACK 2"
//
// Both cannot be true. The row was right — the agent had filed two feedback beads. The dialog read a
// different store (`retro-receipts.json`) that the retro pipeline never writes to, and since NOTHING
// writes a `captured` receipt in production, it said this to every agent that ever reported.
//
// These cases pin the four-way standing so the accusing sentence — and the permanent gap note the
// button writes — can only reach an agent that demonstrably reported nothing.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetireAgentConfirm } from "./RetireAgentConfirm";
import type { FeedbackEvidence } from "../engine/retroEvidence";

afterEach(cleanup);

/** The sentence that must never reach an agent with feedback on file. */
const ACCUSATION = /nothing has been recorded about what it learned/i;
/** The button that writes the permanent gap receipt. */
const GAP_BUTTON = /record the gap/i;

function show(over: {
  feedback: FeedbackEvidence;
  receipt?: Parameters<typeof RetireAgentConfirm>[0]["receipt"];
}) {
  return render(
    <RetireAgentConfirm
      agentName="Agents Inherit Permission Allowlist"
      receipt={over.receipt ?? null}
      feedback={over.feedback}
      canAnswer={true}
      onRetire={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe("an agent that demonstrably reported", () => {
  // ── THE GOAL, STATED AS A TEST ────────────────────────────────────────────────────────────────
  it("is never told nothing has been recorded", () => {
    show({ feedback: { kind: "reported", count: 2 } });
    expect(screen.queryByText(ACCUSATION)).toBeNull();
  });

  it("is never offered the gap-recording button", () => {
    show({ feedback: { kind: "reported", count: 2 } });
    expect(screen.queryByRole("button", { name: GAP_BUTTON })).toBeNull();
  });

  it("is never shown the note explaining that a gap is about to be written", () => {
    show({ feedback: { kind: "reported", count: 2 } });
    expect(screen.queryByTestId("retire-gap-note")).toBeNull();
  });

  it("has its title stop claiming the retro is missing", () => {
    show({ feedback: { kind: "reported", count: 2 } });
    expect(screen.queryByText(/without its retro/i)).toBeNull();
  });

  it("is credited with what it actually filed, by count", () => {
    show({ feedback: { kind: "reported", count: 2 } });
    // The number is the point: it is the same count the row's pill shows, so the two surfaces
    // visibly agree instead of contradicting each other.
    expect(screen.getByTestId("retire-feedback-credit").textContent).toMatch(/\b2\b/);
  });

  it("still offers a way to complete the retirement", () => {
    // A landed row must always have an exit — see the dialog's own note on `canAnswer`.
    show({ feedback: { kind: "reported", count: 2 } });
    expect(screen.getByRole("button", { name: /^Retire it$/ })).toBeTruthy();
  });

  it("says 'piece' rather than 'pieces' for a single bead", () => {
    show({ feedback: { kind: "reported", count: 1 } });
    const t = screen.getByTestId("retire-feedback-credit").textContent ?? "";
    expect(t).toMatch(/1 piece of feedback/);
    expect(t).not.toMatch(/pieces/);
  });
});

describe("an agent whose backlog could not be read", () => {
  it("is not accused of having recorded nothing", () => {
    show({ feedback: { kind: "unknown" } });
    expect(screen.queryByText(ACCUSATION)).toBeNull();
  });

  it("is not offered the gap-recording button", () => {
    // "I could not look" is not evidence of a gap. Writing one here would recreate the bug in a
    // narrower window — and a gap receipt has no delete path anywhere in the app.
    show({ feedback: { kind: "unknown" } });
    expect(screen.queryByRole("button", { name: GAP_BUTTON })).toBeNull();
  });

  it("says plainly that it cannot tell, and that nothing will be recorded against the agent", () => {
    show({ feedback: { kind: "unknown" } });
    const t = screen.getByTestId("retire-unknown-note").textContent ?? "";
    expect(t).toMatch(/can’t tell|cannot tell/i);
    expect(t).toMatch(/won’t record|will not record/i);
  });

  it("still offers a way to complete the retirement", () => {
    show({ feedback: { kind: "unknown" } });
    expect(screen.getByRole("button", { name: /^Retire it$/ })).toBeTruthy();
  });
});

describe("an agent that genuinely reported nothing", () => {
  // The ONE case where the original copy was true. It must survive intact — the point of the fix is
  // to narrow the accusation to where it is earned, not to abolish it.
  it("is still told nothing has been recorded", () => {
    show({ feedback: { kind: "none" } });
    expect(screen.getByText(ACCUSATION)).toBeTruthy();
  });

  it("is still offered the gap-recording button and its explanation", () => {
    show({ feedback: { kind: "none" } });
    expect(screen.getByRole("button", { name: GAP_BUTTON })).toBeTruthy();
    expect(screen.getByTestId("retire-gap-note")).toBeTruthy();
  });

  it("still titles itself as missing the retro", () => {
    show({ feedback: { kind: "none" } });
    expect(screen.getByText(/without its retro/i)).toBeTruthy();
  });
});

describe("a receipt on file still wins", () => {
  it("keeps the settled copy even when the agent also has feedback beads", () => {
    show({
      receipt: { state: "excused", at: 1, source: "agent-declared", reasonText: "no-changes" },
      feedback: { kind: "reported", count: 3 },
    });
    expect(screen.getByText(/it recorded why it has no retro to file/i)).toBeTruthy();
    expect(screen.queryByText(ACCUSATION)).toBeNull();
    expect(screen.getByRole("button", { name: /^Retire it$/ })).toBeTruthy();
  });
});

describe("uncommitted files still block retirement in every standing", () => {
  // The dirty gate is orthogonal to the retro standing and must not be weakened by this change.
  for (const feedback of [
    { kind: "reported", count: 2 },
    { kind: "unknown" },
    { kind: "none" },
  ] as FeedbackEvidence[]) {
    it(`withholds every retire button when dirty (${feedback.kind})`, () => {
      render(
        <RetireAgentConfirm
          agentName="X"
          receipt={null}
          feedback={feedback}
          canAnswer={true}
          dirty={true}
          dirtyCount={2}
          dirtyFiles={["a.ts", "b.ts"]}
          onRetire={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: /^Retire it$/ })).toBeNull();
      expect(screen.queryByRole("button", { name: GAP_BUTTON })).toBeNull();
      expect(screen.getByTestId("retire-uncommitted-block")).toBeTruthy();
    });
  }
});
