// SENDING A CHAT MESSAGE TO A HUMAN — the destination `@Ada` resolves to (bead sparkle-6baj6s).
//
// ══ THE TWO CALLS, AND WHY THE FIRST IS ASSERTED RATHER THAN ASSUMED ══════════════════════════
// `createConversation` is the choke point where the SERVER runs `canMessage` — a stranger gets a
// `requested` participant, a connection gets `active`, a blocked sender gets a 403 with no row
// created. It is the only way to obtain a conversation id for someone you have no thread with. A
// future edit that "optimises" it away with a client-side cache would be building a second, laxer
// copy of an authorization rule that lives on the server, so the ORDER and the ARGUMENT of both
// calls are pinned here rather than left to the implementation's discretion.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendDirectMessage, REAL_PERSON_MESSAGING_DEPS } from "./personMessaging";
import type { PersonMessagingDeps } from "./personMessaging";
import { SocialApiError, SocialNetworkError } from "./socialApi";
import * as socialApi from "./socialApi";
import { useSocialStore } from "../stores/socialStore";

const ADA = {
  socialId: "soc-ada",
  username: "ada",
  displayName: "Ada Lovelace",
  availability: "available" as const,
  relationship: "connected" as const,
};

function deps(over: Partial<PersonMessagingDeps> = {}): PersonMessagingDeps {
  return {
    createConversation: vi.fn(async () => ({ id: "conv-1", state: "active" })),
    sendMessage: vi.fn(async () => ({ id: "m1", seq: 1, createdAt: "2026-09-09T00:00:00Z" })),
    newClientMsgId: () => "fixed-client-id",
    ...over,
  };
}

beforeEach(() => {
  useSocialStore.setState({ people: { [ADA.socialId]: ADA } });
});
afterEach(() => {
  useSocialStore.getState().reset();
  vi.restoreAllMocks();
});

describe("sendDirectMessage — the happy path", () => {
  it("opens the conversation by USERNAME, then sends the body as a text block", async () => {
    const d = deps();
    const r = await sendDirectMessage(ADA.socialId, "can you look at this?", d);

    expect(r).toEqual({ ok: true, conversationId: "conv-1" });
    // BY USERNAME, not by socialId: `createConversation` takes the username, and passing the uuid
    // would 404 at the server on every send.
    expect(d.createConversation).toHaveBeenCalledWith("ada");
    // BLOCKS, not `body`. The server flattens blocks into `body` and REJECTS a client-supplied
    // `body` (§6.6), so a send built the other way round fails for everyone, always.
    expect(d.sendMessage).toHaveBeenCalledWith("conv-1", {
      clientMsgId: "fixed-client-id",
      blocks: [{ kind: "text", text: "can you look at this?" }],
    });
  });

  it("trims the body, so trailing whitespace is not stored", async () => {
    const d = deps();
    await sendDirectMessage(ADA.socialId, "  hi  ", d);
    expect(d.sendMessage).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ blocks: [{ kind: "text", text: "hi" }] }),
    );
  });

  // THE LOOKUP IS AT SEND TIME, and that is the point of keying on socialId: §6.1 says the mount key
  // is not the username precisely so a rename cannot orphan a thread. A send addressed a moment
  // before a rename must still reach the right person.
  it("uses the username the roster holds NOW, not one captured earlier", async () => {
    const d = deps();
    useSocialStore.setState({ people: { [ADA.socialId]: { ...ADA, username: "ada_renamed" } } });
    await sendDirectMessage(ADA.socialId, "hi", d);
    expect(d.createConversation).toHaveBeenCalledWith("ada_renamed");
  });
});

describe("sendDirectMessage — every failure keeps the words and says why", () => {
  // THE CONTRACT THIS FILE EXISTS FOR: never throws. An exception crossing the submit handler is how
  // the founder's words get lost instead of staying in the box.
  it("returns a value rather than throwing when the server refuses", async () => {
    const d = deps({
      createConversation: vi.fn(async () => {
        throw new SocialApiError(403, "blocked");
      }),
    });
    const r = await sendDirectMessage(ADA.socialId, "hi", d);
    expect(r.ok).toBe(false);
    // NAMES THE PERSON and offers NO remedy: a block is a decision, and "try again" at one is an
    // instruction that cannot succeed (AGENTS.md — a remedy string is an instruction).
    expect(r).toMatchObject({ reason: expect.stringContaining("Ada Lovelace") });
    if (!r.ok) expect(r.reason).not.toMatch(/try again/i);
  });

  // THE ONE ARM WHERE A RETRY IS HONEST — the server was never reached, so nothing was decided.
  // Paired with the row above so an implementation printing one sentence for every failure fails.
  it("distinguishes a transport failure, where retrying IS the right advice", async () => {
    const d = deps({
      createConversation: vi.fn(async () => {
        throw new SocialNetworkError();
      }),
    });
    const r = await sendDirectMessage(ADA.socialId, "hi", d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/couldn't reach the server/i);
  });

  it("reports a not_connected refusal with the action that clears it", async () => {
    const d = deps({
      createConversation: vi.fn(async () => {
        throw new SocialApiError(403, "not_connected");
      }),
    });
    const r = await sendDirectMessage(ADA.socialId, "hi", d);
    if (!r.ok) expect(r.reason).toMatch(/connection request/i);
    else expect.fail("expected a refusal");
  });

  // A SEND THAT FAILS AFTER THE CONVERSATION OPENED is still a failure. Without this row an
  // implementation that awaited only the first call would be green on the happy path and would
  // report success for a message the server never stored.
  it("fails when the MESSAGE call fails, even though the conversation opened", async () => {
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new SocialApiError(500, null);
      }),
    });
    const r = await sendDirectMessage(ADA.socialId, "hi", d);
    expect(r.ok).toBe(false);
  });

  it("refuses an empty body without touching the network", async () => {
    const d = deps();
    const r = await sendDirectMessage(ADA.socialId, "   ", d);
    expect(r.ok).toBe(false);
    expect(d.createConversation).not.toHaveBeenCalled();
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses a socialId the roster no longer knows, without touching the network", async () => {
    const d = deps();
    const r = await sendDirectMessage("soc-nobody", "hi", d);
    expect(r.ok).toBe(false);
    expect(d.createConversation).not.toHaveBeenCalled();
  });
});

// ══ THE DEFAULTED SEAM ════════════════════════════════════════════════════════════════════════
// Every test above injects `deps`, which is exactly the shape AGENTS.md warns about: the line
// supplying the REAL value is then covered by nothing, and deleting it leaves the suite green while
// production sends nothing anywhere. So the production wiring is asserted directly.
describe("the production deps are the real transport", () => {
  it("points at socialApi's own functions", () => {
    expect(REAL_PERSON_MESSAGING_DEPS.createConversation).toBe(socialApi.createConversation);
    expect(REAL_PERSON_MESSAGING_DEPS.sendMessage).toBe(socialApi.sendMessage);
  });

  it("mints a distinct client message id per call", () => {
    const a = REAL_PERSON_MESSAGING_DEPS.newClientMsgId();
    const b = REAL_PERSON_MESSAGING_DEPS.newClientMsgId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});
