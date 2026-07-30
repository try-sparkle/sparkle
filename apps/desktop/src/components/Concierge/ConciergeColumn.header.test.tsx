// @vitest-environment jsdom
//
// THE HEADER IS ONE ROW — rev4.html's `.ahd`, and the founder's explicit ask.
//
// wordmark · 8-dot grip · scope pill · needs-you filter · PR/merge pill · avatar · kebab.
//
// The shell used to SCATTER these: the scope line had its own centred block below the mark, the
// credit pill shared a row with the mark, the avatar and kebab lived over in the project tabs bar,
// and there was no global "just show me what needs me" control anywhere at all. This file pins the
// consolidation from both ends — that all seven are in ONE element, and that the pieces which are
// NOT in the founder's list have moved OUT of it rather than being quietly left behind, which is
// how a consolidation half-lands.
//
// The two store-backed pieces are stubbed for the same reason ConciergeColumn.test.tsx stubs them:
// the real ones drag a rAF audio loop and an entitlement fetch into assertions about layout.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => <div data-testid="logo-waveform" /> }));
vi.mock("../BalanceBadge", () => ({
  BalanceBadge: () => <button type="button">Open credits</button>,
}));

import { ConciergeColumn } from "./ConciergeColumn";
import { wordmarkRamp } from "./wordmarkRamp";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import type { ConciergeController, ConciergeViewModel } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import { useAuthStore } from "../../stores/authStore";
import { useTrialStore } from "../../stores/trialStore";

beforeEach(() => {
  enableAiEnhancementsForTests();
  // THE AVATAR IS ONE OF THE SEVEN, so it has to actually render. `AuthStatusButton` returns null
  // while either the auth or the trial store is still loading — the default in a fresh test — which
  // would make the "all seven" loop below pass by asserting six and silently skipping the seventh.
  // `signedIn` is keyed on `tokenPresent`, not on `me`.
  useAuthStore.setState({ tokenPresent: true, loading: false } as never);
  useTrialStore.setState({ loading: false, started: true } as never);
});
afterEach(cleanup);

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 2, running: 5, done: 1 },
  messages: [{ id: "m1", kind: "you", text: "Retry the failing one" }],
};

function controller(over: Partial<ConciergeController> = {}): ConciergeController {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
    ...over,
  };
}

/** Every control the founder named, with the handlers that make the optional ones render. */
function fullHeader(over: Partial<ConciergeViewModel> = {}) {
  const c = controller({
    onMoveSide: vi.fn(),
    onNeedsYouFilterToggle: vi.fn(),
    onPrClick: vi.fn(),
  });
  render(<ConciergeColumn model={{ ...model, prsReady: 3, ...over }} controller={c} />);
  return c;
}

const header = () => screen.getByTestId("concierge-header");

describe("the concierge header is ONE row", () => {
  it("holds all seven controls in a single element", () => {
    fullHeader();
    const h = header();
    for (const el of [
      screen.getByRole("img", { name: "Sparkle" }),
      screen.getByTestId("concierge-grip"),
      screen.getByTestId("concierge-vitals-line"),
      screen.getByTestId("concierge-needs-filter"),
      screen.getByTestId("concierge-pr-pill"),
      // THE AVATAR — the seventh, and it was missing from this loop while the test claimed "all
      // seven" and listed six (roborev 54712). `enableAiEnhancementsForTests` seeds a `me` with no
      // name or email, so `authIdentity` resolves to null and the signed-in control names itself
      // "Account". It is the other half of the `ConciergeTopRight` cluster and has to be IN the row.
      screen.getByRole("button", { name: "Account" }),
      screen.getByRole("button", { name: "Settings" }),
    ]) {
      expect(h.contains(el), `${el.tagName} is not in the header row`).toBe(true);
    }
    // ONE row: a fixed-height flex line, not a block that stacks.
    expect(h.style.display).toBe("flex");
    expect(h.style.height).toBe("34px");
  });

  it("keeps them in the order the founder named", () => {
    fullHeader();
    const order = [
      screen.getByRole("img", { name: "Sparkle" }),
      screen.getByTestId("concierge-grip"),
      screen.getByTestId("concierge-vitals-line"),
      screen.getByTestId("concierge-needs-filter"),
      screen.getByTestId("concierge-pr-pill"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `header item ${i} is out of order`,
      ).toBeTruthy();
    }
  });

  // THE OTHER HALF OF THE CONSOLIDATION. A move like this half-lands by adding the new row and
  // never taking anything out of it — so these assert the ABSENCE as hard as the presence above.
  it("does NOT keep the waveform or the credit pill in it", () => {
    fullHeader();
    const h = header();
    expect(h.contains(screen.getByTestId("logo-waveform"))).toBe(false);
    expect(h.contains(screen.getByRole("button", { name: "Open credits" }))).toBe(false);
    // …but neither was DELETED. The ring is the app's single mic control and what names the
    // concierge as the voice surface; the badge is the only "Open credits" entry point in the
    // shell. They keep a strip of their own directly below the header.
    const strip = screen.getByTestId("concierge-voice-strip");
    expect(strip.contains(screen.getByTestId("logo-waveform"))).toBe(true);
    expect(strip.contains(screen.getByRole("button", { name: "Open credits" }))).toBe(true);
    expect(
      h.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the voice strip must sit BELOW the header, not above it",
    ).toBeTruthy();
  });

  it("has no separate centred scope block left under it", () => {
    fullHeader();
    // Exactly one scope line in the column, and it is the one INSIDE the header — a leftover block
    // below would render a second, which is the shape this consolidation replaced.
    const lines = screen.getAllByTestId("concierge-vitals-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.style.textAlign).toBe("left");
    expect(lines[0]!.style.marginTop).toBe("0px");
  });
});

describe("the header's pills", () => {
  it("routes the grip, the filter and the PR pill through the controller", () => {
    const c = fullHeader();
    fireEvent.click(screen.getByTestId("concierge-grip"));
    expect(c.onMoveSide).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("concierge-needs-filter"));
    expect(c.onNeedsYouFilterToggle).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("concierge-pr-pill"));
    expect(c.onPrClick).toHaveBeenCalled();
  });

  it("reports the filter's state to assistive tech, not just as paint", () => {
    render(
      <ConciergeColumn
        model={{ ...model, needsYouFilter: true }}
        controller={controller({ onNeedsYouFilterToggle: vi.fn() })}
      />,
    );
    expect(screen.getByTestId("concierge-needs-filter").getAttribute("aria-pressed")).toBe("true");
  });

  // ── AN ENGAGED FILTER MUST KEEP ITS OFF SWITCH ────────────────────────────────────────────────
  // `vitals.needs_you` is the SCOPED count and the filter does not change it — so answering the
  // last waiting agent takes it to zero while the filter is still ON. Hiding the pill on the count
  // alone stranded that state: every open column kept showing needs-you items only, i.e. nothing,
  // with no control anywhere in the app to clear it (roborev 54712). "A filter offering to hide
  // nothing is a control with no state to be in" was the justification for hiding it, and an
  // ENGAGED filter is precisely a state it is in.
  it("stays mounted at a zero count while the filter is still ON", () => {
    render(
      <ConciergeColumn
        model={{ ...model, vitals: { needs_you: 0, running: 0, done: 0 }, needsYouFilter: true }}
        controller={controller({ onNeedsYouFilterToggle: vi.fn() })}
      />,
    );
    const pill = screen.getByTestId("concierge-needs-filter");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    // …and it is still the control that turns it off.
    fireEvent.click(pill);
  });

  // A control offering to filter nothing, or to merge nothing, is chrome asserting the absence of a
  // thing — which is exactly what the header consolidated to stop carrying.
  it("renders neither pill when there is nothing behind it", () => {
    render(
      <ConciergeColumn
        model={{ ...model, vitals: { needs_you: 0, running: 0, done: 0 }, prsReady: 0 }}
        controller={controller({ onNeedsYouFilterToggle: vi.fn(), onPrClick: vi.fn() })}
      />,
    );
    expect(screen.queryByTestId("concierge-needs-filter")).toBeNull();
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
  });

  // The same rule ScopeVitals' segment buttons follow: no handler, no affordance. A focusable,
  // cursor-pointer, named control that does nothing is worse than no control.
  it("renders no grip and no pills when the shell supplies no handlers", () => {
    render(<ConciergeColumn model={{ ...model, prsReady: 3 }} controller={controller()} />);
    expect(screen.queryByTestId("concierge-grip")).toBeNull();
    expect(screen.queryByTestId("concierge-needs-filter")).toBeNull();
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
  });

  // NO EMOJI AS ICONS — a standing founder rule for this repo, and the PR pill is exactly the kind
  // of control that attracts one. It draws a Feather git-pull-request glyph.
  it("draws the PR pill with an SVG icon, never an emoji", () => {
    fullHeader();
    const pill = screen.getByTestId("concierge-pr-pill");
    expect(pill.querySelector("svg")).not.toBeNull();
    // The surrogate-pair range every pictographic emoji lives in.
    expect(pill.textContent ?? "").not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("the wordmark ramps dark → light", () => {
  it("paints the mark with the theme's own ramp, not the retired gold sheen", () => {
    fullHeader();
    const logo = screen.getByRole("img", { name: "Sparkle" });
    // jsdom resolves to dark here (systemPrefersDark defaults true with no matchMedia).
    expect(logo.style.background).toBe(wordmarkRamp("dark"));
    expect(logo.style.background).toContain(BLUEPRINT.dark.wmDark);
    expect(logo.style.background).toContain(BLUEPRINT.dark.wmLit);
    // Blueprint retired gold entirely; a gold glint here was the last gold left on screen.
    expect(logo.style.background.toLowerCase()).not.toContain("gold");
    // …and it must not have reintroduced the asset's own decorative cyan→blue either, which is the
    // whole reason the mark is a mask over a themed fill rather than an <img>.
    expect(logo.style.background.toLowerCase()).not.toContain("34e0f0");
    expect(logo.style.background.toLowerCase()).not.toContain("3e7bff");
  });

  it("puts the DARK end first, so the ramp runs dark → light left to right", () => {
    fullHeader();
    const bg = screen.getByRole("img", { name: "Sparkle" }).style.background;
    expect(bg.indexOf(BLUEPRINT.dark.wmDark)).toBeLessThan(bg.indexOf(BLUEPRINT.dark.wmLit));
  });
});
