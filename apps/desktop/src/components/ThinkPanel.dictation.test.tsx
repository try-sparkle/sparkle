// @vitest-environment jsdom
//
// Voice-dictation wiring for the Think composer. The Think tab shares the always-on ambient
// dictation pipeline with the build Composer via the dictation store's insert target. This covers
// the React glue that wires ThinkPanel into it: registering the visible pane as the insert target,
// NOT stealing it when backgrounded (so the build Composer / another Think pane keeps it), appending
// spoken text into the box, the live interim preview, and the mic-hot placeholder. Mirrors
// Composer.dictation.test.tsx.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Chief / interview / closed-loop boundaries — skip all network and background work, same as the
// brainstorm-capture test. We only exercise the composer's dictation glue here.
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
vi.mock("../services/anthropic", () => ({
  chatOnce: vi.fn(() => Promise.resolve("reply")),
  structuredJson: vi.fn(() => Promise.resolve({})),
}));
// The headless Claude Code engine — never touch a real PTY/tauri invoke in tests.
vi.mock("../services/claudeChat", () => ({
  resolveClaudePath: vi.fn(() => Promise.resolve("/usr/local/bin/claude")),
  sendClaudeChat: vi.fn(() => Promise.resolve(() => {})),
  cancelClaudeChat: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/chiefParticipant", () => ({ chiefInterject: vi.fn(() => Promise.resolve(null)) }));
vi.mock("../services/voiceAnswer", () => ({ answerAsVoice: vi.fn(() => Promise.resolve("ok")) }));
vi.mock("../services/prd", () => ({ synthesizePrd: vi.fn(), writePrd: vi.fn() }));
vi.mock("../services/tasks", () => ({
  generateTasks: vi.fn(),
  createBeadFull: vi.fn(),
  beadDepAdd: vi.fn(),
}));
vi.mock("../services/sendToBuild", () => ({ sendToBuild: vi.fn() }));
vi.mock("../services/thinkBridge", () => ({
  registerThink: () => () => {},
}));

import { ThinkPanel } from "./ThinkPanel";
import { useDictationStore } from "../stores/dictationStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useHandoffStore } from "../stores/handoffStore";
import type { Project } from "../types";

const project = { id: "proj-1", name: "My Project" } as Project;

// jsdom doesn't implement Element.scrollTo, which the transcript auto-scroll effect calls.
Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;

beforeEach(() => {
  useDictationStore.setState({
    insertTarget: null,
    enabled: true,
    status: "idle",
    interim: "",
    phase: "passive",
  });
  // Connected Chief + a pre-linked project so the panel renders the composer (not ConnectChief).
  useSettingsStore.setState({
    chiefPat: "pat_test",
    runtimeChiefPat: "",
    chiefProjectByProject: { "proj-1": "chief-proj" },
  });
  useHandoffStore.setState({ pending: null });
  useAuthStore.setState({ refresh: vi.fn(() => Promise.resolve()) });
});
afterEach(() => cleanup());

describe("ThinkPanel — dictation wiring", () => {
  it("registers the visible panel as the dictation insert target", () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    expect(typeof useDictationStore.getState().insertTarget).toBe("function");
  });

  it("does NOT register when the panel isn't visible (no stomping a focused composer)", () => {
    render(<ThinkPanel project={project} agentId="a1" visible={false} />);
    expect(useDictationStore.getState().insertTarget).toBeNull();
  });

  it("registers even without Chief — Claude Code chat works without a PAT", () => {
    // The redesign drops the hard ConnectChief gate: you can talk to Claude Code with no Chief
    // connected (only Chief participation / @chief / Make-a-Plan need a PAT). So the composer — and
    // its dictation registration — is live regardless of the PAT.
    useSettingsStore.setState({ chiefPat: "", runtimeChiefPat: "" });
    render(<ThinkPanel project={project} agentId="a1" visible />);
    expect(typeof useDictationStore.getState().insertTarget).toBe("function");
  });

  it("appends dictated text into the box (space-separated, not clobbered)", () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    act(() => useDictationStore.getState().insert("hello world"));
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toBe("hello world");
    act(() => useDictationStore.getState().insert("again"));
    expect(ta.value).toBe("hello world again");
  });

  it("shows the live interim transcript while the mic is hot, then clears it", () => {
    act(() => useDictationStore.setState({ status: "listening" }));
    render(<ThinkPanel project={project} agentId="a1" visible />);
    act(() => useDictationStore.getState().setInterim("hello wor"));
    expect(screen.getByText("hello wor")).toBeTruthy();
    act(() => useDictationStore.getState().setInterim(""));
    expect(screen.queryByText("hello wor")).toBeNull();
  });

  it("renders the interim preview ONLY in the visible pane (no cross-pane leak)", () => {
    act(() => useDictationStore.setState({ status: "listening" }));
    render(
      <>
        <ThinkPanel project={project} agentId="active" visible />
        <ThinkPanel project={project} agentId="hidden" visible={false} />
      </>,
    );
    act(() => useDictationStore.getState().setInterim("leaky words"));
    expect(screen.getAllByText("leaky words")).toHaveLength(1);
  });

  it("clears its insert registration on unmount", () => {
    const { unmount } = render(<ThinkPanel project={project} agentId="a1" visible />);
    expect(typeof useDictationStore.getState().insertTarget).toBe("function");
    act(() => unmount());
    expect(useDictationStore.getState().insertTarget).toBeNull();
  });

  it("an unmounting pane's cleanup does NOT clobber the pane that took the insert target", () => {
    // Two visible panes mount; the later one (B) registers last and owns the insert target.
    // Explicit keys so React unmounts A specifically — index-based reconciliation would otherwise
    // keep A's element and unmount B, inverting the scenario under test.
    const { rerender } = render(
      <>
        <ThinkPanel key="A" project={project} agentId="A" visible />
        <ThinkPanel key="B" project={project} agentId="B" visible />
      </>,
    );
    const owned = useDictationStore.getState().insertTarget;
    expect(typeof owned).toBe("function");
    // A goes away. Its cleanup runs, but the "only clear if still the registered target" guard
    // must leave B's registration intact.
    act(() =>
      rerender(
        <>
          <ThinkPanel key="B" project={project} agentId="B" visible />
        </>,
      ),
    );
    expect(useDictationStore.getState().insertTarget).toBe(owned);
  });

  it("swaps the placeholder to the mic-hot copy while ACTIVELY dictating", () => {
    act(() => useDictationStore.setState({ status: "listening", phase: "active" }));
    render(<ThinkPanel project={project} agentId="a1" visible />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("I'm listening, so just start talking.");
    expect(ta.placeholder).toContain("Sparkle, stop");
  });

  it("shows the wake-word placeholder when capturing but still passive (not yet dictating)", () => {
    act(() => useDictationStore.setState({ status: "listening", phase: "passive" }));
    render(<ThinkPanel project={project} agentId="a1" visible />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("Listening for the wake word.");
    expect(ta.placeholder).toContain("Hey Sparkle");
    expect(ta.placeholder).not.toContain("I'm listening, so just start talking.");
  });

  it("falls back to the think-out-loud placeholder when the mic is idle", () => {
    render(<ThinkPanel project={project} agentId="a1" visible />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("Talk to Sparkle about My Project");
    expect(ta.placeholder).not.toContain("I'm listening");
  });
});
