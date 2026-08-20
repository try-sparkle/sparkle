// @vitest-environment jsdom
//
// ── AN APP-AUTHORED NOTICE MUST NOT LOOK LIKE THE CONCIERGE TALKING TO THE FOUNDER ───────────────
//
// THE DEFECT (bead sparkle-4kgpb3). The app's own tool layer posts its results into the concierge
// thread, in the same full-weight ink as the concierge's prose, with no attribution:
//
//     Not sent to @Sparkle Concierge Agents Header — that text carries the founder's own words,
//     and he did not name this agent…
//
// The founder read that as the CONCIERGE speaking to him. It is not: it is the app answering a call
// the concierge made, and he is reading over its shoulder. `conciergeTools/relayGate` proves it in
// its own words — "His message went to you, not to the fleet" — where the "you" is the concierge.
//
// ══ WHY THESE TESTS MOUNT BOTH TREATMENTS AT ONCE ═══════════════════════════════════════════════
// The rule under test picks ONE of two renderings, so a test that renders a single row and asserts
// the header is absent proves nothing: it is absent because there is no element to draw, and it
// stays absent if the rule is keyed to the wrong side entirely. That is the "N targets, only one
// mounted" vacuous shape AGENTS.md enumerates. So the contrast cases render a receipt row AND a
// reply row in one tree and assert the treatment lands on exactly one of them.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { ConciergeMessageRow } from "./ConciergeMessageRow";
import { NOTICE_ATTRIBUTION_TESTID, NOTICE_ROW_TESTID } from "./NoticeAttribution";
import type { ConciergeMessage, ConciergeReceiptMark } from "./types";

const noop = () => {};

const REFUSAL_MARK: ConciergeReceiptMark = {
  kind: "sent",
  ok: false,
  reason: "that text carries the founder's own words, and he did not name this agent.",
};
const SUCCESS_MARK: ConciergeReceiptMark = { kind: "filed", ok: true };

/** A real refusal receipt — the exact class from the report. */
const RECEIPT: ConciergeMessage = {
  id: "receipt-1",
  kind: "sparkle",
  text: "Refused the concierge's message to @Alpha — that text carries the founder's own words.",
  actionReceipt: REFUSAL_MARK,
} as ConciergeMessage;

/** An ordinary concierge answer — the thing a receipt was being mistaken for. */
const REPLY: ConciergeMessage = {
  id: "reply-1",
  kind: "sparkle",
  text: "I've started three agents on the retry work.",
  settled: true,
} as ConciergeMessage;

/** An APP-AUTHORED line that is addressed to the FOUNDER. Same author as the receipt, opposite
 *  recipient — this is the row a sender-based split would have wrongly greyed. */
const FOUNDER_NOTICE: ConciergeMessage = {
  id: "founder-1",
  kind: "sparkle",
  text: "That message had more asks than I file at once, so 2 of them didn't make the list — say them again and I'll pick them up.",
} as ConciergeMessage;

function renderRows(messages: ConciergeMessage[]) {
  const { container } = render(
    <>
      {messages.map((m) => (
        <ConciergeMessageRow
          key={m.id}
          message={m}
          wired={false}
          shownBlockIds=""
          onOpenPayload={noop}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onAnswerCopied={noop}
          onMessageCopied={noop}
        />
      ))}
    </>,
  );
  const row = (id: string) => {
    const el = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (!el) throw new Error(`no row rendered for message ${id}`);
    return el;
  };
  return { container, row };
}

afterEach(cleanup);

describe("a concierge-addressed notice is attributed", () => {
  it("carries a Sparkle → Concierge header that an ordinary reply does not", () => {
    const { row } = renderRows([RECEIPT, REPLY]);

    // PRESENT on the receipt…
    expect(
      within(row("receipt-1")).getByTestId(NOTICE_ATTRIBUTION_TESTID).textContent,
    ).toContain("Sparkle → Concierge");
    // …and ABSENT on the reply beside it, in the same tree. Both mounted, so the absence is a real
    // statement about the rule rather than about what happened to be rendered.
    expect(
      within(row("reply-1")).queryByTestId(NOTICE_ATTRIBUTION_TESTID),
    ).toBeNull();
  });

  it("marks the recipient on the element, for both halves", () => {
    const { row } = renderRows([RECEIPT, REPLY]);
    expect(row("receipt-1").getAttribute("data-recipient")).toBe("concierge");
    expect(row("reply-1").getAttribute("data-recipient")).toBe("founder");
  });

  it("attributes a SUCCESS receipt too, not only a refusal", () => {
    // Keying the treatment on `ok` would leave every "The concierge filed …" line rendering as
    // concierge prose — half the population, and the half most often mistaken for the concierge
    // reporting in.
    const { row } = renderRows([
      { ...RECEIPT, id: "ok-1", actionReceipt: SUCCESS_MARK } as ConciergeMessage,
    ]);
    expect(row("ok-1").getAttribute("data-recipient")).toBe("concierge");
    expect(
      within(row("ok-1")).getByTestId(NOTICE_ATTRIBUTION_TESTID),
    ).toBeTruthy();
  });
});

describe("an app line addressed to the FOUNDER keeps full weight", () => {
  it("is not greyed and not attributed, even though the app authored it", () => {
    // The failure this forbids is worse than the bug being fixed: it would de-emphasise a line that
    // ends in an instruction only he can carry out ("say them again and I'll pick them up").
    const { row } = renderRows([RECEIPT, FOUNDER_NOTICE]);

    expect(row("founder-1").getAttribute("data-recipient")).toBe("founder");
    expect(
      within(row("founder-1")).queryByTestId(NOTICE_ATTRIBUTION_TESTID),
    ).toBeNull();
    // The ink is untouched: no re-inking declaration of any kind on this row.
    expect(row("founder-1").style.getPropertyValue("--c-cream")).toBe("");
    expect(row("founder-1").style.color).toBe("");
    // …while the receipt beside it DOES carry it. One direction alone is half the evidence.
    expect(row("receipt-1").style.getPropertyValue("--c-cream")).not.toBe("");
  });
});

describe("the grey treatment", () => {
  // BOTH DECLARATIONS, asserted separately, because either one alone leaves the bug half-present
  // and the failure is silent. Redefining the token re-inks everything that RESOLVES it (the
  // Markdown prose root does); declaring `color` re-resolves the COMPUTED value the row otherwise
  // inherits from ConciergeColumn. See NOTICE_INK_VARS — this is the trap SENT_CARD_INK_VARS
  // documents, and it shipped once as light-mode ink on a black card.
  it("redefines the cream token AND declares a colour on the row", () => {
    const { row } = renderRows([RECEIPT]);
    const style = row("receipt-1").style;
    expect(style.getPropertyValue("--c-cream")).toBe("var(--c-concierge-muted)");
    expect(style.color).toBe("var(--c-concierge-muted)");
  });

  it("is de-emphasis, NOT a disabled state — nothing is hidden, faded out or removed", () => {
    // The founder said explicitly that he likes seeing these lines. So: the words are still in the
    // DOM, the row is not `display:none`, and there is no opacity fade (that treatment belongs to a
    // STALE push, which is a different claim and must stay distinguishable).
    const { row } = renderRows([RECEIPT]);
    const el = row("receipt-1");
    expect(el.textContent).toContain("that text carries the founder's own words");
    expect(el.style.display).not.toBe("none");
    expect(el.style.opacity).toBe("");
    expect(el.hidden).toBe(false);
  });
});

describe("the no-authorship-captions decision still holds", () => {
  // The founder's 2026-07-27 ruling, pinned by ConciergeThread.roleLabels.test. Re-asserted here
  // against the header this change introduces, so a future edit to the label fails in the file that
  // owns it rather than two suites away.
  it("adds no all-caps caption and no name-only leaf node", () => {
    const { container } = renderRows([RECEIPT, REPLY, FOUNDER_NOTICE]);

    expect(/\bSPARKLE\b/.test(container.textContent ?? "")).toBe(false);
    expect(/\bYOU\b/.test(container.textContent ?? "")).toBe(false);

    const leaves = [...container.querySelectorAll("*")].filter((el) => el.children.length === 0);
    const captionish = leaves.filter((el) =>
      /^(sparkle|you)[\s:·—-]*$/i.test((el.textContent ?? "").trim()),
    );
    expect(captionish.map((el) => el.textContent)).toEqual([]);
    // Not vacuous — there were plenty of leaves to have caught one in.
    expect(leaves.length).toBeGreaterThan(5);
  });
});

describe("the notice row keeps the prose-arm contract", () => {
  it("still declares width:100%, like every other floated-prose arm", () => {
    // ConciergeMessageRow.proseWidth.test explains why: a floated copy glyph shrink-wraps the row to
    // the paragraph's max-content and then eats its first line, evicting the last word. A new arm
    // that dropped this would reintroduce the founder's "retired that / agent." screenshot.
    const { row } = renderRows([RECEIPT]);
    expect(row("receipt-1").style.width).toBe("100%");
  });

  it("is queryable as a notice row", () => {
    const { row } = renderRows([RECEIPT, REPLY]);
    expect(row("receipt-1").getAttribute("data-testid")).toBe(NOTICE_ROW_TESTID);
    expect(row("reply-1").getAttribute("data-testid")).toBeNull();
  });
});
