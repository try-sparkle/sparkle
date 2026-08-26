// @vitest-environment jsdom
//
// `ChatPane` — the person chat surface in the terminal stage (bead `sparkle-xnjil.10`).
//
// ── WHAT THESE ASSERT, AND WHY IT IS NOT THE OBVIOUS THING ─────────────────────────────────────
// "The pane renders" is vacuous: it is true of a `<div/>`. Every test here names a behaviour the
// bead and the design call out by name — the hide-without-collapsing contract, the person key, the
// composer being this pane's ONE input surface, the send signature carrying its deferred fields —
// and is written so that removing the mechanism turns it red.
//
// jsdom caveats apply (docs/jsdom-test-caveats.md): no layout engine and no stylesheet, so
// `getComputedStyle` reads nothing that comes from a class. Every style assertion below is against
// an INLINE style, which jsdom does resolve, and which is where this pane's visibility contract
// actually lives.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatPane } from "./ChatPane";
import { personAgentId } from "../engine/social";
import { useSocialStore } from "../stores/socialStore";
import type { ChatMessage, ChatSendExtras, ChatThreadSource } from "../engine/chatThread";
import { CHAT_NO_PERSON } from "./chatCopy";

const ADA = "soc-ada";
const GRACE = "soc-grace";

function seedPeople() {
  useSocialStore.setState({
    people: {
      [ADA]: {
        socialId: ADA,
        username: "ada",
        displayName: "Ada L.",
        availability: "available",
        relationship: "connected",
      },
      [GRACE]: {
        socialId: GRACE,
        username: "grace",
        displayName: null,
        availability: "offline",
        relationship: "connected",
      },
    },
  } as never);
}

const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, "id">): ChatMessage => ({
  mine: false,
  author: "ada",
  body: "hello",
  createdAt: "2026-08-25T00:00:00.000Z",
  ...over,
});

/** A test double for the injected transport. Records every send verbatim. */
function stubThread(over: Partial<ChatThreadSource> = {}) {
  const sends: Array<{ body: string; extras?: ChatSendExtras }> = [];
  const source: ChatThreadSource = {
    messages: [],
    state: "ready",
    error: null,
    send: async (body, extras) => {
      sends.push({ body, extras });
      return { ok: true };
    },
    ...over,
  };
  return { source, sends };
}

beforeEach(() => {
  seedPeople();
});
afterEach(() => {
  cleanup();
  useSocialStore.setState({ people: {} } as never);
});

describe("the pane's shape in the stage", () => {
  // THE SHAPE THE BEAD SPECIFIES, and it is what lets several panes stack in one stage with exactly
  // one painting. Asserted on the inline style because that is where the component writes it.
  it("is absolutely positioned and inset to fill the stage", () => {
    const { source } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    const pane = screen.getByTestId("chat-pane");
    expect(pane.style.position).toBe("absolute");
    expect(pane.style.inset).toBe("0");
  });

  // ══ THE paneVisibility BUG CLASS, ASSERTED THE WAY THE BEAD ASKS ═══════════════════════════════
  // "assert the terminal pane is visibility:hidden while STILL LAID OUT, not that the node is
  // absent". Same contract on this side of it: a hidden chat pane must keep a real box. The
  // `display` half is the load-bearing one — `display: none` is what collapses a pane, and a test
  // that only checked `visibility` would pass for the very implementation this rule exists to
  // forbid.
  it("hides WITHOUT collapsing its box — never display:none", () => {
    const { source } = stubThread();
    const { rerender } = render(
      <ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />,
    );
    const pane = screen.getByTestId("chat-pane");
    expect(pane.style.visibility).toBe("visible");

    rerender(<ChatPane visible={false} agentId={personAgentId(ADA)} useThread={() => source} />);

    expect(pane.style.visibility).toBe("hidden");
    // STILL LAID OUT. `display: flex`, not `none`.
    expect(pane.style.display).toBe("flex");
    // …and inert, so a hidden pane can never take a click meant for the pane above it.
    expect(pane.style.pointerEvents).toBe("none");
  });

  it("stays MOUNTED while hidden — the same DOM node comes back", () => {
    const { source } = stubThread({ messages: [msg({ id: "m1", body: "still here" })] });
    const { rerender } = render(
      <ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />,
    );
    const node = screen.getByTestId("chat-pane");
    const bubble = screen.getByTestId("chat-msg-m1");

    rerender(<ChatPane visible={false} agentId={personAgentId(ADA)} useThread={() => source} />);
    rerender(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);

    // Identity, not presence: a pane that unmounted and remounted would satisfy `toBeInTheDocument`
    // and fail this.
    expect(screen.getByTestId("chat-pane")).toBe(node);
    expect(screen.getByTestId("chat-msg-m1")).toBe(bubble);
  });

  it("names the person it belongs to, not a bare agent id", () => {
    const { source } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    // The display name wins over the username — one answer, from `socialStore.personName`.
    expect(screen.getByRole("region", { name: "Chat with Ada L." })).toBeTruthy();
  });

  // A caller bug must be VISIBLE. A pane that paints nothing is indistinguishable from one that
  // failed to mount, and `isPersonAgentId` is the only thing that separates the id spaces.
  it("says so when the mount id is not a person id", () => {
    const { source } = stubThread();
    render(<ChatPane visible agentId="6f1a-not-a-person" useThread={() => source} />);
    expect(screen.getByTestId("chat-no-person").textContent).toBe(CHAT_NO_PERSON);
    expect(screen.queryByTestId("chat-thread")).toBeNull();
  });
});

describe("switching people", () => {
  // THE BEAD'S OWN WORDS: "key the INNER thread on the person so switching people does not destroy
  // pane state." Both halves are asserted, and each alone would be satisfied by the wrong design:
  // pane identity alone passes for a pane with no key (Ada's draft leaks into Grace's box), and the
  // thread swap alone passes for a pane keyed at the TOP (which destroys pane state on every
  // switch).
  it("keeps the PANE instance while swapping the inner thread", () => {
    const adaThread = stubThread({ messages: [msg({ id: "a1", body: "from ada" })] });
    const graceThread = stubThread({ messages: [msg({ id: "g1", body: "from grace" })] });
    const pick = (socialId: string) => (socialId === ADA ? adaThread.source : graceThread.source);

    const { rerender } = render(
      <ChatPane visible agentId={personAgentId(ADA)} useThread={pick} />,
    );
    const pane = screen.getByTestId("chat-pane");
    expect(screen.getByTestId("chat-msg-a1")).toBeTruthy();

    rerender(<ChatPane visible agentId={personAgentId(GRACE)} useThread={pick} />);

    // The pane survived…
    expect(screen.getByTestId("chat-pane")).toBe(pane);
    // …and the conversation inside it changed.
    expect(screen.queryByTestId("chat-msg-a1")).toBeNull();
    expect(screen.getByTestId("chat-msg-g1")).toBeTruthy();
    expect(pane.dataset.chatSocialId).toBe(GRACE);
  });

  // THE CONSEQUENCE OF THE KEY, stated as the failure it prevents: a half-typed message to one
  // person must never surface in another person's composer. Without `key={socialId}` React reuses
  // the instance and this text survives the switch.
  it("does not carry a half-typed draft across to the other person", () => {
    const { source } = stubThread();
    const { rerender } = render(
      <ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />,
    );
    const box = screen.getByTestId("chat-composer") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "meet me at 3" } });
    expect((screen.getByTestId("chat-composer") as HTMLTextAreaElement).value).toBe("meet me at 3");

    rerender(<ChatPane visible agentId={personAgentId(GRACE)} useThread={() => source} />);

    expect((screen.getByTestId("chat-composer") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("the composer — this pane's ONE input surface", () => {
  it("hands the trimmed body to the injected transport", async () => {
    const { source, sends } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    fireEvent.change(screen.getByTestId("chat-composer"), { target: { value: "  hi ada  " } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-send"));
    });
    expect(sends).toEqual([{ body: "hi ada", extras: {} }]);
  });

  // THE SIGNATURE CARRIES THE DEFERRED FIELDS FROM DAY ONE (`mentions`, `attachments`), so
  // `sparkle-xnjil.17` needs no change here. Asserted as a fact about the CALL — the transport is
  // handed an extras object it can read those off — rather than as a fact about the type, which no
  // runtime test can see.
  it("passes an extras object, so the deferred fields need no signature change", async () => {
    const { source, sends } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    fireEvent.change(screen.getByTestId("chat-composer"), { target: { value: "yo" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-send"));
    });
    expect(sends[0]!.extras).toBeDefined();
    // Nothing produces them yet — the fields exist, unread, exactly as the bead specifies.
    expect(sends[0]!.extras!.mentions).toBeUndefined();
    expect(sends[0]!.extras!.attachments).toBeUndefined();
  });

  it("Enter sends; Shift+Enter does not", async () => {
    const { source, sends } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    const box = screen.getByTestId("chat-composer");

    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(sends).toEqual([]);

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(sends.map((s) => s.body)).toEqual(["line one"]);
  });

  it("refuses a whitespace-only body — the button stays disabled and nothing is sent", () => {
    const { source, sends } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    fireEvent.change(screen.getByTestId("chat-composer"), { target: { value: "   " } });
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByTestId("chat-composer"), { key: "Enter" });
    expect(sends).toEqual([]);
  });

  it("clears the box after a send, so the next line can be typed straight away", async () => {
    const { source } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    fireEvent.change(screen.getByTestId("chat-composer"), { target: { value: "sent" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-send"));
    });
    expect((screen.getByTestId("chat-composer") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("the thread", () => {
  it("puts the viewer's own messages on the other side from the peer's", () => {
    const { source } = stubThread({
      messages: [msg({ id: "p1", body: "hi" }), msg({ id: "m1", mine: true, body: "hey" })],
    });
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    expect(screen.getByTestId("chat-msg-p1").dataset.mine).toBe("false");
    expect(screen.getByTestId("chat-msg-m1").dataset.mine).toBe("true");
  });

  it("renders a body through Markdown rather than as a flat string", () => {
    const { source } = stubThread({ messages: [msg({ id: "m1", body: "**shipped**" })] });
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    // The bold survives as an element — a `textContent` check alone would pass for a pane that
    // printed the asterisks verbatim.
    expect(screen.getByTestId("chat-msg-m1").querySelector("strong")?.textContent).toBe("shipped");
  });

  it("says a pending message is still sending, and a failed one was not delivered", () => {
    const { source } = stubThread({
      messages: [
        msg({ id: "p", mine: true, pending: true }),
        msg({ id: "f", mine: true, failed: true }),
      ],
    });
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    expect(screen.getByTestId("chat-msg-state-p").textContent).toBe("Sending…");
    expect(screen.getByTestId("chat-msg-state-f").textContent).toBe("Not delivered");
  });

  // A FAILED SEND KEEPS THE WORDS. The bubble stays in the thread — losing a message because the
  // network blinked is the one outcome a chat surface may not have.
  it("keeps a failed message's text on screen", () => {
    const { source } = stubThread({
      messages: [msg({ id: "f", mine: true, body: "important", failed: true })],
    });
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    expect(screen.getByTestId("chat-msg-f").textContent).toContain("important");
  });

  // "LOADED AND EMPTY" AND "NO TRANSPORT" ARE DIFFERENT FACTS and must not paint the same. The
  // empty state is a claim about the conversation; the unwired one is a claim about the app.
  it("distinguishes an empty conversation from an unconnected one", () => {
    const ready = stubThread({ state: "ready" });
    const { rerender } = render(
      <ChatPane visible agentId={personAgentId(ADA)} useThread={() => ready.source} />,
    );
    expect(screen.getByTestId("chat-empty")).toBeTruthy();
    expect(screen.queryByTestId("chat-unwired")).toBeNull();

    const unwired = stubThread({ state: "unwired" });
    rerender(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => unwired.source} />);
    expect(screen.getByTestId("chat-unwired")).toBeTruthy();
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });

  it("surfaces the transport's own error sentence rather than a generic one", () => {
    const { source } = stubThread({ state: "error", error: "You are not connected to Ada L." });
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    expect(screen.getByRole("alert").textContent).toContain("You are not connected to Ada L.");
  });

  it("wires the transport's backwards-paging callback to the scroller", () => {
    const onReachTop = vi.fn();
    const { source } = stubThread({ onReachTop, messages: [msg({ id: "m1" })] });
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    const scroller = screen.getByTestId("chat-thread");
    // `useAutoFollow` pages only on a scroll the READER made — an event that moved nothing is
    // ignored — so move the position first, then fire.
    Object.defineProperty(scroller, "scrollTop", { value: 4, writable: true, configurable: true });
    fireEvent.scroll(scroller);
    expect(onReachTop).toHaveBeenCalled();
  });
});
