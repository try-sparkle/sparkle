// @vitest-environment jsdom
//
// The column shell: a full view-model renders every region (brand mark, scope, vitals, thread
// with all four message kinds) and gestures route through the controller. Per-piece behavior
// lives in the sibling tests.
//
// The two store-backed header pieces are stubbed. They read their own stores rather than the
// view-model (see ConciergeColumn's header comment), so the real ones would drag a rAF audio loop
// and an entitlement fetch into assertions about view-model rendering. WHERE they render is
// SparkleLogo.placement.test's subject.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import type { ConciergeController, ConciergeNudge, ConciergeViewModel } from "./types";

afterEach(() => cleanup());

const nudge: ConciergeNudge = {
  id: "n1",
  kind: "nudge",
  band: "needs_you",
  projectName: "drodio-website",
  agentName: "OG Image Pipeline",
  text: "A build warning needs your call.",
  actions: [{ id: "show", label: "Show me", kind: "primary" }],
};

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 1, running: 2, done: 0 },
  messages: [
    { id: "m1", kind: "sparkle", text: "Morning — I'm watching every open project.", speakable: true },
    { id: "m2", kind: "you", text: "Thanks, keep me posted." },
    { id: "m3", kind: "batch", text: "All projects calm · nothing needs you" },
    nudge,
  ],
};

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onMicToggle: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
  };
}

describe("ConciergeColumn — view-model → rendered output", () => {
  it("renders the brand mark, scope, vitals, and every message kind", () => {
    const { container } = render(<ConciergeColumn model={model} controller={controller()} />);
    // The mark is the Sparkle.ai LOGO, sharing the header's one row with the credit pill — see
    // SparkleLogo.placement.test for the one-mark contract and the corner-to-corner placement.
    expect(screen.getByAltText("Sparkle")).toBeTruthy();
    expect(screen.getByText("Following all projects")).toBeTruthy();
    expect(container.textContent).toContain("1 Needs you · 2 Running");
    expect(screen.getByText("Morning — I'm watching every open project.")).toBeTruthy();
    expect(screen.getByText("Thanks, keep me posted.")).toBeTruthy();
    expect(screen.getByText("All projects calm · nothing needs you")).toBeTruthy();
    expect(screen.getByText("A build warning needs your call.")).toBeTruthy();
    // No authorship labels anywhere — alignment carries who's talking.
    expect(screen.queryByText("You")).toBeNull();
  });

  it("nudge gestures route through the controller from inside the thread", () => {
    const c = controller();
    render(<ConciergeColumn model={model} controller={c} />);
    fireEvent.click(screen.getByText("A build warning needs your call."));
    expect(c.onNudgeClick).toHaveBeenCalledWith(nudge);
    fireEvent.click(screen.getByText("Show me"));
    expect(c.onNudgeAction).toHaveBeenCalledWith(nudge, "show");
    expect(c.onNudgeClick).toHaveBeenCalledTimes(1); // the action did not double as a card click
  });

  it("composing routes onSend through the controller", () => {
    const c = controller();
    render(<ConciergeColumn model={model} controller={c} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "approve it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(c.onSend).toHaveBeenCalledWith("approve it");
  });

  it("shows the typing indicator only while the view-model says Sparkle is typing", () => {
    const { rerender } = render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.queryByLabelText("Sparkle is typing")).toBeNull();
    rerender(<ConciergeColumn model={{ ...model, typing: true }} controller={controller()} />);
    expect(screen.getByLabelText("Sparkle is typing")).toBeTruthy();
  });
});
