// @vitest-environment jsdom
//
// THE POINT OF THE LOCKED DESIGN, as a test. The concierge column keeps its FREE half and locks
// only the paid one: the status readout is derived from local app state and costs nothing to run,
// so with AI enhancements shut off the column still tells you which agents need you — the lock sits
// directly beside live proof that the thing it sells would be useful.
//
// That is exactly the property a future refactor breaks silently ("the gate is shut, render the
// upsell and nothing else"), so it is asserted here rather than left implied:
//   1. ScopeVitals, the needs-you counts, and the per-project segments all keep working, and the
//      segment click still routes through the controller.
//   2. The composer is GONE, so no send can even be attempted while gated — the paid `claude -p`
//      brain can never be reached from a column in this state.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));
// AiLockedNotice's checkout rails reach for Tauri; its own test owns that behavior.
vi.mock("../../services/sparkleApi", () => ({
  openPaywall: vi.fn(() => Promise.resolve(true)),
  PAYWALL_URL: "https://sparkle.ai/paywall",
}));
vi.mock("../../services/creditsMenuApi", () => ({
  openPaywallCheckout: vi.fn(() => Promise.resolve(true)),
  lastCheckoutUrl: vi.fn(() => null),
}));

import { ConciergeColumn } from "./ConciergeColumn";
import { CONCIERGE_AI_PITCH } from "./ConciergeAiLocked";
import { switchLabel } from "./ScopeVitals";
import { useAuthStore } from "../../stores/authStore";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import type { ConciergeController, ConciergeViewModel } from "./types";

/** The mock's column, in view-model form: three projects with someone waiting in each. */
const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 3, running: 0, done: 0 },
  needsYouByProject: [
    { projectId: "p1", projectName: "web", needsYou: 1, isActive: true },
    { projectId: "p2", projectName: "api", needsYou: 1, isActive: false },
    { projectId: "p3", projectName: "docs", needsYou: 1, isActive: false },
  ],
  messages: [{ id: "m1", kind: "sparkle", text: "Morning — I'm watching every open project." }],
};

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
    onProjectClick: vi.fn(),
  };
}

/** The anonymous-trial shape: nothing bought, no credits. */
function shutTheGate() {
  useAuthStore.setState({ me: null, creditFloorCents: 0 });
}

beforeEach(() => shutTheGate());
afterEach(() => cleanup());

describe("ConciergeColumn with AI enhancements locked — the FREE half stays live", () => {
  it("still renders the status readout: the scope line and the needs-you count", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // The FULL split, not just a total: who is waiting and where. Exactly what the mock's column
    // shows above the lock, and exactly what a "render the upsell and nothing else" refactor loses.
    expect(screen.getByTestId("concierge-vitals-line").textContent).toBe(
      "All projects · 1 here · 1 in api · 1 in docs",
    );
    expect(screen.getByTestId("concierge-needs-dot")).toBeTruthy();
    expect(screen.getByLabelText("3 Need you")).toBeTruthy();
  });

  it("still renders the per-project segments, and clicking one still switches projects", () => {
    const c = controller();
    render(<ConciergeColumn model={model} controller={c} />);
    const seg = screen.getByRole("button", { name: switchLabel("api", 1) });
    fireEvent.click(seg);
    expect(c.onProjectClick).toHaveBeenCalledWith("p2");
  });

  it("still renders a search slot the host hands it — the free chrome is untouched", () => {
    render(
      <ConciergeColumn
        model={model}
        controller={controller()}
        searchSlot={<div data-testid="search-slot" />}
      />,
    );
    expect(screen.getByTestId("search-slot")).toBeTruthy();
  });
});

describe("ConciergeColumn with AI enhancements locked — the PAID half is gone", () => {
  it("replaces the thread and the composer with the upsell", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByTestId("concierge-ai-locked")).toBeTruthy();
    expect(screen.getByText(CONCIERGE_AI_PITCH)).toBeTruthy();
    expect(screen.queryByTestId(CONCIERGE_THREAD_TESTID)).toBeNull();
    expect(screen.queryByTestId("concierge-compose")).toBeNull();
    // The thread's content is not merely hidden — a locked column never renders the conversation.
    expect(screen.queryByText("Morning — I'm watching every open project.")).toBeNull();
  });

  it("attempts NO send: there is nothing to type into and nothing to press", () => {
    const c = controller();
    render(<ConciergeColumn model={model} controller={c} />);
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    // Nothing left in the column can reach the paid brain: press everything that IS there.
    for (const b of screen.queryAllByRole("button")) fireEvent.click(b);
    expect(c.onSend).not.toHaveBeenCalled();
  });

  it("pitches the $99 for a trial user, not a settings toggle", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByRole("button", { name: /Unlock Sparkle/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on AI enhancements" })).toBeNull();
  });
});

describe("ConciergeColumn with AI enhancements ON — nothing changed", () => {
  beforeEach(() => {
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
      creditFloorCents: 0,
    });
  });

  it("renders the thread and the composer, and the upsell is nowhere", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByText("Morning — I'm watching every open project.")).toBeTruthy();
    expect(screen.getByTestId("concierge-compose")).toBeTruthy();
    expect(screen.queryByTestId("concierge-ai-locked")).toBeNull();
  });

  it("sends through the controller", () => {
    const c = controller();
    render(<ConciergeColumn model={model} controller={c} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "approve it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(c.onSend).toHaveBeenCalledWith("approve it");
  });
});
