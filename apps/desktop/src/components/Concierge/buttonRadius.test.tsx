// @vitest-environment jsdom
//
// EVERY LABELLED ACTION BUTTON ROUNDS LIKE PUSH TO TALK — the founder's ask, pinned by comparison
// rather than by a number.
//
// His words, off a screenshot of the BLOCKED card in the concierge thread (2026-08-06):
//
//     "I don't like these rounded buttons. I want the buttons to be less rounded, like the
//      roundedness of the Push to Talk button for example. Change the Approve roundedness to be
//      less like Push to Talk and then also change it in any other modals that also have buttons
//      like that."
//
// ── WHY THIS TEST READS THE REFERENCE INSTEAD OF ASSERTING `4` ────────────────────────────────
// The founder named a REFERENCE ("the Push to Talk button"), not a value. A test that asserted
// `borderRadius === "4px"` on the Approve button would be true of the fix and equally true of a
// future in which someone re-rounds the send tray and leaves these behind — i.e. it would pin the
// number he did not choose and stop guarding the relationship he did. So the reference is MEASURED:
// `SendModeTray` is rendered, the Push-to-talk pill's own computed inline radius is read off the
// DOM, and every button below is compared to THAT.
//
// Reading both sides off the rendered DOM is also what keeps this from being vacuous in the
// specific way this repo keeps rediscovering (`docs/jsdom-test-caveats.md`, and the "extraction
// creates new vacuity" lesson): if these cases imported `RADIUS.input` and asserted both sides
// equalled it, they would pass against a component that had reverted to a hard-coded `999` — because
// the assertion would never have looked at the component at all. Here, a revert on either side is a
// mismatch. The one thing asserted absolutely is the NEGATIVE (`999px`), which is the shape the
// founder rejected and which no reference-drift can make acceptable again.
//
// ── WHAT IS DELIBERATELY *NOT* IN THIS FILE ────────────────────────────────────────────────────
// Not every capsule in the app is a button, and "buttons like that" is the scope he gave. Left as
// capsules on purpose, each because the shape is carrying meaning rather than decorating a button:
//
//   • `AutoSendToggle` / `ToolsPane` switch TRACKS — a switch is a capsule the way its knob is a
//     circle. A 4px track with a round knob in it is a broken switch, not a squarer one.
//   • `PresenceSlider`'s group track, its Here/Away segments and its pin — a segmented control whose
//     segments sit INSIDE a capsule track. Squaring the segments alone would leave 4px boxes rattling
//     in a 999px frame; squaring the track would stop the control reading as a slider at all.
//   • `AttachmentStrip`'s remove badge — an 18x18 SQUARE box, so `999` there is a CIRCLE. There is
//     no "less rounded circle"; the alternative is a different shape.
//   • `AgentSidebar`'s close control — and this one is NOT the circle case, which is worth stating
//     because the first cut of this list said it was. It is `glyphWidth` (12) x 22, so `999` paints
//     a real vertical CAPSULE. It is left alone on scope, not on geometry: it is a hover-revealed
//     row affordance in the sidebar — it takes the leading glyph's slot so the name does not shift,
//     and the pill IS the hit target appearing — not a labelled action button in a modal or a card,
//     which is the scope the founder named. If that reading is ever revisited, revisit it as a
//     SCOPE decision; do not re-derive it from the shape (roborev 59577).
//   • `ConciergeColumn`'s credit backdrop — not a control at all, a blurred plate behind the balance.
//   • `BeadCard/PriorityPill` — already `RADIUS.sm` via the shared `tag()` treatment; the `999` the
//     sweep found there is a COMMENT explaining what that treatment exists to refuse.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalPrompt } from "./ApprovalPrompt";
import { AgentPillProvider } from "./AgentPill";
import { NudgeCard } from "./NudgeCard";
import { QuoteChiclet, QUOTE_CHICLET_TESTID } from "./QuoteChiclet";
import { SendModeTray } from "./SendModeTray";
import type { ConciergeApproval } from "../../stores/conciergeApprovals";
import type { ConciergeNudge } from "./types";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

/** The shape the founder rejected: a full stadium capsule. */
const CAPSULE = "999px";

/**
 * THE REFERENCE. Renders the real send tray and reads the Push-to-talk pill's own radius back off
 * the node — no token import, no literal — so this is the radius the app actually paints on the
 * button he pointed at.
 */
function pushToTalkRadius(): string {
  const { unmount } = render(
    <SendModeTray mode="send" onModeChange={vi.fn()} onSend={vi.fn()} canSend chord="cmd-enter" />,
  );
  const pill = screen
    .getByTestId("send-mode-tray")
    .querySelector<HTMLElement>('[data-mode-pill="ptt"]');
  const radius = pill?.style.borderRadius ?? "";
  unmount();
  return radius;
}

const blockedNudge: ConciergeNudge = {
  id: "a-mirror",
  kind: "nudge",
  band: "needs_you",
  projectName: "sparkle",
  agentName: "Recap Expands Not Scrolls",
  text: "Blocked on an approval.",
  actions: [{ id: "approve", label: "Approve", kind: "primary" }],
};

function renderBlockedCard() {
  render(
    <AgentPillProvider
      value={{
        agents: [
          {
            id: blockedNudge.id,
            name: blockedNudge.agentName,
            projectId: "p1",
            projectName: blockedNudge.projectName,
            band: blockedNudge.band,
            canAcceptInput: true,
          },
        ],
        onOpenAgent: vi.fn((): RevealOutcome => "revealed"),
      }}
    >
      <NudgeCard nudge={blockedNudge} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />
    </AgentPillProvider>,
  );
}

function pendingApproval(): ConciergeApproval {
  return {
    id: "call-1",
    requestedBy: "sparkle:concierge",
    domain: "lifecycle",
    op: "discard_agent",
    summary: "Throw the agent's work away.",
    riskClass: "irreversible",
    riskNote: "Permanently destroys something that cannot be recovered.",
    args: [{ key: "agentId", value: "kraken-auth" }],
    rawArgs: { agentId: "kraken-auth" },
    configPath: "concierge.tools.discard_agent",
    fingerprint: "lifecycle.discard_agent#{}",
    requestedAt: 0,
    expiresAt: 1,
    outcome: "pending",
    resolvedAt: null,
    spent: false,
  };
}

describe("the reference itself", () => {
  it("Push to talk is a drawn box, not a capsule — otherwise there is nothing to match", () => {
    // If this ever fails, the founder's reference moved and every case below is comparing against
    // the wrong thing. Stated first, and stated as its own case, so that failure names itself
    // instead of surfacing as three confusing mismatches downstream.
    const reference = pushToTalkRadius();
    expect(reference).not.toBe("");
    expect(reference).not.toBe(CAPSULE);
  });
});

describe("NudgeCard — the BLOCKED card's Approve button", () => {
  it("rounds exactly like Push to Talk", () => {
    const reference = pushToTalkRadius();
    renderBlockedCard();
    // By its accessible name, which is what the founder is pointing at in the screenshot.
    expect(screen.getByRole("button", { name: "Approve" }).style.borderRadius).toBe(reference);
  });

  it("is no longer a stadium pill", () => {
    // The direct statement of the complaint, independent of the reference. This is the assertion
    // that fails against `main`, where the button carries `borderRadius: 999`.
    renderBlockedCard();
    expect(screen.getByRole("button", { name: "Approve" }).style.borderRadius).not.toBe(CAPSULE);
  });

  it("keeps its icon controls on the same radius, so the row reads as one set of buttons", () => {
    const reference = pushToTalkRadius();
    renderBlockedCard();
    for (const testId of ["concierge-nudge-mute", "concierge-nudge-dismiss"]) {
      expect(screen.getByTestId(testId).style.borderRadius).toBe(reference);
    }
  });
});

describe("QuoteChiclet — the quote-response button", () => {
  // Founder, 2026-08-12: *"Make this quote response button less rounded I can't stand the rounded
  // buttons like that."* — the same complaint as 2026-08-06, one component later. It shipped as
  // `PILL` behind a comment arguing "this really is a pill"; that reading has been overruled, and
  // PR #1775 moved it to `RADIUS.input`.
  //
  // ── WHY THIS CASE EXISTS ALONGSIDE `QuoteChiclet.radius.test.tsx`, AND WHAT IT DOES *NOT* ADD ─
  // That file asserts the chiclet equals the `RADIUS.input` TOKEN. This one asserts it equals the
  // BUTTON HE NAMED, measured off the DOM. The delta is narrower than it first looks, and the
  // overstated version of this comment was written and then MEASURED before it was believed:
  //
  //   re-point `--r-input` at "999px" → BOTH files go red. The token test's own "is not the PILL
  //   token" case catches it, because `PILL` did not move with the re-point. So "a token re-point
  //   would sail past the token test" is FALSE; it was the tempting argument for this file and it
  //   does not hold.
  //
  // What this DOES add is the case the token test cannot see, because it never looks at the
  // reference: the chiclet and the button the founder pointed at DIVERGING. Hard-code Push to
  // talk's radius, or move it to a different token, and the chiclet keeps matching `RADIUS.input`
  // (token test green) while no longer matching Push to Talk — which is the relationship he
  // actually named, and the one this file exists to hold every labelled action button to. The
  // "reference itself" case at the top is what tells those two failures apart.
  //
  // So: kept because the instruction was a comparison, not a value, and this is where every other
  // button in that instruction is pinned — not because the token test has a hole.
  //
  // Being PORTALLED to `document.body` is why this component was not swept up with
  // `NudgeCard`/`ApprovalPrompt` in the first pass: it renders outside the thread, so a sweep that
  // rendered cards never saw it.
  function renderChiclet() {
    render(<QuoteChiclet x={40} y={40} onQuote={vi.fn()} onDismiss={vi.fn()} />);
    return screen.getByTestId(QUOTE_CHICLET_TESTID);
  }

  it("rounds exactly like Push to Talk", () => {
    const reference = pushToTalkRadius();
    expect(renderChiclet().style.borderRadius).toBe(reference);
  });

  it("is no longer a stadium pill", () => {
    // The direct statement of the complaint, independent of the reference — the assertion that
    // fails against the version PR #1775 replaced, where this button carried `borderRadius: PILL`.
    expect(renderChiclet().style.borderRadius).not.toBe(CAPSULE);
  });
});

describe("ApprovalPrompt — the modal's Approve and Decline", () => {
  it("round exactly like Push to Talk, and are not capsules", () => {
    const reference = pushToTalkRadius();
    render(
      <ApprovalPrompt
        approvals={[pendingApproval()]}
        onApprove={vi.fn()}
        onDecline={vi.fn()}
        onAlwaysAllow={vi.fn()}
      />,
    );
    // Both, not just Approve: they share one `actionBtn()` base, and the whole point of fixing them
    // together is that a pair of buttons side by side must not disagree about their own shape.
    for (const name of [/approve/i, /decline/i]) {
      const btn = screen.getByRole("button", { name });
      expect(btn.style.borderRadius).toBe(reference);
      expect(btn.style.borderRadius).not.toBe(CAPSULE);
    }
  });
});
