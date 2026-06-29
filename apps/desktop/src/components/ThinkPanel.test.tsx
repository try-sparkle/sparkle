// @vitest-environment jsdom
//
// Brainstorm-capture wiring for ThinkPanel (Task D, bead ). The chat glue
// (Chief round-trip, metering, error surfacing) is exercised elsewhere; this covers the
// history-capture seam added at the user-submit and reply-complete boundaries: each turn
// must record exactly one `brainstorm` entry (a `prompt` on submit, a `response` when the
// reply resolves), scoped to the project, and never let a capture error break the chat.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chief boundary: skip the network. The interview itself now runs on Claude-direct (anthropic),
// so the reply text comes from chatOnce below; Chief's startChat/pollForResponse remain mocked for
// the (here-isolated) librarian + synthesis paths.
vi.mock("../services/chief", () => ({
  ensureChiefProject: vi.fn(() => Promise.resolve("chief-proj")),
  startChat: vi.fn(() => Promise.resolve({ chat_id: "c1", message_id: "m1" })),
  sendMessage: vi.fn(() => Promise.resolve({ message_id: "m2" })),
  pollForResponse: vi.fn(() => Promise.resolve("…")),
  ensureSkill: vi.fn(() => Promise.resolve("sparkle-skeptic")),
  createMemory: vi.fn(() => Promise.resolve({})),
  wipeChiefLibrary: vi.fn(() => Promise.resolve(0)),
  listSkills: vi.fn(() => Promise.resolve([])),
  listAllAssets: vi.fn(() => Promise.resolve([])),
  ChiefError: class ChiefError extends Error {},
}));
// The interview engine: Claude-direct. chatOnce yields the assistant reply text per turn.
const chatOnce = vi.fn(() => Promise.resolve("Chief's reply"));
vi.mock("../services/anthropic", () => ({
  chatOnce: (...a: unknown[]) => chatOnce(...(a as [])),
  structuredJson: vi.fn(() => Promise.resolve({})),
}));
// Isolate the background librarian — its own tests cover it; here it must not fire timers/network.
vi.mock("../services/librarian", () => ({
  createLibrarian: () => ({ onUserTurn: vi.fn(), dispose: vi.fn() }),
}));
// Metering wrapper: run the action straight through (no credit gate in this test).
vi.mock("../services/sparkleApi", () => ({
  meteredAi: <T,>(_action: unknown, run: () => Promise<T>) => run(),
}));
// Closed-loop services — spied so the done→generate→build sequence can be driven + asserted.
const synthesizePrd = vi.fn();
const generateTasks = vi.fn();
const sendToBuildSpy = vi.fn(() => "build-1");
vi.mock("../services/prd", () => ({
  synthesizePrd: (...a: unknown[]) => synthesizePrd(...(a as [])),
  writePrd: vi.fn(),
}));
vi.mock("../services/tasks", () => ({
  generateTasks: (...a: unknown[]) => generateTasks(...(a as [])),
  createBeadFull: vi.fn(),
  beadDepAdd: vi.fn(),
}));
vi.mock("../services/sendToBuild", () => ({
  sendToBuild: (...a: unknown[]) => sendToBuildSpy(...(a as [])),
}));
// The think bridge registers a callback for the connectivity "status update" nudge; capture it
// so a test can fire a synthetic nudge through the same sendText path the bridge uses.
let nudge: ((text: string) => void) | null = null;
vi.mock("../services/thinkBridge", () => ({
  registerThink: (_id: string, cb: (text: string) => void) => {
    nudge = cb;
    return () => {
      nudge = null;
    };
  },
}));

import { ThinkPanel } from "./ThinkPanel";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useHistoryStore } from "../stores/historyStore";
import { useHandoffStore } from "../stores/handoffStore";
import type { Project } from "../types";

const project = { id: "proj-1", name: "My Project" } as Project;

// jsdom doesn't implement Element.scrollTo, which the transcript auto-scroll effect calls.
Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;

let record: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // mockReset (not mockClear) so a prior test's queued mockResolvedValueOnce can't leak forward.
  chatOnce.mockReset();
  chatOnce.mockResolvedValue("Chief's reply");
  // Connected Chief + a pre-linked Chief project so the panel renders the composer and
  // the send path skips ensureChiefProject.
  useSettingsStore.setState({
    chiefPat: "pat_test",
    runtimeChiefPat: "",
    chiefProjectByProject: { "proj-1": "chief-proj" },
  });
  useHandoffStore.setState({ pending: null });
  useAuthStore.setState({ refresh: vi.fn(() => Promise.resolve()) });
  record = vi.fn(() => Promise.resolve());
  useHistoryStore.setState({ record });
  synthesizePrd.mockReset();
  synthesizePrd.mockResolvedValue({
    path: "PRD/2026-x.md",
    filename: "2026-x.md",
    title: "X",
    content: "---\nepic: null\ntasks: []\n---\n\n# X",
  });
  generateTasks.mockReset();
  generateTasks.mockResolvedValue({
    epicId: "sparkle-ep",
    taskIds: ["sparkle-ep.1", "sparkle-ep.2"],
    updatedPrdContent: "---\nepic: \"sparkle-ep\"\n---\n\n# X",
  });
  sendToBuildSpy.mockClear();
});
afterEach(() => cleanup());

async function submit(text: string) {
  const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value: text } });
  fireEvent.keyDown(ta, { key: "Enter" });
}

describe("ThinkPanel — brainstorm history capture", () => {
  it("records one prompt entry on submit and one response entry after the reply resolves", async () => {
    render(<ThinkPanel project={project} agentId="agent-1" />);

    await submit("What have we decided?");

    // The reply must land (so the response entry gets recorded).
    await waitFor(() => expect(screen.getByText("Chief's reply")).toBeTruthy());

    const calls = record.mock.calls.map((c) => c[0]);
    const prompts = calls.filter((e) => e.kind === "prompt");
    const responses = calls.filter((e) => e.kind === "response");

    expect(prompts).toHaveLength(1);
    expect(responses).toHaveLength(1);

    expect(prompts[0]).toMatchObject({
      source: "brainstorm",
      kind: "prompt",
      text: "What have we decided?",
      projectId: "proj-1",
      projectName: "My Project",
      agentId: "agent-1",
      agentName: "Think",
    });
    expect(typeof prompts[0].id).toBe("string");
    expect(typeof prompts[0].createdAt).toBe("number");

    expect(responses[0]).toMatchObject({
      source: "brainstorm",
      kind: "response",
      text: "Chief's reply",
      projectId: "proj-1",
    });
  });

  it("does NOT record synthetic think-bridge nudges (only genuine user turns)", async () => {
    const { act } = await import("@testing-library/react");
    render(<ThinkPanel project={project} agentId="agent-1" />);

    // A real user turn first — this seeds the conversation (chatIdRef) so the nudge isn't skipped.
    await submit("real question");
    await waitFor(() => expect(screen.getByText("Chief's reply")).toBeTruthy());
    const beforeNudge = record.mock.calls.length;

    // Fire the connectivity "status update" nudge through the same sendText path the bridge uses.
    chatOnce.mockResolvedValueOnce("nudge reply");
    await act(async () => {
      nudge?.("status update: connectivity restored");
    });
    await waitFor(() => expect(screen.getByText("nudge reply")).toBeTruthy());

    // The synthetic nudge (prompt AND its response) must not pollute durable brainstorm history.
    expect(record.mock.calls.length).toBe(beforeNudge);
    const nudgeEntries = record.mock.calls
      .map((c) => c[0])
      .filter((e) => e.text.includes("connectivity restored") || e.text === "nudge reply");
    expect(nudgeEntries).toHaveLength(0);
  });

  it("does not break the chat when capture throws (fire-and-forget)", async () => {
    record = vi.fn(() => {
      throw new Error("storage down");
    });
    useHistoryStore.setState({ record });

    render(<ThinkPanel project={project} agentId="agent-1" />);
    await submit("still works?");

    // Despite record() throwing synchronously, the user message and Chief's reply both render.
    await waitFor(() => expect(screen.getByText("still works?")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Chief's reply")).toBeTruthy());
  });

  it("ignores a connectivity nudge on an untouched (empty) panel", async () => {
    const { act } = await import("@testing-library/react");
    render(<ThinkPanel project={project} agentId="agent-1" />);

    // Fire the nudge before the user has said anything — it must be a no-op (no synthetic turn).
    await act(async () => {
      nudge?.("status update: connectivity restored");
    });

    expect(chatOnce).not.toHaveBeenCalled();
    expect(screen.queryByText("nudge reply")).toBeNull();
    expect(screen.queryByText(/connectivity restored/)).toBeNull();
  });
});

describe("ThinkPanel — closed-loop actions (done → generate → build)", () => {
  it("gates each step on the prior result and calls the right service", async () => {
    render(<ThinkPanel project={project} agentId="agent-1" />);

    // Need a conversation before the PRD can be synthesized.
    await submit("we want offline mode");
    await waitFor(() => expect(screen.getByText("Chief's reply")).toBeTruthy());

    const imDone = screen.getByRole("button", { name: /I'm done/ });
    const genTasks = screen.getByRole("button", { name: /Generate tasks/ });
    const sendBuild = screen.getByRole("button", { name: /Send to Build/ });

    // Before synthesis: generate + send are disabled; done is enabled (conversation exists).
    expect((imDone as HTMLButtonElement).disabled).toBe(false);
    expect((genTasks as HTMLButtonElement).disabled).toBe(true);
    expect((sendBuild as HTMLButtonElement).disabled).toBe(true);

    // I'm done → synthesize PRD.
    fireEvent.click(imDone);
    await waitFor(() => expect(synthesizePrd).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((genTasks as HTMLButtonElement).disabled).toBe(false));
    expect((sendBuild as HTMLButtonElement).disabled).toBe(true);

    // Generate tasks → epic + children; send becomes enabled.
    fireEvent.click(genTasks);
    await waitFor(() => expect(generateTasks).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((sendBuild as HTMLButtonElement).disabled).toBe(false));

    // Send to Build → orchestrator seeded with the epic + PRD path.
    fireEvent.click(sendBuild);
    expect(sendToBuildSpy).toHaveBeenCalledWith({
      projectId: "proj-1",
      epicId: "sparkle-ep",
      prdPath: "PRD/2026-x.md",
    });
  });
});
