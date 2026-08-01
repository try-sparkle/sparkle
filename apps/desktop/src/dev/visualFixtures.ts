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
import type { AgentGoal } from "../engine/agentGoal";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useCableStore } from "../stores/cableStore";
import { useUiStore } from "../stores/uiStore";
import { useDictationStore } from "../stores/dictationStore";
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

/** The second project, seeded onto the LEFT pair only when `?pairs=2` is asked for. */
export const FIXTURE_LEFT_PROJECT_ID = "visual-fixture-project-left";

/** The left project's selected row — the one whose seam a left-pair capture is taken to inspect. */
const LEFT_SELECTED_ROW_ID = "vfx-left-agent-1";

/** The query parameter that opens the SECOND pair: `?pairs=2`. */
export const VISUAL_PAIRS_PARAM = "pairs";

/**
 * How many pairs the capture wants. Default 1 — the single-pair cockpit every existing surface is
 * baselined against, which must not move.
 *
 * OPT-IN, and that is the whole design constraint. `workspace-wired-left` needs a project on the
 * left pair (`useEffectiveWired` refuses to project a side whose far end has no selected agent), but
 * seeding one unconditionally opens a second pair and re-lays-out EVERY other surface — so the
 * fixture would fix one capture by invalidating the baselines of all the rest. A parameter keeps the
 * default seed byte-identical and lets exactly the surfaces that need two pairs ask for them.
 */
export function visualPairCount(search: string): 1 | 2 {
  return new URLSearchParams(search).get(VISUAL_PAIRS_PARAM) === "2" ? 2 : 1;
}

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
  /** This row's goal, if it has one. See {@link GOAL_STATES}. */
  goal?: AgentGoal;
}

/**
 * A goal in each of the four states a row can render, so a capture PROVES the row treatment for all
 * of them rather than one happy path.
 *
 * This exists because the roster carried no goals at all, and that made the agent-sidebar capture
 * unable to answer the founder's question — "if every agent had a goal, I would see it on the row"
 * (bead sparkle-6kz9q). A screenshot of six goal-less agents looks identical before and after a fix
 * to how goals are shown, so it could never have caught the regression, and could never demonstrate
 * the fix either.
 *
 * Every timestamp is an offset from {@link FIXTURE_NOW} for the same reason every other one here is:
 * `goalStateOf` and the "3h 20m left" readout are both `now`-relative, so a wall-clock goal would
 * make the row's own text change between two runs of the same capture.
 */
const HOUR = 60 * MINUTE;

const GOAL_STATES = {
  /** Live, with time on the clock — the common case, and the one that reads as invisible today. */
  unmet: {
    text: "Land the concierge column on the left edge",
    setAt: FIXTURE_NOW - 40 * MINUTE,
    ttlMs: 4 * HOUR,
    continues: 0,
    totalContinues: 0,
  },
  /** Achieved. `metAt` is what makes an idle agent legitimately done (see engine/agentGoal). */
  met: {
    text: "Fix the seam between the sidebar and the terminal",
    setAt: FIXTURE_NOW - 3 * HOUR,
    ttlMs: 4 * HOUR,
    metAt: FIXTURE_NOW - 20 * MINUTE,
    continues: 0,
    totalContinues: 2,
  },
  /** Past its TTL and never met — unfinished work whose auto-continue mandate ran out. */
  expired: {
    text: "Group the sidebar rows by workflow stage",
    setAt: FIXTURE_NOW - 5 * HOUR,
    ttlMs: 4 * HOUR,
    continues: 3,
    totalContinues: 6,
  },
  /** Auto-continue gave up and handed the agent back. The loudest state on the row. */
  escalated: {
    text: "Re-skin the settings dialog against rev4",
    setAt: FIXTURE_NOW - 90 * MINUTE,
    ttlMs: 4 * HOUR,
    continues: 20,
    totalContinues: 20,
    escalatedAt: FIXTURE_NOW - 10 * MINUTE,
    escalationReason: "no progress in 20 restarts",
  },
} satisfies Record<string, AgentGoal>;

/**
 * The roster. Chosen to light up every band the sidebar can group into — a red row that needs you,
 * a green working row, workers nested under a build parent, and a landed row — so a capture
 * exercises the group headers (`.grp`) and the status dot's full colour range rather than one
 * happy path. Names are deliberately mundane and of varied length: name truncation is a real
 * fidelity risk and a roster of equal-length names would hide it.
 *
 * GOALS ARE SPREAD THE SAME WAY, and the rows LEFT WITHOUT ONE are as deliberate as the four that
 * have one. The founder's test for the row treatment is "tell a goal-bearing agent from a
 * goal-less one at a glance" (bead sparkle-6kz9q), so a roster where every row carried a goal could
 * not photograph the distinction it exists to prove.
 *
 * THE CONTROL IS SAME-KIND, and that is the whole subtlety (roborev 57331). The first cut left the
 * two nested WORKERS goal-less while every goal sat on a top-level BUILD row — so "has a goal" was
 * perfectly confounded with "is a top-level build row", and a capture could not show which of the
 * two a visible difference came from. A control has to differ in the ONE variable under test, so
 * `vfx-agent-7` is a goal-less TOP-LEVEL BUILD row, matched against the four that carry goals.
 *
 * It is a seventh row rather than a demotion of one of the four because all four states have to stay
 * PHOTOGRAPHABLE: a worker under a collapsed head renders as a one-line peek (AgentSidebar's "THE
 * PEEK"), not a row, so a goal moved onto one would vanish from the very capture this table exists
 * to feed — trading a confounded control for an invisible state.
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
    goal: GOAL_STATES.unmet,
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
    goal: GOAL_STATES.expired,
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
    goal: GOAL_STATES.escalated,
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
    goal: GOAL_STATES.met,
  },
  {
    // THE GOAL-LESS CONTROL, and it is a TOP-LEVEL BUILD row on purpose (roborev 57331). A control
    // has to differ from the rows it is compared against in the ONE variable under test, and every
    // goal above sits on a build row — so a goal-less WORKER could not serve: "has a goal" would be
    // confounded with "is a top-level build row" and the capture could not say which difference the
    // eye was seeing. The two nested workers stay goal-less as well, but they are not the control
    // and nothing rests on them; a worker under a collapsed head renders as a one-line PEEK, not a
    // row, so a goal parked there could not be photographed at all.
    id: "vfx-agent-7",
    name: "Credit pill contrast",
    kind: "build",
    parentId: null,
    status: "idle",
    elapsedMin: 52,
    stage: "building_saved",
    lastPrompt: "Check the credit pill against the flooded column in both themes",
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
    // Spread conditionally so a goal-less row has NO `goal` key rather than an explicit
    // `undefined` — the control rows must be indistinguishable from an agent that never had one.
    ...(r.goal ? { goal: r.goal } : {}),
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
 * The LEFT pair's project. Deliberately small — three rows, one selected — because its job is to
 * make the left pair REAL (a project with a selected agent, so the cable can seat there), not to
 * re-photograph the whole sidebar from the other side.
 *
 * Ids are prefixed so they cannot collide with the right project's; a duplicate agent id would put
 * two rows in the roster under one key and make the capture quietly wrong rather than fail.
 */
export function buildLeftPairFixture(): {
  project: Project;
  status: Record<string, AgentTabStatus>;
  workflowStage: Record<string, WorkflowStageId>;
} {
  const iso = new Date(FIXTURE_NOW).toISOString();
  const rows: Row[] = ROWS.slice(0, 3).map((r, i) => ({
    ...r,
    id: `vfx-left-agent-${i + 1}`,
    // Workers point at the RIGHT project's ids otherwise, which would orphan them in this project.
    parentId: null,
    kind: "build",
  }));
  const project: Project = {
    id: FIXTURE_LEFT_PROJECT_ID,
    name: "mobile",
    rootPath: "/Users/dev/Projects/mobile",
    defaultBranch: "main",
    createdAt: iso,
    lastOpenedAt: iso,
    agents: rows.map(toAgent),
    selectedAgentId: LEFT_SELECTED_ROW_ID,
    freshBuildAgentId: LEFT_SELECTED_ROW_ID,
  };
  const status: Record<string, AgentTabStatus> = {};
  const workflowStage: Record<string, WorkflowStageId> = {};
  for (const r of rows) {
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
  // useDictationStore IS IN THIS LIST, and it is the one entry that is not obvious.
  //
  // `useCableStore` is absent because it is genuinely in-memory — there is nothing to detach. The
  // dictation store is NOT: it persists under DICTATION_PERSIST_KEY with
  // `partialize: (s) => ({ enabled: s.enabled, phase: s.phase })`, so the `__sparkleMic` handle
  // below writing `enabled: true` would go straight through the live middleware to localStorage and
  // OUTLIVE THE TAB — the exact clobber this function's header promises it prevents.
  //
  // Two consequences, neither cosmetic. The store defaults to `enabled: false` so a cold start does
  // not prompt for microphone permission or kick off the ~482 MB model download; a persisted `true`
  // makes the developer's next ordinary launch do both. And DICTATION_PERSIST_KEY is watched by the
  // cross-window sync service on the browser `storage` event, so a harness tab could arm the mic in
  // another window the developer has open right now. (roborev 56045)
  for (const store of [useProjectStore, useRuntimeStore, useDictationStore]) {
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
  // The second pair is OPT-IN (`?pairs=2`); see `visualPairCount` for why it cannot be the default.
  const left = visualPairCount(search) === 2 ? buildLeftPairFixture() : null;

  // FIRST — before a single write. See "SAFETY, PART TWO" at the top of this file.
  detachPersistence();

  // setState, not addProject/addAgent: those mint uuids and stamp Date.now(), which is precisely
  // the non-determinism the fixture exists to avoid. Replaces `projects` outright so a persisted
  // localStorage profile from an earlier run can't leak extra rows into the capture.
  useProjectStore.setState({
    // The RIGHT project stays first and stays `selectedProjectId`, so the single-pair layout — and
    // every surface baselined against it — is untouched when `?pairs=2` is absent.
    projects: left ? [project, left.project] : [project],
    selectedProjectId: project.id,
    removedIds: {},
  });

  // ── THE SECOND PAIR ────────────────────────────────────────────────────────────────────────
  //
  // Three ui values, and all three are load-bearing: `pairAssignment` is what `pairCountFor` reads
  // to decide there are two pairs at all, and `leftProjectId` is what `useEffectiveWired` resolves
  // the LEFT side's selected agent through — without it, `patch("left")` is a no-op as far as the
  // shell is concerned and the capture silently photographs an unwired app. That is the exact bug
  // that let `workspace-wired-left` score the wrong state for its whole life; the harness's `cable`
  // step now verifies `data-wired` agrees, so this being wrong fails loudly instead.
  if (left) {
    useUiStore.setState({
      openProjectIds: [project.id, left.project.id],
      pairAssignment: { [left.project.id]: "left" },
      leftProjectId: left.project.id,
    });
  }

  // `status` is the only live-only key here — it is never persisted, so it must be written on every
  // boot or the rows render with no dot at all. `workflowStage` and `openAgentIds` ARE persisted
  // (runtimeStore's partialize covers openAgentIds, workflowStage and workflowShipped), and writing
  // them is only safe because detachPersistence() ran above. Do NOT drop useRuntimeStore from that
  // loop on the strength of a "live-only" reading of this line — that restores the clobber, this
  // time of the developer's stage watermarks. (roborev 54756)
  useRuntimeStore.setState({
    status: left ? { ...status, ...left.status } : status,
    workflowStage: left ? { ...workflowStage, ...left.workflowStage } : workflowStage,
    openAgentIds: [],
  });

  // The offline banner is real UI that pushes the whole workspace down, and a headless browser
  // with no reachable probe endpoint always shows it. The mock has no such banner, so leaving it
  // in would score as a layout-wide diff on every surface. Forced online.
  useConnectionStore.setState({ isOnline: true, browserOnline: true, probeOk: true });

  // ── A HANDLE ON THE CABLE, FOR THE CAPTURE HARNESS ──────────────────────────────────────────
  //
  // The harness reached the wired states by setting `data-wired` on the shell root as a DOM
  // ATTRIBUTE. That never wired anything: the attribute is BOUND to the cable store
  // (`data-wired={wired}` in Workspace), so React owns it, and every surface that actually paints
  // the connection — the concierge's flood and lift are inline styles off `useCableStore` — kept
  // reading "off". The only thing that responded was the handful of `[data-wired]` rules in
  // index.css, which key off the raw attribute. So `workspace-wired-left` came out BYTE-IDENTICAL
  // to `workspace-unwired`, and the two wired surfaces have been scoring the unwired app since they
  // were added.
  //
  // Exposing the store's own action is what makes those surfaces real. Behind the same two gates as
  // everything above (DEV build AND the auth-bypass flag AND `?visual=1`), so it cannot exist in a
  // shipped app.
  // `typeof window` guarded: this module's own suite runs in the NODE environment (it is pure
  // store logic), where a bare `window` reference throws and would take the seeding tests down with
  // it — the fixtures are the thing under test there, not the browser handle.
  if (typeof window !== "undefined") {
    (window as unknown as { __sparkleCable?: (side: "off" | "left" | "right") => void }).__sparkleCable =
      (side) => {
        if (side === "off") useCableStore.getState().unbind();
        else useCableStore.getState().patch(side);
      };

    // ── AND A HANDLE ON THE MIC, FOR THE SAME REASON ──────────────────────────────────────────
    //
    // The voice states (armed-and-listening, focus-paused, preparing, error) are real UI with real
    // copy and NO visual coverage, because reaching them needs a backend: arming the mic opens a
    // device and downloads a model, neither of which exists in a headless browser. This writes the
    // two OBSERVATIONS the state derives from and lets the app's own derivation do the rest.
    //
    // Deliberately NOT a way to set the pause REASON. `focusOwner` stays the focus tracker's to
    // write (voice/dictationFocusTracker, installed in App): a harness that set the reason directly
    // would capture a notice the real focus path can no longer produce — which is how a surface
    // ends up "verified" in a state the app cannot actually reach. Focus a terminal-marked element
    // and the tracker classifies it, exactly as it does for a real xterm pane.
    (window as unknown as { __sparkleMic?: (s: { enabled: boolean }) => void }).__sparkleMic = (s) => {
      useDictationStore.setState({
        enabled: s.enabled,
        status: "idle",
        // The tracker writes this too, but only on a window transition — and a headless page may
        // never see one, which would leave the pause reading as "window" and mask the terminal case.
        windowFocused: true,
        error: null,
        modelProgress: null,
      });
    };
  }

  return true;
}
