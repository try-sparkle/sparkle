// @vitest-environment jsdom
//
// THE UNSTAFFED RUNG, ON THE FOUNDER'S ACTUAL SCREEN (bead `sparkle-tsyh5u`).
//
// The founder, 2026-08-22, verbatim: *"I don't have a good understanding of why an epic can be in
// the being built category and yet there are no active billed agents running against it."*
//
// `services/epicBoard.test.ts` pins the RULE — where `bucketEpics` files an epic given an answer
// about staffing. What it cannot see is whether this column asks the question at all: the predicate
// is optional, so a column that simply never passes one renders exactly as it did before the rung
// existed and every bucketing test stays green. That is what this file guards, end to end through
// the real `useEpicHealthOf` wiring, with nothing mocked.
//
// ══ WHY EVERY CASE MOUNTS A STAFFED EPIC BESIDE THE UNSTAFFED ONE ══════════════════════════════
// Same trap `EpicsColumn.health.test.tsx` names one file over. "Render one bare epic, assert it is
// under Unstaffed" passes against a column that files EVERY in-progress epic there, and against one
// that ignores the roster entirely. So the fixture stands the two side by side and every assertion
// is that they SEPARATE — the bare one present under the new header AND absent from the old one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { STAGE_LABELS } from "../services/epicBoard";
import { bucketBeads, type Bead } from "../services/beads";
import type { AgentTab, AgentTabStatus, Project } from "../types";

/** An epic the board files under "Being built" — the 129-bead case, `in_progress` on the bead.
 *
 *  Written out in full rather than cast: a partial object behind `as Bead` is a compile error under
 *  this repo's settings ("neither type sufficiently overlaps"), and casting through `unknown` to get
 *  round it would let a field the bucketing actually reads go missing without a word. */
function buildingEpic(id: string): Bead {
  return {
    id,
    title: id,
    description: "",
    status: "in_progress",
    labels: [],
    parent: null,
    commentCount: 0,
    type: "epic",
  };
}

/** A build orchestrator bound to `epicId` — the edge `services/epicLadder` reads. */
function build(id: string, epicId: string): AgentTab {
  return { id, name: id, kind: "build", parentId: null, epicId } as unknown as AgentTab;
}

function projectWith(agents: AgentTab[]): Project {
  return { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents } as unknown as Project;
}

function seed(beads: Bead[]) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      p1: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
}

/** The epic ids rendered under one rung. Reads the STAGE CONTAINER rather than the whole column, so
 *  "absent from Being built" is a real observation about that rung and not about the document. */
function rungIds(key: string): string[] {
  const stage = screen.getByTestId(`epics-stage-${key}`);
  return within(stage)
    .queryAllByTestId("epic-row")
    .map((r) => r.getAttribute("data-epic-id") ?? "");
}

function rungCount(key: string): string {
  return screen.getByTestId(`epics-stage-count-${key}`).textContent ?? "";
}

const STATUS: Record<string, AgentTabStatus> = {
  "a-live": "working",
  // `waiting` is the status the red band is keyed to — it bands as `needs_you`
  // (`engine/workerRollup.isRedStatus` / `bandOfStatus`), which is what rolls a fleet up to the red
  // dot. Cite the CLASSIFIER, not a palette: `EpicHealthSquare` no longer has a colour map at all
  // (it is `ROLLUP_DOT_COLOR[health]`), and a paint lookup could be changed to any hex without
  // moving this outcome — while `isRedStatus` de-escalating `waiting`, which `workerRollup`'s own
  // header records as having already happened once to `unmerged`, would red this file with its
  // comment pointing at a module that had nothing to do with it (roborev 67958). Named here rather
  // than inline so the red-fleet case below cannot drift onto a status that merely LOOKS alarming
  // while banding as something else.
  "a-stuck": "waiting",
};

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
  useRuntimeStore.setState({
    status: { ...STATUS },
    openAgentIds: [],
    lastObserved: {},
    branchStatus: {},
    workflowStage: {},
    observedAttention: {},
  } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("EpicsColumn — the Unstaffed rung", () => {
  it("moves an in_progress epic with NO agent out of Being built and under Unstaffed", () => {
    // THE DEFECT, stated as a render. Both epics carry `status: "in_progress"`, so `columnFor` puts
    // both under "Being built"; the only difference between them is that one has a working
    // orchestrator bound to it and the other has nobody.
    seed([buildingEpic("ep-staffed"), buildingEpic("ep-bare")]);
    render(<EpicsColumn project={projectWith([build("a-live", "ep-staffed")])} side="right" />);

    // Present in the new rung...
    expect(rungIds("unstaffed")).toEqual(["ep-bare"]);
    // ...and ABSENT from the column whose header was lying about it, which is the half the
    // founder's complaint is actually about. Its staffed sibling is still there, so this cannot
    // pass by way of an empty Being-built column.
    expect(rungIds("inProgress")).toEqual(["ep-staffed"]);

    // The counts in the two headers move with the rows — a rung whose count and body disagree is
    // the shape a reader trusts least.
    expect(rungCount("unstaffed")).toBe("1");
    expect(rungCount("inProgress")).toBe("1");
  });

  // ══ THE OTHER ARM OF THE SAME WIRING, AND IT NEEDS ITS OWN END-TO-END CASE ══════════════════
  // The founder: *"if the agents are Red then it would go into blocked."* `epicBoard.test.ts` pins
  // that rule by HAND-SUPPLYING a rung to `bucketEpics`, which proves the rule and says nothing
  // about whether this column asks for it. That distinction is not academic: replacing the call
  // site with a second local rule — `healthOf(id) === "gray" ? "unstaffed" : "inProgress"` —
  // (spelled with the COLOUR, `gray`, because that is what `healthOf` returns since `EpicHealth`
  // collapsed to `RollupDot`; the older spelling with `"unstaffed"` no longer typechecks, so a
  // reader who tried to run the mutation got a type error and could reasonably conclude this case
  // was unnecessary — roborev 67959) —
  // typechecks and leaves every bucketing test green while quietly deleting the founder's rule from
  // the product. Only a render can see it, which is what this file exists for.
  it("sends an epic whose whole fleet is RED to Blocked, not to either build rung", () => {
    // THREE epics, one per outcome, mounted at once. Asserting the red one's arrival alone would
    // pass for a column that files EVERY in-progress epic under Blocked; asserting its absence from
    // Being built alone would pass for a rule that filed it as unstaffed instead — a different
    // claim about the epic (nobody came) than the one its fleet is making (everyone is stuck).
    seed([buildingEpic("ep-working"), buildingEpic("ep-stuck"), buildingEpic("ep-bare")]);
    render(
      <EpicsColumn
        project={projectWith([build("a-live", "ep-working"), build("a-stuck", "ep-stuck")])}
        side="right"
      />,
    );

    expect(rungIds("blocked")).toEqual(["ep-stuck"]);
    expect(rungIds("inProgress")).toEqual(["ep-working"]);
    expect(rungIds("unstaffed")).toEqual(["ep-bare"]);
    // All three separated, so no single rung can be swallowing the column.
    expect(rungCount("blocked")).toBe("1");
    expect(rungCount("inProgress")).toBe("1");
    expect(rungCount("unstaffed")).toBe("1");
  });

  it("renders the rung under the founder's own word, between Blocked and Being built", () => {
    seed([buildingEpic("ep-bare")]);
    render(<EpicsColumn project={projectWith([])} side="right" />);

    const headers = screen
      .getAllByTestId(/^epics-stage-toggle-/)
      .map((b) => b.textContent ?? "");
    expect(headers.some((t) => t.includes(STAGE_LABELS.unstaffed))).toBe(true);
    // The ORDER as rendered, which is the thing a person actually reads. `EPIC_LADDER`'s own test
    // pins the array; this pins that the column walks it rather than a list of its own.
    const at = (label: string) => headers.findIndex((t) => t.includes(label));
    expect(at(STAGE_LABELS.unstaffed)).toBe(at(STAGE_LABELS.inProgress) - 1);
    expect(at(STAGE_LABELS.blocked)).toBe(at(STAGE_LABELS.unstaffed) - 1);
  });

  it("ships the rung EXPANDED — a collapsed one would re-hide exactly what it exists to surface", () => {
    // `OPEN_BY_DEFAULT`. Asserted through the DOM with NO click first: the row above was found
    // without expanding anything, and this states the reason out loud so a future edit to that set
    // reds here rather than silently swapping one wrong header for a closed chevron.
    seed([buildingEpic("ep-bare")]);
    render(<EpicsColumn project={projectWith([])} side="right" />);
    expect(screen.getByTestId("epics-stage-toggle-unstaffed").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(rungIds("unstaffed")).toEqual(["ep-bare"]);
  });

  it("is the SAME rule as the square: an epic whose only agent finished and went idle lands here", () => {
    // The other half of "just sitting there", and the reason this must not be a fresh "is the
    // roster non-empty" predicate. `ep-gone` HAS a bound agent; that agent is idle, which
    // `engine/epicHealth` reads as `"gray"` — the COLOUR, which the ladder then files under the
    // `unstaffed` RUNG; the two used to share one name and no longer do — so the column has to
    // agree with the square beside
    // it. A roster-membership test would leave this epic under "Being built" while its own square
    // said nobody was working on it.
    seed([buildingEpic("ep-live"), buildingEpic("ep-gone")]);
    useRuntimeStore.setState({ status: { "a-live": "working", "a-done": "idle" } } as never);
    render(
      <EpicsColumn
        project={projectWith([build("a-live", "ep-live"), build("a-done", "ep-gone")])}
        side="right"
      />,
    );

    expect(rungIds("unstaffed")).toEqual(["ep-gone"]);
    expect(rungIds("inProgress")).toEqual(["ep-live"]);
  });

  it("still paints the health square on the new rung — it is not a terminal one", () => {
    // `epicHealthApplies("unstaffed")` is true and is deliberately NOT special-cased. The row's mark
    // and the header above it say the same thing, which is the whole point of deriving both from
    // one rule.
    //
    // NOTE THE TWO WORDS, which used to be one. `"unstaffed"` is the LADDER RUNG; `"gray"` is the
    // COLOUR (`EpicHealth` is now literally `RollupDot`, per the founder's colour-parity rule). The
    // square is SOLID gray rather than the hollow amber it used to be — see `EpicHealthSquare`.
    seed([buildingEpic("ep-bare")]);
    render(<EpicsColumn project={projectWith([])} side="right" />);
    const stage = screen.getByTestId("epics-stage-unstaffed");
    const square = within(stage).getByTestId("epic-health");
    expect(square.getAttribute("data-health")).toBe("gray");
    expect(square.style.background).not.toBe("transparent");
    expect(square.style.background).not.toBe("");
    expect(square.style.border).toBe("");
  });

  it("leaves the rung EMPTY when every in-progress epic is staffed — it is not a dumping ground", () => {
    // The negative with the rung mounted. Without it every assertion above is satisfied by a column
    // that files all in-progress epics under Unstaffed, and the founder's screen would go from one
    // wrong header to the other one.
    seed([buildingEpic("ep-a"), buildingEpic("ep-b")]);
    useRuntimeStore.setState({ status: { "a-1": "working", "a-2": "working" } } as never);
    render(
      <EpicsColumn
        project={projectWith([build("a-1", "ep-a"), build("a-2", "ep-b")])}
        side="right"
      />,
    );
    expect(rungIds("unstaffed")).toEqual([]);
    expect(rungCount("unstaffed")).toBe("0");
    expect(rungIds("inProgress")).toEqual(["ep-a", "ep-b"]);
  });
});
