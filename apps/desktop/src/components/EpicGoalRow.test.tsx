// @vitest-environment jsdom
//
// WHAT THIS SUITE IS GUARDING, AND WHY EACH CASE IS SHAPED THE WAY IT IS
//
// Every assertion here is on a SIDE EFFECT — the write that leaves the component, or the mark a
// reader can actually see — never on a precondition that was already true before the feature
// existed. Two shapes are used deliberately and neither is decoration:
//
//   • THE PROVENANCE PAIR IS MOUNTED TOGETHER. Asserting "the auto goal has a badge" alone passes
//     for a component that badges EVERYTHING, and asserting "the human goal has none" alone passes
//     for one that badges NOTHING. Only rendering both at once and checking the badge lands on
//     exactly one of them says the rule is keyed to `source`. The same pairing is used for the
//     at-risk count and for the Generate retry, for the same reason.
//   • THE WRITE IS CHECKED FOR ITS SECOND ARGUMENT. `onSetGoal(text, "human")` — the `"human"` is
//     not a label, it is the authority statement that stamps `projectStore`'s permanent latch, so a
//     test that only checked the text would pass while the machine kept the right to overwrite what
//     the founder typed. That is the whole point of the field.
//
// jsdom NEVER lays out and never loads the stylesheet (docs/jsdom-test-caveats.md), so nothing here
// reads a class-derived `getComputedStyle`. Truncation is asserted from the INLINE style object,
// which jsdom does carry; ink is asserted by testid, not by colour.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { EpicGoalRow } from "./EpicGoalRow";
import type { EpicGoal } from "../engine/epicGoal";
import {
  rollUpEpicGoal,
  type RollupAgent,
  type RollupBead,
} from "../engine/epicGoalRollup";

afterEach(cleanup);

/** Comfortably past `GOAL_MIN_LEN` (16), so the text itself is never what a case is testing. */
const TEXT = "Ship the epic goal row end to end";

function goal(over: Partial<EpicGoal> = {}): EpicGoal {
  return { text: TEXT, setAt: 1_000, source: "human", ...over };
}

function bead(id: string, status: RollupBead["status"], title = id): RollupBead {
  return { id, title, status };
}

/** The row for one epic, found by the epic id it was rendered with. */
function row(epicId: string) {
  const el = document.querySelector(`[data-testid="epic-goal-row"][data-epic-id="${epicId}"]`);
  if (el === null) throw new Error(`no goal row rendered for ${epicId}`);
  return within(el as HTMLElement);
}

describe("EpicGoalRow — reading the goal", () => {
  it("renders the goal on one line, truncated, with the whole text in a tooltip", () => {
    render(
      <EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={vi.fn()} />,
    );
    const text = screen.getByTestId("epic-goal");
    expect(text.textContent).toBe(TEXT);
    // The tooltip carries the UNTRUNCATED text, which is the only way a clipped line stays readable.
    expect(text.getAttribute("title")).toContain(TEXT);
    // Inline styles, not a stylesheet class — see the header.
    expect(text.style.whiteSpace).toBe("nowrap");
    expect(text.style.textOverflow).toBe("ellipsis");
    expect(text.style.overflow).toBe("hidden");
  });

  it("badges an AUTO goal and leaves a HUMAN goal unmarked — both mounted at once", () => {
    render(
      <>
        <EpicGoalRow
          projectId="p1"
          epicId="e-auto"
          goal={goal({ source: "auto" })}
          onSetGoal={vi.fn()}
        />
        <EpicGoalRow
          projectId="p1"
          epicId="e-human"
          goal={goal({ source: "human" })}
          onSetGoal={vi.fn()}
        />
      </>,
    );
    // BOTH candidates are in the tree, so the absence below is a statement about the RULE rather
    // than about an element that was never rendered.
    expect(row("e-auto").getByTestId("epic-goal").textContent).toBe(TEXT);
    expect(row("e-human").getByTestId("epic-goal").textContent).toBe(TEXT);

    const badge = row("e-auto").getByTestId("epic-goal-auto");
    expect(badge.textContent).toContain("auto");
    // The mark is an SVG icon, not a character. `components/glyphIcons.test.ts` is a ceiling that
    // only ever goes DOWN on glyph-as-icon sites, so asserting the emoji here would have pinned the
    // thing that ratchet exists to remove — and would go red again the moment the icon changes,
    // which is not what this test is about. The badge's IDENTITY is its testid and its title.
    expect(badge.querySelector("svg")).not.toBeNull();
    // It has to SAY what it means, or the mark is just decoration the founder has to remember.
    expect(badge.getAttribute("title")).toMatch(/Sparkle wrote this goal/);
    expect(badge.getAttribute("title")).toMatch(/becomes yours/);

    expect(row("e-human").queryByTestId("epic-goal-auto")).toBeNull();
  });
});

describe("EpicGoalRow — editing", () => {
  it("clicking the goal opens an editor seeded with the current text", () => {
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={vi.fn()} />);
    expect(screen.queryByTestId("epic-goal-input")).toBeNull();
    fireEvent.click(screen.getByTestId("epic-goal"));
    expect((screen.getByTestId("epic-goal-input") as HTMLTextAreaElement).value).toBe(TEXT);
  });

  it("Enter writes the new text AS THE HUMAN'S, which is what stamps the latch", async () => {
    const onSetGoal = vi.fn();
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={onSetGoal} />);
    fireEvent.click(screen.getByTestId("epic-goal"));
    const input = screen.getByTestId("epic-goal-input");
    fireEvent.change(input, { target: { value: "Land the epic goal row on every epic" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSetGoal).toHaveBeenCalledTimes(1));
    // THE SECOND ARGUMENT IS THE POINT. See this file's header.
    expect(onSetGoal).toHaveBeenCalledWith("Land the epic goal row on every epic", "human");
    // And the row shows the new text optimistically, before any store round-trip.
    expect(screen.getByTestId("epic-goal").textContent).toBe("Land the epic goal row on every epic");
  });

  it("Shift+Enter does NOT save — it is a newline while thinking", () => {
    const onSetGoal = vi.fn();
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={onSetGoal} />);
    fireEvent.click(screen.getByTestId("epic-goal"));
    const input = screen.getByTestId("epic-goal-input");
    fireEvent.change(input, { target: { value: "A goal I am still in the middle of" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSetGoal).not.toHaveBeenCalled();
    expect(screen.getByTestId("epic-goal-input")).toBeTruthy();
  });

  it("Escape restores the ORIGINAL text and writes nothing", () => {
    const onSetGoal = vi.fn();
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={onSetGoal} />);
    fireEvent.click(screen.getByTestId("epic-goal"));
    fireEvent.change(screen.getByTestId("epic-goal-input"), {
      target: { value: "something I typed and thought better of" },
    });
    // ON `window`, because that is where the listener is registered. Dispatching at the textarea
    // would be the wrong-target `fireEvent` this repo has a lint rule about.
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onSetGoal).not.toHaveBeenCalled();
    expect(screen.queryByTestId("epic-goal-input")).toBeNull();
    expect(screen.getByTestId("epic-goal").textContent).toBe(TEXT);

    // And reopening shows the ORIGINAL again, not the abandoned draft.
    fireEvent.click(screen.getByTestId("epic-goal"));
    expect((screen.getByTestId("epic-goal-input") as HTMLTextAreaElement).value).toBe(TEXT);
  });

  it("blur saves, so clicking away does not silently lose the edit", async () => {
    const onSetGoal = vi.fn();
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={onSetGoal} />);
    fireEvent.click(screen.getByTestId("epic-goal"));
    const input = screen.getByTestId("epic-goal-input");
    fireEvent.change(input, { target: { value: "Saved by clicking somewhere else" } });
    fireEvent.blur(input, { target: { value: "Saved by clicking somewhere else" } });

    await waitFor(() => expect(onSetGoal).toHaveBeenCalledTimes(1));
    expect(onSetGoal).toHaveBeenCalledWith("Saved by clicking somewhere else", "human");
  });

  it("refuses unusable text inline, keeps the editor open, and writes nothing", () => {
    const onSetGoal = vi.fn();
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={onSetGoal} />);
    fireEvent.click(screen.getByTestId("epic-goal"));
    const input = screen.getByTestId("epic-goal-input");
    fireEvent.change(input, { target: { value: "too short" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSetGoal).not.toHaveBeenCalled();
    // The reason is SHOWN, and the text he typed is still there to act on it.
    expect(screen.getByTestId("epic-goal-error").textContent).toMatch(/too short/);
    expect((screen.getByTestId("epic-goal-input") as HTMLTextAreaElement).value).toBe("too short");
  });

  it("rolls the row back to the stored text when the write throws", async () => {
    const onSetGoal = vi.fn().mockRejectedValue(new Error("bd is locked"));
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={onSetGoal} />);
    fireEvent.click(screen.getByTestId("epic-goal"));
    const input = screen.getByTestId("epic-goal-input");
    fireEvent.change(input, { target: { value: "A goal that never reaches the store" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("epic-goal-error").textContent).toBe("bd is locked"));
    expect(screen.getByTestId("epic-goal").textContent).toBe(TEXT);
  });
});

describe("EpicGoalRow — the empty state", () => {
  it("offers to set a goal, and never invents placeholder text", () => {
    render(
      <>
        <EpicGoalRow projectId="p1" epicId="e-none" goal={undefined} onSetGoal={vi.fn()} />
        <EpicGoalRow
          projectId="p1"
          epicId="e-blank"
          goal={goal({ text: "   " })}
          onSetGoal={vi.fn()}
        />
        <EpicGoalRow projectId="p1" epicId="e-set" goal={goal()} onSetGoal={vi.fn()} />
      </>,
    );
    // NO goal, and a goal whose text is BLANK, both read as empty…
    for (const id of ["e-none", "e-blank"]) {
      expect(row(id).getByTestId("epic-goal-empty").textContent).toBe("Set a goal");
      expect(row(id).queryByTestId("epic-goal")).toBeNull();
    }
    // …while a real goal is not offered the empty affordance. Mounted alongside, so the absences
    // above are the rule and not an unmounted component.
    expect(row("e-set").queryByTestId("epic-goal-empty")).toBeNull();
    expect(row("e-set").getByTestId("epic-goal").textContent).toBe(TEXT);
  });

  it("clicking 'Set a goal' opens an editor seeded EMPTY", () => {
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={undefined} onSetGoal={vi.fn()} />);
    fireEvent.click(screen.getByTestId("epic-goal-empty"));
    expect((screen.getByTestId("epic-goal-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("a recorded generation failure shows its reason, with Generate offered only when it can retry", () => {
    const onGenerate = vi.fn();
    const failed = goal({
      text: "",
      source: "auto",
      generationFailedAt: 5_000,
      generationFailureReason: "the model timed out",
    });
    render(
      <>
        <EpicGoalRow
          projectId="p1"
          epicId="e-retry"
          goal={failed}
          onSetGoal={vi.fn()}
          onGenerate={onGenerate}
        />
        <EpicGoalRow projectId="p1" epicId="e-noretry" goal={failed} onSetGoal={vi.fn()} />
        <EpicGoalRow projectId="p1" epicId="e-untried" goal={undefined} onSetGoal={vi.fn()} />
      </>,
    );
    // A FAILED generation is a RECORDED absence, and it must not read like an untried one.
    expect(row("e-retry").getByTestId("epic-goal-failure").textContent).toBe("the model timed out");
    expect(row("e-untried").queryByTestId("epic-goal-failure")).toBeNull();

    // Generate is offered only where a retry is actually wired — both mounted, so this is the rule.
    fireEvent.click(row("e-retry").getByTestId("epic-goal-generate"));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(row("e-noretry").queryByTestId("epic-goal-generate")).toBeNull();
  });
});

describe("EpicGoalRow — the ladder readout", () => {
  const CHILDREN = [
    bead("c1", "closed", "the closed slice"),
    bead("c2", "open", "the live slice"),
    bead("c3", "open", "the abandoned slice"),
  ];
  const NOW = 10_000;

  /** An agent that took `c3` and gave up on it — the shape that makes a slice `dropped`. */
  const QUITTER: RollupAgent = {
    id: "a1",
    beadId: "c3",
    goal: {
      text: "carry the abandoned slice",
      setAt: 0,
      abandonedAt: 1,
      abandonedEvidence: "its agent walked away",
    } as RollupAgent["goal"],
  };
  /** An agent still carrying `c2`, so the epic counts as STARTED and c2 is merely open. */
  const WORKER: RollupAgent = {
    id: "a2",
    beadId: "c2",
    goal: { text: "carry the live slice", setAt: 0 } as RollupAgent["goal"],
  };

  it("says how many slices are done", () => {
    const rollup = rollUpEpicGoal(CHILDREN, [WORKER, QUITTER], NOW);
    render(
      <EpicGoalRow projectId="p1" epicId="e1" goal={goal()} rollup={rollup} onSetGoal={vi.fn()} />,
    );
    expect(screen.getByTestId("epic-goal-ladder").textContent).toBe("1 of 3 slices done");
  });

  it("paints dropped and stranded slices as AT RISK and names them — and does not when there are none", () => {
    // AT RISK: c3's only agent gave up (dropped). LEFT ALONE: every slice carried or closed.
    const atRisk = rollUpEpicGoal(CHILDREN, [WORKER, QUITTER], NOW);
    const clean = rollUpEpicGoal(
      [bead("d1", "closed"), bead("d2", "open", "carried")],
      [{ id: "a3", beadId: "d2", goal: { text: "carry it", setAt: 0 } as RollupAgent["goal"] }],
      NOW,
    );
    expect(atRisk.dropped).toBe(1);
    expect(clean.dropped + clean.stranded).toBe(0);

    render(
      <>
        <EpicGoalRow
          projectId="p1"
          epicId="e-risk"
          goal={goal()}
          rollup={atRisk}
          onSetGoal={vi.fn()}
        />
        <EpicGoalRow
          projectId="p1"
          epicId="e-clean"
          goal={goal()}
          rollup={clean}
          onSetGoal={vi.fn()}
        />
      </>,
    );
    const mark = row("e-risk").getByTestId("epic-goal-at-risk");
    expect(mark.textContent).toBe("1 at risk");
    // A COUNT WITH NO NAMES IS NOT ACTIONABLE — the tooltip has to say WHICH slice.
    expect(mark.getAttribute("title")).toContain("the abandoned slice");
    expect(mark.getAttribute("title")).toContain("dropped");

    // Both rollups are mounted, so this absence is the `dropped + stranded > 0` rule firing.
    expect(row("e-clean").queryByTestId("epic-goal-at-risk")).toBeNull();
    expect(row("e-clean").getByTestId("epic-goal-ladder").textContent).toBe("1 of 2 slices done");
  });

  it("counts a STRANDED slice as at risk too — the shape a retired agent leaves behind", () => {
    // c2 is carried, c3 is carried by nobody at all while work HAS started.
    const rollup = rollUpEpicGoal(CHILDREN, [WORKER], NOW);
    expect(rollup.stranded).toBe(1);
    render(
      <EpicGoalRow projectId="p1" epicId="e1" goal={goal()} rollup={rollup} onSetGoal={vi.fn()} />,
    );
    const mark = screen.getByTestId("epic-goal-at-risk");
    expect(mark.textContent).toBe("1 at risk");
    expect(mark.getAttribute("title")).toContain("the abandoned slice");
  });

  it("notices a finished epic WITHOUT offering to close it", () => {
    const finished = rollUpEpicGoal([bead("c1", "closed"), bead("c2", "closed")], [], NOW);
    const unfinished = rollUpEpicGoal(CHILDREN, [WORKER, QUITTER], NOW);
    render(
      <>
        <EpicGoalRow
          projectId="p1"
          epicId="e-done"
          goal={goal()}
          rollup={finished}
          onSetGoal={vi.fn()}
        />
        <EpicGoalRow
          projectId="p1"
          epicId="e-open"
          goal={goal()}
          rollup={unfinished}
          onSetGoal={vi.fn()}
        />
      </>,
    );
    const notice = row("e-done").getByTestId("epic-goal-ready");
    expect(notice.textContent).toBe("ready to close");
    // A NOTICE, NOT A CONTROL. Nothing in this row may close an epic — it says so, and this is the
    // assertion that keeps it saying so.
    expect(notice.getAttribute("role")).toBeNull();
    expect(notice.querySelector("button")).toBeNull();

    expect(row("e-open").queryByTestId("epic-goal-ready")).toBeNull();
  });

  it("shows no ladder readout at all when the caller has no rollup to give", () => {
    render(<EpicGoalRow projectId="p1" epicId="e1" goal={goal()} onSetGoal={vi.fn()} />);
    expect(screen.queryByTestId("epic-goal-ladder")).toBeNull();
    expect(screen.queryByTestId("epic-goal-at-risk")).toBeNull();
    expect(screen.queryByTestId("epic-goal-ready")).toBeNull();
  });
});
