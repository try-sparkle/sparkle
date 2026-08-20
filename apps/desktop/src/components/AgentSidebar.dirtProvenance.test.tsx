// @vitest-environment jsdom
//
// THE AGENT'S SPAWN STAMP MUST REACH RUST, or dirt attribution ships INERT.
//
// `dirtySinceAgentCount` (bead `sparkle-d5muhf`, change 1B) answers "how much of this worktree's
// dirt did THIS AGENT actually make?" by comparing each dirty file's mtime against the agent
// record's creation time. Rust cannot see that record: `AgentTab.createdAt` lives in the frontend
// store, so the value has to be carried across on every poll. Rust's own guard is deliberately
// permissive — a missing stamp means "could not tell", which is a silent, valid answer — so if the
// frontend never sends it, the reading returns `null` for every agent forever and NOTHING FAILS.
// That is the AGENTS.md "defaulted seam" shape exactly: the feature would be permanently off with a
// green suite on both sides.
//
// So this asserts the SIDE EFFECT — what the batch call actually carried — across the whole wiring
// the value travels: `AgentSidebar`'s `toInput` → `runtimeStore.pollProjectStatus` → the service
// call. Only `projectAgentsStatus` itself is stubbed; both mapping sites are real, which is what
// makes one test cover both of them.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

const projectAgentsStatus = vi.fn(() => Promise.resolve([]));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: (...args: unknown[]) =>
    (projectAgentsStatus as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
}));
vi.mock("../services/agentNaming", () => ({
  refreshAgentTitle: vi.fn(() => Promise.resolve()),
  maybeNameFromWork: vi.fn(() => Promise.resolve()),
  isNameFromWorkCandidate: () => false,
  WORK_BACKSTOP_WINDOW_TICKS: 4,
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

const STAMPED_AT = 1_760_000_000_000;

function mkAgent(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: "main", lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

/** Two rows, differing ONLY in whether they carry a spawn stamp — the split under test. A
 *  re-adopted worker and every legacy persisted row genuinely read `createdAt: undefined`
 *  (projectStore.spawnStamp.test.ts pins that), so the unstamped row is not a hypothetical. */
function seed(): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: "stamped",
    agents: [
      mkAgent("stamped", { createdAt: STAMPED_AT }),
      mkAgent("unstamped"),
    ],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, workflowShipped: {},
    status: {}, openAgentIds: ["stamped", "unstamped"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** The per-agent input the batch call actually carried, across every batch this tick. */
function inputFor(agentId: string): Record<string, unknown> | undefined {
  for (const call of projectAgentsStatus.mock.calls) {
    const batch = (call as unknown[])[2] as Record<string, unknown>[] | undefined;
    const hit = (batch ?? []).find((a) => a.agentId === agentId);
    if (hit) return hit;
  }
  return undefined;
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
  projectAgentsStatus.mockClear();
});
afterEach(cleanup);

describe("AgentSidebar status tick — the spawn stamp reaches Rust", () => {
  it("carries the agent's createdAt as createdAtMs, so dirt can be attributed at all", async () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    await waitFor(() => expect(inputFor("stamped")).toBeDefined());
    // The VALUE, not merely presence: a stamp that arrived as 0/NaN would make Rust decline just as
    // surely as one that never arrived, and the row would silently keep its "Unsaved" chip.
    expect(inputFor("stamped")?.createdAtMs).toBe(STAMPED_AT);
  });

  it("sends an unstamped row an explicit null, never an absent key", async () => {
    const project = seed();
    render(<AgentSidebar project={project} />);

    await waitFor(() => expect(inputFor("unstamped")).toBeDefined());
    const input = inputFor("unstamped")!;
    // Rust reads this into an `Option<i64>`. Both sides must agree that ABSENT and NULL mean the
    // same "no stamp" — AGENTS.md's Option-across-the-wire rule, in the argument direction. An
    // omitted key relies on `#[serde(default)]`; sending `null` is what the field is documented as.
    expect("createdAtMs" in input).toBe(true);
    expect(input.createdAtMs).toBeNull();
    // …and the stamped row in the SAME tick still carries its number, so this is a real split and
    // not a wiring that happens to send null for everyone.
    expect(inputFor("stamped")?.createdAtMs).toBe(STAMPED_AT);
  });
});
