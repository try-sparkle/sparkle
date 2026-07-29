// @vitest-environment jsdom
//
// WHERE the mic menu is anchored. This used to be a ~40px column of glyphs, for which centering on
// the mic was obviously right. It now carries a ~242px device list, and the composer mic it hangs
// off is a 32px button pinned to the composer's LEFT EDGE — so a centered menu puts its left edge
// roughly 105px OUTSIDE the pane, where it paints over the neighbouring column or gets clipped by
// an `overflow: hidden` ancestor, cutting off exactly the device names the menu exists to show.
//
// Pinned as a test because the failure is invisible to every other assertion in the suite: jsdom
// computes no layout, so a menu positioned off-screen still renders, still has its buttons, and
// still passes every behavioural test in MicMenu.test.tsx.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { ComposerMic, MicMenu } from "./MicButton";
import { useDictationStore } from "../stores/dictationStore";
import { useAuthStore } from "../stores/authStore";

beforeEach(() => {
  useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
  useAuthStore.setState({ me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 } });
});
afterEach(() => cleanup());

describe("MicMenu anchoring", () => {
  it("LEFT-anchors when told to, so a left-edge mic grows the menu rightward", () => {
    render(<MicMenu surface="agent" align="left" />);
    const menu = screen.getByRole("menu", { name: "Microphone mode" });
    expect(menu.style.left).toBe("0px");
    // The centering transform must be GONE, not merely accompanied by left:0 — leaving it would
    // still drag the menu half its width off-pane.
    expect(menu.style.transform).toBe("");
  });

  it("CENTERS by default, for a mic that sits in the middle of its container", () => {
    render(<MicMenu surface="concierge" />);
    const menu = screen.getByRole("menu", { name: "Microphone mode" });
    expect(menu.style.left).toBe("50%");
    expect(menu.style.transform).toBe("translateX(-50%)");
  });

  it("the COMPOSER mic actually asks for the left anchor", () => {
    // The prop existing is worth nothing if the one call site that needs it does not pass it —
    // that gap is precisely how the off-pane menu shipped in the first place.
    render(<ComposerMic />);
    fireEvent.mouseEnter(screen.getByLabelText("Turn off microphone").parentElement!);
    const menu = screen.getByRole("menu", { name: "Microphone mode" });
    expect(menu.getAttribute("data-align")).toBe("left");
    expect(menu.style.left).toBe("0px");
  });
});
