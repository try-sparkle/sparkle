// @vitest-environment jsdom
//
// The bar in isolation. `AgentSidebar.stageLadder.test.tsx` already covers what the chips DO to the
// ladder; what is pinned here is the presentation contract the chips carry on their own — the count
// on the surface, the sentence in the accessible name, and the fact that the ● N comes from the
// shared `BandBadge` rather than a fourth local copy of "dot plus number".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusFilterBar } from "./StatusFilterBar";
import { allBandsVisible, type StatusBand } from "../engine/buildSections";
import { bandColor } from "../engine/statusBandLabels";
import { C, statusInk } from "../theme/colors";
import { asRgb } from "./statusDotTestUtils";

afterEach(cleanup);

const counts: Record<StatusBand, number> = { needs_you: 3, running: 2, done: 5 };

function renderBar(over: Partial<Parameters<typeof StatusFilterBar>[0]> = {}) {
  const props = { counts, visible: allBandsVisible(), onToggle: vi.fn(), onReset: vi.fn(), ...over };
  render(<StatusFilterBar {...props} />);
  return props;
}

describe("StatusFilterBar — what the chip shows", () => {
  it("shows the COUNT on the chip and the whole phrase in the accessible name", () => {
    // The phrase must never be rebuilt from parts for styling — assembling it from a count span and
    // a label span is what once shipped "3 Needs you". `bandCountLabel` hands it over whole.
    renderBar();
    const chip = screen.getByTestId("status-chip-needs_you");
    expect(chip.textContent).toBe("3");
    expect(chip.getAttribute("aria-label")).toContain("3 Need you");
    expect(chip.getAttribute("title")).toContain("3 Need you");
  });

  it("inflects at n = 1 — the boundary the shared helper owns", () => {
    renderBar({ counts: { ...counts, needs_you: 1 } });
    const label = screen.getByTestId("status-chip-needs_you").getAttribute("aria-label");
    expect(label).toContain("1 Needs you");
    expect(label).not.toContain("1 Need you —");
  });

  it("renders the SHARED BandBadge, not a local dot-and-number", () => {
    // The point of the extraction: if this chip ever grows its own dot again, the colour rule can
    // drift from the badge the concierge and the tabs are meant to converge on.
    renderBar();
    for (const band of ["needs_you", "running", "done"] as const) {
      const chip = screen.getByTestId(`status-chip-${band}`);
      expect(chip.contains(screen.getByTestId(`band-badge-${band}`))).toBe(true);
    }
  });

  it("announces the count ONCE — the badge inside the chip is silent", () => {
    // The button already carries "3 Need you — showing, click to hide". A badge contributing its own
    // accessible name would make a screen reader say the count twice per chip.
    renderBar();
    expect(screen.queryAllByRole("img", { name: /Need you|Running|Done/ })).toHaveLength(0);
  });

  it("keeps an OFF chip's count visible — nothing is silently lost behind a filter", () => {
    renderBar({ visible: { needs_you: false, running: true, done: true } });
    const chip = screen.getByTestId("status-chip-needs_you");
    expect(chip.getAttribute("data-on")).toBe("false");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.textContent).toBe("3");
  });

  it("inks the count per state: the band's own ink when ON, muted when OFF", () => {
    // The chip's `color` moved off the button and onto the badge's `ink` prop, and neither end had
    // a test on the RESULT (roborev 54026): BandBadge only proved the prop is honoured, and the
    // assertions above read data-on/textContent. Deleting the prop, or passing it unconditionally,
    // would leave the suite green while every chip painted as equally live.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={allBandsVisible()}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("band-badge-needs_you").style.color).toBe(
      asRgb(statusInk(bandColor("needs_you"))),
    );
    rerender(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: false, running: true, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByTestId("band-badge-needs_you").style.color).toBe(C.muted);
  });

  it("dims an OFF chip with INK, never with opacity — opacity composites the count", () => {
    // The same defect the Plan/Build strip's 0.9 had (roborev 54038): an opacity on the button
    // multiplies against whatever ink the badge resolved, so the OFF count was landing at 2.24:1 on
    // light's sidebar rather than the token's own 3.86:1. The empty string, not "1": that is the
    // only value that proves the property was never set rather than set back to a safe-looking one.
    renderBar({ visible: { needs_you: false, running: true, done: true } });
    expect(screen.getByTestId("status-chip-needs_you").style.opacity).toBe("");
    expect(screen.getByTestId("status-chip-running").style.opacity).toBe("");
  });
});

describe("StatusFilterBar — Reset", () => {
  it("stays hidden while every band is showing — but MOUNTED", () => {
    // The slot is permanent: unmounting it destroys the element under the cursor and, for a
    // keyboard user, blurs it on the very click that succeeds — stranding focus on <body>. So
    // "not offered" is asserted as the state a user can perceive, not as absence from the DOM.
    renderBar();
    const reset = screen.getByTestId("status-filter-reset") as HTMLButtonElement;
    expect(reset.style.visibility).toBe("hidden");
    expect(reset.disabled).toBe(true);
  });

  it("appears as soon as ANY band is hidden, and calls the shared clear action", () => {
    // Not a second filter state: the integration passes uiStore.showAllStatusBands, the same action
    // the concierge scope line and the helper island's chiclets write.
    const props = renderBar({ visible: { needs_you: true, running: false, done: true } });
    // Pin the POSITIVE state too. Since the slot is permanent, presence in the DOM no longer
    // distinguishes offered from not-offered, and `fireEvent.click` succeeds on a hidden button —
    // so without these, hard-coding `visibility: "hidden"` would leave the suite green while the
    // user had no way back out of the filter (roborev 54140).
    const reset = screen.getByTestId("status-filter-reset") as HTMLButtonElement;
    expect(reset.style.visibility).toBe("visible");
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it("re-homes by ROLE, not by data-testid — survives a testid-stripping build", () => {
    // Strips every data-testid before the transition, so the helper can only find the chip through
    // role/aria. If it regressed to `[data-testid^="status-chip-"]` this fails, whereas a test that
    // also queried by testid would keep passing and report nothing (roborev 54140).
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const bar = screen.getByTestId("status-filter-bar");
    const reset = bar.querySelector<HTMLButtonElement>("button:last-of-type")!;
    reset.focus();
    for (const el of Array.from(bar.querySelectorAll("[data-testid]"))) el.removeAttribute("data-testid");
    bar.removeAttribute("data-testid");
    reset.blur();
    fireEvent.blur(reset);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement)?.getAttribute("aria-pressed")).toBeTruthy();
  });

  it("stays reachable at minimum sidebar width — the row wraps rather than overflowing", () => {
    // jsdom does no layout, so this pins the style contract instead of a measured width. The chips
    // are content-sized and Reset is `nowrap`, so nothing in the row can shrink; at MIN_WIDTH 160
    // the list's `overflowY: auto` makes overflow-x `auto` too and `marginLeft: auto` collapses,
    // which would push Reset — the one way back out of the filter — off the visible edge.
    renderBar({ visible: { needs_you: true, running: false, done: true } });
    expect(screen.getByTestId("status-filter-bar").style.flexWrap).toBe("wrap");
    expect(screen.getByTestId("status-chip-running").style.flex).toBe("0 0 auto");
  });
});

describe("StatusFilterBar — toggling", () => {
  it("multi-select: each chip toggles only its own band", () => {
    const props = renderBar({ visible: { needs_you: true, running: false, done: true } });
    fireEvent.click(screen.getByTestId("status-chip-done"));
    expect(props.onToggle).toHaveBeenCalledWith("done");
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("StatusFilterBar — Reset focus re-homing", () => {
  // Reset retires when the last hidden band comes back, so the control the user just acted on
  // disappears. These rows pin that focus is re-homed onto the first chip rather than stranded on
  // <body>, across BOTH engine orderings — WebKit clears focus on mousedown (before any commit),
  // Chrome after it — and that the claim never steals focus it has no call on.
  // Restore the monotonic-clock stub unconditionally: a failing row would otherwise leak it.
  afterEach(() => vi.restoreAllMocks());

  // Model the HTML focus-fixup rule, which jsdom does not implement: setting `disabled` on the
  // focused element moves focus to <body>. The order matters — the component must be re-rendered
  // with `disabled` already true (that is how the real fixup is distinguished from the user
  // leaving on their own), and `activeElement` must actually end up off the button, which is what
  // makes an implementation that merely SAMPLES `document.activeElement` in an effect fail here as
  // it does in a browser.
  //
  // Focus moves by focusing <body> rather than calling `el.blur()`: jsdom's `blur()` is a no-op on
  // an already-disabled element, and blurring first, while still enabled, would dispatch exactly
  // the "user left on their own" event this is not.
  const fixupBlur = (el: HTMLButtonElement) => {
    el.disabled = true;
    document.body.tabIndex = -1;
    document.body.focus();
  };

  it("hands focus to the first chip when Reset fires — never back to <body>", () => {
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    fireEvent.click(reset);
    fixupBlur(reset as HTMLButtonElement);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement).toBe(screen.getByTestId("status-chip-needs_you"));
    // …and the slot itself survives the state change, so the row does not re-flow around it.
    expect(screen.getByTestId("status-filter-reset")).toBe(reset);
  });

  it("re-homes focus when a CHIP clears the last hidden band — Reset's onClick never runs", () => {
    // The path an onClick-based fix misses, and it is reachable on this app's platform: WebKit
    // does not focus a <button> on mouse click, so focus can legitimately sit on Reset (tabbed to)
    // while the user clicks the last hidden chip back on. Reset then hides underneath the focus
    // with no click of its own.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    fixupBlur(reset as HTMLButtonElement);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement).toBe(screen.getByTestId("status-chip-needs_you"));
  });

  it("re-homes focus on the WEBKIT ordering — blur fires while still ENABLED, then the state clears", async () => {
    // The platform case, and the one the previous rule got wrong (roborev 54058). WKWebView and
    // Safari clear focus on MOUSEDOWN — before React commits anything — so the blur arrives with
    // the button still enabled, and NO second blur follows once `disabled` is set, because the
    // button no longer holds focus. A rule that read `disabled` at blur time therefore cleared the
    // flag here and no-oped, leaving focus on <body>: exactly the bug the tracking exists to fix,
    // invisible in Chrome (which blurs after the commit) and in jsdom.
    //
    // No timer flush between the blur and the rerender — that is the point. The transition happens
    // in the same task as the interaction, so the deferred clear must NOT have run yet.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    expect(document.activeElement).toBe(reset);
    // The real order: pointerdown lands on the last hidden chip — INSIDE the bar, which must NOT
    // end the claim — and only then does WebKit clear focus, while the button is STILL ENABLED.
    fireEvent.pointerDown(screen.getByTestId("status-chip-running"));
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    reset.blur();
    fireEvent.blur(reset);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    // Re-homed onto the chip group rather than abandoned on <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("data-testid")).toMatch(/^status-chip-/);
  });

  it("re-homes across the real MOUSE GAP — blur on mousedown, state clears on a later task", async () => {
    // The sequence a WebKit mouse click actually produces, and the one a 0 ms deferred clear got
    // wrong (roborev 54066): focus is cleared on MOUSEDOWN, and the state change arrives on CLICK
    // — a different task, however long the user holds the button. The claim must span that.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    reset.blur();
    fireEvent.blur(reset);
    // A macrotask elapses between mousedown and click — this is the gap, not an expiry.
    await new Promise((r) => setTimeout(r, 0));
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("data-testid")).toMatch(/^status-chip-/);
  });

  it("does NOT steal focus from a chip the user just clicked (Chrome mousedown-focus ordering)", () => {
    // The other engine, and the failure the deferred clear could otherwise introduce (roborev
    // 54064). Chrome focuses a <button> on MOUSEDOWN, so clicking the last hidden chip blurs Reset
    // WHILE ENABLED and focuses the chip — same interaction, same task, flag still set. Re-homing
    // on that would yank focus off the control the user just clicked, and their next Space/Enter
    // would toggle the wrong band. The effect's "is focus nowhere useful?" read is what prevents it.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    // Chrome ordering: mousedown focuses the chip, which blurs Reset while it is still enabled.
    const clicked = screen.getByTestId("status-chip-running");
    clicked.focus();
    fireEvent.blur(reset);
    // Same task as the interaction — no timer flush, so the flag is still set.
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement).toBe(clicked);
  });

  it("keeps the claim when an outside press CANCELS the focus change (resize-handle case)", () => {
    // AgentSidebar.startResize calls preventDefault() on mousedown, so focus never leaves Reset and
    // no blur follows. A rule that destroyed the claim at pointerdown would strand focus on the
    // next keyboard Reset, with nothing to re-arm it (roborev 54080). Recording at pointerdown and
    // deciding at blur means "no blur" correctly leaves the claim live.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside); // press cancelled: NO blur follows, focus stays on Reset
    fireEvent.pointerUp(outside); // press ends with Reset STILL focused -> the note is forgotten
    reset.blur(); // now the user hits Enter on Reset; the fixup blurs the disabled button
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement?.getAttribute("data-testid") ?? "").toMatch(/^status-chip-/);
    outside.remove();
  });

  it("keeps the claim when a cancelled press ends in POINTERCANCEL (touch becomes a scroll)", () => {
    // A touch/pen press that turns into a scroll never dispatches pointerup, so a note forgotten
    // only on pointerup would latch and strand the next keyboard Reset (roborev 54086).
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.pointerCancel(outside); // gesture taken over; focus never left Reset
    reset.blur();
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement?.getAttribute("data-testid") ?? "").toMatch(/^status-chip-/);
    outside.remove();
  });

  it("focusin drops a STAMPED claim when relatedTarget could not answer (the fallback path)", () => {
    // The defence-in-depth branch. Engines that leave relatedTarget unpopulated (older WKWebView
    // focusout quirks, shadow-DOM retargeting, cross-document moves) reach onBlur with `to === null`
    // and stamp a LIVE claim; focus then genuinely lands outside. Without the focusin drop that
    // claim survives, and an unrelated clear within the window yanks focus into the bar
    // (roborev 54099/54108).
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    reset.blur();
    fireEvent.blur(reset); // NO relatedTarget -> the claim is stamped finite, not dropped
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus(); // real focusin on a real element outside the bar -> drops the stamped claim
    outside.blur();
    outside.remove();
    expect(document.activeElement).toBe(document.body);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement?.getAttribute("data-testid") ?? "").not.toMatch(/^status-chip-/);
  });

  it("drops the claim when focus TABS AWAY to a real element outside the bar", () => {
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    // REAL ORDER: focusout fires BEFORE focusin on the new target, so at blur time the capture
    // listener has not seen the departure yet. Only `relatedTarget` can answer here — which is
    // exactly why the decision lives at the blur rather than waiting for focusin (roborev 54086).
    fireEvent.blur(reset, { relatedTarget: outside });
    outside.focus();
    // Now send focus NOWHERE before the clear. Without this the assertion would pass on the
    // focus-is-nowhere guard alone and could not see the claim at all (roborev 54086).
    outside.blur();
    outside.remove();
    expect(document.activeElement).toBe(document.body);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement?.getAttribute("data-testid") ?? "").not.toMatch(/^status-chip-/);
  });

  it("KEEPS the claim when focus leaves Reset for a chip INSIDE the bar", () => {
    // Pins the containment half of the relatedTarget decision. Without `!contains(to)` any real
    // relatedTarget would read as a departure, killing the primary in-bar interaction — and no
    // other row catches it, because the rows that need a live claim blur with relatedTarget null
    // and take the note fallback instead (roborev 54099).
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    const chip = screen.getByTestId("status-chip-running");
    // Focus moves to a chip INSIDE the bar — the claim must survive this.
    fireEvent.blur(reset, { relatedTarget: chip });
    // Then focus really goes nowhere, so the assertion turns on the claim and not on the guard.
    // (If containment were dropped, the blur above would have nulled the claim and this second,
    // relatedTarget-less blur would return early rather than re-stamping — so the row still fails.)
    reset.blur();
    expect(document.activeElement).toBe(document.body);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement?.getAttribute("data-testid") ?? "").toMatch(/^status-chip-/);
  });

  it("does NOT pull focus into the bar when the clear came from ANOTHER surface", () => {
    // showAllStatusBands() is also called by ConciergeHost's reveal and digest-click paths. On
    // WebKit a click leaves activeElement on <body> as the NORMAL state, so a time-only claim
    // could not tell that clear apart from the fixup and would yank focus into this sidebar,
    // competing with the tab that was just opened (roborev 54070). The capture-phase pointerdown
    // outside the bar is what distinguishes them.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    // The user mouses over to a surface outside the bar and presses there.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    reset.blur();
    fireEvent.blur(reset);
    // That surface clears the bands.
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement?.getAttribute("data-testid") ?? "").not.toMatch(/^status-chip-/);
    outside.remove();
  });

  it("leaves focus alone when the user TABBED AWAY from Reset before the filter cleared", () => {
    // The other half of the claim: an ordinary departure means Reset no longer holds focus and has
    // no call on it. The claim carries an EXPIRY, so this row advances the clock past the window —
    // duration is what separates a stale claim from a press in progress. Without expiry the flag
    // would latch on the first focus forever and steal focus on some later, unrelated clear.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset");
    reset.focus();
    const elsewhere = screen.getByTestId("status-chip-done");
    elsewhere.focus();
    fireEvent.blur(reset);
    // Past the claim window — the real gap between an unrelated departure and a later clear.
    // Advance the MONOTONIC clock the claim is stamped against. Fake timers are avoided here:
    // vitest's do not move performance.now() by default, and a mocked clock leaking out of a
    // failing row would hang the later rows that await a real macrotask.
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_000);
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement).toBe(elsewhere);
  });

  it("does NOT latch — a focus that ended on <body> long ago cannot steal a later clear", () => {
    // The failure mode of clearing the flag from the render body while treating focus-on-<body> as
    // "hasn't moved" (roborev 54051): focus Reset, click any non-focusable region, and the flag
    // stays true for the component's life — so an unrelated clear minutes later yanks focus into a
    // chip out of nowhere. Blurring to <body> while the button is still ENABLED is the user
    // leaving on their own, and must clear.
    const { rerender } = render(
      <StatusFilterBar
        counts={counts}
        visible={{ needs_you: true, running: false, done: true }}
        onToggle={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const reset = screen.getByTestId("status-filter-reset") as HTMLButtonElement;
    reset.focus();
    reset.blur(); // dead space: focus goes nowhere, button still live
    expect(document.activeElement).not.toBe(reset);
    // Advance past the CLAIM WINDOW, not merely a macrotask. A macrotask is exactly what the
    // WebKit mouse path produces (mousedown-blur, then click), so expiring on that would pin the
    // platform failure as correct behaviour and block its fix (roborev 54066). Duration is what
    // separates "stale claim" from "press in progress".
    // Advance the MONOTONIC clock the claim is stamped against. Fake timers are avoided here:
    // vitest's do not move performance.now() by default, and a mocked clock leaking out of a
    // failing row would hang the later rows that await a real macrotask.
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_000);
    const before = document.activeElement;
    rerender(
      <StatusFilterBar counts={counts} visible={allBandsVisible()} onToggle={vi.fn()} onReset={vi.fn()} />,
    );
    expect(document.activeElement).toBe(before);
  });
});
