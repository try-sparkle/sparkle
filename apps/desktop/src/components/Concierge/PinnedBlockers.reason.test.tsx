// @vitest-environment jsdom
//
// ── A BLOCKED ROW MUST SAY WHAT IT WANTS, AND MUST OFFER SOMETHING TO DO ───────────────────────
// The founder, looking at a red row in the pinned strip: *"You're showing it as blocked ... But
// there's nothing that it says it needs from me. And in fact, I can't even see anywhere to type."*
//
// Two independent defects produced that, and this file pins both:
//
//  1. THE STRIP NEVER RENDERED THE REASON. `engine/conciergeNudges.agentToNudge` has always built a
//     `text` sentence, but `ConciergeHost` deliberately routes live blockers to this strip and OUT
//     of the transcript, so `NudgeCard` — the only component that rendered `text` — never received
//     them. The row drew a dot, the word BLOCKED, a name, a project, and buttons. Nothing said why.
//
//  2. `actionsFor` RETURNED `[]` FOR EVERY NON-APPROVAL STATUS. A blocker raised by a stall cause
//     carried no button at all, while `components/agentNotices.ts` told the human to "Open the agent
//     to see what it needs from you" — an instruction to do a thing the surface did not offer.
//
// Both are the concealment `docs/never-hide-actionable-rows.md` forbids: the row is visible, it
// demands attention, and it cannot be acted on. Visibility without actionability is hiding.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PINNED_BLOCKER_ACTION_TESTID,
  PINNED_BLOCKER_REASON_TESTID,
  PINNED_BLOCKER_REDRAW_TESTID,
  PinnedBlockers,
} from "./PinnedBlockers";
import { AgentPillProvider } from "./AgentPill";
import type { ConciergeNudge } from "./types";
import type { RevealOutcome } from "../../services/agentReveal";
import { actionsFor, agentToNudge, NUDGE_OPEN_ACTION } from "../../engine/conciergeNudges";
import { NUDGE_REDRAW_ACTION } from "./NudgeCard";
import type { ConciergeAgent } from "../../services/conciergeFeed";

afterEach(() => cleanup());

const nudge = (over: Partial<ConciergeNudge> = {}): ConciergeNudge => ({
  id: "a",
  kind: "nudge",
  band: "needs_you",
  projectName: "sparkle",
  agentName: "Sparkle Off Pane Auto Resume",
  text: "Needs you — Sparkle Off Pane Auto Resume in sparkle.",
  reason: "Needs you",
  actions: [{ id: "approve", label: "Approve", kind: "primary" }],
  ...over,
});

function renderPinned(blockers: ConciergeNudge[]) {
  render(
    <AgentPillProvider
      value={{
        agents: blockers.map((b) => ({
          id: b.id,
          name: b.agentName,
          projectId: "p1",
          projectName: b.projectName,
          band: b.band,
          canAcceptInput: true,
        })),
        onOpenAgent: () => "revealed" as RevealOutcome,
      }}
    >
      <PinnedBlockers
        blockers={blockers}
        acknowledged={[]}
        onNudgeClick={vi.fn()}
        onNudgeAction={vi.fn()}
      />
    </AgentPillProvider>,
  );
}

describe("the pinned blocked row states its reason in words", () => {
  it("renders the nudge's own reason sentence", () => {
    renderPinned([nudge({ reason: "Approve?" })]);
    // THE ASSERTION IS ON THE RENDERED SENTENCE, not on the presence of the node. A row that
    // rendered an empty reason element would satisfy "the element exists" while showing the human
    // exactly what he complained about.
    expect(screen.getByTestId(PINNED_BLOCKER_REASON_TESTID).textContent).toContain("Approve?");
  });

  it("renders each row's OWN reason, not the first row's", () => {
    // Two rows, asserting on the SECOND. A component that hard-coded one row's text, or that read
    // `blockers[0]`, satisfies a single-row fixture — the mis-attribution class this suite's
    // sibling already had to fix once.
    renderPinned([
      nudge({ id: "a", reason: "first reason" }),
      nudge({ id: "b", agentName: "Second", reason: "second reason" }),
    ]);
    const texts = screen.getAllByTestId(PINNED_BLOCKER_REASON_TESTID).map((n) => n.textContent);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("second reason");
    expect(texts[1]).not.toContain("first reason");
  });

  it("does NOT repeat the agent name or project — the row already draws both", () => {
    // The first cut rendered the nudge's full `text`, producing
    // "BLOCKED: @Kraken Auth in sparkle — Approve? — Kraken Auth in sparkle."  Caught by
    // ConciergeHost.cloudApproval's positive control finding TWO matches for the agent name.
    renderPinned([nudge({ agentName: "Kraken Auth", projectName: "sparkle" })]);
    const reason = screen.getByTestId(PINNED_BLOCKER_REASON_TESTID).textContent ?? "";
    expect(reason).not.toContain("Kraken Auth");
    expect(reason).not.toContain("in sparkle");
  });

  it("renders the row's labelled action beside the reason — words AND a way to act", () => {
    // BOTH HALVES IN ONE ASSERTION, because either alone reproduces half the founder's report: a
    // row that says what it wants but offers no way to act, or a row with a button and no statement
    // of what it is for.
    renderPinned([nudge({ reason: "Approve?" })]);
    expect(screen.getByTestId(PINNED_BLOCKER_REASON_TESTID).textContent).toContain("Approve?");
    expect(screen.getAllByTestId(PINNED_BLOCKER_ACTION_TESTID)).toHaveLength(1);
  });

  it("renders no reason node at all when the nudge carries no text", () => {
    // Not a hidden requirement — a dangling "— " after the project name reads as a rendering fault.
    renderPinned([nudge({ reason: "" })]);
    expect(screen.queryByTestId(PINNED_BLOCKER_REASON_TESTID)).toBeNull();
  });
});

describe("every blocked row carries a Force-redraw control", () => {
  // THE RECOVERY ACTION. The founder's ask, verbatim: "we specifically need to get it to re render
  // or whatever is required so I can actually do something." A row can insist it needs him while
  // the pane behind it renders nothing readable; this is the control that makes the agent say it
  // again.
  it("renders the control on every row", () => {
    renderPinned([nudge({ id: "a" }), nudge({ id: "b", agentName: "Second" })]);
    expect(screen.getAllByTestId(PINNED_BLOCKER_REDRAW_TESTID)).toHaveLength(2);
  });

  it("fires the redraw action for the row it belongs to — not the first row's", () => {
    // Clicking the SECOND row's control. A component that passed `blockers[0]` would satisfy a
    // single-row fixture while redrawing the wrong agent — the mis-attribution class this suite's
    // sibling already had to fix once.
    const onNudgeAction = vi.fn();
    render(
      <AgentPillProvider
        value={{
          agents: [],
          onOpenAgent: () => "revealed" as RevealOutcome,
        }}
      >
        <PinnedBlockers
          blockers={[nudge({ id: "a" }), nudge({ id: "b", agentName: "Second" })]}
          acknowledged={[]}
          onNudgeClick={vi.fn()}
          onNudgeAction={onNudgeAction}
        />
      </AgentPillProvider>,
    );
    fireEvent.click(screen.getAllByTestId(PINNED_BLOCKER_REDRAW_TESTID)[1]!);
    expect(onNudgeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b" }),
      NUDGE_REDRAW_ACTION,
    );
  });

  it("does NOT also fire the row's own activation — the control is fenced", () => {
    // Without `stopPropagation` the click bubbles to the row and ALSO opens the agent, so one press
    // both redraws and navigates away from the pane you were trying to read.
    const onNudgeClick = vi.fn();
    const onNudgeAction = vi.fn();
    render(
      <AgentPillProvider
        value={{ agents: [], onOpenAgent: () => "revealed" as RevealOutcome }}
      >
        <PinnedBlockers
          blockers={[nudge({ id: "a" })]}
          acknowledged={[]}
          onNudgeClick={onNudgeClick}
          onNudgeAction={onNudgeAction}
        />
      </AgentPillProvider>,
    );
    fireEvent.click(screen.getByTestId(PINNED_BLOCKER_REDRAW_TESTID));
    expect(onNudgeAction).toHaveBeenCalledWith(expect.anything(), NUDGE_REDRAW_ACTION);
    expect(onNudgeClick).not.toHaveBeenCalled();
  });
});

describe("actionsFor — every blocker offers at least Open agent", () => {
  const agent = (status: string, band = "needs_you"): ConciergeAgent =>
    ({
      id: "a1",
      name: "Sparkle Off Pane Auto Resume",
      projectName: "sparkle",
      projectId: "p1",
      status,
      statusLabel: "Blocked",
      band,
    }) as unknown as ConciergeAgent;

  // THE STALL CAUSES, BY NAME. Not a single representative status: the defect was that `approval`
  // was the ONLY status with an action, so any one of these standing in for the rest would leave
  // the others able to regress silently.
  // THE BANDED SET ONLY. `lapsed`, `unmerged` and `idle` are NOT `needs_you` — they are calm rows
  // that are not asking for anything, and `ConciergeHost.cloudApproval.test.tsx` pins that they
  // carry no labelled button at all. The floor exists so a row that DEMANDS attention can never
  // offer nothing; extending it to calm rows would turn the column into a wall of buttons, which is
  // the regression that suite was written to catch.
  // `questions` IS THE BEHAVIOUR CHANGE, so it must be in the loop (roborev 65897). It went from
  // `[]` to an Open action when the predicate started deriving from `bandOfStatus`; the other three
  // passed under the old hand-listed set too, so without this the change is entirely unasserted.
  // `buildSections` states that `questions` "means the agent cannot proceed without you exactly as
  // waiting/approval do" — it is the same fact in a calmer colour, so a row in it that offered
  // nothing would be the same dead end.
  for (const status of ["blocked", "waiting", "errored", "questions"]) {
    it(`offers an action for status "${status}"`, () => {
      const actions = actionsFor(agent(status));
      expect(actions.length).toBeGreaterThan(0);
      expect(actions[0]!.id).toBe(NUDGE_OPEN_ACTION);
      expect(actions[0]!.label).toBe("Open agent");
    });

    it(`does NOT offer an approve relay for status "${status}"`, () => {
      // The floor is Open, deliberately. Relaying an approval into an agent that is not asking a
      // question presses whatever happens to be on its screen — the same hazard the row-activation
      // reversal exists to remove, and it must not come back through this door.
      expect(actionsFor(agent(status)).some((a) => a.id === "approve")).toBe(false);
    });
  }

  it("still offers Approve on a genuine approval", () => {
    // The paired inverse. Without it, `actionsFor` returning Open for EVERYTHING would pass every
    // assertion above while silently deleting the one-tap approve the strip exists to provide.
    const actions = actionsFor(agent("approval"));
    expect(actions[0]!.id).toBe("approve");
  });

  it("a CALM row still carries no labelled button", () => {
    // THE PAIRED INVERSE, and the boundary the first cut of this change got wrong: flooring every
    // non-approval status gave `idle`/`done`/`unmerged` a button they must not have.
    // Band is NOT the discriminator — the status is. These are passed the needs_you band on
    // purpose, mirroring ConciergeHost.cloudApproval's fixture, so this would fail against a
    // band-based rule.
    // REAL `AgentTabStatus` VALUES ONLY (roborev 65897). This list said `running`, which is a
    // BAND and not a status — `bandOfStatus` has no arm for it, so the switch fell through and the
    // row passed for a reason unrelated to the calm-status rule it claims to pin. The
    // `as unknown as ConciergeAgent` cast hides that from tsc, so nothing else would have caught it.
    expect(actionsFor(agent("idle"))).toEqual([]);
    expect(actionsFor(agent("unmerged"))).toEqual([]);
    expect(actionsFor(agent("working"))).toEqual([]);
    expect(actionsFor(agent("stopped"))).toEqual([]);
    expect(actionsFor(agent("done"))).toEqual([]);
  });

  it("a nudge built from a stalled agent carries both a reason and an action", () => {
    // END TO END through the real builder, because the two halves are separately defective: a
    // nudge with text but no actions, or actions but no text, each reproduce half the founder's
    // report. This asserts the row he is actually handed has both.
    const built = agentToNudge(agent("blocked"));
    expect((built.reason ?? "").trim()).not.toBe("");
    expect(built.actions.length).toBeGreaterThan(0);
  });
});
