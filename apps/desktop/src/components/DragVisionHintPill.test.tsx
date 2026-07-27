// @vitest-environment jsdom
//
// Covers the drag-vision hint pill (spec 2026-07-02, Unit A; reduced to the truth by roborev
// 46485):
//  - primary "Go to the Sparkle box" → focuses the concierge compose box (requestComposeFocus)
//  - "Learn more" → docs link; × / Escape / auto-timeout dismiss
//
// The pill is now purely INFORMATIONAL and shows for everyone. Both former actions are gone: the
// entitled branch flipped a `composer` flag that mounts nothing since CM-U7, and the not-entitled
// branch sold AI Features — and now that the attach pickers HAVE landed (parity row #21), the flow
// this pill recommends checks no entitlement anywhere, so the upsell was selling a feature the
// recommended flow does not need (roborev 46485-M / 46925). THE COPY IS PINNED BELOW ON PURPOSE:
// the box takes files now, so the pill may name its Image / Files buttons — but it still must not
// claim the image reaches the AGENT whose terminal was dragged over, in the body or in the
// accessible name (the box aims at Sparkle until the user pins an agent with the send-target
// toggle).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../services/sparkleApi", () => ({
  launch: vi.fn(() => Promise.resolve(true)),
}));

import { DragVisionHintPill, VISION_LEARN_MORE_URL } from "./DragVisionHintPill";
import { launch } from "../services/sparkleApi";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

const mockLaunch = vi.mocked(launch);

beforeEach(() => {
  vi.clearAllMocks();
  mockLaunch.mockResolvedValue(true);
  // Composer starts OFF (the whole premise of the pill: the composer flag is disabled).
  useSettingsStore.setState({ aiComposer: false });
});
afterEach(() => cleanup());

describe("DragVisionHintPill", () => {
  it("renders the redirect copy and the compose-box action", () => {
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    expect(screen.getByText(/Drop it on the Sparkle box instead/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to the Sparkle box" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Learn more/i })).toBeTruthy();
  });

  it("points at the concierge pickers by name, and still promises no more than that", () => {
    // Landed in parity row #21: the box takes files now, so the pill may say so. What it still may
    // NOT say is that the image reaches the agent whose terminal was dragged over — the box aims at
    // Sparkle until the user pins an agent with the send-target toggle.
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    const body = screen.getByRole("dialog").textContent ?? "";
    expect(body).toMatch(/Image \/ Files buttons/i);
    expect(body).not.toMatch(/reach(es)? this agent/i);
  });

  it("primary action focuses the compose box and dismisses — no URL, no flag flip", () => {
    // The pill's ONE positive behaviour. My consolidation of the three overlapping negative tests
    // took this with it (roborev 52969), leaving only "the button exists" — so a regression that
    // made it inert, or made it navigate somewhere, would have passed green.
    const onDismiss = vi.fn();
    const seqBefore = useUiStore.getState().composeFocusSeq;
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to the Sparkle box" }));
    expect(useUiStore.getState().composeFocusSeq).toBe(seqBefore + 1);
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().aiComposer).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers no upsell anywhere: no CTA, no entitlement caveat, no pricing URL", () => {
    // ONE negative-copy test (roborev 51593/51594): the union merge had left three that re-asserted
    // the same invariant from different angles. The pill sold "Enable AI Features" from when the
    // terminal drop fed a paid vision path; the flow it now recommends — the concierge pickers /
    // drop-to-attach — checks no entitlement anywhere, so both the CTA and the "(Vision also needs
    // AI Features enabled.)" line were selling a feature it does not need (roborev 46485-M/46925).
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Enable AI Features/i })).toBeNull();
    expect(screen.getByRole("dialog").textContent ?? "").not.toMatch(/AI Features/i);
    // Learn more is the only launch on this pill, and it goes to the docs.
    fireEvent.click(screen.getByRole("button", { name: /Learn more/i }));
    for (const [url] of mockLaunch.mock.calls) expect(url).not.toMatch(/pricing/i);
    expect(useSettingsStore.getState().aiComposer).toBe(false);
  });

  it("promises NOTHING the app can't do yet — body AND accessible name (roborev 46485-H/L)", () => {
    // The box stages the file for the NEXT message and aims at Sparkle unless the user pins an
    // agent, so "it reaches this agent" may never appear. The aria-label is checked too:
    // textContent excludes attributes, so an overpromising accessible name (what a screen-reader
    // user actually hears) would otherwise slip past.
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    for (const text of [dialog.textContent ?? "", dialog.getAttribute("aria-label") ?? ""]) {
      expect(text).not.toMatch(/reach(es)? this agent/i);
      // Same claim, re-worded: the box aims at the concierge unless the user pins the agent with
      // the send-target toggle, and this pill's action does not pin it (roborev 46897).
      expect(text).not.toMatch(/hand (the work|it) to this agent/i);
    }
  });

  it("Learn more opens the docs deep link and dismisses", () => {
    const onDismiss = vi.fn();
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /Learn more/i }));
    expect(mockLaunch).toHaveBeenCalledWith(VISION_LEARN_MORE_URL);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("× dismisses", () => {
    const onDismiss = vi.fn();
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("Escape dismisses", () => {
    const onDismiss = vi.fn();
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("auto-dismisses after the timeout", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
