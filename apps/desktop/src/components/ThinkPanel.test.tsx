// @vitest-environment jsdom
//
// Brainstorm-capture wiring for ThinkPanel (Task D, bead ). The chat glue
// (Chief round-trip, metering, error surfacing) is exercised elsewhere; this covers the
// history-capture seam added at the user-submit and reply-complete boundaries: each turn
// must record exactly one `brainstorm` entry (a `prompt` on submit, a `response` when the
// reply resolves), scoped to the project, and never let a capture error break the chat.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chief boundary: skip the network. ensureChiefProject is unused here (the project is
// pre-linked), startChat seeds the conversation, pollForResponse yields the reply text.
const startChat = vi.fn(() => Promise.resolve({ chat_id: "c1", message_id: "m1" }));
const pollForResponse = vi.fn(() => Promise.resolve("Chief's reply"));
vi.mock("../services/chief", () => ({
  ensureChiefProject: vi.fn(() => Promise.resolve("chief-proj")),
  startChat: (...a: unknown[]) => startChat(...(a as [])),
  sendMessage: vi.fn(() => Promise.resolve({ message_id: "m2" })),
  pollForResponse: (...a: unknown[]) => pollForResponse(...(a as [])),
  ChiefError: class ChiefError extends Error {},
}));
// Metering wrapper: run the action straight through (no credit gate in this test).
vi.mock("../services/sparkleApi", () => ({
  meteredAi: <T,>(_action: unknown, run: () => Promise<T>) => run(),
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
  startChat.mockClear();
  pollForResponse.mockClear();
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
    pollForResponse.mockResolvedValueOnce("nudge reply");
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
});
