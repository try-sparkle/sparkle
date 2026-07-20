// @vitest-environment jsdom
//
// The redesigned Think tab: a thin markdown chat over the user's OWN Claude Code (headless,
// streamed — NOT the Anthropic API), with Chief popping in from the project library and
// @mentionable expert voices. This covers the routing + wiring seams: plain text → Claude Code
// (+ a Chief interjection), @chief → Chief only, @<voice> → that expert voice only, the @-mention
// picker, "Make a Plan" → turnIntoPlan + switch to the Plan tab, and per-turn history capture.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chief client boundary — no network. startChat opens the @chief chat (and backs synthesis);
// sendMessage carries every FOLLOW-UP turn on that same chat (services/chiefThread.ts), so both
// must be stubbed or the lane can't run.
const startChat = vi.fn(() => Promise.resolve({ chat_id: "c1", message_id: "m1" }));
// Rest-typed so the test can assert WHICH chat id and prompt a follow-up carried.
const sendMessage = vi.fn((..._a: unknown[]) => Promise.resolve({ message_id: "m2" }));
const pollForResponse = vi.fn(() => Promise.resolve("Chief says hi"));
const ensureSkill = vi.fn(() => Promise.resolve("architect"));
vi.mock("../services/chief", () => {
  // Declared INSIDE the factory: vi.mock is hoisted above top-level consts, so a class referenced
  // here must live here too (else "Cannot access 'X' before initialization").
  class ChiefError extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = "ChiefError";
    }
  }
  return {
    ensureChiefProject: vi.fn(() => Promise.resolve("chief-proj")),
    startChat: (...a: unknown[]) => startChat(...(a as [])),
    sendMessage: (...a: unknown[]) => sendMessage(...(a as [])),
    pollForResponse: (...a: unknown[]) => pollForResponse(...(a as [])),
    ensureSkill: (...a: unknown[]) => ensureSkill(...(a as [])),
    createMemory: vi.fn(() => Promise.resolve({})),
    ChiefError,
    // Real-ish quota classifier so the friendlyError mapping is exercised, not stubbed away.
    isChiefQuotaError: (e: unknown) =>
      e instanceof ChiefError &&
      (e.status === 402 ||
        e.status === 429 ||
        /quota|out of credit|usage limit|insufficient/i.test(e.message)),
  };
});
vi.mock("../services/anthropic", () => ({ structuredJson: vi.fn(() => Promise.resolve({})) }));

// The headless Claude Code engine. sendClaudeChat drives onDelta/onDone synchronously so a "turn"
// resolves in the test without a real `claude` process.
const sendClaudeChat = vi.fn((opts: any) => {
  opts.onDelta("Hello ");
  opts.onDelta("world");
  opts.onDone({ sessionId: "sess-1", text: "Hello world" });
  return Promise.resolve(() => {});
});
// Keep the REAL classifyClaudeChatError (a pure fn) so the auth→reconnect wiring is genuinely tested.
vi.mock("../services/claudeChat", async () => {
  const actual = await vi.importActual<typeof import("../services/claudeChat")>("../services/claudeChat");
  return {
    resolveClaudePath: vi.fn(() => Promise.resolve("/usr/local/bin/claude")),
    sendClaudeChat: (...a: unknown[]) => sendClaudeChat(...(a as [any])),
    cancelClaudeChat: vi.fn(() => Promise.resolve()),
    classifyClaudeChatError: actual.classifyClaudeChatError,
  };
});
// The reconnect affordance mounts a real `claude login` PTY + probes preflight; stub both so the
// wiring is testable without xterm / a real binary.
vi.mock("./Terminal", () => ({
  Terminal: (p: { onExit?: () => void }) => (
    <button data-testid="login-terminal-exit" onClick={() => p.onExit?.()}>
      login-terminal
    </button>
  ),
}));
vi.mock("../services/claudeSpawn", () => ({
  SHELL: "/bin/zsh",
  buildClaudeLoginExec: () => "exec claude login",
}));
const checkClaudeSignedIn = vi.fn(() => Promise.resolve(true));
vi.mock("../preflight", () => ({
  checkClaudeSignedIn: (...a: unknown[]) => checkClaudeSignedIn(...(a as [])),
  refreshPreflight: vi.fn(() => Promise.resolve()),
}));

const chiefInterject = vi.fn((): Promise<string | null> => Promise.resolve(null));
vi.mock("../services/chiefParticipant", () => ({
  chiefInterject: (...a: unknown[]) => chiefInterject(...(a as [])),
}));
const answerAsVoice = vi.fn(() => Promise.resolve("The architect's take"));
vi.mock("../services/voiceAnswer", () => ({
  answerAsVoice: (...a: unknown[]) => answerAsVoice(...(a as [])),
}));

// Make-a-Plan composes synthesize + generate via turnIntoPlan — spy the leaf services.
const synthesizePrd = vi.fn(() =>
  Promise.resolve({ path: "PRD/x.md", filename: "x.md", title: "My Epic", content: "# My Epic" }),
);
const generateTasks = vi.fn(() => Promise.resolve({ epicId: "ep-1", taskIds: ["t1", "t2"] }));
vi.mock("../services/prd", () => ({
  synthesizePrd: (...a: unknown[]) => synthesizePrd(...(a as [])),
  writePrd: vi.fn(),
}));
vi.mock("../services/tasks", () => ({
  generateTasks: (...a: unknown[]) => generateTasks(...(a as [])),
  createBeadFull: vi.fn(),
  beadDepAdd: vi.fn(),
}));
vi.mock("../services/agentNaming", () => ({ maybeAutoName: vi.fn() }));
vi.mock("../services/thinkBridge", () => ({ registerThink: () => () => {} }));

// The MOCKED ChiefError class (declared in the vi.mock factory above) — the same class object
// chiefThread's `e instanceof ChiefError` status checks compare against.
import { ChiefError } from "../services/chief";
import { ThinkPanel, routeMessage, activeMentionToken, splitMentions } from "./ThinkPanel";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useHandoffStore } from "../stores/handoffStore";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { Project } from "../types";

const project = { id: "proj-1", name: "My Project", rootPath: "/repo/my-project" } as Project;

Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;

const recordSpy = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    chiefPat: "pat_test",
    runtimeChiefPat: "",
    chiefProjectByProject: { "proj-1": "chief-proj" },
    // AI features on by default — the AI-off test flips these and we reset here for isolation.
    aiAutoRename: true,
    cloudDictation: true,
    aiBrainstorm: true,
    aiComposer: true,
  } as never);
  // Think now requires the app to be bought (entitled) to actually SEND — the trial "visible-but-
  // locked" gate. Default the suite to an entitled user so the routing/wiring behavior is what's
  // under test; the dedicated lock test below flips `me` back to the anonymous-trial (null) state.
  useAuthStore.setState({
    me: { clerkUserId: "u", entitled: true, balanceCents: 20000, tokenVersion: 1 },
    tokenPresent: true,
    loading: false,
  });
  useHandoffStore.setState({ pending: null });
  useHistoryStore.setState({ record: recordSpy as never });
  useUiStore.setState({ workMode: "think" });
  useProjectStore.setState({ renameAgent: vi.fn() } as never);
});
afterEach(() => cleanup());

function typeAndSend(text: string) {
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: "Enter" });
}

// The headless `claude` path resolves on a microtask after mount; wait for the engine to be ready
// (header flips to "…in the room") before sending a plain turn, or sendToClaude would bail.
async function waitReady() {
  await screen.findByText(/in the room/);
}

describe("routeMessage", () => {
  it("routes plain text to Sparkle alone", () => {
    expect(routeMessage("how should I ship this?")).toEqual({
      question: "how should I ship this?",
      responders: [{ kind: "claude" }],
    });
  });
  it("a LEADING @chief is directed — Chief only, mention stripped", () => {
    expect(routeMessage("@chief what do you think?")).toEqual({
      question: "what do you think?",
      responders: [{ kind: "chief" }],
    });
  });
  it("a LEADING @voice is directed — that voice only", () => {
    const r = routeMessage("@architect review this design");
    expect(r.question).toBe("review this design");
    expect(r.responders).toEqual([{ kind: "voice", handle: "architect" }]);
  });
  it("a mention LATER in the message is additive — Sparkle + the mentioned entity", () => {
    const r = routeMessage("make a PRD for this. And @chief any suggestions?");
    expect(r.responders).toEqual([{ kind: "claude" }, { kind: "chief" }]);
    expect(r.question).toBe("make a PRD for this. And any suggestions?");
  });
  it("multiple non-leading mentions all chime in after Sparkle, de-duped in first-seen order", () => {
    const r = routeMessage("thoughts? @architect and @chief and @architect again");
    expect(r.responders).toEqual([
      { kind: "claude" },
      { kind: "voice", handle: "architect" },
      { kind: "chief" },
    ]);
  });
  it("ignores an unknown @token and falls back to Sparkle alone", () => {
    expect(routeMessage("email me @ bob about it").responders).toEqual([{ kind: "claude" }]);
  });
});

describe("splitMentions", () => {
  it("keeps the leading @ on recognized mentions and splits around them", () => {
    expect(splitMentions("hey @chief and @architect ok")).toEqual([
      { text: "hey " },
      { text: "@chief", handle: "chief" },
      { text: " and " },
      { text: "@architect", handle: "architect" },
      { text: " ok" },
    ]);
  });
  it("leaves unknown @tokens inline as plain text", () => {
    expect(splitMentions("mail @ bob and @nope")).toEqual([{ text: "mail @ bob and @nope" }]);
  });
  it("returns a single plain segment when there are no mentions", () => {
    expect(splitMentions("just text")).toEqual([{ text: "just text" }]);
  });
});

describe("activeMentionToken", () => {
  it("detects an in-progress mention before the caret", () => {
    expect(activeMentionToken("hey @arch", 9)).toEqual({ start: 4, query: "arch" });
  });
  it("returns null when the caret isn't in a mention", () => {
    expect(activeMentionToken("hey there", 9)).toBeNull();
  });
});

describe("ThinkPanel — routing + wiring", () => {
  it("plain text streams a Claude Code reply and records the turn", async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("hello there");
    await waitFor(() => {
      expect(sendClaudeChat).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Hello world")).toBeTruthy();
    });
    const opts = (sendClaudeChat.mock.calls[0] as any[])[0];
    expect(opts.cwd).toBe("/repo/my-project");
    expect(opts.claudePath).toBe("/usr/local/bin/claude");
    await waitFor(() => {
      const kinds = recordSpy.mock.calls.map((c: any) => c[0].kind);
      expect(kinds).toContain("prompt");
      expect(kinds).toContain("response");
    });
    await waitFor(() => expect(chiefInterject).toHaveBeenCalledTimes(1));
  });

  it("a Chief interjection pops in as its own message", async () => {
    chiefInterject.mockResolvedValueOnce("Heads up: PRD already covers auth.");
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("what about auth?");
    await waitFor(() => expect(screen.getByText("Heads up: PRD already covers auth.")).toBeTruthy());
  });

  it("@chief routes to Chief only — Claude Code stays silent", async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@chief what's the risk?");
    await waitFor(() => {
      expect(startChat).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Chief says hi")).toBeTruthy();
    });
    expect(sendClaudeChat).not.toHaveBeenCalled();
  });

  it("a second @chief turn continues the SAME chat instead of opening a new one", async () => {
    // The unit tests in chiefThread.test.ts can't see whether the component actually PERSISTS the
    // returned thread state across turns — a thread ref rebuilt on each render would still satisfy
    // them while silently reopening a chat per turn, which is the O(N^2) defect this fixes.
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();

    typeAndSend("@chief what's the risk?");
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));

    typeAndSend("@chief and the mitigation?");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    expect(startChat).toHaveBeenCalledTimes(1); // still ONE chat, not two
    expect(sendMessage.mock.calls[0]![2]).toBe("c1"); // the chat startChat opened

    // The follow-up carries only the undelivered turns — the first question is already in Chief's
    // own history and must not be re-sent.
    const followUp = sendMessage.mock.calls[0]![3] as string;
    expect(followUp).toContain("and the mitigation?");
    expect(followUp).not.toContain("what's the risk?");
  });

  // The bounded escape lives in the component (the thread ref is component state), so the service
  // tests can't see it. Same argument as the continuity test above.
  it("abandons the chat after two consecutive send failures, then re-seeds", async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();

    typeAndSend("@chief one?");
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));

    // A send failure with a status that does NOT explain itself — i.e. possibly a dead chat.
    sendMessage.mockRejectedValueOnce(new ChiefError("gateway", 502));
    typeAndSend("@chief two?");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    sendMessage.mockRejectedValueOnce(new ChiefError("gateway", 502));
    typeAndSend("@chief three?");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    // Two strikes: the chat is abandoned, so the NEXT turn opens a fresh one.
    startChat.mockClear();
    typeAndSend("@chief four?");
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));
  });

  it("does NOT abandon the chat over slow polls — a poll failure proves it is alive", async () => {
    // The regression this guards: counting poll failures abandoned a healthy chat and pushed the
    // next turn onto the full re-seed, the exact oversized payload the lane exists to avoid.
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();

    typeAndSend("@chief one?");
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));

    pollForResponse.mockRejectedValueOnce(new ChiefError("Chief took too long", 408));
    typeAndSend("@chief two?");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    pollForResponse.mockRejectedValueOnce(new ChiefError("Chief took too long", 408));
    typeAndSend("@chief three?");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    startChat.mockClear();
    typeAndSend("@chief four?");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));

    expect(startChat).not.toHaveBeenCalled(); // still the same chat — never abandoned
    expect(sendMessage.mock.calls[2]![2]).toBe("c1");
  });

  it("does NOT abandon the chat over repeated out-of-credits — 402 is not chat death", async () => {
    // Out of credits persists across turns by its nature, so counting it would abandon a live chat
    // and re-seed a LARGER prompt than the delta that just failed.
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();

    typeAndSend("@chief one?");
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));

    // Assert a GROWING count: `toHaveBeenCalled()` would be satisfied by the first iteration's
    // call, so the second turn wouldn't wait for its own send to be issued and rejected — it would
    // be superseded, its catch would return early, and the test would pass without the 402
    // exclusion doing any work at all.
    const questions = ["two?", "three?"];
    for (const [i, q] of questions.entries()) {
      sendMessage.mockRejectedValueOnce(new ChiefError("out of credits", 402));
      typeAndSend(`@chief ${q}`);
      await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(i + 1));
    }

    startChat.mockClear();
    typeAndSend("@chief four?");
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
    expect(startChat).not.toHaveBeenCalled();
  });

  it("@<voice> routes to that expert voice — Claude Code stays silent", async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@architect is this scalable?");
    await waitFor(() => {
      expect(answerAsVoice).toHaveBeenCalledTimes(1);
      expect(screen.getByText("The architect's take")).toBeTruthy();
    });
    expect(sendClaudeChat).not.toHaveBeenCalled();
    const args = (answerAsVoice.mock.calls[0] as any[])[1];
    expect(args.voiceName).toBe("architect");
  });

  it("a non-leading @chief is additive — Sparkle answers AND Chief chimes in (no double Chief)", async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("build a billing system. and @chief any suggestions?");
    await waitFor(() => {
      expect(sendClaudeChat).toHaveBeenCalledTimes(1); // Sparkle
      expect(startChat).toHaveBeenCalledTimes(1); // Chief, explicitly
      expect(screen.getByText("Hello world")).toBeTruthy();
      expect(screen.getByText("Chief says hi")).toBeTruthy();
    });
    // Chief answered explicitly, so its automatic post-Sparkle interjection must be suppressed.
    expect(chiefInterject).not.toHaveBeenCalled();
    // The mention token is stripped from what Sparkle receives.
    const claudeArgs = (sendClaudeChat.mock.calls[0] as any[])[0];
    expect(claudeArgs.prompt).toBe("build a billing system. and any suggestions?");
  });

  it("typing @ opens the mention picker", async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "@" } });
    await waitFor(() => expect(screen.getByTestId("mention-picker")).toBeTruthy());
    expect(within(screen.getByTestId("mention-picker")).getByText("@chief")).toBeTruthy();
  });

  it('"Make a Plan" synthesizes, decomposes, and switches to the Plan tab', async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("let's build a thing");
    await waitFor(() => expect(screen.getByText("Hello world")).toBeTruthy());
    fireEvent.click(screen.getByText("Make a Plan"));
    await waitFor(() => {
      expect(synthesizePrd).toHaveBeenCalledTimes(1);
      expect(generateTasks).toHaveBeenCalledTimes(1);
      expect(useUiStore.getState().workMode).toBe("plan");
    });
  });

  it('"Make a Plan" is disabled until there is a conversation', () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    const btn = screen.getByText("Make a Plan") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("blocks the @chief path when AI features are off", async () => {
    // All four AI flags off → aiFeatureMode === "off". The Chief-backed paths must not fire.
    useSettingsStore.setState({
      aiAutoRename: false,
      cloudDictation: false,
      aiBrainstorm: false,
      aiComposer: false,
      aiSuggestedActions: false,
      aiAutoApprove: false,
    } as never);
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@chief what's the risk?");
    await waitFor(() => expect(screen.getByText(/AI features are off/)).toBeTruthy());
    expect(startChat).not.toHaveBeenCalled();
    // …and no unpaired prompt is recorded when the route is blocked.
    expect(recordSpy.mock.calls.some((c: any) => c[0].kind === "prompt")).toBe(false);
  });

  it("blocks the @voice path when AI features are off", async () => {
    useSettingsStore.setState({
      aiAutoRename: false,
      cloudDictation: false,
      aiBrainstorm: false,
      aiComposer: false,
      aiSuggestedActions: false,
      aiAutoApprove: false,
    } as never);
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@architect is this scalable?");
    await waitFor(() => expect(screen.getByText(/AI features are off/)).toBeTruthy());
    expect(answerAsVoice).not.toHaveBeenCalled();
  });

  it("blocks Make a Plan when AI features are off", async () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("let's build a thing");
    await waitFor(() => expect(screen.getByText("Hello world")).toBeTruthy());
    useSettingsStore.setState({
      aiAutoRename: false,
      cloudDictation: false,
      aiBrainstorm: false,
      aiComposer: false,
      aiSuggestedActions: false,
      aiAutoApprove: false,
    } as never);
    fireEvent.click(screen.getByText("Make a Plan"));
    await waitFor(() => expect(screen.getByText(/AI features are off/)).toBeTruthy());
    expect(synthesizePrd).not.toHaveBeenCalled();
  });

  it("Stop cancels an in-flight @chief turn — a late reply doesn't overwrite or record", async () => {
    let resolvePoll: (v: string) => void = () => {};
    pollForResponse.mockImplementationOnce(
      () => new Promise<string>((res) => (resolvePoll = res)),
    );
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@chief slow question");
    // The turn is in flight: Chief was asked, the Stop affordance is showing.
    await waitFor(() => expect(startChat).toHaveBeenCalledTimes(1));
    const stopBtn = await screen.findByText("Stop");
    fireEvent.click(stopBtn);
    // The poll resolves LATE, after the user stopped.
    await act(async () => {
      resolvePoll("LATE REPLY");
    });
    expect(screen.queryByText("LATE REPLY")).toBeNull();
    expect(recordSpy.mock.calls.some((c: any) => c[0].kind === "response")).toBe(false);
  });

  it("Stop cancels an in-flight @voice turn — a late answer doesn't overwrite or record", async () => {
    let resolveAnswer: (v: string) => void = () => {};
    answerAsVoice.mockImplementationOnce(
      () => new Promise<string>((res) => (resolveAnswer = res)),
    );
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@architect slow question");
    await waitFor(() => expect(answerAsVoice).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Stop"));
    await act(async () => {
      resolveAnswer("LATE VOICE ANSWER");
    });
    expect(screen.queryByText("LATE VOICE ANSWER")).toBeNull();
    expect(recordSpy.mock.calls.some((c: any) => c[0].kind === "response")).toBe(false);
  });

  it("echoes the user's message even when a Chief route is blocked by AI-off", async () => {
    useSettingsStore.setState({
      aiAutoRename: false,
      cloudDictation: false,
      aiBrainstorm: false,
      aiComposer: false,
      aiSuggestedActions: false,
      aiAutoApprove: false,
    } as never);
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@chief blocked but visible");
    // The typed message still shows in the thread (not silently discarded), with the error banner.
    // In the sent bubble the mention renders as a styled chip WITHOUT the "@" ("chief"), and the
    // rest of the text follows in its own segment.
    await waitFor(() => {
      expect(screen.getByText("chief")).toBeTruthy(); // the @-stripped, emphasized mention
      expect(screen.getByText(/blocked but visible/)).toBeTruthy();
    });
    expect(screen.getByText(/AI features are off/)).toBeTruthy();
  });

  it("visible-but-locked (trial): submitting shows the buy-to-use notice, fires no backend, keeps the text", async () => {
    // Anonymous trial: no token, no `me` → the app isn't bought, so Think is locked.
    useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
    render(<ThinkPanel project={project} agentId="a1" visible />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "help me think" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    // The buy-to-use notice appears and NO AI backend fires.
    await screen.findByText(/Buy Sparkle to think/);
    expect(screen.getByRole("button", { name: /Unlock Sparkle/ })).toBeTruthy();
    expect(sendClaudeChat).not.toHaveBeenCalled();
    expect(startChat).not.toHaveBeenCalled();
    expect(answerAsVoice).not.toHaveBeenCalled();
    // The typed text is preserved so the user can send it for real after buying.
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("help me think");
  });
});

describe("ThinkPanel — Sparkle auth failure surfaces a clear reason + reconnect", () => {
  it("translates 'Not logged in · Please run /login' into a reconnect message + button (no raw /login hint)", async () => {
    sendClaudeChat.mockImplementationOnce((opts: any) => {
      opts.onError("Not logged in · Please run /login");
      return Promise.resolve(() => {});
    });
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("hello there");
    // The reconnect button appears...
    const btn = await screen.findByRole("button", { name: /reconnect claude code/i });
    expect(btn).toBeTruthy();
    // ...and the cryptic terminal-only "/login" hint is NOT shown to the user.
    expect(screen.queryByText(/please run \/login/i)).toBeNull();
  });

  it("clicking Reconnect mounts the login terminal; a confirmed sign-in clears the affordance", async () => {
    checkClaudeSignedIn.mockResolvedValue(true);
    sendClaudeChat.mockImplementationOnce((opts: any) => {
      opts.onError("Not logged in · Please run /login");
      return Promise.resolve(() => {});
    });
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("hello there");
    fireEvent.click(await screen.findByRole("button", { name: /reconnect claude code/i }));
    // The login terminal (stubbed) mounts; firing its onExit runs the sign-in verification.
    fireEvent.click(await screen.findByTestId("login-terminal-exit"));
    await waitFor(() => expect(checkClaudeSignedIn).toHaveBeenCalled());
    // A confirmed sign-in retires the reconnect UI and prompts a retry.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /reconnect claude code/i })).toBeNull(),
    );
    await screen.findByText(/reconnected to claude code/i);
  });

  it("classifies an auth failure on the REJECTED-promise (spawn) path too, showing the reconnect button", async () => {
    // A synchronous spawn/invoke failure surfaces via the .catch path, not onError — it must
    // classify identically so an auth failure there also offers reconnect.
    sendClaudeChat.mockImplementationOnce(() =>
      Promise.reject(new Error("Not logged in · Please run /login")),
    );
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("hello there");
    expect(await screen.findByRole("button", { name: /reconnect claude code/i })).toBeTruthy();
    expect(screen.queryByText(/please run \/login/i)).toBeNull();
  });

  it("a usage-limit failure keeps claude's own text (with the reset time) and shows NO reconnect button", async () => {
    sendClaudeChat.mockImplementationOnce((opts: any) => {
      opts.onError("Claude usage limit reached. Your limit resets at 5:00pm.");
      return Promise.resolve(() => {});
    });
    render(<ThinkPanel project={project} agentId="a1" visible />);
    await waitReady();
    typeAndSend("hello there");
    // The message legitimately appears in both the chat bubble and the error line — assert ≥1.
    expect((await screen.findAllByText(/usage limit reached.*resets at 5:00pm/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /reconnect claude code/i })).toBeNull();
  });
});
