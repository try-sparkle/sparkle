// @vitest-environment jsdom
//
// THE HEADER IS ONE ROW — rev4.html's `.ahd`, and the founder's explicit ask.
//
// wordmark · 8-dot grip · needs-you pill · PR/merge slot · avatar · kebab.
//
// The shell used to SCATTER these: the credit pill shared a row with the mark, the avatar and kebab
// lived over in the project tabs bar, and there was no global "just show me what needs me" control
// anywhere at all. This file pins the consolidation from both ends — that all six are in ONE
// element, and that the pieces which are NOT in the founder's list have moved OUT of it rather than
// being quietly left behind, which is how a consolidation half-lands.
//
// A scope/vitals line was the seventh until bead sparkle-ircc3 deleted it: the founder asked twice
// for nothing to appear beside the wordmark but the red pill. The last describe in this file is
// what holds that, and it asserts the row's whole `textContent`, not just a missing testid.
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
  vitals: { needs_you: 2, questions: 0, running: 5, done: 1 },
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

/** Stands in for `<OpenPrMenu compact />`, which the shell — not this directory — supplies. */
const PR_SLOT = (
  <button type="button" data-testid="pr-slot-stub">
    <svg />3
  </button>
);

/** Every control the founder named, with the handlers that make the optional ones render. */
function fullHeader(over: Partial<ConciergeViewModel> = {}) {
  const c = controller({
    onMoveSide: vi.fn(),
    onNeedsYouFilterToggle: vi.fn(),
  });
  render(
    <ConciergeColumn model={{ ...model, ...over }} controller={c} prSlot={PR_SLOT} />,
  );
  return c;
}

const header = () => screen.getByTestId("concierge-header");

describe("the concierge header is ONE row", () => {
  it("holds all six controls in a single element", () => {
    fullHeader();
    const h = header();
    for (const el of [
      screen.getByRole("img", { name: "Sparkle" }),
      screen.getByTestId("concierge-grip"),
      screen.getByTestId("concierge-needs-filter"),
      screen.getByTestId("pr-slot-stub"),
      // THE AVATAR — and it was once missing from this loop while the test claimed to check every
      // control and listed one fewer (roborev 54712). `enableAiEnhancementsForTests` seeds a `me` with no
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
      screen.getByTestId("concierge-needs-filter"),
      screen.getByTestId("pr-slot-stub"),
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

  it("has no scope block anywhere in the column — not in the row, not under it", () => {
    fullHeader();
    // The consolidation folded a separate centred scope block INTO this row; bead sparkle-ircc3
    // then deleted the folded line outright. Both halves are asserted here, because "moved into the
    // header" and "deleted from the header" leave the same wreckage if only one lands: ZERO scope
    // lines in the whole column, not one in the row and not a leftover block below it.
    expect(screen.queryAllByTestId("concierge-vitals-line")).toHaveLength(0);
    expect(screen.queryAllByTestId("concierge-needs-dot")).toHaveLength(0);
  });
});

describe("the header's pills", () => {
  it("routes the grip and the filter through the controller", () => {
    const c = fullHeader();
    fireEvent.click(screen.getByTestId("concierge-grip"));
    expect(c.onMoveSide).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("concierge-needs-filter"));
    expect(c.onNeedsYouFilterToggle).toHaveBeenCalled();
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
        model={{ ...model, vitals: { needs_you: 0, questions: 0, running: 0, done: 0 }, needsYouFilter: true }}
        controller={controller({ onNeedsYouFilterToggle: vi.fn() })}
      />,
    );
    const pill = screen.getByTestId("concierge-needs-filter");
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    // …and it is still the control that turns it off.
    fireEvent.click(pill);
  });

  // A control offering to filter nothing is chrome asserting the absence of a thing — which is
  // exactly what the header consolidated to stop carrying.
  it("renders no filter pill when there is nothing behind it", () => {
    render(
      <ConciergeColumn
        model={{ ...model, vitals: { needs_you: 0, questions: 0, running: 0, done: 0 } }}
        controller={controller({ onNeedsYouFilterToggle: vi.fn() })}
      />,
    );
    expect(screen.queryByTestId("concierge-needs-filter")).toBeNull();
  });

  // NO HANDLER, NO AFFORDANCE — the rule every optional control in this row follows. A focusable,
  // cursor-pointer, named control that does nothing is worse than no control.
  it("renders no grip and no filter pill when the shell supplies no handlers", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.queryByTestId("concierge-grip")).toBeNull();
    expect(screen.queryByTestId("concierge-needs-filter")).toBeNull();
  });
});

// ── THE PR SLOT ───────────────────────────────────────────────────────────────────────────────
// This used to be a `prsReady` count and an `onPrClick` callback the column painted itself, and it
// was DEAD: nothing in the app ever passed either, so the only PR affordance a user could reach was
// the wide "N PRs waiting" pill over in the project tab strip. It is now a slot the shell fills
// with the real `<OpenPrMenu compact />`, so this directory stays presentational — which means the
// column's whole contract here is WHERE it puts what it is handed, and that it invents nothing.
describe("the header's PR slot", () => {
  it("renders what the shell hands it, between the filter and the ⋮ cluster", () => {
    fullHeader();
    const slot = screen.getByTestId("pr-slot-stub");
    expect(header().contains(slot)).toBe(true);
    for (const [before, after] of [
      [screen.getByTestId("concierge-needs-filter"), slot],
      [slot, screen.getByRole("button", { name: "Settings" })],
    ] as const) {
      expect(
        before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the PR slot must sit after the filter and before the kebab",
      ).toBeTruthy();
    }
  });

  // The column must not substitute a pill of its own for an absent slot. A surface with no PR probe
  // wired (a satellite window, a test harness) shows NOTHING here — the old dead `prsReady` chip is
  // gone, not merely unwired, so there is no path back to two competing PR affordances.
  it("renders nothing at all when no slot is supplied", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.queryByTestId("pr-slot-stub")).toBeNull();
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();
  });

  // The panel the compact menu drops hangs off the HEADER, not off the chip: the concierge is a
  // ~380px column that docks to either side, so a panel anchored near its right edge would leave
  // the window on one of them. That only works if the header is a positioned ancestor.
  it("is a positioned ancestor, so a dropped panel can span the column", () => {
    fullHeader();
    expect(header().style.position).toBe("relative");
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

// ── THE VOICE STRIP: WAVEFORM FULL-WIDTH, CREDIT PILL OVERLAID ────────────────────────────────
// The pill used to be a FLEX SIBLING of the waveform, so it consumed horizontal space and the bars
// were squeezed to `strip − padding − gap − pill` — dying visibly short of the right edge and
// leaving the right of the bar dead. The founder's ask was explicit that the waveform reach the
// edge and the pill float ON it, "not laid out beside it… do not shrink the waveform to make room".
//
// jsdom has no layout engine, so nothing here measures a width — a `getBoundingClientRect` in this
// environment returns zero and would assert nothing. What IS checkable, and is exactly what
// regressed, is the LAYOUT MODEL: whether the pill is in the flow at all.
describe("the voice strip lays the credit pill OVER the waveform", () => {
  const strip = () => screen.getByTestId("concierge-voice-strip");

  it("takes the pill out of the flow entirely, so it consumes no width", () => {
    fullHeader();
    const overlay = screen.getByTestId("concierge-credit-overlay");
    expect(overlay.style.position).toBe("absolute");
    // Absolute against the STRIP, which must therefore be the positioned ancestor — otherwise it
    // escapes to whatever ancestor is positioned and lands somewhere else in the column.
    expect(strip().style.position).toBe("relative");
    expect(strip().contains(overlay)).toBe(true);
    // …and the strip is NOT a flex row any more. That is the mechanism that squeezed the bars: as
    // long as this is a flex container with the pill inside it, the pill takes a share of the line.
    expect(strip().style.display).not.toBe("flex");
  });

  it("cancels LogoWaveform's own side padding on BOTH sides, not just the left", () => {
    fullHeader();
    const slot = screen.getByTestId("concierge-waveform-slot");
    // Only the left inset existed — the other half of why the bars stopped short on the right.
    expect(slot.style.marginLeft).toBe("-14px");
    expect(slot.style.marginRight).toBe(slot.style.marginLeft);
  });

  it("keeps the pill legible over moving bars with a backdrop of its own", () => {
    fullHeader();
    const overlay = screen.getByTestId("concierge-credit-overlay");
    // The column's background is dynamic (it floods on `data-wired`), so a scrim in a fixed colour
    // would be wrong half the time; a local backdrop blur is background-agnostic. It also has to
    // sit ABOVE the bars in z-order, or "overlaid" is just "hidden behind".
    // Read through the index signature: jsdom carries the prefixed property, but the DOM lib's
    // `CSSStyleDeclaration` does not declare it.
    const filter =
      overlay.style.backdropFilter || (overlay.style as unknown as Record<string, string>)["webkitBackdropFilter"];
    expect(filter).toContain("blur");
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(0);
    // Confined to the pill's own box — the waveform underneath is untouched.
    expect(overlay.contains(screen.getByTestId("logo-waveform"))).toBe(false);
  });

  // ── THE GUTTER (bead sparkle-kk9dg.3) ─────────────────────────────────────────────────────
  // Founder, at a narrow concierge column: "The dictation waveform runs right up against
  // '$9972.67' with no separation."
  //
  // MEASURED IN A REAL BROWSER at 190px and 280px (the visual harness's `?concierge=`, painted
  // width asserted): this box hugged `BalanceBadge` EXACTLY — no padding of its own — so the
  // blurred region began where the ink began and the bars ran sharp into the badge's own fill.
  // The blur was never wrong; it had no room. The fix widens the blurred box past the glyphs.
  //
  // jsdom cannot see any of that: there is no layout, `backdrop-filter` composites nothing, and a
  // `getBoundingClientRect` here is 0 (docs/jsdom-test-caveats.md). So these assert the STYLE
  // SHAPE the fix adds — a gutter that did not exist, a blur wider than the 7px that shipped, and
  // the offset that keeps the badge itself where it was. The separation is judged in the capture.
  const paddingX = (el: HTMLElement) => {
    const m = /^\s*\S+\s+(-?\d+(?:\.\d+)?)px\s*$/.exec(el.style.padding);
    if (!m) throw new Error(`credit overlay has no horizontal padding: ${el.style.padding || "(none)"}`);
    return Number(m[1]);
  };

  it("pads the backdrop past the badge's own glyphs, so the bars stop short of the ink", () => {
    fullHeader();
    // The gutter itself. Zero — or the declaration missing altogether — IS the reported defect.
    expect(paddingX(screen.getByTestId("concierge-credit-overlay"))).toBeGreaterThanOrEqual(8);
  });

  it("blurs harder than the 7px that shipped as 'no separation'", () => {
    fullHeader();
    const overlay = screen.getByTestId("concierge-credit-overlay");
    // `?? ""` because the index-signature read is `string | undefined` under
    // `noUncheckedIndexedAccess`, and an absent property must fail the ASSERTION below rather than
    // the compile — a missing blur is exactly what this test exists to catch.
    const filter =
      overlay.style.backdropFilter ||
      (overlay.style as unknown as Record<string, string>)["webkitBackdropFilter"] ||
      "";
    const m = /blur\((\d+(?:\.\d+)?)px\)/.exec(filter);
    expect(m, `no blur radius in ${JSON.stringify(filter)}`).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(7);
  });

  it("casts NO shadow, because the gutter moved its border box off the pill (roborev 58703)", () => {
    fullHeader();
    const overlay = screen.getByTestId("concierge-credit-overlay");
    // A shadow is drawn from the BORDER BOX, and the gutter pushed that box ~10px out past the
    // ink — so a shadow here traces a rounded rectangle with nothing on it instead of lifting the
    // badge. This box paints no fill and no border either, so the ONLY thing it may contribute is
    // the blur. A lift, if one is ever wanted again, belongs on `BalanceBadge`.
    expect(overlay.style.boxShadow === "" || overlay.style.boxShadow === "none").toBe(true);
  });

  it("offsets by the gutter, so the VISIBLE badge keeps the column's 16px inset", () => {
    fullHeader();
    const overlay = screen.getByTestId("concierge-credit-overlay");
    // THE RELATIONSHIP, not two literals. Padding grows this box outward in BOTH directions, so a
    // gutter added without pulling `right` back by the same amount shoves the visible pill left of
    // the search field and the cards under it — fixing the crowding by breaking the column's one
    // vertical edge. `right + gutter` is where the badge's own right edge lands.
    expect(Number(overlay.style.right.replace("px", "")) + paddingX(overlay)).toBe(16);
  });
});

// ── NOTHING BESIDE THE WORDMARK (bead sparkle-ircc3) ────────────────────────────────────────────
//
// The founder, twice, and the second time about the pinned variant specifically:
//
//   "I wanna to be saying all projects, all comm, etcetera, to the right of the sparkle AI. I do
//    not want that. I said I do not want it. … So remove that line. Remove that. It should only be
//    showing the red dot pill when there are issues. It shouldn't say anything else next to the
//    sparkle logo."
//
// So the header's CALM state is the wordmark alone, and the ONE thing allowed to appear beside it
// is the red needs-you pill — only while something actually needs him. These assert the ABSENCE by
// testid AND by read text, because the failure mode this bead is about is a line that survives a
// "make it smaller" fix and keeps rendering. `concierge-vitals-line` / `concierge-needs-dot` were
// ScopeVitals' handles; nothing may reintroduce them here.
describe("the header says NOTHING beside the wordmark", () => {
  /** Every word ScopeVitals could put in this row. None of them may reach the header again. */
  const SCOPE_PROSE = ["All projects", "all calm", "Pinned to", "here", "elsewhere"];

  /** The header, rendered with the shell's handlers but no PR slot — so its text is the column's
   *  own, not a stub's. */
  function headerOnly(over: Partial<ConciergeViewModel> = {}) {
    render(
      <ConciergeColumn
        model={{ ...model, ...over }}
        controller={controller({ onMoveSide: vi.fn(), onNeedsYouFilterToggle: vi.fn() })}
      />,
    );
    return header();
  }

  // ── THE RIGHT CLUSTER MUST STAY ON THE RIGHT ─────────────────────────────────────────────────
  // The deleted scope line was the row's ONLY flexible child. Removing it without replacing its
  // growth packs everything left — the PR chip, avatar and kebab crowd the wordmark with dead space
  // beside them (roborev 57364). jsdom lays nothing out, so the assertable artefact is the token:
  // exactly one growing child, and it is the spacer, sitting before the right-hand cluster.
  it("keeps exactly one growing child, so the right cluster is not dragged to the wordmark", () => {
    const h = headerOnly({ vitals: { needs_you: 0, questions: 0, running: 0, done: 0 } });
    const spacer = screen.getByTestId("concierge-header-spacer");
    expect(h.contains(spacer)).toBe(true);
    expect(spacer.style.flex).toBe("1 1 auto");
    // It states nothing and announces nothing — it exists purely to take up the slack.
    expect(spacer.textContent).toBe("");
    expect(spacer.getAttribute("aria-hidden")).toBe("true");
    // The ONE flexible child: any other `flex-grow` here would split the slack and move the cluster
    // back toward the mark.
    const growing = [...h.children].filter(
      (el) => !/^0/.test((el as HTMLElement).style.flex || "0") && (el as HTMLElement).style.flex,
    );
    expect(growing).toEqual([spacer]);
    // …and it sits BEFORE the right-hand cluster, or it pushes nothing.
    const kebab = screen.getByRole("button", { name: "Settings" });
    expect(
      spacer.compareDocumentPosition(kebab) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("CALM: nothing needs you, so the row carries the wordmark and no words at all", () => {
    const h = headerOnly({ vitals: { needs_you: 0, questions: 0, running: 5, done: 12 } });
    // The mark is still there — this is a deletion of the LINE, not of the header.
    expect(h.contains(screen.getByRole("img", { name: "Sparkle" }))).toBe(true);
    // ScopeVitals' two handles, gone from the whole column, not merely from this row.
    expect(screen.queryByTestId("concierge-vitals-line")).toBeNull();
    expect(screen.queryByTestId("concierge-needs-dot")).toBeNull();
    // …and the red pill too: calm means there is nothing for it to filter.
    expect(screen.queryByTestId("concierge-needs-filter")).toBeNull();
    // Read as a human reads it: the row states nothing. `running: 5` and `done: 12` are carried in
    // the view-model and deliberately unprinted, so a header that grew a "5 running" would fail
    // here as hard as one that kept "All projects".
    for (const phrase of SCOPE_PROSE) expect(h.textContent).not.toContain(phrase);
    expect(h.textContent?.trim()).toBe("");
  });

  it("ALARM: the red pill is the ONLY thing that appears, and it carries the count", () => {
    const h = headerOnly({ vitals: { needs_you: 3, questions: 0, running: 5, done: 12 } });
    const pill = screen.getByTestId("concierge-needs-filter");
    expect(h.contains(pill)).toBe(true);
    expect(pill.textContent).toBe("3");
    expect(pill.getAttribute("aria-label")).toBe("Show only what needs you (3)");
    // The count arriving does NOT bring the line back with it.
    expect(screen.queryByTestId("concierge-vitals-line")).toBeNull();
    expect(screen.queryByTestId("concierge-needs-dot")).toBeNull();
    for (const phrase of SCOPE_PROSE) expect(h.textContent).not.toContain(phrase);
    // The pill's numeral is the row's ENTIRE text — nothing else writes into this row.
    expect(h.textContent?.trim()).toBe("3");
  });

  it("PINNED: a pinned scope still prints nothing — this is the one he complained about last", () => {
    const h = headerOnly({
      scope: { pinnedProjectName: "sparkle-desktop-experiments" },
      vitals: { needs_you: 0, questions: 0, running: 2, done: 0 },
    });
    // The pin is still MODELLED — `scope.pinnedProjectName` is fed and simply not printed here.
    // Where a human sees it instead: the project tab's solid, rotated, accent-ink pin
    // (ProjectTabs.tsx `.concierge-tab-pin[data-pinned="true"]`), pinned by ProjectTabs.test.tsx.
    expect(h.textContent?.trim()).toBe("");
    expect(h.textContent).not.toContain("Pinned to");
    expect(h.textContent).not.toContain("sparkle-desktop");
    expect(screen.queryByTestId("concierge-vitals-line")).toBeNull();
  });

  it("no per-project switch buttons anywhere: the split moved out of the header entirely", () => {
    headerOnly({
      vitals: { needs_you: 3, questions: 0, running: 0, done: 0 },
      needsYouByProject: [
        { projectId: "p1", projectName: "web", needsYou: 2, isActive: true },
        { projectId: "p2", projectName: "mobile", needsYou: 1, isActive: false },
      ],
    });
    // `needsYouByProject` is still carried by the view-model (ConciergeHost keeps feeding it); the
    // header just no longer renders a segment per project.
    expect(screen.queryByRole("button", { name: /^Switch to / })).toBeNull();
    expect(screen.queryByText("2 here")).toBeNull();
    expect(screen.queryByText("1 in mobile")).toBeNull();
  });
});
