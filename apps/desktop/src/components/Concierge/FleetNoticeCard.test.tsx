// @vitest-environment jsdom
//
// THE PROPERTY: the card reproduces what the citation rule vouched for, character for character.
//
// `pusherFleet` composes each sentence from measured values and verbatim quotes, and `pusherGate`
// refuses any number that was not measured. That guarantee survives only if the renderer changes
// nothing — a card that re-phrased, truncated or reformatted would put prose outside the rule the
// whole feature rests on. So these tests assert the exact strings, not that "something rendered".
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FleetNoticeCard, splitNoticeText } from "./FleetNoticeCard";
import { evaluateFleetConditions, type FleetSnapshot } from "@sparkle/core";

afterEach(cleanup);

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const WEEKLY = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";
const OFFLINE = "API Error: Unable to connect to API (ENOTFOUND)";

const walled = (id: string): FleetSnapshot => ({
  agentId: id,
  label: `Agent ${id}`,
  quota: { message: WEEKLY, resetAt: T0 + 4 * HOUR, resetParsed: true },
});

describe("splitNoticeText", () => {
  it("keeps the lead sentence exactly", () => {
    expect(splitNoticeText("A lead.\n  - one\n  - two").lead).toBe("A lead.");
  });

  it("strips only the bullet prefix, never the content", () => {
    expect(splitNoticeText("Lead\n  - Agent A — gave up").bullets).toEqual(["Agent A — gave up"]);
  });

  it("does not eat a hyphen inside the content", () => {
    expect(splitNoticeText('Lead\n  - 5 agents died — one event: "err-code-3"').bullets).toEqual([
      '5 agents died — one event: "err-code-3"',
    ]);
  });

  it("drops blank rows rather than rendering empty lines", () => {
    expect(splitNoticeText("Lead\n\n  - one").bullets).toEqual(["one"]);
  });
});

describe("FleetNoticeCard", () => {
  // An empty card is a permanent "everything is fine" box, which is exactly the thing a reader
  // stops seeing — and this feature exists because things were being missed.
  it("renders nothing when the fleet is healthy", () => {
    const { container } = render(<FleetNoticeCard conditions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("quotes the limit banner verbatim, including the reset time", () => {
    const conditions = evaluateFleetConditions([walled("a"), walled("b")], T0);
    render(<FleetNoticeCard conditions={conditions} />);
    // The exact bytes the agent printed — the only place the reset time and remedy path appear.
    expect(screen.getByText(new RegExp(WEEKLY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
  });

  it("keeps the do-not-retry sentence, which is the half that cost the founder hours", () => {
    render(<FleetNoticeCard conditions={evaluateFleetConditions([walled("a")], T0)} />);
    expect(screen.getByText(/Restarting them does not help/)).toBeTruthy();
  });

  it("renders every condition, tagged by id so a surface test can find one", () => {
    const conditions = evaluateFleetConditions(
      [
        walled("q"),
        { agentId: "e", label: "Agent e", escalation: { reason: "auto-continue gave up" } },
      ],
      T0,
    );
    render(<FleetNoticeCard conditions={conditions} />);
    const rendered = screen
      .getAllByTestId("fleet-notice-condition")
      .map((n) => n.getAttribute("data-condition"));
    expect(rendered).toEqual(["quota-blocked", "goals-escalated"]);
  });

  it("names each escalated agent and its blocker, so one glance clears the batch", () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({
      agentId: `a${i}`,
      label: `Agent ${i}`,
      escalation: { reason: `blocker ${i}` },
    }));
    render(<FleetNoticeCard conditions={evaluateFleetConditions(eight, T0)} />);
    expect(screen.getByText(/8 goals are escalated/)).toBeTruthy();
    for (let i = 0; i < 8; i++) expect(screen.getByText(new RegExp(`blocker ${i}`))).toBeTruthy();
  });

  it("reports N shutdown casualties as ONE event, with the shared error", () => {
    const died = (id: string): FleetSnapshot => ({
      agentId: id,
      label: `Agent ${id}`,
      failure: { message: OFFLINE, at: T0 },
    });
    const conditions = evaluateFleetConditions(["a", "b", "c", "d", "e"].map(died), T0);
    render(<FleetNoticeCard conditions={conditions} />);
    expect(screen.getByText(/5 agents stopped for a single shared reason/)).toBeTruthy();
    expect(screen.getByText(new RegExp(OFFLINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
  });

  it("names what is holding an overdue duty", () => {
    const conditions = evaluateFleetConditions([], T0, [
      {
        name: "the hourly improvement pass (logs + beads backlog)",
        intervalMs: HOUR,
        lastRunAt: T0 - 9 * HOUR,
        heldBy: "the Sparkle agent pane reads 'working'",
      },
    ]);
    render(<FleetNoticeCard conditions={conditions} />);
    expect(screen.getByText(/logs \+ beads backlog/)).toBeTruthy();
    expect(screen.getByText(/Held by: the Sparkle agent pane reads 'working'\./)).toBeTruthy();
  });

  // NOT the nudge sienna — the alarm colour belongs to the cards that carry an action. Pinned so a
  // later restyle has to make that decision deliberately rather than by drift.
  it("uses the briefing accent, not the alarm accent", () => {
    render(<FleetNoticeCard conditions={evaluateFleetConditions([walled("a")], T0)} />);
    const card = screen.getByTestId("fleet-notice");
    expect(card.getAttribute("style")).toContain("accent");
  });

  // THE CARD MUST NOT BE THE COLUMN'S SHOCK ABSORBER (roborev 57483). Its siblings are all
  // `flex: "0 0 auto"` and the thread is `flex: 1` with a zero shrink factor, so a card left at the
  // default `0 1 auto` takes 100% of any vertical overflow — and its bullet list is one row PER
  // AGENT by design, so on a real fleet it painted over the approval row and the composer.
  //
  // jsdom evaluates no layout, so this asserts the DECLARATIONS rather than a measured height —
  // the honest thing to check here, and the same call this repo makes for CSS it cannot compute.
  it("does not shrink, and bounds its own height instead of overflowing the column", () => {
    render(<FleetNoticeCard conditions={evaluateFleetConditions([walled("a")], T0)} />);
    const style = screen.getByTestId("fleet-notice").getAttribute("style") ?? "";
    expect(style).toContain("flex: 0 0 auto");
    expect(style).toMatch(/max-height:\s*32vh/);
    expect(style).toMatch(/overflow-y:\s*auto/);
  });

  // Capping the LIST would drop agents, which is the one thing a card built so nothing goes
  // unnoticed must not do. The box scrolls; every agent stays reachable.
  it("still names every agent in a large batch rather than truncating the list", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      agentId: `a${i}`,
      label: `Agent ${i}`,
      escalation: { reason: `blocker ${i}` },
    }));
    render(<FleetNoticeCard conditions={evaluateFleetConditions(twenty, T0)} />);
    for (let i = 0; i < 20; i++) expect(screen.getByText(new RegExp(`blocker ${i}$`))).toBeTruthy();
  });
});
