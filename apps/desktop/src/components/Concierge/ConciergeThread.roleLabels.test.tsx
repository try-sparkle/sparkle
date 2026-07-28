// @vitest-environment jsdom
//
// THE THREAD NAMES NOBODY. Founder, 2026-07-27: the "SPARKLE" / "YOU" captions above each bubble
// are not wanted — alignment and bubble chrome already say who is talking, and a caption per turn
// costs a line of the column's scarcest space on information the eye already has.
//
// The labels are not in the component today (its own header says so, and `types.ts` says it twice
// more), which is exactly why this file exists: "we decided not to render this" is a decision with
// no failing test behind it, and every chat UI on earth drifts back toward captions. This is that
// test. It renders EVERY message kind — sparkle, you, you-with-a-routing-receipt, batch, recap,
// digest, nudge, plus the typing row — so a label reintroduced on one branch cannot hide behind the
// others.
//
// ACCESSIBILITY IS THE OTHER HALF. If those captions had been carrying authorship for a screen
// reader, deleting them would have taken the information with them — so the thread's own accessible
// name is pinned here too. Authorship reaches assistive tech through the column's single
// `role="status"` announcer (ConciergeColumn), not through per-bubble text; nothing here may grow a
// second live region.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import type { ConciergeMessage } from "./types";

afterEach(() => cleanup());

const messages: ConciergeMessage[] = [
  { id: "m1", kind: "sparkle", text: "Two agents are waiting on you." },
  { id: "m2", kind: "you", text: "Approve the first one." },
  // A user bubble carrying a RECEIPT — its own render branch (RoutingReceipt), and a natural place
  // for a "→ you" caption to reappear.
  {
    id: "m2b",
    kind: "you",
    text: "Ship it.",
    receipt: { target: "agent", agentName: "Kraken Auth", agentId: "ag1", redirectable: true },
  },
  { id: "m3", kind: "batch", text: "All projects calm · nothing needs you" },
  // The return-from-Away briefing (RecapCard) — the fifth branch, and the one most likely to grow
  // a per-speaker heading, since it is a report rather than a turn.
  {
    id: "m3b",
    kind: "recap",
    awayMs: 45 * 60 * 1000,
    needsYou: [
      {
        agentId: "ag1",
        agentName: "Kraken Auth",
        projectName: "web",
        status: "waiting",
        statusLabel: "Needs you",
      },
    ],
    finished: [
      {
        agentId: "ag2",
        agentName: "OG Image Pipeline",
        projectName: "web",
        status: "done",
        statusLabel: "Done",
      },
    ],
    decisions: [
      { id: "d1", kind: "sent", agentName: "Kraken Auth", summary: "approved a file write", at: 1 },
    ],
  },
  {
    id: "m4",
    kind: "digest",
    band: "needs_you",
    variant: "rows",
    text: "2 Need you in web",
    leadAgentId: "ag1",
  },
  {
    id: "m5",
    kind: "nudge",
    band: "needs_you",
    projectName: "web",
    agentName: "OG Image Pipeline",
    text: "A build warning needs your call.",
    actions: [{ id: "show", label: "Show me", kind: "primary" }],
  },
];

function renderThread() {
  return render(
    <ConciergeThread
      messages={messages}
      typing
      onNudgeClick={vi.fn()}
      onNudgeAction={vi.fn()}
      onDigestClick={vi.fn()}
    />,
  );
}

describe("the thread prints no authorship captions", () => {
  it('renders neither "SPARKLE" nor "YOU" above any bubble', () => {
    const { container } = renderThread();
    // CASE-SENSITIVE ON PURPOSE, over the whole transcript: it catches the shipped-looking form (an
    // all-caps caption) without tripping over legitimate prose. A case-insensitive sweep of
    // `textContent` cannot work here — "Two agents are waiting on you." and the nudge's "needs your
    // call." would match, so it would fail on correct output.
    expect(/\bSPARKLE\b/.test(container.textContent ?? "")).toBe(false);
    expect(/\bYOU\b/.test(container.textContent ?? "")).toBe(false);
  });

  it("has no caption-SHAPED node either, in any casing", () => {
    // The other half, and the one that actually generalises: a caption is a LEAF element whose whole
    // text is the speaker's name. Checking the shape rather than the transcript lets this be
    // case-insensitive and punctuation-tolerant ("Sparkle:", "You ·") without banning the words from
    // ordinary sentences, which is what the whole-text sweep above cannot do.
    const { container } = renderThread();
    const leaves = [...container.querySelectorAll("*")].filter((el) => el.children.length === 0);
    const captionish = leaves.filter((el) =>
      /^(sparkle|you)[\s:·—-]*$/i.test((el.textContent ?? "").trim()),
    );
    expect(captionish.map((el) => el.textContent)).toEqual([]);
    // Not vacuous — there are plenty of leaves to have caught one in.
    expect(leaves.length).toBeGreaterThan(5);
  });

  it("still says whose conversation this is, to a screen reader", () => {
    renderThread();
    // The information a caption WOULD have carried, kept where it belongs: on the region, once.
    expect(screen.getByLabelText("Conversation with Sparkle")).toBeTruthy();
  });

  it("adds no live region of its own — the column owns the only one", () => {
    const { container } = renderThread();
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll("[role='status']")).toHaveLength(0);
    // …and the messages themselves are still all there, so the assertions above are not vacuous.
    expect(screen.getByText("Two agents are waiting on you.")).toBeTruthy();
    expect(screen.getByText("Approve the first one.")).toBeTruthy();
    expect(screen.getByText("A build warning needs your call.")).toBeTruthy();
  });

  it("really did render every branch the no-caption assertions sweep", () => {
    // The fixture's coverage claim, checked. Without this, dropping a message kind from the fixture
    // — or a branch quietly failing to render — would silently narrow all three tests above while
    // they stayed green.
    renderThread();
    expect(screen.getByTestId("concierge-recap")).toBeTruthy(); // recap
    expect(screen.getByTestId("routing-receipt")).toBeTruthy(); // you + receipt
    expect(screen.getByTestId("concierge-digest")).toBeTruthy(); // digest line
    expect(screen.getByText("All projects calm · nothing needs you")).toBeTruthy(); // batch
    expect(screen.getByLabelText("Sparkle is typing")).toBeTruthy(); // the typing row
  });
});
