// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StatusBand } from "../engine/buildSections";
import { bandColor } from "../engine/statusBandLabels";
import { C, INK_MIN_CONTRAST, CONTROL_MIN_CONTRAST, THEME_HEX } from "../theme/colors";
import { asRgb } from "./statusDotTestUtils";
import {
  ProjectTabs,
  pinTitle,
  tabBadgeCount,
  tabBand,
  TAB_LABEL_MAX_WIDTH,
} from "./ProjectTabs";

/** WCAG relative luminance / contrast for a #rrggbb pair — the same arithmetic
 *  theme/chromeContrast.test.ts uses, kept local so this file's colour floors are self-contained. */
function luminance(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Counts with only the named bands set — a tab takes the full per-band Record. */
function counts(over: Partial<Record<StatusBand, number>> = {}): Record<StatusBand, number> {
  return { needs_you: 0, questions: 0, running: 0, done: 0, ...over };
}

const projects = [
  { id: "sparkle", name: "sparkle" },
  { id: "website", name: "drodio-website" },
];

afterEach(() => {
  cleanup();
  // The stylesheet is injected into the shared jsdom <head> and persists across tests; remove it so
  // the "injected exactly once" test genuinely exercises the dedupe guard from a clean slate.
  document.getElementById("concierge-tabs-styles")?.remove();
});

function renderTabs(overrides: Partial<Parameters<typeof ProjectTabs>[0]> = {}) {
  const onSelect = vi.fn();
  const onTogglePin = vi.fn();
  const onAddProject = vi.fn();
  render(
    <ProjectTabs
      projects={projects}
      selectedProjectId="sparkle"
      pinnedProjectId={null}
      countsByProject={{}}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onAddProject={onAddProject}
      {...overrides}
    />,
  );
  return { onSelect, onTogglePin, onAddProject };
}

describe("pure helpers", () => {
  it("pinTitle describes the action (pin vs unpin)", () => {
    expect(pinTitle(false)).toMatch(/disregard all other project alerts/i);
    expect(pinTitle(true)).toMatch(/across all projects again/i);
  });
  it("tabBand: only Needs-you badges — running and done never do", () => {
    expect(tabBand(undefined)).toBeNull();
    expect(tabBand(counts())).toBeNull();
    expect(tabBand(counts({ needs_you: 1 }))).toBe("needs_you");
    // A tab that glowed while anything was merely working would glow permanently, and a signal
    // that is always on is not a signal.
    expect(tabBand(counts({ running: 4, done: 9 }))).toBeNull();
  });
});

describe("ProjectTabs", () => {
  it("renders a tab per project and marks the selected one", () => {
    renderTabs();
    expect(screen.getByTestId("tab-sparkle").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-website").getAttribute("aria-selected")).toBe("false");
  });

  it("clicking a tab selects that project", () => {
    const { onSelect } = renderTabs();
    fireEvent.click(screen.getByTestId("tab-website"));
    expect(onSelect).toHaveBeenCalledWith("website");
  });

  it("clicking the pin toggles pin and does NOT select the tab", () => {
    const { onSelect, onTogglePin } = renderTabs();
    fireEvent.click(screen.getByTestId("pin-website"));
    expect(onTogglePin).toHaveBeenCalledWith("website");
    expect(onSelect).not.toHaveBeenCalled();
  });

  // ── THE BADGE: ● N ON THE TABS YOU ARE NOT LOOKING AT, AND NOTHING ON THE ONE YOU ARE ──────────
  // These assert the SIDE EFFECT of the rule, not its precondition. The first one is the load-
  // bearing case: the active tab's count is nonzero, so every input that used to produce a badge is
  // still present and only the new rule suppresses it. Written the other way round — "the active
  // tab is calm, so no badge" — it would have passed before the change too.

  it("the ACTIVE tab shows NO badge and NO count text, even with agents needing you", () => {
    // `sparkle` is selected AND has 3 needing you. Deleting the `active` guard in `tabBadgeCount`
    // brings a "3" back onto this tab, which is what this test exists to catch.
    renderTabs({
      selectedProjectId: "sparkle",
      countsByProject: { sparkle: counts({ needs_you: 3, running: 1 }) },
    });
    expect(screen.queryByTestId("count-sparkle")).toBeNull();
    // Not just the badge element — no digit from that count reaches the tab at all. The label is
    // "sparkle", so a stray "3" anywhere in the tab is the count leaking back by another route.
    expect(screen.getByTestId("tab-sparkle").textContent).toBe("sparkle");
  });

  it("an INACTIVE tab with a nonzero count shows the band dot and the bare number", () => {
    renderTabs({ countsByProject: { website: counts({ needs_you: 2, running: 1 }) } });
    const badge = screen.getByTestId("count-website");
    // The NUMBER only — "2", never "2 Need you". A regression that restores the phrase changes this.
    expect(badge.textContent).toBe("2");
    // …and it counts `needs_you`, not the 1 running beside it.
    const dot = screen.getByTestId("band-badge-needs_you").firstElementChild as HTMLElement;
    // The dot is the BAND's own paint — the same fill the agent rows' dots and the filter chips
    // take — so the badge is a legend for exactly the rows it counts. `asRgb`, because jsdom
    // normalises a hex background to rgb().
    expect(dot.style.background).toBe(asRgb(bandColor("needs_you")));
    expect(dot.style.width).toBe("8px");
    expect(dot.style.borderRadius).toBe("50%");
  });

  it("an inactive tab whose count is ZERO shows no badge", () => {
    renderTabs({ countsByProject: { website: counts({ needs_you: 0, questions: 0, running: 3, done: 5 }) } });
    expect(screen.queryByTestId("count-website")).toBeNull();
    expect(screen.getByTestId("tab-website").textContent).toBe("drodio-website");
  });

  it('the words "Needs you" are nowhere in the tab strip', () => {
    // Both tabs badged and one of them plural, so every branch of the old phrase renders if it is
    // still there at all. This is the founder's line: the badge is a dot and a number, never a
    // sentence — the filter chips below the strip are where the bands are named.
    renderTabs({
      selectedProjectId: "sparkle",
      countsByProject: {
        sparkle: counts({ needs_you: 4 }),
        website: counts({ needs_you: 1 }),
      },
    });
    const strip = screen.getByRole("tablist").textContent ?? "";
    expect(strip).not.toMatch(/needs? you/i);
    // Guard the guard: the assertion above is worthless if nothing is rendering. The one badged
    // (inactive) tab must still be showing its number.
    expect(screen.getByTestId("count-website").textContent).toBe("1");
  });

  it("keeps the whole phrase as the badge's ACCESSIBLE name — the words are dropped VISUALLY only", () => {
    // A red dot and a bare "1" is punctuation-plus-a-digit to a screen reader. The phrase moves to
    // the accessible name rather than being deleted, and it still agrees in number.
    const { rerender } = render(
      <ProjectTabs
        projects={projects}
        selectedProjectId="sparkle"
        pinnedProjectId={null}
        countsByProject={{ website: counts({ needs_you: 1 }) }}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "1 Needs you" })).toBeTruthy();
    rerender(
      <ProjectTabs
        projects={projects}
        selectedProjectId="sparkle"
        pinnedProjectId={null}
        countsByProject={{ website: counts({ needs_you: 3 }) }}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "3 Need you" })).toBeTruthy();
    // No `title`: a tooltip is VISIBLE chrome, so spelling the phrase out on hover would put the
    // words back on screen through the side door.
    expect(screen.getByTestId("count-website").hasAttribute("title")).toBe(false);
    expect(screen.getByTestId("band-badge-needs_you").hasAttribute("title")).toBe(false);
  });

  it("paints the numeral with the themed alarm ink, which the band's raw red cannot replace", () => {
    renderTabs({ countsByProject: { website: counts({ needs_you: 2 }) } });
    expect(screen.getByTestId("band-badge-needs_you").style.color).toBe(C.dangerInk);
  });

  it("…and that ink clears AA on the tab strip in BOTH themes, where the band's red does not", () => {
    // The reason the line above is not just a preference. Asserted as a measurement in both
    // directions so neither half can be reverted to "the band colour is fine here".
    for (const mode of ["dark", "light"] as const) {
      const hex = THEME_HEX[mode];
      expect(
        contrast(hex.dangerInk, hex.barSurface),
        `${mode}: the tab badge's numeral is unreadable on the tab strip`,
      ).toBeGreaterThanOrEqual(INK_MIN_CONTRAST);
      expect(
        contrast(bandColor("needs_you"), hex.barSurface),
        `${mode}: the band's raw red now clears AA as text — this override may be retired`,
      ).toBeLessThan(INK_MIN_CONTRAST);
      // The DOT is a shape, not text, so it is held to the non-text control floor instead — and it
      // has to clear that, or the thing carrying the alarm is invisible on the strip.
      expect(
        contrast(bandColor("needs_you"), hex.barSurface),
        `${mode}: the badge's dot is invisible on the tab strip`,
      ).toBeGreaterThanOrEqual(CONTROL_MIN_CONTRAST);
    }
  });

  describe("tabBadgeCount", () => {
    it("is null on the active tab whatever the count, and the count otherwise", () => {
      expect(tabBadgeCount(counts({ needs_you: 5 }), true)).toBeNull();
      expect(tabBadgeCount(counts({ needs_you: 5 }), false)).toBe(5);
      expect(tabBadgeCount(counts({ needs_you: 0 }), false)).toBeNull();
      // Running and done never badge — same rule `tabBand` already owns, asserted through here so
      // the two cannot drift.
      expect(tabBadgeCount(counts({ running: 4, done: 9 }), false)).toBeNull();
      expect(tabBadgeCount(undefined, false)).toBeNull();
    });
  });

  it("renders the add-project button and the top-right cluster", () => {
    const { onAddProject } = renderTabs({ topRight: <div data-testid="kebab" /> });
    fireEvent.click(screen.getByTestId("tab-add"));
    expect(onAddProject).toHaveBeenCalled();
    expect(screen.queryByTestId("kebab")).not.toBeNull();
  });

  it("marks the pinned project's pin visible (data-pinned) and others not", () => {
    renderTabs({ pinnedProjectId: "website" });
    expect(screen.getByTestId("pin-website").getAttribute("data-pinned")).toBe("true");
    expect(screen.getByTestId("pin-sparkle").getAttribute("data-pinned")).toBe("false");
  });

  // ── THIS TAB IS NOW THE ONLY PLACE PINNING IS VISIBLE (bead sparkle-ircc3) ────────────────────
  //
  // The concierge header used to say "Pinned to <name>" beside the Sparkle wordmark. The founder
  // asked for that line gone, so the pinned tab's pin is what tells a user the concierge is scoped
  // to one project — and the test above proves only that the ATTRIBUTE is set, which is the hook,
  // not the appearance. A pinned pin painted `C.muted` at opacity 0 would pass it while pinning
  // became invisible app-wide. These assert what a human actually sees:
  //   • ACCENT INK on the pinned pin and muted on every other — inline, so jsdom reads it directly.
  //   • FULL OPACITY + the 45° rotate, and the `:not([data-pinned="true"])` that keeps the hover
  //     rule from dimming a pinned pin to .65. jsdom runs no cascade, so the rule TEXT is the
  //     assertable artefact — and that `:not()` is the whole reason the pinned pin stays solid.
  it("paints the pinned pin solid accent ink, held at full opacity — pinning's only remaining tell", () => {
    renderTabs({ pinnedProjectId: "website" });
    expect(screen.getByTestId("pin-website").style.color).toBe(C.accentInk);
    expect(screen.getByTestId("pin-sparkle").style.color).toBe(C.muted);
    expect(C.accentInk).not.toBe(C.muted);

    const css = document.getElementById("concierge-tabs-styles")!.textContent!;
    // The pinned pin's own rule: fully opaque and rotated, so it reads as a driven-in pin.
    expect(css).toMatch(/\.concierge-tab-pin\[data-pinned="true"\][^}]*opacity:\s*1/);
    expect(css).toMatch(/\.concierge-tab-pin\[data-pinned="true"\][^}]*rotate\(45deg\)/);
    // …and BOTH reveal selectors EXCLUDE it, or the pinned pin gets dimmed to .65 the moment a
    // neighbouring tab is hovered or focused. `:focus-within` is checked as hard as `:hover`
    // because it is the MORE dangerous of the two: `.concierge-tab:focus-within
    // .concierge-tab-pin` scores (0,3,0) against the pinned rule's (0,2,0), so dropping the
    // `:not()` from that line alone wins the cascade outright (roborev 57364).
    const revealRules = css.split("\n").filter((l) => /(:hover|:focus-within) \.concierge-tab-pin/.test(l));
    // Assert the filter MATCHED before looping: a zero-match filter runs zero assertions and passes
    // vacuously, so a rename or a reflow of these selectors would silently retire this check.
    expect(revealRules).toHaveLength(2);
    for (const rule of revealRules) expect(rule).toContain(':not([data-pinned="true"])');
  });

  it("injects the hover-reveal stylesheet exactly once", () => {
    renderTabs();
    renderTabs(); // a second mount must not duplicate the <style>
    expect(document.querySelectorAll("#concierge-tabs-styles").length).toBe(1);
    // the reveal is CSS-driven, not inline opacity (the inline-opacity bug that hid pins on hover).
    expect(document.getElementById("concierge-tabs-styles")!.textContent).toMatch(/:hover .concierge-tab-pin/);
  });

  it("is keyboard-operable: Enter on a tab selects it", () => {
    const { onSelect } = renderTabs();
    fireEvent.keyDown(screen.getByTestId("tab-website"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("website");
  });
});

// A long folder name used to WRAP, making that one tab two rows tall while its neighbours stayed
// one row — the bar grew and the tabs stopped lining up. Names must ellipsize on a single line.
describe("ProjectTabs — long names truncate rather than wrap", () => {
  const longName = "sparkle-desktop-experimental-rewrite-with-a-very-long-folder-name";

  it("clamps the label to one line with an ellipsis", () => {
    renderTabs({ projects: [{ id: "long", name: longName }] });
    const label = screen.getByTestId("tab-label-long");
    expect(label.style.whiteSpace).toBe("nowrap");
    expect(label.style.textOverflow).toBe("ellipsis");
    expect(label.style.overflow).toBe("hidden");
    expect(label.style.maxWidth).toBe(`${TAB_LABEL_MAX_WIDTH}px`);
  });

  it("keeps the FULL name available on hover, so truncation loses nothing", () => {
    renderTabs({ projects: [{ id: "long", name: longName }] });
    expect(screen.getByTestId("tab-label-long").textContent).toBe(longName);
    expect(screen.getByTestId("tab-long").getAttribute("title")).toContain(longName);
  });

  it("applies the same clamp to short names, so every tab is exactly one row tall", () => {
    renderTabs();
    for (const p of projects) {
      expect(screen.getByTestId(`tab-label-${p.id}`).style.whiteSpace).toBe("nowrap");
    }
  });
});

// The close control. Presentational half only — what closing DOES to the stores is
// ProjectTabsBar.close.test.tsx's job.
describe("the close ×", () => {
  it("renders no close control at all when onClose is omitted", () => {
    // The pre-close tab bar. Callers that don't pass it get exactly the old markup.
    renderTabs();
    expect(screen.queryByTestId("close-sparkle")).toBeNull();
  });

  it("calls onClose with the project id", () => {
    const onClose = vi.fn();
    renderTabs({ onClose });
    fireEvent.click(screen.getByTestId("close-website"));
    expect(onClose).toHaveBeenCalledWith("website");
  });

  it("closing a tab does NOT also select it", () => {
    // Both handlers stopPropagation: a <button> turns Enter/Space into a click, and BOTH events
    // bubble to the tab's own onClick/onKeyDown.
    const onClose = vi.fn();
    const { onSelect } = renderTabs({ onClose });
    fireEvent.click(screen.getByTestId("close-website"));
    expect(onClose).toHaveBeenCalledWith("website");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closing via the keyboard does not select the tab either", () => {
    const onClose = vi.fn();
    const { onSelect } = renderTabs({ onClose });
    const btn = screen.getByTestId("close-website");
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.keyDown(btn, { key: " " });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("double-clicking × does not open project settings", () => {
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    renderTabs({ onClose, onOpenSettings });
    fireEvent.doubleClick(screen.getByTestId("close-website"));
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("is a real button with a per-project accessible name", () => {
    // Keyboard-reachable by construction, and N tabs must not present N identical "Close" buttons.
    // The name also says what closing does NOT do — a bare × beside a project reads as "delete".
    renderTabs({ onClose: vi.fn() });
    const btn = screen.getByTestId("close-website");
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-label")).toBe(
      "Close drodio-website — the project and its agents are kept",
    );
    expect(btn.getAttribute("title")).toBe(btn.getAttribute("aria-label"));
    // Reachable by NAME, not just by test id — this is the screen-reader/keyboard contract.
    expect(screen.getByRole("button", { name: /Close drodio-website/ })).toBe(btn);
  });

  it("keeps the × visible on the ACTIVE tab, and hover-reveals it on the others", () => {
    // A permanently-hidden control is an undiscoverable one; an always-visible one on every tab
    // makes an idle bar noisy. data-active drives the CSS rule that splits the two.
    renderTabs({ onClose: vi.fn() });
    expect(screen.getByTestId("close-sparkle").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("close-website").getAttribute("data-active")).toBe("false");
    const css = document.getElementById("concierge-tabs-styles")!.textContent!;
    expect(css).toContain(".concierge-tab:focus-within .concierge-tab-close");
    expect(css).toContain('.concierge-tab-close[data-active="true"]');
  });
});
// ── THE GLOW IS NOW THE ACTIVE TAB'S ONLY ALARM ───────────────────────────────────────────────
//
// Suppressing the badge on the active tab makes the glow load-bearing there — and nothing in this
// file or ProjectTabsBar.test.tsx asserted it existed. The plausible follow-up ("make the glow
// consistent with the badge and suppress it there too", or a restyle that drops `boxShadow`) would
// leave a selected project whose agents need you showing NO alarm in any modality, with the whole
// suite green. The commit that suppressed the badge called the glow "deliberately untouched"; that
// is exactly the kind of load-bearing decision every other rule here pins as a side effect
// (roborev 55307).
describe("ProjectTabs — the active tab keeps its glow", () => {
  it("glows when the SELECTED project has agents needing you, badge or no badge", () => {
    renderTabs({
      selectedProjectId: "sparkle",
      countsByProject: { sparkle: counts({ needs_you: 3 }) },
    });
    const tab = screen.getByTestId("tab-sparkle");
    expect(tab.style.boxShadow).not.toBe("");
    // The same red the dots and chips use — one alarm vocabulary, not a bespoke tab colour.
    // Compared as HEX, not via `asRgb`: jsdom normalises `background` to rgb() but leaves
    // `boxShadow` as authored, and the glow appends an alpha suffix to the token.
    expect(tab.style.boxShadow).toContain(bandColor("needs_you"));
    // …and the badge really is suppressed, so the glow is genuinely carrying it alone.
    expect(screen.queryByTestId("count-sparkle")).toBeNull();
  });

  it("does NOT glow when the selected project is calm", () => {
    renderTabs({
      selectedProjectId: "sparkle",
      countsByProject: { sparkle: counts({ running: 3, done: 5 }) },
    });
    expect(screen.getByTestId("tab-sparkle").style.boxShadow).toBe("");
  });
});

