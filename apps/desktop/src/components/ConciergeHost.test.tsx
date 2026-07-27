// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  ConciergeDispatchPath,
  ConciergeDispatchResult,
} from "../services/conciergeDispatch";

/** The deferred-outcome shape is the PRODUCTION interface, not a hand-copy of it: `onDeferredSend
 *  Outcome` takes `(r: ConciergeDispatchResult) => void`, so aliasing it means the mock can't drift
 *  from what a real listener receives — a field the ladder later gates on, or `sent` becoming
 *  required, now breaks the mock instead of leaving rows green but unrepresentative (roborev
 *  53162). It also makes `path` the real union, so a `path: "pty-gonw"` typo is a compile error
 *  rather than a row that silently passes through the catch-all `else` (roborev 53142).
 *
 *  The `dispatchConciergeAnswer` mock below keeps its own narrower literal ON PURPOSE — it models
 *  an optional `path`, which the production result does not have. */
type DeferredOutcome = ConciergeDispatchResult;
/** For `importOriginal` in the concierge mock below — the real module's type, so pulling a genuine
 *  export through the factory is checked rather than `any`. */
type Concierge = typeof import("../services/concierge");

// Mock the data feed + the three side-effecting services so we test the HOST's wiring: user send →
// brain, nudge actions → dispatch/select/mute, brain deltas → thread. ConciergeColumn renders for real.
const h = vi.hoisted(() => ({
  feed: null as unknown,
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_prompt: string): Promise<string | null> => null),
  // `path` is the real union, not bare `string`: typed loosely, a `path: "pty-gonw"` typo compiles
  // and quietly exercises refusalCopy's generic arm while the row's regex still matches the generic
  // line — a test passing on a path production can never produce (roborev 53097). matchedLabel
  // rides along on picker-option; the component renders it, so the mock must carry it.
  // The PARAMETERS are declared too (roborev: the routed suites assert delivery ORDER off
  // `mock.calls.map(c => c[1])`, and an argument-less signature makes every call a zero-length
  // tuple — a compile error at the assertion rather than at the mock, which is the confusing end).
  dispatchConciergeAnswer: vi.fn(
    async (
      _agentId: string,
      _text: string,
      _opts?: { userPrompt?: boolean; display?: string; namingBasis?: string },
    ): Promise<{ ok: boolean; path?: ConciergeDispatchPath; matchedLabel?: string }> => ({
      ok: true,
    }),
  ),
  setInterruptPreference: vi.fn(),
  // The router has its own exhaustive suite (services/conciergeRouter.test.ts). Here it is a knob,
  // so these tests assert what the HOST does with a decision rather than re-testing the decision.
  routeMessage: vi.fn(
    async (_text: string, _ctx: { agent: { id: string; name: string } | null }) => ({
      target: "sparkle" as "sparkle" | "agent",
      reason: "test",
      source: "heuristic" as const,
    }),
  ),
  agentCanAcceptInput: vi.fn((_agentId: string) => true),
  suggestionMounts: [] as string[],
  suggestionVisible: undefined as boolean | undefined,
  suggestionProps: undefined as
    | {
        onApply: (run: () => Promise<boolean>) => Promise<boolean>;
        onDeliverPrompt: (t: string) => Promise<boolean>;
      }
    | undefined,
  deferred: undefined as ((r: DeferredOutcome) => void) | undefined,
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; text: string }) => void;
    error?: (e: { id: string; detail: string }) => void;
  },
}));
// Single-window shell (CM-U7): "show me" is a TAB switch + agent reveal, not a bare select.
// Mirror EVERY export: Vitest throws on access to a missing mock export, so a partial factory
// breaks the moment anything else in the tree imports the other symbol.
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => ({
  // The REAL sentinels and the REAL matcher, not hand-copies: the host now filters error EVENTS by
  // detail (roborev 53460/53462), so a stubbed list or predicate would let the host and Rust drift
  // while these rows stayed green.
  SUPERSEDED_DETAILS: (await importOriginal<Concierge>()).SUPERSEDED_DETAILS,
  isSupersededDetail: (await importOriginal<Concierge>()).isSupersededDetail,
  startConciergeTurn: h.startConciergeTurn,
  onConciergeDelta: (cb: (e: { id: string; text: string }) => void) => {
    h.brain.delta = cb;
    return () => {};
  },
  onConciergeDone: (cb: (e: { id: string; text: string }) => void) => {
    h.brain.done = cb;
    return () => {};
  },
  onConciergeError: (cb: (e: { id: string; detail: string }) => void) => {
    h.brain.error = cb;
    return () => {};
  },
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: h.agentCanAcceptInput,
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  // Not exercised in these rows (no picker on screen), but the host imports it — and Vitest
  // throws on ACCESS to an export a factory omits, so a partial mock breaks the whole file.
  answersLivePicker: () => false,
  onDeferredSendOutcome: (cb: (r: DeferredOutcome) => void) => {
    h.deferred = cb;
    return () => {};
  },
}));
vi.mock("../services/conciergeRouter", () => ({ routeMessage: h.routeMessage }));
// The recommended-action row is a keyed child (Concierge/ConciergeSuggestions) with its own
// per-agent hook. Mock it to record the agentId it was mounted with — the HIGH finding in roborev
// 53043 was precisely that this identity was shared across agents.
vi.mock("./Concierge/ConciergeSuggestions", async () => {
  const { useEffect } = await import("react");
  return {
    ConciergeSuggestions: (p: {
      agentId: string;
      agentName: string;
      visible?: boolean;
      onApply: (run: () => Promise<boolean>) => Promise<boolean>;
      onDeliverPrompt: (t: string) => Promise<boolean>;
    }) => {
      h.suggestionVisible = p.visible;
      h.suggestionProps = p;
      // MOUNTS, not renders. Pushing on every render made the key={agentId} assertion inert: a
      // re-rendered single instance would record both ids just as well as two instances, so the
      // one test guarding the irreversible cross-agent misdelivery proved nothing (roborev 53086).
      useEffect(() => {
        h.suggestionMounts.push(p.agentId);
      }, []);
      return <div data-testid="suggestions-row" data-agent={p.agentId} />;
    },
  };
});
// The voice stack (CM-U9) is mocked in EVERY host test, not just the voice one (roborev 48171):
// the host imports it unconditionally, so without this the base tests run the real dictation hook
// and the real stopVoice() on every simulated send — mutating global dictation state and coupling
// these tests to the mic pipeline.
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    micLive: false,
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("../services/conciergeVoice", () => ({
  speakConciergeReply: vi.fn(async () => "elevenlabs" as const),
  speakOnDemand: vi.fn(async () => "elevenlabs" as const),
  stopConciergeVoice: vi.fn(),
  shouldSpeakConciergeReply: vi.fn(() => true),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: h.setInterruptPreference }) },
}));

// TRIAL_SPENT_TEXT is IMPORTED, not re-declared: both voices are supposed to return this exact
// string, and asserting the literal on each side is what pins that they stay shared. A hand-synced
// copy here would turn a wording tweak into a red test for a non-bug (roborev 53044).
import { ConciergeHost, TRIAL_SPENT_TEXT } from "./ConciergeHost";
// Through the mock above, which re-exports the REAL array — so these rows use the same literals the
// host filters on and the same ones Rust emits.
import { SUPERSEDED_DETAILS } from "../services/concierge";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";

const EMPTY_COUNTS: Record<StatusBand, number> = { needs_you: 0, running: 0, done: 0 };

/** A one-agent feed. The band defaults to `needs_you` because that IS the surfacing gate — an agent
 *  in any other band produces no nudge card, which is what the `done` case below pins. */
function feedWith(status: string, band: StatusBand = "needs_you") {
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status,
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band,
    inScope: true,
    muted: false,
    // A parentless build agent — it gets a row of its own in column two, which is what the
    // surfacing gate now also requires (see ConciergeHost.surfacedAgents).
    topLevel: true,
    // Nothing above it in the tree, so no ancestor row can be speaking for it.
    representedElsewhere: false,
  };
  const counts = { needs_you: 0, running: 0, done: 0, [band]: 1 };
  return {
    projects: [{ id: "p1", name: "sparkle", inScope: true, counts, agents: [agent] }],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  };
}

afterEach(() => {
  cleanup();
  h.suggestionMounts = [];
  h.suggestionVisible = undefined;
  h.suggestionProps = undefined;
  // resetAllMocks, NOT clearAllMocks: clear leaves any UNCONSUMED `…Once` implementation sitting in
  // the queue, where it silently becomes the NEXT test's first answer. Resetting everything (rather
  // than a hand-maintained list) means a mock added later can't reintroduce that leak by omission.
  vi.resetAllMocks();
  h.routeMessage.mockResolvedValue({ target: "sparkle", reason: "test", source: "heuristic" });
  h.dispatchConciergeAnswer.mockResolvedValue({ ok: true });
  h.startConciergeTurn.mockResolvedValue(null);
  h.agentCanAcceptInput.mockReturnValue(true);
});

/** Point the router at the agent for the next send(s). The router itself is exhaustively tested in
 *  services/conciergeRouter.test.ts; here it is a knob. */
function routeToAgent() {
  h.routeMessage.mockResolvedValue({ target: "agent", reason: "test", source: "heuristic" });
}

/** Let the queued send finish. Routing is async now (tier 2 is a network round trip) and every
 *  delivery chains behind the previous one, so nothing lands in the same tick as the click. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Queries scoped to the VISIBLE transcript. The column also renders a hidden `role="status"` live
 *  region carrying the last finished line (roborev 53010), so a document-wide getByText would match
 *  the same string twice — and would pass even if the visible thread stopped rendering it. */
const thread = () => screen.getByTestId("concierge-thread");
const inThread = (re: RegExp | string) => within(thread()).getByText(re);
const findInThread = (re: RegExp | string) => within(thread()).findByText(re);
const queryInThread = (re: RegExp | string) => within(thread()).queryByText(re);

describe("ConciergeHost", () => {
  it("surfaces an in-scope needing agent as a nudge with an Approve action", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.getAllByText(/CI Hardening/).length).toBeGreaterThan(0);
    expect(inThread("Approve")).toBeTruthy();
    expect(inThread("Show me")).toBeTruthy();
  });

  it("Approve relays the answer into the agent's terminal", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    // Approve goes through the SAME delivery queue as a compose send now, so it lands a few
    // microtasks later rather than in the click's own tick (roborev 53119).
    await settle();
    // userPrompt: false — "approve" is machine-authored; it must not enter prompt history,
    // debit a trial prompt, or feed the auto-name ladder (roborev 46251-H1).
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "approve", { userPrompt: false });
    expect(h.openProjectTab).not.toHaveBeenCalled();
  });

  // Approve sits behind the queue now, so a click during a still-routing send produces no
  // immediate delivery — and with no feedback the natural reaction is to click again. A second
  // queued approve lands AFTER the picker has been answered, where it answers whatever comes next
  // or is typed as free text (roborev 53119).
  it("a double-tap on Approve dispatches once, and acknowledges the click immediately", async () => {
    h.feed = feedWith("approval");
    let release: (() => void) | undefined;
    h.dispatchConciergeAnswer.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
    );
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    // The acknowledgement is synchronous — that is what makes the second click unnecessary.
    expect(inThread(/Approving CI Hardening…/)).toBeTruthy();
    fireEvent.click(inThread("Approve"));
    await settle();
    await act(async () => { release?.(); await Promise.resolve(); });
    await settle();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });

  it("Show me opens the source project's TAB and selects the agent", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Show me"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag1");
  });

  it("does NOT surface an agent whose band is `done` — that includes `unmerged`", () => {
    // The regression this pins: 27 of 51 agents on the reported fleet were committed-but-unlanded.
    // Surfacing the `done` band is 27 nudge cards nobody can dismiss.
    h.feed = feedWith("unmerged", "done");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.queryByText("Show me")).toBeNull();
    expect(screen.queryByText("Mute")).toBeNull();
  });

  it("surfaces `blocked` — it bands Needs-you now, with the same red as an approval", () => {
    h.feed = feedWith("blocked");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    // One band label on the card, not a "P1" badge in a second alarm color.
    expect(screen.getAllByText("Needs you").length).toBeGreaterThan(0);
    expect(screen.queryByText("P1")).toBeNull();
  });

  it("Mute records a do-not-interrupt preference for the agent", () => {
    h.feed = feedWith("blocked");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Mute"));
    expect(h.setInterruptPreference).toHaveBeenCalledWith("ag1", "mute");
  });

  it("sending a message starts a brain turn with a grounded snapshot", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    const snapshot = h.startConciergeTurn.mock.calls[0]![0];
    expect(snapshot).toContain("CI Hardening");
    expect(snapshot).toContain("what needs me?");
    // the user's message shows in the thread
    expect(inThread("what needs me?")).toBeTruthy();
  });

  it("streams a brain reply into the thread (delta then done)", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.delta?.({ id: "7", text: "On " }));
    act(() => h.brain.delta?.({ id: "7", text: "it." }));
    expect(inThread("On it.")).toBeTruthy();
    act(() => h.brain.done?.({ id: "7", text: "On it — approving CI Hardening." }));
    expect(inThread("On it — approving CI Hardening.")).toBeTruthy();
  });

  it("announces the FINISHED reply once, never the streaming chunks (roborev 53010)", () => {
    // The column's one live region. It must not carry the growing text: a value that changes per
    // delta hands a screen reader an announcement per chunk — the flooding the interim dictation
    // preview was silenced for, which putting role=log on the transcript would have re-created.
    h.feed = feedWith("approval", "needs_you");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    const announcer = () => screen.getByTestId("concierge-announcer");
    act(() => h.brain.delta?.({ id: "7", text: "On " }));
    act(() => h.brain.delta?.({ id: "7", text: "it." }));
    expect(announcer().textContent).toBe("");
    act(() => h.brain.done?.({ id: "7", text: "" }));
    expect(announcer().textContent).toBe("On it.");
  });

  it("shows an error bubble when the brain can't be reached", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.error?.({ id: "t1", detail: "spawn failed" }));
    expect(await findInThread(/couldn't reach my brain/i)).toBeTruthy();
  });

  // A sentinel detail on the EVENT path (roborev 53460). startConciergeTurn silences these on the
  // invoke-rejection path, but an error EVENT carrying the same string was not filtered by detail at
  // all — its only guard was supersededTurn, and that misses a turn which failed before streaming
  // anything, because the send-time floor can only retire ids an event has been SEEN for. The turn
  // id here is deliberately one no delta ever arrived for, which is exactly that hole.
  //
  // Typing must stay ON: the turn that displaced this one is the one still talking.
  it.each(SUPERSEDED_DETAILS.map((d) => [d] as const))(
    "an error event whose detail is %s is silent — no bubble, no typing reset",
    async (detail) => {
      h.feed = feedWith("approval");
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      // A brain turn has to be IN FLIGHT for "don't reset typing" to mean anything. Routing is a
      // promise now, so the indicator only appears once the router has said "sparkle".
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
      fireEvent.click(screen.getByText("Send"));
      await settle();
      expect(screen.queryByLabelText("Sparkle is typing")).toBeTruthy();

      act(() => h.brain.error?.({ id: "9", detail }));
      expect(queryInThread(/couldn't reach my brain/i)).toBeNull();
      // Still typing — the displacing turn owns the indicator.
      expect(screen.queryByLabelText("Sparkle is typing")).toBeTruthy();
    },
  );

  // Each refused path gets its OWN remedy, and the remedies genuinely differ: Retry for a pane that
  // gave up, "use its own pane" for a cloud agent. Falling back to the generic "I couldn't send the
  // approval to X." is the dead end these branches exist to remove — and it silently came back once
  // already, because the approval ladder drifted a commit behind the prompt one.
  //
  // Every pattern below is VOICE-UNIQUE — it appears in the approval copy and NOWHERE in the prompt
  // copy. That is the whole point since both voices share one `refusalCopy` table: a loose pattern
  // like /hit Retry/ matches the prompt line too, so mis-wiring the call to `…, "prompt")` would
  // ship "then send again" on a nudge Approve and still pass (roborev 52972). trial-spent is
  // deliberately absent — its copy is SHARED by both voices by design, so it has no unique
  // fragment; the pair of exact-string tests below pin that sharing instead.
  it.each([
    ["agent-failed", /I couldn't send the approval — open its pane and hit Retry/],
    ["cloud-agent", /relay the approval/],
    ["pty-gone", /I couldn't send the approval\./],
    ["ambiguous-picker", /open it to choose/],
  ] as const)("an Approve refused as %s speaks in the APPROVAL voice", async (path, remedy) => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(remedy)).toBeTruthy();
    // …and NOT the generic dead end, nor any prompt-voice phrasing bleeding across.
    expect(queryInThread(/^I couldn't send the approval to/)).toBeNull();
    expect(queryInThread(/then send again|isn't wired up yet|pass it along/)).toBeNull();
  });

  it("an Approve refused as trial-spent says EXACTLY the shared trial line", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "trial-spent" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    // Exact string, not a fragment: trial-spent is the one branch both voices are meant to share,
    // and its prompt-side twin asserts the same literal. A fragment match would let the two drift
    // apart while still passing, which is precisely the design claim (roborev 53018).
    expect(await findInThread(TRIAL_SPENT_TEXT)).toBeTruthy();
  });

  // The approve-side mirror of the prompt table below: `approve` carried the identical widening,
  // where reinstating it prints "Approved — sent to X." on a dispatch that FAILED. Nothing in the
  // suite caught that until now (roborev 53044). No draft to check here — Approve has no composer.
  it.each(["free-text", "picker-option", "queued"] as const)(
    "an ok:false Approve carrying the delivered path %s is still a refusal",
    async (path) => {
      h.feed = feedWith("approval");
      h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.click(inThread("Approve"));
      await settle();
      // Pin that the dispatch actually happened with the approve arguments. The catch path can't
      // satisfy these rows TODAY (it posts "I couldn't reach X's terminal to approve.", which the
      // regex below doesn't match) — this is a forward-guard: a change routing the catch through
      // refusalCopy would otherwise let them pass on a path they never meant to cover.
      expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "approve", { userPrompt: false });
      expect(await findInThread(/I couldn't send the approval to/)).toBeTruthy();
      expect(queryInThread(/^Approved — sent to/)).toBeNull();
      expect(queryInThread(/still starting up/)).toBeNull();
    },
  );

  // The POSITIVE SUCCESS report. Every other approve test asserts this line only via
  // `queryByText(…).toBeNull()`, and the one success-path test checks the dispatch args without
  // ever looking at the thread — so deleting the success branch made a working Approve post
  // NOTHING and left the suite green. That silence is precisely what `approve`'s own comment
  // promises never happens ("ALWAYS give the user feedback") (roborev 53097).
  it("a delivered Approve is confirmed in the thread", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "free-text" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(/^Approved — sent to CI Hardening\.$/)).toBeTruthy();
    expect(queryInThread(/still starting up|I couldn't send the approval/)).toBeNull();
  });

  // The THROWING path — the other half of "ALWAYS give the user feedback… Also swallows the
  // throwing path". Nothing held this string in place, so deleting the try/catch made a throwing
  // dispatch post nothing at all: the same silence the success test above now prevents. It also
  // pins the copy that the refusal table's forward-guard comment cites as its rationale
  // (roborev 53111).
  it("a THROWING Approve still says something rather than leaving the user waiting", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockRejectedValueOnce(new Error("pty write failed"));
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(/^I couldn't reach CI Hardening's terminal to approve\.$/)).toBeTruthy();
    expect(queryInThread(/^Approved — sent to/)).toBeNull();
    // States WHICH failure voice this row pins: the catch's copy, not refusalCopy's — the same
    // distinction the refusal table's forward-guard comment relies on.
    expect(queryInThread(/I couldn't send the approval to/)).toBeNull();
  });

  // The POSITIVE queued case, which `promptAgent` has and `approve` did not. Without it, deleting
  // or mis-gating approve's queued branch drops an ok:true hold through to `else if (r.ok)` and
  // posts "Approved — sent to X." for something that was only HELD — the exact lie this series
  // exists to remove — with the whole suite still green (roborev 53062).
  it("an Approve that is only QUEUED says so, and does not claim it was sent", async () => {
    h.feed = feedWith("approval");
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "queued" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(/is still starting up — I'll approve as soon as it's ready/)).toBeTruthy();
    expect(queryInThread(/^Approved — sent to/)).toBeNull();
  });
});

// The capability the removed AgentPane composer owned: type a prompt, have it reach an agent's
// terminal with all the side-effects that used to hang off Send (roborev 46251-H1 / 46260-M3).
//
// The user no longer PICKS that destination — the host routes (PRD/sparkle/concierge-auto-routing).
// So every row that used to flip the target toggle now points the mocked router at the agent
// instead. What is being pinned is unchanged: the dispatch options, and every outcome the thread
// has to report honestly.
describe("ConciergeHost — routed prompt → the selected agent", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  function renderWithTarget(t: typeof target | null = target) {
    h.feed = feedWith("approval");
    return render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={t} />);
  }

  function type(text: string) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
  }

  async function send(text: string) {
    type(text);
    await settle();
  }

  it("the box offers NO target affordance — the user never picks", () => {
    renderWithTarget();
    expect(screen.queryByTestId("send-target-toggle")).toBeNull();
  });

  it("asks the router where the message goes, with the agent in view", async () => {
    renderWithTarget();
    await send("what needs me?");
    expect(h.routeMessage).toHaveBeenCalledWith("what needs me?", {
      agent: { id: "ag1", name: "CI Hardening", status: undefined, canAcceptInput: true },
    });
  });

  it("a 'sparkle' decision starts a brain turn and never touches the agent", async () => {
    renderWithTarget();
    await send("what needs me?");
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("an 'agent' decision dispatches as a USER prompt and never asks the brain", async () => {
    routeToAgent();
    renderWithTarget();
    await send("rebase onto main and re-run CI");
    // With nothing attached, all three renderings are the same string (see the dispatch options).
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith(
      "ag1",
      "rebase onto main and re-run CI",
      {
        userPrompt: true,
        display: "rebase onto main and re-run CI",
        namingBasis: "rebase onto main and re-run CI",
      },
    );
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  // The dispatcher refuses cloud agents outright, so asking it UP FRONT turns a guaranteed
  // delivery failure into a useful chat answer. `canAcceptInput` is required on RouteAgent for
  // exactly this reason — a caller that doesn't know must not be able to route at a terminal.
  it("tells the router a cloud agent can't accept input", async () => {
    h.agentCanAcceptInput.mockReturnValue(false);
    renderWithTarget();
    await send("anything");
    expect(h.routeMessage).toHaveBeenCalledWith("anything", {
      agent: { id: "ag1", name: "CI Hardening", status: undefined, canAcceptInput: false },
    });
  });

  it("tells the router there is nothing to prompt when no agent is in view", async () => {
    renderWithTarget(null);
    await send("still chat");
    expect(h.routeMessage).toHaveBeenCalledWith("still chat", { agent: null });
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  // A promptTarget naming an agent the feed no longer carries is a corpse: routing at it would
  // report a delivery that cannot happen.
  it("treats an agent that vanished from the feed as no agent at all", async () => {
    h.feed = feedWith("approval");
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p9", agentId: "ghost", name: "Ghost" }}
      />,
    );
    await send("hello?");
    expect(h.routeMessage).toHaveBeenCalledWith("hello?", { agent: null });
  });

  // Two IDENTICAL consecutive announcements — the most ordinary path there is: send twice to the
  // same pinned agent and both outcomes read "Sent to CI Hardening." (roborev 53392). Fed a bare
  // string, the second `setAnnouncement` is `Object.is`-equal, so React bails out of the update; and
  // even re-rendered the text node is unchanged, while an `aria-live` region only speaks on a
  // content CHANGE. The screen-reader user was told about the first send only.
  //
  // So this asserts the NODE was replaced, not merely that the text still reads the same — the text
  // read the same the whole time it was broken, which is why the previous "fixed" claim on bbf596e
  // survived with no nonce in the code and this suite green.
  //
  // Under ROUTING the repeat is the common case, not a corner one: the outcome announced for a
  // routed send is its RECEIPT, and routing is sticky — two messages in a row sent to the same
  // agent both read "→ Sent to CI Hardening". So this pins the receipt path through `announce`
  // rather than a plain `setAnnouncement`.
  it("announces a SECOND, IDENTICAL outcome — the live region must not go quiet on a repeat", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer
      .mockResolvedValueOnce({ ok: true, path: "free-text" })
      .mockResolvedValueOnce({ ok: true, path: "free-text" });
    renderWithTarget();
    const announcer = () => screen.getByTestId("concierge-announcer");

    await send("ship it");
    expect(await within(thread()).findByText("→ Sent to CI Hardening")).toBeTruthy();
    expect(announcer().textContent).toBe("→ Sent to CI Hardening");
    const spoken = announcer().firstElementChild;
    const seq = spoken?.getAttribute("data-announce-seq");

    await send("ship it again");
    // A different node carrying the same words: exactly the mutation the assistive technology
    // listens for, and the thing a bare string could not produce.
    await waitFor(() => expect(announcer().firstElementChild).not.toBe(spoken));
    expect(announcer().textContent).toBe("→ Sent to CI Hardening");
    expect(announcer().firstElementChild?.getAttribute("data-announce-seq")).not.toBe(seq);
  });

  it("surfaces the trial-spent refusal instead of pretending the prompt landed", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "trial-spent" });
    renderWithTarget();
    await send("one more");
    // Exact string — the approve-side twin asserts the same literal, which is what pins that the
    // one branch both voices share actually stays shared.
    expect(await findInThread(TRIAL_SPENT_TEXT)).toBeTruthy();
  });

  it("says a queued prompt is waiting on the agent's start-up", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "queued" });
    renderWithTarget();
    await send("start on the docs");
    // Full phrase, not the /still starting up/ fragment both voices share: mis-wiring this branch
    // to the APPROVAL wording ("I'll approve as soon as it's ready") would pass on the fragment.
    expect(await findInThread(/still starting up — I'll send that the moment it's ready/)).toBeTruthy();
  });

  // The positive picker-option branch — the last untested "ok:true but not a plain send" report.
  // Mis-gating it (e.g. to "free-text") drops through to `if (r.ok)`, which under routing posts no
  // line at all — silently losing WHICH option the user's text answered (roborev 53081).
  it("a prompt that answered a PICKER names the option it chose", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({
      ok: true, path: "picker-option", matchedLabel: "Yes",
    });
    renderWithTarget();
    await send("yes");
    expect(await findInThread(/was asking something — I answered "Yes"/)).toBeTruthy();
  });

  // `matchedLabel` is OPTIONAL on the result, so interpolating it unguarded renders the literal
  // `I answered "undefined".` — the same untrue report the ladder exists to avoid (roborev 53097).
  it("a picker-option result with NO label degrades truthfully — never 'I answered \"undefined\"'", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "picker-option" });
    renderWithTarget();
    await send("yes");
    expect(await findInThread(/was asking something — I answered it\./)).toBeTruthy();
    expect(queryInThread(/undefined/)).toBeNull();
  });

  // The refusal ladder, in the PROMPT voice. Each row asserts a phrase unique to its path so a
  // fall-through to the generic line is a failure, not a pass.
  it.each([
    ["agent-failed", /hit Retry/],
    ["cloud-agent", /use its own pane for now/],
    ["ambiguous-picker", /open it and pick/],
    // /didn't send/ is voice-unique but appears in THREE prompt-side branches, so it pins the voice
    // without pinning the path→copy mapping. "pass it along" is pty-gone's alone (roborev 53018).
    ["pty-gone", /pass it along/],
  ] as const)("a prompt refused as %s speaks in the PROMPT voice and keeps the draft", async (path, remedy) => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
    renderWithTarget();
    await send("worth not retyping");
    expect(await findInThread(remedy)).toBeTruthy();
    expect(queryInThread(/^I couldn't send that to/)).toBeNull();
    // No approval-voice phrasing bleeding across the shared table.
    expect(queryInThread(/the approval|open it to choose/)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("worth not retyping");
  });

  // `ok` is the ONLY test for delivery. A pass at the type-narrowing problem widened this branch to
  // `r.ok || r.path === "picker-option" || r.path === "free-text"`, which meant an ok:false result
  // carrying a delivered-looking path reported success and returned true — silently DISCARDING the
  // user's draft on a failure that used to restore it (roborev 53018). The two fields are
  // independent on ConciergeDispatchResult, so nothing but this test stops that coming back.
  it.each(["free-text", "picker-option", "queued"] as const)(
    "an ok:false result carrying the delivered path %s is still a refusal — draft kept",
    async (path) => {
      routeToAgent();
      h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
      renderWithTarget();
      await send("must not vanish");
      expect(await findInThread(/I couldn't send that to CI Hardening\./)).toBeTruthy();
      // …and no "I'll send it the moment it's ready" promise either — that lie is the same shape.
      expect(queryInThread(/still starting up/)).toBeNull();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("must not vanish");
    },
  );

  // The prompt-side throwing path. Worse than silence here: the catch is also the ONLY thing
  // returning false on an exception, so deleting it discards the user's draft (roborev 53111).
  it("a THROWING prompt says so AND gives the draft back", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockRejectedValueOnce(new Error("pty write failed"));
    renderWithTarget();
    await send("worth not retyping");
    expect(await findInThread(/^I couldn't reach CI Hardening's terminal\.$/)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("worth not retyping");
  });

  it("puts the draft BACK in the box when the send fails", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    await send("a paragraph nobody wants to retype");
    await findInThread(/didn't send/i);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "a paragraph nobody wants to retype",
    );
  });

  it("does NOT restore the draft on a successful send", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "free-text" });
    renderWithTarget();
    await send("landed fine");
    await findInThread(/→ Sent to CI Hardening/);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  // The aim is captured AT SUBMIT, not re-read when the queue reaches the message: selection moves
  // for reasons unrelated to the box (a nudge's "Show me", a notification reveal, a tab click), and
  // a late lookup would deliver the user's paragraph to whichever agent happened to be selected
  // (roborev 46284-M4). Pinning used to be the toggle's job; with routing it is the queue's.
  it("delivers a QUEUED send to the agent aimed at when THAT message was submitted", async () => {
    let release: (() => void) | undefined;
    h.routeMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ target: "agent", reason: "test", source: "heuristic" });
        }),
    );
    const { rerender } = renderWithTarget();
    type("for the agent I aimed at");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    // Something else changes the selected agent while the send is still routing.
    const feed2 = feedWith("approval") as ConciergeFeed;
    (feed2.projects[0]!.agents as unknown[]).push({
      ...feed2.projects[0]!.agents[0]!,
      id: "other",
      name: "Something Else",
    });
    h.feed = feed2;
    await act(async () => {
      rerender(
        <ConciergeHost
          feed={feed2}
          promptTarget={{ projectId: "p1", agentId: "other", name: "Something Else" }}
        />,
      );
    });
    await act(async () => {
      release!();
    });
    await waitFor(() =>
      expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "for the agent I aimed at", {
        userPrompt: true,
        display: "for the agent I aimed at",
        namingBasis: "for the agent I aimed at",
      }),
    );
  });

  // Two sends whose ROUTING resolves out of order must still reach the PTY in submit order —
  // routing is a network round trip, so without the chain the second can overtake the first and
  // silently reorder the user's instructions.
  it("delivers rapid sends in submit order even when routing resolves out of order", async () => {
    const toAgent = { target: "agent" as const, reason: "test", source: "heuristic" as const };
    // "first" routes SLOWLY, "second" instantly — the exact race that would reorder PTY writes.
    // Keyed on the TEXT, not on call order: the chain means the second send's classify does not
    // even start until the first has settled, so a positional mock would hand the second send's
    // gate to a call that never happens.
    let releaseFirst: (() => void) | undefined;
    h.routeMessage.mockImplementation((text: string) =>
      text === "first"
        ? new Promise((resolve) => {
            releaseFirst = () => resolve(toAgent);
          })
        : Promise.resolve(toAgent),
    );
    renderWithTarget();
    type("first");
    type("second");
    // The chain starts on a microtask, so wait until "first" is actually in flight before
    // releasing it — otherwise the gate doesn't exist yet and the test proves nothing.
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await act(async () => {
      releaseFirst!();
    });
    await waitFor(() => expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(2));
    expect(h.dispatchConciergeAnswer.mock.calls.map((c) => c[1])).toEqual(["first", "second"]);
  });

  // The aim is captured before a NETWORK call. If the agent closes while we classify, dispatching
  // at it surfaces as pty-gone where the router's own design says to take the safe direction.
  it("falls back to Sparkle when the agent disappears mid-routing", async () => {
    let release: (() => void) | undefined;
    h.routeMessage.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ target: "agent", reason: "test", source: "heuristic" });
        }),
    );
    const { rerender } = renderWithTarget();
    type("meant for the agent");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    // The agent is closed while the classify is in flight.
    const empty = { projects: [], counts: EMPTY_COUNTS, scopedCounts: EMPTY_COUNTS, pinnedProjectId: null };
    await act(async () => {
      rerender(<ConciergeHost feed={empty as unknown as ConciergeFeed} promptTarget={null} />);
    });
    await act(async () => {
      release!();
    });
    await settle();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // The box clears on submit, so a bubble that waited for routing left a second rapid send with no
  // visible state at all for up to the route deadline plus a round trip.
  it("shows both bubbles immediately, even while the first is still routing", async () => {
    h.routeMessage.mockImplementation(() => new Promise(() => {}));
    renderWithTarget();
    type("first");
    type("second");
    expect(inThread("first")).toBeTruthy();
    expect(inThread("second")).toBeTruthy();
  });

  // The queue must always settle FULFILLED: a rejected promise parked in the chain hands the
  // rejection to ComposeBox, whose `.then(ok => …)` has no rejection arm — so the draft would not
  // be restored and the user's text would be lost.
  it("a REJECTING send does not stall the one queued behind it", async () => {
    routeToAgent();
    h.routeMessage.mockRejectedValueOnce(new Error("router exploded"));
    renderWithTarget();
    type("doomed");
    await settle();
    await send("but this one lands");
    await settle();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith(
      "ag1",
      "but this one lands",
      expect.anything(),
    );
  });
});

// The receipt is what makes inference defensible (PRD §3). Without it a misroute is silent, which
// is precisely the objection the removed target toggle existed to answer.
describe("ConciergeHost — routing receipts", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  function renderWithTarget(t: typeof target | null = target) {
    h.feed = feedWith("approval");
    return render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={t} />);
  }

  async function send(text: string) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
  }

  it("names the agent on a message routed to the terminal", async () => {
    routeToAgent();
    renderWithTarget();
    await send("add retry logic");
    expect(await within(thread()).findByText("→ Sent to CI Hardening")).toBeTruthy();
  });

  it("says a chat answer landed here", async () => {
    renderWithTarget();
    await send("what's going on?");
    expect(await within(thread()).findByText("→ Answered here")).toBeTruthy();
  });

  // "→ Sent to CI Hardening" over a message that never arrived would be a plain lie; the failure
  // is already explained in the thread.
  it("posts NO receipt when the delivery failed", async () => {
    routeToAgent();
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    await send("never lands");
    await findInThread(/didn't send/i);
    expect(within(thread()).queryByTestId("routing-receipt")).toBeNull();
  });

  it("redirects a chat answer into the agent, on one click", async () => {
    renderWithTarget();
    await send("was that right?");
    await within(thread()).findByText("→ Answered here");
    await act(async () => {
      fireEvent.click(screen.getByTestId("routing-redirect"));
    });
    await settle();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "was that right?", {
      userPrompt: true,
      display: "was that right?",
      namingBasis: "was that right?",
    });
  });

  it("redirects an agent-bound message into the chat, on one click", async () => {
    routeToAgent();
    renderWithTarget();
    await send("add retry logic");
    await within(thread()).findByText("→ Sent to CI Hardening");
    await act(async () => {
      fireEvent.click(screen.getByTestId("routing-redirect"));
    });
    await settle();
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
  });

  // A redirect RE-SENDS; it never retracts. Text already in a PTY cannot be pulled back, so the
  // line must state BOTH destinations in the order they happened — and the button is consumed,
  // because a message that has gone both ways has nowhere left to go.
  it("records BOTH destinations after a redirect, and retires the button", async () => {
    renderWithTarget();
    await send("both ways");
    await act(async () => {
      fireEvent.click(screen.getByTestId("routing-redirect"));
    });
    await settle();
    expect(await within(thread()).findByText("→ Answered here, then to CI Hardening")).toBeTruthy();
    expect(screen.queryByTestId("routing-redirect")).toBeNull();
    expect(within(thread()).queryByText(/instead|moved|undone/i)).toBeNull();
  });

  // With the target pill gone the receipt is the ONLY routing signal a screen-reader user gets, so
  // rendering it without announcing it would leave them with nothing.
  it("announces the routing through the column's live region", async () => {
    routeToAgent();
    renderWithTarget();
    await send("add retry logic");
    expect(screen.getByTestId("concierge-announcer").textContent).toBe("→ Sent to CI Hardening");
  });

  it("leaves only the latest receipt redirectable", async () => {
    renderWithTarget();
    await send("first");
    await send("second");
    expect(screen.getAllByTestId("routing-receipt").length).toBe(2);
    expect(screen.getAllByTestId("routing-redirect").length).toBe(1);
  });

  // The relay is async and the button stays mounted until the receipt updates, so an impatient
  // second click passed the alsoSentTo guard twice and wrote the same text into the terminal
  // twice — irreversible, with the receipt still reading as a single redirect.
  it("a double-tap on the redirect delivers ONCE", async () => {
    renderWithTarget();
    await send("only once please");
    const button = screen.getByTestId("routing-redirect");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await settle();
    await settle();
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledTimes(1);
  });

  // The label ("Also ask CI Hardening") is an explicit promise made BEFORE the click, and the
  // selection moves for reasons unrelated to this thread.
  it("delivers to the agent the BUTTON NAMED, even after the selection moves", async () => {
    const { rerender } = renderWithTarget();
    await send("for CI Hardening");
    const feed2 = feedWith("approval") as ConciergeFeed;
    (feed2.projects[0]!.agents as unknown[]).push({
      ...feed2.projects[0]!.agents[0]!,
      id: "other",
      name: "Something Else",
    });
    h.feed = feed2;
    await act(async () => {
      rerender(
        <ConciergeHost
          feed={feed2}
          promptTarget={{ projectId: "p1", agentId: "other", name: "Something Else" }}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("routing-redirect"));
    });
    await settle();
    expect(h.dispatchConciergeAnswer.mock.calls[0]![0]).toBe("ag1");
  });

  it("says so rather than silently dropping a redirect whose agent has closed", async () => {
    const { rerender } = renderWithTarget();
    await send("nowhere to go");
    const empty = { projects: [], counts: EMPTY_COUNTS, scopedCounts: EMPTY_COUNTS, pinnedProjectId: null };
    await act(async () => {
      rerender(<ConciergeHost feed={empty as unknown as ConciergeFeed} promptTarget={null} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("routing-redirect"));
    });
    await settle();
    expect(await findInThread(/isn't open any more, so I couldn't pass the message along/)).toBeTruthy();
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });
});

// The recommended-action row, re-homed above the compose box (PRD §4). Real build agents lost their
// composer at CM-U7 and the suggestion row went with it; this is where it lives now.
describe("ConciergeHost — recommended actions", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  it("mounts the row for the actively-shown agent", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={target} />);
    expect(screen.getByTestId("suggestions-row").getAttribute("data-agent")).toBe("ag1");
    expect(h.suggestionVisible).toBe(true);
  });

  // The engine follows the SELECTION; only the rendering follows the VIEW. Unmounting the hook
  // when the user glances at the Plan board would silently stop auto-approve (roborev 53074).
  it("keeps the engine mounted but hidden when the agent's pane isn't shown", () => {
    h.feed = feedWith("approval");
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={target}
        promptTargetShown={false}
      />,
    );
    expect(screen.getByTestId("suggestions-row")).toBeTruthy();
    expect(h.suggestionVisible).toBe(false);
  });

  // The other half of promptTargetShown: an imperative typed while looking at the Plan board must
  // not be written into a terminal the user cannot see.
  it("a send is NOT routed at an agent whose pane isn't shown", async () => {
    h.feed = feedWith("approval");
    render(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={target}
        promptTargetShown={false}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "add retry logic" } });
    fireEvent.click(screen.getByText("Send"));
    await settle();
    expect(h.routeMessage).toHaveBeenCalledWith("add retry logic", { agent: null });
  });

  it("mounts NO row when no build agent is in view", () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={null} />);
    expect(screen.queryByTestId("suggestions-row")).toBeNull();
  });

  // useSuggestions owns ONE agent per instance by design; a shared instance with a changing id kept
  // the previous agent's buttons on screen and would write their keystroke into the newly-selected
  // agent's PTY (roborev 53043 HIGH). key={agentId} is what makes each a fresh instance.
  it("gives each agent its OWN row instance rather than reusing one", async () => {
    const feed2 = feedWith("approval") as ConciergeFeed;
    (feed2.projects[0]!.agents as unknown[]).push({
      ...feed2.projects[0]!.agents[0]!,
      id: "ag2",
      name: "Other Agent",
    });
    h.feed = feed2;
    const { rerender } = render(
      <ConciergeHost feed={feed2} promptTarget={target} />,
    );
    await act(async () => {
      rerender(
        <ConciergeHost
          feed={feed2}
          promptTarget={{ projectId: "p1", agentId: "ag2", name: "Other Agent" }}
        />,
      );
    });
    expect(h.suggestionMounts).toEqual(["ag1", "ag2"]);
  });

  // QUEUE ONCE. onApply wraps the WHOLE action, so the delivery it calls must not queue again:
  // a second enqueue would chain onto the very promise awaiting it — a circular wait broken only
  // by the 30s task timeout, i.e. a stall of every send, redirect and Approve (roborev 53196).
  it("queues a suggestion ONCE — the delivery inside onApply must not re-enter the queue", async () => {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={target} />);
    const props = h.suggestionProps!;
    let delivered = false;
    await act(async () => {
      await props.onApply(async () => {
        delivered = await props.onDeliverPrompt("do the thing");
        return delivered;
      });
    });
    expect(delivered).toBe(true);
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "do the thing", {
      userPrompt: true,
      display: "do the thing",
      namingBasis: "do the thing",
    });
    // A suggestion click posts no receipt, so this is the one delivery that DOES say so itself.
    expect(await findInThread(/^Sent to CI Hardening\.$/)).toBeTruthy();
  });
});
// A queued prompt is a PROMISE ("I'll send that when it's ready"). Whatever happens to it later
// has to come back into the thread, or the user is told something that never becomes true.
describe("ConciergeHost — reconciling a queued prompt", () => {
  function renderHost() {
    h.feed = feedWith("approval");
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
  }

  it("confirms the delayed delivery once the agent comes up", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: true, path: "free-text", agentId: "ag1", sent: "start on the docs" }));
    // Includes the QUOTE: every test here passes `sent`, but none asserted it, so dropping the
    // interpolation passed — and the quote is the only thing telling the user WHICH held message
    // an outcome refers to when several were queued (roborev 53123).
    expect(
      await findInThread(/CI Hardening is up — I sent your message \("start on the docs"\)\./),
    ).toBeTruthy();
  });

  it("says so when the hold aged out instead of leaving the promise dangling", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "never sent" }));
    // The quote matters MOST here: this is the arm whose copy explicitly instructs the user to
    // send it again, and flushPendingSends emits one expired outcome per aged-out entry, so an
    // unattributable message is the costliest of the three (roborev 53162).
    expect(
      await findInThread(/never came up, so I dropped the message I was holding \("never sent"\)\./),
    ).toBeTruthy();
  });

  it("says so when the terminal closed before the held prompt could land", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "pty-gone", agentId: "ag1", sent: "gone" }));
    expect(
      await findInThread(/closed before I could send the message I was holding \("gone"\)\./),
    ).toBeTruthy();
  });

  // An UNKNOWN path must not inherit the terminal-closed wording. `pty-gone` is now its own arm,
  // so the catch-all gives a reason it can always stand behind — letting a new path fall into a
  // specific claim is exactly how 46485-M shipped a falsehood the first time (roborev 53162).
  //
  // The assertion is BRANCH-SPECIFIC on the catch-all's own verb — "didn't", where `abandoned`
  // says "couldn't". They were briefly identical (which un-pinned `abandoned` outright), then
  // prefix-related (which left them separable only by the `$` below). Distinct words mean this row
  // keeps working even if someone later writes an unanchored matcher (roborev 53187/53198).
  //
  // Driven by `agent-failed`: a real union member that has no arm TODAY. If it ever gains one,
  // this row fails loudly and should be repointed at another armless member.
  it("a path the ladder doesn't know states only the reason — no terminal claim, no wrong remedy", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "agent-failed", agentId: "ag1", sent: "held" }));
    expect(
      await findInThread(/^CI Hardening didn't take the message I was holding \("held"\)\.$/),
    ).toBeTruthy();
    expect(queryInThread(/terminal closed before I could send/)).toBeNull();
    // Not the `abandoned` arm's wording, and no remedy: `agent-failed` needs a Retry and a cloud
    // agent is never "running" locally, so that instruction would never come true.
    expect(queryInThread(/couldn't take the message/)).toBeNull();
    expect(queryInThread(/Send it again once it's running/)).toBeNull();
  });

  // The ABANDONED arm — the one branch here that ALREADY shipped a falsehood once. Its own comment
  // records the history: `abandoned` used to be reported as "the terminal closed", which is false
  // when the spawn failed and no terminal ever opened (roborev 46485-M). Nothing held the corrected
  // string, so mis-gating it drops through to the else and reinstates exactly that lie, green
  // (roborev 53123). The negative half matters most — these two lines are what drifted before.
  it("says the agent couldn't TAKE the held message — not that a terminal closed", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "abandoned", agentId: "ag1", sent: "held" }));
    // WITH the quote: it matters most on non-delivery. `abandonPendingSends` emits one outcome per
    // held entry, so several of these can land for the same agent at once, and the quote is the
    // only thing telling the user which text to retype (roborev 53142).
    // Anchored on the FULL abandoned line including its remedy clause — that clause is what
    // separates this arm from the catch-all, so matching only the reason would let a mis-gated
    // `abandoned` fall through and still pass (roborev 53187).
    expect(
      await findInThread(
        /^CI Hardening couldn't take the message I was holding \("held"\)\. Send it again once it's running\.$/,
      ),
    ).toBeTruthy();
    expect(queryInThread(/terminal closed before I could send|never came up/)).toBeNull();
  });

  // The `?? "that agent"` fallback is a LIVE path: the outcome can arrive after the agent has left
  // the feed. Nothing covered it, so a change to a non-guarding form would render
  // "undefined is up — I sent your message" — the same literal-undefined report the matchedLabel
  // guard was added to prevent one commit ago (roborev 53123).
  it("names an agent that has left the feed generically, never 'undefined'", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: true, path: "free-text", agentId: "gone-from-feed", sent: "x" }));
    expect(await findInThread(/^that agent is up — I sent your message \("x"\)\.$/)).toBeTruthy();
    expect(queryInThread(/undefined/)).toBeNull();
  });

  it("quotes the DISPLAY rendering back, never the payload with its temp paths", async () => {
    // The whole point of the three-way split (roborev 46911/46925): `sent` is the wire payload.
    // Quoting it here would print '/var/folders/…png look at this' into the thread — the one
    // surface `display` exists to protect — three lines below the code that avoids exactly that.
    renderHost();
    act(() =>
      h.deferred?.({
        ok: true,
        path: "free-text",
        agentId: "ag1",
        sent: "'/var/folders/x9/T/sparkle-shot-1753.png' look at this",
        display: "look at this · 1 image",
      }),
    );
    expect(await findInThread(/"look at this · 1 image"/)).toBeTruthy();
    expect(within(thread()).queryByText(/sparkle-shot-1753\.png/)).toBeNull();
  });
});

// DIGEST, don't enumerate (bead sparkle-4562.4). Eight P0s and nineteen P1s meant twenty-seven
// cards stacked above the compose box — the chat pushed off screen, and column one reduced to an
// unreadable copy of column two.
describe("ConciergeHost — digest instead of a card wall", () => {
  /** A feed with `n` needs-you agents in one project. */
  function feedOf(n: number) {
    const agents = Array.from({ length: n }, (_, i) => ({
      id: `ag${i}`,
      name: `Agent ${i}`,
      projectId: "p1",
      projectName: "sparkle-desktop",
      kind: "build" as const,
      status: "approval",
      statusColor: "#e0533f",
      statusLabel: "Approve?",
      band: "needs_you" as const,
      inScope: true,
      muted: false,
      topLevel: true,
      // Nothing above it in the tree, so no ancestor row can be speaking for it.
      representedElsewhere: false,
    }));
    const counts: Record<StatusBand, number> = { ...EMPTY_COUNTS, needs_you: n };
    return {
      projects: [{ id: "p1", name: "sparkle-desktop", inScope: true, counts, agents }],
      counts,
      scopedCounts: counts,
      pinnedProjectId: null,
    };
  }

  it("keeps the card when only one item needs attention", () => {
    h.feed = feedOf(1);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.queryByTestId("concierge-digest")).toBeNull();
    expect(inThread("Approve")).toBeTruthy(); // the card's action
  });

  it("collapses a wall of cards into ONE line", () => {
    h.feed = feedOf(8);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    const digests = screen.getAllByTestId("concierge-digest");
    expect(digests).toHaveLength(1);
    expect(digests[0]!.textContent).toContain("8 Need you in sparkle-desktop");
    // …and no per-agent cards survive to bury the chat.
    expect(queryInThread("Approve")).toBeNull();
  });

  it("the digest line hands off to column two", () => {
    h.feed = feedOf(5);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(screen.getByTestId("concierge-digest"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag0");
  });

  it("leaves the chat reachable — a reply still renders alongside the digest", async () => {
    h.feed = feedOf(8);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.done?.({ id: "1", text: "Here is what needs you." }));
    expect(await findInThread("Here is what needs you.")).toBeTruthy();
    expect(screen.getAllByTestId("concierge-digest")).toHaveLength(1);
  });
});
