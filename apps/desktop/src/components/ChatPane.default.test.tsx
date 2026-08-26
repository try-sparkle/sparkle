// @vitest-environment jsdom
//
// ══ THE DEFAULT SEAM IS EXERCISED HERE, AND NOWHERE ELSE ═══════════════════════════════════════
//
// `ChatPane` takes its transport as an injected `useThread` prop with a default, so the pane can
// land before the server half (design stage S4) exists. Every OTHER test of this pane injects its
// own double — which is precisely the measured vacuity trap this repo keeps paying for: "a
// defaulted seam every test injects — the line supplying the real value is covered by nothing:
// delete it and the suite stays green while the bug comes back" (AGENTS.md).
//
// So this file mounts `ChatPane` with NO `useThread` at all and asserts what the DEFAULT produces.
// Delete `= useUnwiredChatThread` from the signature and this file goes red immediately (the pane
// crashes calling `undefined`); change the default to a `ready` empty thread and it goes red on the
// copy, because "loaded and empty" and "not connected" are different claims.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatPane, useUnwiredChatThread } from "./ChatPane";
import { personAgentId } from "../engine/social";
import { useSocialStore } from "../stores/socialStore";
import {
  CHAT_COMPOSER_PLACEHOLDER_UNWIRED,
  CHAT_UNWIRED_BODY,
  CHAT_UNWIRED_TITLE,
} from "./chatCopy";

const ADA = "soc-ada";

afterEach(() => {
  cleanup();
  useSocialStore.setState({ people: {} } as never);
});

describe("ChatPane with NO injected transport — the default", () => {
  it("mounts and paints, rather than crashing on an undefined hook", () => {
    render(<ChatPane visible agentId={personAgentId(ADA)} />);
    expect(screen.getByTestId("chat-pane")).toBeTruthy();
  });

  // THE DEFAULT'S ACTUAL CONTENT, not merely that it exists. An honest no-transport state says the
  // app cannot carry a message; an empty `ready` thread would claim nobody has sent one, which is a
  // statement about the conversation that this build is in no position to make.
  it("says messaging is not connected — NOT that the conversation is empty", () => {
    render(<ChatPane visible agentId={personAgentId(ADA)} />);
    const notice = screen.getByTestId("chat-unwired");
    expect(notice.textContent).toContain(CHAT_UNWIRED_TITLE);
    expect(notice.textContent).toContain(CHAT_UNWIRED_BODY);
    expect(screen.queryByTestId("chat-empty")).toBeNull();
  });

  // The composer is inert rather than absent. A missing box would teach the user the feature does
  // not exist; a disabled one with a reason on it says "not yet".
  it("disables the composer and says why", () => {
    render(<ChatPane visible agentId={personAgentId(ADA)} />);
    const box = screen.getByTestId("chat-composer") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe(CHAT_COMPOSER_PLACEHOLDER_UNWIRED);
    expect((screen.getByTestId("chat-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("cannot be made to send by pressing Enter in the box either", () => {
    render(<ChatPane visible agentId={personAgentId(ADA)} />);
    const box = screen.getByTestId("chat-composer");
    fireEvent.change(box, { target: { value: "hello?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    // A disabled textarea takes no input in a real browser; the assertion that matters is that no
    // state moved and the unwired notice is still what the pane shows.
    expect(screen.getByTestId("chat-unwired")).toBeTruthy();
  });
});

describe("useUnwiredChatThread — the default's own contract", () => {
  it("reports `unwired`, which is not `ready`", () => {
    const t = useUnwiredChatThread();
    expect(t.state).toBe("unwired");
    expect(t.messages).toEqual([]);
  });

  // NEVER THROWS. A rejected promise crossing the submit handler is how a user's words get lost
  // instead of staying on screen — see `ChatSendResult`.
  it("refuses a send as a VALUE, not as an exception", async () => {
    const result = await useUnwiredChatThread().send("hi");
    expect(result).toEqual({ ok: false, reason: "no_transport" });
  });

  // A fresh object per call would change `chatContentKey`'s inputs every render and re-run the
  // follow on every tick — bead `sparkle-y4ft` in miniature.
  it("returns a STABLE object, so the follow is not re-run on every render", () => {
    expect(useUnwiredChatThread()).toBe(useUnwiredChatThread());
  });
});
