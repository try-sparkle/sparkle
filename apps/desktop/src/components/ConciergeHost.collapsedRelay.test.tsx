// @vitest-environment jsdom
//
// THE ANTI-FLOOD GUARANTEE, end to end: a deferred-send outcome whose held payload is a long brief
// must not put that brief into the transcript — or into the live region.
//
// The bug, as reported: the concierge relays a message to a build agent and the transcript echoes the
// ENTIRE relayed payload inline — "Concierge Reply Linter is up — I sent your message (…)" followed by
// forty rows of brief that push the whole conversation off screen. `oneLine` collapsed the newlines
// and BOUNDED NOTHING, so a paste became one enormous wrapped line rather than a quote.
//
// It is also the structural half of a standing rule: the concierge must never paste relayed text back
// at the founder. The APP doing it defeats that rule no matter how the concierge behaves, which is why
// this is fixed here and not in a prompt.
//
// WHY THIS SUITE GOES THROUGH THE HOST rather than hand-building a message: the claim is about what
// the transcript CONTAINS after a real outcome arrives, and the two halves that could each silently
// undo it (the sentence the host composes, and the block it hands the thread) live on opposite sides of
// that seam. A row asserting "postSparkle was called with a block" would pass with the brief still
// interpolated into the sentence.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConciergeDispatchResult } from "../services/conciergeDispatch";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  /** The host's deferred-outcome listener, captured at mount so a row can emit one. */
  deferred: undefined as ((r: ConciergeDispatchResult) => void) | undefined,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
// SPREAD THE REAL MODULE and replace one export. Vitest throws on access to an export a factory omits,
// so a hand-listed partial mock breaks the moment the host imports anything else from here — and the
// outcome shape stays the production one, so a field the ladder later gates on cannot drift.
vi.mock("../services/conciergeDispatch", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    onDeferredSendOutcome: (cb: (r: ConciergeDispatchResult) => void) => {
      h.deferred = cb;
      return () => {};
    },
  };
});

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import type { ConciergeFeed } from "../useConciergeFeed";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

/** A line buried DEEP in the payload — 20-odd rows in. Only the full text may ever contain it, which
 *  is what makes "the transcript does not carry the brief" a fact rather than an impression. */
const CANARY = "line-19-nobody-should-read-this-in-the-transcript";

const BRIEF = [
  "Ship the reply linter behind a flag",
  "",
  "Context: the concierge pastes relayed text back at the founder, which is the",
  "one thing the standing rule forbids.",
  "",
  ...Array.from({ length: 13 }, (_, i) => `step ${i + 1}: do the thing`),
  CANARY,
  "…and then report back.",
].join("\n");

function feed(): ConciergeFeed {
  const counts = { needs_you: 1, running: 0, done: 0 };
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "approval",
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band: "needs_you" as const,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
    rolledUpGreen: false,
  };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: [agent] },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const thread = () => screen.getByTestId("concierge-thread");
const announcer = () => screen.getByTestId("concierge-announcer");
const pills = () => within(thread()).queryAllByTestId("composer-text-pill");

/** Find a receipt SENTENCE that is split across elements.
 *
 *  The agent's name is now an agent pill — a `<button>` inside the sentence — so the receipt is no
 *  longer one text node and `findByText` cannot see it whole. This matches on the tightest element
 *  whose `textContent` satisfies the pattern (an ancestor that merely CONTAINS it is rejected,
 *  which is what keeps the `^…$` anchors below meaningful). */
const findSentence = (re: RegExp) =>
  within(thread()).findByText((_t, el) => {
    if (!el) return false;
    if (!re.test(el.textContent ?? "")) return false;
    return !Array.from(el.children).some((c) => re.test(c.textContent ?? ""));
  });

/** Emit one deferred-send outcome, the way `flushPendingSends` does when the pane comes up. */
function outcome(r: ConciergeDispatchResult) {
  act(() => h.deferred!(r));
}

beforeEach(() => {
  // The column locks thread and composer whenever the AI gate is shut, and a fresh test's default is
  // the locked anonymous trial. Stated rather than inherited.
  enableAiEnhancementsForTests();
  // The thread store is MODULE-level and persisted, so a row would otherwise read the previous row's
  // bubbles.
  useConciergeThreadStore.getState().clearChat();
  h.deferred = undefined;
});
afterEach(() => cleanup());

describe("ConciergeHost — a long relayed payload rides as a pill, not as transcript text", () => {
  it("does not put the brief in the transcript, and renders a pill for it", async () => {
    render(<ConciergeHost feed={feed()} />);
    outcome({ ok: true, path: "free-text", agentId: "ag1", sent: BRIEF });

    // The receipt sentence is there… and the agent is named as a CLICKABLE PILL, not bare text.
    // Scoped to the sentence: a nudge card for the same red agent draws its own pill, so a
    // thread-wide query would pass on the card's pill and prove nothing about the receipt.
    const sentence = await findSentence(/@CI Hardening is up — I sent your message/);
    expect(within(sentence).getByTestId("concierge-agent-pill").textContent).toBe("@CI Hardening");
    // …and the payload is NOT. This is the row that fails against the old unbounded quote: `oneLine`
    // kept every word of the brief, so the canary landed in the bubble.
    expect(thread().textContent).not.toContain(CANARY);
    // The payload is not lost — it is collapsed. One row, full text a click away.
    expect(pills()).toHaveLength(1);
    expect(pills()[0]!.getAttribute("data-pill-variant")).toBe("inline");
  });

  it("leads the pill with the payload's first line, so the outcome is attributable unopened", async () => {
    // The quote exists so the user can tell WHICH held message an outcome refers to when several were
    // queued (roborev 53123). Collapsing must not cost that: the pill's face carries the identifying
    // words the sentence used to.
    render(<ConciergeHost feed={feed()} />);
    outcome({ ok: true, path: "free-text", agentId: "ag1", sent: BRIEF });
    await waitFor(() => expect(pills()).toHaveLength(1));
    expect(pills()[0]!.textContent).toContain("Ship the reply linter behind a flag");
  });

  it("announces the RECEIPT SENTENCE and never the payload", async () => {
    // The accessibility half of the same bug. There is no scrolling past a live region: a screen
    // reader handed forty rows has to sit through all of them to learn that a message went out.
    render(<ConciergeHost feed={feed()} />);
    outcome({ ok: true, path: "free-text", agentId: "ag1", sent: BRIEF });
    await waitFor(() =>
      expect(announcer().textContent).toContain("CI Hardening is up — I sent your message"),
    );
    expect(announcer().textContent).not.toContain(CANARY);
    // Bounded, not merely canary-free: the spoken line stays a line.
    expect(announcer().textContent!.length).toBeLessThan(200);
  });

  it("bounds the quote on a NON-delivery too, where the copy tells the user to send it again", async () => {
    // `expired` is the arm whose copy instructs a retype, so it is the costliest one to bury under a
    // wall of text — and `flushPendingSends` emits one of these per aged-out entry.
    render(<ConciergeHost feed={feed()} />);
    outcome({ ok: false, path: "expired", agentId: "ag1", sent: BRIEF });
    expect(
      await within(thread()).findByText(/never came up, so I dropped the message I was holding/),
    ).toBeTruthy();
    expect(thread().textContent).not.toContain(CANARY);
    expect(pills()).toHaveLength(1);
    // The remedy survives the collapse — it is the whole reason this arm reads differently.
    expect(thread().textContent).toContain("Send it again when it's running.");
  });

  it("quotes the DISPLAY rendering when there is one, so temp paths still never reach the pill", async () => {
    // `sent` is the wire payload and carries the attachments' temp paths (roborev 46925). The block is
    // built from the same `shown` string the sentence quotes, so this protection had to survive being
    // moved into a pill.
    render(<ConciergeHost feed={feed()} />);
    outcome({
      ok: true,
      path: "free-text",
      agentId: "ag1",
      sent: `'/var/folders/x9/T/sparkle-shot-1753.png' ${BRIEF}`,
      display: `${BRIEF} · 1 image`,
    });
    await waitFor(() => expect(pills()).toHaveLength(1));
    expect(pills()[0]!.getAttribute("aria-label")).not.toContain("sparkle-shot-1753");
    // Opened, the modal shows the display rendering — still no temp path.
    act(() => pills()[0]!.click());
    expect(screen.getByTestId("text-pill-full-text").textContent).toContain(CANARY);
    expect(screen.getByTestId("text-pill-full-text").textContent).not.toContain("sparkle-shot-1753");
  });
});

describe("ConciergeHost — an elided quote ALWAYS has the full text behind it", () => {
  it("collapses a payload that is under the pill threshold but over the quote's", async () => {
    // THE GAP ROW (roborev 55746). The elide bound (120 chars) and the pill threshold (6 lines / 2000
    // chars) are independent numbers, so read as two decisions they leave a band where the quote is CUT
    // and nothing rides along — a three-line, ~300-character relayed instruction, which is an entirely
    // ordinary one. The user would be left with `("<119 chars>…")` and no route to the rest, having had
    // the whole thing before this change.
    const mid = ["Please rerun the notarization step", "x".repeat(150), "y".repeat(120)].join("\n");
    expect(mid.length).toBeGreaterThan(120);
    render(<ConciergeHost feed={feed()} />);
    outcome({ ok: false, path: "expired", agentId: "ag1", sent: mid });

    // The quote is elided…
    expect(await within(thread()).findByText(/…"\)\. Send it again when it's running\./)).toBeTruthy();
    // …so the payload MUST be reachable. Exactly one pill, carrying the whole thing.
    await waitFor(() => expect(pills()).toHaveLength(1));
    act(() => pills()[0]!.click());
    expect(screen.getByTestId("text-pill-full-text").textContent).toBe(mid);
  });
});

describe("ConciergeHost — a SHORT held message is untouched", () => {
  it("still quotes it inline, with no pill", async () => {
    // The no-regression row. Everything the deferred-outcome ladder was written for is a line or two,
    // and those must read exactly as they did — `shouldPasteAsPill` is the one gate, so a short
    // payload never reaches the collapse path at all.
    render(<ConciergeHost feed={feed()} />);
    outcome({ ok: true, path: "free-text", agentId: "ag1", sent: "start on the docs" });
    expect(
      await findSentence(/^@CI Hardening is up — I sent your message \("start on the docs"\)\.$/),
    ).toBeTruthy();
    expect(pills()).toHaveLength(0);
  });

  it("keeps a five-line message as prose, matching the composer's own threshold", async () => {
    // The threshold is SHARED (PILL_MIN_LINES / PILL_MIN_CHARS), not re-decided here: five lines is
    // under it, so this stays prose in the transcript exactly as it stays prose in a compose box.
    render(<ConciergeHost feed={feed()} />);
    outcome({ ok: true, path: "free-text", agentId: "ag1", sent: "one\ntwo\nthree\nfour\nfive" });
    expect(await within(thread()).findByText(/one two three four five/)).toBeTruthy();
    expect(pills()).toHaveLength(0);
  });
});
