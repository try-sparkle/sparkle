// DEV-ONLY seeded fixture data for the visual-fidelity harness (scripts/visual/).
//
// WHY THIS EXISTS. The auth bypass (devBypassAuth.ts) gets a headless browser past the paywall, but
// it lands on an EMPTY workspace: every backend read goes through Tauri `invoke`, which no-ops in a
// plain browser, so the sidebar says "Create a project to add agents". You cannot measure the
// fidelity of an agent row that isn't rendered.
//
// WHY IT IS SEEDED RATHER THAN REAL. A screenshot diff is only a measurement if the same input
// produces the same pixels. Real data fails that on three axes at once: uuids differ per run,
// `lastOpenedAt`/`createdAt` are `Date.now()`, and every "3m ago" in the sidebar is a subtraction
// against the wall clock. So everything here is a CONSTANT — fixed ids, fixed names, fixed
// statuses, and timestamps expressed as offsets from FIXTURE_NOW, which the harness pins
// `Date.now()` to (scripts/visual/serve.mjs, FROZEN_CLOCK). Change one and you change the baseline;
// that is the point.
//
// SAFETY. Gated on devBypassAuthEnabled(), which is itself gated on `import.meta.env.DEV` — FALSE
// in any `vite build` artifact. So this can never seed a shipped bundle, regardless of env vars.
//
// SAFETY, PART TWO — WHAT THE GATE DOES *NOT* BUY. Both stores seeded here are `persist`-backed by
// localStorage, so a plain `setState` writes THROUGH to disk. The two gates are the dev bypass flag
// and `?visual=1`, and a developer who keeps VITE_SPARKLE_DEV_BYPASS_AUTH=1 in their environment
// and opens their own dev server with `?visual=1` — to reproduce a capture by hand, say — satisfies
// both. That would have overwritten their real project list and their removal tombstones, with no
// undo. detachPersistence() below stops the write at the storage layer, so reloading without
// `?visual=1` restores their session. (roborev 54701)
//
// THE PRECISE GUARANTEE IS "no STORE write reaches disk", not "memory-only". detachPersistence only
// covers zustand `persist` storage. Code that writes localStorage directly is unaffected — notably
// capture/LastFocusedProjectTracker, which stamps `sparkle-last-focused-project` with the selected
// project on mount/focus and will therefore record the fixture project id, outliving the tab. That
// key degrades benignly (lastFocusedProject falls back to the first project), so it is left alone
// rather than special-cased; what is NOT acceptable is a comment claiming a guarantee wider than
// the mechanism delivers. (roborev 54756)

import { createJSONStorage } from "zustand/middleware";
import type { AgentTab, Project } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";
import type { WorkflowStageId } from "../engine/workflowStage";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useConnectionStore } from "../stores/connectionStore";
import { devBypassAuthEnabled } from "./devBypassAuth";

/** The query parameter that turns fixtures on: `?visual=1`. */
export const VISUAL_FIXTURES_PARAM = "visual";

/**
 * The pinned instant, as epoch ms — 2026-07-28T17:00:00Z.
 *
 * MUST equal FROZEN_CLOCK's FIXED in scripts/visual/serve.mjs. They are asserted equal by
 * visualFixtures.test.ts, because a drift between them silently reintroduces exactly the
 * wall-clock dependence this file exists to remove.
 */
export const FIXTURE_NOW = Date.UTC(2026, 6, 28, 17, 0, 0);

const MINUTE = 60_000;

/** `?visual=1` / `?visual=true`. Pure so the parse is testable without a browser. */
export function visualFixturesRequested(search: string): boolean {
  const v = new URLSearchParams(search).get(VISUAL_FIXTURES_PARAM);
  return v === "1" || v === "true";
}

export const FIXTURE_PROJECT_ID = "visual-fixture-project";

/** One agent row's worth of fixture, flattened so the table below reads as a spec. */
interface Row {
  id: string;
  name: string;
  kind: AgentTab["kind"];
  parentId: string | null;
  status: AgentTabStatus;
  /** Minutes since this agent's last turn — the `.el` elapsed readout in the mock. */
  elapsedMin: number;
  stage: WorkflowStageId;
  activity?: string;
  lastPrompt: string;
}

/**
 * The roster. Chosen to light up every band the sidebar can group into — a red row that needs you,
 * a green working row, workers nested under a build parent, and a landed row — so a capture
 * exercises the group headers (`.grp`) and the status dot's full colour range rather than one
 * happy path. Names are deliberately mundane and of varied length: name truncation is a real
 * fidelity risk and a roster of equal-length names would hide it.
 */
const SELECTED_ROW_ID = "vfx-agent-1";

const ROWS: Row[] = [
  {
    id: SELECTED_ROW_ID,
    name: "Concierge column layout",
    kind: "build",
    parentId: null,
    status: "waiting",
    elapsedMin: 3,
    stage: "building_unsaved",
    activity: "Asking which side the pull tab belongs on",
    lastPrompt: "Move the concierge to the left edge and make it full height",
  },
  {
    id: "vfx-agent-2",
    name: "Wire the connection badge",
    kind: "worker",
    parentId: "vfx-agent-1",
    status: "working",
    elapsedMin: 1,
    stage: "building_unsaved",
    activity: "Drawing the cable between the row and the column",
    lastPrompt: "Render the wired badge only when data-wired is set",
  },
  {
    id: "vfx-agent-3",
    name: "Blueprint grid",
    kind: "worker",
    parentId: "vfx-agent-1",
    status: "approval",
    elapsedMin: 7,
    stage: "building_saved",
    activity: "Waiting on approval to touch index.css",
    lastPrompt: "Add the 26px blueprint grid behind the workspace",
  },
  {
    id: "vfx-agent-4",
    name: "Agent sidebar group headers",
    kind: "build",
    parentId: null,
    status: "idle",
    elapsedMin: 24,
    stage: "pull_request",
    lastPrompt: "Group the sidebar rows by workflow stage with a rule and a count",
  },
  {
    id: "vfx-agent-5",
    name: "Settings dialog pass",
    kind: "build",
    parentId: null,
    status: "unmerged",
    elapsedMin: 96,
    stage: "merged_local",
    lastPrompt: "Re-skin the settings dialog against rev4",
  },
  {
    id: "vfx-agent-6",
    name: "Terminal seam",
    kind: "build",
    parentId: null,
    status: "done",
    elapsedMin: 240,
    stage: "shipped",
    lastPrompt: "Fix the seam between the sidebar and the terminal",
  },
];

function toAgent(r: Row): AgentTab {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    parentId: r.parentId,
    runtime: "local",
    worktreePath: `/tmp/sparkle-visual/${r.id}`,
    branch: `sparkle/${r.id}`,
    baseBranch: "main",
    lastPrompt: r.lastPrompt,
    promptHistory: [
      {
        id: `${r.id}-p1`,
        text: r.lastPrompt,
        // The elapsed readout is `now - at`; with Date.now() pinned to FIXTURE_NOW this is exact.
        at: FIXTURE_NOW - r.elapsedMin * MINUTE,
        source: "composer",
      },
    ],
    activity: r.activity,
    task: r.parentId ? r.lastPrompt : undefined,
    parentBranch: r.parentId ? "sparkle/vfx-agent-1" : undefined,
    namePinned: false,
    autoNameBasis: r.lastPrompt,
    autoNameVariants: { title: r.name, description: r.lastPrompt },
    shellCommand: null,
    createdAt: FIXTURE_NOW - r.elapsedMin * MINUTE,
  };
}

/** The seeded project. Pure — no clock, no randomness, no store access. */
export function buildVisualFixture(): {
  project: Project;
  status: Record<string, AgentTabStatus>;
  workflowStage: Record<string, WorkflowStageId>;
} {
  const iso = new Date(FIXTURE_NOW).toISOString();
  const project: Project = {
    id: FIXTURE_PROJECT_ID,
    name: "sparkle",
    rootPath: "/Users/dev/Projects/sparkle",
    defaultBranch: "main",
    createdAt: iso,
    lastOpenedAt: iso,
    agents: ROWS.map(toAgent),
    // The first row is selected so a capture shows the SELECTED-row geometry (the mouth/fillet at
    // the junction) — the single most-reviewed detail in MAPPING.md's geometry section.
    selectedAgentId: SELECTED_ROW_ID,
    freshBuildAgentId: SELECTED_ROW_ID,
  };
  const status: Record<string, AgentTabStatus> = {};
  const workflowStage: Record<string, WorkflowStageId> = {};
  for (const r of ROWS) {
    status[r.id] = r.status;
    workflowStage[r.id] = r.stage;
  }
  return { project, status, workflowStage };
}

/**
 * Seed the stores. No-op unless the dev auth bypass is on, so a normal dev session can never be
 * clobbered by fixtures just because the URL carried a stray parameter.
 *
 * Returns whether it seeded, so the caller (and the test) can assert rather than guess.
 */
/** A storage backend that forgets everything — reads empty, swallows writes. */
const NOOP_STORAGE = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** The persist API zustand attaches to a persisted store. Narrowed to the one method used here. */
interface PersistApi {
  persist?: { setOptions: (o: { storage: ReturnType<typeof createJSONStorage> }) => void };
}

/**
 * Point the seeded stores' persist middleware at a no-op backend, so seeding cannot reach disk.
 *
 * Called BEFORE any setState below — rehydration has already happened by then, so the developer's
 * real blob is intact on disk and merely shadowed in memory for this page's lifetime.
 */
export function detachPersistence(): void {
  const noop = createJSONStorage(() => NOOP_STORAGE);
  for (const store of [useProjectStore, useRuntimeStore]) {
    (store as unknown as PersistApi).persist?.setOptions({ storage: noop });
  }
}

export function applyVisualFixtures(
  search: string = window.location.search,
  // Injectable for the same reason devBypassAuthEnabled's is: a test must be able to exercise the
  // enabled branch without stubbing Vite's import.meta.env.
  env?: Record<string, unknown>,
): boolean {
  if (!devBypassAuthEnabled(env)) return false;
  if (!visualFixturesRequested(search)) return false;

  const { project, status, workflowStage } = buildVisualFixture();

  // FIRST — before a single write. See "SAFETY, PART TWO" at the top of this file.
  detachPersistence();

  // setState, not addProject/addAgent: those mint uuids and stamp Date.now(), which is precisely
  // the non-determinism the fixture exists to avoid. Replaces `projects` outright so a persisted
  // localStorage profile from an earlier run can't leak extra rows into the capture.
  useProjectStore.setState({
    projects: [project],
    selectedProjectId: project.id,
    removedIds: {},
  });

  // `status` is the only live-only key here — it is never persisted, so it must be written on every
  // boot or the rows render with no dot at all. `workflowStage` and `openAgentIds` ARE persisted
  // (runtimeStore's partialize covers openAgentIds, workflowStage and workflowShipped), and writing
  // them is only safe because detachPersistence() ran above. Do NOT drop useRuntimeStore from that
  // loop on the strength of a "live-only" reading of this line — that restores the clobber, this
  // time of the developer's stage watermarks. (roborev 54756)
  useRuntimeStore.setState({ status, workflowStage, openAgentIds: [] });

  // The offline banner is real UI that pushes the whole workspace down, and a headless browser
  // with no reachable probe endpoint always shows it. The mock has no such banner, so leaving it
  // in would score as a layout-wide diff on every surface. Forced online.
  useConnectionStore.setState({ isOnline: true, browserOnline: true, probeOk: true });

  return true;
}
