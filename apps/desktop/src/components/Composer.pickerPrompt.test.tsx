// @vitest-environment jsdom
//
// Task 2.3 of docs/superpowers/plans/2026-07-15-stage-driven-cta-and-fast-naming.md — LANDED via
// option (a) (tag entries + filter at display), the founder's call.
//
// THE FIX. promptCount only advances via appendPrompt, whose call sites are the Composer's
// onSubmitPrompt and the build seed. AskUserQuestion picker answers are neither — they're Claude
// Code's own TUI menu inside the PTY, answered via writePty — so a build agent interacting mostly
// through pickers sits at promptCount 1 forever, permanently parked in agentNaming's
// deferred_first_turn branch. Picker answers now ALSO go through appendPrompt, tagged
// source:"picker", so promptHistory.length (the promptCount the ladder reads) advances.
//
// WHY TAGGED, NOT PLAIN. appendPrompt feeds display surfaces, not just the naming ladder, and a
// terse answer must not reach them: the last-4 breadcrumb (spec §7) would evict the real request
// ("Add Stripe checkout…" → "Unlisted — direct link only › Yes, overwrite › …"), the pinned banner
// would show the answer, and the row's Jump has no xterm marker so it would report "scrolled out".
// So a picker entry carries source:"picker" and is filtered out of every display surface by
// components/promptHistory.ts::composerPrompts (used by PinnedPrompt via AgentPane and by the tray
// via useRosterPublisher), and appendPrompt leaves `lastPrompt` untouched for a picker send. The
// RAW store keeps the entry so naming sees it; only DISPLAY filters it. Persist bumped to v10 to
// backfill source:"composer" on legacy entries. Naming basis (workNamingBasis) skips picker entries
// too, so a non-tactical menu label is never chosen as a name.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writePty = vi.fn(() => Promise.resolve());
vi.mock("../pty", () => ({
  submitPrompt: vi.fn(() => Promise.resolve()),
  writePty: (...a: unknown[]) => writePty(...(a as [])),
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
// This seed gives the agent a real project rootPath, so Composer's useSyncProjectApprovals effect
// subscribes to config changes via Tauri's event `listen` — which has no backend under jsdom. Stub
// it to a no-op unsubscribe so the mount effect doesn't throw (siblings with a null root skip it).
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Drive the suggestion row directly: this is about what onSuggestionClick DOES with a
// terminal-kind button, not about how the engine came to offer one.
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
import { composerPrompts } from "./promptHistory";
import { useProjectStore } from "../stores/projectStore";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

const PICKER_ANSWER = {
  id: "p:1",
  label: "Unlisted — direct link only",
  value: "1\n",
  kind: "terminal" as const,
  source: "heuristic" as const,
};

function seedAgent(over: Partial<AgentTab> = {}): void {
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
    pinnedIndex: null,
    ...over,
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

// The pill itself, by EXACT name — the row also renders a "Dismiss {label}" sibling, so a
// substring match is ambiguous.
const pill = () => screen.getByRole("button", { name: PICKER_ANSWER.label });

const promptHistoryOf = (id: string) =>
  useProjectStore.getState().projects.find((p) => p.id === "p1")?.agents.find((a) => a.id === id)
    ?.promptHistory ?? [];

beforeEach(() => {
  writePty.mockClear();
  suggestionButtons.mockReturnValue([PICKER_ANSWER]);
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

describe("Composer — picker answers advance promptCount", () => {
  it("records the answer as a prompt turn so the naming ladder re-evaluates", async () => {
    renderComposer();
    await userEvent.click(pill());
    expect(promptHistoryOf("a1")).toHaveLength(2);
  });

  it("records the human-readable LABEL, not the bare keystroke", async () => {
    // "1\n" is meaningless as naming basis and worse as a breadcrumb row; the label at least
    // carries what the user actually chose.
    renderComposer();
    await userEvent.click(pill());
    expect(promptHistoryOf("a1")[1]?.text).toBe("Unlisted — direct link only");
  });

  it("tags the entry source:'picker' so display surfaces can filter it out", async () => {
    renderComposer();
    await userEvent.click(pill());
    const entries = promptHistoryOf("a1");
    expect(entries[0]?.source).toBe("composer"); // the seed prompt is untouched
    expect(entries[1]?.source).toBe("picker");
  });

  it("does NOT move lastPrompt — the pinned banner keeps the last real message", async () => {
    // The seed set lastPrompt="Add Stripe checkout"; a picker answer must not overwrite it, or the
    // banner would read "Unlisted — direct link only".
    renderComposer();
    await userEvent.click(pill());
    const agent = useProjectStore.getState().projects[0]?.agents[0];
    expect(agent?.lastPrompt).toBe("Add Stripe checkout");
  });

  it("composerPrompts hides the picker row from the breadcrumb while naming still counts it", async () => {
    renderComposer();
    await userEvent.click(pill());
    const raw = promptHistoryOf("a1");
    expect(raw).toHaveLength(2); // naming reads the raw list → promptCount advanced
    const shown = composerPrompts(raw);
    expect(shown).toHaveLength(1); // the breadcrumb sees only the real prompt
    expect(shown[0]?.text).toBe("Add Stripe checkout");
  });

  // The two below pin the invariants the fix must not break (recording is additive to the PTY
  // write, never a replacement).
  it("still sends the keystroke to the PTY — recording is additive, not a replacement", async () => {
    // A picker answer is interactive terminal input, not a metered send. It must keep taking the
    // writePty path (and keep bypassing the trial gate, exactly like typing into the terminal).
    renderComposer();
    await userEvent.click(pill());
    expect(writePty).toHaveBeenCalledWith("a1", "1\n");
  });

  it("does nothing to history when the agent belongs to no loaded project", async () => {
    // The composer can outlive its project in the store (project switch mid-click); appending
    // against a stale id must be a no-op, not a throw that swallows the PTY write.
    useProjectStore.setState({ projects: [] });
    renderComposer();
    await userEvent.click(pill());
    expect(writePty).toHaveBeenCalledWith("a1", "1\n");
  });
});
