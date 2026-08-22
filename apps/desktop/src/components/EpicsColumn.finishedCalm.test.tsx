// @vitest-environment jsdom
//
// THE EPIC SQUARE MUST NOT PAINT RED ON A HEAD THE BUILD COLUMN HAS ALREADY CALMED.
//
// `rollupViewFor` takes a `isFinishedOf` reading and its own parameter doc says what happens to a
// caller that lets it default: *"a column that skipped it would keep painting a finished head red
// while every other surface had calmed it."* The Epics column is now that second caller, and the
// first cut of its wiring DID let it default — a finished orchestrator still carrying a red worker
// bubble would have painted its EPIC red beside a build row that had gone quiet. That is the
// column↔column drift `engine/workerRollup`'s header says the shared entry point exists to prevent,
// and the founder-visible form of it is *"why is this red? nothing is blocked by me."*
//
// ══ WHY THIS MOCKS THE HOOK RATHER THAN BUILDING A FINISHED AGENT ══════════════════════════════
// The real verdict comes from `stallReport` over branch status, workflow state, the goal record, a
// quota registry and the nudger's flag table — six inputs whose job is to decide WHETHER an agent
// is finished. That decision is `engine/agentStall`'s and it has its own suite. What is untested
// without this file is narrower and is the thing that actually broke: whether this column THREADS
// the reading through at all. Mocking the hook pins exactly that seam — the same defaulted-seam
// trap AGENTS.md names ("a defaulted seam every test injects"), inverted so the seam is the
// assertion instead of the blind spot.
//
// The test asserts a DIFFERENCE across the two readings, so it cannot pass against a column that
// ignores the hook: `finished === undefined` (never read) must paint red, `finished === true` must
// not. A wiring that drops the argument gives the same answer for both.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

/** Flipped per case; the mocked hook reads it at call time. */
let finishedReading: boolean | undefined = undefined;
vi.mock("../hooks/useFinishedHeads", () => ({
  useFinishedHeads: () => () => finishedReading,
}));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { AgentTab, Project } from "../types";

const EPIC = {
  id: "ep-1",
  title: "ep-1",
  status: "open",
  labels: [],
  type: "epic",
} as unknown as Bead;

/** A calm head bound to the epic, and a RED WORKER under it whose red bubbles up.
 *
 *  The shape matters, twice over:
 *
 *  • THE RED HAS TO BE THE WORKER'S. `withFinishedHeadCalm` writes into the PUBLISHED map, and
 *    `rollupDotAccessor` reads published for the WORKER statuses while reading the bubble-free `own`
 *    map for the head's own tier. So a finished reading can only ever retire an INHERITED red —
 *    which is exactly the red this test is about, and exactly the one that outlives the work.
 *  • `blocked` RATHER THAN `waiting`. `isFinishedHeadCalmed`'s second conjunct refuses to demote an
 *    ask made on the row's own behalf (`needsAttention`, which deliberately excludes `blocked`).
 *    `blocked` means "went quiet, might need unsticking" — the red a positive finished reading is
 *    allowed to retire. A calm head is also not `isInMotion`, so the suppression rule cannot swallow
 *    this red for an unrelated reason and hand the test a green for the wrong cause. */
const HEAD = { id: "h", name: "h", kind: "build", parentId: null, epicId: "ep-1" } as unknown as AgentTab;
const WORKER = { id: "w", name: "w", kind: "worker", parentId: "h", beadId: "ep-1" } as unknown as AgentTab;

const PROJECT = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/alpha",
  agents: [HEAD, WORKER],
} as unknown as Project;

function healthOf(id: string): string {
  const r = screen
    .queryAllByTestId("epic-row")
    .find((el) => el.getAttribute("data-epic-id") === id);
  if (!r) throw new Error(`no epic row for ${id}`);
  const sq = r.querySelector<HTMLElement>('[data-testid="epic-health"]');
  if (!sq) throw new Error(`no health square for ${id}`);
  return sq.getAttribute("data-health") ?? "";
}

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      p1: { beads: [EPIC], board: bucketBeads([EPIC]), polledAt: 0 },
    },
    error: {},
  }) as never);
  useRuntimeStore.setState({
    status: { h: "idle", w: "blocked" },
    openAgentIds: [],
    lastObserved: {},
    branchStatus: {},
    workflowStage: {},
    observedAttention: {},
  } as never);
});
afterEach(() => {
  cleanup();
  finishedReading = undefined;
});

describe("EpicsColumn — the finished-head reading reaches the epic square", () => {
  it("paints RED while the head has NOT been read as finished", () => {
    finishedReading = undefined; // "we never looked" — demotes nothing
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(healthOf("ep-1")).toBe("red");
  });

  it("does NOT paint red once the head IS read as finished", () => {
    // Same store, same agents, same statuses. The ONLY thing that changed is the reading the
    // column passes into `rollupViewFor` — so a column that never passes it cannot satisfy both
    // this case and the one above.
    finishedReading = true;
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(healthOf("ep-1")).not.toBe("red");
  });
});
