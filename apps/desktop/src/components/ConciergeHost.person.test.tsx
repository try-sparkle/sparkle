// @vitest-environment jsdom
//
// THE PERSON ARM OF `send` — the 98 lines roborev 82277 found untested (bead sparkle-6baj6s).
//
// `composerRoute.test.ts` pins the pure CLASSIFIER and never exercises `send`, so nothing asserted
// the thing the arm's own comment says it depends on: that it runs BEFORE every branch below it.
// Each of those is a non-exhaustive `route.kind === "agent"` / `=== "sparkle"` boolean, so a
// `person` route that reaches them satisfies none and falls through to the CONCIERGE BRAIN — the
// founder's private message to a human, delivered to an AI. The type system cannot catch it (the
// arm's comment says so), so these rows are the only thing that can.
//
// THE ROSTER WIRING IS PINNED HERE TOO, and for a blunter reason: with `socialRoster(socialPeople)`
// deleted from `mentionAgents`, `@Ada` resolves to nobody, the message becomes ordinary prose to
// the concierge, and every other test in the tree still passes. The feature would be completely
// inert and green.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_p: string): Promise<string | null> => null),
  dispatchConciergeAnswer: vi.fn(
    async (_agentId: string, _text: string, _opts?: unknown) => ({ ok: true, path: "free-text" }),
  ),
  // TYPED WITH ITS ARGUMENTS, so a row can assert WHAT the router was asked — "consulted" and
  // "consulted about the user's own words" are different facts, and only the second catches a caller
  // that hands the classifier a string with a name deleted out of it.
  routeMessage: vi.fn(async (_text: string, _ctx?: unknown) => ({
    target: "sparkle" as "sparkle" | "agent",
    reason: "test",
    source: "heuristic" as const,
  })),
  agentCanAcceptInput: vi.fn((_agentId: string) => true),
  /** The rendered screen, for the write-guard. Defaults to a clean prompt; a row that wants a
   *  refusal points it at a full-screen app. */
  viewport: vi.fn((_agentId: string) => CLEAN as null | { text: string; alternateBuffer: boolean }),
  answersLivePicker: vi.fn((_agentId: string, _text: string) => false),
  /** The DM transport an addressed person resolves to. Typed with its arguments so a row can assert
   *  WHICH human was reached and WHAT was sent — "the transport was called" and "the transport was
   *  called with the address stripped off, aimed at Ada's socialId" are different facts, and only
   *  the second catches a caller that hands the wire the envelope. */
  sendDirectMessage: vi.fn(
    // TYPED AS THE FULL RESULT UNION, not narrowed by the happy-path default. `ok: true as const`
    // would pin the mock to success and make the failure row below un-writable — which is how a
    // suite comes to cover only the path that works.
    async (
      _socialId: string,
      _body: string,
    ): Promise<{ ok: true; conversationId: string } | { ok: false; reason: string }> => ({
      ok: true,
      conversationId: "conv-1",
    }),
  ),
}));
vi.mock("../services/personMessaging", () => ({
  sendDirectMessage: (id: string, body: string) => h.sendDirectMessage(id, body),
}));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", () => ({
  // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
  // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
  // 'turn not remembered', which the rotation degrades on.
  turnAccountFor: () => null,
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
/** A terminal at an ordinary prompt — nothing that blocks a write. */
const CLEAN = { text: "> \n", alternateBuffer: false };
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
// The recommended-action row mounts a real metered engine; this suite is about the compose box, so
// it is stubbed out entirely rather than fed a stage to portal into.
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
    // `done`, not `needs_you`: a surfaced agent adds nudge cards that have nothing to do with this.
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

/** The SELECTED agent throughout: every row that asserts a mention beat the selection aims here. */
const SELECTED: ConciergePromptTarget = { projectId: "p1", agentId: "ag1", name: "Blueprint UI/UX" };

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const thread = () => screen.getByTestId("concierge-thread");

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  h.dispatchConciergeAnswer.mockClear();
  h.startConciergeTurn.mockClear();
  // mockRESET, not mockClear: one row below points the router at the agent with `mockResolvedValue`,
  // which is persistent — `mockClear` drops the recorded calls and leaves that implementation in
  // place, so every later row silently ran against a router that always said "agent". That is how
  // the unreachable-agent row failed: it dispatched. Reset the implementation and restate the
  // default, so each row starts from the same knob position.
  h.routeMessage.mockReset();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.agentCanAcceptInput.mockReset();
  h.agentCanAcceptInput.mockReturnValue(true);
  h.answersLivePicker.mockReset();
  h.answersLivePicker.mockReturnValue(false);
  h.viewport.mockReset();
  h.viewport.mockReturnValue(CLEAN);
});
afterEach(() => {
  for (const i of armedIntents()) cancelIntent(i.id);
  cleanup();
  vi.clearAllMocks();
});

/** Type a message and press Send. The caret is asserted onto the node because the mention query
 *  reads it (see ComposeBox.mentions.test.tsx's own `type`). */
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

/** Let every armed countdown elapse — the gate an addressed send still passes through. Fires the
 *  intents directly rather than advancing timers, matching ConciergeHost.test.tsx. */
async function elapse() {
  const pending = armedIntents();
  if (pending.length === 0) return;
  await act(async () => {
    for (const i of pending) fireIntent(i.id);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function mount() {
  return render(<ConciergeHost feed={FEED} promptTarget={SELECTED} />);
}



import { useSocialStore } from "../stores/socialStore";

const ADA_SOCIAL = "soc-ada";
const ADA = {
  socialId: ADA_SOCIAL,
  username: "ada",
  displayName: "Ada",
  availability: "available" as const,
  relationship: "connected" as const,
};

/** Seed the roster BEFORE mounting: `mentionAgents` reads `useSocialStore((s) => s.people)`, so a
 *  person added after render would not be in the roster the composer scanned. */
function withAda() {
  useSocialStore.setState({ people: { [ADA_SOCIAL]: ADA } });
}

beforeEach(() => {
  withAda();
  h.sendDirectMessage.mockReset();
  h.sendDirectMessage.mockResolvedValue({ ok: true, conversationId: "conv-1" });
});
afterEach(() => {
  useSocialStore.getState().reset();
});

describe("an addressed PERSON is sent a DM, and never reaches an agent", () => {
  it("calls the DM transport with the person's socialId and the address stripped off", async () => {
    mount();
    await send("@Ada can you look at this?");
    await elapse();
    expect(h.sendDirectMessage).toHaveBeenCalledTimes(1);
    // THE SOCIAL ID, not the `person:` mount id — the transport addresses the former, and handing it
    // the latter 404s at the server on every send.
    expect(h.sendDirectMessage.mock.calls[0]![0]).toBe(ADA_SOCIAL);
    // THE ADDRESS IS THE ENVELOPE and is consumed, exactly as it is for an agent.
    expect(h.sendDirectMessage.mock.calls[0]![1]).toBe("can you look at this?");
  });

  // ══ THE ROW THE WHOLE FILE EXISTS FOR ═════════════════════════════════════════════════════════
  // If the person arm is moved below `conciergeAddressed` — or any branch is inserted above it —
  // the route falls through to the ordinary unaddressed path and the founder's private message to a
  // human is delivered to the AI. Both halves are asserted: nothing reached a terminal, and no
  // concierge turn was started.
  it("starts no concierge turn and dispatches to no terminal", async () => {
    mount();
    await send("@Ada can you look at this?");
    await elapse();
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // …AND THE ROUTER IS NOT CONSULTED (or billed for). A person route is a user GESTURE, not an
  // inference, so nothing should be asking a classifier where the message ought to go.
  it("does not consult the router", async () => {
    mount();
    await send("@Ada can you look at this?");
    await elapse();
    expect(h.routeMessage).not.toHaveBeenCalled();
  });

  // THE PAIR, so none of the rows above is satisfied by a build that simply sends everything to the
  // DM transport. An addressed AGENT must still reach its terminal and must NOT reach a person.
  it("still delivers an addressed AGENT to its terminal", async () => {
    mount();
    await send("@Kraken Auth ship the DMG");
    await elapse();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag2");
    expect(h.sendDirectMessage).not.toHaveBeenCalled();
  });

  // A person named MID-SENTENCE is the subject, not the envelope — the same positional rule agents
  // get. Without this the arm would divert any message merely mentioning a human.
  it("does not divert a message that merely mentions a person", async () => {
    mount();
    await send("what did @Ada say about the DMG?");
    await elapse();
    expect(h.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("the roster wiring itself", () => {
  // WITHOUT THIS ROW, deleting `socialRoster(socialPeople)` from `mentionAgents` leaves `@Ada`
  // resolving to nobody — the message becomes ordinary prose to the concierge and the entire feature
  // is inert with every other test still green. Asserted through the OUTCOME (the DM went) rather
  // than by reaching into the memo, so it cannot be satisfied by a roster nothing routes on.
  it("puts people in the roster the composer resolves against", async () => {
    mount();
    await send("@Ada hi");
    await elapse();
    expect(h.sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  // …and with NO person in the store, the same text is just prose. The pair proves the row above is
  // about the roster and not about the string "@Ada".
  it("resolves nobody when the roster is empty", async () => {
    useSocialStore.getState().reset();
    mount();
    await send("@Ada hi");
    await elapse();
    expect(h.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("the refusals keep the founder's words", () => {
  // A BARE address strips to nothing, which is not a message. `mentionFreeText` deletes the
  // addressing span whole, so sending would store an empty bubble the recipient reads as a blank.
  it("refuses a bare address without calling the transport", async () => {
    mount();
    await send("@Ada");
    await elapse();
    expect(h.sendDirectMessage).not.toHaveBeenCalled();
  });

  // A FAILED SEND must not be reported as delivered. The transport never throws — it returns a
  // reason — and that reason is a founder-facing sentence posted verbatim.
  it("posts the transport's own reason when the send fails", async () => {
    h.sendDirectMessage.mockResolvedValue({ ok: false, reason: "Ada isn't accepting messages." });
    mount();
    await send("@Ada hi");
    await elapse();
    await waitFor(() => {
      expect(thread().textContent).toContain("Ada isn't accepting messages.");
    });
    // and still nothing went to an agent or the brain
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  it("receipts a successful send by naming who it reached", async () => {
    mount();
    await send("@Ada hi");
    await elapse();
    await waitFor(() => {
      expect(thread().textContent).toContain("Sent to Ada.");
    });
  });

  // ══ AND SAYS WHAT THIS BUILD CANNOT SHOW (sparkle-reviewer probe 2) ═══════════════════════════
  // The bare receipt is byte-identical in SHAPE to the AGENT receipt, where the destination really
  // is openable — so on its own it reads as delivered-and-awaiting-reply, and the builder waits for
  // a reply no surface in this build can paint (`Workspace` renders `<ChatPane>` with no
  // `useThread`, so it runs `useUnwiredChatThread`). PAIRED, per AGENTS.md: the positive demands the
  // caveat is stated, the negative demands the receipt does not stop at the bare sentence — deleting
  // the clause would satisfy a positive-only check on "Sent to Ada." forever. So the row above pins
  // WHO it reached and this one pins WHAT the builder cannot then do, and neither is green alone.
  it("tells the builder the conversation is not readable here yet", async () => {
    mount();
    await send("@Ada hi");
    await elapse();
    await waitFor(() => {
      expect(thread().textContent).toContain("Sent to Ada.");
    });
    const said = thread().textContent ?? "";
    expect(said, "a bare receipt promises a thread this build cannot render").toMatch(
      /can't show this conversation yet/i,
    );
    expect(said, "and it must not imply the reply will turn up in this thread").toMatch(
      /reply won't appear here/i,
    );
  });
});
