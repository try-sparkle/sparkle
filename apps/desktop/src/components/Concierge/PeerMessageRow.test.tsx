// @vitest-environment jsdom
//
// The peer row — what the founder actually sees of one agent talking to another.
//
// THE ROW MOUNTS THROUGH `ConciergeMessageRow`, not directly, in the integration describe at the
// bottom. A test that only ever mounted `PeerMessageRow` would keep passing if the `kind === "peer"`
// branch were removed from the row dispatch, which is the wiring that makes any of this visible.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import {
  PeerMessageRow,
  PEER_ROW_TESTID,
  PEER_EXPAND_TESTID,
  PEER_BODY_TESTID,
  PEER_APP_PARTY_TESTID,
} from "./PeerMessageRow";
import { ConciergeMessageRow } from "./ConciergeMessageRow";
import { peerMessageEntry, PEER_CLAMP_SAFE_CHARS } from "../../services/peerMessageLog";
import type { MentionAgent } from "./mentions";
import type { RevealOutcome } from "../../services/agentReveal";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return { projectId: "p1", projectName: "web", band: "running", canAcceptInput: true, ...over };
}

const ORCH = agent({ id: "a1", name: "Orchestrator" });
const RUST = agent({ id: "a2", name: "Rust Half", band: "needs_you" });

function ctx(over: Partial<AgentPillContextValue> = {}): AgentPillContextValue {
  return { agents: [ORCH, RUST], onOpenAgent: vi.fn((): RevealOutcome => "revealed"), ...over };
}

const LONG = "I am claiming src/parser.rs and its test.\nDo not edit it.\nThe codegen half is yours.";

function entry(over: { gist?: string; message?: string } = {}) {
  return peerMessageEntry({
    id: "peer-1",
    from: { id: "a1", name: "Orchestrator" },
    to: { id: "a2", name: "Rust Half" },
    message: over.message ?? LONG,
    gist: over.gist ?? "taking the parser; you own the codegen",
  });
}

function mount(m = entry(), value = ctx()) {
  return render(
    <AgentPillProvider value={value}>
      <PeerMessageRow message={m} />
    </AgentPillProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PeerMessageRow — the two-line clamp", () => {
  it("shows the sender's gist and NOT the message it stands for", () => {
    mount();
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(
      "taking the parser; you own the codegen",
    );
    // The whole point of a clamp: the full text is not in the document at all until asked for, so a
    // long message cannot push the rest of the conversation off the screen.
    expect(screen.queryByText(/The codegen half is yours/)).toBeNull();
  });

  it("clamps to two lines rather than relying on the message being short", () => {
    mount();
    const body = screen.getByTestId(PEER_BODY_TESTID);
    expect(body.style.getPropertyValue("-webkit-line-clamp")).toBe("2");
  });
});

describe("PeerMessageRow — expanding in place", () => {
  it("reveals the full message verbatim, in the same row", () => {
    mount();
    const row = screen.getByTestId(PEER_ROW_TESTID);
    expect(row.getAttribute("data-expanded")).toBe("false");

    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));

    // IN PLACE: the same row element, still mounted, now carrying the full text. Asserting the row
    // survived is what separates "expanded" from "navigated somewhere that also shows the text".
    expect(screen.getByTestId(PEER_ROW_TESTID)).toBe(row);
    expect(row.getAttribute("data-expanded")).toBe("true");
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(LONG);
  });

  it("collapses again, so an opened row is not a one-way door", () => {
    mount();
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    expect(screen.getByTestId(PEER_ROW_TESTID).getAttribute("data-expanded")).toBe("false");
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(
      "taking the parser; you own the codegen",
    );
  });

  it("renders no expand control when the gist IS the whole message", () => {
    // Nothing to reveal. A control that opens a row onto the text already on screen is a promise
    // the row cannot keep, and the reader learns to stop trusting the affordance.
    mount(entry({ gist: "", message: "one short line" }));
    expect(screen.queryByTestId(PEER_EXPAND_TESTID)).toBeNull();
  });

  it("renders the message as plain text, never as markdown", () => {
    // A peer message is a machine string written for another machine: `_` and `*` are characters.
    mount(entry({ message: "use `_foo_` and *not* **bar**", gist: "styling note" }));
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    const body = screen.getByTestId(PEER_BODY_TESTID);
    expect(body.textContent).toBe("use `_foo_` and *not* **bar**");
    expect(body.querySelector("em")).toBeNull();
    expect(body.querySelector("strong")).toBeNull();
  });
});

describe("PeerMessageRow — a long single line is still reachable (roborev 68628)", () => {
  // THE SHIPPED HIGH. Expandability was a STRING compare while the clamp hides by RENDERED LINES,
  // and for the commonest shape in the feature the two disagree: a one-line message with no gist
  // derives a gist equal to itself, so the compare said "nothing behind the clamp" and drew no
  // control while `-webkit-line-clamp: 2` ate everything past the second visual line. Every agent
  // that has not been updated to send a gist produces exactly this, up to 2000 characters.
  const ONE_LONG_LINE = "x".repeat(PEER_CLAMP_SAFE_CHARS + 200);

  it("offers the control for a long single line sent with NO gist", () => {
    mount(entry({ gist: "", message: ONE_LONG_LINE }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });

  it("and expanding it drops the clamp, so the hidden tail is actually reachable", () => {
    // The control existing is not the fix — reaching the text is. Asserts the body stops carrying
    // the clamp, which is the thing that was hiding it.
    mount(entry({ gist: "", message: ONE_LONG_LINE }));
    fireEvent.click(screen.getByTestId(PEER_EXPAND_TESTID));
    const body = screen.getByTestId(PEER_BODY_TESTID);
    expect(body.style.getPropertyValue("-webkit-line-clamp")).toBe("");
    expect(body.textContent).toBe(ONE_LONG_LINE);
  });

  it("offers it for TWO long lines too — line count alone was never the question", () => {
    const two = `${"a".repeat(PEER_CLAMP_SAFE_CHARS)}\n${"b".repeat(PEER_CLAMP_SAFE_CHARS)}`;
    mount(entry({ gist: "", message: two }));
    expect(screen.getByTestId(PEER_EXPAND_TESTID)).toBeTruthy();
  });

  it("still draws NO control for a genuinely short message", () => {
    // The other direction still holds: a message two lines could not have clamped gets no control,
    // so the affordance keeps meaning something.
    mount(entry({ gist: "", message: "one short line" }));
    expect(screen.queryByTestId(PEER_EXPAND_TESTID)).toBeNull();
  });
});

describe("PeerMessageRow — an app-global end is never called closed (roborev 68628)", () => {
  const withConcierge = () =>
    peerMessageEntry({
      id: "peer-c",
      from: { id: "sparkle:concierge", name: "Sparkle", appGlobal: true },
      to: { id: "a2", name: "Rust Half" },
      message: "the founder asked for the parser split",
      gist: "relaying a decision",
    });

  it("does not claim the concierge is closed", () => {
    // `AgentPill` reads "not in the roster I was given" as evidence the agent is GONE. The
    // concierge's id is deliberately not a roster row, so a pill here announced that the assistant
    // the human is mid-conversation with is closed — on every row it appears in.
    mount(withConcierge());
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
    expect(screen.getByTestId(PEER_ROW_TESTID).textContent).not.toContain("is closed");
  });

  it("still names it, as prose rather than a pill wired to nothing", () => {
    mount(withConcierge());
    const party = screen.getByTestId(PEER_APP_PARTY_TESTID);
    expect(party.textContent).toBe("Sparkle");
    expect(party.tagName).not.toBe("BUTTON");
  });

  it("leaves the ORDINARY end a real pill — the fix is scoped to app-global ids", () => {
    // A spun-down worker SHOULD still read as closed; that claim is true. Only the app-global ids
    // are the false case, so the repair must not flatten every end into prose.
    mount(withConcierge());
    // The EXACT id, not a regex — `concierge-agent-pill-closed` and `-unwired` both contain it, so
    // a loose match would be satisfied by the very failure this describe is about.
    const pills = screen.getAllByTestId("concierge-agent-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.getAttribute("data-agent-id")).toBe("a2");
  });
});

describe("PeerMessageRow — the agent pills", () => {
  it("draws BOTH ends as real, clickable agent pills carrying their ids", () => {
    mount();
    const pills = screen.getAllByTestId("concierge-agent-pill");
    expect(pills.map((p) => p.getAttribute("data-agent-id"))).toEqual(["a1", "a2"]);
    // Real pills, not lookalikes — the dead-label bug SentToAgentRow was written to fix.
    expect(pills.every((p) => p.tagName === "BUTTON")).toBe(true);
  });

  it("opens the agent a pill names", () => {
    const onOpenAgent = vi.fn((): RevealOutcome => "revealed");
    mount(entry(), ctx({ onOpenAgent }));
    const pills = screen.getAllByTestId("concierge-agent-pill");
    // The RECIPIENT pill — asserted to exist rather than indexed blind, so a row that stopped
    // drawing the second pill fails here instead of throwing an opaque undefined-target error.
    expect(pills).toHaveLength(2);
    fireEvent.click(pills[1]!);
    expect(onOpenAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "a2" }));
  });

  it("falls back to the recorded name when the roster no longer resolves the agent", () => {
    // An agent that has since been spun down still has to be readable — the row is a record of
    // something that happened, and it must not degrade into a bare uuid.
    mount(entry(), ctx({ agents: [] }));
    expect(screen.getByTestId(PEER_ROW_TESTID).textContent).toContain("Rust Half");
  });
});

describe("PeerMessageRow — copy all", () => {
  it("copies the FULL message, not the gist that is on screen", async () => {
    // The founder's use for this button is pasting what one agent told another into a PR or a
    // message to a person. Copying the two-line clamp would silently hand him a summary.
    mount();
    fireEvent.click(screen.getByTestId("concierge-copy-peer"));
    await settle();
    expect(writeText).toHaveBeenCalledWith(LONG);
  });

  it("copies the full message while the row is still collapsed", async () => {
    mount();
    expect(screen.getByTestId(PEER_ROW_TESTID).getAttribute("data-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("concierge-copy-peer"));
    await settle();
    expect(writeText).toHaveBeenCalledWith(LONG);
  });
});

describe("the row dispatch", () => {
  it("ConciergeMessageRow draws a peer message as the peer row", () => {
    // The wiring, not the component: without the `kind === "peer"` branch this message would fall
    // through to the sparkle-bubble default and render as an assistant reply.
    render(
      <AgentPillProvider value={ctx()}>
        <ConciergeMessageRow
          message={entry()}
          wired={false}
          shownBlockIds=""
          onOpenPayload={vi.fn()}
          onNudgeClick={vi.fn()}
          onNudgeAction={vi.fn()}
          onAnswerCopied={vi.fn()}
          onMessageCopied={vi.fn()}
        />
      </AgentPillProvider>,
    );
    expect(screen.getByTestId(PEER_ROW_TESTID)).toBeTruthy();
    expect(screen.getByTestId(PEER_BODY_TESTID).textContent).toBe(
      "taking the parser; you own the codegen",
    );
  });
});
