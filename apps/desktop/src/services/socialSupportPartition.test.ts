// The reconciliation guard for open question 15 — the Sparkle Support Agent and the support-ticket
// surface that already ships must be ONE thing, not two rows side by side (design §7).
//
// ── WHAT THESE TESTS ARE ACTUALLY GUARDING ───────────────────────────────────────────────────────
// The way a second support surface ships is not a decision anyone takes. It is a `.map()` over the
// conversation list that happens to contain a `kind: "support"` row, rendered as a chat row, next
// to the `SupportTicketRow` already pinned at AgentSidebar.tsx:4011. So the assertions below are
// about ABSENCE from `chats` — and every one of them is PAIRED with the positive that must still
// hold under the same input, because "the support row is not in chats" is trivially satisfied by a
// partition that returns nothing at all, and a chat list that renders no chats would pass every
// negative here while deleting the feature.
//
// See PRD/social-coding-support-agent-seam.md for the decision these pin.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  __setSocialApiDeps,
  getConversations,
  partitionConversations,
  type ConversationRow,
} from "./socialApi";

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A row as the server emits it. `kind` defaults to `dm` so a case can override just that. */
function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: "conv-dm",
    kind: "dm",
    socialId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    state: "active",
    unread: 0,
    lastSeq: 0,
    ...over,
  };
}

const support = (over: Partial<ConversationRow> = {}) =>
  row({ id: "conv-support", kind: "support", ...over });

describe("partitionConversations — the support thread never reaches a chat row", () => {
  it("routes the support conversation to `support` and NOT into `chats`", () => {
    const p = partitionConversations([row({ id: "a" }), support(), row({ id: "b" })]);

    // THE GUARD. A chat row is built from `chats` and from nothing else, so this is the assertion
    // that a second support row cannot be rendered.
    expect(p.chats.map((c) => c.id)).toEqual(["a", "b"]);
    expect(p.chats.some((c) => c.kind === "support")).toBe(false);

    // THE PAIRED POSITIVE — the support thread is not DISCARDED, it is re-homed. Dropping it would
    // also satisfy the assertion above while making the one support slot unable to ever show it.
    expect(p.support?.id).toBe("conv-support");
  });

  it("keeps every DM when there is no support conversation at all", () => {
    // The state before a user's first username claim: the server seeds the support thread on the
    // claim, not at signup, so a partition must be correct with `support: null`.
    const p = partitionConversations([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    expect(p.chats.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(p.support).toBeNull();
  });

  it("an empty payload yields no chats and no support", () => {
    const p = partitionConversations([]);
    expect(p.chats).toEqual([]);
    expect(p.support).toBeNull();
  });

  it("a SECOND support row is dropped from BOTH halves, never demoted into chats", () => {
    // Not representable server-side — the `dm_key` unique index is the create-once gate — but if it
    // ever were, letting the extra one fall through to `chats` would ship the second support
    // surface by the back door, which is the exact failure this seam exists to prevent. Failing
    // toward ONE support row is the safe direction.
    const p = partitionConversations([
      support({ id: "first" }),
      support({ id: "second" }),
      row({ id: "dm" }),
    ]);
    expect(p.support?.id).toBe("first");
    expect(p.chats.map((c) => c.id)).toEqual(["dm"]);
  });

  it("preserves the server's order among chats", () => {
    // The server orders the list; the partition must not silently re-sort it, or a client that
    // relied on that order would show conversations in an order nothing chose.
    const p = partitionConversations([row({ id: "z" }), support(), row({ id: "a" })]);
    expect(p.chats.map((c) => c.id)).toEqual(["z", "a"]);
  });

  it("carries the row's own fields through untouched", () => {
    // The partition re-homes rows; it must not rebuild them. An unread count lost here is a badge
    // that never appears.
    const p = partitionConversations([support({ unread: 4, state: "active", lastSeq: 9 })]);
    expect(p.support).toMatchObject({ unread: 4, state: "active", lastSeq: 9 });
  });
});

describe("getConversations — the partition IS the API", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let restore: () => void;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonRes(200, { conversations: [] }));
    restore = __setSocialApiDeps({
      fetch: fetchMock as unknown as typeof fetch,
      getToken: async () => "tok-123",
      baseUrl: "https://api.test",
    });
  });

  afterEach(() => restore());

  it("splits a real payload, so no caller can obtain the flat list", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        conversations: [
          { id: "s", kind: "support", socialId: "x", state: "active", unread: 1, lastSeq: 1 },
          { id: "d", kind: "dm", socialId: "y", state: "active", unread: 0, lastSeq: 0 },
        ],
      }),
    );
    const p = await getConversations();

    // The side effect that matters: what a chat-row `.map()` would receive.
    expect(p.chats.map((c) => c.id)).toEqual(["d"]);
    expect(p.support?.id).toBe("s");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test/social/conversations");
  });

  it("a payload with no `kind` at all leaves every row in chats", async () => {
    // A server that predates `kind` yields `undefined`, which is not `"support"`. Failing OPEN is
    // correct here and is not the leniency this file otherwise refuses: the support row cannot
    // exist before the server that emits `kind` is deployed, so there is nothing to leak — whereas
    // routing unknown rows to `support` would make a plain DM disappear from the chat list.
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        conversations: [{ id: "old", socialId: "y", state: "active", unread: 0, lastSeq: 0 }],
      }),
    );
    const p = await getConversations();
    expect(p.chats.map((c) => c.id)).toEqual(["old"]);
    expect(p.support).toBeNull();
  });

  it("a NON-JSON body yields an empty partition rather than a raw TypeError", async () => {
    // `readJson` answers `null` for a 204, an empty-bodied 200, or a proxy serving HTML, and
    // `request` casts that null to the declared type. Destructuring it would throw a bare
    // `TypeError` — neither `SocialApiError` nor `SocialNetworkError`, the two types every caller
    // of this module is written to branch on — so an unrouted path would crash the sidebar
    // instead of rendering as "no conversations". This is the assertion for that null, which the
    // `{}` case below cannot make: `{}` is an OBJECT and destructures happily. (roborev 69154.)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    } as unknown as Response);
    await expect(getConversations()).resolves.toEqual({ chats: [], support: null });
  });

  it("a payload with no `conversations` key does not throw", async () => {
    // The chat list is one of the first things the app asks for; a malformed answer must not take
    // the sidebar down with it.
    fetchMock.mockResolvedValueOnce(jsonRes(200, {}));
    const p = await getConversations();
    expect(p).toEqual({ chats: [], support: null });
  });
});
