// @vitest-environment jsdom
//
// The recap card's contract: it renders the newly-entered delta, it renders the gate decisions the
// sibling branch will feed it, and it carries NO live region of its own (the column's single
// role="status" node does the announcing — a second region double-announces).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecapCard } from "./RecapCard";
import { DESC_MAX_H } from "./BeadPill";
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

/** Open the card if it started closed.
 *
 *  The card is a disclosure since bead `sparkle-o37mn`: a recap with nothing ACTIONABLE in it (only
 *  settled `done` rows, or only decisions) starts collapsed and renders no rows. The tests below
 *  that use such a fixture are about the SECTION CAP and the row content, not about the disclosure
 *  — that has its own file, `RecapCard.expand.test.tsx` — so they open the card first.
 *
 *  This cannot mask a regression: a collapsed card makes every one of those assertions fail by
 *  ABSENCE (`getAllByTestId` throws on an empty match), never pass vacuously. */
function openCard() {
  const d = screen.getByTestId("recap-disclosure");
  if (d.getAttribute("aria-expanded") === "false") fireEvent.click(d);
}

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
    openCard();
    const rows = screen.getAllByTestId("recap-decision");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["queued", "sent"]);
    // "Held for you" and "Sent" are opposite facts, so the verb leads the line rather than trailing
    // the description.
    expect(rows[0]!.textContent!.startsWith("Held for you")).toBe(true);
    expect(rows[1]!.textContent!.startsWith("Sent")).toBe(true);
  });

  /** Agents for a section, named so a row can tell which ones survived the cap.
   *
   *  THE STATUS IS A PARAMETER NOW, and that is the whole point of bead `sparkle-ws8gd`: the cap
   *  may only ever hide a SETTLED row (`done` — finished AND landed). `waiting` here is an
   *  actionable row and must survive the cap however many there are. */
  const LABEL = {
    waiting: "Needs you",
    unmerged: "Needs merge",
    // `idle` is THE ordinary finish (services/conciergeRecap says so in as many words), so it is the
    // highest-traffic row type there is — and it was the one this helper could not express, which
    // left the founder's rule untested on the case it will meet most often (roborev 59105).
    idle: "Done — your turn",
    done: "Done",
  } as const;

  const changes = (
    n: number,
    prefix: string,
    status: "waiting" | "done" | "unmerged" | "idle" = "waiting",
  ) =>
    Array.from({ length: n }, (_, i) => ({
      agentId: `${prefix}${i}`,
      agentName: `${prefix} ${i}`,
      projectName: "sparkle",
      status,
      statusLabel: LABEL[status],
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

  it("caps a long section of SETTLED rows and says how many it kept back", () => {
    // A night away on a large fleet is when this card has the most to say and the least room: 30
    // rows push the chat off screen above the compose box, the failure buildDigest exists to
    // prevent on the nudge side. The summary sentence still carries the totals.
    //
    // `done` rows, deliberately — those are the only ones the cap may eat. This test used to use
    // `waiting`, which is exactly the defect the founder reported (bead sparkle-ws8gd).
    render(<RecapCard recap={recap({ needsYou: [], finished: changes(12, "a", "done") })} />);
    openCard();
    expect(screen.getAllByTestId("recap-change")).toHaveLength(5);
    expect(more("finished")!.textContent).toBe("+7 more in Finished");
    // Nothing is hidden from the sentence — it still counts all twelve.
    expect(screen.getByText(/12 finished/)).toBeTruthy();
  });

  // ── "We should never hide a row that needs action from me." (the founder, bead sparkle-ws8gd) ──
  describe("the cap may never hide a row that needs action", () => {
    it("shows every actionable row however many there are, and offers no +N more", () => {
      // Twelve rows that all want something. Under the old cap five rendered and SEVEN ASKS WERE
      // INVISIBLE behind flat grey text — the card reporting a count that sounded complete while
      // hiding the things the reader had to do.
      render(<RecapCard recap={recap({ needsYou: changes(12, "a"), finished: [] })} />);
      expect(screen.getAllByTestId("recap-change")).toHaveLength(12);
      expect(more("needsYou")).toBeNull();
    });

    it("protects 'Needs merge' and 'Done — your turn', which live under FINISHED", () => {
      // The subtle half, and the one the screenshot proved: finished is NOT settled. `unmerged`
      // ("Needs merge") and `idle` ("Done — your turn") sit in the finished bucket and both owe the
      // reader something. In the founder's screenshot every visible finished row was one of these.
      const mixed = [
        ...changes(4, "merge", "unmerged"),
        // `idle`, NOT a `waiting` stand-in. This test names "Done — your turn", and that IS `idle`;
        // substituting a red status would have left the ordinary-finish case unexercised while the
        // test's own title claimed otherwise (roborev 59105).
        ...changes(4, "turn", "idle"),
        ...changes(9, "landed", "done"),
      ];
      render(<RecapCard recap={recap({ needsYou: [], finished: mixed })} />);
      // 8 actionable + the 5 settled the cap allows = 13; the other 4 settled collapse.
      expect(screen.getAllByTestId("recap-change")).toHaveLength(13);
      expect(more("finished")!.textContent).toBe("+4 more in Finished");
      // Every actionable agent is on screen by name — none of them is behind the disclosure.
      for (let i = 0; i < 4; i++) {
        expect(screen.getByText(`@merge ${i}`)).toBeTruthy();
        expect(screen.getByText(`@turn ${i}`)).toBeTruthy();
      }
    });

    it("keeps the ORIGINAL row order rather than hoisting actionable rows", () => {
      // The cap removes rows; it must not reshuffle them, or expanding would rearrange the card
      // under the reader.
      const mixed = [
        ...changes(1, "first", "done"),
        ...changes(1, "second", "unmerged"),
        ...changes(1, "third", "done"),
      ];
      render(<RecapCard recap={recap({ needsYou: [], finished: mixed })} />);
      const names = screen.getAllByTestId("recap-change").map((r) => r.textContent ?? "");
      expect(names[0]).toContain("first 0");
      expect(names[1]).toContain("second 0");
      expect(names[2]).toContain("third 0");
    });
  });

  // ── THE CARD IS BOUNDED, THE ROW SET IS NOT ─────────────────────────────────────────────────
  // `SECTION_CAP`'s docblock explicitly delegates height protection to these declarations, so
  // deleting them would leave both the code and that docblock silently wrong. They are INLINE
  // styles, so jsdom can assert them directly — no layout engine needed, and therefore no excuse
  // for the gap (roborev 59167).
  describe("the card bounds its own height instead of hiding rows", () => {
    const card = () => screen.getByTestId("concierge-recap");

    it("scrolls past a max height rather than growing without limit", () => {
      render(<RecapCard recap={recap({ needsYou: changes(40, "a"), finished: [] })} />);
      // Every one of the forty actionable rows is rendered — the bound is on the BOX, not the set.
      expect(screen.getAllByTestId("recap-change")).toHaveLength(40);
      // The bead card's height, not a viewport fraction — the founder asked for the recap to
      // expand to "whatever we're using for the beads expand sizes" (bead `sparkle-o37mn`).
      // Bound to the imported constant so the two cards cannot drift apart.
      expect(card().style.maxHeight).toBe(`${DESC_MAX_H}px`);
      expect(card().style.overflowY).toBe("auto");
    });

    it("does NOT shrink as a flex item — the scroll container's min-height is zero", () => {
      // The High finding this exists for: this card is a direct flex item of the thread's column
      // scroller, and Flexbox §4.5 gives a SCROLL CONTAINER an automatic minimum size of zero while
      // every sibling row keeps its content height. Without `flex-shrink: 0` the card is the only
      // item that can give, so a transcript longer than one screen collapses it toward 0px and
      // hides every row — strictly worse than the "+N more" this bead is about.
      render(<RecapCard recap={recap()} />);
      expect(card().style.flexShrink).toBe("0");
    });

    it("does not become a HORIZONTAL scroll container as a side effect", () => {
      // `overflow-y` alone computes the other axis from `visible` to `auto`, which would put a
      // horizontal scrollbar on the surface whose horizontal overflow was already fixed by
      // `overflow-wrap: anywhere` (roborev 58700).
      render(<RecapCard recap={recap()} />);
      expect(card().style.overflowX).toBe("hidden");
    });
  });

  describe("the +N more line is a control, not a caption", () => {
    it("expands in place on click, revealing every hidden row, and collapses again", () => {
      render(<RecapCard recap={recap({ needsYou: [], finished: changes(12, "a", "done") })} />);
      openCard();
      expect(screen.getAllByTestId("recap-change")).toHaveLength(5);

      fireEvent.click(more("finished")!);
      // ALL twelve, in place — not a modal, not a paged list (the founder: "should be expandable
      // when clicked to see everything").
      expect(screen.getAllByTestId("recap-change")).toHaveLength(12);

      fireEvent.click(more("finished")!);
      expect(screen.getAllByTestId("recap-change")).toHaveLength(5);
    });

    it("is a real button that advertises its expanded state", () => {
      // "Make it LOOK clickable" — it was a bare div in muted caption ink, visually identical to
      // the asides around it, which is why the founder could not tell it did anything.
      render(<RecapCard recap={recap({ needsYou: [], finished: changes(12, "a", "done") })} />);
      openCard();
      const line = more("finished")!;
      expect(line.tagName).toBe("BUTTON");
      expect(line.getAttribute("aria-expanded")).toBe("false");
      // It carries an icon, not an emoji glyph typed into the string (this repo bans emoji-as-icons).
      expect(line.querySelector("svg")).toBeTruthy();

      fireEvent.click(line);
      expect(more("finished")!.getAttribute("aria-expanded")).toBe("true");
      expect(more("finished")!.textContent).toContain("Show fewer");
    });

    it("expands the decisions section too, so no overflow line is a dead end", () => {
      render(<RecapCard recap={recap({ decisions: decisions(9) })} />);
      expect(screen.getAllByTestId("recap-decision")).toHaveLength(5);
      fireEvent.click(more("decisions")!);
      expect(screen.getAllByTestId("recap-decision")).toHaveLength(9);
    });
  });

  it("caps decisions from the RECENT end — the earliest are the ones that collapse", () => {
    // Decisions render oldest-first (the card reads as a narrative), but a cancelled deploy from
    // two minutes ago is the line you can still act on, so the tail is what survives the cap.
    render(<RecapCard recap={recap({ needsYou: [], finished: [], decisions: decisions(8) })} />);
    openCard();
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
    //
    // SETTLED rows in both change sections, because only those can overflow at all now — an
    // actionable row is never hidden (bead sparkle-ws8gd). WANTS YOU is populated with `done` rows
    // purely to force a third marker: the bucketing is the producer's job (services/conciergeRecap
    // puts red statuses there), and this test is about the three MARKERS being tellable apart, not
    // about which bucket a status belongs in.
    render(
      <RecapCard
        recap={recap({
          needsYou: changes(12, "n", "done"),
          finished: changes(9, "f", "done"),
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
