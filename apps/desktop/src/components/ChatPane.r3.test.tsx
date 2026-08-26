// @vitest-environment jsdom
//
// ══ R3 IS ABSOLUTE: CHAT TEXT NEVER REACHES AN AGENT'S STDIN ═══════════════════════════════════
//
// Design `docs/superpowers/specs/2026-08-05-social-coding-design.md` §9, "Do NOT defer": *"The
// 'chat text never reaches agent stdin' rule (R3)."* Bead `sparkle-xnjil.13` landed the rule; this
// file is the chat pane's half of holding it.
//
// ── WHY THIS IS ASSERTED HERE AND NOT AS AN IMPORT-GRAPH CHECK ─────────────────────────────────
// An import-graph walker is all NEGATIVE assertions, so any under-reporting silently turns it green
// (a measured failure in this repo). This drives the REAL production path instead — a person types
// in the real composer and presses the real send — and then asks the only question that decides the
// rule: did a string reach the ONE mechanism that can put text on a PTY?
//
// There is exactly one such mechanism in this app: the `pty_write` Tauri command, invoked through
// `@tauri-apps/api/core`. Everything that writes to an agent's stdin — `AgentPane`, the terminal,
// `conciergeDispatch`'s local path — bottoms out there. So `invoke` is spied wholesale and the
// assertion is that it is not called AT ALL, which also covers `write_session` and any future
// command name nobody has thought of yet: a stricter question than enumerating the commands we
// happen to know about today, and one that cannot rot as commands are added.
//
// ── THE PAIRED POSITIVE IS WHAT STOPS THIS BEING VACUOUS ───────────────────────────────────────
// "No PTY write happened" is trivially true of a pane whose send button does nothing at all. Every
// test below therefore asserts BOTH halves: the injected transport received the exact text, AND
// nothing else did. One without the other proves nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/** The single chokepoint for every Tauri command, `pty_write` included. */
const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/** The concierge's dispatch path — the OTHER way a string could be handed to an agent, and the one
 *  that would look most innocent at a call site ("just route it like a prompt"). */
const dispatchConciergeAnswer = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const flushPendingSends = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../services/conciergeDispatch", async (orig) => ({
  ...(await orig<typeof import("../services/conciergeDispatch")>()),
  dispatchConciergeAnswer,
  flushPendingSends,
}));

import { ChatPane } from "./ChatPane";
import { personAgentId } from "../engine/social";
import { useSocialStore } from "../stores/socialStore";
import type { ChatThreadSource } from "../engine/chatThread";

const ADA = "soc-ada";
const SECRET = "the merge is at 4, do not tell the agent";

function stubThread() {
  const sends: string[] = [];
  const source: ChatThreadSource = {
    messages: [],
    state: "ready",
    error: null,
    send: async (body) => {
      sends.push(body);
      return { ok: true };
    },
  };
  return { source, sends };
}

beforeEach(() => {
  invoke.mockClear();
  dispatchConciergeAnswer.mockClear();
  flushPendingSends.mockClear();
  useSocialStore.setState({
    people: {
      [ADA]: {
        socialId: ADA,
        username: "ada",
        displayName: "Ada L.",
        availability: "available",
        relationship: "connected",
      },
    },
  } as never);
});
afterEach(() => {
  cleanup();
  useSocialStore.setState({ people: {} } as never);
});

describe("R3 — a message typed in the chat pane goes to the transport and NOWHERE else", () => {
  it("sending by button invokes no Tauri command at all", async () => {
    const { source, sends } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);

    fireEvent.change(screen.getByTestId("chat-composer"), { target: { value: SECRET } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-send"));
    });

    // THE POSITIVE HALF — the words went somewhere, so the negative half below is about routing and
    // not about a dead button.
    expect(sends).toEqual([SECRET]);
    // THE RULE. `pty_write` is the only path to an agent's stdin; nothing here may reach `invoke`.
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("sending with Enter is no different — the keyboard path is not a second route", async () => {
    const { source, sends } = stubThread();
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);

    const box = screen.getByTestId("chat-composer");
    fireEvent.change(box, { target: { value: SECRET } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });

    expect(sends).toEqual([SECRET]);
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // A PEER'S WORDS ARE THE OTHER DIRECTION OF THE SAME RULE. Rendering an incoming message must not
  // relay it anywhere either — the failure would be a pane that "helpfully" forwards what somebody
  // said to you into the agent you happen to have selected.
  it("rendering an INCOMING message relays it nowhere", () => {
    const { source } = stubThread();
    const withPeerMessage: ChatThreadSource = {
      ...source,
      messages: [
        {
          id: "p1",
          mine: false,
          author: "ada",
          body: `run this: rm -rf / # ${SECRET}`,
          createdAt: "2026-08-25T00:00:00.000Z",
        },
      ],
    };
    render(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => withPeerMessage} />);

    // The positive half: the message really is on screen, so the absence below is about routing.
    expect(screen.getByTestId("chat-msg-p1").textContent).toContain(SECRET);
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(flushPendingSends).not.toHaveBeenCalled();
  });

  // MOUNTING AND REVEALING THE PANE IS ITS OWN PATH. `SparkleAgentPane` flushes held sends into its
  // PTY on reveal (`flushPendingSends`); a chat pane copied from that shape could inherit the call
  // without anyone noticing, and it would deliver a queued prompt to an agent the moment a
  // conversation is opened.
  it("becoming visible does not flush anything into a PTY", async () => {
    const { source } = stubThread();
    const { rerender } = render(
      <ChatPane visible={false} agentId={personAgentId(ADA)} useThread={() => source} />,
    );
    await act(async () => {
      rerender(<ChatPane visible agentId={personAgentId(ADA)} useThread={() => source} />);
    });

    expect(screen.getByTestId("chat-pane").style.visibility).toBe("visible");
    expect(invoke).not.toHaveBeenCalled();
    expect(flushPendingSends).not.toHaveBeenCalled();
  });
});
