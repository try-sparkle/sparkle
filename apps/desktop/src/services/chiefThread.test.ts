import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChiefError } from "./chief";
import {
  emptyThread,
  askChief,
  isSendFailure,
  type ChiefThreadState,
  type ThreadMsg,
} from "./chiefThread";

const startChat = vi.fn();
const sendMessage = vi.fn();
const pollForResponse = vi.fn();
const deps = { startChat, sendMessage, pollForResponse };

const msg = (id: string, author: ThreadMsg["author"], text: string): ThreadMsg => ({
  id,
  author,
  text,
});

beforeEach(() => {
  startChat.mockReset();
  sendMessage.mockReset();
  pollForResponse.mockReset();
  startChat.mockResolvedValue({ chat_id: "chat-1", message_id: "m1" });
  sendMessage.mockResolvedValue({ message_id: "m2" });
  pollForResponse.mockResolvedValue("Chief's answer");
});

const args = (over: Partial<Parameters<typeof askChief>[2]> = {}) => ({
  pat: "pat",
  chiefProjectId: "chief-proj-1",
  question: "what now?",
  messages: [msg("a", "user", "hello")],
  ...over,
});

describe("askChief — first turn", () => {
  it("opens a chat and remembers it", async () => {
    const { reply, state } = await askChief(deps, emptyThread(), args());

    expect(startChat).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(reply).toBe("Chief's answer");
    expect(state.chatId).toBe("chat-1");
    expect(state.chiefProjectId).toBe("chief-proj-1");
  });

  it("sends the whole conversation on the first turn", async () => {
    await askChief(deps, emptyThread(), args({ messages: [msg("a", "user", "hello")] }));
    const prompt = startChat.mock.calls[0]![2] as string;
    expect(prompt).toContain("hello");
    expect(prompt).toContain("what now?");
  });
});

describe("askChief — continuity", () => {
  it("uses sendMessage on the SAME chat for a follow-up turn", async () => {
    const first = await askChief(deps, emptyThread(), args());
    startChat.mockClear();

    const { state } = await askChief(deps, first.state, args({ question: "and then?" }));

    expect(startChat).not.toHaveBeenCalled(); // no new chat
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![2]).toBe("chat-1"); // same chat id
    expect(state.chatId).toBe("chat-1");
  });

  it("sends ONLY the turns Chief has not already been told about", async () => {
    // This is the point of continuity: Chief keeps its own history, so re-sending the whole
    // transcript every turn is what made the payload grow O(N^2) and trip the opaque 400.
    const convo = [msg("a", "user", "FIRST TURN"), msg("b", "chief", "chief replied")];
    const first = await askChief(deps, emptyThread(), args({ messages: convo }));

    const grown = [...convo, msg("c", "claude", "SPARKLE SAID THIS"), msg("d", "user", "NEW TURN")];
    await askChief(deps, first.state, args({ messages: grown, question: "and then?" }));

    const prompt = sendMessage.mock.calls[0]![3] as string;
    expect(prompt).toContain("SPARKLE SAID THIS"); // the new turns ARE sent
    expect(prompt).toContain("NEW TURN");
    expect(prompt).not.toContain("FIRST TURN"); // already-delivered turns are NOT re-sent
  });

  it("still tells Chief what SPARKLE said while Chief was not the responder", async () => {
    // The founder's requirement: each must be aware of what the other is saying. Sparkle's turns
    // never reach Chief's server-side history on their own — they only arrive in our delta.
    const first = await askChief(deps, emptyThread(), args());
    const grown = [
      msg("a", "user", "hello"),
      msg("s1", "claude", "Sparkle's design opinion"),
      msg("s2", "claude", "Sparkle's second point"),
    ];
    await askChief(deps, first.state, args({ messages: grown }));

    const prompt = sendMessage.mock.calls[0]![3] as string;
    expect(prompt).toContain("Sparkle's design opinion");
    expect(prompt).toContain("Sparkle's second point");
    expect(prompt).toContain('speaker="Sparkle"'); // attributed, not anonymous
  });

  it("records every message it has delivered, including ones added mid-turn", async () => {
    const convo = [msg("a", "user", "hello")];
    const first = await askChief(deps, emptyThread(), args({ messages: convo }));
    expect(first.state.deliveredIds).toContain("a");

    const grown = [...convo, msg("b", "user", "more")];
    const second = await askChief(deps, first.state, args({ messages: grown }));
    expect(second.state.deliveredIds).toEqual(expect.arrayContaining(["a", "b"]));
  });
});

describe("askChief — scoping", () => {
  it("does NOT reuse a chat across Chief projects", async () => {
    const first = await askChief(deps, emptyThread(), args({ chiefProjectId: "proj-A" }));
    startChat.mockClear();
    startChat.mockResolvedValue({ chat_id: "chat-B", message_id: "m1" });

    const { state } = await askChief(deps, first.state, args({ chiefProjectId: "proj-B" }));

    expect(sendMessage).not.toHaveBeenCalled(); // proj-A's chat must not be written into by proj-B
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(state.chatId).toBe("chat-B");
    expect(state.chiefProjectId).toBe("proj-B");
  });

  it("starts a clean delta when the project changes (no leaked delivered ids)", async () => {
    const first = await askChief(
      deps,
      emptyThread(),
      args({ chiefProjectId: "proj-A", messages: [msg("a", "user", "PROJECT A SECRET")] }),
    );
    startChat.mockClear();

    await askChief(
      deps,
      first.state,
      args({ chiefProjectId: "proj-B", messages: [msg("b", "user", "project B question")] }),
    );

    const prompt = startChat.mock.calls[0]![2] as string;
    expect(prompt).not.toContain("PROJECT A SECRET");
    expect(prompt).toContain("project B question");
  });
});

describe("askChief — never records a turn Chief was not actually sent", () => {
  it("leaves budget-elided turns UNdelivered so a later turn still carries them", async () => {
    // The delta is bounded like any transcript, so an over-budget delta drops its oldest turns.
    // Recording those as delivered would lose them from Chief's history permanently — the next
    // delta is small again, so there is no later chance to convey them.
    const first = await askChief(deps, emptyThread(), args());

    const big = (id: string) => msg(id, "claude", `${id} ${"z".repeat(20_000)}`);
    const grown = [msg("a", "user", "hello"), big("s1"), big("s2"), big("s3")];
    const second = await askChief(deps, first.state, args({ messages: grown }));

    const sent = sendMessage.mock.calls[0]![3] as string;
    // The budget (24k) can't hold three 20k turns: only the OLDEST goes out...
    expect(sent).toContain("s1 zzz");
    expect(sent).not.toContain("s3 zzz");
    // ...so the rest must NOT be recorded as delivered.
    expect(second.state.deliveredIds).toContain("s1");
    expect(second.state.deliveredIds).not.toContain("s2");
    expect(second.state.deliveredIds).not.toContain("s3");

    // The backlog drains CHRONOLOGICALLY. Chief appends each delta to its own history, so a
    // newest-first drain would leave it reading older turns as the most recent thing said.
    sendMessage.mockClear();
    const third = await askChief(deps, second.state, args({ messages: grown, question: "?" }));
    expect(sendMessage.mock.calls[0]![3] as string).toContain("s2 zzz");

    sendMessage.mockClear();
    const fourth = await askChief(deps, third.state, args({ messages: grown, question: "?" }));
    expect(sendMessage.mock.calls[0]![3] as string).toContain("s3 zzz");
    expect(fourth.state.deliveredIds).toEqual(expect.arrayContaining(["s1", "s2", "s3"]));
  });

  it("drains a backlog in the order it happened, never in reverse", async () => {
    const first = await askChief(deps, emptyThread(), args());
    const big = (id: string) => msg(id, "claude", `${id} ${"z".repeat(20_000)}`);
    const grown = [msg("a", "user", "hello"), big("s1"), big("s2"), big("s3")];

    // Walk the drain to completion, recording which turn each send carried.
    const order: string[] = [];
    let state = first.state;
    for (let i = 0; i < 3; i++) {
      sendMessage.mockClear();
      ({ state } = await askChief(deps, state, args({ messages: grown, question: "?" })));
      const body = sendMessage.mock.calls[0]![3] as string;
      order.push(["s1", "s2", "s3"].find((id) => body.includes(`${id} zzz`))!);
    }

    expect(order).toEqual(["s1", "s2", "s3"]); // as it happened — not s3, s2, s1
  });

  it("clips rather than stalls when one undelivered turn alone exceeds the budget", async () => {
    // Left unkept, a too-big turn would be re-offered forever and the backlog would never drain
    // past it — Chief would never hear anything said after it.
    const first = await askChief(deps, emptyThread(), args());
    const grown = [
      msg("a", "user", "hello"),
      msg("huge", "claude", `HUGE ${"z".repeat(80_000)}`),
      msg("after", "user", "said after the huge one"),
    ];

    const second = await askChief(deps, first.state, args({ messages: grown }));
    expect(second.state.deliveredIds).toContain("huge"); // clipped, but conveyed — not stuck

    sendMessage.mockClear();
    await askChief(deps, second.state, args({ messages: grown, question: "?" }));
    expect(sendMessage.mock.calls[0]![3] as string).toContain("said after the huge one");
  });
});

describe("askChief — a GONE chat heals itself; other failures don't", () => {
  const gone = () => new ChiefError("chat not found", 404);

  it("falls back to a fresh chat with the FULL transcript when the chat is gone", async () => {
    const convo = [msg("a", "user", "FIRST TURN"), msg("b", "chief", "chief replied")];
    const first = await askChief(deps, emptyThread(), args({ messages: convo }));

    sendMessage.mockRejectedValueOnce(gone());
    startChat.mockClear();
    startChat.mockResolvedValue({ chat_id: "chat-2", message_id: "m9" });

    const grown = [...convo, msg("c", "user", "NEW TURN")];
    const { reply, state } = await askChief(deps, first.state, args({ messages: grown }));

    expect(startChat).toHaveBeenCalledTimes(1);
    expect(state.chatId).toBe("chat-2");
    expect(reply).toBe("Chief's answer");
    // The new chat knows nothing, so it must be re-seeded with everything — not just the delta.
    const prompt = startChat.mock.calls[0]![2] as string;
    expect(prompt).toContain("FIRST TURN");
    expect(prompt).toContain("NEW TURN");
  });

  it("does NOT re-seed on a quota/transient failure — it surfaces the real cause", async () => {
    // Re-seeding sends the FULL conversation, which is the payload most likely to have failed in
    // the first place. A 402 is not a dead chat, and the user must see the 402, not its aftermath.
    const first = await askChief(deps, emptyThread(), args());
    startChat.mockClear();
    sendMessage.mockRejectedValueOnce(new ChiefError("out of credits", 402));

    await expect(askChief(deps, first.state, args())).rejects.toThrow(/out of credits/);
    expect(startChat).not.toHaveBeenCalled();
  });

  it("does NOT re-seed on an oversized-prompt 400", async () => {
    const first = await askChief(deps, emptyThread(), args());
    startChat.mockClear();
    sendMessage.mockRejectedValueOnce(new ChiefError("Chief request failed (400)", 400));

    await expect(askChief(deps, first.state, args())).rejects.toThrow(/400/);
    expect(startChat).not.toHaveBeenCalled();
  });

  it("propagates the error when the fallback ALSO fails (no silent swallow)", async () => {
    const first = await askChief(deps, emptyThread(), args());
    sendMessage.mockRejectedValueOnce(gone());
    startChat.mockRejectedValueOnce(new ChiefError("Chief request failed (402)", 402));

    await expect(askChief(deps, first.state, args())).rejects.toThrow(/402/);
  });

  it("does not fall back when the failure is the POLL, not the send", async () => {
    // A poll timeout means the chat is alive and the turn was accepted; re-seeding a whole new
    // chat would duplicate the turn.
    const first = await askChief(deps, emptyThread(), args());
    startChat.mockClear();
    pollForResponse.mockRejectedValueOnce(new Error("Chief took too long to respond."));

    await expect(askChief(deps, first.state, args())).rejects.toThrow(/too long/);
    expect(startChat).not.toHaveBeenCalled();
  });
});

describe("isSendFailure — only a failed SEND says the chat may be unhealthy", () => {
  const catchErr = async (p: Promise<unknown>) => p.then(() => null).catch((e) => e);

  it("tags a send failure whose status does NOT explain itself", async () => {
    const first = await askChief(deps, emptyThread(), args());
    sendMessage.mockRejectedValueOnce(new ChiefError("gateway", 502));

    expect(isSendFailure(await catchErr(askChief(deps, first.state, args())))).toBe(true);
  });

  it.each([
    [402, "out of credits"],
    [429, "rate limited"],
    [400, "Chief request failed (400)"],
  ])("does NOT tag a %i — it explains itself and isn't chat death", async (status, message) => {
    // Each persists across turns by its own nature, so counting it would abandon a live chat and
    // re-seed the FULL conversation — a larger prompt than the delta that just failed.
    const first = await askChief(deps, emptyThread(), args());
    sendMessage.mockRejectedValueOnce(new ChiefError(message, status));

    expect(isSendFailure(await catchErr(askChief(deps, first.state, args())))).toBe(false);
  });

  it.each([
    ["a status-less quota error", new ChiefError("quota exceeded")],
    ["quota language behind an unexpected status", new ChiefError("usage limit reached", 503)],
  ])("does NOT tag %s — status alone would miss it", async (_label, err) => {
    // chief.ts folds response detail into the message so quota language reaches isChiefQuotaError
    // even without a 402/429. A parallel status list here would miss these and abandon a live chat.
    const first = await askChief(deps, emptyThread(), args());
    sendMessage.mockRejectedValueOnce(err);

    expect(isSendFailure(await catchErr(askChief(deps, first.state, args())))).toBe(false);
  });

  it("does not mask the real error when the thrown value is frozen", async () => {
    // A TypeError from the tag write would replace the real cause on its way to the user — the
    // exact cause-swallowing this tag exists to prevent.
    const first = await askChief(deps, emptyThread(), args());
    const frozen = Object.freeze(new ChiefError("gateway", 502));
    sendMessage.mockRejectedValueOnce(frozen);

    const thrown = await catchErr(askChief(deps, first.state, args()));
    expect(thrown).toBe(frozen);
    expect((thrown as ChiefError).message).toBe("gateway"); // not "Cannot add property..."
  });

  it("does NOT tag a poll failure — the send succeeded, so the chat is demonstrably alive", async () => {
    // Counting this would abandon a healthy chat over a slow response, forcing the full re-seed
    // that the 404/410 narrowing exists to avoid.
    const first = await askChief(deps, emptyThread(), args());
    pollForResponse.mockRejectedValueOnce(new ChiefError("Chief took too long", 408));

    expect(isSendFailure(await catchErr(askChief(deps, first.state, args())))).toBe(false);
  });

  it("does NOT tag a startChat failure — there was no chat to blame", async () => {
    startChat.mockRejectedValueOnce(new ChiefError("boom", 500));

    expect(isSendFailure(await catchErr(askChief(deps, emptyThread(), args())))).toBe(false);
  });

  it("preserves the original error and its message when tagging", async () => {
    const first = await askChief(deps, emptyThread(), args());
    const original = new ChiefError("gateway", 502);
    sendMessage.mockRejectedValueOnce(original);

    const thrown = await catchErr(askChief(deps, first.state, args()));
    expect(thrown).toBe(original); // same instance — the user still sees the real cause
    expect((thrown as ChiefError).message).toBe("gateway");
    expect((thrown as ChiefError).status).toBe(502);
  });

  it("is false for a plain error that never went through askChief", () => {
    expect(isSendFailure(new Error("unrelated"))).toBe(false);
    expect(isSendFailure(null)).toBe(false);
    expect(isSendFailure("nope")).toBe(false);
  });
});

describe("askChief — the question isn't sent twice", () => {
  it("omits the question's own turn from the transcript but still marks it delivered", async () => {
    const q = msg("q1", "user", "what is the risk?");
    const { state } = await askChief(
      deps,
      emptyThread(),
      args({ messages: [msg("a", "user", "earlier"), q], question: "what is the risk?", questionMsgId: "q1" }),
    );

    const prompt = startChat.mock.calls[0]![2] as string;
    // Restated once by compose, not also rendered as a turn.
    expect(prompt.match(/what is the risk\?/g)).toHaveLength(1);
    expect(prompt).toContain("earlier"); // the rest of the conversation still goes
    // It WAS conveyed (by the restatement), so it must not be re-sent next turn.
    expect(state.deliveredIds).toContain("q1");
  });
});

describe("emptyThread", () => {
  it("starts with no chat and nothing delivered", () => {
    const s: ChiefThreadState = emptyThread();
    expect(s.chatId).toBeNull();
    expect(s.chiefProjectId).toBeNull();
    expect(s.deliveredIds).toEqual([]);
  });
});
