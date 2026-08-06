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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import { CONCIERGE_COLUMN_DND_TARGET } from "../../services/dndTargets";
import type { ConciergeController, ConciergeNudge, ConciergeViewModel } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import { NUDGE_CARD_TESTID } from "./NudgeCard";

// PRECONDITION, stated rather than inherited: every assertion below is about the column's PAID
// half — the thread and the compose box — which the column replaces with an upsell whenever the AI
// gate is shut (./conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`),
// which is locked. The locked state is ./ConciergeColumn.locked.test's subject, including the
// status readout above it, which stays live either way.
beforeEach(enableAiEnhancementsForTests);
afterEach(() => cleanup());

const nudge: ConciergeNudge = {
  id: "n1",
  kind: "nudge",
  band: "needs_you",
  projectName: "drodio-website",
  agentName: "OG Image Pipeline",
  text: "A build warning needs your call.",
  // Approve is the ONE labelled action a card still carries. "Show me" and "Mute" left this list
  // when the card became a single line: the agent's name is now a clickable `AgentPill` (so a
  // navigating button beside it was the same affordance twice) and Mute became an icon control
  // alongside the new [x]. See Concierge/NudgeCard and ConciergeHost.actionsFor.
  actions: [{ id: "approve", label: "Approve", kind: "primary" }],
};

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 1, questions: 0, running: 2, done: 0 },
  messages: [
    { id: "m1", kind: "sparkle", text: "Morning — I'm watching every open project." },
    { id: "m2", kind: "you", text: "Thanks, keep me posted." },
    { id: "m3", kind: "batch", text: "All projects calm · nothing needs you" },
    nudge,
  ],
};

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
  };
}

describe("ConciergeColumn — view-model → rendered output", () => {
  it("renders the brand mark, no scope line, and every message kind", () => {
    const { container } = render(<ConciergeColumn model={model} controller={controller()} />);
    // The mark is the Sparkle.ai LOGO, sharing the header's one row with the credit pill — see
    // SparkleLogo.placement.test for the one-mark contract and the corner-to-corner placement.
    // Queried by ROLE, not alt: §1 made the mark an alpha mask over C.goldInk rather than a painted
    // <img> (the asset's own cyan gradient was the largest decorative non-gold patch on screen), so
    // the accessible name moved from `alt` to `role="img"` + `aria-label`. Same name, no longer an
    // image element.
    expect(screen.getByRole("img", { name: "Sparkle" })).toBeTruthy();
    // NO header line at all now (bead sparkle-ircc3): the row that read "All projects · 1" is gone,
    // and the count survives only as the red needs-you pill's numeral. `2 Running` was already
    // deliberately absent (founder, 2026-07-27) and stays absent — the header states one band or
    // nothing. ConciergeColumn.header.test.tsx pins the whole row's text in all three states.
    expect(screen.queryByTestId("concierge-vitals-line")).toBeNull();
    expect(screen.queryByTestId("concierge-needs-dot")).toBeNull();
    expect(container.textContent).not.toContain("All projects · 1");
    expect(container.textContent).not.toContain("2 Running");
    expect(screen.getByText("Morning — I'm watching every open project.")).toBeTruthy();
    expect(screen.getByText("Thanks, keep me posted.")).toBeTruthy();
    expect(screen.getByText("All projects calm · nothing needs you")).toBeTruthy();
    // THE NUDGE, by its one line — a lead word, the agent as a pill, the project. Its `text` is
    // deliberately NOT on screen: the card used to repeat the whole alert as prose under itself,
    // which is the duplication the one-line rewrite removed (founder, 2026-07-30).
    expect(screen.getByTestId(NUDGE_CARD_TESTID)).toBeTruthy();
    expect(screen.getByText("in drodio-website")).toBeTruthy();
    expect(screen.queryByText("A build warning needs your call.")).toBeNull();
    // No authorship labels anywhere — alignment carries who's talking.
    expect(screen.queryByText("You")).toBeNull();
  });

  it("nudge gestures route through the controller from inside the thread", () => {
    const c = controller();
    render(<ConciergeColumn model={model} controller={c} />);
    fireEvent.click(screen.getByTestId(NUDGE_CARD_TESTID));
    expect(c.onNudgeClick).toHaveBeenCalledWith(nudge);
    fireEvent.click(screen.getByText("Approve"));
    expect(c.onNudgeAction).toHaveBeenCalledWith(nudge, "approve");
    // …and so does the [x], which is a control on the card rather than one of its actions.
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    expect(c.onNudgeAction).toHaveBeenCalledWith(nudge, "dismiss");
    expect(c.onNudgeClick).toHaveBeenCalledTimes(1); // no action doubled as a card click
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

// A file dropped ANYWHERE over the concierge attaches to the next prompt, so the hit-test marker
// the host's window-global drag listener resolves against has to be on the column ROOT — not on
// the compose box, which is a ~90px strip a real cursor misses. The listener (and the Sparkle
// pane's Composer, which stands down over this target) both find it by attribute, so a marker
// that moved or vanished breaks drag-and-drop silently and with nothing logged.
describe("drop target", () => {
  it("marks the whole column, and the compose box does not compete for it", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    const marked = document.querySelectorAll("[data-dnd-target]");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.getAttribute("data-dnd-target")).toBe(CONCIERGE_COLUMN_DND_TARGET);
    expect(marked[0]!.getAttribute("aria-label")).toBe("Sparkle concierge");
  });

  it("contains the compose box, so the affordance is inside the surface being dropped on", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    const column = document.querySelector(`[data-dnd-target="${CONCIERGE_COLUMN_DND_TARGET}"]`);
    expect(column!.contains(screen.getByTestId("concierge-compose"))).toBe(true);
  });
});

// The `deriveWordmarkMode` block that stood here is gone: `main` removed the star-field wordmark
// (and with it that helper) independently of this branch's §4. Nothing to re-test.

// ── THE USER'S BUBBLE IS A FILL, NOT AN OUTLINED BOX ──────────────────────────────────────────
// It carried `1px solid color-mix(muted 25%)` on top of its own fill, which says the same thing
// twice and said it faintly. The founder called it out directly. The tail corner is what marks the
// bubble as yours, so the identity survives losing the rule — this pins the absence so a future
// "add an edge for definition" has to argue with the fill first.
describe("the you-bubble", () => {
  it("has a fill and NO drawn border", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    const bubble = screen.getByTestId("you-bubble");
    // jsdom serializes an absent border to "", so assert on what must NOT be there.
    expect(bubble.style.border).not.toContain("solid");
    expect(bubble.style.borderWidth).toBe("");
    // …and the two things that DO carry it are still present.
    expect(bubble.style.background).toBeTruthy();
    expect(bubble.style.borderRadius).toBe("4px 4px 0 4px");
  });
});
