// @vitest-environment jsdom
//
// What this file pins is the rail's hard promises — the fill drains INTO Send (anchored right, the
// correction to the source mockup), NO NUMERAL renders in any state, the TARGET never disappears
// while armed, and counting is signalled by STRUCTURE (the track) rather than by texture — plus the
// tier cue, the threshold ease, reduced motion, and the single-live-region contract. The timing
// rules behind it (when a countdown starts, moves, or fires) are tested in voice/autoSendTimer;
// this file does not restate them.
//
// The last two are the legibility fix. The rail used to drop the arrow while counting AND encode
// two independent facts (counting-vs-idle, and the tier) on the fill alone, so a user comparing two
// screenshots six seconds apart saw one solid rail naming a destination and one hatched rail naming
// nothing, with no way to tell which fact had changed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";

import { SendRail, THRESHOLD_EASE_MS, type SendRailModel } from "./SendRail";
import { C } from "../../theme/colors";
import { BLUEPRINT } from "../../theme/blueprintSpec";
import { useUiStore } from "../../stores/uiStore";

/** jsdom's CSSOM leaves a `var(--…)` string verbatim but normalises a LITERAL hex to
 *  `rgb(r, g, b)` — including one sitting inside a `color-mix()` it cannot otherwise parse. The
 *  terminal's edge is the second kind (the spec value has no CSS var of its own), so it has to be
 *  converted before comparing. Derived from BLUEPRINT rather than hard-coded so a palette retune
 *  carries these rows along with it — the same trick ComposeBox.plate.test.tsx uses. */
const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

const IDLE: SendRailModel = {
  phase: "disarmed",
  targetName: "Concierge",
  tier: "verylow",
  remainingFraction: 1,
};
const ARMED: SendRailModel = { ...IDLE, phase: "listening", tier: "normal" };
const COUNTING: SendRailModel = {
  phase: "counting",
  targetName: "Concierge",
  tier: "normal",
  remainingFraction: 0.6,
};

function draw(model: SendRailModel, props: Partial<Parameters<typeof SendRail>[0]> = {}) {
  return render(
    <SendRail
      model={model}
      onToggleArmed={props.onToggleArmed ?? vi.fn()}
      onSend={props.onSend ?? vi.fn()}
      canSend={props.canSend ?? true}
    />,
  );
}

/** Install a `matchMedia` that answers the reduced-motion query with `reduce`. jsdom has none. */
function withReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && q.includes("prefers-reduced-motion"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The wired-track rows below drive an EXPLICIT theme; hand the store back so nothing else in the
  // suite inherits one.
  useUiStore.setState({ themePref: "auto" } as never);
});

describe("SendRail — the three states", () => {
  it("idle: the switch is off and the label offers the feature by name", () => {
    draw(IDLE);
    const toggle = screen.getByRole("switch", { name: /^Auto-send/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("send-rail-label").textContent).toBe("Auto-send");
    // Nothing is counting, so nothing is drawn counting. A full-width wash on an idle rail reads as
    // a countdown that is STUCK rather than one that has not started.
    expect(screen.queryByTestId("send-rail-fill")).toBeNull();
  });

  it("armed: the switch is on and the label points at the target", () => {
    draw({ ...ARMED, targetName: "Build 4" });
    expect(screen.getByRole("switch", { name: /^Auto-send/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("send-rail-label").textContent).toBe("→ Build 4");
    expect(screen.queryByTestId("send-rail-fill")).toBeNull();
  });

  it("counting: the fill appears and the label STILL points at the target", () => {
    // The arrow used to be dropped the moment counting began, so the row went "→ Build 4" →
    // "Build 4" and the mis-route safety net changed shape at the moment it mattered most. Two
    // screenshots six seconds apart read as one rail with a destination and one with none.
    draw({ ...COUNTING, targetName: "Build 4" });
    expect(screen.getByTestId("send-rail-label").textContent).toBe("→ Build 4");
    expect(screen.getByTestId("send-rail-fill")).toBeTruthy();
  });

  it("the Send button is present in every state, with its name and shortcut unchanged", () => {
    // It MOVED into the rail from beside the textarea; nothing else about it changed, so anything
    // reaching for it by label or by ⌘↩ must still find it.
    for (const model of [IDLE, ARMED, COUNTING]) {
      const { unmount } = draw(model);
      const send = screen.getByRole("button", { name: "Send" });
      expect(send.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter Control+Enter");
      expect(send.getAttribute("title")).toBe("Send (⌘↩)");
      unmount();
    }
  });
});

describe("SendRail — the fill anchors RIGHT and drains toward Send", () => {
  it("is pinned to the right edge with no left anchor", () => {
    // THE CORRECTION to the source mockup, which anchored it left — draining it AWAY from Send.
    // `right: 0` with no `left` is what makes a shrinking width walk the fill's left edge rightward,
    // collapsing it INTO the button it is about to press.
    draw(COUNTING);
    const fill = screen.getByTestId("send-rail-fill");
    expect(fill.style.right).toBe("0px");
    expect(fill.style.left).toBe("");
  });

  it("width tracks the remaining fraction, so a drained rail is a vanished fill", () => {
    const { rerender } = draw({ ...COUNTING, remainingFraction: 1 });
    expect(screen.getByTestId("send-rail-fill").style.width).toBe("100%");

    for (const [fraction, width] of [
      [0.6, "60%"],
      [0.25, "25%"],
      [0, "0%"],
    ] as const) {
      rerender(
        <SendRail
          model={{ ...COUNTING, remainingFraction: fraction }}
          onToggleArmed={vi.fn()}
          onSend={vi.fn()}
          canSend
        />,
      );
      expect(screen.getByTestId("send-rail-fill").style.width).toBe(width);
    }
  });

  it("clamps an out-of-range fraction rather than drawing an inverted bar", () => {
    // The timer clamps too, but a negative width here is a rendering artefact the user would see
    // during the drop-guard's 600ms, so the component does not rely on its caller for this.
    const { rerender } = draw({ ...COUNTING, remainingFraction: -0.4 });
    expect(screen.getByTestId("send-rail-fill").style.width).toBe("0%");
    rerender(
      <SendRail
        model={{ ...COUNTING, remainingFraction: 1.8 }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );
    expect(screen.getByTestId("send-rail-fill").style.width).toBe("100%");
  });
});

describe("SendRail — NO DIGITS, in any state", () => {
  const STATES: Array<[string, SendRailModel]> = [
    ["idle", IDLE],
    ["armed", ARMED],
    ["counting, full", { ...COUNTING, remainingFraction: 1 }],
    ["counting, half", { ...COUNTING, remainingFraction: 0.5 }],
    ["counting, nearly gone", { ...COUNTING, remainingFraction: 0.03 }],
    ["counting, very low", { ...COUNTING, tier: "verylow" }],
    ["counting, high", { ...COUNTING, tier: "high" }],
  ];

  for (const [name, model] of STATES) {
    it(`renders no numeral in the ${name} state`, () => {
      // A digit-free target name, so this assertion is about the RAIL'S OWN chrome. No seconds
      // readout, no percentage, no tier number — the number is not the information, the target is,
      // and a visible countdown invites the user to race it.
      const { container } = draw({ ...model, targetName: "Concierge" });
      expect(container.textContent ?? "").not.toMatch(/\d/);
    });
  }

  it("a numeral in the TARGET NAME is not a readout and survives verbatim", () => {
    // The ban is on a countdown readout, not on an agent that happens to be called "Build 4".
    // Stripping it would break the one thing the label is for.
    draw({ ...COUNTING, targetName: "Build 4" });
    expect(screen.getByTestId("send-rail-label").textContent).toBe("→ Build 4");
  });
});

describe("SendRail — the target NEVER disappears while armed", () => {
  it("shows the same `→ target` label in both armed states", () => {
    // THE DEFECT. `label` was `counting ? targetName : \`→ ${targetName}\``, so the arrow — the
    // thing that makes the word after it read as a DESTINATION rather than a caption — was dropped
    // exactly while a send was pending. A state change must not SUBTRACT information the other
    // state was showing; there is then nothing to compare, and the difference reads as a bug.
    const { rerender } = draw({ ...ARMED, targetName: "Build 4" });
    const armedIdle = screen.getByTestId("send-rail-label").textContent;

    rerender(
      <SendRail
        model={{ ...COUNTING, targetName: "Build 4" }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );
    expect(screen.getByTestId("send-rail-label").textContent).toBe(armedIdle);
    expect(armedIdle).toBe("→ Build 4");
  });

  it("keeps the arrow at every tier and every remaining fraction", () => {
    // The arrow is not a function of how the fill is painted. Pinned across the hatched tier and
    // the drained end of the bar, where the old rule was most likely to be re-introduced.
    for (const model of [
      { ...COUNTING, tier: "verylow" as const, remainingFraction: 1 },
      { ...COUNTING, tier: "high" as const, remainingFraction: 0.02 },
      { ...COUNTING, tier: "normal" as const, remainingFraction: 0 },
    ]) {
      const { unmount } = draw({ ...model, targetName: "Build 4" });
      expect(screen.getByTestId("send-rail-label").textContent).toBe("→ Build 4");
      unmount();
    }
  });

  it("only the DISARMED state drops the target, because there is none to name", () => {
    draw(IDLE);
    expect(screen.getByTestId("send-rail-label").textContent).toBe("Auto-send");
  });
});

describe("SendRail — counting is signalled by STRUCTURE, not by texture", () => {
  it("draws a bounded track while counting and none when armed-idle", () => {
    // The cue that separates counting from armed-idle, and the whole point of the fix: the fill's
    // texture is spoken for (it carries the tier), so counting needs its OWN channel. Without this
    // the only difference between the two states was that one painted a wash — which the user read
    // as "sometimes solid, sometimes hatched" with nothing explaining why.
    const { rerender } = draw(COUNTING);
    expect(screen.getByTestId("send-rail-track")).toBeTruthy();

    rerender(<SendRail model={ARMED} onToggleArmed={vi.fn()} onSend={vi.fn()} canSend />);
    expect(screen.queryByTestId("send-rail-track")).toBeNull();

    rerender(<SendRail model={IDLE} onToggleArmed={vi.fn()} onSend={vi.fn()} canSend />);
    expect(screen.queryByTestId("send-rail-track")).toBeNull();
  });

  it("the track is a BOUNDED plate — an outline, not another wash", () => {
    // Structural, not textural. A border is a different visual channel from the fill's texture, so
    // the two facts can never collide again the way they did.
    draw(COUNTING);
    const track = screen.getByTestId("send-rail-track");
    expect(track.style.borderStyle).toBe("solid");
    expect(track.style.borderWidth).toBe("1px");
    // Themed, so it resolves against BOTH light and dark rather than one hard-coded ink. This is
    // the UNWIRED ground (the composer's own `inputSurface` plate), where the chrome seam is the
    // right token; see the wired case below for why that cannot be hardcoded.
    expect(track.style.borderColor).toContain("var(--c-hairline)");
    // Bounded on all four edges — it is a plate the fill drains inside, not a second wash.
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      expect(track.style[edge]).toBe("0px");
    }
    // Behind the controls, like the fill — it must wash the strip, not cover it.
    expect(track.style.zIndex).toBe("0");
    // It is decoration; the state it depicts is announced by the host, not by this node.
    expect(track.getAttribute("aria-hidden")).toBe("true");
  });

  it("on the TERMINAL ground the track takes the terminal's edge token, not the chrome seam", () => {
    // roborev 55244. `C.hairline` is the CHROME seam, and theme/chromeContrast.test.ts deliberately
    // does NOT pair it with the terminal plane: light `hairline` on `forest` measures 1.195 against
    // a 1.2 floor, which is why the spec draws `termHair` where a rule meets the terminal. A wired
    // composer goes transparent over that flood (ComposeBox's `wired`), so a hardcoded chrome
    // hairline here would paint the counting cue BELOW the project's own visibility floor — putting
    // counting and armed-idle back to indistinguishable in wired + light, which is the whole defect
    // this track exists to remove.
    //
    // ASSERTED AS THE TOKEN, not as "some colour that isn't the chrome seam". That weaker form was
    // satisfied by ANY substitution — `C.inputEdge`, `C.pillFill`, `C.dialogEdge`, a literal "red"
    // — which is exactly the wrong shape for a guard whose stated contract is VISIBILITY on the
    // terminal plane: chromeContrast floors precisely ONE token there (`termHairline`), and
    // `pillFill`/`inputEdge` are excluded from the `forest` pairing altogether, so a refactor
    // swapping either in would reintroduce a sub-floor counting cue with this row still green.
    // Compared against BLUEPRINT rather than a literal hex — the precedent is
    // AgentPane.blueprint.test.tsx — so the palette can be retuned without editing this file.
    //
    // BOTH MODES, because the value is a `BLUEPRINT[mode]` lookup: jsdom hands out dark for free
    // (no matchMedia ⇒ systemPrefersDark), so a hard-coded `BLUEPRINT.dark` in the component would
    // pass a dark-only row. Light is also the end the floor actually bites at — 1.195 vs 1.2.
    for (const mode of ["dark", "light"] as const) {
      useUiStore.setState({ themePref: mode } as never);
      render(<SendRail model={COUNTING} onToggleArmed={vi.fn()} onSend={vi.fn()} canSend wired />);
      const wiredTrack = screen.getByTestId("send-rail-track");
      expect(wiredTrack.style.borderColor, `${mode}: wired track edge`).toBe(
        rgb(BLUEPRINT[mode].termHair),
      );
      // Said separately, because it is the specific regression: the chrome seam is the token this
      // plane has no guard for at all.
      expect(wiredTrack.style.borderColor).not.toContain(C.hairline);
      // …and the wash is mixed from the SAME token as the edge, so the two can never disagree about
      // which ground they think they are on. Pinned to the token, not to "whatever the edge is".
      expect(wiredTrack.style.background).toContain(rgb(BLUEPRINT[mode].termHair));
      cleanup();
    }
    // The two modes really are different colours, so the loop above is two assertions and not one
    // made twice.
    expect(rgb(BLUEPRINT.light.termHair)).not.toBe(rgb(BLUEPRINT.dark.termHair));

    // The unwired default is unchanged — the fix is a branch, not a swap.
    render(<SendRail model={COUNTING} onToggleArmed={vi.fn()} onSend={vi.fn()} canSend />);
    expect(screen.getByTestId("send-rail-track").style.borderColor).toBe(C.hairline);
  });

  it("the track sits BEHIND the fill, so the bar drains inside it", () => {
    // DOM order at equal z-index is what puts the fill on top. Reversed, the plate would paint over
    // the draining bar and the rail would look full for the whole countdown.
    draw(COUNTING);
    const rail = screen.getByTestId("concierge-send-rail");
    const track = screen.getByTestId("send-rail-track");
    const fill = screen.getByTestId("send-rail-fill");
    expect(track.style.zIndex).toBe(fill.style.zIndex);
    const order = Array.from(rail.children);
    expect(order.indexOf(track)).toBeLessThan(order.indexOf(fill));
  });

  it("states counting as an attribute, so the cue is assertable without reading styles", () => {
    const { rerender } = draw(COUNTING);
    const rail = () => screen.getByTestId("concierge-send-rail");
    expect(rail().getAttribute("data-counting")).toBe("true");
    // …and the existing contract is untouched.
    expect(rail().getAttribute("data-phase")).toBe("counting");
    expect(rail().getAttribute("data-tier")).toBe("normal");

    rerender(<SendRail model={ARMED} onToggleArmed={vi.fn()} onSend={vi.fn()} canSend />);
    expect(rail().hasAttribute("data-counting")).toBe(false);
    expect(rail().getAttribute("data-phase")).toBe("listening");

    rerender(<SendRail model={IDLE} onToggleArmed={vi.fn()} onSend={vi.fn()} canSend />);
    expect(rail().hasAttribute("data-counting")).toBe(false);
    expect(rail().getAttribute("data-phase")).toBe("disarmed");
  });

  it("the label stays ABOVE the fill in every tier, hatched or solid", () => {
    // Contrast survives the wash only because the label is painted over it, not under it. Pinned
    // for both fill treatments so a future tier cue cannot quietly bury the target name.
    for (const tier of ["verylow", "normal", "high"] as const) {
      const { unmount } = draw({ ...COUNTING, tier });
      const label = screen.getByTestId("send-rail-label");
      const fill = screen.getByTestId("send-rail-fill");
      // The label's stacking comes from the switch that wraps it.
      const stacked = label.closest('[role="switch"]') as HTMLElement;
      expect(Number(stacked.style.zIndex)).toBeGreaterThan(Number(fill.style.zIndex));
      unmount();
    }
  });
});

describe("SendRail — the very-low tier cue", () => {
  it("marks the tier on the rail while counting, and only while counting", () => {
    const { rerender } = draw({ ...COUNTING, tier: "verylow" });
    expect(screen.getByTestId("concierge-send-rail").getAttribute("data-tier")).toBe("verylow");
    // Not while armed-but-idle: a tier the user cannot see must not be advertised.
    rerender(
      <SendRail model={ARMED} onToggleArmed={vi.fn()} onSend={vi.fn()} canSend />,
    );
    expect(screen.getByTestId("concierge-send-rail").hasAttribute("data-tier")).toBe(false);
  });

  it("draws a HATCHED track at very-low and a solid one otherwise", () => {
    // In motion very-low reads on its own — ten seconds of drain is imperceptible frame to frame.
    // A still frame cannot show motion, so the tier gets ONE non-numeric cue. Still no numerals.
    const { rerender } = draw({ ...COUNTING, tier: "verylow" });
    const hatched = screen.getByTestId("send-rail-fill").style.background;
    expect(hatched).toContain("repeating-linear-gradient");

    rerender(
      <SendRail
        model={{ ...COUNTING, tier: "normal" }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );
    expect(screen.getByTestId("send-rail-fill").style.background).not.toContain(
      "repeating-linear-gradient",
    );
  });
});

describe("SendRail — a threshold change EASES the fill", () => {
  beforeEach(() => {
    withReducedMotion(false);
    vi.useFakeTimers();
  });

  it("turns the transition on for a tier change and back off after the ease", () => {
    // A receding deadline must read as "that just got longer", not as a teleport.
    const { rerender } = draw({ ...COUNTING, tier: "high", remainingFraction: 0.4 });
    expect(screen.getByTestId("send-rail-fill").style.transition).toBe("none");

    rerender(
      <SendRail
        model={{ ...COUNTING, tier: "verylow", remainingFraction: 0.95 }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );
    expect(screen.getByTestId("send-rail-fill").style.transition).toContain(
      `${THRESHOLD_EASE_MS}ms`,
    );

    // …and it is WITHDRAWN, so the ordinary ~60fps drain is never transitioned. Leaving it on
    // smears every step into the next and makes the bar lag visibly behind the real deadline.
    vi.advanceTimersByTime(THRESHOLD_EASE_MS);
    rerender(
      <SendRail
        model={{ ...COUNTING, tier: "verylow", remainingFraction: 0.9 }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );
    expect(screen.getByTestId("send-rail-fill").style.transition).toBe("none");
  });

  it("has the transition in place alongside the new width", () => {
    // A REGRESSION GUARD, not a proof. The real defect this replaced was an ORDERING one — the ease
    // was armed in a passive effect, so commit 1 wrote the new width bare and commit 2 added the
    // transition, and the browser painted between them. That is invisible here: jsdom never paints,
    // and RTL's act() flushes effects before any assertion, so the final DOM carries both either
    // way. A mutation-record count does not separate them either (React writes each style property
    // individually, so both versions emit the same records).
    //
    // Verified by reverting the fix: every jsdom assertion available still passed. The fix — deriving
    // `easing` during render, React's "adjust state when a prop changes" pattern — is correct on
    // React's commit semantics rather than on anything this file can observe. What IS observable is
    // the stuck-easing defect below, which the same rewrite fixed.
    const { rerender } = draw(COUNTING);
    const widthBefore = screen.getByTestId("send-rail-fill").style.width;

    rerender(
      <SendRail
        model={{ ...COUNTING, tier: "verylow", remainingFraction: 0.95 }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );

    const fill = screen.getByTestId("send-rail-fill");
    expect(fill.style.width).not.toBe(widthBefore);
    expect(fill.style.transition).toContain(`${THRESHOLD_EASE_MS}ms`);
  });

  it("still withdraws the ease when reduced-motion flips DURING the window", () => {
    // THE OBSERVABLE HALF of the same defect. The withdrawal timer used to be keyed on
    // [tier, reduceMotion]: a reduced-motion flip mid-window re-ran the effect, which cleared the
    // pending timeout and then early-returned on the unchanged tier — leaving `easing` stuck true
    // forever. A permanently-declared transition smears every ~60fps drain step into the next,
    // which is the exact thing THRESHOLD_EASE_MS is withdrawn to avoid. Keyed on [easing] now.
    vi.useFakeTimers();
    withReducedMotion(false);
    const { rerender } = draw(COUNTING);

    const armNewTier = (reduce: boolean) => {
      withReducedMotion(reduce);
      rerender(
        <SendRail
          model={{ ...COUNTING, tier: "verylow", remainingFraction: 0.95 }}
          onToggleArmed={vi.fn()}
          onSend={vi.fn()}
          canSend
        />,
      );
    };

    armNewTier(false);
    expect(screen.getByTestId("send-rail-fill").style.transition).toContain(`${THRESHOLD_EASE_MS}ms`);

    // The user turns reduced motion on while the ease is still running.
    armNewTier(true);
    act(() => void vi.advanceTimersByTime(THRESHOLD_EASE_MS + 10));

    expect(screen.getByTestId("send-rail-fill").style.transition).toBe("none");
  });

  it("does NOT transition when only the fraction moves", () => {
    const { rerender } = draw({ ...COUNTING, remainingFraction: 0.9 });
    rerender(
      <SendRail
        model={{ ...COUNTING, remainingFraction: 0.8 }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );
    expect(screen.getByTestId("send-rail-fill").style.transition).toBe("none");
  });
});

describe("SendRail — prefers-reduced-motion", () => {
  it("skips the ease entirely; the bar still lands in the right place", () => {
    withReducedMotion(true);
    const { rerender } = draw({ ...COUNTING, tier: "high", remainingFraction: 0.4 });
    rerender(
      <SendRail
        model={{ ...COUNTING, tier: "verylow", remainingFraction: 0.95 }}
        onToggleArmed={vi.fn()}
        onSend={vi.fn()}
        canSend
      />,
    );
    const fill = screen.getByTestId("send-rail-fill");
    expect(fill.style.transition).toBe("none");
    expect(fill.style.width).toBe("95%");
  });
});

describe("SendRail — gestures", () => {
  it("the switch reports the state it is asking for, both ways", () => {
    const onToggleArmed = vi.fn();
    const { rerender } = draw(IDLE, { onToggleArmed });
    fireEvent.click(screen.getByRole("switch", { name: /^Auto-send/ }));
    expect(onToggleArmed).toHaveBeenCalledWith(true);

    rerender(
      <SendRail model={ARMED} onToggleArmed={onToggleArmed} onSend={vi.fn()} canSend />,
    );
    fireEvent.click(screen.getByRole("switch", { name: /^Auto-send/ }));
    expect(onToggleArmed).toHaveBeenLastCalledWith(false);
  });

  it("Send fires mid-countdown — a manual send always overrides", () => {
    const onSend = vi.fn();
    draw(COUNTING, { onSend });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Send is disabled with nothing to send", () => {
    const onSend = vi.fn();
    draw(ARMED, { onSend, canSend: false });
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("SendRail — the single-live-region contract", () => {
  it("carries NO aria-live node of its own, in any state", () => {
    // The column has exactly ONE role="status" announcer and the host feeds it via announce().
    // A second region makes a screen reader read every send twice (roborev 52648/53010/53088).
    for (const model of [IDLE, ARMED, COUNTING]) {
      const { container, unmount } = draw(model);
      expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      unmount();
    }
  });
});

describe("the target name reaches assistive tech", () => {
  it("names the destination in the switch's ACCESSIBLE name while armed", () => {
    // `aria-label` REPLACES the subtree for name computation, so a constant "Auto-send" left the
    // visible "Build 4" unreachable: a screen-reader user heard the same string in every state and
    // could never learn where a pending auto-send was aimed — which is the mis-route safety net,
    // and the only reason the label exists.
    draw({ ...COUNTING, targetName: "Build 4" });
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-label")).toContain("Build 4");
  });

  it("keeps the visible text INSIDE the accessible name — WCAG 2.5.3, Label in Name", () => {
    // Visible "Build 4" with an accessible name of "Auto-send" also breaks voice control: saying
    // "click Build 4" cannot match the control.
    draw({ ...COUNTING, targetName: "Build 4" });
    const sw = screen.getByRole("switch");
    const visible = sw.textContent ?? "";
    expect(visible).toContain("Build 4");
    expect(sw.getAttribute("aria-label")).toContain("Build 4");
    // The stable prefix survives, so the control stays recognisable across state changes.
    expect(sw.getAttribute("aria-label")).toMatch(/^Auto-send/);
  });

  it("says just 'Auto-send' when disarmed — there is no pending destination to name", () => {
    draw(IDLE);
    expect(screen.getByRole("switch").getAttribute("aria-label")).toBe("Auto-send");
  });
});
