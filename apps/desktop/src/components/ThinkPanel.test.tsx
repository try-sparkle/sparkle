// @vitest-environment jsdom
//
// The redesigned Think tab: a thin markdown chat over the user's OWN Claude Code (headless,
// streamed — NOT the Anthropic API), with Chief popping in from the project library and
// @mentionable expert voices. This covers the routing + wiring seams: plain text → Claude Code
// (+ a Chief interjection), @chief → Chief only, @<voice> → that expert voice only, the @-mention
// picker, "Make a Plan" → turnIntoPlan + switch to the Plan tab, and per-turn history capture.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chief client boundary — no network. startChat/pollForResponse back the @chief path + synthesis.
const startChat = vi.fn(() => Promise.resolve({ chat_id: "c1", message_id: "m1" }));
const pollForResponse = vi.fn(() => Promise.resolve("Chief says hi"));
const ensureSkill = vi.fn(() => Promise.resolve("architect"));
vi.mock("../services/chief", () => ({
  ensureChiefProject: vi.fn(() => Promise.resolve("chief-proj")),
  startChat: (...a: unknown[]) => startChat(...(a as [])),
  pollForResponse: (...a: unknown[]) => pollForResponse(...(a as [])),
  ensureSkill: (...a: unknown[]) => ensureSkill(...(a as [])),
  createMemory: vi.fn(() => Promise.resolve({})),
  ChiefError: class ChiefError extends Error {},
}));
vi.mock("../services/anthropic", () => ({ structuredJson: vi.fn(() => Promise.resolve({})) }));

// The headless Claude Code engine. sendClaudeChat drives onDelta/onDone synchronously so a "turn"
// resolves in the test without a real `claude` process.
const sendClaudeChat = vi.fn((opts: any) => {
  opts.onDelta("Hello ");
  opts.onDelta("world");
  opts.onDone({ sessionId: "sess-1", text: "Hello world" });
  return Promise.resolve(() => {});
});
vi.mock("../services/claudeChat", () => ({
  resolveClaudePath: vi.fn(() => Promise.resolve("/usr/local/bin/claude")),
  sendClaudeChat: (...a: unknown[]) => sendClaudeChat(...(a as [any])),
  cancelClaudeChat: vi.fn(() => Promise.resolve()),
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

import { ThinkPanel, routeMessage, activeMentionToken } from "./ThinkPanel";
import { useSettingsStore } from "../stores/settingsStore";
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
  it("routes plain text to Claude Code", () => {
    expect(routeMessage("how should I ship this?")).toEqual({
      kind: "claude",
      question: "how should I ship this?",
    });
  });
  it("routes @chief to Chief only and strips the mention", () => {
    expect(routeMessage("@chief what do you think?")).toEqual({
      kind: "chief",
      question: "what do you think?",
    });
  });
  it("routes a known @voice to that voice and strips the mention", () => {
    const r = routeMessage("@architect review this design");
    expect(r.kind).toBe("voice");
    if (r.kind === "voice") {
      expect(r.handle).toBe("architect");
      expect(r.question).toBe("review this design");
    }
  });
  it("ignores an unknown @token and falls back to Claude", () => {
    expect(routeMessage("email me @ bob about it").kind).toBe("claude");
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
    } as never);
    render(<ThinkPanel project={project} agentId="a1" visible />);
    typeAndSend("@chief blocked but visible");
    // The typed message still shows in the thread (not silently discarded), with the error banner.
    await waitFor(() => expect(screen.getByText("@chief blocked but visible")).toBeTruthy());
    expect(screen.getByText(/AI features are off/)).toBeTruthy();
  });
});
