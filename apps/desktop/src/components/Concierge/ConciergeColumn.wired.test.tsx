// @vitest-environment jsdom
//
// LIFT AT REST · FLOOD WHEN WIRED — rev4.html's `.assist`, and MAPPING.md's `data-wired`.
//
// UNWIRED the concierge LIFTS: a soft shadow, NO colour change, reading as a layer above the
// build+terminal pairs. WIRED (the cable patched to a pair, left or right) it DROPS FLUSH — loses
// the shadow entirely and takes the TERMINAL's colour, which is what says "this column is now one
// end of that cable". The two are alternatives, not a stack: a shadow AND a colour change would
// read as two unrelated effects rather than as one control being plugged in.
//
// MAPPING.md is explicit that this must be ONE value with every visual consequence following from
// it, NOT scattered component state. So these tests drive a single prop and assert the whole
// cascade — column, composer, user bubble — rather than poking each piece.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { CONCIERGE_LIFT_Z, ConciergeColumn } from "./ConciergeColumn";
import { PULL_TAB_RAIL_Z } from "../ColumnPullTab";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { C, CHAT_USER_BUBBLE } from "../../theme/colors";
import type { ConciergeController, ConciergeViewModel, ConciergeWired } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);
afterEach(cleanup);

/** jsdom's CSSOM normalises a literal hex to `rgb(r, g, b)`; a `var(--…)` string is left verbatim.
 *  The wired surface comes straight off BLUEPRINT (those two spec values have no CSS var — see
 *  theme/blueprintSpec), so it has to be converted before comparing. */
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
  messages: [{ id: "m1", kind: "you", text: "Retry the failing one" }],
};

const controller = (): ConciergeController => ({
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onNudgeClick: vi.fn(),
  onNudgeAction: vi.fn(),
});

function mount(wired?: ConciergeWired) {
  render(
    <ConciergeColumn
      model={model}
      controller={controller()}
      {...(wired === undefined ? {} : { wired })}
    />,
  );
  return screen.getByLabelText("Sparkle concierge");
}

describe("unwired — the concierge LIFTS", () => {
  it("carries the spec's lift, on its OWN plane", () => {
    const col = mount();
    expect(col.dataset.wired).toBe("off");
    expect(col.style.boxShadow).toBe(BLUEPRINT.dark.lift);
    // ── THIS ASSERTION WAS INVERTED, DELIBERATELY. ────────────────────────────────────────────
    // It used to read `toBe(C.conciergeSurface)` under the heading "does NOT change colour",
    // because the design said the lift speaks with elevation ALONE. That was written for LIGHT,
    // where the column is #ffffff and elevation is the only move available. In DARK it left the
    // unmounted column sitting on exactly the ground colour, so the shadow had nothing to lift
    // OFF and the founder read it as one more dark column beside the build columns.
    //
    // The resting state now has its own plane. `conciergeSurfaceLifted` is IDENTICAL to
    // `conciergeSurface` in light (nothing is above white), so the original "elevation alone"
    // reading still holds everywhere it was ever true; dark takes a +16.3% L* step. The
    // relationship between the two tokens is pinned in theme/blueprintSpec.test.ts.
    expect(col.style.background).toBe(C.conciergeSurfaceLifted);
    expect(col.style.color).toBe(C.cream);
  });

  it("is the default, so a shell that knows nothing about wiring gets the resting state", () => {
    expect(mount().dataset.wired).toBe("off");
  });
});

// ── THE VERTICAL LINE. Reported three times; this is the regression test for it. ───────────────
// The column used to paint `border-right: 1px solid <hairline>` unconditionally. That single
// declaration was the line the founder saw at the concierge↔build boundary, and it survived two
// rounds of "seam" fixes because those moved the SIDEBAR's border in index.css while this one —
// in a different file, reading as the concierge's own edge — was never touched.
//
// ASSERTS THE PAINT, NOT THE ABSENCE OF A DECLARATION. The border must stay 1px (box-sizing is
// border-box and this column has an explicit width, so dropping it would widen the content box and
// shift the thread) — so "fixed" means transparent, and a test that merely checked for no border
// would pass on the layout-shifting version too.
describe("the concierge↔build boundary paints NO rule, in either state", () => {
  for (const wired of [undefined, "left", "right"] as const) {
    it(`draws a transparent 1px right border (wired=${wired ?? "off"})`, () => {
      const col = mount(wired);
      expect(col.style.borderRightWidth).toBe("1px");
      expect(col.style.borderRightColor).toBe("transparent");
    });
  }
});

describe("wired — the concierge FLOODS", () => {
  for (const side of ["left", "right"] as const) {
    it(`drops the lift and takes the terminal's colour (${side})`, () => {
      const col = mount(side);
      expect(col.dataset.wired).toBe(side);
      // FLUSH is the absence of the lift, which is why there is no `--z-flush` token to compare to.
      expect(col.style.boxShadow).toBe("none");
      expect(col.style.background).toBe(rgb(BLUEPRINT.dark.term));
      // The terminal's plane comes with the terminal's INK. They are a pair in the spec, and
      // separating them would leave shell ink on a terminal surface.
      expect(col.style.color).toBe(rgb(BLUEPRINT.dark.termInk));
    });
  }

  it("floods the composer and the user's bubble from the SAME value", () => {
    mount("left");
    // The composer stops painting its own `--k-input` plate — a white box punched through the
    // flood — and floats on it instead.
    const compose = screen.getByTestId("concierge-compose");
    expect(compose.dataset.wired).toBe("yes");
    expect(compose.style.background).toBe("transparent");
    // The bubble washes the terminal's own ink rather than reaching back into the shell register
    // for `--k-bubble`, which the flood has just replaced.
    const bubble = screen.getByTestId("you-bubble");
    expect(bubble.dataset.wired).toBe("yes");
    expect(bubble.style.background).toContain("currentcolor");
    expect(bubble.style.background).not.toContain(CHAT_USER_BUBBLE);
  });

  it("…and unwiring puts every one of them back", () => {
    mount();
    expect(screen.getByTestId("concierge-compose").dataset.wired).toBe("no");
    expect(screen.getByTestId("you-bubble").dataset.wired).toBe("no");
    expect(screen.getByTestId("you-bubble").style.background).toBe(CHAT_USER_BUBBLE);
  });
});

// ── FULL HEIGHT, AND HEIGHT-AGNOSTIC ────────────────────────────────────────────────────────────
// The concierge runs the full height of the window in the cockpit and has lost its project tabs —
// tabs belong to the build+terminal PAIR now, since those two are one project and the concierge is
// not any project at all. What the column must NOT do is hard-code that height: `Workspace` owns
// the shell's layout and is a concurrent worker's file, so this fills whatever box it is handed.
describe("the column's height", () => {
  it("fills its container rather than naming a number", () => {
    const col = mount();
    expect(col.style.height).toBe("100%");
    // `minHeight: 0` is what lets the thread inside it actually scroll instead of the column
    // growing to fit its content and pushing the composer off the bottom.
    expect(col.style.minHeight).toBe("0");
  });

  // ── THE LIFT MUST NOT BURY THE SEAM CONTROL ──────────────────────────────────────────────────
  // The pull tab is ~17px wide centred in a 6px rail, so it OVERHANGS this column by ~5px. A column
  // that outranks the rail paints over that overhang and swallows its hit area — the control loses
  // part of its chrome AND part of its click target, silently, and no unit test of either component
  // alone can see it. The lift shipped at `6` against the rail's `4` and did exactly that (roborev
  // 54712). Pinned against the rail's own exported constant, in both directions, so neither value
  // can be bumped back over the other.
  it("lifts ABOVE the pairs but stays BELOW the pull tab's rail", () => {
    expect(Number(mount().style.zIndex)).toBe(CONCIERGE_LIFT_Z);
    expect(
      CONCIERGE_LIFT_Z,
      "the lifted column outranks the pull tab's rail and would bury its overhang",
    ).toBeLessThan(PULL_TAB_RAIL_Z);
    // …and it is still above the pairs, which is what makes the shadow fall ON them.
    expect(CONCIERGE_LIFT_Z).toBeGreaterThan(0);
  });

  it("renders no project tabs of its own", () => {
    mount();
    expect(screen.queryByTestId("project-tabs")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
