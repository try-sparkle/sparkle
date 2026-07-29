// @vitest-environment jsdom
//
// What this file pins is the rail's two hard promises — the fill drains INTO Send (anchored right,
// the correction to the source mockup) and NO NUMERAL renders in any state — plus the tier cue, the
// threshold ease, reduced motion, and the single-live-region contract. The timing rules behind it
// (when a countdown starts, moves, or fires) are tested in voice/autoSendTimer; this file does not
// restate them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";

import { SendRail, THRESHOLD_EASE_MS, type SendRailModel } from "./SendRail";

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

  it("counting: the fill appears and the label is the bare target name", () => {
    draw({ ...COUNTING, targetName: "Build 4" });
    expect(screen.getByTestId("send-rail-label").textContent).toBe("Build 4");
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
    expect(screen.getByTestId("send-rail-label").textContent).toBe("Build 4");
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
