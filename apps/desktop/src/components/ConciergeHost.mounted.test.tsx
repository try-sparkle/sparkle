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
//   • a mounted send actually reaches `dispatchConciergeAnswer`, at the mounted agent — IMMEDIATELY,
//     with no countdown armed in between, under a `{kind:"mount"}` authority of its own. An
//     ADDRESSED send from the same box still arms the cancellable countdown, and that pair is the
//     discriminator: this is a narrowing, not the removal of the gate;
//   • `@Sparkle` pulls it back out again, deterministically, without spending a router call;
//   • `@Other` overrules the mount for that one message and the mount does not follow it;
//   • the SCREEN GUARDS shipped for dictation apply here too — a full-screen app, a credential
//     prompt, or a screen that cannot be read all refuse, and the words come back to the composer
//     rather than vanishing;
//   • and the refusal is asked AGAIN at the write, on BOTH paths. Not only after a countdown: the
//     send queue is global, so an immediate mounted write can still sit behind an in-flight task
//     long enough for the screen to change under it. Pinned on each path separately.
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
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
  onConciergeTool: () => () => {},
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
// ══ THE APP-OWNED SPARKLE AGENT HAS TO BE RESOLVABLE (beads sparkle-k5kit / sparkle-l6mgg) ══════
// Without this, nothing in this file can test the Improve-Sparkle row at all — and three attempts to
// do so silently measured the fixture instead of the code.
//
// That agent is DELIBERATELY never a member of any project's `agents` array (knownAgents.ts), so it
// cannot be put in `FEED`. `isPromptableTarget` reaches it through a second arm — `findKnownAgent(id)
// ?.source === "sparkle"` — and `agentStillExists` follows the same path. Unmocked, both say "no such
// agent", so a send aimed at it is reduced to "no usable aim" BEFORE any routing decision matters:
// `addressable` is false either way and every assertion passes with the fix reverted.
//
// `importOriginal` rather than a hand-written module: only `findKnownAgent` needs steering, and
// stubbing the rest would silently change `knownAgentLiveness`/`openAgentIdSet` for every other row
// in this file.
vi.mock("../services/knownAgents", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/knownAgents")>();
  return {
    ...real,
    findKnownAgent: (agentId: string) =>
      agentId.startsWith("__sparkle_self__")
        ? { id: agentId, name: "Sparkle", source: "sparkle" as const, runtime: "local" as const }
        : real.findKnownAgent(agentId),
  };
});

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: Object.assign((sel: (s: typeof RUNTIME) => unknown) => sel(RUNTIME), {
    getState: () => RUNTIME,
  }),
  // Both are reached only once a SPARKLE-namespace agent is the selected target — that pane
  // registers itself into the shared open-agent set on mount.
  //
  // `mergeOpenAgentIds` MIRRORS THE REAL ONE rather than returning undefined (roborev 57970). It is
  // not unobserved: `knownAgents.openAgentIdSet()` is `new Set(mergeOpenAgentIds(...))`, and
  // `new Set(undefined)` is a legal EMPTY set — so a bare `vi.fn()` silently gave every caller in
  // this file an empty open-agent set instead of failing loudly, which is exactly the drift the
  // `knownAgents` mock below is written to avoid. Callers that treat the result as an array would
  // also throw a TypeError reading as unrelated to whichever row triggered it.
  mergeOpenAgentIds: vi.fn((inMemory: string[], persisted: string[], add?: string) => [
    ...new Set([...inMemory, ...persisted, ...(add ? [add] : [])]),
  ]),
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { ConciergeHost, type ConciergePromptTarget } from "./ConciergeHost";
import type { ConciergeFeed } from "../useConciergeFeed";
import {
  armedIntents,
  cancelIntent,
  clearAllIntents,
  fireIntent,
  queuedIntents,
} from "../services/dispatchIntent";
// The REAL store, not a mock: the immediate mounted path is gated on it, so a stubbed presence would
// make every row here assert against a value the production gate never reads.
import { IDLE_AWAY_MS, usePresenceStore } from "../stores/presenceStore";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useProjectStore } from "../stores/projectStore";
import { CONCIERGE_CHATTING_WITH_TESTID } from "./Concierge/ConciergeColumn";
import { MOUNTED_THREAD_TESTID } from "./Concierge/MountedAgentThread";
import { MOUNTED_NOTICE_TESTID } from "./Concierge/MountedNotice";
import { CONCIERGE_THREAD_TESTID } from "../engine/composeBoxHeight";
import { SPARKLE_AGENT_ID, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";

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
const COUNTS = { needs_you: 0, questions: 0, running: 0, done: 2 };
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
  // HERE by default, so every row that does not say otherwise exercises the immediate path. Reset
  // per test rather than relied on: the away rows below write this store, and a leaked "away" would
  // silently turn every later mounted row back into a countdown row — which they would still PASS,
  // because `elapse()` is a no-op when nothing is armed and most rows call it.
  usePresenceStore.getState().reset();
  seedMountedRow();
});
afterEach(() => {
  // ══ BOTH REGISTRIES, NOT JUST THE ARMED ONE ═══════════════════════════════════════════════════
  // This used to be `for (const i of armedIntents()) cancelIntent(i.id)`, which cannot see a QUEUED
  // intent — and the away rows below are the first in this file to leave one. A leaked queue entry
  // survives `cleanup()` in the module-scoped registry, and `presentNextQueued` runs at the tail of
  // every later `fireIntent`/`cancelIntent` and re-checks presence per intent. Since `beforeEach`
  // resets presence to Here, the next row that elapses a countdown would RE-ARM the stale intent
  // inside its own test: a banner in a host that never sent it, a fresh timer, and
  // `onRepresent`/`onCancel` firing against the previous test's unmounted host. A row that elapses
  // twice would fire it outright and add a phantom `dispatchConciergeAnswer` call — an
  // order-dependent flake in every `toHaveBeenCalledTimes` assertion downstream.
  //
  // `clearAllIntents` is the API that exists for exactly this ("test teardown and app shutdown
  // only") and drops armed and queued alike, without delivering or reporting.
  // ══ UNFREEZE THE CLOCK, UNCONDITIONALLY ═══════════════════════════════════════════════════════
  // One row calls `vi.setSystemTime` to separate submit time from queue-drain time. No fake timers
  // are installed in this file or in test-setup, so vitest takes the `!_fakingTime` branch and swaps
  // `globalThis.Date` for a FROZEN MockDate while `setTimeout`/`setInterval` keep running in real
  // time. Restoring at the end of that test body would only run when all of its assertions passed —
  // exactly the case where it does not matter. If one fails, `Date` stays frozen for every later row
  // (and for `retry` re-runs), so presence, countdown deadlines and `STALE_INTENT_MS` are all
  // computed against a clock that never advances while their timers do fire: one genuine regression
  // would surface as a cascade of unrelated timeouts and destroy the diagnostic. Teardown is where
  // this file already puts its other global resets, for the same reason.
  vi.useRealTimers();
  clearAllIntents();
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

/** Let every armed countdown elapse — the gate an ADDRESSED send still passes through.
 *
 *  A NO-OP AFTER A MOUNTED SEND, deliberately, rather than something to strip from those rows: a
 *  mounted send dispatches on submit and leaves nothing armed, so this returns early. Keeping the
 *  call in the mounted rows means they read identically whichever path they exercise, and a
 *  regression that re-armed a mounted send would surface on the rows that assert `armedIntents()`
 *  is empty rather than being quietly absorbed here. */
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

/** The APP-OWNED Improve-Sparkle agent as the SELECTED row. Real constants, imported rather than
 *  spelled out, because the bug is a consequence of those exact values: `isSparkleAgentId` matches
 *  the id, and the name is the literal "Sparkle". */
const SPARKLE_TARGET: ConciergePromptTarget = {
  projectId: "sparkle-self",
  agentId: SPARKLE_AGENT_ID,
  name: SPARKLE_AGENT_NAME,
};

function selectSparkleRow() {
  return render(<ConciergeHost feed={FEED} promptTarget={SPARKLE_TARGET} />);
}

// ══ FOCUS IS NOT A MOUNT (beads sparkle-k5kit, sparkle-l6mgg) ═══════════════════════════════════
//
// The founder worked this out himself: *"Why did I just get this? '@Sparkle has a full-screen app
// open, so I didn't type that into it.' I THINK IT'S BECAUSE I HAD MY CURSOR IN THE IMPROVE SPARKLE
// ROW."* — and proved it by moving the cursor out and finding Sparkle reachable again.
//
// NOTHING WAS MOUNTED. `mountAddress` fired on `isSparkleAgentId(targetRef.current.agentId)` alone,
// with no cable check, so merely SELECTING that row built an aim at it and `deliver` read ITS screen.
// Improve Sparkle is always-on, so his cursor resting there cost him the concierge entirely.
//
// THE INVARIANT: once the destination resolves to the concierge there is no screen to check — it has
// no PTY and no alternate buffer — so that refusal must be UNREACHABLE, not merely rare.
describe("ConciergeHost — a concierge-bound message is never screen-checked", () => {
  /** A screen that genuinely BLOCKS a write — vim on the alternate buffer.
   *
   *  NOT a busy Claude Code, deliberately. PR #1143 taught the guard to recognise Claude Code, so a
   *  busy one no longer refuses at all: a fixture built from the founder's own screenshot makes these
   *  rows VACUOUS, which a first cut of them did. His exact symptom is therefore already mitigated for
   *  a RECOGNISED Claude Code; what survives is the structural defect underneath — the screen check is
   *  aimed by FOCUS rather than by the mount — and it still bites on every screen that does block. */
  const BLOCKING = { text: "~\n~\n~\n:", alternateBuffer: true };

  it("reaches the concierge with the cursor in a blocked Improve Sparkle row and nothing mounted", async () => {
    h.wired.mockReturnValue("off");
    selectSparkleRow();
    h.viewport.mockReturnValue(BLOCKING);
    await send("here is a long thought for you about the roadmap");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // ══ THE IRREVERSIBLE HALF, AND THE ROW THAT STAYS LOAD-BEARING (roborev 57970) ═══════════════
  // The two rows around this one use a BLOCKING screen, so they only pin the REFUSAL. But with the
  // cursor in that row, the cable off and an ordinary CLEAN screen, the removed `mountAddress` made
  // `addressable` true, sailed past the screen guard, armed an intent and wrote the founder's
  // unaddressed paragraph into that agent's PTY — no refusal, no warning. That is the direction
  // `composerRoute`'s header calls unrecoverable, and it is the one a screen-dependent fixture
  // cannot see: a future `isClaudeCodeScreen` that learns to recognise one more thing would make
  // the blocking rows vacuous while this one keeps failing.
  it("does not write into that agent's terminal on a clean screen either", async () => {
    h.wired.mockReturnValue("off");
    selectSparkleRow();
    await send("here is a long thought for you about the roadmap");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a full-screen app, since the concierge has no screen", async () => {
    h.wired.mockReturnValue("off");
    selectSparkleRow();
    h.viewport.mockReturnValue(BLOCKING);
    await send("here is a long thought for you about the roadmap");
    await elapse();
    expect(screen.getByTestId(CONCIERGE_THREAD_TESTID).textContent ?? "").not.toContain(
      "full-screen app",
    );
  });

  // THE OTHER HALF — sparkle-0rf5 must survive. That pane has no composer of its own and
  // `routeMessage` never aims at a PTY, so while it IS mounted the concierge box is the only way into
  // its terminal. The cable gate must narrow `mountAddress` to the mount, not remove it.
  it("still routes into Improve Sparkle's terminal while it IS mounted", async () => {
    h.wired.mockReturnValue("left");
    selectSparkleRow();
    await send("carry on with the retry work");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe(SPARKLE_AGENT_ID);
  });
});

// ══ SELECTING A DIFFERENT BUILD AGENT RE-POINTS THE MOUNT (bead sparkle-k5kit part 3) ══════════
//
// The founder: *"I clicked on Improve Sparkle bottom right corner… it still showed it as mounted. So
// when I clicked on the Improve Sparkle Build Agent, it showed a mounted version of Concierge
// content, which is wrong."* Whatever the mount was keyed on was not being invalidated when the
// selected agent changed.
//
// The routing half and the display half are both derived from `promptTarget`, so a re-point should
// be automatic — but "should be" is what this cluster has been wrong about five times, and NOTHING
// in this suite moved the selection while mounted. These rows move it and assert both halves.
describe("ConciergeHost — the mount follows the selected agent", () => {
  it("routes to the NEWLY selected agent after the selection moves", async () => {
    const view = mount();
    await send("first, to the original mount");
    await elapse();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag1");

    // The founder clicks a different build row. Same cable, different agent.
    view.rerender(
      <ConciergeHost
        feed={FEED}
        promptTarget={{ projectId: "p1", agentId: "ag2", name: "Kraken Auth" }}
      />,
    );
    await send("second, to the new one");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(2);
    // THE ASSERTION THAT MATTERS: the second message went to ag2, not to the agent that was mounted
    // when the column first rendered. A mount keyed on something staler than the selection sends
    // both to ag1 — which is the founder's report, from the routing side.
    expect(h.dispatchConciergeAnswer.mock.calls[1]![0]).toBe("ag2");
  });

  // AND THE DISPLAY HALF, which is what he actually SAW. The pane must show the newly selected
  // agent's conversation — its accessible label names whose it is, so a pane still pointed at the
  // previous agent (or fallen back to the concierge thread) fails here.
  it("re-points the pane's conversation to the newly selected agent", async () => {
    const view = mount();
    expect(screen.getByTestId(MOUNTED_THREAD_TESTID).getAttribute("aria-label")).toContain(
      "Blueprint UI/UX",
    );
    view.rerender(
      <ConciergeHost
        feed={FEED}
        promptTarget={{ projectId: "p1", agentId: "ag2", name: "Kraken Auth" }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId(MOUNTED_THREAD_TESTID).getAttribute("aria-label")).toContain(
        "Kraken Auth",
      ),
    );
  });
});

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

  // ══ …AND IT STAYS MOUNTED WHEN THE AGENT HAS NO projectStore ROW (roborev 59232) ═══════════════
  // `mountedName` used to be `mountedRow?.name ?? (mountedIsSparkle ? … )`, so an agent with no row
  // that is not the app-owned Sparkle one resolved NO NAME — and `mountedAgent` is gated on
  // `mountedAgentId && mountedName`, so a missing name did not degrade one label, it silently
  // unmounted the whole column: the chip vanished and the SPARKLE conversation rendered, while
  // `send` still aimed at that agent's PTY because routing reads `mountedAgentId`, which stays
  // non-null. That is the founder's original defect — the pane says one thing, the words go
  // somewhere else — and bead `sparkle-gw8yi` records the app really producing this state.
  //
  // Fixing it at `railTargetName` alone left THIS surface lying, which is why the row lives here and
  // not only in the rail suite.
  it("REGRESSION: stays mounted, with the chip, when the agent has no projectStore row", () => {
    useProjectStore.setState({
      projects: [] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
    });
    mount();
    // The discriminator, as above: the concierge thread's ABSENCE is what proves the mount held.
    expect(screen.queryByTestId("concierge-thread")).toBeNull();
    expect(screen.getByTestId(MOUNTED_THREAD_TESTID)).toBeTruthy();
    // And the chip still names him the agent — from `promptTarget.name`, the value the send aims at.
    expect(screen.getByTestId(CONCIERGE_CHATTING_WITH_TESTID).textContent).toContain(MOUNTED.name);
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

  // ══ A MOUNTED SEND HAS NO COUNTDOWN AT ALL ══════════════════════════════════════════════════
  // THE FOUNDER'S ASK, verbatim: "when the concierge is mounted and I'm sending something to a build
  // agent, I don't need this countdown. I just want it to be sent immediately."
  //
  // THE ROW DELIBERATELY DOES NOT CALL `elapse()`, and that is the whole assertion: there is nothing
  // left to elapse, because the send already happened on submit. Against the build before this
  // change both lines read the other way — one armed intent, zero dispatches — so this cannot pass
  // by accident on the old behaviour.
  it("dispatches on submit, with no countdown armed in between", async () => {
    mount();
    await send("move the button 5px left");
    expect(armedIntents()).toHaveLength(0);
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag1");
  });

  // THE CONTROL, and the reason this is a NARROWING rather than a deletion. An ADDRESSED message is
  // relayed THROUGH the concierge from a surface aimed somewhere else, so a mistyped or mis-resolved
  // name is still a real misroute and still gets its veto window. A build that ripped the countdown
  // out globally passes the row above and fails this one.
  it("still arms a cancellable countdown for an ADDRESSED send, even while mounted", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    expect(armedIntents()).toHaveLength(1);
    expect(armedIntents()[0]!.targetName).toBe("Kraken Auth");
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("delivers nothing when that addressed countdown is cancelled", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await act(async () => {
      cancelIntent(armedIntents()[0]!.id);
      await Promise.resolve();
    });
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    // ══ AND THE MOUNTED COLUMN IS TOLD ════════════════════════════════════════════════════════════
    // `onCancel` announces through `postSparkle`, which a MOUNTED column does not render — so
    // without the `noteMounted` mirror the founder watches a banner vanish with no word about what
    // happened to the message. Asserting only "nothing dispatched" (which this row did) leaves that
    // branch unobservable, so deleting it would keep the suite green: the same unobservable-branch
    // class the rows further down were written to close.
    await waitFor(() => expect(notice().textContent).toContain("didn't send that to Kraken Auth"));
  });

  // The audit line has to name the REAL gesture. A mounted send claiming `{kind:"countdown"}` would
  // answer "why did it type that?" with "a send countdown elapsed without being cancelled" — naming
  // a countdown that never ran and a cancel window the founder never had. See the `mount` arm in
  // services/dispatchAuthority.
  it("dispatches under the MOUNT authority, not a countdown it never ran", async () => {
    mount();
    await send("move the button 5px left");
    expect(h.dispatchConciergeAnswer.mock.calls[0]![2]).toMatchObject({
      userPrompt: true,
      authority: { kind: "mount", agentId: "ag1" },
    });
  });

  // ...and the addressed path still reports the countdown that genuinely DID run. The pair is the
  // discriminator: one authority per gesture, neither borrowing the other's.
  it("still dispatches an ADDRESSED send under the countdown authority", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
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
  //
  // ══ WHY THIS ROW IS *ADDRESSED* AND NOT MOUNTED ═══════════════════════════════════════════════
  // It used to be a mounted send, and it cannot be one any more: a mounted send now dispatches on
  // submit, so there is no window between the two checks to open vim in — they observe the same
  // instant, and the "vim opened while the banner counted down" scenario is unreachable there BY
  // CONSTRUCTION rather than by a missing guard. The ADDRESSED path still counts down, so it is where
  // the two-instants property is still real and still worth pinning. The column stays MOUNTED so the
  // refusal is asserted through `notice()`, which is the mounted surface's channel — the unmounted
  // `postSparkle` half of the same refusal is pinned by the row below.
  it("re-checks the screen after the countdown, not only before it", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    expect(armedIntents()).toHaveLength(1);
    // vim opened while the banner was counting down.
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(notice().textContent).toContain("full-screen app"));
    await waitFor(() => expect(box().value).toBe("@Kraken Auth ship the DMG"));
  });

  // ══ THE IMMEDIATE MOUNTED PATH STILL HONOURS THE SUBMIT-TIME GUARD ════════════════════════════
  // WHAT THIS ROW PROVES, STATED HONESTLY, because roborev's Medium on the first attempt was that it
  // claimed more than it showed. It proves ONLY that skipping the countdown did not also skip the
  // SUBMIT-TIME screen check — a guard that predates this change. It is a REGRESSION GUARD on the
  // mounted path, not evidence about the second check, and it would pass against the old build too.
  //
  // THE POST-WRITE RE-CHECK IS COVERED, but by the addressed row above rather than here, and after
  // this change that is sufficient rather than a gap: both paths now run the SAME
  // `dispatchToTerminal`, so there is exactly one post-write screen check in the code and the
  // addressed row exercises those literal lines. Hand-mutating that check to `null` kills the
  // addressed row; it cannot kill a mounted row, because the concierge's send-while-busy queue
  // re-runs the submit-time check when it drains a held message, so the earlier guard refuses first
  // and the later one is never reached. A mounted "post-write" row is therefore unwritable at this
  // seam — better to say so than to ship a row whose name promises it.
  it("refuses an immediate mounted send when the screen is in a full-screen app", async () => {
    mount();
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await send("move the button 5px left");
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    // NOTHING WAS ARMED EITHER: the refusal happens before the class check and before any dispatch,
    // so the founder gets the reason immediately rather than after a countdown he cannot see.
    expect(armedIntents()).toHaveLength(0);
    await waitFor(() => expect(notice().textContent).toContain("full-screen app"));
    await waitFor(() => expect(box().value).toBe("move the button 5px left"));
  });

  // ══ AWAY: A MOUNT STOPS BEING SPECIAL ══════════════════════════════════════════════════════════
  // THE SAFETY INVARIANT, and the fix for roborev's High on the previous commit. The immediate path
  // is gated on presence, NOT on the danger classifier. That is deliberate and the reason is
  // measurable: `DESTRUCTIVE_CATEGORIES` is exactly `["bash"]` and `approvalClassifier` was tuned on
  // permission-prompt headers, so `rm -rf .`, `force push to main`, `drop the users table` and
  // `deploy to production` all classify ROUTINE. A classifier gate would have protected the phrasing
  // nobody uses and waved through every phrasing they do. Presence has no such gap.
  //
  // These rows use ROUTINE text on purpose. A destructive-classified sample would pass even against
  // a classifier-gated build, which is exactly the vacuity roborev caught in the row this replaces —
  // the previous version used "run the deploy command", destructive solely because of the trailing
  // word "command". Routine text discriminates: only a presence gate holds it.
  it("arms rather than dispatching while AWAY, even mounted", async () => {
    // `setAway()`, NOT `setState({mode:"away"})`. `mode` is DERIVED and re-resolved on every
    // keystroke via `noteInput`, so a seeded mode is wiped by the act of typing the message — the
    // row then silently tests the Here path while claiming to test Away. `manualAway` is first in
    // `resolveMode`, so an explicit Away survives the typing that follows it.
    usePresenceStore.getState().setAway();
    mount();
    await send("move the button 5px left");
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(armedIntents()).toHaveLength(1);
    expect(armedIntents()[0]!.targetName).toBe("Blueprint UI/UX");
  });

  // ...and the precedence rule it exists to preserve actually fires: a DESTRUCTIVE send while Away
  // is HELD, not sent. Asserted against `queuedIntents()` — a real, inspectable place — because
  // "did not dispatch" alone passes against an implementation that threw the message away.
  it("QUEUES a destructive mounted send while away, rather than sending it", async () => {
    // `setAway()`, NOT `setState({mode:"away"})`. `mode` is DERIVED and re-resolved on every
    // keystroke via `noteInput`, so a seeded mode is wiped by the act of typing the message — the
    // row then silently tests the Here path while claiming to test Away. `manualAway` is first in
    // `resolveMode`, so an explicit Away survives the typing that follows it.
    usePresenceStore.getState().setAway();
    mount();
    await send("run the deploy command");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(queuedIntents()).toHaveLength(1);
    expect(queuedIntents()[0]!.class).toBe("destructive");
    // ══ AND THE MOUNTED COLUMN SAYS SO ═══════════════════════════════════════════════════════════
    // The second half of roborev's Medium. `onQueue` announces through `postSparkle`, which a
    // mounted column does not render, and a queued intent is not in `armedIntents()` so it leaves
    // the banner too. Without the `noteMounted` mirror the composer clears, the banner empties and
    // nothing on screen says the message is held — and `onQueue` restores no draft, so that is a
    // silent hold with the words gone from view.
    await waitFor(() => expect(notice().textContent).toContain("holding it"));
  });

  // THE CONTROL for both rows above: the same routine text, Here, goes instantly. Without this the
  // pair passes against a build that simply never dispatches from a mount.
  it("dispatches that same routine text immediately while HERE", async () => {
    usePresenceStore.getState().setHere();
    mount();
    await send("move the button 5px left");
    expect(armedIntents()).toHaveLength(0);
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });

  // ══ A VOICE-ONLY SESSION MUST NOT LOOK IDLE ═══════════════════════════════════════════════════
  // THE REGRESSION THIS GUARDS, and it is the founder's own complaint coming back in the mode he
  // uses most. `noteInput`'s feeders are enumerated ONCE, in ConciergeHost's mount-gate block — do
  // not restate the list here; an earlier version of this header did, with the retracted "exactly
  // two" count, which is the drift that correction existed to close (roborev 60364). What matters
  // for this row: none of them fires for a dictated CONCIERGE send. So read terminal output for five
  // minutes without typing, dictate a line, and the idle clock has already resolved presence to
  // Away — the presence gate falls through and the countdown banner is back.
  //
  // IDLE Away, not MANUAL away, which is the distinction that makes this row mean something. The
  // rows above use `setAway()` (an explicit "I'm stepping out", which `resolveMode` honours first
  // and a submit must NOT override). This one ages `lastInputAt` past the idle threshold instead,
  // which is the only kind of Away a submit is allowed to clear.
  // THE HELPER CANNOT BE `send()` HERE, and getting that wrong made the first version of this row
  // VACUOUS — it passed with the fix removed. `send()` uses `fireEvent.change`, which is a USER
  // EDIT: it runs ComposeBox's own `onChange`, which pokes `noteInput` and resolves presence back to
  // Here before the click ever happens. So the row could never reach the state it claimed to test.
  // Dictation is different precisely because it does NOT go through `onChange` (segments land via
  // `setText`), so here the text goes in first, presence is aged AFTERWARDS, and only then is Send
  // pressed — which is exactly the state an auto-sent dictated utterance submits in.
  it("treats a submit as input, so an idle voice-only session still sends immediately", async () => {
    mount();
    const ta = box();
    const text = "move the button 5px left";
    fireEvent.change(ta, {
      target: { value: text, selectionStart: text.length, selectionEnd: text.length },
    });
    // NOW nobody touches the keyboard for longer than the idle threshold — the words are already
    // sitting in the box, as they would be after dictation appended them.
    usePresenceStore.setState({
      pinnedHere: false,
      manualAway: false,
      focused: true,
      lastInputAt: Date.now() - (IDLE_AWAY_MS + 60_000),
    });
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("away");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    // The submit itself counted as input, so the send took the immediate path.
    expect(armedIntents()).toHaveLength(0);
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });

  // ...and the inference does NOT trample an explicit Away. `resolveMode` puts `manualAway` first,
  // so "I'm stepping out" survives a submit — otherwise the fix above would quietly delete the one
  // presence signal the user set on purpose.
  it("does not let a submit override an EXPLICIT away", async () => {
    usePresenceStore.getState().setAway();
    mount();
    await send("move the button 5px left");
    expect(usePresenceStore.getState().mode).toBe("away");
    expect(armedIntents()).toHaveLength(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // ══ THE SUBMIT INFERENCE IS SCOPED, AND THIS IS THE ROW THAT SAYS SO ══════════════════════════
  // THE BUG THIS PINS, which an earlier version of this branch shipped: "a submit is input" was
  // written as a global `noteInput()` poke. That resets the STORE's idle clock for IDLE_AWAY_MS —
  // and the ARMED path reads presence AT EXPIRY, precisely so that walking away DURING a countdown
  // still queues a destructive send. So the poke silently converted "idle-Away + destructive →
  // queued" into "→ dispatched", deleting the last way the idle heuristic could reach the queue arm.
  //
  // IDLE-Away, not manual. Every other away row here uses `setAway()` (`manualAway`), which
  // `noteInput` can never clear — so those rows are structurally blind to this bug in both
  // directions. Only an aged `lastInputAt` can see it.
  it("leaves the idle clock alone, so an addressed destructive send still QUEUES while idle-away", async () => {
    mount();
    const text = "@Kraken Auth run the deploy command";
    fireEvent.change(box(), {
      target: { value: text, selectionStart: text.length, selectionEnd: text.length },
    });
    // Nobody touches the keyboard for longer than the idle threshold, then the rail auto-fires.
    usePresenceStore.setState({
      pinnedHere: false,
      manualAway: false,
      focused: true,
      lastInputAt: Date.now() - (IDLE_AWAY_MS + 60_000),
    });
    usePresenceStore.getState().evaluate();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(armedIntents()).toHaveLength(1);
    await elapse();
    // HELD, not sent: the submit did not clear the idle clock the expiry reads.
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(queuedIntents()).toHaveLength(1);
    expect(queuedIntents()[0]!.class).toBe("destructive");
  });

  // ══ THE CREDIT IS ANCHORED TO SUBMIT TIME, NOT DEQUEUE TIME ═══════════════════════════════════
  // THE BUG THIS PINS, which the first cut of the scoping fix shipped: the gate computed
  // `resolveMode({...facts, lastInputAt: Date.now()}, Date.now())`. With both arguments read at the
  // same instant, `now - lastInputAt` is identically ZERO, so `resolveMode`'s idle clause is
  // structurally unreachable and the gate ALWAYS reads Here. Since this runs in the ENQUEUED half,
  // that grants presence at dequeue time — a send from minutes ago writes straight into a live
  // terminal on the strength of a gesture that is no longer true of where the founder is.
  //
  // ALL FOUR OTHER PRESENCE ROWS SUBMIT AND DELIVER IN THE SAME TICK, so the distinction between
  // "submit time" and "dequeue time" is invisible to them. This row is the only one that separates
  // the two: one slow delivery is chained ahead of the mounted send, and the clock is aged past the
  // idle threshold before the chain is allowed to drain.
  it("arms rather than dispatching when the queue drains long after the submit", async () => {
    mount();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.dispatchConciergeAnswer.mockImplementationOnce(async () => {
      await gate;
      return { ok: true, path: "free-text" };
    });
    await send("first message holding the queue");
    // Submitted while genuinely Here, and queued behind the in-flight delivery above.
    await send("move the button 5px left");
    // Time passes — more than the idle window — before the chain reaches our send. `lastInputAt` is
    // aged to match, which is what the real clock would have done.
    const aged = Date.now() - (IDLE_AWAY_MS + 60_000);
    usePresenceStore.setState({
      pinnedHere: false,
      manualAway: false,
      focused: true,
      lastInputAt: aged,
    });
    usePresenceStore.getState().evaluate();
    vi.setSystemTime(Date.now() + IDLE_AWAY_MS + 60_000);
    await act(async () => {
      release();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    // The first message went out; ours did NOT take the immediate path — the submit is too old to
    // still count as evidence anyone is watching, so it fell through to the countdown.
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![1]).toBe("first message holding the queue");
    expect(armedIntents()).toHaveLength(1);
    // NO `vi.useRealTimers()` HERE — it lives in `afterEach`. See the note there: undoing a frozen
    // clock in the test body only runs when every assertion above it passed, which is precisely the
    // case where it does not matter.
  });

  // THE OTHER HALF, so the scoping is pinned in both directions rather than only the safe one. The
  // MOUNT gate does count the submit, deliberately, including for destructive text — the founder
  // just spoke or pressed Send, and immediate dispatch happens at that same instant, so there is no
  // walk-away window for the queue to protect. A build that scoped the inference to nothing (or
  // reverted to reading the raw store mode) reds here.
  it("still dispatches a destructive MOUNTED send immediately while idle-away", async () => {
    mount();
    const text = "run the deploy command";
    fireEvent.change(box(), {
      target: { value: text, selectionStart: text.length, selectionEnd: text.length },
    });
    usePresenceStore.setState({
      pinnedHere: false,
      manualAway: false,
      focused: true,
      lastInputAt: Date.now() - (IDLE_AWAY_MS + 60_000),
    });
    usePresenceStore.getState().evaluate();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(armedIntents()).toHaveLength(0);
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![2]).toMatchObject({
      authority: { kind: "mount" },
    });
  });

  // ══ AND THE POST-COUNTDOWN REFUSAL RETRACTS ITS BUBBLE TOO (roborev 57776) ═══════════════════
  // UNMOUNTED, and that is the whole point of this row existing separately from the one above.
  // `retractSend` is called at BOTH refusal instants, but every test that reached the post-countdown
  // one ran MOUNTED — where `ConciergeThread` is not rendered — so deleting that branch's retraction
  // left the suite green. The submit-time retraction was covered; this one was not.
  //
  // Exactly the trap the previous commit recorded on the submit-time test, one instant over: an
  // absence assertion is worthless if the container is never rendered in that state.
  it("takes back the bubble when the refusal comes AFTER the countdown", async () => {
    h.wired.mockReturnValue("off");
    mount();
    await send("@Kraken Auth ship the DMG");
    expect(armedIntents()).toHaveLength(1);
    // The bubble IS there while the countdown runs — the send has not been refused yet. Asserting
    // its presence first is what makes the absence below mean something.
    expect(screen.getByTestId(CONCIERGE_THREAD_TESTID).textContent ?? "").toContain("ship the DMG");
    // vim opened while the banner was counting down.
    h.viewport.mockReturnValue({ text: "~\n~\n:", alternateBuffer: true });
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    await waitFor(() => expect(box().value).toBe("@Kraken Auth ship the DMG"));
    // ══ RETRACTED *AND* EXPLAINED (roborev 57784) ═══════════════════════════════════════════════
    // Both halves off ONE read of the thread, so the two facts describe a single render rather than
    // two instants that might disagree.
    //
    // The positive half is not decoration. `postSparkle(terminalRefusalLine(…))` at this instant is
    // observable ONLY unmounted — the mounted row asserts `notice()`, which comes from the separate
    // `noteMounted` call — so this row is the only place in the suite where deleting it could fail
    // anything. Without it the founder gets his words back and his bubble retracted with NO
    // explanation, which is exactly the "both refusal instants tell the same story" invariant
    // roborev 57360 was filed for. Third instance of this same unobservable-branch class in this
    // file; the retraction and the explanation must be asserted together or one of them rots.
    await waitFor(() => {
      const thread = screen.getByTestId(CONCIERGE_THREAD_TESTID).textContent ?? "";
      expect(thread).not.toContain("ship the DMG");
      expect(thread).toContain("full-screen app");
      expect(thread).toContain("Kraken Auth");
    });
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
  it("does not claim the message was sent", async () => {
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
    // THE "Also ask" ASSERTION IS GONE, not relaxed. `d23f186` deleted the redirect pill and
    // `redirectLabel` with it, so that button can no longer render ANYWHERE — a query for it cannot
    // fail, and an assertion that cannot fail is worse than none: it reads as coverage of a
    // capability that no longer exists. The property it guarded (a refusal must not offer to replay
    // the message into the agent that just declined it) is now structural rather than tested here.
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

// ══ THE HEADER IS THE CONTRACT: IF IT NAMES AN AGENT, THE SEND GOES THERE ═══════════════════════
//
// The founder, on the defect these rows now pin the fix for: *"If I have a mounted Concierge and I
// type in the compose box, it actually sends it to Sparkle. You can see here that it tells me that
// I'm talking to that build agent but then right above it says it's sent what I said to Sparkle.
// That should not be happening. It should be sending it to the build agent unless I @mention
// Sparkle. This is a big bug that needs to be fixed."*
//
// His screenshot is the whole case, stacked vertically in one frame: the notice row reading *"Asked
// Sparkle — press Esc to unmount and read the reply."* and DIRECTLY BELOW IT the composer header
// reading *"Chatting with ● Mic Capture Regression"*.
//
// THIS BLOCK USED TO PIN THE OPPOSITE, and the reversal is deliberate (it was roborev 57358/57361's
// "one notion of mounted for routing"). `promptTargetShown` — false whenever the Plan board or the
// Improve-Sparkle pane is up, the agent's tab is closed, or, with two pairs, the cable is patched
// LEFT while that predicate reads the RIGHT column — nulled the ROUTING mount while the DISPLAY
// mount, which draws "Chatting with ● <Agent>" and swaps the thread, stayed. So the column named the
// agent and the words went to the concierge.
//
// The old rows called that state agreement because BOTH halves said "not a terminal". They were
// right that the two halves must agree, and wrong about which way: the composer never disagreed with
// the send path so much as the HEADER did, and the header is what the founder reads. The rule
// resolves it toward the terminal.
//
// NOTHING IS LOST BY UNGATING IT, which is why this is a deletion rather than a new special case.
// The hazard `promptTargetShown` was there to prevent — his words going into a terminal he cannot
// see — is caught one layer down by the SCREEN GUARD, which treats a `no-viewport` read as FATAL for
// a mount (`terminalWriteBlocked`) and refuses VISIBLY, with the words put back in the box. That is
// the founder's own stated remedy for an unresolvable route, and it is strictly better than the
// silent redirect it replaces: a refusal you can read beats a delivery to the wrong recipient.
describe("ConciergeHost — a plain mounted send goes to the mounted agent, always", () => {
  const mountHidden = () =>
    render(<ConciergeHost feed={FEED} promptTarget={MOUNTED} promptTargetShown={false} />);

  it("routes to the mounted agent even when its pane is not the shown surface", async () => {
    mountHidden();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]?.[0]).toBe("ag1");
    // AND THE BRAIN IS NEVER ASKED. The screenshotted defect is exactly this call happening
    // INSTEAD of the dispatch above, so asserting only the dispatch would leave the bug's own
    // signature untested.
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  // THE ROW THAT PINS THE AGREEMENT, kept from the old block and flipped with it: the composer must
  // not disclaim a terminal destination the send path is about to use, any more than it may claim
  // one the send path has refused.
  it("paints the composer in the terminal's face in that same state", () => {
    mountHidden();
    expect(box().style.fontFamily).not.toBe("inherit");
  });

  // THE ESCAPE HATCH IS UNAFFECTED — and it is now the ONLY way to reach the concierge from here,
  // which is precisely what the founder asked for ("unless I @mention Sparkle").
  it("still lets @Sparkle pull the message back to the concierge from that state", async () => {
    mountHidden();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // ══ AND WHEN THE ROUTE GENUINELY CANNOT BE RESOLVED, IT REFUSES — IT DOES NOT REDIRECT ═════════
  // The founder's rule has two halves and this is the second: *"if a route genuinely cannot be
  // resolved, the send must be REFUSED with a visible reason, never silently redirected."* An
  // unreadable screen is that case, and it is the one `promptTargetShown` used to swallow: the
  // message went to Sparkle with a notice that said only "Asked Sparkle", which names the wrong
  // recipient rather than the reason.
  it("refuses visibly rather than falling through to Sparkle when the screen can't be read", async () => {
    h.viewport.mockReturnValue(null);
    mountHidden();
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    // THE POINT OF THE ROW. A refusal that quietly asks the brain instead is the defect wearing a
    // different hat — the words still reached a recipient the founder did not choose.
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    await waitFor(() => expect(notice().textContent).toContain("Not sent"));
    // …and the words are back where he can see them, so the refusal costs him nothing.
    expect(box().value).toBe("move the button 5px left");
  });

  // ══ THE THREAD IS STILL HIDDEN HERE, SO THE COLUMN MUST STILL BE ABLE TO SPEAK (roborev 57424) ══
  // The notice row's original defect is still a defect: a message that DOES legitimately go to
  // Sparkle from a mounted column is answered into a thread that is not rendered. `@Sparkle` is now
  // the only way to get there, and it must still say so.
  it("still points at the Sparkle reply while the thread is swapped away", async () => {
    mountHidden();
    expect(screen.queryByTestId("concierge-thread")).toBeNull();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId(MOUNTED_NOTICE_TESTID)).toBeTruthy());
  });

  // ══ AND THE NOTICE NAMES WHO DID *NOT* GET IT (the founder's second ask) ═══════════════════════
  // The line used to read only "Asked Sparkle — press Esc to unmount and read the reply.", which
  // talks about where the ANSWER is and says nothing about the agent he is mounted to and looking
  // at. That is what let the misroute read as normal: the one line that could have said "this did
  // not reach your agent" was busy discussing a reply. It must name the mount, or a Sparkle-bound
  // send stays indistinguishable at a glance from one that reached the terminal.
  it("names the mounted agent it did NOT go to", async () => {
    mountHidden();
    await send("@Sparkle what is the status of the build?");
    await elapse();
    await waitFor(() => expect(notice().textContent).toContain("Asked Sparkle"));
    // The chip's own name, so the notice and the "Chatting with ● <Agent>" header cannot disagree.
    expect(notice().textContent).toContain("Blueprint UI/UX");
  });

  // ══ …BUT NOT WHEN THE MOUNT IS THE AGENT *CALLED* "Sparkle" (roborev 59097) ════════════════════
  // `mountedName` falls back to SPARKLE_AGENT_NAME for the app-owned Improve-Sparkle row, so the
  // named form rendered `Asked Sparkle — not Sparkle.` — a self-contradiction, and in the LIKELIEST
  // case: a leading `@Sparkle` is the only way to reach this line while mounted, and it is exactly
  // what someone mounted to an agent named "Sparkle" types. This also covers the `held === undefined`
  // fallback branch, which no other row exercises.
  it("does not say 'not Sparkle' when the mount IS the Sparkle agent", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={SPARKLE_TARGET} promptTargetShown={false} />);
    await send("@Sparkle what is the status of the build?");
    await elapse();
    await waitFor(() => expect(notice().textContent).toContain("Asked Sparkle"));
    expect(notice().textContent).not.toContain("not Sparkle");
    // The unnamed fallback, whole — so a future edit cannot satisfy this row by dropping the
    // sentence that tells him where the reply is.
    expect(notice().textContent).toContain("press Esc to unmount and read the reply");
  });

  // The control: shown, and every half agrees, exactly as it did before.
  it("routes AND paints when the pane is shown", async () => {
    mount();
    expect(box().style.fontFamily).not.toBe("inherit");
    await send("move the button 5px left");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });
});
