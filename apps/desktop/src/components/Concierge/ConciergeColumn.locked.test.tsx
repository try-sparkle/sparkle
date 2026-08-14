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
  vitals: { needs_you: 3, questions: 0, running: 0, done: 0 },
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
  // THE "ACROSS THE FLEET" BOX IS GONE ON PURPOSE (bead sparkle-d43bf), and the two cases that
  // pinned it here went with it: one asserted the card still rendered with the paid half locked,
  // the other that it was a DIRECT child of the flex stack. Both described a card that no longer
  // exists.
  //
  // NOTHING REPLACES THEM HERE, DELIBERATELY. The obvious substitute — assert `fleet-notice` is
  // absent — is vacuous in every reachable world: this suite defaulted the conditions to `[]`, and
  // the card rendered null on an empty list, so the assertion passed before the change, passes
  // after it, and would keep passing if the card were re-added verbatim. That is the exact shape
  // AGENTS.md calls the #1 fleet-wide finding, and writing it would leave a test that reads like a
  // guard while guarding nothing (roborev 57666). The removal is proven where it can be: the
  // modules are deleted, so a re-add cannot typecheck, and the `concierge-column` visual capture
  // shows the same fixture rendering the box before and not after.

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

// ══ …BUT A MOUNTED COLUMN STILL HAS A TYPING AREA (bead sparkle-voudj7) ═══════════════════════
//
// THE FOUNDER'S REPORT, verbatim: *"I don't have any terminal typing area."* He mounted an agent
// pane and the column gave him NO input surface of any kind — not a disabled box, not a refusal he
// could read, nothing to type into at all.
//
// The state was KNOWN and un-tested. Four comments in ConciergeColumn described `aiLock && isWired`
// and each ended "and THERE IS NO COMPOSER AT ALL"; every one treated that as a fact to route
// around — gate the neighbouring affordance off too, so nothing points at a box that isn't there —
// and none asked whether the box should have been gone. Meanwhile every suite that finds the
// textarea calls `enableAiEnhancementsForTests()` first, and the locked suite above never mounts,
// so no test in the repo ever visited the one state the founder was in.
//
// WHY IT IS A BUG RATHER THAN A STRICT PAYWALL: mounted, this box is not the paid brain. What the
// human types goes to their OWN agent's PTY — a keystroke relay that calls no model and costs
// nothing. `conciergeAiLock`'s own header says only the chat and the tools hang off the lock; the
// composer was taken by mistake.
describe("ConciergeColumn locked but MOUNTED — the cable is not the paid half", () => {
  const mounted = {
    agentId: "agent-1",
    name: "Kraken Auth",
    thread: { entries: [], hasMore: false, loading: false },
    onReachTop: vi.fn(),
  } as unknown as NonNullable<Parameters<typeof ConciergeColumn>[0]["mountedAgent"]>;

  const renderMountedAndLocked = () =>
    render(
      <ConciergeColumn
        model={model}
        controller={controller()}
        wired="right"
        mountedAgent={mounted}
        routableMountedAgentId={mounted.agentId}
      />,
    );

  it("renders a typing area", () => {
    renderMountedAndLocked();
    // `getBy*` throws with the DOM attached, so this is the row that would have named the founder's
    // symptom directly instead of leaving him to describe it.
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.getByTestId("concierge-compose")).toBeTruthy();
  });

  // THE SIDE EFFECT, not just the pixels. A box that renders but cannot deliver is the same outage
  // wearing a nicer face — and this is the assertion that would fail if a later change re-gated the
  // SEND while leaving the textarea on screen.
  it("and that typing area actually sends", () => {
    const c = controller();
    render(
      <ConciergeColumn
        model={model}
        controller={c}
        wired="right"
        mountedAgent={mounted}
        routableMountedAgentId={mounted.agentId}
      />,
    );
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "run the tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(c.onSend).toHaveBeenCalledWith("run the tests");
  });

  it("shows the agent's own thread, not the upsell", () => {
    renderMountedAndLocked();
    expect(screen.queryByTestId("concierge-ai-locked")).toBeNull();
    expect(screen.queryByText(CONCIERGE_AI_PITCH)).toBeNull();
  });

  // THE PAIRED CASE, and the reason the two are in one file: unmount and the paywall must come
  // straight back. Without this row the fix above could be "delete the lock" and still go green,
  // which is the failure mode the locked suite exists to prevent.
  it("…and unmounting restores the upsell with no composer", () => {
    render(<ConciergeColumn model={model} controller={controller()} wired="off" />);
    expect(screen.getByTestId("concierge-ai-locked")).toBeTruthy();
    expect(screen.queryByTestId("concierge-compose")).toBeNull();
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
