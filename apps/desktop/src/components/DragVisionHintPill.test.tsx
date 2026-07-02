// @vitest-environment jsdom
//
// Covers the drag-vision hint pill (spec 2026-07-02, Unit A), focused on the entitlement fork:
//  - entitled (paid $99) → "Enable AI Features" flips the aiComposer flag on + dismisses, no URL
//  - NOT entitled → opens the pricing page (composer-vision highlighted) + dismisses, no flag flip
//  - "Learn more" → opens the docs deep link
//  - × / Escape / auto-timeout dismiss
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../services/sparkleApi", () => ({
  launch: vi.fn(() => Promise.resolve(true)),
}));

import {
  DragVisionHintPill,
  VISION_LEARN_MORE_URL,
  VISION_PRICING_URL,
} from "./DragVisionHintPill";
import { launch } from "../services/sparkleApi";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { Me } from "../services/entitlement";

const mockLaunch = vi.mocked(launch);

function setEntitled(entitled: boolean) {
  const me: Me = { clerkUserId: "u1", entitled, balanceCents: 0, tokenVersion: 1 };
  useAuthStore.setState({ me, tokenPresent: true, loading: false });
}

const clickEnable = () =>
  fireEvent.click(screen.getByRole("button", { name: "Enable AI Features" }));

beforeEach(() => {
  vi.clearAllMocks();
  mockLaunch.mockResolvedValue(true);
  // Composer starts OFF (the whole premise of the pill: the composer flag is disabled).
  useSettingsStore.setState({ aiComposer: false });
  setEntitled(false);
});
afterEach(() => cleanup());

describe("DragVisionHintPill", () => {
  it("renders the hint text and both actions", () => {
    render(<DragVisionHintPill onDismiss={vi.fn()} />);
    expect(
      screen.getByText(/give Claude Code vision by dragging images/i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable AI Features" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Learn more/i })).toBeTruthy();
  });

  it("entitled: Enable flips aiComposer on and dismisses (no browser hand-off)", () => {
    setEntitled(true);
    const onDismiss = vi.fn();
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    clickEnable();
    expect(useSettingsStore.getState().aiComposer).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it("not entitled: Enable opens the pricing highlight URL and does NOT flip the flag", () => {
    setEntitled(false);
    const onDismiss = vi.fn();
    render(<DragVisionHintPill onDismiss={onDismiss} />);
    clickEnable();
    expect(mockLaunch).toHaveBeenCalledWith(VISION_PRICING_URL);
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
