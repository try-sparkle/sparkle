// @vitest-environment jsdom
//
// THE BLACK CARD FOR A MESSAGE THAT LEFT THE ROOM.
//
// THE COMPLAINT: the founder spent a minute working out, after the fact, which of his own messages
// had gone to a build agent. A forwarded message and one the concierge answered itself were the same
// blue bubble; the only difference was a grey line hanging OUTSIDE and BELOW it whose agent name was
// dead text. His instruction: *"it would be inside the card with the black background and it would
// say sent to colon, and then it would have the agent as a clickable link… And it would be a black
// background instead of a blue background when it was sent to an agent."*
//
// WHAT THESE CASES ARE CAREFUL ABOUT, because the obvious versions of them are vacuous
// (AGENTS.md's #1 fleet-wide finding — a green test guarding a feature that is 100% broken):
//
//   • "A pill renders" proves NOTHING. Pills already render in this column — in the message text
//     itself, in the concierge's replies, in the nudge cards. Every case here asserts CONTAINMENT:
//     the pill is a descendant of `[data-testid="you-bubble"]`. That is the actual ask ("inside the
//     card"), and it is the assertion that would have failed before this change.
//   • "The name appears" proves nothing either — the OLD dead label also contained the name. The
//     click case asserts the pill actually opens the agent, which is the whole reason he wanted a
//     pill rather than text.
//   • Every positive case has a NEGATIVE twin. A test that only checks the card appears would pass
//     against a build that painted every bubble black.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentPillProvider } from "./AgentPill";
import { ConciergeThread } from "./ConciergeThread";
import { SENT_TO_AGENT_TESTID, sentToAgent } from "./SentToAgentRow";
import {
  CHAT_SENT_BUBBLE,
  CHAT_SENT_FILL,
  CHAT_SENT_INK,
  CHAT_SENT_MUTED,
  CHAT_USER_BUBBLE,
} from "../../theme/colors";
import { useProjectStore } from "../../stores/projectStore";
import type { ConciergeMessage, ConciergeReceipt } from "./types";
import type { RevealOutcome } from "../../services/agentReveal";

const AGENT_ID = "agent-7";
const AGENT_NAME = "Drodio Admin Calendar";

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
});
afterEach(() => cleanup());

function draw(
  receipt: ConciergeReceipt | undefined,
  opts: { wired?: boolean; onOpenAgent?: (t: { agentId: string }) => RevealOutcome } = {},
) {
  const onOpenAgent = vi.fn(opts.onOpenAgent ?? ((): RevealOutcome => "revealed"));
  const messages: ConciergeMessage[] = [
    { id: "u1", kind: "you", text: "put all the fields into meeting type", receipt },
  ];
  render(
    <AgentPillProvider
      value={{
        agents: [
          {
            id: AGENT_ID,
            name: AGENT_NAME,
            projectId: "p1",
            projectName: "web",
            band: "running",
            canAcceptInput: true,
          },
        ],
        onOpenAgent,
      }}
    >
      <ConciergeThread
        messages={messages}
        typing={false}
        turnFloor={-1}
        statuses={{}}
        wired={opts.wired ?? false}
        onNudgeClick={() => {}}
        onNudgeAction={() => {}}
      />
    </AgentPillProvider>,
  );
  return { onOpenAgent, bubble: () => screen.getByTestId("you-bubble") };
}

const SENT: ConciergeReceipt = { target: "agent", agentId: AGENT_ID, agentName: AGENT_NAME };

describe("which receipts earn the card", () => {
  // The pure half. `sentToAgent` decides whether a message is PRESENTED as having left the room, and
  // the founder is about to start trusting that colour without reading anything — so a wrong answer
  // here is a false claim about delivery, not a styling slip.
  it("says yes for a plain agent send", () => {
    expect(sentToAgent(SENT)).toMatchObject({ agentId: AGENT_ID, agentName: AGENT_NAME });
  });

  it("says NO for a refused send, even though it names an agent", () => {
    // The message went back to the composer. It never left.
    expect(sentToAgent({ ...SENT, refused: true })).toBeNull();
  });

  it("says NO for an ordinary concierge answer", () => {
    expect(sentToAgent({ target: "sparkle" })).toBeNull();
  });

  it("says yes when the agent was the SECOND delivery", () => {
    // The concierge answered and also relayed — which is exactly what the relay stamp records.
    expect(
      sentToAgent({ target: "sparkle", alsoSentTo: "agent", agentId: AGENT_ID, agentName: AGENT_NAME }),
    ).toMatchObject({ agentId: AGENT_ID, thenHere: false });
  });

  it("keeps the sequence when the agent was FIRST and the concierge second", () => {
    expect(sentToAgent({ ...SENT, alsoSentTo: "sparkle" })).toMatchObject({ thenHere: true });
  });

  it("falls back to the same words RoutingReceipt uses when the name is missing", () => {
    expect(sentToAgent({ target: "agent" })).toMatchObject({ agentName: "the agent" });
  });
});

describe("the card, and that it is a card", () => {
  it("paints the bubble black and marks it, for a message that reached an agent", () => {
    const { bubble } = draw(SENT);
    expect(bubble().dataset.sentToAgent).toBe("yes");
    expect(bubble().style.background).toContain(CHAT_SENT_BUBBLE);
  });

  // THE NEGATIVE TWIN. Without this, painting every bubble black passes the case above.
  it("leaves an ordinary concierge answer on the blue bubble", () => {
    const { bubble } = draw({ target: "sparkle" });
    expect(bubble().dataset.sentToAgent).toBe("no");
    expect(bubble().style.background).toContain(CHAT_USER_BUBBLE);
    expect(screen.queryByTestId(SENT_TO_AGENT_TESTID)).toBeNull();
  });

  it("pins its inks on itself, so the card survives light mode", () => {
    // THE ONE THING NO SCREENSHOT OF DARK MODE WOULD CATCH. `--c-cream` is #dce8fc in dark but
    // #0a1b33 in LIGHT, so a black card that inherits the themed ink renders near-black on black —
    // the message text, the pill's label and the paste pills all vanish together. jsdom never loads
    // the stylesheet, so this asserts the DECLARATION (the tier AgentPill.truncation.test.tsx uses);
    // the composited contrast is measured in theme/chromeContrast.test.ts.
    const { bubble } = draw(SENT);
    expect(bubble().style.getPropertyValue("--c-cream")).toBe(CHAT_SENT_INK);
    expect(bubble().style.getPropertyValue("--c-concierge-muted")).toBe(CHAT_SENT_MUTED);
  });

  it("also re-resolves `color` on itself, or the founder's own words stay themed", () => {
    // THE HOLE THE TEST ABOVE LEFT OPEN, and it shipped through it. Defining `--c-cream` on the card
    // only reaches descendants that RESOLVE that var themselves — the "Sent to:" label and the pill
    // both do. The message body does not: it has no `color` of its own and inherits a COMPUTED one
    // from ConciergeColumn.tsx:335, resolved against the THEME's `--c-cream` far above the card and
    // inherited as a finished value that a later redefinition cannot reach back and change.
    //
    // So the assertion above stayed green in light mode while the body text rendered #0a1b33 on
    // black. It was true and it proved less than it appeared to. The card must DECLARE `color` for
    // the subtree to inherit the pinned ink, and that declaration is what this pins.
    const { bubble } = draw(SENT);
    expect(bubble().style.color).toBe("var(--c-cream)");
  });

  it("pins the FILL its subtree paints, not only the inks", () => {
    // THE OTHER HALF OF THE SAME BUG, one level down. A non-thumbnail attachment chip
    // (AttachmentStrip) draws a ground of its own inside this bubble. Pinning only the ink left that
    // ground THEMED, so light mode put fixed-dark ink on a pale chip: ~1.07:1, the label invisible
    // inside its own tile. Declaring `color` on the card cannot reach it — the chip declares its own
    // background. The collapsed-paste pill needs no pin: it is translucent over the card's black.
    const { bubble } = draw(SENT);
    expect(bubble().style.getPropertyValue("--c-chat-bubble")).toBe(CHAT_SENT_FILL);
  });

  it("does NOT pin inks on an ordinary bubble", () => {
    // Pointed the other way, the same bug: pinned light ink on a pale blue bubble is unreadable in
    // light mode. The override has to be scoped to the card that needs it.
    const { bubble } = draw({ target: "sparkle" });
    expect(bubble().style.getPropertyValue("--c-cream")).toBe("");
    // And it must not pin `color` either — an ordinary bubble has to keep inheriting the theme's ink,
    // which is the whole reason the override is scoped to the card instead of living on the thread.
    expect(bubble().style.color).toBe("");
  });
});

describe("the destination is INSIDE the card, and it is live", () => {
  it("draws the agent pill as a DESCENDANT of the bubble, not a sibling below it", () => {
    // THE ASSERTION THAT WOULD HAVE FAILED BEFORE THIS CHANGE. The old label was outside the bubble
    // and was not a pill; "a pill exists somewhere" would have been satisfiable without moving it.
    const { bubble } = draw(SENT);
    const row = screen.getByTestId(SENT_TO_AGENT_TESTID);
    const pill = screen.getByTestId("concierge-agent-pill");
    expect(bubble().contains(row)).toBe(true);
    expect(bubble().contains(pill)).toBe(true);
    // `textContent`, not jest-dom's `toHaveTextContent` — this suite does not load jest-dom.
    expect(row.textContent).toContain("Sent to:");
  });

  it("clicking the pill opens the agent", () => {
    // The entire reason he asked for a pill instead of text: the dead label is what made him work
    // out where his message had gone by hand.
    const { onOpenAgent } = draw(SENT);
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));
    expect(onOpenAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT_ID }));
  });

  it("nothing hangs below the bubble for a message the card speaks for", () => {
    // The founder: *"instead of being below where it says send to admin calendar…"*
    draw(SENT);
    expect(screen.queryByTestId("routing-receipt")).toBeNull();
  });

  it("draws no pill when the receipt has no agent id to open", () => {
    // A pill promises that clicking it goes somewhere. With no id there is nowhere, so it degrades
    // to words rather than becoming the dead link in a new costume.
    draw({ target: "agent", agentName: AGENT_NAME });
    expect(screen.getByTestId(SENT_TO_AGENT_TESTID).textContent).toContain(AGENT_NAME);
    expect(screen.queryByTestId("concierge-agent-pill")).toBeNull();
  });
});

describe("a refused send must not borrow the treatment", () => {
  it("stays blue and keeps its line below the bubble", () => {
    // Black means the message left. This one bounced — the founder chose this himself when asked.
    const { bubble } = draw({ ...SENT, refused: true });
    expect(bubble().dataset.sentToAgent).toBe("no");
    expect(bubble().style.background).toContain(CHAT_USER_BUBBLE);
    expect(screen.queryByTestId(SENT_TO_AGENT_TESTID)).toBeNull();
    expect(screen.getByTestId("routing-receipt").textContent).toContain("Not sent");
  });
});

describe("a wired column", () => {
  it("suppresses the card, because every message there goes to the same agent", () => {
    // A signal that never varies is no signal, and the card would fight the terminal flood the
    // wired wash exists to sit inside.
    const { bubble } = draw(SENT, { wired: true });
    expect(bubble().dataset.sentToAgent).toBe("no");
    expect(screen.queryByTestId(SENT_TO_AGENT_TESTID)).toBeNull();
    // The line below the bubble is still its home there, so the destination is not simply lost.
    expect(screen.getByTestId("routing-receipt").textContent).toContain(AGENT_NAME);
  });
});
