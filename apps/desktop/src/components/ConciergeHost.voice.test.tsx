// @vitest-environment jsdom
//
// The host wiring for the voice pass (CM-U9): who gets spoken to, and when. The leaf modules
// (the quiet gate, the dictation-target borrow) have their own tests — these cover the seams
// BETWEEN them, which is where the behavior is easy to break without failing anything else.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Append = (text: string) => void;

const h = vi.hoisted(() => ({
  dispatchConciergeAnswer: vi.fn(async (): Promise<{ ok: boolean; path?: string }> => ({
    ok: true,
    path: "free-text",
  })),
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; sessionId: string; text: string }) => void;
    error?: (e: { id: string; detail: string }) => void;
  },
  dictation: {
    micLive: false,
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  },
  speakConciergeReply: vi.fn(async () => "elevenlabs" as const),
  speakOnDemand: vi.fn(async () => "elevenlabs" as const),
  stopConciergeVoice: vi.fn(),
  shouldSpeakConciergeReply: vi.fn(() => true),
  maybePauseOnSubmit: vi.fn(),
  route: vi.fn(async () => ({ target: "sparkle" as "sparkle" | "agent", reason: "test", source: "heuristic" as const })),
}));

// The host reaches for openProjectTab (a nudge's "Show me"), not useConciergeFeed — the feed has
// been a PROP since CM-U7, so a useConciergeFeed mock here would be dead weight (roborev 48171).
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  onConciergeDelta: (cb: (e: { id: string; text: string }) => void) => {
    h.brain.delta = cb;
    return () => {};
  },
  onConciergeDone: (cb: (e: { id: string; sessionId: string; text: string }) => void) => {
    h.brain.done = cb;
    return () => {};
  },
  onConciergeError: (cb: (e: { id: string; detail: string }) => void) => {
    h.brain.error = cb;
    return () => {};
  },
}));
// Mirror EVERY export: Vitest throws on access to a missing mock export, so a partial factory
// breaks the moment anything else in the tree imports the other symbol.
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  onDeferredSendOutcome: () => () => {},
}));
// The user no longer PICKS a destination — the host routes (PRD/sparkle/concierge-auto-routing).
// A knob here: what these rows care about is whether the reply is spoken, which turns on which
// destination a send reached, not on how that decision was reached.
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.route }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: vi.fn() }) },
}));
vi.mock("../useConciergeDictation", () => ({ useConciergeDictation: () => h.dictation }));
vi.mock("../services/conciergeVoice", () => ({
  speakConciergeReply: h.speakConciergeReply,
  speakOnDemand: h.speakOnDemand,
  stopConciergeVoice: h.stopConciergeVoice,
  shouldSpeakConciergeReply: h.shouldSpeakConciergeReply,
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: h.maybePauseOnSubmit }));

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";

const calmFeed = {
  projects: [],
  counts: { needs_you: 0, running: 0, done: 0 },
  scopedCounts: { needs_you: 0, running: 0, done: 0 },
  pinnedProjectId: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.dictation.micLive = false;
  h.dictation.interim = "";
});

/** A feed carrying ONE agent, so the send-target toggle has something to pin. */
const feedWithAgent = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: { needs_you: 0, running: 0, done: 0 },
      agents: [
        {
          id: "ag1",
          name: "CI Hardening",
          projectId: "p1",
          projectName: "sparkle",
          kind: "build" as const,
          status: "working",
          statusColor: "#8fb08a",
          statusLabel: "Working",
          band: "done" as const,
          inScope: true,
          muted: false,
        },
      ],
    },
  ],
  counts: { needs_you: 0, running: 0, done: 0 },
  scopedCounts: { needs_you: 0, running: 0, done: 0 },
  pinnedProjectId: null,
};
const AIM = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

function mount(opts: { aimable?: boolean } = {}) {
  const feed = opts.aimable ? feedWithAgent : calmFeed;
  render(
    <ConciergeHost
      feed={feed as ConciergeFeed}
      promptTarget={opts.aimable ? AIM : null}
    />,
  );
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  return {
    box,
    type: (text: string) => fireEvent.change(box(), { target: { value: text } }),
    // Routing is async now and every delivery chains behind the previous one, so a send settles
    // over several microtasks rather than in the click's own tick.
    send: async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    /** Point the router at the AGENT: the next send goes to its terminal, not the brain. This is
     *  the routed replacement for flipping the removed send-target toggle. */
    aim: () => h.route.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" }),
    /** …and back: the next send is answered in chat. */
    unaim: () =>
      h.route.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" }),
    // The wrapped append the host handed down to the compose box.
    dictate: (segment: string) => {
      const calls = h.dictation.registerInsert.mock.calls as [Append | null][];
      const append = calls.map(([fn]) => fn).filter((fn): fn is Append => fn != null).at(-1);
      if (!append) throw new Error("host never registered an insert target");
      act(() => append(segment));
    },
    reply: (text: string) =>
      act(() => {
        h.brain.done?.({ id: "t1", sessionId: "s1", text });
      }),
  };
}

/** Queries scoped to the VISIBLE transcript. The column also renders a hidden `role="status"` live
 *  region carrying the last finished line (roborev 53010), so a document-wide getByText would match
 *  the same string twice — and would pass even if the visible thread stopped rendering it. */
const thread = () => screen.getByTestId("concierge-thread");
const inThread = (re: RegExp | string) => within(thread()).getByText(re);
const findInThread = (re: RegExp | string) => within(thread()).findByText(re);

describe("ConciergeHost — spoken replies", () => {
  it("a TYPED turn is never spoken", async () => {
    const c = mount();
    c.type("approve the deploy");
    await c.send();
    c.reply("Approved.");
    expect(h.speakConciergeReply).not.toHaveBeenCalled();
  });

  it("a DICTATED turn is spoken back, even though the mic went quiet before Send", async () => {
    const c = mount();
    c.dictate("approve the deploy"); // the stop word then drops the mic; micLive stays false
    await c.send();
    c.reply("Approved.");
    expect(h.speakConciergeReply).toHaveBeenCalledWith("Approved.", { voiceTurn: true });
  });

  it("a turn sent while the mic is still live is spoken back too", async () => {
    h.dictation.micLive = true;
    const c = mount();
    c.type("approve the deploy");
    await c.send();
    c.reply("Approved.");
    expect(h.speakConciergeReply).toHaveBeenCalledWith("Approved.", { voiceTurn: true });
  });

  // roborev 46922: the latch was set by dictated content arriving and cleared only on send, so
  // content that LEFT the box without being sent kept it armed — the exact inverse of the bug the
  // latch exists to fix, and Concierge v1's rule is that typing must never make the app speak.
  it("emptying the box by hand retires the dictated-origin latch", async () => {
    const c = mount();
    c.dictate("scratch that");
    c.type(""); // select-all + delete
    c.type("a completely typed message");
    await c.send();
    c.reply("Done.");
    expect(h.speakConciergeReply).not.toHaveBeenCalled();
  });

  it("editing dictated text without clearing it keeps the turn a VOICE turn", async () => {
    // Only an EMPTY box retires the latch — fixing a transcription typo must not silence the reply.
    const c = mount();
    c.dictate("approve the deply");
    c.type("approve the deploy");
    await c.send();
    c.reply("Approved.");
    expect(h.speakConciergeReply).toHaveBeenCalledWith("Approved.", { voiceTurn: true });
  });

  it("the voice origin does not leak into the NEXT turn", async () => {
    const c = mount();
    c.dictate("approve the deploy");
    await c.send();
    c.reply("Approved.");
    h.speakConciergeReply.mockClear();

    c.type("and now this one");
    await c.send();
    c.reply("Done.");
    expect(h.speakConciergeReply).not.toHaveBeenCalled();
  });

  it("speaks the WHOLE streamed reply, not just the final chunk", async () => {
    const c = mount();
    c.dictate("status?");
    await c.send();
    act(() => {
      h.brain.delta?.({ id: "t1", text: "All " });
      h.brain.delta?.({ id: "t1", text: "calm." });
    });
    act(() => {
      h.brain.done?.({ id: "t1", sessionId: "s1", text: "" });
    });
    expect(h.speakConciergeReply).toHaveBeenCalledWith("All calm.", { voiceTurn: true });
  });

  it("a suppressed autoplay never reaches the TTS service", async () => {
    h.shouldSpeakConciergeReply.mockReturnValueOnce(false);
    const c = mount();
    c.dictate("status?");
    await c.send();
    c.reply("All calm.");
    expect(h.speakConciergeReply).not.toHaveBeenCalled();
  });

  // roborev 48172/48171: the ONE thing the CM-U9 merge had to hand-reconcile — the voice origin is
  // read before anything clears, then DISCARDED on the agent branch and applied only on the brain
  // branch — had no test at all. Every other case in this file goes down the brain path.
  it("a DICTATED prompt aimed at an agent speaks nothing", async () => {
    const c = mount({ aimable: true });
    c.aim();
    c.dictate("rebase onto main");
    await c.send();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalled();
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(h.speakConciergeReply).not.toHaveBeenCalled();
  });

  it("…and does not leave the flag set for the NEXT brain turn", async () => {
    const c = mount({ aimable: true });
    c.aim();
    c.dictate("rebase onto main");
    await c.send();
    c.unaim(); // back to Sparkle
    c.type("and what about the docs?");
    await c.send();
    c.reply("They're fine.");
    expect(h.speakConciergeReply).not.toHaveBeenCalled();
  });

  it("a FAILED agent send hands the voice origin back with the draft (roborev 48172)", async () => {
    // The box restores the draft on a failed send; a restored dictated draft that reads as typed
    // would silently never be spoken once the user re-aims it at Sparkle.
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    const c = mount({ aimable: true });
    c.aim();
    c.dictate("rebase onto main");
    await c.send();
    c.unaim(); // back to Sparkle, with the restored draft still in the box
    await c.send();
    c.reply("Rebasing.");
    expect(h.speakConciergeReply).toHaveBeenCalledWith("Rebasing.", { voiceTurn: true });
  });

  // The turn-token guard (roborev 53004). Every OTHER case in this file uses the id "t1", which is
  // not a token — it takes the "not a number → always surface" escape hatch, so the numeric branch
  // was dead in tests while being the thing that decides which reply is spoken.
  describe("turn tokens (a superseded turn keeps talking — concierge.rs only gates the reap)", () => {
    const delta = (id: string, text: string) => act(() => h.brain.delta?.({ id, text }));
    const done = (id: string, text: string) =>
      act(() => h.brain.done?.({ id, sessionId: "s1", text }));

    it("a straggler from the OLD turn can't corrupt the new turn's spoken reply", async () => {
      const c = mount();
      c.dictate("first question");
      await c.send();
      delta("7", "part of the OLD answer");
      // The user asks again: the backend kills turn 7 and spawns turn 8.
      c.dictate("second question");
      await c.send();
      delta("7", " …and more of it"); // turn 7's reader flushing its buffer, post-kill
      delta("8", "The new answer.");
      done("8", "");
      expect(h.speakConciergeReply).toHaveBeenCalledWith("The new answer.", { voiceTurn: true });
    });

    it("a DONE from the retired turn neither speaks nor steals the new turn's voice flag", async () => {
      const c = mount();
      c.dictate("first question");
      await c.send();
      delta("7", "the old answer");
      c.dictate("second question");
      await c.send();
      done("7", "the old answer, finished"); // races the new send
      expect(h.speakConciergeReply).not.toHaveBeenCalled();

      delta("8", "The new answer.");
      done("8", "");
      expect(h.speakConciergeReply).toHaveBeenCalledWith("The new answer.", { voiceTurn: true });
    });

    it("an ERROR from the retired turn posts no bubble", async () => {
      const c = mount();
      c.type("first question");
      await c.send();
      delta("7", "partial");
      c.type("second question");
      await c.send();
      act(() => h.brain.error?.({ id: "7", detail: "killed" }));
      expect(within(thread()).queryByText(/couldn't reach my brain/i)).toBeNull();
    });

    it("a turn killed BEFORE it said anything can't strand a bubble — once the token lands", async () => {
      // The floor ("retire everything I have SEEN") cannot cover this: turn 8 is spawned and killed
      // without emitting, so the frontend has only ever seen turn 7. Its stragglers carry an id
      // NEWER than anything seen. The returned token retires them — AFTER it arrives (roborev
      // 53051); the case below is the same race with the ordering production actually delivers.
      const c = mount();
      c.type("first");
      await c.send();
      delta("7", "the first answer");
      h.startConciergeTurn.mockResolvedValueOnce("9");
      c.type("second");
      await c.send();
      await act(async () => {}); // the token lands
      delta("8", "the dead turn's buffered output");
      expect(within(thread()).queryByText(/dead turn/)).toBeNull();
    });

    it("…and once the token lands, a dead turn stays shut out", async () => {
      // The ordering production delivers (roborev 53088/53105): a killed child's buffered deltas
      // are emitted BEFORE concierge_turn returns the new token, and Tauri gives no ordering
      // guarantee between the event channel and an invoke response — so the frontend alone cannot
      // win this race. That is why the gate lives in concierge.rs (`drain_stream`, which stops
      // emitting the moment the user sends). This case pins the one guarantee THIS layer owes:
      // once the token has landed, nothing further from the retired turn gets through.
      //
      // Deliberately does NOT assert what happens to a straggler that beats the token: that is a
      // property of the backend gate, and pinning today's residue here would make a future
      // frontend hardening read as a regression (roborev 53105).
      const c = mount();
      c.type("first");
      await c.send();
      delta("7", "the first answer");

      let settle!: (id: string | null) => void;
      h.startConciergeTurn.mockImplementationOnce(
        () => new Promise<string | null>((res) => { settle = res; }),
      );
      c.type("second");
      await c.send();
      await act(async () => {
        settle("9"); // the send that spawned turn 9 — registered AFTER the first send consumed none
      });

      delta("8", "the dead turn's buffered output");
      expect(within(thread()).queryByText(/dead turn/)).toBeNull();
    });

    it("a LOCAL error id (not a token) always surfaces", async () => {
      const c = mount();
      c.type("anything");
      await c.send();
      act(() => h.brain.error?.({ id: "local", detail: "invoke rejected" }));
      expect(await findInThread(/couldn't reach my brain/i)).toBeTruthy();
    });
  });

  it("sending stops whatever Sparkle was already saying", async () => {
    const c = mount();
    c.type("stop talking");
    await c.send();
    expect(h.stopConciergeVoice).toHaveBeenCalled();
  });
});

describe("ConciergeHost — speak on demand", () => {
  it("the speaker button reads a reply aloud", async () => {
    const c = mount();
    c.type("status?");
    await c.send();
    c.reply("All calm.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speak this reply" }));
    });
    expect(h.speakOnDemand).toHaveBeenCalledWith("All calm.");
  });

  it("clicking the speaker of the clip that is playing stops it instead of restarting", async () => {
    // A speak that never resolves keeps the reply in the "playing" state for the second click.
    h.speakOnDemand.mockImplementationOnce(() => new Promise(() => {}));
    const c = mount();
    c.type("status?");
    await c.send();
    c.reply("All calm.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Speak this reply" }));
    });
    h.stopConciergeVoice.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
    expect(h.stopConciergeVoice).toHaveBeenCalledTimes(1);
    expect(h.speakOnDemand).toHaveBeenCalledTimes(1);
  });
});

describe("ConciergeHost — mic", () => {
  it("the compose mic drives the real dictation toggle", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Talk to Sparkle" }));
    expect(h.dictation.toggleMic).toHaveBeenCalledTimes(1);
  });

  it("a live mic buzzes the wordmark and paints the live transcript", async () => {
    h.dictation.micLive = true;
    h.dictation.interim = "approve the dep";
    mount();
    expect(screen.getByTestId("concierge-interim").textContent).toBe("approve the dep");
    expect(
      screen.getByRole("button", { name: "Talk to Sparkle" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
