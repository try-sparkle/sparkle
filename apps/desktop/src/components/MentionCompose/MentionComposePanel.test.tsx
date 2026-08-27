// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MentionComposePanel } from "./MentionComposePanel";
import type { MentionChannel } from "./mentionChannel";

afterEach(cleanup);

/** A controllable double keyed BY MESSAGE ID: each `send` mints a distinct id (`m1`, `m2`, …) and
 *  `awaitReply` returns the deferred registered under the id it is CALLED with. That is what makes the
 *  id-threading real: if the hook fetched the reply under the wrong key, no deferred resolves and the
 *  turn never leaves pending. It also lets two turns be in flight and settle into their own rows. */
function deferredChannel() {
  const sends: Array<{ target: string; body: string; threadRef: string; from: string }> = [];
  const gates = new Map<string, { resolve: (b: string) => void; reject: (e: Error) => void }>();
  let n = 0;
  const channel: MentionChannel = {
    send: vi.fn(async (input) => {
      sends.push(input);
      n += 1;
      return { messageId: `m${n}` };
    }),
    awaitReply: vi.fn(
      (messageId: string) =>
        new Promise<{ body: string }>((resolve, reject) => {
          gates.set(messageId, { resolve: (body) => resolve({ body }), reject });
        }),
    ),
  };
  return {
    channel,
    sends,
    releaseReply: (body: string, id = "m1") => gates.get(id)!.resolve(body),
    failReply: (e: Error, id = "m1") => gates.get(id)!.reject(e),
  };
}

function typeAndSend(text: string) {
  const input = screen.getByTestId("mention-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByTestId("mention-send"));
}

describe("MentionComposePanel — pinging @improve / @sparkle", () => {
  it("routes a sent @improve message to the backend channel with the improve handle + stripped body", async () => {
    const { channel, sends } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);

    typeAndSend("@improve why is CI red?");

    // THE routing side effect: the channel saw target "improve" and the body without the handle.
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ target: "improve", body: "why is CI red?" });
  });

  it("shows a PENDING state (labeled with the agent) while the reply is in flight — not an empty blank", async () => {
    const { channel, releaseReply } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);

    typeAndSend("@improve why is CI red?");

    // While the reply is unresolved: the pending row exists, the reply does NOT, and the empty-state
    // placeholder is gone (distinguishing loading from empty — the accounts-modal flicker lesson).
    const pending = await screen.findByTestId("mention-pending");
    expect(pending.textContent).toContain("Improve Sparkle is thinking");
    expect(screen.queryByTestId("mention-reply")).toBeNull();
    expect(screen.queryByTestId("mention-empty")).toBeNull();

    // THE ID THREADING: the reply is fetched under the ACK's id ("m1"). If the hook fetched the wrong
    // key the gate below never resolves and the turn hangs pending — so this is load-bearing, not a
    // free assertion. (Mutate `ack.messageId` in the hook and this test hangs → red.)
    await waitFor(() => expect(channel.awaitReply).toHaveBeenCalledWith("m1"));

    // Release the reply under that same id → it arrives, pending clears.
    await act(async () => {
      releaseReply("A runner was saturated.", "m1");
    });
    const reply = await screen.findByTestId("mention-reply");
    expect(reply.textContent).toContain("A runner was saturated.");
    expect(screen.queryByTestId("mention-pending")).toBeNull();
  });

  it("threads two concurrent turns to their OWN rows by message id", async () => {
    const { channel, releaseReply } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);

    typeAndSend("@improve first question");
    await waitFor(() => expect(channel.awaitReply).toHaveBeenCalledWith("m1"));
    typeAndSend("@sparkle second question");
    await waitFor(() => expect(channel.awaitReply).toHaveBeenCalledWith("m2"));

    // Resolve the SECOND turn first — its reply must land on the second row, not the first.
    await act(async () => releaseReply("answer to second", "m2"));
    await act(async () => releaseReply("answer to first", "m1"));

    const replies = await screen.findAllByTestId("mention-reply");
    expect(replies).toHaveLength(2);
    // Row order is send order; each carries its own reply.
    expect(replies[0]!.textContent).toContain("answer to first");
    expect(replies[1]!.textContent).toContain("answer to second");
  });

  it("attributes a @sparkle reply to EXACTLY 'Sparkle' — never 'Improve Sparkle'", async () => {
    const { channel, releaseReply } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);

    typeAndSend("@sparkle who is blocked?");
    const turn = await screen.findByTestId("mention-turn");
    expect(turn.getAttribute("data-target")).toBe("sparkle");
    expect(screen.getByTestId("mention-turn-pill").textContent).toContain("@sparkle");

    await waitFor(() => expect(channel.awaitReply).toHaveBeenCalledWith("m1"));
    await act(async () => releaseReply("Three agents are blocked.", "m1"));
    const reply = await screen.findByTestId("mention-reply");
    // NOT a substring check: "Improve Sparkle" contains "Sparkle", so the exact label is what proves
    // the routing. The reply's leading label span is the attribution.
    const label = reply.querySelector("span");
    expect(label?.textContent).toBe("Sparkle");
    expect(reply.textContent).not.toContain("Improve Sparkle");
  });

  it("attributes a @improve reply to 'Improve Sparkle' — the other direction of the same distinction", async () => {
    const { channel, releaseReply } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);

    typeAndSend("@improve why is CI red?");
    await waitFor(() => expect(channel.awaitReply).toHaveBeenCalledWith("m1"));
    await act(async () => releaseReply("A runner was saturated.", "m1"));
    const reply = await screen.findByTestId("mention-reply");
    expect(reply.querySelector("span")?.textContent).toBe("Improve Sparkle");
  });

  it("handles an unrecognized handle gracefully — no send, an inline hint instead", () => {
    const { channel, sends } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);

    typeAndSend("@nobody are you there?");

    expect(sends).toHaveLength(0);
    expect(channel.send).not.toHaveBeenCalled();
    expect(screen.getByTestId("mention-hint").textContent).toContain("isn't a handle");
    // No pending row was created for a message that never went out.
    expect(screen.queryByTestId("mention-pending")).toBeNull();
  });

  it("hints (does not send) when there is a handle but no message body", () => {
    const { channel } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);
    typeAndSend("@improve");
    expect(channel.send).not.toHaveBeenCalled();
    expect(screen.getByTestId("mention-hint").textContent).toContain("Type a message");
  });

  it("renders an error state when delivery/reply fails, still naming the agent", async () => {
    const { channel, failReply } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);

    typeAndSend("@improve why is CI red?");
    await screen.findByTestId("mention-pending");
    await waitFor(() => expect(channel.awaitReply).toHaveBeenCalledWith("m1"));

    await act(async () => failReply(new Error("channel down"), "m1"));
    const err = await screen.findByTestId("mention-error");
    expect(err.textContent).toContain("Improve Sparkle");
    expect(err.textContent).toContain("channel down");
  });

  it("settles a never-answered turn out of pending to a legible timeout error", async () => {
    // A channel whose reply NEVER resolves — the dead-backend case. A tiny real bound keeps the test
    // fast while still proving the pending→error transition the bound exists for.
    const channel: MentionChannel = {
      send: vi.fn(async () => ({ messageId: "m1" })),
      awaitReply: vi.fn(() => new Promise<{ body: string }>(() => {})),
    };
    render(<MentionComposePanel channel={channel} replyTimeoutMs={20} />);

    const input = screen.getByTestId("mention-input");
    fireEvent.change(input, { target: { value: "@improve are you there?" } });
    fireEvent.click(screen.getByTestId("mention-send"));

    // Pending first, then — with no reply ever arriving — the bound fires and it becomes an error.
    await screen.findByTestId("mention-pending");
    const err = await screen.findByTestId("mention-error");
    expect(err.textContent).toContain("No reply after");
    expect(screen.queryByTestId("mention-pending")).toBeNull();
  });

  it("Enter sends; the typeahead lists both handles while a leading @ is open", async () => {
    const { channel, sends } = deferredChannel();
    render(<MentionComposePanel channel={channel} />);
    const input = screen.getByTestId("mention-input");

    fireEvent.change(input, { target: { value: "@" } });
    expect(screen.getByTestId("mention-candidate-improve")).toBeTruthy();
    expect(screen.getByTestId("mention-candidate-sparkle")).toBeTruthy();

    fireEvent.change(input, { target: { value: "@sparkle hello there" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ target: "sparkle", body: "hello there" });
  });
});
