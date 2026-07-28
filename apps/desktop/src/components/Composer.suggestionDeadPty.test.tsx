// @vitest-environment jsdom
//
// A suggestion click whose keystroke reaches a DEAD PTY (roborev 54409).
//
// The click races the exit rather than being caught by the gate: `disabled` is derived from
// runtimeStore, which lags the real exit, so the button looks live and the write is attempted.
// `applySuggestion` throws PtyGoneError, and this composer has to undo the one thing it did BEFORE
// the write — `beforeTerminalWrite` renders the "always approve this?" nudge, which must read the
// screen first and therefore cannot wait for the write's result. Left standing, it offers to
// persist an auto-approve rule off a "Yes" that reached nothing, on an agent that is gone.
//
// Both halves are asserted against a fixture that ACTUALLY RAISES THE NUDGE — the success case
// below is what keeps the failure case from passing vacuously.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  write: vi.fn(() => Promise.resolve()),
  PtyGoneError: class PtyGoneError extends Error {},
}));

vi.mock("../pty", () => ({
  submitPrompt: vi.fn(() => Promise.resolve()),
  writePtyChainedStrict: (...a: unknown[]) => h.write(...(a as [])),
  PtyGoneError: h.PtyGoneError,
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The nudge fires only when the clicked value IS the classifier's approve option, the feature is
// on, and the category has no rule yet. Pin all three so the pre-write side effect really happens.
vi.mock("../services/suggestions/approvalClassifier", () => ({
  classifyApproval: () => ({ category: "edit", approveOption: "1\n" }),
}));
vi.mock("../services/suggestions/approvalsRuntime", () => ({
  useSyncProjectApprovals: () => {},
  effectiveApprovalRule: () => undefined,
  setApprovalRule: vi.fn(async () => {}),
}));
vi.mock("../services/aiGate", async (orig) => ({
  ...(await orig<typeof import("../services/aiGate")>()),
  aiFeatureNow: () => true,
}));
vi.mock("../services/terminalScrollback", () => ({
  getAgentScrollback: () => "Do you want to make this edit?\n1. Yes\n2. No",
}));

const suggestionButtons = vi.fn(() => [] as unknown[]);
vi.mock("../services/suggestions/useSuggestions", () => ({
  useSuggestions: () => ({
    buttons: suggestionButtons(),
    dismiss: vi.fn(),
    clear: vi.fn(),
    autoApproved: false,
  }),
}));

import { Composer } from "./Composer";
import { useProjectStore } from "../stores/projectStore";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

const APPROVE = {
  id: "p:1",
  label: "Yes",
  value: "1\n",
  kind: "terminal" as const,
  source: "heuristic" as const,
};

function seedAgent(): void {
  const agent: AgentTab = {
    id: "a1",
    name: "Build 1",
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: "/wt/a1",
    branch: null,
    baseBranch: null,
    lastPrompt: "Add Stripe checkout",
    promptHistory: [{ id: "h0", text: "Add Stripe checkout", at: 0, source: "composer" }],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
  const project: Project = {
    id: "p1",
    name: "Proj",
    rootPath: "/tmp/p",
    defaultBranch: "main",
    createdAt: "2026-01-01",
    agents: [agent],
    selectedAgentId: "a1",
  };
  useProjectStore.setState({ projects: [project] });
}

const pill = () => screen.getByRole("button", { name: APPROVE.label });
const historyOf = () =>
  useProjectStore.getState().projects[0]?.agents[0]?.promptHistory ?? [];

beforeEach(() => {
  h.write.mockReset();
  h.write.mockResolvedValue(undefined);
  suggestionButtons.mockReturnValue([APPROVE]);
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
  useUiStore.getState().setComposerMinimized(false);
  seedAgent();
});
afterEach(() => cleanup());

function renderComposer() {
  render(
    <Composer agentId="a1" active disabled={false} inputRef={{ current: null }} onSubmitPrompt={vi.fn()} />,
  );
}

describe("Composer — a suggestion click that reaches a dead PTY", () => {
  // The control case. Without it the assertions below would pass on a fixture that never raised
  // the nudge at all, which is the whole failure mode this file exists to rule out.
  it("raises the approval nudge on a click that DOES land", async () => {
    renderComposer();
    await userEvent.click(pill());
    await waitFor(() => expect(screen.getByTestId("approval-nudge")).toBeTruthy());
    expect(historyOf()).toHaveLength(2);
  });

  it("clears the nudge again when the keystroke reached nothing", async () => {
    h.write.mockRejectedValue(new h.PtyGoneError("a1"));
    renderComposer();
    await userEvent.click(pill());
    await waitFor(() => expect(screen.queryByTestId("approval-nudge")).toBeNull());
  });

  it("says so, instead of leaving a dead button", async () => {
    h.write.mockRejectedValue(new h.PtyGoneError("a1"));
    renderComposer();
    await userEvent.click(pill());
    await waitFor(() => expect(screen.getByText(/didn't go through/i)).toBeTruthy());
  });

  it("records no turn for a keystroke that never landed", async () => {
    // A picker turn advances the naming ladder's promptCount and consumes the first-turn deferral.
    h.write.mockRejectedValue(new h.PtyGoneError("a1"));
    renderComposer();
    await userEvent.click(pill());
    await waitFor(() => expect(screen.getByText(/didn't go through/i)).toBeTruthy());
    expect(historyOf()).toHaveLength(1);
  });
});
