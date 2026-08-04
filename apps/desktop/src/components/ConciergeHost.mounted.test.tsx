// @vitest-environment jsdom
//
// THE MOUNTED COMPOSER ROUTES INTO THE MOUNTED AGENT'S TERMINAL — the host's half.
//
// The founder: *"when the concierge is mounted to a build agent, what I type goes to THAT AGENT'S
// TERMINAL — unless I @-mention Sparkle, in which case it goes to the concierge instead."*
//
// The RULE is pinned as data in Concierge/composerRoute.test.ts. What is pinned HERE is everything a
// pure test cannot see, and it is the half that matters most, because this is the path where the
// founder's typing becomes bytes on a live command line:
//
//   • a mounted send actually reaches `dispatchConciergeAnswer`, at the mounted agent, through the
//     same armed-and-cancellable countdown every other routed send passes through;
//   • `@Sparkle` pulls it back out again, deterministically, without spending a router call;
//   • `@Other` overrules the mount for that one message and the mount does not follow it;
//   • the SCREEN GUARDS shipped for dictation apply here too — a full-screen app, a credential
//     prompt, or a screen that cannot be read all refuse, and the words come back to the composer
//     rather than vanishing;
//   • and the refusal is asked AGAIN after the countdown, because that is the instant the write
//     actually happens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(
    async (_agentId: string, _text: string, _opts?: unknown) => ({ ok: true, path: "free-text" }),
  ),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  agentCanAcceptInput: vi.fn((_agentId: string) => true),
  answersLivePicker: vi.fn((_agentId: string, _text: string) => false),
  /** The rendered screen each agent's terminal is showing. `null` = the terminal is not mounted, or
   *  its screen could not be read — which is exactly the state the guard treats as unreadable. */
  viewport: vi.fn((_agentId: string) => CLEAN as null | { text: string; alternateBuffer: boolean }),
  /** Which side the cable is patched to. "off" = the concierge floats free (unmounted). */
  wired: vi.fn(() => "left" as "off" | "left" | "right"),
}));

/** A terminal sitting at an ordinary Claude Code prompt — nothing that blocks a write. */
const CLEAN = { text: "> \n", alternateBuffer: false };

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: (id: string) => h.agentCanAcceptInput(id),
  agentCanAcceptPrompt: (id: string) => h.agentCanAcceptInput(id),
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: (id: string, t: string) => h.answersLivePicker(id, t),
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
// THE MOUNT, as one knob. `useEffectiveWired` is the host's only reader of the cable, and driving it
// directly keeps this suite about ROUTING rather than about the cockpit's selection plumbing (whose
// own rules are pinned in engine/cable.test.ts and hooks/useEffectiveWired's tests).
vi.mock("../hooks/useEffectiveWired", () => ({
  useEffectiveWired: () => h.wired(),
  usePairIsLive: () => false,
}));
// THE SCREEN, as another. The guard reads the VIEWPORT registry — never the scrollback, which
// latches on the session's first `(y/n)` and would refuse forever after it.
vi.mock("../services/terminalViewport", () => ({
  getAgentViewport: (id: string) => h.viewport(id),
  registerViewport: () => () => {},
  resetViewportRegistry: () => {},
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: {
    getState: () => ({ setInterruptPreference: vi.fn(), shouldInterrupt: () => true }),
  },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
}));

const RUNTIME = {
  status: { ag1: "idle", ag2: "idle" },
  workflowShipped: {},
  workflowStage: {},
  workflowState: {},
  branchStatus: {},
};
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign((sel: (s: typeof RUNTIME) => unknown) => sel(RUNTIME), {
    getState: () => RUNTIME,
  }),
}));

import { ConciergeHost, type ConciergePromptTarget } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import { armedIntents, cancelIntent, fireIntent } from "../services/dispatchIntent";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useProjectStore } from "../stores/projectStore";
import { MOUNTED_THREAD_TESTID } from "./Concierge/MountedAgentThread";
import { MOUNTED_NOTICE_TESTID } from "./Concierge/MountedNotice";
import { CONCIERGE_THREAD_TESTID } from "../engine/composeBoxHeight";

function agent(id: string, name: string) {
  return {
    id,
    name,
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "idle",
    statusColor: "#e0533f",
    statusLabel: "Idle",
    band: "done" as const,
    inScope: true,
    muted: false,
    topLevel: true,
  };
}
const COUNTS = { needs_you: 0, running: 0, done: 2 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [agent("ag1", "Blueprint UI/UX"), agent("ag2", "Kraken Auth")],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** THE MOUNTED AGENT. `mountedAgentId` is derived from the cable plus this target, so patching the
 *  cable (above) and seating this agent is what "the concierge is mounted to Blueprint UI/UX" means. */
const MOUNTED: ConciergePromptTarget = { projectId: "p1", agentId: "ag1", name: "Blueprint UI/UX" };

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
/** The MOUNTED column's notice row — the one surface that survives the thread swap. Everything the
 *  founder is TOLD while mounted has to be reachable from here, because `ConciergeThread` is not
 *  rendered at all in this state (roborev 57360). */
const notice = () => screen.getByTestId(MOUNTED_NOTICE_TESTID);

/**
 * ══ THE SUITE MUST ACTUALLY ENTER THE MOUNTED STATE (roborev 57360) ═════════════════════════════
 *
 * `mountedAgent` needs BOTH a patched cable and a row for that agent in `projectStore` — the host
 * looks the row up to get the worktree path its transcript is keyed by. The first cut of this file
 * mocked only the cable, so `mountedRow` missed, `mountedAgent` stayed null, and the UNMOUNTED column
 * rendered throughout. Every assertion about what the founder SEES while mounted was therefore
 * evidence about the unmounted rendering — and that is exactly what let the hidden-thread defect
 * through: `getByTestId("concierge-thread")` resolved only because the swap never happened.
 *
 * Seeding the real store is deliberate over mocking the module: the lookup is a `flatMap` across
 * projects, and a mock would let the shape drift from what the host actually reads.
 */
function seedMountedRow() {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/sparkle",
        agents: [
          { id: "ag1", name: "Blueprint UI/UX", worktreePath: "/tmp/wt/ag1" },
          { id: "ag2", name: "Kraken Auth", worktreePath: "/tmp/wt/ag2" },
        ],
      },
      // A PARTIAL row on purpose: the host reads exactly `id`, `name` and `worktreePath` off it, and
      // spelling out every field of a real `Project` here would be a second, drifting definition of
      // one that already exists.
    ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
  });
}

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  h.dispatchConciergeAnswer.mockReset();
  h.dispatchConciergeAnswer.mockResolvedValue({ ok: true, path: "free-text" });
  h.startConciergeTurn.mockReset();
  h.startConciergeTurn.mockResolvedValue(null);
  h.routeMessage.mockReset();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.agentCanAcceptInput.mockReset();
  h.agentCanAcceptInput.mockReturnValue(true);
  h.answersLivePicker.mockReset();
  h.answersLivePicker.mockReturnValue(false);
  h.viewport.mockReset();
  h.viewport.mockReturnValue(CLEAN);
  h.wired.mockReset();
  h.wired.mockReturnValue("left");
  seedMountedRow();
});
afterEach(() => {
  for (const i of armedIntents()) cancelIntent(i.id);
  cleanup();
  vi.clearAllMocks();
  // The store is a module singleton shared across cases — leaving rows behind would silently mount a
  // later suite's host against this one's fleet.
  useProjectStore.setState({ projects: [] });
});

async function send(text: string) {
  const ta = box();
  fireEvent.change(ta, {
    target: { value: text, selectionStart: text.length, selectionEnd: text.length },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

/** Let every armed countdown elapse — the gate a mounted send still passes through. */
async function elapse() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function mount() {
  return render(<ConciergeHost feed={FEED} promptTarget={MOUNTED} />);
}

// ══ THE PRECONDITION EVERY OTHER ROW RESTS ON ═══════════════════════════════════════════════════
// Asserted FIRST and on its own, because the first cut of this suite silently failed it: the column
// never entered the mounted state, so every "what the founder sees" assertion below was reading the
// unmounted rendering (roborev 57360). If this row fails, nothing under it means what its name says.
describe("ConciergeHost — the suite is actually in the mounted state", () => {
  it("renders the agent's transcript and NOT the concierge thread", () => {
    mount();
    expect(screen.getByTestId(MOUNTED_THREAD_TESTID)).toBeTruthy();
    // THE DISCRIMINATOR. A build that fails to mount renders `concierge-thread` — which is precisely
    // what made the hidden-thread defect invisible — so its ABSENCE is the assertion that matters.
    expect(screen.queryByTestId("concierge-thread")).toBeNull();
  });

  it("renders the concierge thread again with the cable unplugged", () => {
    h.wired.mockReturnValue("off");
    mount();
    expect(screen.getByTestId("concierge-thread")).toBeTruthy();
    expect(screen.queryByTestId(MOUNTED_THREAD_TESTID)).toBeNull();
  });
});

describe("ConciergeHost — while MOUNTED, what you type goes to that agent's terminal", () => {
  // THE HEADLINE. Before this rule, an unaddressed message could not reach an agent by ANY path —
  // `routeMessage` never returns `target: "agent"` — so this row is red against the whole prior
  // build, mount or no mount.
  it("dispatches plain text to the mounted agent", async () => {
    mount();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag1");
    expect(h.dispatchConciergeAnswer.mock.calls[0]![1]).toBe("move the button 5px left");
  });

  // THE CONTROL for the row above, and the thing that keeps it from passing against "everything goes
  // to a terminal now". Same text, cable unplugged, and it reaches the concierge instead.
  it("sends the same words to the concierge when nothing is mounted", async () => {
    h.wired.mockReturnValue("off");
    mount();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // Explicitness — or a mount — buys a skipped CLASSIFY, never a skipped GATE. A mounted send is
  // still armed, visible in the banner, and cancellable; only an expiry the founder did not stop
  // dispatches.
  it("arms a cancellable countdown rather than dispatching outright", async () => {
    mount();
    await send("move the button 5px left");
    expect(armedIntents()).toHaveLength(1);
    expect(armedIntents()[0]!.targetName).toBe("Blueprint UI/UX");
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("delivers nothing when that countdown is cancelled", async () => {
    mount();
    await send("move the button 5px left");
    await act(async () => {
      cancelIntent(armedIntents()[0]!.id);
      await Promise.resolve();
    });
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("dispatches through the countdown authority, like every other routed send", async () => {
    mount();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![2]).toMatchObject({
      userPrompt: true,
      authority: { kind: "countdown" },
    });
  });

  // A destination the founder chose with a cable is not a guess, so there is nothing to ask a model
  // about — and nothing to bill for.
  it("does not spend a router call on a mounted send", async () => {
    mount();
    await send("move the button 5px left");
    await elapse();
    expect(h.routeMessage).not.toHaveBeenCalled();
  });

  // ══ NO UNBIDDEN BRAIN TURN PER LINE ═══════════════════════════════════════════════════════════
  // An ADDRESSED message is relayed THROUGH the concierge, so it follows up ("the concierge stays in
  // the conversation" — the founder's headline requirement for mentions). A MOUNTED message is the
  // founder talking straight to the agent, and a paragraph of commentary plus a metered turn after
  // every line of that conversation is a tax on typing. The pair is the discriminator: the follow-up
  // machinery is proven alive by the second half, so the first is not passing on a dead feature.
  it("does not follow a mounted send with a concierge turn, though an addressed one still does", async () => {
    mount();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.startConciergeTurn).not.toHaveBeenCalled();

    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(h.startConciergeTurn).toHaveBeenCalledTimes(1));
  });

  // The `@` may never reach the wire even when the mention is only the SUBJECT of the sentence: the
  // agent on the far end is a Claude Code CLI, where a leading `@` opens its file-reference
  // autocomplete and strands the instruction behind a picker nobody asked for. The name stays,
  // because the founder wrote it and the instruction depends on it.
  it("strips a subject mention's sigil, and keeps its name, on the way to the terminal", async () => {
    mount();
    await send("check what @Kraken Auth did before you land this");
    await elapse();
    const wire = h.dispatchConciergeAnswer.mock.calls[0]![1] as string;
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag1");
    expect(wire).toBe("check what Kraken Auth did before you land this");
    expect(wire).not.toContain("@");
  });
});

describe("ConciergeHost — @Sparkle is the way out of a mount", () => {
  // THE ESCAPE HATCH. Without this there is no way to reach the concierge at all while patched to an
  // agent: every word typed into that box would go to a PTY.
  it("routes the message to the concierge instead of the mounted terminal", async () => {
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  it("does not spend a router call on a destination the founder stated", async () => {
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.routeMessage).not.toHaveBeenCalled();
  });

  // ══ THE SCREEN GUARD MAY NOT VETO A CONCIERGE-BOUND MESSAGE (bead sparkle-k5kit) ═══════════════
  // The founder's report, verbatim: "@Sparkle has a full-screen app open, so I didn't type that into
  // it — the keys would have run as commands." That sentence cannot be true of the concierge under
  // any circumstance. It is not a PTY. It has no screen, no alternate buffer, and no way for keys to
  // run as commands.
  //
  // THE GUARD IS ABOUT A TERMINAL, so it may only ever be asked about a message bound FOR a terminal.
  // Once the route resolves to the concierge, no screen check of any kind may run — and in particular
  // not one aimed at the MOUNTED agent's screen, which is a different destination entirely. The
  // escape hatch has to work in exactly the state it exists for: patched to an agent that is busy.
  //
  // The three assertions are one invariant seen from three sides — the brain was asked, no terminal
  // was written, and the words were NOT bounced back with a refusal.
  it("reaches the concierge even while the mounted agent is in a full-screen app", async () => {
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(notice().textContent ?? "").not.toContain("full-screen app");
  });

  // ══ NOT EVERY @Sparkle IS A REDIRECT ══════════════════════════════════════════════════════════
  // This app is called Sparkle, so its own name lands in ordinary instructions to an agent. Yanking
  // this message out of the terminal it was written for would silently drop the instruction. The
  // discriminator is position, and the row above is the other half of the pair.
  it("leaves a mid-sentence Sparkle in the message, bound for the terminal", async () => {
    mount();
    await send("land this first and then ask @Sparkle to look at the diff");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag1");
    expect(h.dispatchConciergeAnswer.mock.calls[0]![1]).toBe(
      "land this first and then ask Sparkle to look at the diff",
    );
  });
});

describe("ConciergeHost — an address overrules the mount without moving it", () => {
  it("delivers to the NAMED agent, not to the mounted one", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
  });

  // MENTIONING IS NOT RE-MOUNTING, stated as the founder would notice it: the NEXT message, with no
  // address, goes back to the mounted agent. A build that moved the mount on a mention would send it
  // to ag2 and fail here.
  it("leaves the following unaddressed message on the mount", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    await send("and you keep going on the header");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(2);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
    expect(h.dispatchConciergeAnswer.mock.calls[1]![0]).toBe("ag1");
  });
});

// ══ THE SCREEN GUARDS ═══════════════════════════════════════════════════════════════════════════
//
// `dispatchConciergeAnswer` guards exactly one hazard — a live PICKER — and nothing else about the
// screen. So without these, a mounted send into an agent sitting in `vim` is pasted AND submitted,
// and vim normal mode does not insert a sentence, it EXECUTES it. The guard is the one shipped for
// dictation (`voice/dictationTerminalRoute`), reused rather than rebuilt.
// ══ …BUT A BUSY CLAUDE CODE IS NOT ONE OF THEM (bead sparkle-v7k3y, roborev 57704) ══════════════
// THE END-TO-END ROW. Every other alternate-buffer fixture in this file is `"~\n~\n:"` — a vim
// screen — so none of them can see whether a busy Claude Code still gets bounced. It did: relaxing
// only the caller-side pre-check left `conciergeDispatch`'s own unconditional alternate-buffer
// refusal in place, so the send fell through the loosened check and was refused at the chokepoint
// with the SAME "full-screen app" sentence. Unit tests on the classifier were green throughout.
//
// This asserts the founder's actual outcome: mounted, agent busy in Claude Code, the message REACHES
// the terminal.
describe("ConciergeHost — a busy Claude Code takes the message", () => {
  const BUSY_CLAUDE = [
    "⏺ I'll run the test suite and commit.",
    "  ⎿  $ bash scripts/tests/run.sh (1m 23s)",
    "     (ctrl+b to run in background)",
    "────────────────────────────────────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────────────────",
    "  ⏸ manual mode on · ? for shortcuts",
  ].join("\n");

  it("delivers a mounted send into an agent running a shell command", async () => {
    mount();
    h.viewport.mockReturnValue({ text: BUSY_CLAUDE, alternateBuffer: true });
    await send("give me an update after you do");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag1");
  });

  // `queryByTestId`, not the suite's throwing `notice()` helper: on a delivered send the notice row
  // is not rendered AT ALL, which is the strongest form of "he was not told his message bounced".
  it("says nothing about a full-screen app", async () => {
    mount();
    h.viewport.mockReturnValue({ text: BUSY_CLAUDE, alternateBuffer: true });
    await send("give me an update after you do");
    await elapse();
    expect(screen.queryByTestId(MOUNTED_NOTICE_TESTID)?.textContent ?? "").not.toContain(
      "full-screen app",
    );
  });
});

describe("ConciergeHost — a terminal that must not receive free text refuses", () => {
  it("refuses when a full-screen app owns the terminal, and keeps the words", async () => {
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    // NOTHING WAS EVEN ARMED: refusing before the countdown is what makes the reason arrive while the
    // words are still the last thing the founder typed.
    expect(armedIntents()).toHaveLength(0);
    await waitFor(() => expect(notice().textContent).toContain("full-screen app"));
    // AND THE WORDS ARE BACK. A refusal that silently eats the message is indistinguishable from the
    // send being broken — this is the same "put it in the composer, don't drop it" contract the
    // dictation sink's caller keeps.
    await waitFor(() => expect(box().value).toBe("move the button 5px left"));
  });

  // ══ A REFUSED SEND LEAVES NO BUBBLE (bead sparkle-k5kit part 2) ═══════════════════════════════
  // The founder: *"It's also not clearing what I sent out of the Compose box even though it shows up
  // in the Concierge list."* Both halves are ONE bug. `send` appends the "you" bubble synchronously,
  // before routing; the refusal then puts the words back in the composer — so his paragraph was in
  // two places at once, quoted in the thread as though sent AND sitting in the box as though not.
  // That is how he ends up sending the same thing twice.
  //
  // The words come back (the row above pins that) and the refusal is still SAID — but the record of
  // a send that never happened is gone.
  // UNMOUNTED, and that is not incidental: `ConciergeThread` — where the "you" bubble is rendered —
  // is not mounted at all while the column is patched to an agent (the mounted view shows THAT
  // AGENT's conversation instead). A first cut of this test asserted against MOUNTED_THREAD_TESTID
  // and was VACUOUS: the bubble was never in that subtree to begin with, so it passed with the
  // retraction disabled. This is the state where the founder can actually see the thing he reported.
  it("takes back the thread bubble, since no send happened", async () => {
    h.wired.mockReturnValue("off");
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("@Kraken Auth ship the DMG");
    await elapse();
    // The words are back in the box — the precondition for retracting at all.
    await waitFor(() => expect(box().value).toBe("@Kraken Auth ship the DMG"));
    // AND NOT ALSO QUOTED AS A SENT MESSAGE. `postSparkle`'s refusal line names the agent, so this
    // looks for the BODY the founder typed, which only the "you" bubble would carry.
    expect(screen.getByTestId(CONCIERGE_THREAD_TESTID).textContent ?? "").not.toContain(
      "ship the DMG",
    );
  });

  // ══ AND IT MUST NOT QUIETLY BECOME A CONCIERGE MESSAGE INSTEAD (bead sparkle-sp0wv) ═══════════
  // *"If a refused terminal write falls through to the concierge, the message silently changes
  // destination"* — the one failure mode composerRoute's header calls unrecoverable. He addressed the
  // AGENT; re-aiming his words without telling him is the harm. Retracting the bubble must not open
  // that door either: the words go back to the box and NOWHERE else.
  it("does not reach the concierge instead", async () => {
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("move the button 5px left");
    await elapse();
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("refuses at a credential prompt", async () => {
    mount();
    h.viewport.mockReturnValue({
      text: "$ sudo -v\n[sudo] password for founder:",
      alternateBuffer: false,
    });
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(notice().textContent).toContain("waiting on something on screen"));
  });

  // "I cannot see that screen" and "that screen is at a clean prompt" are different facts, and only
  // the second permits a write. For a MOUNT the terminal is on screen by construction, so an
  // unreadable one means something is actually wrong.
  it("refuses a mounted send when the screen cannot be read at all", async () => {
    mount();
    h.viewport.mockReturnValue(null);
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(notice().textContent).toContain("can't see"));
  });

  // ...but an ADDRESS may legitimately name an agent whose pane is not mounted in this window, and
  // that send has worked since mentions shipped. Refusing it would break a shipped feature to protect
  // a screen nobody is looking at. This row is the asymmetry, and it is the one that fails if someone
  // "tidies" the guard into a single unconditional check.
  it("still delivers an ADDRESSED send to an agent whose screen it cannot read", async () => {
    mount();
    h.viewport.mockReturnValue(null);
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
  });

  // ...and an address is still refused on what the screen POSITIVELY shows. Strictly more protection
  // than the addressed path had, with nothing taken away.
  it("refuses an ADDRESSED send into a full-screen app", async () => {
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // ══ THE INSTANT THAT ACTUALLY MATTERS ═══════════════════════════════════════════════════════════
  // The countdown is exactly long enough to open `vim` in. The submit-time check gives a fast, cheap
  // answer; THIS one is the last thing between the founder's text and `submitPrompt`'s
  // paste-and-carriage-return, so it is the load-bearing one. A build that checks only at submit
  // passes every row above and fails this one.
  it("re-checks the screen after the countdown, not only before it", async () => {
    mount();
    await send("move the button 5px left");
    expect(armedIntents()).toHaveLength(1);
    // vim opened while the banner was counting down.
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(notice().textContent).toContain("full-screen app"));
    await waitFor(() => expect(box().value).toBe("move the button 5px left"));
  });

  // The control for every row in this block: with a clean screen the same message goes through.
  // Without it, "nothing dispatched" would be satisfied by a build that stopped sending altogether.
  it("delivers when the screen is an ordinary prompt", async () => {
    mount();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });

  // ══ THE RECEIPT, ASSERTED WHERE IT IS ACTUALLY RENDERED ═════════════════════════════════════════
  // UNMOUNTED, deliberately. The receipt lives inside `ConciergeThread`, which a mounted column does
  // not render — so asserting it under a mount was asserting a surface that is not on screen (the
  // same mistake that hid this suite's own defect). The refusal path is shared, so the copy is the
  // same fact; this is the state where a human can read it. The mounted state's channel is the
  // notice row, covered in its own block below.
  it("does not claim the message was sent, and offers no redirect into the refusing agent", async () => {
    h.wired.mockReturnValue("off");
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    // ══ THE RECEIPT IS GONE BECAUSE THE BUBBLE IS (bead sparkle-k5kit part 2) ═══════════════════
    // This used to assert a receipt reading "Not sent — Kraken Auth". That was roborev 57360's fix
    // for a receipt that claimed "Answered here" over a send the brain never saw, and it was right
    // about the claim being false — but it left the underlying record in place. A receipt ANNOTATES
    // a "you" bubble, and the founder's complaint is that the bubble should not be there at all: a
    // message shown as sent while its words are back in the composer is how he sends it twice.
    //
    // So the assertion moves UP a level: nothing on screen claims this was sent, because the record
    // of the send has been retracted. Strictly stronger than the old row — a build that restored the
    // "Answered here" receipt fails this too, since any receipt at all fails it.
    await waitFor(() => expect(box().value).toBe("@Kraken Auth ship the DMG"));
    expect(screen.queryByTestId("routing-receipt")).toBeNull();
    // The refusal is still SAID — as a Sparkle-authored line, which is an explanation rather than a
    // record of a send. That is the surface that must survive, and it names the agent.
    const thread = screen.getByTestId(CONCIERGE_THREAD_TESTID).textContent ?? "";
    expect(thread).toContain("full-screen app");
    expect(thread).toContain("Kraken Auth");
    expect(screen.queryByRole("button", { name: /^Also ask / })).toBeNull();
    // ══ AND NO BANNER (roborev 57424) ═════════════════════════════════════════════════════════════
    // The notice row exists ONLY because a mounted column hides its thread. Unmounted, this refusal
    // is already on screen twice — the thread line and the receipt above — so a third copy is noise;
    // and worse, the row clears on a change of MOUNT, which never comes while nothing is mounted, so
    // it would sit over every later successful send for the rest of the session.
    expect(screen.queryByTestId(MOUNTED_NOTICE_TESTID)).toBeNull();
  });
});

// ══ EVERYTHING THE FOUNDER IS TOLD HAS TO SURVIVE THE SWAP (roborev 57360) ═════════════════════
//
// Mounted, `ConciergeThread` is not rendered, so every `postSparkle` line is written off screen.
// These rows read the notice row — the sibling that stays — and each asserts a fact that is FALSE of
// the build that shipped without it.
describe("ConciergeHost — a mounted column can still say what happened", () => {
  it("says nothing at all until something happens", () => {
    mount();
    expect(screen.queryByTestId(MOUNTED_NOTICE_TESTID)).toBeNull();
  });

  // THE ESCAPE HATCH'S ANSWER. `@Sparkle` routes correctly and Sparkle replies — into a thread the
  // mount hides. Without this row the documented way out of a mount produces a real answer and no
  // visible sign of it, which reads exactly like the feature being broken.
  it("points at where the @Sparkle reply went, since the mount hides the thread", async () => {
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(notice().textContent).toContain("Asked Sparkle"));
  });

  // …and NOT while unmounted, where the answer lands in the thread the founder is already reading.
  // Without this the row above passes against a build that narrates every send unconditionally.
  it("stays quiet about a concierge send when nothing is mounted", async () => {
    h.wired.mockReturnValue("off");
    mount();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(MOUNTED_NOTICE_TESTID)).toBeNull();
  });

  it("names the agent that could not take the message", async () => {
    mount();
    h.agentCanAcceptInput.mockReturnValue(false);
    await send("move the button 5px left");
    await elapse();
    await waitFor(() => expect(notice().textContent).toContain("Blueprint UI/UX"));
    expect(notice().textContent).toContain("can't take a message");
  });

  // A REFUSAL REPEATS. The founder retypes and hits the same `vim`, so the second refusal is the
  // common case — and a row keyed on text alone renders it as no change at all. The `seq` bump is
  // what makes an identical repeat a distinct write; this is the row that proves it.
  it("re-renders an identical refusal rather than swallowing the repeat", async () => {
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("move the button 5px left");
    await elapse();
    // NODE IDENTITY, NOT TEXT — the text is identical by construction, which is the whole point. The
    // row is keyed on `seq`, so a genuine second write REPLACES the element; a build that stored the
    // notice as a bare string would have React bail out of the `Object.is`-equal setState and hand
    // back the SAME node, and this is the only assertion that can tell those apart.
    const firstNode = notice();
    await send("move the button 5px left");
    await elapse();
    await waitFor(() => expect(notice()).not.toBe(firstNode));
    expect(notice().textContent).toContain("full-screen app");
  });

  // A NOTICE MUST NOT OUTLIVE THE MOUNT IT DESCRIBES. Left standing after an unmount it asserts a
  // state that is over — the same stale signal the unmount hint is gated against.
  it("clears when the cable is unplugged", async () => {
    const view = mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("move the button 5px left");
    await elapse();
    await waitFor(() => expect(notice().textContent).toContain("full-screen app"));
    h.wired.mockReturnValue("off");
    await act(async () => {
      view.rerender(<ConciergeHost feed={FEED} promptTarget={MOUNTED} />);
      await Promise.resolve();
    });
    expect(screen.queryByTestId(MOUNTED_NOTICE_TESTID)).toBeNull();
  });
});

// ══ ONE NOTION OF "MOUNTED" FOR ROUTING (roborev 57358/57361) ══════════════════════════════════
//
// The cable being patched decides whose CONVERSATION is shown. It does NOT decide where words go —
// the host also requires the agent's pane to be on screen (`promptTargetShown`). Two derivations of
// "mounted" meant the composer could paint itself in the terminal's face while the send path had
// already decided the message must not go to a PTY: an indicator lying in the irreversible direction.
describe("ConciergeHost — the mount that routes is the mount the composer reports", () => {
  const mountHidden = () =>
    render(<ConciergeHost feed={FEED} promptTarget={MOUNTED} promptTargetShown={false} />);

  it("does not route to the terminal when the agent's pane is not shown", async () => {
    mountHidden();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // THE ROW THAT PINS THE AGREEMENT. Same state, the other half: the composer must not claim a
  // terminal destination the send path has refused. A build with two derivations passes the row
  // above and fails this one.
  it("does not paint the composer in the terminal's face in that same state", () => {
    mountHidden();
    const ta = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(ta.style.fontFamily).toBe("inherit");
  });

  // ══ THE THREAD IS STILL HIDDEN HERE, SO THE COLUMN MUST STILL BE ABLE TO SPEAK (roborev 57424) ══
  // `promptTargetShown === false` gates ROUTING and the typeface; it does not un-swap the thread —
  // the column keeps showing the agent's transcript. So a message that falls through to Sparkle in
  // this state is answered into a thread that is not rendered, which is the exact defect the notice
  // row was added to fix. Gating the notice on the ROUTING mount reintroduced it one state over.
  it("still points at the Sparkle reply while the thread is swapped away", async () => {
    mountHidden();
    expect(screen.queryByTestId("concierge-thread")).toBeNull();
    await send("what is the status of the build?");
    await elapse();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId(MOUNTED_NOTICE_TESTID)).toBeTruthy());
  });

  // The control: shown, and both halves agree the other way.
  it("routes AND paints when the pane is shown", async () => {
    mount();
    const ta = screen.getByLabelText("Message") as HTMLTextAreaElement;
    expect(ta.style.fontFamily).not.toBe("inherit");
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });
});
