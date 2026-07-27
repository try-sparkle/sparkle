// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  dispatchConciergeAnswer: vi.fn(
    async (): Promise<{ ok: boolean; path?: ConciergeDispatchPath; matchedLabel?: string }> => ({
      ok: true,
    }),
  ),
  setInterruptPreference: vi.fn(),
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
vi.mock("../services/concierge", () => ({
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
  onDeferredSendOutcome: (cb: (r: DeferredOutcome) => void) => {
    h.deferred = cb;
    return () => {};
  },
}));
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
import type { ConciergeFeed } from "../useConciergeFeed";

function feedWith(status: string, priority: 0 | 1) {
  const agent = {
    id: "ag1",
    name: "CI Hardening",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status,
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    priority,
    inScope: true,
    muted: false,
  };
  return {
    projects: [{ id: "p1", name: "sparkle", inScope: true, counts: { p0: priority === 0 ? 1 : 0, p1: priority === 1 ? 1 : 0 }, agents: [agent] }],
    counts: { p0: priority === 0 ? 1 : 0, p1: priority === 1 ? 1 : 0 },
    scopedCounts: { p0: priority === 0 ? 1 : 0, p1: priority === 1 ? 1 : 0 },
    pinnedProjectId: null,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Queries scoped to the VISIBLE transcript. The column also renders a hidden `role="status"` live
 *  region carrying the last finished line (roborev 53010), so a document-wide getByText would match
 *  the same string twice — and would pass even if the visible thread stopped rendering it. */
const thread = () => screen.getByTestId("concierge-thread");
const inThread = (re: RegExp | string) => within(thread()).getByText(re);
const findInThread = (re: RegExp | string) => within(thread()).findByText(re);
const queryInThread = (re: RegExp | string) => within(thread()).queryByText(re);

describe("ConciergeHost", () => {
  it("surfaces an in-scope needing agent as a nudge with an Approve action", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.getAllByText(/CI Hardening/).length).toBeGreaterThan(0);
    expect(inThread("Approve")).toBeTruthy();
    expect(inThread("Show me")).toBeTruthy();
  });

  it("Approve relays the answer into the agent's terminal", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    // userPrompt: false — "approve" is machine-authored; it must not enter prompt history,
    // debit a trial prompt, or feed the auto-name ladder (roborev 46251-H1).
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "approve", { userPrompt: false });
    expect(h.openProjectTab).not.toHaveBeenCalled();
  });

  it("Show me opens the source project's TAB and selects the agent", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Show me"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag1");
  });

  it("Mute records a do-not-interrupt preference for the agent", () => {
    h.feed = feedWith("blocked", 1);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Mute"));
    expect(h.setInterruptPreference).toHaveBeenCalledWith("ag1", "mute");
  });

  it("sending a message starts a brain turn with a grounded snapshot", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "what needs me?" } });
    fireEvent.click(screen.getByText("Send"));
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    const snapshot = h.startConciergeTurn.mock.calls[0]![0];
    expect(snapshot).toContain("CI Hardening");
    expect(snapshot).toContain("what needs me?");
    // the user's message shows in the thread
    expect(inThread("what needs me?")).toBeTruthy();
  });

  it("streams a brain reply into the thread (delta then done)", () => {
    h.feed = feedWith("approval", 0);
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
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    const announcer = () => screen.getByTestId("concierge-announcer");
    act(() => h.brain.delta?.({ id: "7", text: "On " }));
    act(() => h.brain.delta?.({ id: "7", text: "it." }));
    expect(announcer().textContent).toBe("");
    act(() => h.brain.done?.({ id: "7", text: "" }));
    expect(announcer().textContent).toBe("On it.");
  });

  it("shows an error bubble when the brain can't be reached", async () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.error?.({ id: "t1", detail: "spawn failed" }));
    expect(await findInThread(/couldn't reach my brain/i)).toBeTruthy();
  });

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
    h.feed = feedWith("approval", 0);
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(remedy)).toBeTruthy();
    // …and NOT the generic dead end, nor any prompt-voice phrasing bleeding across.
    expect(queryInThread(/^I couldn't send the approval to/)).toBeNull();
    expect(queryInThread(/then send again|isn't wired up yet|pass it along/)).toBeNull();
  });

  it("an Approve refused as trial-spent says EXACTLY the shared trial line", async () => {
    h.feed = feedWith("approval", 0);
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
      h.feed = feedWith("approval", 0);
      h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
      render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
      fireEvent.click(inThread("Approve"));
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
    h.feed = feedWith("approval", 0);
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
    h.feed = feedWith("approval", 0);
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
    h.feed = feedWith("approval", 0);
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "queued" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(inThread("Approve"));
    expect(await findInThread(/is still starting up — I'll approve as soon as it's ready/)).toBeTruthy();
    expect(queryInThread(/^Approved — sent to/)).toBeNull();
  });
});

// The capability the removed AgentPane composer owned: type a prompt, have it reach an agent's
// terminal with all the side-effects that used to hang off Send (roborev 46251-H1 / 46260-M3).
describe("ConciergeHost — free-text prompt → the selected agent", () => {
  const target = { projectId: "p1", agentId: "ag1", name: "CI Hardening" };

  function renderWithTarget(t: typeof target | null = target) {
    h.feed = feedWith("approval", 0);
    return render(<ConciergeHost feed={h.feed as ConciergeFeed} promptTarget={t} />);
  }

  function send(text: string) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByText("Send"));
  }

  it("defaults to Sparkle — a send goes to the brain, not the agent", () => {
    renderWithTarget();
    send("what needs me?");
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("after flipping the target, a send is dispatched to the agent as a USER prompt", () => {
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("rebase onto main and re-run CI");
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
    // The brain is NOT also asked — the prompt went to the agent instead.
    expect(h.startConciergeTurn).not.toHaveBeenCalled();
  });

  it("names the target agent on the toggle and in the composer once flipped", () => {
    renderWithTarget();
    const toggle = screen.getByTestId("send-target-toggle");
    expect(toggle.textContent).toContain("Sparkle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("send-target-toggle").textContent).toContain("CI Hardening");
    expect(screen.getByLabelText("Message CI Hardening")).toBeTruthy();
  });

  it("the toggle is inert when there is no agent to prompt", () => {
    renderWithTarget(null);
    const toggle = screen.getByTestId("send-target-toggle") as HTMLButtonElement;
    // aria-disabled, not `disabled`: a disabled control gets no pointer events, so its title —
    // the only place a sighted user reads WHY — could never appear (roborev 49295). The click is
    // a no-op instead, which is what this case pins.
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    send("still chat");
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });

  it("confirms a delivered prompt in the thread", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "free-text" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("ship it");
    expect(await findInThread(/Sent to CI Hardening/)).toBeTruthy();
  });

  it("surfaces the trial-spent refusal instead of pretending the prompt landed", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "trial-spent" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("one more");
    // Exact string — the approve-side twin asserts the same literal, which is what pins that the
    // one branch both voices share actually stays shared.
    expect(await findInThread(TRIAL_SPENT_TEXT)).toBeTruthy();
  });

  it("says a queued prompt is waiting on the agent's start-up", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "queued" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("start on the docs");
    // Full phrase, not the /still starting up/ fragment both voices share: mis-wiring this branch
    // to the APPROVAL wording ("I'll approve as soon as it's ready") would pass on the fragment.
    expect(await findInThread(/still starting up — I'll send that the moment it's ready/)).toBeTruthy();
  });

  // The positive picker-option branch — the last untested "ok:true but not a plain send" report.
  // Mis-gating it (e.g. to "free-text") drops through to `if (r.ok)` → "Sent to CI Hardening.",
  // which silently loses WHICH option the user's text answered (roborev 53081).
  it("a prompt that answered a PICKER names the option it chose, not a plain send", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({
      ok: true, path: "picker-option", matchedLabel: "Yes",
    });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("yes");
    expect(await findInThread(/was asking something — I answered "Yes"/)).toBeTruthy();
    expect(queryInThread(/^Sent to CI Hardening\.$/)).toBeNull();
    // It returns true, so the draft is consumed rather than restored.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  // matchedLabel is OPTIONAL on the result type. Unguarded interpolation renders the literal
  // `I answered "undefined".` — an untrue report of exactly the kind this series removes. Today's
  // only picker-option return always sets it, but the type doesn't promise that and a second
  // return site would ship the bad string silently, so the branch falls back to the plain
  // confirmation rather than naming an option it doesn't have (roborev 53097).
  it("a picker-option result with NO label degrades truthfully — never 'I answered \"undefined\"'", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "picker-option" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("yes");
    // "I answered it" — NOT "Sent to X.", which would report the one thing that didn't happen:
    // on picker-option the text was matched to an option, not sent as a prompt.
    expect(await findInThread(/^CI Hardening was asking something — I answered it\.$/)).toBeTruthy();
    expect(queryInThread(/undefined/)).toBeNull();
    expect(queryInThread(/^Sent to CI Hardening\.$/)).toBeNull();
    // It still returns true, so the draft is consumed — a regression that treated the missing
    // label as a failure would restore the draft after a SUCCESSFUL send.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("reports a dead terminal rather than silently dropping the prompt", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("too late");
    expect(await findInThread(/didn't send/i)).toBeTruthy();
  });

  // The prompt-side twins of the Approve cases above — same paths, deliberately different copy (a
  // prompt can be re-sent, so it says "then send again"), and the draft still comes back. Patterns
  // are voice-unique in the other direction: none of them appear in the approval copy.
  it.each([
    ["agent-failed", /then send again/],
    ["cloud-agent", /isn't wired up yet/],
    ["ambiguous-picker", /answer with just the option/],
    // /didn't send/ is voice-unique but appears in THREE prompt-side branches, so it pins the voice
    // without pinning the path→copy mapping. "pass it along" is pty-gone's alone (roborev 53018).
    ["pty-gone", /pass it along/],
  ] as const)("a prompt refused as %s speaks in the PROMPT voice and keeps the draft", async (path, remedy) => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("worth not retyping");
    expect(await findInThread(remedy)).toBeTruthy();
    expect(queryInThread(/^I couldn't send that to/)).toBeNull();
    // No approval-voice phrasing bleeding across the shared table.
    expect(queryInThread(/the approval|open it to choose/)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("worth not retyping");
  });

  // `ok` is the ONLY test for delivery. A pass at the type-narrowing problem widened this branch to
  // `r.ok || r.path === "picker-option" || r.path === "free-text"`, which meant an ok:false result
  // carrying a delivered-looking path reported "Sent to X." and returned true — silently DISCARDING
  // the user's draft on a failure that used to restore it (roborev 53018). The two fields are
  // independent on ConciergeDispatchResult, so nothing but this test stops that coming back.
  it.each(["free-text", "picker-option", "queued"] as const)(
    "an ok:false result carrying the delivered path %s is still a refusal — draft kept",
    async (path) => {
      h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path });
      renderWithTarget();
      fireEvent.click(screen.getByTestId("send-target-toggle"));
      send("must not vanish");
      expect(await findInThread(/I couldn't send that to CI Hardening\./)).toBeTruthy();
      expect(queryInThread(/^Sent to CI Hardening\.$/)).toBeNull();
      // …and no "I'll send it the moment it's ready" promise either — that lie is the same shape.
      expect(queryInThread(/still starting up/)).toBeNull();
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("must not vanish");
    },
  );

  // The prompt-side throwing path. Worse than silence here: the catch is also the ONLY thing
  // returning false on an exception, so deleting it discards the user's draft (roborev 53111).
  it("a THROWING prompt says so AND gives the draft back", async () => {
    h.dispatchConciergeAnswer.mockRejectedValueOnce(new Error("pty write failed"));
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("worth not retyping");
    expect(await findInThread(/^I couldn't reach CI Hardening's terminal\.$/)).toBeTruthy();
    expect(queryInThread(/^Sent to CI Hardening\.$/)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("worth not retyping");
  });

  it("puts the draft BACK in the box when the send fails", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("a paragraph nobody wants to retype");
    await findInThread(/didn't send/i);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "a paragraph nobody wants to retype",
    );
  });

  it("does NOT restore the draft on a successful send", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "free-text" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("landed fine");
    await findInThread(/Sent to CI Hardening/);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  // The aim is PINNED when the toggle is flipped: selection moves for reasons unrelated to the box
  // (a nudge's "Show me", a notification reveal, a tab click), and a live lookup at send time would
  // deliver the user's paragraph to whichever agent happened to be selected (roborev 46284-M4).
  it("keeps prompting the agent that was aimed at, even after the selection moves", async () => {
    const { rerender } = renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    // Something else changes the selected agent under us.
    rerender(
      <ConciergeHost
        feed={h.feed as ConciergeFeed}
        promptTarget={{ projectId: "p9", agentId: "other", name: "Something Else" }}
      />,
    );
    expect(screen.getByTestId("send-target-toggle").textContent).toContain("CI Hardening");
    send("for the agent I aimed at");
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "for the agent I aimed at", {
      userPrompt: true,
      display: "for the agent I aimed at",
      namingBasis: "for the agent I aimed at",
    });
  });

  it("drops the aim when the agent it names disappears from the feed", async () => {
    const { rerender } = renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    expect(screen.getByTestId("send-target-toggle").getAttribute("aria-pressed")).toBe("true");
    // The agent is gone (closed / deleted): the feed no longer carries it.
    const empty = { projects: [], counts: { p0: 0, p1: 0 }, scopedCounts: { p0: 0, p1: 0 }, pinnedProjectId: null };
    await act(async () => {
      rerender(<ConciergeHost feed={empty as unknown as ConciergeFeed} promptTarget={null} />);
    });
    expect(screen.getByTestId("send-target-toggle").getAttribute("aria-pressed")).toBe("false");
    send("back to chat");
    expect(h.startConciergeTurn).toHaveBeenCalledTimes(1);
    expect(h.dispatchConciergeAnswer).not.toHaveBeenCalled();
  });
});

// A queued prompt is a PROMISE ("I'll send that when it's ready"). Whatever happens to it later
// has to come back into the thread, or the user is told something that never becomes true.
describe("ConciergeHost — reconciling a queued prompt", () => {
  function renderHost() {
    h.feed = feedWith("approval", 0);
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
