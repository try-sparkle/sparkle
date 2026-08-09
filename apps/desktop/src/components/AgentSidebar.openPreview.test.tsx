// @vitest-environment jsdom
//
// The ENTRY POINT for a live preview: one item in the agent row's detail card, sibling of
// "Move to cloud" (`AgentSidebar.promoteToCloud.test.tsx` is this file's shape and its neighbour).
//
// ITS ABSENCE IS AS MUCH OF THE CONTRACT AS ITS PRESENCE, and it must be absent rather than
// DISABLED — design §7 rule 5, which is `ColumnPullTab.tsx:130`'s rule verbatim: "an affordance
// that does nothing is worse than an absent one." So the negative tests below check for a missing
// element AND for the absence of a disabled one, because `disabled={!previewable}` is the obvious
// wrong implementation and renders almost identically.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

// The service is stubbed rather than the Tauri bridge, which is the whole point of routing every
// invoke through it: `openPreviewServer` is observable as a CALL WITH ARGUMENTS, so the test can
// assert that the click asked for the right agent's worktree — not merely that something happened.
// `refreshPreviewCapability` is stubbed to a no-op because this file seeds the capability directly;
// leaving it real would have the column overwrite the seed with a bridge failure's `false`.
interface OpenArgs {
  agentId: string;
  projectId: string;
  worktree: string;
  path?: string | null;
}
const openPreviewServer = vi.fn((_args: OpenArgs) => Promise.resolve(null));
const refreshPreviewCapability = vi.fn(() => Promise.resolve(null));
vi.mock("../services/preview", async (orig) => ({
  ...(await orig<typeof import("../services/preview")>()),
  openPreviewServer: (args: OpenArgs) => openPreviewServer(args),
  refreshPreviewCapability: () => refreshPreviewCapability(),
}));

import { AgentSidebar } from "./AgentSidebar";
import { PREVIEW_ALREADY_STARTING } from "../services/preview";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { usePreviewStore } from "../stores/previewStore";
import { useProjectStore } from "../stores/projectStore";
import type { AgentTab, Project } from "../types";

function mkAgent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1", name: "Parser Agent", kind: "build", parentId: null, runtime: "local",
    worktreePath: "/tmp/demo-wt", branch: "sparkle/agent-fixture", baseBranch: "main",
    lastPrompt: "", promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
    ...over,
  };
}
function mkProject(agents: AgentTab[]): Project {
  return {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
}

/** Open the row's detail card — right-click, the same gesture the neighbouring cloud items use. */
function openCard(name: string) {
  const row = screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
  fireEvent.contextMenu(row);
}
const item = () => screen.queryByTestId("open-preview");

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {}, workflowStage: {} } as never);
  useUiStore.setState({
    workModeBySide: { left: "build", right: "build" },
    collapsedOrchestrators: {},
    promoteAgentId: null,
    settingsRequest: null,
    activeSpecial: null,
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  useProjectStore.setState({ projects: [mkProject([mkAgent()])], selectedProjectId: "p1" } as never);
  usePreviewStore.setState({ byAgent: {}, capability: { p1: { previewable: true } } });
  openPreviewServer.mockClear();
  refreshPreviewCapability.mockClear();
});
afterEach(cleanup);

describe("AgentSidebar — Preview", () => {
  it("offers it on a row whose project is previewable", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).not.toBeNull();
  });

  // ── THE ABSENCES ─────────────────────────────────────────────────────────────────────────────
  // Each renders the SAME row that shows the item above, changing exactly one fact.

  it("is ABSENT — not disabled — when the project cannot be previewed", () => {
    usePreviewStore.setState({ capability: { p1: { previewable: false } } });
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).toBeNull();
    // ...and NOT merely greyed. Asserting on the testid alone would already catch
    // `disabled={!previewable}` (the element would still be there), but this catches the same wrong
    // answer even if the control is renamed: nothing anywhere offers the word. It is a text search
    // rather than a `button[disabled]` sweep because the column has an unrelated disabled control
    // (the status-filter "Reset"), which would make that sweep fail for a reason nobody meant.
    expect(screen.queryByText("Preview")).toBeNull();
  });

  // "Not asked yet" must read as no. Offering the mode before the probe answers would put the user
  // in a pane whose only possible content is an apology.
  it("is absent while the capability probe has not answered", () => {
    usePreviewStore.setState({ capability: {} });
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openCard("Parser Agent");
    expect(item()).toBeNull();
  });

  // A preview server runs IN a worktree. An agent that has not been given one has nowhere to run
  // it, and the button would spend a round trip to report a state the row already knows.
  it("is absent on an agent with no worktree yet", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ worktreePath: null })])} />);
    openCard("Parser Agent");
    expect(item()).toBeNull();
  });

  it("is absent from the collapsed row — it lives on the card, not in the column", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    expect(item()).toBeNull();
  });

  // ── WHAT USING IT DOES ───────────────────────────────────────────────────────────────────────

  it("puts this column into Preview and asks for THAT agent's worktree", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ id: "a7" })])} />);
    openCard("Parser Agent");
    fireEvent.click(item()!);

    // Both halves of the side effect. The mode alone would show an empty pane forever; the invoke
    // alone would start a server nobody can see.
    expect(useUiStore.getState().workModeBySide.right).toBe("preview");
    expect(openPreviewServer).toHaveBeenCalledTimes(1);
    expect(openPreviewServer.mock.calls[0]?.[0]).toMatchObject({
      agentId: "a7",
      projectId: "p1",
      worktree: "/tmp/demo-wt",
    });
  });

  // A REJECTED INVOKE EMITS NO EVENT, so nothing else would ever write this agent's entry and the
  // pane would sit on "starting…" for good. The click records the failure itself.
  it("records a failed entry when the server cannot be started", async () => {
    openPreviewServer.mockRejectedValueOnce(new Error("EADDRINUSE"));
    render(<AgentSidebar project={mkProject([mkAgent({ id: "a7" })])} />);
    openCard("Parser Agent");
    fireEvent.click(item()!);

    // The rejection is handled in a promise callback — let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();

    const entry = usePreviewStore.getState().byAgent.a7;
    expect(entry?.status).toBe("failed");
    expect(entry?.error).toContain("EADDRINUSE");
  });

  // THE PAIR TO THE TEST ABOVE, and the reason the catch cannot just write `failed` unconditionally.
  // A click landing while this agent's own start is in flight is REFUSED by the Rust reservation —
  // the thing that stops a second dev server — and that first start is still running and will
  // populate this pane by event. Painting the terminal `failed` state over it would report a broken
  // preview for the one rejection where nothing is wrong, and "starting…" would never come back.
  it("leaves the in-flight entry alone when the start was refused as already-starting", async () => {
    usePreviewStore.getState().setPreview("a7", {
      id: "srv-1",
      status: "starting",
      url: null,
      port: null,
      error: null,
    });
    // Built from the constant, not restated: `previewSeam.test.ts` is what pins that constant to
    // `preview.rs`'s `ALREADY_STARTING`, so this file does not need a second copy of the token —
    // and a copy here would drift silently the moment the seam moved.
    openPreviewServer.mockRejectedValueOnce(
      new Error(`preview: a server for this agent is ${PREVIEW_ALREADY_STARTING}`),
    );
    render(<AgentSidebar project={mkProject([mkAgent({ id: "a7" })])} />);
    openCard("Parser Agent");
    fireEvent.click(item()!);

    await Promise.resolve();
    await Promise.resolve();

    const entry = usePreviewStore.getState().byAgent.a7;
    expect(entry?.status).toBe("starting");
    expect(entry?.error).toBeNull();
  });

  // `e.stopPropagation()`, because the card's own onClick re-selects the agent. Without it the
  // click would ALSO change the selection — which, in a column where the user was watching another
  // agent, moves the pane out from under them as a side effect of pressing an unrelated button.
  it("does not re-select the agent as a side effect", () => {
    const selectAgent = vi.fn();
    useProjectStore.setState({ selectAgent } as never);
    render(<AgentSidebar project={mkProject([mkAgent({ id: "a7" })])} />);
    openCard("Parser Agent");
    selectAgent.mockClear();

    fireEvent.click(item()!);
    expect(selectAgent).not.toHaveBeenCalled();
  });
});
