// @vitest-environment jsdom
// THE ONE TITLE A STATUS DISC PAINTS — pinned to the component that paints it (bead sparkle-uklivz).
//
// The defect this file exists for is not a wrong string; it is an AMBIGUOUS one. The disc renders
// exactly one `title`, and it used to be chosen by a chain spread over three files, so a test
// querying the disc by title was guessing which of two candidates existed — and `queryByTitle`
// answers `null` for a wrong guess exactly as it does for a genuine absence. Two shipped absence
// assertions in `AgentSidebar.stallOverlay.test.tsx` were green for that reason and could not fail.
//
// So the two properties asserted here are: the resolver is what the COMPONENT paints (nobody can
// re-inline the chain without reddening this), and for the red tier the taxonomy label is NOT it.
import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import type { AgentTabStatus } from "../types";
import { askFor, FOUNDER_ASK_LABEL } from "../engine/founderAsk";
import { StatusDot } from "./StatusDot";
import { statusDotTitle } from "./statusDotTitle";

afterEach(cleanup);

const ALL = Object.keys(AGENT_STATUS) as AgentTabStatus[];

/** The `title` the mounted disc actually carries — read off the DOM, never recomputed. */
function paintedTitle(node: React.ReactElement): string | null {
  const { container } = render(node);
  const span = container.querySelector("span");
  expect(span, "StatusDot rendered no element to read a title from").not.toBeNull();
  return span!.getAttribute("title");
}

describe("statusDotTitle is the single source of the disc's title", () => {
  it("is exactly what StatusDot paints, for every status and both shapes", () => {
    // THE ANTI-DRIFT PIN. `expectedDotTitle` / `expectedPlainDotTitle` in statusDotTestUtils — and
    // therefore every by-title query in the sidebar suites — resolve through this function; if the
    // component ever stops doing the same, those queries go back to guessing and this says so.
    // `StatusDot` is the PLAIN surface: `AgentRow` folds the founder-ask in before it gets here, so
    // what arrives is already resolved and the component must not resolve it a second way.
    //
    // The status list is taken from AGENT_STATUS rather than hand-written, so a new status arrives
    // covered instead of silently outside the sweep.
    expect(ALL.length).toBeGreaterThan(8);
    for (const status of ALL) {
      expect(paintedTitle(<StatusDot status={status} />), status).toBe(statusDotTitle({ status }));
      cleanup();
      expect(paintedTitle(<StatusDot status={status} shape="half" />), status).toBe(
        statusDotTitle({ status, shape: "half" }),
      );
      cleanup();
    }
  });

  it("on a BUILD ROW, paints the founder-ask and never the taxonomy label for a status that raises one", () => {
    // ⚠️ THIS IS THE PROPERTY THAT MADE TWO ABSENCE ASSERTIONS DEAD. `queryByTitle` returns `null`
    // for a string that is painted nowhere, so `queryByTitle(AGENT_STATUS.blocked.label)` held over
    // a screaming red row exactly as it held over a calm one — and the two tests built on it were
    // controls that could never fire. Asserted in BOTH directions on the same status: the ask IS
    // what gets resolved, and the taxonomy label is NOT, because "equals the ask" alone would pass
    // for a resolver that also happened to make them equal.
    const asking = ALL.filter((s) => askFor({ status: s }) !== null);
    // Not "more than zero": all four red-tier statuses raise an ask, and a regression that left one
    // of them silently unasked would still satisfy a non-empty check.
    expect([...asking].sort()).toEqual(["approval", "blocked", "errored", "waiting"]);
    for (const status of asking) {
      const ask = askFor({ status })!;
      const title = statusDotTitle({ status, withFounderAsk: true });
      expect(title, status).toBe(FOUNDER_ASK_LABEL[ask]);
      expect(title, status).not.toBe(AGENT_STATUS[status].label);
    }
  });

  it("on every OTHER surface, keeps the taxonomy label even for a status that raises an ask", () => {
    // ⚠️ THE HALF THAT IS EASY TO BREAK WHILE FIXING THE OTHER, and it was broken exactly once on
    // the way to this file: folding the ask into `StatusDot` itself silently retitled the Sparkle
    // row, the concierge row and the TopBar cluster, which report a MACHINE's condition rather than
    // the founder's next action. `AgentSidebar.sparkleDot.test.tsx` caught it — this is the unit
    // statement of the same rule, so the next person sees the boundary before the integration does.
    for (const status of ALL) {
      expect(statusDotTitle({ status }), status).toBe(AGENT_STATUS[status].label);
    }
  });

  it("falls back to the taxonomy label on a build row too, for every calm status", () => {
    // The other side of the ask rule — without it, a resolver that returned the ask unconditionally
    // would pass the build-row assertion above.
    const calm = ALL.filter((s) => askFor({ status: s }) === null);
    expect(calm.length).toBeGreaterThan(4);
    for (const status of calm) {
      expect(statusDotTitle({ status, withFounderAsk: true }), status).toBe(
        AGENT_STATUS[status].label,
      );
    }
  });

  it("lets the caller's dotLabel outrank BOTH — it describes a subtree the row's status cannot", () => {
    // The rollup override, and the reason the chain has three levels rather than two. Asserted on a
    // RED status, because that is the case where all three candidates differ: the override, the ask,
    // and the taxonomy label. A test written against a calm status could not tell the first two
    // apart from each other.
    const ROLLUP = "a task under here needs you";
    expect(statusDotTitle({ status: "blocked", dotLabel: ROLLUP, withFounderAsk: true })).toBe(
      ROLLUP,
    );
    expect(paintedTitle(<StatusDot status="blocked" label={ROLLUP} />)).toBe(ROLLUP);
  });

  it("marks a half disc as a sub-agent, whichever level of the chain won", () => {
    // The suffix rides on the RESOLVED text, so it has to survive an override as well as a fallback.
    expect(statusDotTitle({ status: "working", shape: "half" })).toBe(
      `${AGENT_STATUS.working.label} (sub-agent)`,
    );
    expect(
      statusDotTitle({
        status: "blocked",
        dotLabel: "rolled up",
        withFounderAsk: true,
        shape: "half",
      }),
    ).toBe("rolled up (sub-agent)");
    expect(statusDotTitle({ status: "blocked", withFounderAsk: true, shape: "half" })).toBe(
      `${FOUNDER_ASK_LABEL.unstick} (sub-agent)`,
    );
  });
});
