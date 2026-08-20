// @vitest-environment jsdom
//
// BEADS IN THE LIVE MENTION ROSTER — the founder's ask, verbatim: "@mention task and epic titles the
// same way I @mention build agents, with that being what appears in the composer" (bead
// sparkle-1cpomd).
//
// ══ WHY THIS FILE MOUNTS THE HOST INSTEAD OF UNIT-TESTING THE MEMO ══════════════════════════════
// Every interesting property of this wiring is a property of the SEAM, not of any one function.
// `mentions.ts` already pins what a bead mention IS (mentions.test.ts, 149 rows) and it did so while
// the feature was completely dead: nothing put a bead into a roster, so a picker that never offered
// one satisfied that whole suite. The questions only this level can answer are
//
//   • does a bead the beads STORE holds reach the picker the founder is typing into,
//   • does choosing one actually write its title into the box, and
//   • does the trailing space that terminates the mention survive the handoff seam,
//
// and each of them is a fact about two modules agreeing, which is exactly the class of defect this
// repo keeps shipping green (see AGENTS.md on the Rust/TS `Option` seam).
//
// ══ EVERY ROW HOLDS BOTH KINDS AT ONCE ══════════════════════════════════════════════════════════
// The fixture always has an agent AND a bead in the roster. A rule that decides which of N things
// gets an effect cannot be proven by rendering one of them: "the bead row appeared" is also produced
// by a picker that lists everything unconditionally, which would bury the fleet under the backlog.
// So the paired half — the agent is still listed, still uncapped, still offered by a bare `@` — is
// asserted beside it every time.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true, path: "free-text" })),
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  startConciergeTurn: h.startConciergeTurn,
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
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
  agentCanAcceptInput: () => true,
  agentCanAcceptPrompt: () => true,
  liveOptionsFor: () => [],
  isTerseAnswer: () => false,
  matchAnswerToOption: () => null,
  answersLivePicker: () => false,
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
vi.mock("../hooks/useEffectiveWired", () => ({
  useEffectiveWired: () => "off" as const,
  usePairIsLive: () => false,
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: {
    getState: () => ({ setInterruptPreference: vi.fn(), shouldInterrupt: () => true }),
  },
}));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    interim: "",
    micLive: false,
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
  hasAiCredits: () => true,
}));
const RUNTIME = {
  status: {} as Record<string, string>,
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
import { useBeadsStore } from "../stores/beadsStore";
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { bucketBeads, type Bead } from "../services/beads";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { armedIntents, cancelIntent } from "../services/dispatchIntent";
import { useProjectStore } from "../stores/projectStore";

// ── THE FIXTURE ─────────────────────────────────────────────────────────────────────────────────

const AGENT_NAME = "Kraken Auth";
/** The bead the picker must offer. Its title deliberately shares NO prefix with the agent's name, so
 *  a query that reaches it cannot also be reaching the agent by accident. */
const BEAD_TITLE = "Notarization step is flaky since Tuesday";
const BEAD_ID = "sparkle-1cpomd";

function bead(over: Partial<Bead> & { id: string; title: string }): Bead {
  return {
    description: "",
    status: "open",
    type: "task",
    priority: 1,
    labels: [],
    parent: null,
    ...over,
  };
}
const OPEN_BEAD = bead({ id: BEAD_ID, title: BEAD_TITLE });
/** A CLOSED bead with an equally matchable title. It must never be offered — the picker names work
 *  in flight, and a backlog's worth of finished beads would bury the ones that matter. Its presence
 *  is what makes "only the open one showed up" a statement about the filter rather than about the
 *  fixture holding one bead. */
const CLOSED_BEAD = bead({ id: "sparkle-done1", title: "Notarization was fixed last year", status: "closed" });

const COUNTS = { needs_you: 0, questions: 0, running: 1, done: 0 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [
        {
          id: "ag1",
          name: AGENT_NAME,
          projectId: "p1",
          projectName: "sparkle",
          kind: "build" as const,
          status: "running",
          statusColor: "#e0533f",
          statusLabel: "Running",
          band: "running" as const,
          inScope: true,
          muted: false,
          topLevel: true,
        },
      ],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

const SELECTED: ConciergePromptTarget = { projectId: "p1", agentId: "ag1", name: AGENT_NAME };

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const rows = () => screen.queryAllByTestId("concierge-mention-option");
const rowLabels = () => rows().map((r) => r.textContent ?? "");

/** Type a whole value into the box, caret at the end — the way a keystroke actually arrives. */
async function type(value: string) {
  await act(async () => {
    fireEvent.change(box(), {
      target: { value, selectionStart: value.length, selectionEnd: value.length },
    });
    await Promise.resolve();
  });
}

const realPoller = {
  startPolling: useBeadsStore.getState().startPolling,
  stopPolling: useBeadsStore.getState().stopPolling,
};

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  h.routeMessage.mockClear();
  h.startConciergeTurn.mockClear();
  h.dispatchConciergeAnswer.mockClear();
  useComposeHandoffStore.getState().clear();
  // The poller would shell out to `bd` through a bridge jsdom does not have. The SNAPSHOT is what
  // this suite is about, so it is written directly — which is also the honest fixture: the host is
  // specified to read what the store already holds and to fetch nothing itself.
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} });
  const beads = [OPEN_BEAD, CLOSED_BEAD];
  useBeadsStore.setState({
    byProject: { p1: { beads, board: bucketBeads(beads), loadedAt: 1 } },
  });
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/sparkle",
        agents: [{ id: "ag1", name: AGENT_NAME, worktreePath: "/tmp/wt/ag1" }],
      },
    ] as unknown as ReturnType<typeof useProjectStore.getState>["projects"],
  });
});
afterEach(() => {
  for (const i of armedIntents()) cancelIntent(i.id);
  useBeadsStore.setState({ ...realPoller, byProject: {} });
  cleanup();
  vi.clearAllMocks();
});

describe("the @-picker offers beads as well as agents", () => {
  // The whole feature in one row: a bead that exists ONLY in the beads store reaches the list the
  // founder is looking at. Before the roster carried beads this list was the fleet and nothing else,
  // so there is no arrangement of the old code that satisfies this.
  it("offers an open bead by its title, alongside the fleet", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await type("@nota");
    expect(rowLabels().some((t) => t.includes(BEAD_TITLE))).toBe(true);
    // …and the row carries the id, which is the handle the founder greps.
    expect(rows().some((r) => (r.textContent ?? "").includes(BEAD_ID))).toBe(true);
  });

  it("does NOT offer a closed bead whose title matches just as well", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await type("@nota");
    // Same query, same prefix, same store — only the status differs, so a row that appears here is
    // the filter failing rather than the query being too broad.
    expect(rowLabels().some((t) => t.includes("Notarization was fixed last year"))).toBe(false);
  });

  // THE PAIRED HALF, and the one that would catch the expensive mistake. A bare `@` is the "show me
  // the fleet" affordance; if beads joined it, ~2,200 rows would be mounted into the DOM in front of
  // the agent the founder was reaching for.
  it("keeps a bare @ to the fleet — beads need a query", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await type("@");
    expect(rowLabels().some((t) => t.includes(AGENT_NAME))).toBe(true);
    expect(rowLabels().some((t) => t.includes(BEAD_TITLE))).toBe(false);
    // One character is still not enough (BEAD_MENTION_MIN_QUERY), while the agent narrows normally.
    await type("@n");
    expect(rowLabels().some((t) => t.includes(BEAD_TITLE))).toBe(false);
  });

  // ── ONE ROW PER BEAD, ACROSS PROJECTS ────────────────────────────────────────────────────────
  // `bd` resolves `.beads/` through `git-common-dir`, so a worktree registered as its own project
  // reads THE SAME database as the repo it came from and every id collides. Two rows carrying one id
  // would carry the SAME address too — a bead disambiguates with its id, which is identical — so
  // `findMentionSpans` would have two indistinguishable candidates for one literal and the winner
  // would be decided by roster order. That is precisely the invisible wrong-aim `withMentionLabels`
  // exists to make unreachable, and no assertion downstream can see it: both rows draw the same pill.
  it("offers a bead ONCE when two projects' snapshots both hold it", async () => {
    const beads = [OPEN_BEAD, CLOSED_BEAD];
    useBeadsStore.setState({
      byProject: {
        p1: { beads, board: bucketBeads(beads), loadedAt: 1 },
        // The same database, reached through a worktree registered as its own project.
        p1worktree: { beads, board: bucketBeads(beads), loadedAt: 1 },
      },
    });
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await type("@nota");
    expect(rowLabels().filter((t) => t.includes(BEAD_TITLE))).toHaveLength(1);
  });

  // Choosing is the side effect that matters: the box's TEXT changes. This is also the row that
  // would have caught the picker offering beads it then refused — a bead carries
  // `canAcceptInput: false`, which used to mean "unchoosable", so every click and every Enter was
  // silently dropped while the row sat there looking available.
  it("writes the bead's title into the composer, terminated by a space", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await type("@nota");
    const row = rows().find((r) => (r.textContent ?? "").includes(BEAD_TITLE));
    expect(row).toBeTruthy();
    await act(async () => {
      fireEvent.mouseDown(row!);
      await Promise.resolve();
    });
    expect(box().value).toBe(`@${BEAD_TITLE} `);
    // The space TERMINATES the mention, and the proof is behavioural rather than textual: a complete
    // mention closes the list. Were the space missing, `@Notarization step is flaky since Tuesday`
    // would still be an open query and the picker would be sitting over the composer.
    expect(rows()).toHaveLength(0);
  });
});

describe("a handoff's trailing space survives the composer seam", () => {
  /** Push a draft at the box the way the bead card's Chat button does. */
  async function handoff(text: string) {
    await act(async () => {
      useComposeHandoffStore.getState().set({
        origin: "capture-chat",
        projectId: "p1",
        text,
        attachments: [],
        route: "sparkle",
      });
      await Promise.resolve();
    });
  }

  // ══ THE BUG ═══════════════════════════════════════════════════════════════════════════════════
  // The host consumed a handoff with a bare `insert(h.text)`, which routed through the DICTATION
  // join — and that one trims, correctly, because Deepgram pads its segments. So `RE: @<title> `
  // arrived as `RE: @<title>` and the founder's next character extended the bead's name until the
  // literal matched nothing and the reference silently stopped resolving.
  it("keeps the space the producer wrote, so the mention stays complete", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await handoff(`RE: @${BEAD_TITLE} `);
    expect(box().value).toBe(`RE: @${BEAD_TITLE} `);
    expect(box().value.endsWith(" ")).toBe(true);
    // THE CARET IS PAST THE SPACE, and this is the assertion with the grip: the picker reads
    // `mentionQuery(text, caret)`, so a caret sitting before the space — or a space that was
    // trimmed away — leaves an OPEN query and re-opens the list over the draft. Zero rows is the
    // observable difference between the two, and it is a difference the text alone cannot show.
    expect(rows()).toHaveLength(0);
    expect(box().selectionStart).toBe(box().value.length);
  });

  // The PAIRED half. A mode that simply never trimmed anything would satisfy the row above and also
  // satisfy a mode that pasted the prefill flush against whatever was already in the box.
  it("joins onto an existing draft with exactly one space, and never a newline", async () => {
    render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
    await type("look at this");
    await handoff(`RE: @${BEAD_TITLE} `);
    expect(box().value).toBe(`look at this RE: @${BEAD_TITLE} `);
    expect(box().value).not.toContain("\n");
  });
});
