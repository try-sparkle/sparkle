// @vitest-environment jsdom
//
// The recap card's contract: it renders the newly-entered delta, it renders the gate decisions the
// sibling branch will feed it, and it carries NO live region of its own (the column's single
// role="status" node does the announcing — a second region double-announces).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecapCard } from "./RecapCard";
import { AgentPillProvider } from "./AgentPill";
import type { MentionAgent } from "./mentions";
import { ConciergeThread } from "./ConciergeThread";
import type { ConciergeRecapMessage } from "../../services/conciergeRecap";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

/** The two agents the fixture recap names, as the live roster a pill resolves against. */
const ROSTER = [
  { id: "a", name: "Kraken Auth", projectId: "p1", projectName: "sparkle", band: "needs_you" },
  { id: "b", name: "OG Images", projectId: "p2", projectName: "drodio-website", band: "done" },
] as unknown as readonly MentionAgent[];

const recap = (over: Partial<ConciergeRecapMessage> = {}): ConciergeRecapMessage => ({
  id: "recap-1",
  kind: "recap",
  awayMs: 12 * 60_000,
  needsYou: [
    {
      agentId: "a",
      agentName: "Kraken Auth",
      projectName: "sparkle",
      status: "waiting",
      statusLabel: "Needs you",
    },
  ],
  finished: [
    {
      agentId: "b",
      agentName: "OG Images",
      projectName: "drodio-website",
      status: "done",
      statusLabel: "Done",
    },
  ],
  decisions: [],
  ...over,
});

describe("RecapCard", () => {
  it("leads with the one-line summary", () => {
    render(<RecapCard recap={recap()} />);
    expect(
      screen.getByText("While you were away — 12 minutes: 1 needs you, 1 finished."),
    ).toBeTruthy();
  });

  it("renders the newly-entered delta, bucketed", () => {
    render(<RecapCard recap={recap()} />);
    const rows = screen.getAllByTestId("recap-change");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-status")).toBe("waiting");
    expect(rows[0]!.textContent).toContain("Kraken Auth");
    expect(rows[1]!.getAttribute("data-status")).toBe("done");
    expect(screen.getByText("Wants you")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("omits a section that has nothing in it", () => {
    render(<RecapCard recap={recap({ finished: [] })} />);
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.getAllByTestId("recap-change")).toHaveLength(1);
  });

  it("renders gate decisions with the outcome leading", () => {
    render(
      <RecapCard
        recap={recap({
          needsYou: [],
          finished: [],
          decisions: [
            {
              id: "d1",
              kind: "queued",
              agentName: "Kraken Auth",
              agentId: "ag-recap",
              summary: "Delete the staging database",
              at: 1,
            },
            { id: "d2", kind: "sent", agentName: "OG Images", agentId: "ag-recap", summary: "Re-ran the tests", at: 2 },
          ],
        })}
      />,
    );
    const rows = screen.getAllByTestId("recap-decision");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["queued", "sent"]);
    // "Held for you" and "Sent" are opposite facts, so the verb leads the line rather than trailing
    // the description.
    expect(rows[0]!.textContent!.startsWith("Held for you")).toBe(true);
    expect(rows[1]!.textContent!.startsWith("Sent")).toBe(true);
  });

  /** Agents for a section, named so a row can tell which ones survived the cap. */
  const changes = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({
      agentId: `${prefix}${i}`,
      agentName: `${prefix} ${i}`,
      projectName: "sparkle",
      status: "waiting" as const,
      statusLabel: "Needs you",
    }));

  const decisions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `d${i}`,
      kind: "sent" as const,
      agentName: `Agent ${i}`,
      agentId: "ag-recap",
      summary: `Did thing ${i}`,
      at: i,
    }));

  /** The overflow marker for one section, or null. Scoped by `data-section` because the case the
   *  cap exists for has THREE of these on screen at once. */
  const more = (section: string) =>
    screen.queryAllByTestId("recap-more").find((n) => n.getAttribute("data-section") === section) ??
    null;

  it("caps a long section and says how many it kept back", () => {
    // A night away on a large fleet is when this card has the most to say and the least room: 30
    // rows push the chat off screen above the compose box, the failure buildDigest exists to
    // prevent on the nudge side. The summary sentence still carries the totals.
    render(<RecapCard recap={recap({ needsYou: changes(12, "a"), finished: [] })} />);
    expect(screen.getAllByTestId("recap-change")).toHaveLength(5);
    expect(more("needsYou")!.textContent).toBe("+7 more in Wants you");
    // Nothing is hidden from the sentence — it still counts all twelve.
    expect(screen.getByText(/12 need you/)).toBeTruthy();
  });

  it("caps decisions from the RECENT end — the earliest are the ones that collapse", () => {
    // Decisions render oldest-first (the card reads as a narrative), but a cancelled deploy from
    // two minutes ago is the line you can still act on, so the tail is what survives the cap.
    render(<RecapCard recap={recap({ needsYou: [], finished: [], decisions: decisions(8) })} />);
    const rows = screen.getAllByTestId("recap-decision");
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain("Did thing 3");
    expect(rows[4]!.textContent).toContain("Did thing 7");
    expect(more("decisions")!.textContent).toBe("+3 earlier in What I did");
  });

  it("caps all three sections at once — the night-away case, which is the point", () => {
    // Every earlier cap row overflows exactly ONE section, which is not the shape that motivated
    // the cap. Here each section overflows, so the three markers have to stay distinguishable and
    // count their own section (roborev 53655-M).
    render(
      <RecapCard
        recap={recap({
          needsYou: changes(12, "n"),
          finished: changes(9, "f"),
          decisions: decisions(8),
        })}
      />,
    );
    expect(screen.getAllByTestId("recap-more")).toHaveLength(3);
    // A screen reader gets nothing from `data-section`, and nothing from an `aria-label` on a
    // role-less div either (generic elements prohibit name-from-author, so the name is dropped and
    // the text content is read instead — roborev 53665-M, 53674-M). The section therefore rides in
    // CONTENT, visually hidden, which is what actually reaches assistive tech. Asserted on the
    // accessible TEXT rather than on an attribute that may never be honoured.
    expect(more("needsYou")!.textContent).toBe("+7 more in Wants you");
    expect(more("finished")!.textContent).toBe("+4 more in Finished");
    expect(more("decisions")!.textContent).toBe("+3 earlier in What I did");
    // …and it stays hidden from sighted users, who read it off the heading directly above.
    // (jsdom doesn't model the legacy `clip` shorthand, so the assertion is on the rest of the
    // clip-rect idiom — a 1px overflow-hidden absolute box, the same shape as the column's
    // announcer. What matters is that it is off-screen rather than laid out.)
    const hidden = within(more("needsYou")!).getByTestId("recap-more-section");
    expect(hidden.style.position).toBe("absolute");
    expect(hidden.style.width).toBe("1px");
    expect(hidden.style.overflow).toBe("hidden");
    // 5 + 5 rows kept, and the change sections trail their marker while decisions lead with it.
    expect(screen.getAllByTestId("recap-change")).toHaveLength(10);
    const order = Array.from(
      document.querySelectorAll("[data-testid='recap-change'],[data-testid='recap-more']"),
    );
    expect(order.indexOf(more("needsYou")!)).toBe(5); // after its five rows
    expect(order.indexOf(more("finished")!)).toBe(11); // after the next five
    // The decisions marker LEADS its section: no change row follows it.
    expect(order.indexOf(more("decisions")!)).toBe(order.length - 1);
  });

  it("shows every row when the section fits", () => {
    render(<RecapCard recap={recap()} />);
    expect(screen.queryByTestId("recap-more")).toBeNull();
  });

  it("paints the project chip in themed ink, never the brand amber constant", () => {
    // Brand amber is constant across themes and lands ~2.1:1 as 9.5px text on this card's surface
    // (roborev 53631-M4); the contrast arithmetic is in theme/amberInk.test.ts. Amber stays on the
    // BORDER, where it is a fill rather than ink.
    render(<RecapCard recap={recap()} />);
    const chip = screen.getByText("sparkle");
    expect(chip.style.color).toBe("var(--c-concierge-muted)");
    expect(chip.style.color).not.toContain("e0982f");
  });

  it("adds no live region — the column's single role=status node announces", () => {
    const { container } = render(<RecapCard recap={recap()} />);
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});

describe("ConciergeThread", () => {
  it("renders a recap message as the card", () => {
    render(
      <ConciergeThread
        messages={[recap()]}
        onNudgeClick={vi.fn()}
        onNudgeAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId("concierge-recap")).toBeTruthy();
  });
});

// ── THE ROWS NAME BUILD AGENTS, SO THE ROWS ARE CLICKABLE ───────────────────────────────────────
// The founder's rule: any mention of a build agent anywhere in the concierge surface is clickable.
// A recap that tells you three agents want you and then makes you go find them in the column is
// only half a recap.
//
// The interesting half is HOW. A pill left to the pill context reports its own outcome through a
// `role="status"` node it mounts itself — and this card is permanently on screen, so that is a
// SECOND live region in a column that owns exactly one (see this file's header). The card therefore
// supplies `onOpen`, which suppresses the pill's region and moves the reporting to `revealAgent`,
// which announces through the column's existing announcer.
describe("RecapCard — its agents are clickable, without a second live region", () => {
  /** The card as the app actually mounts it: inside the thread, so inside a real pill context.
   *
   *  WIRED ON PURPOSE. A context-less card has no roster, so every id fails to resolve and the pill
   *  makes a "…is closed" claim about agents that are perfectly live — the false claim the
   *  `!canOpen` guard exists to prevent (roborev 55590). An earlier version of these rows rendered
   *  the card bare and asserted that claim, which baked the wrong behaviour into tests
   *  (roborev 56062). */
  const wired = (onRevealAgent?: (id: string) => void) =>
    render(
      <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: (): RevealOutcome => "revealed" }}>
        <RecapCard recap={recap()} onRevealAgent={onRevealAgent} />
      </AgentPillProvider>,
    );

  it("draws each named agent as a control, not as bare text", () => {
    wired(vi.fn());
    const pills = screen.getAllByTestId("concierge-agent-pill");
    // Both rows — "Wants you" and "Finished".
    expect(pills).toHaveLength(2);
    expect(pills.map((p) => p.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(pills.map((p) => p.textContent)).toEqual(["@Kraken Auth", "@OG Images"]);
  });

  it("reveals the agent the row named", () => {
    const onRevealAgent = vi.fn();
    wired(onRevealAgent);
    fireEvent.click(screen.getAllByTestId("concierge-agent-pill")[1]!);
    // The id from the row, not the first one on the card.
    expect(onRevealAgent).toHaveBeenCalledWith("b");
  });

  it("adds NO live region of its own, even with pills that RESOLVE", () => {
    // The regression this guards is exact: pills without `onOpen` report their own outcome through a
    // `role="status"` node they mount themselves, and this card is permanently on screen — so two
    // rows meant two extra regions in a column that owns exactly one, and the failure surfaced two
    // files away in ConciergeHost's recap test.
    const { container } = wired(vi.fn());
    expect(container.querySelectorAll('[data-testid="concierge-agent-pill"]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("WHY the card needs its own reveal: without one the pills bring regions back", () => {
    // Not a wish, a characterisation. With no `onRevealAgent` the pills fall back to the pill
    // CONTEXT, which is a perfectly good way to open an agent — but a context-path pill reports its
    // own outcome, so it mounts a `role="status"` node each, and this card is permanently on screen.
    // That is the coupling `onRevealAgent` exists to break, and pinning it here means deleting the
    // prop fails with an explanation rather than in ConciergeHost's recap test two files away.
    const { container } = wired(undefined);
    expect(container.querySelectorAll('[data-testid="concierge-agent-pill"]')).toHaveLength(2);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2);
  });
});

// ── THE WIRING, END TO END ──────────────────────────────────────────────────────────────────────
// The rows above prove the CARD calls its own prop. They prove nothing about the prop arriving:
// `onRevealAgent` crosses ConciergeColumn → ConciergeThread → RecapCard, and dropping it at either
// hop leaves every one of them green while shipping pills that reveal nothing. That is the
// "assert the side effect, not the precondition" rule applied to a prop chain (roborev 56062).
describe("a recap pill's reveal reaches the thread's caller", () => {
  it("carries the clicked row's agentId out through ConciergeThread", () => {
    const onRevealAgent = vi.fn();
    render(
      <AgentPillProvider value={{ agents: ROSTER, onOpenAgent: (): RevealOutcome => "revealed" }}>
        <ConciergeThread
          messages={[recap()]}
          onNudgeClick={vi.fn()}
          onNudgeAction={vi.fn()}
          onRevealAgent={onRevealAgent}
        />
      </AgentPillProvider>,
    );
    fireEvent.click(screen.getAllByTestId("concierge-agent-pill")[0]!);
    // The FIRST row is "Wants you" → agent "a". A hop that dropped the prop calls nothing at all.
    expect(onRevealAgent).toHaveBeenCalledWith("a");
  });
});
