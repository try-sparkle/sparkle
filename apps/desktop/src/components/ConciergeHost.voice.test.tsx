// @vitest-environment jsdom
//
// The host wiring for the voice pass (CM-U9) — INPUT ONLY. Voice output was removed whole
// (PRD/feat/ui-refresh-2026-07-27 §5): the mic, dictation and the wake-word flow stay, and nothing
// in this app speaks. What is left here is the mic seam plus the turn-token guard, which used to be
// observed through "which reply gets spoken" and is now observed through the thread itself.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  // `micLive` is still part of the hook's contract (the host reads it to buzz the wordmark), but
  // there is no longer a toggleMic: the box's mic button is gone, so nothing here can turn the mic
  // on. Arming happens at the header ring, and the hook claims dictation off store state.
  dictation: {
    interim: "",
    micLive: false,
    registerInsert: vi.fn(),
  },
  maybePauseOnSubmit: vi.fn(),
  route: vi.fn(async () => ({ target: "sparkle" as "sparkle" | "agent", reason: "test", source: "heuristic" as const })),
}));

// The host reaches for openProjectTab (a nudge's "Show me"), not useConciergeFeed — the feed has
// been a PROP since CM-U7, so a useConciergeFeed mock here would be dead weight (roborev 48171).
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
// Mirror EVERY export the tree touches: Vitest throws on access to a missing mock export, and the
// host's error handler now calls `isSupersededDetail` (roborev 53460/53462). Pulled from the REAL
// module rather than stubbed, so this file can't disagree with the sentinels Rust emits.
vi.mock("../services/concierge", async (importOriginal) => ({
  isSupersededDetail: (await importOriginal<typeof import("../services/concierge")>())
    .isSupersededDetail,
  startConciergeTurn: h.startConciergeTurn,
  // The proactive push channel the host mounts. Stubbed as "stood down" so no case here spends an
  // unasked-for turn; its wiring is covered in ConciergeHost.proactive.test.tsx.
  startProactiveConciergeTurn: vi.fn(async (): Promise<string | null> => null),
  isProactiveTurn: () => false,
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
  onConciergeTurnsAbandoned: () => () => {},
}));
// Mirror EVERY export: Vitest throws on access to a missing mock export, so a partial factory
// breaks the moment anything else in the tree imports the other symbol.
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  agentCanAcceptPrompt: vi.fn(() => true),
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  // Not exercised in these rows (no picker on screen), but the host imports it — and Vitest
  // throws on ACCESS to an export a factory omits, so a partial mock breaks the whole file.
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
// The user no longer PICKS a destination — the host routes (PRD/sparkle/concierge-auto-routing).
// A knob here: these rows care about which destination a send reached, not how that decision was
// reached.
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.route }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: vi.fn() }) },
}));
vi.mock("../useConciergeDictation", () => ({ useConciergeDictation: () => h.dictation }));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: h.maybePauseOnSubmit }));

import { ConciergeHost } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { armedIntents, clearAllIntents, fireIntent } from "../services/dispatchIntent";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useUiStore } from "../stores/uiStore";
import { useDictationStore } from "../stores/dictationStore";

// PRECONDITION, stated rather than inherited: this suite's subject is the concierge CONVERSATION,
// and the column locks that half — thread and composer both — whenever the AI gate is shut
// (Concierge/conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`), which is
// locked. The locked state has its own suite: Concierge/ConciergeColumn.locked.test.
beforeEach(enableAiEnhancementsForTests);

const calmFeed = {
  projects: [],
  counts: { needs_you: 0, running: 0, done: 0 },
  scopedCounts: { needs_you: 0, running: 0, done: 0 },
  pinnedProjectId: null,
};

/**
 * Let every armed send's countdown run out.
 *
 * An agent-bound send now ARMS an intent (services/dispatchIntent) that the user can cancel, and
 * only the uncancelled expiry delivers — so a suite asserting on delivery has to pass through the
 * gate. Fired directly rather than by advancing timers, so this suite keeps real timers.
 */
async function elapseCountdowns() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    // Generously many: the expiry re-enters the send QUEUE and the delivery it runs is several
    // awaits deep (promptAgent → dispatchConciergeAnswer → the outcome ladder), so too few ticks
    // here shows up as a delivery that "did not happen" rather than as a timing failure.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  // See ConciergeHost.test.tsx: a module-level armed intent would leak into the next test.
  clearAllIntents();
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
      scopedCounts: { needs_you: 0, running: 0, done: 0 },
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
          topLevel: true,
          // Nothing above it in the tree, so no ancestor row can be speaking for it.
          representedElsewhere: false,
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
      await elapseCountdowns();
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
const findInThread = (re: RegExp | string) => within(thread()).findByText(re);
const inThread = (re: RegExp | string) => within(thread()).getByText(re);

// The turn-token guard (roborev 53004). Ids like "t1" are not tokens — they take the "not a number
// → always surface" escape hatch, so the numeric branch would be dead in tests while being the
// thing that decides which reply the thread ends up showing.
//
// These rows USED to observe the guard through "which reply gets spoken". With voice output gone
// they observe it through the thread's own text, which is the same guard from the other side:
// a straggler that must not corrupt the live turn's reply must also not corrupt its bubble.
describe("ConciergeHost — turn tokens (a superseded turn keeps talking — concierge.rs gates the reap)", () => {
  const delta = (id: string, text: string) => act(() => h.brain.delta?.({ id, text }));
  const done = (id: string, text: string) =>
    act(() => h.brain.done?.({ id, sessionId: "s1", text }));

  it("a straggler from the OLD turn can't corrupt the new turn's reply", async () => {
    const c = mount();
    c.type("first question");
    await c.send();
    delta("7", "part of the OLD answer");
    // The user asks again: the backend kills turn 7 and spawns turn 8.
    c.type("second question");
    await c.send();
    delta("7", " …and more of it"); // turn 7's reader flushing its buffer, post-kill
    delta("8", "The new answer.");
    done("8", "");
    expect(inThread("The new answer.")).toBeTruthy();
    expect(within(thread()).queryByText(/and more of it/)).toBeNull();
  });

  it("a DONE from the retired turn adds nothing and leaves the new turn intact", async () => {
    const c = mount();
    c.type("first question");
    await c.send();
    delta("7", "the old answer");
    c.type("second question");
    await c.send();
    done("7", "the old answer, finished"); // races the new send
    expect(within(thread()).queryByText(/finished/)).toBeNull();

    delta("8", "The new answer.");
    done("8", "");
    expect(inThread("The new answer.")).toBeTruthy();
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

// Voice INPUT reaches the brain exactly as typed text does. This is the one row that pins the
// dictation seam end to end — the host wraps the compose box's insert target and hands it to
// useConciergeDictation, and a break there silently costs the mic its destination.
describe("ConciergeHost — dictated input", () => {
  it("a DICTATED turn reaches the brain like any other", async () => {
    const c = mount();
    c.dictate("approve the deploy"); // the stop word then drops the mic; micLive stays false
    await c.send();
    expect(h.startConciergeTurn).toHaveBeenCalledWith(expect.stringContaining("approve the deploy"));
    c.reply("Approved.");
    expect(inThread("Approved.")).toBeTruthy();
  });

  it("a DICTATED prompt aimed at an agent goes to its terminal, not the brain", async () => {
    const c = mount({ aimable: true });
    c.aim();
    c.dictate("rebase onto main");
    await c.send();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalled();
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  it("submitting honors the pause-on-submit voice setting", async () => {
    const c = mount();
    c.dictate("status?");
    await c.send();
    expect(h.maybePauseOnSubmit).toHaveBeenCalled();
  });

  it("an AUTO-send does NOT pause the mic — that would end the hands-free loop it exists for", async () => {
    // The guard is one word (`if (!autoFiringRef.current) maybePauseOnSubmit()`), and without a row
    // here deleting it leaves the whole suite green: the case above passes either way, because a
    // MANUAL press pauses in both versions. What breaks silently is the flagship path — the rail
    // fires, the mic pauses itself, and the next sentence goes nowhere because nothing is listening.
    // "Auto-send" that stops listening after one message is not hands-free.
    vi.useFakeTimers();
    try {
      useUiStore.setState({ conciergeSendMode: "speak" });
      useDictationStore.setState({ speechEndSeq: 0 });
      h.dictation.micLive = true;
      const c = mount();
      c.dictate("Deploy the staging branch."); // a finished sentence → `high` → a 1s threshold
      act(() => {
        useDictationStore.getState().noteSpeechEnd();
      });
      await act(async () => {
        vi.advanceTimersByTime(1_500);
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });

      // It really did send — otherwise "did not pause" would pass for the wrong reason.
      expect(h.startConciergeTurn).toHaveBeenCalled();
      expect(h.maybePauseOnSubmit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      useUiStore.setState({ conciergeSendMode: "send" });
      useDictationStore.setState({ speechEndSeq: 0 });
    }
  });
});

describe("ConciergeHost — mic", () => {
  it("the compose row has no mic of its own to drive", () => {
    // There used to be one here, beside Send, and it was the ONLY thing that claimed the app-wide
    // dictation target — which is why arming from the header ring transcribed into an agent pane
    // instead of this box. The claim moved into useConciergeDictation (state-derived, so the wake
    // word works too) and the button went away with it.
    mount();
    expect(screen.queryByRole("button", { name: "Talk to Sparkle" })).toBeNull();
    expect(document.querySelector('[data-hint="composer-mic"]')).toBeNull();
  });

  it("a live mic still paints the live transcript into the box", async () => {
    h.dictation.micLive = true;
    h.dictation.interim = "approve the dep";
    mount();
    expect(screen.getByTestId("concierge-interim").textContent).toBe("approve the dep");
  });
});
