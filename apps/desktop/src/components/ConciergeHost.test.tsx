// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// Mock the data feed + the three side-effecting services so we test the HOST's wiring: user send →
// brain, nudge actions → dispatch/select/mute, brain deltas → thread. ConciergeColumn renders for real.
const h = vi.hoisted(() => ({
  feed: null as unknown,
  openProjectTab: vi.fn(),
  startConciergeTurn: vi.fn(async (_prompt: string) => {}),
  dispatchConciergeAnswer: vi.fn(async (): Promise<{ ok: boolean; path?: string }> => ({ ok: true })),
  setInterruptPreference: vi.fn(),
  deferred: undefined as
    | ((r: { ok: boolean; path: string; agentId: string; sent?: string }) => void)
    | undefined,
  brain: {} as {
    delta?: (e: { id: string; text: string }) => void;
    done?: (e: { id: string; text: string }) => void;
    error?: () => void;
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
  onConciergeError: (cb: () => void) => {
    h.brain.error = cb;
    return () => {};
  },
}));
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: h.dispatchConciergeAnswer,
  flushPendingSends: vi.fn(async () => []),
  onDeferredSendOutcome: (cb: (r: { ok: boolean; path: string; agentId: string; sent?: string }) => void) => {
    h.deferred = cb;
    return () => {};
  },
}));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: h.setInterruptPreference }) },
}));

import { ConciergeHost } from "./ConciergeHost";
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

describe("ConciergeHost", () => {
  it("surfaces an in-scope needing agent as a nudge with an Approve action", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    expect(screen.getAllByText(/CI Hardening/).length).toBeGreaterThan(0);
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText("Show me")).toBeTruthy();
  });

  it("Approve relays the answer into the agent's terminal", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(screen.getByText("Approve"));
    // userPrompt: false — "approve" is machine-authored; it must not enter prompt history,
    // debit a trial prompt, or feed the auto-name ladder (roborev 46251-H1).
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith("ag1", "approve", { userPrompt: false });
    expect(h.openProjectTab).not.toHaveBeenCalled();
  });

  it("Show me opens the source project's TAB and selects the agent", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(screen.getByText("Show me"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag1");
  });

  it("Mute records a do-not-interrupt preference for the agent", () => {
    h.feed = feedWith("blocked", 1);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(screen.getByText("Mute"));
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
    expect(screen.getByText("what needs me?")).toBeTruthy();
  });

  it("streams a brain reply into the thread (delta then done)", () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.delta?.({ id: "7", text: "On " }));
    act(() => h.brain.delta?.({ id: "7", text: "it." }));
    expect(screen.getByText("On it.")).toBeTruthy();
    act(() => h.brain.done?.({ id: "7", text: "On it — approving CI Hardening." }));
    expect(screen.getByText("On it — approving CI Hardening.")).toBeTruthy();
  });

  it("shows an error bubble when the brain can't be reached", async () => {
    h.feed = feedWith("approval", 0);
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    act(() => h.brain.error?.());
    expect(await screen.findByText(/couldn't reach my brain/i)).toBeTruthy();
  });

  it("surfaces feedback when an Approve can't be delivered (dead terminal)", async () => {
    h.feed = feedWith("approval", 0);
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    render(<ConciergeHost feed={h.feed as ConciergeFeed} />);
    fireEvent.click(screen.getByText("Approve"));
    expect(await screen.findByText(/terminal has closed/i)).toBeTruthy();
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
    expect(h.dispatchConciergeAnswer).toHaveBeenCalledWith(
      "ag1",
      "rebase onto main and re-run CI",
      { userPrompt: true },
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
    expect(toggle.disabled).toBe(true);
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
    expect(await screen.findByText(/Sent to CI Hardening/)).toBeTruthy();
  });

  it("surfaces the trial-spent refusal instead of pretending the prompt landed", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "trial-spent" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("one more");
    expect(await screen.findByText(/free trial is used up/i)).toBeTruthy();
  });

  it("says a queued prompt is waiting on the agent's start-up", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "queued" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("start on the docs");
    expect(await screen.findByText(/still starting up/i)).toBeTruthy();
  });

  it("reports a dead terminal rather than silently dropping the prompt", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("too late");
    expect(await screen.findByText(/didn't send/i)).toBeTruthy();
  });

  it("puts the draft BACK in the box when the send fails", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: false, path: "pty-gone" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("a paragraph nobody wants to retype");
    await screen.findByText(/didn't send/i);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "a paragraph nobody wants to retype",
    );
  });

  it("does NOT restore the draft on a successful send", async () => {
    h.dispatchConciergeAnswer.mockResolvedValueOnce({ ok: true, path: "free-text" });
    renderWithTarget();
    fireEvent.click(screen.getByTestId("send-target-toggle"));
    send("landed fine");
    await screen.findByText(/Sent to CI Hardening/);
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
    expect(await screen.findByText(/CI Hardening is up — I sent your message/)).toBeTruthy();
  });

  it("says so when the hold aged out instead of leaving the promise dangling", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "expired", agentId: "ag1", sent: "never sent" }));
    expect(await screen.findByText(/never came up, so I dropped the message/)).toBeTruthy();
  });

  it("says so when the terminal closed before the held prompt could land", async () => {
    renderHost();
    act(() => h.deferred?.({ ok: false, path: "pty-gone", agentId: "ag1", sent: "gone" }));
    expect(await screen.findByText(/closed before I could send/)).toBeTruthy();
  });
});
