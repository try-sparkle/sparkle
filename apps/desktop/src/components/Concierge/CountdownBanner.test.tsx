// @vitest-environment jsdom
//
// The banner is the part of the gate the user actually operates, so what these rows pin is the
// operability: the sentence names the agent AND the words, the counter is live, and every send on
// screen has its own reachable Cancel. The rule engine behind it (what may dispatch, what queues,
// what re-presents) is tested in services/dispatchIntent — this file does not restate it.
//
// The two states are deliberately NOT interchangeable. A counting intent has a deadline and sends
// itself; a held one has neither, and shows a Send button instead of a number. Rendering the
// countdown wording over an intent with no timer would promise a deadline that never arrives, on
// the one path that specifically must not have one.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CountdownBanner } from "./CountdownBanner";
import { DESTRUCTIVE_DELAY_MS, ROUTINE_DELAY_MS } from "../../services/dispatchClass";
import type { DispatchIntent } from "../../services/dispatchIntent";

afterEach(() => cleanup());

const T0 = 1_000_000;

function intent(over: Partial<DispatchIntent> = {}): DispatchIntent {
  return {
    id: "intent-1",
    text: "rebase onto main",
    targetAgentId: "ag1",
    targetName: "Kraken Auth",
    class: "routine",
    status: "armed",
    armedAt: T0,
    countdownStartedAt: T0,
    needsConfirmation: false,
    timerId: null,
    ...over,
    // AFTER the spread, so `intent({ text })` gets a matching display rather than a stale one.
    // Production keeps them identical when there are no attachments; a test that needs them to
    // DIFFER (the temp-path leak) passes `display` explicitly.
    display: over.display ?? over.text ?? "rebase onto main",
  };
}

/** Render at a fixed instant — the counter reads off the injected clock, not the wall clock. */
function renderAt(intents: DispatchIntent[], now = T0) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <CountdownBanner intents={intents} onCancel={onCancel} onConfirm={onConfirm} now={() => now} />,
  );
  return { onCancel, onConfirm };
}

describe("nothing armed", () => {
  it("renders nothing at all — no empty chrome above the compose box", () => {
    renderAt([]);
    expect(screen.queryByTestId("countdown-banners")).toBeNull();
  });
});

describe("a counting send", () => {
  it("names the agent and quotes the message, so a misroute is recognisable", () => {
    renderAt([intent()]);
    const banner = screen.getByTestId("countdown-banner");
    expect(banner.textContent).toContain("Kraken Auth");
    expect(banner.textContent).toContain("rebase onto main");
  });

  it("shows the remaining whole seconds, and never 0 while the send is still pending", () => {
    // Rendered a hair before the deadline: a banner reading "Sending in 0…" for the last fraction
    // of a second reads as already gone, when it is in fact still cancellable.
    renderAt([intent()], T0 + ROUTINE_DELAY_MS - 1);
    expect(screen.getByTestId("countdown-banner").textContent).toContain("Sending in 1…");
  });

  it("counts off the CURRENT countdown, not the original send", () => {
    // A re-presented intent is old (`armedAt` long past) but its window is fresh. Reading the
    // counter off `armedAt` would show a re-presented send as already expired.
    const old = intent({ armedAt: T0 - 60_000, countdownStartedAt: T0 });
    renderAt([old], T0);
    expect(screen.getByTestId("countdown-banner").textContent).toContain("Sending in 3…");
  });

  it("gives the destructive tier its longer window", () => {
    renderAt([intent({ class: "destructive" })], T0);
    const banner = screen.getByTestId("countdown-banner");
    expect(banner.getAttribute("data-dispatch-class")).toBe("destructive");
    expect(banner.textContent).toContain(`Sending in ${DESTRUCTIVE_DELAY_MS / 1000}…`);
  });

  it("cancels the intent it names", () => {
    const { onCancel } = renderAt([intent()]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sending to Kraken Auth" }));
    expect(onCancel).toHaveBeenCalledWith("intent-1");
  });

  it("offers NO Send button — a counting send already sends itself", () => {
    // A Send button here would just be a way to skip your own safety net.
    renderAt([intent()]);
    expect(screen.queryByRole("button", { name: /^Send this to/ })).toBeNull();
  });

  it("ticks without being re-rendered, so the number can't drift from the real deadline", () => {
    vi.useFakeTimers();
    try {
      // A real clock reading, so the component's own interval is what moves the display.
      const start = Date.now();
      render(
        <CountdownBanner
          intents={[intent({ armedAt: start, countdownStartedAt: start })]}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      expect(screen.getByTestId("countdown-banner").textContent).toContain("Sending in 3…");
      // Inside `act`, so the re-render the interval's setState schedules is flushed before the
      // assertion reads the DOM.
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByTestId("countdown-banner").textContent).toContain("Sending in 2…");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a send held while the user was away", () => {
  const held = () => intent({ needsConfirmation: true });

  it("shows no counter — there is no deadline to announce", () => {
    renderAt([held()]);
    const banner = screen.getByTestId("countdown-banner");
    expect(banner.getAttribute("data-needs-confirmation")).toBe("true");
    expect(banner.textContent).toContain("Held while you were away.");
    expect(banner.textContent, "a deadline that never arrives must not be shown").not.toContain(
      "Sending in",
    );
  });

  it("offers an explicit Send, named for the agent it will reach", () => {
    const { onConfirm } = renderAt([held()]);
    fireEvent.click(screen.getByRole("button", { name: "Send this to Kraken Auth" }));
    expect(onConfirm).toHaveBeenCalledWith("intent-1");
  });

  it("can still be declined outright", () => {
    const { onCancel, onConfirm } = renderAt([held()]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sending to Kraken Auth" }));
    expect(onCancel).toHaveBeenCalledWith("intent-1");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("runs no ticker — a static line must not re-render four times a second forever", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(globalThis, "setInterval");
      render(
        <CountdownBanner intents={[held()]} onCancel={vi.fn()} onConfirm={vi.fn()} />,
      );
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("more than one on screen", () => {
  // The serialized drain (services/dispatchIntent) means a return from Away presents one at a time,
  // but a user can still submit while one is counting. Whatever is on screen must each be
  // independently stoppable — a banner showing one send while another counts down invisibly would
  // be a silent send with extra steps.
  const two = [
    intent({ id: "intent-1", targetName: "Kraken Auth", text: "rebase onto main" }),
    intent({ id: "intent-2", targetName: "CI Hardening", text: "re-run the flaky suite" }),
  ];

  it("renders every one of them", () => {
    renderAt(two);
    expect(screen.getAllByTestId("countdown-banner")).toHaveLength(2);
  });

  it("gives each its own Cancel, distinguishable by the agent it stops", () => {
    // Named for the AGENT, not just "Cancel": a screen-reader user tabbing through identical
    // buttons would otherwise have no way to tell which send each one stops.
    const { onCancel } = renderAt(two);
    fireEvent.click(screen.getByRole("button", { name: "Cancel sending to CI Hardening" }));
    expect(onCancel).toHaveBeenCalledWith("intent-2");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps each sentence with its own send", () => {
    renderAt(two);
    const [first, second] = screen.getAllByTestId("countdown-banner");
    expect(within(first!).getByText(/rebase onto main/)).toBeTruthy();
    expect(within(second!).getByText(/re-run the flaky suite/)).toBeTruthy();
  });
});

describe("no second live region", () => {
  it("carries no role=status of its own — the column owns the only announcer", () => {
    // Learned and fixed once already during the auto-routing rescue (roborev 52648/53010): a second
    // aria-live region makes a screen reader say the countdown twice.
    const { container } = render(
      <CountdownBanner intents={[intent()]} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(container.querySelector("[role='status']")).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
  });
});
