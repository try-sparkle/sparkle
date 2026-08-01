// @vitest-environment jsdom
//
// THE POINT OF THE LOCKED DESIGN, as a test. The concierge column keeps its FREE half and locks
// only the paid one: the status readout is derived from local app state and costs nothing to run,
// so with AI enhancements shut off the column still tells you which agents need you — the lock sits
// directly beside live proof that the thing it sells would be useful.
//
// That is exactly the property a future refactor breaks silently ("the gate is shut, render the
// upsell and nothing else"), so it is asserted here rather than left implied:
//   1. The needs-you readout keeps working and its control still routes through the shell. Since
//      bead sparkle-ircc3 that readout is the red filter pill and nothing else — the scope/vitals
//      line beside the wordmark was deleted, so what a locked column must still show is the COUNT
//      and a working filter, not a sentence.
//   2. The composer is GONE, so no send can even be attempted while gated — the paid `claude -p`
//      brain can never be reached from a column in this state.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../useFleetNotices", () => ({ useFleetNotices: vi.fn(() => []) }));
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

import { useFleetNotices } from "../../useFleetNotices";
import { evaluateFleetConditions } from "@sparkle/core";
import { ConciergeColumn } from "./ConciergeColumn";
import { CONCIERGE_AI_PITCH } from "./ConciergeAiLocked";
import { CONCIERGE_UNAVAILABLE_TESTID } from "./ConciergeUnavailable";
import { FAILURE_OUTAGE_RUN } from "../../engine/conciergeLiveness";
import {
  _resetConciergeLivenessForTests,
  noteConciergeFailed,
} from "../../services/conciergeLiveness";
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
    // The free half's ONE control since bead sparkle-ircc3. It is optional, and the pill does not
    // render without it — so a locked-column test that omitted it would assert the readout is
    // missing for the wrong reason and pass while the gate was over-reaching.
    onNeedsYouFilterToggle: vi.fn(),
  };
}

/** The anonymous-trial shape: nothing bought, no credits. */
function shutTheGate() {
  useAuthStore.setState({ me: null, creditFloorCents: 0 });
}

beforeEach(() => {
  shutTheGate();
  _resetConciergeLivenessForTests();
});
afterEach(() => cleanup());

/** Drive the liveness detector into its sticky failure-outage state, the way a run of quota rejections
 *  does. No timers needed: every failure observed in a day of logs was a fast, loud error. */
function makeConciergeUnavailable() {
  for (let i = 0; i < FAILURE_OUTAGE_RUN; i += 1) {
    noteConciergeFailed("You've hit your session limit · resets 8:40am (America/Bogota)");
  }
}

describe("ConciergeColumn with AI enhancements locked — the FREE half stays live", () => {
  // THE FLEET NOTICE IS FREE TOO, and it matters most in exactly this state. Its neighbours in that
  // stack (ConciergeUnavailable, MountedNotice) render only when the gate is OPEN, because with no
  // brain there is nothing to be unresponsive about. This row needs no model and no network, so it
  // is the one thing in the column that still reports when the paid half is off, unbought, or out
  // of credits — which is the same condition a quota-blocked fleet is in. Gating it would hide the
  // report precisely when it is the only report available.
  it("still renders the fleet notice, which needs no brain to compute", () => {
    vi.mocked(useFleetNotices).mockReturnValue(
      evaluateFleetConditions(
        [
          {
            agentId: "a",
            label: "Agent a",
            quota: {
              message: "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)",
              resetAt: Date.now() + 4 * 60 * 60 * 1000,
              resetParsed: true,
            },
          },
        ],
        Date.now(),
      ),
    );
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByTestId("fleet-notice")).toBeTruthy();
    expect(screen.getByText(/Restarting them does not help/)).toBeTruthy();
  });

  it("still renders the status readout: the needs-you count, on the red pill", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // THE COUNT SURVIVES THE GATE. It is derived from local app state and costs nothing to run, so
    // a shut gate has no reason to take it away — and "render the upsell and nothing else" is the
    // refactor that does exactly that. The pill states the whole in-scope total (3, across web/api/
    // docs), and names it for assistive tech too.
    const pill = screen.getByTestId("concierge-needs-filter");
    expect(pill.textContent).toBe("3");
    expect(pill.getAttribute("aria-label")).toBe("Show only what needs you (3)");
  });

  it("still routes the filter through the shell — the free control is live, not decoration", () => {
    const c = controller();
    render(<ConciergeColumn model={model} controller={c} />);
    fireEvent.click(screen.getByTestId("concierge-needs-filter"));
    expect(c.onNeedsYouFilterToggle).toHaveBeenCalled();
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

// ── THE LIVENESS STRIP'S MOUNT POINT ────────────────────────────────────────────────────────────
//
// roborev 55442-M5. The strip had thorough component-level tests and NO test of the one line that
// puts it on screen — deleting `{!aiLock && <ConciergeUnavailable />}` left the whole suite green
// with the feature's primary surface gone. These two rows are about the mount and the gate, not
// about the strip's contents (ConciergeUnavailable.test owns those).
describe("ConciergeColumn — the concierge-unavailable strip", () => {
  it("mounts the strip when the concierge has stopped answering", () => {
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
      creditFloorCents: 0,
    });
    makeConciergeUnavailable();
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByTestId(CONCIERGE_UNAVAILABLE_TESTID)).toBeTruthy();
  });

  // A DELIBERATE COPY DECISION, not an oversight. With the paid half locked there is no brain to be
  // unresponsive, and ConciergeAiLocked already owns the true explanation — a second, vaguer
  // "your concierge isn't answering" stacked under it would contradict it.
  it("stays out of the way when the AI gate is shut — that half is already explained", () => {
    shutTheGate();
    makeConciergeUnavailable();
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByTestId("concierge-ai-locked")).toBeTruthy();
    expect(screen.queryByTestId(CONCIERGE_UNAVAILABLE_TESTID)).toBeNull();
  });
});
