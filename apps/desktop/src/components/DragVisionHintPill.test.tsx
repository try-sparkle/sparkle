// @vitest-environment jsdom
//
// Covers the drag-vision hint pill (spec 2026-07-02, Unit A; reduced to the truth by roborev
// 46485):
//  - primary "Go to the Sparkle box" → focuses the concierge compose box (requestComposeFocus)
//  - "Learn more" → docs link; × / Escape / auto-timeout dismiss
//
// The pill is now purely INFORMATIONAL and shows for everyone. Both former actions are gone: the
// entitled branch flipped a `composer` flag that mounts nothing since CM-U7, and the not-entitled
// branch sold AI Features — but with the attach pickers still stubbed, buying them still leaves
// nowhere to hand an agent an image, which made the upsell the last (and only paid) dead end on
// this surface. THE COPY IS PINNED BELOW ON PURPOSE: it must not promise delivery, in the body or
// in the accessible name, until the pickers actually land.
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
  it("renders the redirect copy and the two surviving actions", () => {
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    expect(screen.getByText(/doesn.t send it/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to the Sparkle box" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Learn more/i })).toBeTruthy();
  });

  it("offers NO paid unlock — there is nothing to unlock yet (roborev 46485-M)", () => {
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Enable AI Features/i })).toBeNull();
    expect(screen.getByRole("dialog").textContent ?? "").not.toMatch(/AI Features/i);
  });

  it("promises NOTHING the app can't do yet — body AND accessible name (roborev 46485-H/L)", () => {
    // The pickers behind the compose box's Image/Files buttons are stubs (ConciergeHost.onAttach
    // is a no-op), and the box aims at Sparkle unless the user pins an agent — so neither
    // "attach it there" nor "it reaches this agent" may appear. The aria-label is checked too:
    // textContent excludes attributes, so an overpromising accessible name (what a screen-reader
    // user actually hears) would otherwise slip past. Retire these only with the pickers.
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    for (const text of [dialog.textContent ?? "", dialog.getAttribute("aria-label") ?? ""]) {
      expect(text).not.toMatch(/attach (them|it) in the Sparkle box/i);
      expect(text).not.toMatch(/reach(es)? this agent/i);
      expect(text).not.toMatch(/drag.and.drop/i);
      // Same claim, re-worded: the box aims at the concierge unless the user pins the agent with
      // the send-target toggle, and this pill's action does not pin it (roborev 46897).
      expect(text).not.toMatch(/hand (the work|it) to this agent/i);
    }
  });

  it("primary action focuses the compose box and dismisses — no URL, no flag flip", () => {
    const onDismiss = vi.fn();
    const seqBefore = useUiStore.getState().composeFocusSeq;
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to the Sparkle box" }));
    expect(useUiStore.getState().composeFocusSeq).toBe(seqBefore + 1);
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().aiComposer).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
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
