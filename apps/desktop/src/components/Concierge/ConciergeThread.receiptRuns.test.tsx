// @vitest-environment jsdom
//
// THE FOUNDER'S SCREENSHOT, as a test.
//
// He sent it with no words: a vertical wall of near-identical receipt cards, one per agent, each
// reading "Sent to @<name>'s terminal." with its own copy icon, consuming the entire column. It came
// from the concierge restarting the fleet after an account switch — sixteen `send_to_agent_terminal`
// calls in one turn. ONE fact ("the fleet was restarted"), shown sixteen times, and he had to scroll
// past all of it.
//
// These rows assert the RENDERED THREAD, not the fold function (that is receiptRuns.test.ts). The
// distinction matters: a pure test proves the rule, and this proves the column actually obeys it —
// which is the half that was missing, since the precedent group work on the sibling branch built a
// data layer whose renderer was never wired up.
//
// ══ WHAT MUST FAIL AGAINST MAIN ═════════════════════════════════════════════════════════════════
// On main, sixteen receipts render as sixteen `[data-message-id]` entries and there is no
// `concierge-receipt-run` in the document. The first row below fails on both counts.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConciergeThread } from "./ConciergeThread";
import {
  RECEIPT_RUN_MEMBERS_TESTID,
  RECEIPT_RUN_TESTID,
  RECEIPT_RUN_TOGGLE_TESTID,
} from "./ReceiptRunRow";
import type { ConciergeMessage, ConciergeReceiptMark } from "./types";

const NAMES = [
  "Mic Capture Regression",
  "Mic Says When It Is Deaf",
  "Errors Explain Themselves",
  "One Card Two Presentations",
  "Naming A Bug Is Not Enough",
  "Ready For A Second User",
  "Narrow Column Holds Up",
];

function sent(
  id: string,
  name: string,
  over: Partial<ConciergeReceiptMark> = {},
): ConciergeMessage {
  return {
    id,
    kind: "sparkle",
    text: `Sent to [@${name}](sparkle-agent:${id}-agent)'s terminal.`,
    actionReceipt: {
      kind: "sent",
      ok: true,
      channel: "terminal",
      // A RELAY, matching this fixture's own "Sent to …" text. The folded sentence is keyed on it,
      // so a mark without it would make the row's wording and its bucket disagree about authorship
      // (bead `sparkle-p9s5q`).
      relayedFounderWords: true,
      subjectId: `${id}-agent`,
      subjectName: name,
      ...over,
    },
  };
}

/** The wall: sixteen successful terminal sends, exactly as the turn produced them. */
const wall = (n = 16): ConciergeMessage[] =>
  Array.from({ length: n }, (_, i) =>
    sent(`s${i}`, NAMES[i % NAMES.length] + ` ${i}`),
  );

function thread(messages: ConciergeMessage[]) {
  render(
    <ConciergeThread
      messages={messages}
      onNudgeClick={vi.fn()}
      onNudgeAction={vi.fn()}
    />,
  );
}

const entries = () => document.querySelectorAll("[data-message-id]");
const runRow = () => screen.getByTestId(RECEIPT_RUN_TESTID);

afterEach(() => cleanup());

describe("the wall of receipts becomes one row", () => {
  it("renders SIXTEEN sends as a single row, not sixteen", () => {
    thread(wall());
    // The complaint, inverted: one row where there were sixteen.
    expect(screen.getAllByTestId(RECEIPT_RUN_TESTID)).toHaveLength(1);
    // …and the sixteen individual entries are NOT in the document until asked for. This is the
    // assertion that fails hardest against main, where all sixteen are always present.
    expect(entries()).toHaveLength(0);
  });

  it("states the count HONESTLY, and the count is the rows it stands for", () => {
    thread(wall());
    expect(runRow().textContent).toContain("Sent to 16 agents' terminals.");
    // The claim on the element and the claim in the sentence come from one place — see receiptRuns
    // for why there is no separate `count` field that could disagree.
    expect(runRow().getAttribute("data-count")).toBe("16");
  });

  it("keeps every agent pill CLICKABLE — the fold must not cost the navigation", () => {
    thread(wall());
    // The pills are how he reaches an agent. Flattening them to plain text would make the folded row
    // worse than the wall it replaced, which is why the brief says not to.
    const pills = runRow().querySelectorAll("[data-agent-id]");
    expect(pills).toHaveLength(16);
    expect(pills[0]?.getAttribute("data-agent-id")).toBe("s0-agent");
  });

  it("expands to the individual receipts, and collapses again", () => {
    thread(wall());
    expect(screen.queryByTestId(RECEIPT_RUN_MEMBERS_TESTID)).toBeNull();

    fireEvent.click(screen.getByTestId(RECEIPT_RUN_TOGGLE_TESTID));
    // COMPRESSED, NOT DELETED: every one of the sixteen is there, unchanged, one click away.
    expect(screen.getByTestId(RECEIPT_RUN_MEMBERS_TESTID)).toBeTruthy();
    expect(entries()).toHaveLength(16);
    // The member's OWN sentence, verbatim — the `@` is the pill drawing its sigil, so this is the
    // individual receipt as it always rendered, not a summary of it.
    expect(runRow().textContent).toContain(
      "Sent to @Mic Capture Regression 0's terminal.",
    );

    fireEvent.click(screen.getByTestId(RECEIPT_RUN_TOGGLE_TESTID));
    expect(entries()).toHaveLength(0);
  });

  it("expanded, it shows exactly as many rows as it claimed", () => {
    // The count and the disclosure cannot drift: whatever the row says, opening it produces that
    // many receipts. A cap or a filter on either side breaks this row.
    thread(wall());
    const claimed = Number(runRow().getAttribute("data-count"));
    fireEvent.click(screen.getByTestId(RECEIPT_RUN_TOGGLE_TESTID));
    expect(entries()).toHaveLength(claimed);
  });
});

describe("a failure is NEVER swallowed into a success count", () => {
  it("leaves a REFUSED send standing on its own row, outside every count", () => {
    // This afternoon's shape: six sends rejected for a bad argument. A row reading "Sent to 16
    // agents" while three of them silently refused would be strictly worse than the wall.
    const messages = [
      ...Array.from({ length: 3 }, (_, i) => sent(`a${i}`, `Alpha ${i}`)),
      sent("bad", "Broken One", { ok: false }),
      ...Array.from({ length: 4 }, (_, i) => sent(`b${i}`, `Beta ${i}`)),
    ];
    thread(messages);

    // The refusal is visible WITHOUT expanding anything.
    expect(document.querySelector('[data-message-id="bad"]')).toBeTruthy();

    // Two folded runs, and neither count reaches the refusal.
    const runs = screen.getAllByTestId(RECEIPT_RUN_TESTID);
    expect(runs.map((r) => r.getAttribute("data-count"))).toEqual(["3", "4"]);
    // The total claimed is 7, never 8 — the refusal is not in it.
    expect(
      runs.reduce((n, r) => n + Number(r.getAttribute("data-count")), 0),
    ).toBe(7);
  });

  it("does not fold a partial fan-out, whose ok reply carries failures", () => {
    // `inboxBroadcast` reports a partial failure as ok + counts. Folding on `ok` alone would claim
    // flat delivery the tool never reported.
    thread([
      sent("p0", "Alpha", { channel: "inbox", failed: 2 }),
      sent("p1", "Beta", { channel: "inbox", failed: 1 }),
    ]);
    expect(screen.queryByTestId(RECEIPT_RUN_TESTID)).toBeNull();
    expect(entries()).toHaveLength(2);
  });

  it("keeps a lone receipt exactly as it was — no group of one", () => {
    thread([sent("only", "Solo Agent")]);
    expect(screen.queryByTestId(RECEIPT_RUN_TESTID)).toBeNull();
    expect(entries()).toHaveLength(1);
  });
});

describe("nothing else in the transcript changes", () => {
  it("leaves ordinary prose and unmarked app lines alone", () => {
    // The no-regression half. Only receipt-MARKED lines can fold; a brain reply and a bookkeeping
    // line that carries no mark render exactly as they did.
    thread([
      { id: "p1", kind: "sparkle", text: "Here's what I found." },
      { id: "p2", kind: "sparkle", text: "Here's what I found." },
      { id: "p3", kind: "sparkle", text: "Sent to CI Hardening." },
    ]);
    expect(screen.queryByTestId(RECEIPT_RUN_TESTID)).toBeNull();
    expect(entries()).toHaveLength(3);
  });

  it("never folds across an unrelated message", () => {
    thread([
      sent("a", "Alpha"),
      sent("b", "Beta"),
      { id: "mid", kind: "sparkle", text: "One moment." },
      sent("c", "Gamma"),
      sent("d", "Delta"),
    ]);
    expect(screen.getAllByTestId(RECEIPT_RUN_TESTID)).toHaveLength(2);
    expect(document.querySelector('[data-message-id="mid"]')).toBeTruthy();
  });
});
