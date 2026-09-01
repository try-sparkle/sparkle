// @vitest-environment jsdom
//
// THE ASK (founder, 2026-08-07, verbatim): *"I want any sort of blocked notices to be right above
// the compose window. And not in line in the chat thread. So they should not flow upwards with the
// chat thread. If there is any real block notices, they should stay persistently above the composed
// window so that I see them regardless of how much the chat thread moves."*
//
// EVERY CASE HERE IS ABOUT NOT LOSING A BLOCKER. Sparkle's standing rule is that nothing which needs
// the founder may be hidden, and MOVING alerts is the gesture most likely to break it by accident:
// the pinned zone is the only surface in the column that cannot be scrolled to, so anything that
// falls out of it is gone in a way an inline card never was. So the assertions come in pairs —
// quieter is allowed, absent is not.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PINNED_BLOCKERS_TESTID,
  PINNED_BLOCKER_ACTION_TESTID,
  PINNED_BLOCKER_CHIP_TESTID,
  PINNED_BLOCKER_REDRAW_TESTID,
  PINNED_BLOCKER_TESTID,
  PINNED_CLEAR_ACTION,
  PinnedBlockers,
} from "./PinnedBlockers";
import { expectAnnounced, flattenedBy } from "../../testing/announcedControls";
import { NUDGE_DISMISS_ACTION } from "./NudgeCard";
import { AgentPillProvider } from "./AgentPill";
import type { ConciergeNudge } from "./types";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

const blocker = (id: string, name = `Agent ${id}`): ConciergeNudge => ({
  id,
  kind: "nudge",
  band: "needs_you",
  projectName: "drodio-website",
  agentName: name,
  text: "",
  actions: [],
});

function renderPinned(blockers: ConciergeNudge[], acknowledged: ConciergeNudge[] = []) {
  const onNudgeClick = vi.fn();
  const onNudgeAction = vi.fn();
  render(
    <AgentPillProvider
      value={{
        agents: [...blockers, ...acknowledged].map((b) => ({
          id: b.id,
          name: b.agentName,
          projectId: "p1",
          projectName: b.projectName,
          band: b.band,
          canAcceptInput: true,
        })),
        onOpenAgent: () => ({ ok: true }) as unknown as RevealOutcome,
      }}
    >
      <PinnedBlockers
        blockers={blockers}
        acknowledged={acknowledged}
        onNudgeClick={onNudgeClick}
        onNudgeAction={onNudgeAction}
      />
    </AgentPillProvider>,
  );
  return { onNudgeClick, onNudgeAction };
}

const openIds = () =>
  screen.queryAllByTestId(PINNED_BLOCKER_TESTID).map((el) => el.getAttribute("data-agent-id"));
const chipIds = () =>
  screen.queryAllByTestId(PINNED_BLOCKER_CHIP_TESTID).map((el) => el.getAttribute("data-agent-id"));

// ══ EVERY CONTROL ON THE ROW IS ANNOUNCED, AND NONE IS FLATTENED ═════════════════════════════════
//
// THE DEFECT (bead sparkle-2mwl2m.1). The row carried `role="button"` so the whole strip was one
// click target, and WAI-ARIA gives that role PRESENTATIONAL CHILDREN — assistive tech flattens the
// entire subtree to the row's own accessible name. Approve/Open (a one-tap relay with no other entry
// point), Force redraw (the recovery action for a pane the app cannot read), Mute (the
// do-not-interrupt feature's only call site) and [x] were all announced as nothing at all, on a
// surface whose entire purpose is that nothing needing the founder may be hidden.
//
// THE FIX IS `role="group"`, NOT NO ROLE: a container role with no presentational children keeps
// the four buttons announced while the row keeps the name that says BLOCKED at a width where the
// visible word has been dropped (see `PinnedBlockers.narrow.test.tsx`, tier 2). A name on a bare
// generic is not exposed at all, so dropping the role outright would have lost it.
//
// EVERY CANDIDATE IS MOUNTED — the fixture carries an action, so Approve is on screen, and the
// unmeasured column width reads as roomy so nothing is tiered away. Asserting the absence of
// flattening on a control that was never rendered would pass on an empty row.
describe("PinnedBlockers — the row's nested controls reach the accessibility tree", () => {
  it("announces the pill, Approve, Force redraw, Mute and [x] by their own role and name", () => {
    const approvable: ConciergeNudge = {
      ...blocker("a"),
      actions: [{ id: "approve", label: "Approve", kind: "primary" }],
    };
    renderPinned([approvable]);
    const row = screen.getByTestId(PINNED_BLOCKER_TESTID);
    expectAnnounced(row, [
      { testId: "concierge-agent-pill", role: "button", name: /@Agent a/ },
      { testId: PINNED_BLOCKER_ACTION_TESTID, role: "button", name: "Approve" },
      {
        testId: PINNED_BLOCKER_REDRAW_TESTID,
        role: "button",
        name: "Force Agent a's terminal to redraw",
      },
      { testId: "concierge-nudge-mute", role: "button", name: "Mute alerts about Agent a" },
      {
        testId: "concierge-nudge-dismiss",
        role: "button",
        name: "Dismiss this alert about Agent a",
      },
    ]);
    // The row's own role is what decides all five, so pin it directly too: `group` announces the
    // name AND leaves its children alone, which is the whole distinction from `button`.
    expect(row.getAttribute("role")).toBe("group");
    expect(flattenedBy(screen.getByTestId(PINNED_BLOCKER_ACTION_TESTID), row)).toBeNull();
  });
});

describe("PinnedBlockers — a live blocker is pinned, not threaded", () => {
  it("names its agent and project, and says BLOCKED in the same words the thread used", () => {
    renderPinned([blocker("a", "Social Publisher Hardening")]);
    expect(openIds()).toEqual(["a"]);
    expect(screen.getByTestId(PINNED_BLOCKER_TESTID).getAttribute("aria-label")).toBe(
      "BLOCKED: Social Publisher Hardening in drodio-website",
    );
  });

  it("renders NOTHING when nothing is blocked, rather than an empty strip", () => {
    // An always-present bordered row above the composer is furniture that asserts the fleet is
    // fine. Absence is the honest rendering of "nothing needs you".
    renderPinned([]);
    expect(screen.queryByTestId(PINNED_BLOCKERS_TESTID)).toBeNull();
  });

  it("stacks several without swallowing the composer — it caps and scrolls INSIDE itself", () => {
    // The card wall that created the digest was twenty-seven of these. A pinned region that grew
    // without bound would push the input surface off screen, which is worse than the bug it fixes.
    renderPinned([blocker("a"), blocker("b"), blocker("c"), blocker("d"), blocker("e")]);
    expect(openIds()).toEqual(["a", "b", "c", "d", "e"]);
    const zone = screen.getByTestId(PINNED_BLOCKERS_TESTID);
    // BOTH, and they are one mechanism: a cap without a scroll clips the overflow silently, which
    // hides a blocker instead of moving it.
    expect(zone.style.maxHeight).not.toBe("");
    expect(zone.style.overflowY).toBe("auto");
  });

  it("opens the agent when the row is clicked", () => {
    const { onNudgeClick } = renderPinned([blocker("a")]);
    fireEvent.click(screen.getByTestId(PINNED_BLOCKER_TESTID));
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
  });

  it("opens it ONCE from the pill too — the fence stops the click reaching the row", () => {
    // The `stopPropagation` fence around the pill is load-bearing: without it one click runs the
    // reveal TWICE (re-selecting the project tab and tearing the overlay down a second time). The
    // case above cannot see that — a click on the ROW never travels through the pill — so deleting
    // the fence left the suite green while the bug was live (roborev 60158).
    const { onNudgeClick } = renderPinned([blocker("a")]);
    fireEvent.click(
      screen
        .getByTestId(PINNED_BLOCKER_TESTID)
        .querySelector<HTMLElement>('[data-testid^="concierge-agent-pill"]')!,
    );
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
  });
});

describe("PinnedBlockers — [x] acknowledges AND leaves a chip", () => {
  // THE FOUNDER'S OWN ANSWER for what [x] means here: a dismissed-but-still-live blocker "collapses
  // to a quiet chip, never vanishes". Both halves matter and they used to be in tension —
  // acknowledging de-escalates the published band, so the agent drops out of the live set and the
  // row would simply disappear from the one surface built so that it cannot.
  it("fires the SAME acknowledgement the inline card fired, under the same handle", () => {
    // Same action id and same testid on purpose: it is the same gesture, writing the same
    // transitive `dismissAlert`. A new id would have quietly orphaned the cases that pin the
    // rollup/subtree dismissal.
    const { onNudgeAction } = renderPinned([blocker("a")]);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    expect(onNudgeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      NUDGE_DISMISS_ACTION,
    );
  });

  it("keeps an acknowledged blocker ON SCREEN as a chip that still says BLOCKED", () => {
    renderPinned([], [blocker("a", "Social Publisher Hardening")]);
    // Out of the loud list…
    expect(openIds()).toEqual([]);
    // …but PRESENT, which is the whole point of the pair: quieter is allowed, absent is not.
    expect(chipIds()).toEqual(["a"]);
    expect(screen.getByTestId(PINNED_BLOCKER_CHIP_TESTID).getAttribute("aria-label")).toBe(
      "BLOCKED: Social Publisher Hardening in drodio-website (acknowledged)",
    );
  });

  it("quiets only the one acknowledged, leaving its neighbours loud", () => {
    // Without this the suite would pass against a component that quieted everything.
    renderPinned([blocker("a"), blocker("c")], [blocker("b")]);
    expect(openIds()).toEqual(["a", "c"]);
    expect(chipIds()).toEqual(["b"]);
  });

  it("goes LOUD again when the same agent blocks again, and is not drawn twice", () => {
    // A re-raised red outranks its own stale acknowledgement. Drawing both would state the opposite
    // fact about one agent in two places — and duplicate its React key.
    renderPinned([blocker("a")], [blocker("a")]);
    expect(openIds()).toEqual(["a"]);
    expect(chipIds()).toEqual([]);
  });

  it("still opens the agent from the chip, so an acknowledged blocker is not a dead end", () => {
    // Acknowledging says "I have seen this", not "I have dealt with it" — and the way to deal with
    // it is to go there.
    const { onNudgeClick } = renderPinned([], [blocker("a", "Social Publisher Hardening")]);
    fireEvent.click(screen.getByTitle("Open Social Publisher Hardening"));
    expect(onNudgeClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("clears a chip only on its OWN control — the last removal gesture there is", () => {
    const { onNudgeAction } = renderPinned([], [blocker("a")]);
    fireEvent.click(screen.getByTestId("concierge-pinned-clear"));
    expect(onNudgeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      PINNED_CLEAR_ACTION,
    );
  });

  it("keeps the loud ones ABOVE the acknowledged ones", () => {
    // What the reader has not looked at belongs nearest the composer's eye line.
    renderPinned([blocker("b")], [blocker("a")]);
    const zone = screen.getByTestId(PINNED_BLOCKERS_TESTID);
    const all = Array.from(zone.querySelectorAll("[data-agent-id]")).map((el) =>
      el.getAttribute("data-agent-id"),
    );
    expect(all.indexOf("b")).toBeLessThan(all.indexOf("a"));
  });
});
