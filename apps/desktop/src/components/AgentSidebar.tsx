import { useState, useEffect, useRef, type DragEvent as ReactDragEvent } from "react";
import { createPortal } from "react-dom";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { TbPinFilled, TbBulb } from "react-icons/tb";
import { FaTasks } from "react-icons/fa";
import { C, AGENT_STATUS, FONT, FONT_WEIGHT, CHAT_USER_BUBBLE, ROW_ACTIVE_BUBBLE, ON_BRAND_FILL, ON_BRAND_FILL_DARK, statusInk } from "../theme/colors";
import type { Project, AgentTab, AgentTabStatus } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAiFeature } from "../services/aiGate";
import { removeAgentWorkspace } from "../services/worktree";
import { refreshAgentBranch, landAgentBranch } from "../services/branchStatus";
import type { BranchStatus } from "../services/branchStatus";
import { refreshAgentTitle } from "../services/sessionTitle";
import { SPARKLE_AGENT_ID, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";
import { useBeadsStore } from "../stores/beadsStore";
import { beadLabel, epicForBuild, needsClosePrompt } from "../services/planView";
import { closeBead, type Bead } from "../services/beads";
import { orderAgents } from "../engine/agentOrdering";
import { StatusDot } from "./StatusDot";
import { StatusBar } from "./StatusBar";
import { LogoWaveform } from "./LogoWaveform";
import { FittedAgentName } from "./FittedAgentName";
import { WorkflowLine } from "./WorkflowLine";
import { HistorySearch } from "./HistorySearch";
import { OtherWindowAgentRow } from "./OtherWindowAgentRow";
import { useOtherWindowsRedAgents } from "../useOtherWindowsRedAgents";
import type { OtherWindowAgent } from "../services/windowStatus";
import { emitFocusAgent } from "../services/attention";
import { findWindowForProject } from "../services/windowRegistry";
import { openProjectInWindow, defaultDeps } from "../services/projectWindows";
import { resolveStage, rollupStages, stageFraction, stageIndex } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import { createBeadFull } from "../services/tasks";
import { CloseWorkerPrompt } from "./CloseWorkerPrompt";
import { CloseAgentPrompt } from "./CloseAgentPrompt";
import { BalanceBadge } from "./BalanceBadge";

/**
 * Left column: the current project's agents as a vertical list (spec layout, revised).
 * Each row is a status dot + the agent name rendered in that status's color; click a row
 * to open the agent, double-click the agent name to rename it, ×
 * to close. "+ Agent" adds one.
 */
// The three create buttons (Think / Plan / Build) form one continuous Sparkle blue→cyan
// fade, split into thirds. These are the four fade boundaries: the cyan "S" accent on the far
// left of Think, the primary brand blue on the far right of Build, and two interpolated stops
// at 1/3 and 2/3 so each button paints exactly its slice of the SAME overall gradient.
const FADE_0 = C.accent; // #34e0f0 — logo cyan, far-left edge of Think
const FADE_1 = "#32b9f5"; // 1/3 stop (Think→Plan seam)
const FADE_2 = "#3192fa"; // 2/3 stop (Plan→Build seam)
const FADE_3 = C.teal; // #2f6bff — primary brand blue, far-right edge of Build

// Depth (px) of the chevron point/notch carved into a button's vertical edge.
const CHEVRON = 11;

// Width (px) of the hairline left between adjacent chevrons. We underlap the tessellation by this
// much (overlap = CHEVRON - SEAM) so a thin diagonal sliver of the wrapper's background shows
// through at each Think→Plan / Plan→Build seam.
const SEAM = 1;

// Build the clip-path for a button in the chevron strip. The OUTER edges of the strip
// (Think's left, Build's right) stay flat ("vertical button surfaces"); interior seams are
// arrow-shaped: a button that isn't last grows a rightward point, a button that isn't first
// gets a matching inward notch on its left so the previous button's point nests into it.
function chevronClip(leftNotch: boolean, rightPoint: boolean): string {
  const d = `${CHEVRON}px`;
  const pts: string[] = ["0 0"];
  if (rightPoint) {
    pts.push(`calc(100% - ${d}) 0`, "100% 50%", `calc(100% - ${d}) 100%`);
  } else {
    pts.push("100% 0", "100% 100%");
  }
  pts.push("0 100%");
  if (leftNotch) pts.push(`${d} 50%`);
  return `polygon(${pts.join(", ")})`;
}

// Shared style for a chevron in the mode strip: a solid gradient slice with NO border/stroke,
// clipped to its chevron shape. `fillText` is the per-chevron ink chosen for contrast on that fill.
// The strip's rounded outer corners come from the wrapper (overflow:hidden + borderRadius), so the
// chevrons themselves are square; `leftNotch` chevrons overlap the previous one by CHEVRON px
// (negative margin) so the point tessellates exactly into the notch. `active` is the currently
// selected mode: the active chevron keeps its brand color; the other two render grayscale.
function createBtnStyle(
  from: string,
  to: string,
  fillText: string,
  leftNotch: boolean,
  rightPoint: boolean,
  active: boolean,
): React.CSSProperties {
  return {
    flex: 1,
    padding: "9px 10px",
    border: "none",
    borderRadius: 0,
    marginLeft: leftNotch ? -(CHEVRON - SEAM) : 0,
    clipPath: chevronClip(leftNotch, rightPoint),
    cursor: "pointer",
    fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 13,
    whiteSpace: "nowrap",
    background: `linear-gradient(90deg, ${from}, ${to})`,
    color: fillText,
    // The active mode shows its brand color; the inactive two desaturate to grayscale.
    filter: active ? "none" : "grayscale(1)",
    opacity: active ? 1 : 0.9,
    transition: "filter 120ms ease, opacity 120ms ease",
    // Flex-center the (enlarged, line-height-0) glyph against the label so the
    // icon sits on the label's vertical center rather than its text baseline.
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  };
}

// A dashed-outline "+ New <kind> Agent" row — the per-mode affordance for creating an agent,
// shown at the top of the sidebar list (under Search history) for the active Build/Think mode.
const DASHED_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  margin: "2px 0 8px",
  padding: "9px 10px",
  border: `1px dashed ${C.muted}`,
  borderRadius: 8,
  background: "transparent",
  color: C.muted,
  fontFamily: '"IBM Plex Sans", sans-serif',
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
};

export function AgentSidebar({ project }: { project: Project | null }) {
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const touchProjectOpened = useProjectStore((s) => s.touchProjectOpened);
  const addAgent = useProjectStore((s) => s.addAgent);
  const setAgentBeadId = useProjectStore((s) => s.setAgentBeadId);
  const removeAgent = useProjectStore((s) => s.removeAgent);
  const open = useRuntimeStore((s) => s.open);
  const close = useRuntimeStore((s) => s.close);
  const status = useRuntimeStore((s) => s.status);
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const workflowShipped = useRuntimeStore((s) => s.workflowShipped);
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);

  // Red agents in OTHER open windows — surfaced as a block at the top of the sidebar.
  const otherWindowRedAgents = useOtherWindowsRedAgents();
  // Clicking such a row raises the owning window and selects the agent. Same three-way router as
  // HistorySearch.onResultClick: same project → focus in place; another OPEN window → emitFocusAgent
  // (the live path, since these only come from open windows); no window → open one (covers the rare
  // race where that window closed between render and click).
  const onOtherWindowAgentClick = (a: OtherWindowAgent) => {
    if (project && a.projectId === project.id) {
      open(a.agentId);
      selectAgent(a.projectId, a.agentId);
      return;
    }
    if (findWindowForProject(a.projectId) != null) {
      emitFocusAgent({ projectId: a.projectId, agentId: a.agentId });
    } else {
      void openProjectInWindow(
        a.projectId,
        "new",
        defaultDeps(() => {}, touchProjectOpened, "main"),
        a.agentId,
      );
    }
  };

  // Which chevron is selected. Drives both the strip's coloring (active = brand, others grayscale)
  // and which agents the sidebar list shows. Defaults to Build; not persisted across launches.
  const [mode, setMode] = useState<"think" | "plan" | "build">("build");
  const agentOrdering = useUiStore((s) => s.agentOrdering);
  // The workflow stage an agent's own git state + any known override resolves to.
  const stageOf = (id: string): WorkflowStageId =>
    resolveStage(branchStatus[id], workflowStage[id]);
  // Has this agent ever shipped (reached On Main+)? Sticky flag set by refreshWorkflowStage, OR'd
  // with the current resolved stage so the ✓ shows even on the first tick that lands it.
  const shippedOf = (id: string): boolean =>
    (workflowShipped[id] ?? false) || stageIndex(stageOf(id)) >= stageIndex("merged");

  // Keep the workflow trackers live: re-poll branch + workflow state on a modest cadence (and once
  // immediately on project switch), so the chevrons advance toward green as work is committed, PR'd,
  // and merged without the user touching anything. Reads fresh state from the stores inside the tick
  // so the effect only re-subscribes on project change, not on every status update.
  const projectId = project?.id;
  useEffect(() => {
    if (!projectId) return;
    // A slow tick (the gh PR probe can take ~0.5s/agent) must not overlap the next interval.
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const proj = useProjectStore.getState().projects.find((p) => p.id === projectId);
        if (!proj) return;
        const { openAgentIds, pollBranchStatus: poll } = useRuntimeStore.getState();
        const hasWorkflow = (a: (typeof proj.agents)[number]) =>
          a.kind !== "think" && a.kind !== "shell"; // those have no git workflow
        // Targets: every OPEN agent, PLUS the orchestrator parent of each open worker — even when
        // that parent's pane is closed — so a worker's "Merged" (which reads its parent's stage)
        // can still advance. De-duped by id.
        const targets = new Map<string, (typeof proj.agents)[number]>();
        for (const a of proj.agents) {
          if (!openAgentIds.includes(a.id) || !hasWorkflow(a)) continue;
          targets.set(a.id, a);
          if (a.kind === "worker" && a.parentId) {
            const parent = proj.agents.find((p) => p.id === a.parentId);
            if (parent && hasWorkflow(parent)) targets.set(parent.id, parent);
          }
        }
        const all = [...targets.values()];
        // Auto-name each agent from Claude Code's own session title (ai-title in the transcript) —
        // the authoritative name once the first turn has summarized. Fire-and-forget, independent
        // of the branch-status polls below; the store action respects pins + de-dupes.
        for (const a of all) void refreshAgentTitle(proj.id, a.id, a.worktreePath);
        // Poll orchestrators (worker parents) first and await them, so a worker's derive in this
        // same round reads its parent's fresh stage rather than lagging a tick behind.
        const parents = all.filter((a) => a.kind === "build");
        const rest = all.filter((a) => a.kind !== "build");
        await Promise.all(parents.map((a) => poll(proj.rootPath, proj.id, a.id, a.baseBranch ?? "")));
        await Promise.all(rest.map((a) => poll(proj.rootPath, proj.id, a.id, a.baseBranch ?? "")));
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 30_000);
    return () => clearInterval(id);
  }, [projectId]);
  // AI Brainstorming feature gate (Use AI Features menu). Off → hide the ✦ Brainstorm button.
  const aiBrainstorm = useAiFeature("brainstorm");
  const [editing, setEditing] = useState<string | null>(null);
  // Which agent the Ship/Save/Discard close prompt is asking about (null = no prompt).
  const [closePromptId, setClosePromptId] = useState<string | null>(null);

  // Draggable column width — persisted to localStorage so it survives relaunch. Clamped to
  // a sane range so the column can't be dragged to nothing or take over the window.
  const MIN_WIDTH = 160;
  const MAX_WIDTH = 480;
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("sparkle-sidebar-width"));
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 220;
  });

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (ev.clientX - startX)));
      setWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist once the drag settles rather than on every intermediate pixel.
      localStorage.setItem("sparkle-sidebar-width", String(latest));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onSelect = (id: string) => {
    if (!project) return;
    // Switching to a normal project agent leaves the special (Sparkle) view.
    setActiveSpecial(null);
    selectAgent(project.id, id);
    open(id);
  };
  const onAddThink = () => {
    if (!project) return;
    setActiveSpecial(null); // creating an agent leaves the special (Sparkle) view
    // Think now allows multiple agents per project: always create a fresh one (parallels Build).
    const id = addAgent(project.id, { kind: "think" });
    selectAgent(project.id, id);
    open(id);
  };
  // The chevron strip switches the active (colored) mode and filters the sidebar list by kind. Think
  // and Build are two-stage: the FIRST click (when that mode isn't already the active section) just
  // switches into the section; clicking the SAME chevron AGAIN while already in that section spawns a
  // fresh agent of that kind (same as the "+ New Think/Build Agent" buttons). Plan stays a pure mode
  // switch: it has no agent concept and only opens the read-only Tasks board in the main pane.
  const onPickThink = () => {
    // "Already in the Think section" = Think mode AND not parked in a special (Sparkle/board) view.
    const alreadyHere = mode === "think" && activeSpecial === null;
    setMode("think");
    setActiveSpecial(null);
    if (!alreadyHere || !project) return;
    const id = addAgent(project.id, { kind: "think" });
    selectAgent(project.id, id);
    open(id);
  };
  const onPickPlan = () => {
    setMode("plan");
    setActiveSpecial("board");
  };
  // Spawn a build agent AND auto-create a bead for it, so every piece of build work is tracked
  // from the start (it floors at "Planned" until code work begins). The agent is created
  // synchronously (immediately usable); the bead is created async + best-effort and attached when
  // `bd` returns — a build agent without a bead is still fine if bd is unavailable.
  const spawnBuildAgent = () => {
    if (!project) return;
    const proj = project;
    const id = addAgent(proj.id, { kind: "build" });
    selectAgent(proj.id, id);
    open(id);
    // Title the bead with the agent's (default) name so beads stay distinguishable on the board
    // rather than a row of identical placeholders. (Syncing the title when the agent auto-renames
    // from its first prompt is a follow-up.) Note: if the user removes the agent within the sub-
    // second `bd create` window, the bead is orphaned — an accepted best-effort tradeoff that the
    // Discard/prune flows mop up.
    const title =
      useProjectStore
        .getState()
        .projects.find((p) => p.id === proj.id)
        ?.agents.find((a) => a.id === id)?.name ?? "Build task";
    void createBeadFull(proj.rootPath, title, "", "task", "", "", "")
      .then((beadId) => setAgentBeadId(proj.id, id, beadId))
      .catch((e) => console.warn("auto-bead creation failed (bd unavailable?):", e));
  };
  const onPickBuild = () => {
    const alreadyHere = mode === "build" && activeSpecial === null;
    setMode("build");
    setActiveSpecial(null);
    if (!alreadyHere || !project) return;
    spawnBuildAgent();
  };
  const onAddBuild = () => {
    setActiveSpecial(null);
    spawnBuildAgent();
  };
  const onSelectSparkle = () => {
    setActiveSpecial("sparkle");
    open(SPARKLE_AGENT_ID);
  };
  // Land an agent's work into its integration target: a worker → its orchestrator's branch; a build
  // agent → the project's default branch. A local --no-ff merge (see Rust land_agent_branch); the
  // tracker then advances to On Main on the next poll. Best-effort feedback via console for now
  // (dirty/conflict/etc.) — a full toast is a follow-up, matching the refresh button's pattern.
  const onLand = async (a: AgentTab): Promise<boolean> => {
    if (!project) return false;
    // Build agents ALWAYS integrate into the project's default branch — regardless of the base they
    // were spawned from — because that's the ref "On Main"/"Merged" reachability is measured against
    // (Rust resolve_default_branch), so a successful Land actually advances the chevron to green. The
    // deliberate tradeoff: a build agent intentionally cut from a NON-default integration branch is
    // still landed into the default, not that base. baseBranch is only a last-resort fallback when
    // the default is unknown. (In practice build agents are cut from the default, so this is rarely
    // observable; workers, which DO target their orchestrator's branch, are handled above.)
    const target =
      a.kind === "worker" && a.parentId
        ? `sparkle/agent-${a.parentId}`
        : project.defaultBranch ?? a.baseBranch ?? "main";
    // The target tree must be clean. For a worker the target is the live orchestrator — gate on it
    // not actively working so we never merge under a running agent. (A build agent lands into the
    // project root, which has no PTY of its own.)
    const targetBusy =
      a.kind === "worker" && a.parentId
        ? useRuntimeStore.getState().status[a.parentId] === "working"
        : false;
    const r = await landAgentBranch(project.rootPath, a.id, target, targetBusy);
    if (r.ok) {
      // Refresh the agent and (for a worker) its orchestrator so both trackers reflect the landing.
      void pollBranchStatus(project.rootPath, project.id, a.id, a.baseBranch ?? "");
      if (a.kind === "worker" && a.parentId) {
        const parent = project.agents.find((p) => p.id === a.parentId);
        void pollBranchStatus(project.rootPath, project.id, a.parentId, parent?.baseBranch ?? "");
      }
      return true;
    } else {
      console.warn("land blocked:", r.reason, r.files ?? "");
      return false;
    }
  };
  // The raw teardown: stop the PTYs + remove each worktree (the branch is KEPT), then remove the
  // agent (cascades to its workers). This is "Keep it for later" / a silent close of empty work.
  const doClose = (id: string) => {
    if (!project) return;
    const childIds = project.agents.filter((a) => a.parentId === id).map((a) => a.id);
    for (const cid of [id, ...childIds]) {
      close(cid);
      void removeAgentWorkspace(project.rootPath, project.id, cid).catch(() => {});
    }
    removeAgent(project.id, id);
  };
  const onClose = (id: string) => {
    if (!project) return;
    // If this agent has UNMERGED work, never silently destroy it — ask Ship / Save / Discard.
    if (needsClosePrompt(stageOf(id))) {
      setClosePromptId(id);
      return;
    }
    doClose(id);
  };
  // Ship / Save / Discard handlers for the close prompt.
  const closingAgent = project?.agents.find((a) => a.id === closePromptId) ?? null;
  const onShipClose = async () => {
    const a = closingAgent;
    if (!a || !project) {
      setClosePromptId(null);
      return;
    }
    const landed = await onLand(a); // merge to main (logs the reason if blocked)
    if (!landed) return; // land blocked (conflict/dirty/busy) — LEAVE the prompt open so the
    // failure is visible and the user can resolve, or pick Keep-for-later / Discard instead.
    setClosePromptId(null);
    if (a.beadId)
      void closeBead(project.rootPath, a.beadId).catch((e) => console.warn("bead close failed:", e));
    doClose(a.id);
  };
  const onSaveClose = () => {
    const a = closingAgent;
    setClosePromptId(null);
    if (a) doClose(a.id); // keeps the branch + leaves the bead on the Plan board at its stage
  };
  const onDiscardClose = () => {
    const a = closingAgent;
    setClosePromptId(null);
    if (!a || !project) return;
    // Stop tracking + discard unsaved changes: closeBead so it's not left tracked as open; the
    // worktree --force in doClose discards uncommitted work. Committed work on the branch remains
    // and is tidied up by the branch-prune flow (true branch-deletion on discard is a follow-up).
    if (a.beadId)
      void closeBead(project.rootPath, a.beadId).catch((e) => console.warn("bead close failed:", e));
    doClose(a.id);
  };

  // "Close this worker?" nudge. When a worker's branch reaches Merged, its work is in main and the
  // worker is redundant — pop a one-time modal recommending (not forcing) closing it. State:
  //  - mergePromptId: which worker the modal is currently asking about (null = no modal).
  //  - promptedIds: workers we've already asked about this session, so we never re-nag.
  //  - seenStageRef: last-observed stage per worker. We prompt ONLY on a live non-merged→merged
  //    EDGE, never merely because a worker "is merged": first sight (incl. a worker already Merged
  //    at mount) seeds silently, and a later poll that re-confirms Merged is not an edge either.
  //  - pendingRef: workers that crossed the edge but haven't been shown yet (e.g. a second worker
  //    that merged while the first modal was still up) — drained one at a time as the modal frees.
  const [mergePromptId, setMergePromptId] = useState<string | null>(null);
  const [promptedIds, setPromptedIds] = useState<Set<string>>(() => new Set());
  // Manual reorder drag state (spec: manual-agent-reorder-pin). The id of the top-level agent
  // currently being dragged by its grip; drop pins it at the target row via pinAgentAt.
  const pinAgentAt = useProjectStore((s) => s.pinAgentAt);
  const [dragId, setDragId] = useState<string | null>(null);
  const onAgentDragStart = (id: string) => setDragId(id);
  const onAgentDragEnd = () => setDragId(null);
  const onAgentDrop = (index: number, targetId: string) => {
    // Skip a self-drop (released on the agent's own row): it's a no-op move, so don't pin/freeze
    // the name for a drag that visually did nothing (roborev 13174/13175).
    if (dragId && project && dragId !== targetId) pinAgentAt(project.id, dragId, index);
    setDragId(null);
  };
  const seenStageRef = useRef<Record<string, WorkflowStageId>>({});
  const pendingRef = useRef<string[]>([]);
  useEffect(() => {
    if (!project) return;
    const seen = seenStageRef.current;
    const present = new Set<string>();
    for (const a of project.agents) {
      if (a.kind !== "worker") continue;
      present.add(a.id);
      // Wait for this worker's first REAL polled datum before seeding. The live stores aren't
      // persisted (see runtimeStore), so on a fresh launch they're empty at mount and
      // resolveStage(undefined, undefined) would yield a non-merged DEFAULT. Seeding that and
      // then receiving a first poll of "merged" would look like a live edge and nag about a
      // worker that was already merged before launch. Skipping until real data arrives makes
      // that first poll the SEED, not an edge.
      const hasData = branchStatus[a.id] !== undefined || workflowStage[a.id] !== undefined;
      if (!hasData) continue;
      const stage = resolveStage(branchStatus[a.id], workflowStage[a.id]);
      const prev = seen[a.id];
      seen[a.id] = stage;
      // Only a live edge INTO merged qualifies. `prev === undefined` is the worker's first real
      // datum (seed only — this is what keeps an already-Merged worker quiet, whether it was
      // merged at mount or by the first poll); `prev === "merged"` is a re-confirm, not an edge.
      // Queue the id unless we've already shown or queued it.
      const edge = prev !== undefined && prev !== "merged" && stage === "merged";
      if (edge && !promptedIds.has(a.id) && !pendingRef.current.includes(a.id)) {
        pendingRef.current.push(a.id);
      }
    }
    // Forget closed workers in the stage map + queue so a recycled id can't carry a stale stage
    // and a closed worker can't linger unshown. (promptedIds is intentionally NOT pruned: it's a
    // small session-scoped set, worker ids are UUIDs and never reused, and retaining it guarantees
    // a worker we've already asked about is never asked again.)
    for (const id of Object.keys(seen)) if (!present.has(id)) delete seen[id];
    pendingRef.current = pendingRef.current.filter((id) => present.has(id));
    // Show the next queued worker when no modal is up. Marking it promptedIds here makes the ask
    // one-time even if it stays Merged across later polls.
    if (!mergePromptId && pendingRef.current.length > 0) {
      const id = pendingRef.current.shift() as string;
      setMergePromptId(id);
      setPromptedIds((s) => new Set(s).add(id));
    }
  }, [project, branchStatus, workflowStage, promptedIds, mergePromptId]);
  // Drop a pending prompt if its worker was closed out from under it (e.g. via the row's × button),
  // so a stale id can't block the modal. (Queued-but-unshown ids are pruned in the effect above.)
  useEffect(() => {
    if (mergePromptId && project && !project.agents.some((a) => a.id === mergePromptId)) {
      setMergePromptId(null);
    }
  }, [project, mergePromptId]);
  const onMergePromptClose = () => {
    const id = mergePromptId;
    setMergePromptId(null);
    if (id) onClose(id);
  };
  const onMergePromptKeep = () => setMergePromptId(null);
  // Think is AI-feature-gated. If the gate turns off while Think mode is selected, the Think chevron
  // disappears — fall back to Build so we're never stuck on a hidden mode with an empty sidebar.
  useEffect(() => {
    if (!aiBrainstorm && mode === "think") setMode("build");
  }, [aiBrainstorm, mode]);
  // Top-level agents (group heads + orphaned workers), matching the list's isTopLevel logic. Used so
  // the per-mode empty hints key off the SAME set the list renders — never "No X agents" beside rows.
  const topLevelAgents = project
    ? (() => {
        const buildIds = new Set(
          project.agents.filter((a) => a.kind === "build").map((a) => a.id),
        );
        return project.agents.filter((a) => !a.parentId || !buildIds.has(a.parentId));
      })()
    : [];

  return (
    <div
      style={{
        width,
        flex: "0 0 auto",
        position: "relative",
        background: C.deepForest,
        borderRight: `1px solid ${C.forest}`,
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* position:relative + zIndex keep the Sparkle.ai logo IN FRONT of the voice-orb glow
          that the waveform paints below — the glow can bleed upward into this row, but the
          logo must stay crisp on top of it, never washed out behind it. */}
      <div
        style={{
          padding: "14px 14px 6px",
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        {/* Anchor (not a bare clickable <img>) so the logo is focusable and announced as a
            link; the system browser is opened via the Tauri opener, so we preventDefault and
            surface any opener failure rather than swallowing the promise. */}
        <a
          href="https://sparkle.ai"
          title="Open sparkle.ai"
          onClick={(e) => {
            e.preventDefault();
            openUrl("https://sparkle.ai").catch((err) =>
              console.error("Failed to open sparkle.ai:", err),
            );
          }}
          style={{ display: "inline-flex", cursor: "pointer" }}
        >
          <img src="/sparkle-logo.svg" alt="Sparkle" style={{ height: 25 }} />
        </a>
        {/* Remaining AI-credit balance, top-right of the left column beside the wordmark. */}
        <BalanceBadge />
      </div>
      <LogoWaveform />

      {project && (
        <div
          style={{
            display: "flex",
            margin: "0 10px 8px",
            borderRadius: 8,
            overflow: "hidden",
            // Seam between chevrons = the sidebar background (light gray, theme-aware), not white.
            background: C.deepForest,
          }}
        >
          {/* Think / Plan / Build form one chevron strip painting a single blue→cyan fade. It's a
              MODE SELECTOR: the active chevron keeps its color, the other two go grayscale.
              Think is AI feature-gated (the "Enable AI Thinking" toggle): off → it disappears
              and Plan becomes the strip's flat-left start. The gate flag stays aiBrainstorm. */}
          {aiBrainstorm && (
            <button
              onClick={onPickThink}
              title="Think mode — your Think agents"
              // First in the strip: flat left, points right into Plan. Cyan ("S" color) leads; dark ink.
              style={createBtnStyle(FADE_0, FADE_1, ON_BRAND_FILL_DARK, false, true, mode === "think")}
            >
              <TbBulb size={18} style={{ flexShrink: 0 }} />
              <span>Think</span>
            </button>
          )}
          <button
            onClick={onPickPlan}
            title="Plan mode — this project's read-only Tasks board"
            // Full chevron when Think is present (notch left + point right); flat-left start when not.
            style={createBtnStyle(FADE_1, FADE_2, ON_BRAND_FILL_DARK, aiBrainstorm, true, mode === "plan")}
          >
            <FaTasks size={14} style={{ flexShrink: 0 }} />
            <span>Plan</span>
          </button>
          <button
            onClick={onPickBuild}
            title="Build mode — your Build orchestrator agents"
            // Last in the strip: notched left (receives Plan's point), flat right. White ink.
            style={createBtnStyle(FADE_2, FADE_3, ON_BRAND_FILL, true, false, mode === "build")}
          >
            <span style={{ fontSize: 26, lineHeight: 0, transform: "translateY(-3.5px)" }}>⚒</span>
            <span>Build</span>
          </button>
        </div>
      )}

      {/* Full-text search across all projects' prompts & responses. Lives directly under the
          chevron strip; hidden in Plan mode (the sidebar is kept clear for the board). */}
      {project && mode !== "plan" && <HistorySearch />}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        {/* Cross-window attention block: red agents from OTHER open windows, each tagged with a
            project pill. Its own section above this window's own agents; hidden when there are none.
            Click raises the owning window and selects the agent (onOtherWindowAgentClick). */}
        {otherWindowRedAgents.length > 0 && (
          <div style={{ paddingBottom: 6, marginBottom: 4, borderBottom: `1px solid ${CHAT_USER_BUBBLE}` }}>
            {otherWindowRedAgents.map((a) => (
              <OtherWindowAgentRow
                key={`${a.windowLabel}:${a.agentId}`}
                agent={a}
                onClick={() => onOtherWindowAgentClick(a)}
              />
            ))}
          </div>
        )}
        {/* Per-mode "+ New … Agent" affordance — the only way to create agents now that the chevrons
            are a selector. Sits above the (mode-filtered) list. Plan has none (no agents in Plan). */}
        {project && mode === "build" && (
          <button onClick={onAddBuild} title="Create a new Build orchestrator agent" style={DASHED_ROW_STYLE}>
            <span style={{ fontSize: 20, lineHeight: 0 }}>⚒</span>
            <span>+ New Build Agent</span>
          </button>
        )}
        {project && mode === "think" && aiBrainstorm && (
          <button onClick={onAddThink} title="Create a new Think agent" style={DASHED_ROW_STYLE}>
            <TbBulb size={16} style={{ flexShrink: 0 }} />
            <span>+ New Think Agent</span>
          </button>
        )}
        {(() => {
          if (!project) return null;
          if (mode === "plan") return null; // Plan: sidebar list stays clear (board shows in main pane)
          // A worker is "orphaned" if its parentId doesn't resolve to a present build agent
          // (e.g. a corrupted/partially-migrated record). Surface those at the top level so they
          // stay visible and closable rather than vanishing from the UI while still in the store.
          const buildIds = new Set(
            project.agents.filter((a) => a.kind === "build").map((a) => a.id),
          );
          const isTopLevel = (a: (typeof project.agents)[number]) =>
            !a.parentId || !buildIds.has(a.parentId);
          // Only the top-level stack reorders; nested workers stay under their parent in
          // insertion order. Selection is tracked by id (project.selectedAgentId), so re-sorting
          // never changes which agent is open. "manual" keeps insertion order, as before.
          // The active chevron filters the list by kind: Think shows think agents; Build shows
          // everything else (build agents + any orphaned workers surfaced at top level).
          const topLevel = project.agents
            .filter(isTopLevel)
            .filter((a) => (mode === "think" ? a.kind === "think" : a.kind !== "think"));
          const ordered =
            agentOrdering === "attention"
              ? orderAgents(topLevel, status)
              : topLevel;
          return ordered.map((top, orderedIndex) => {
            const workers =
              top.kind === "build"
                ? project.agents.filter((w) => w.parentId === top.id)
                : [];
            // The orchestrator's chevron rolls up its workers (overall = least-advanced worker);
            // with no workers it just shows its own git stage. A worker/think/shell row shows
            // its own. (Think has no worktree, so it resolves to the harmless start stage and
            // we simply don't render a tracker for it — see renderRow.)
            const workerStages = workers.map((w) => stageOf(w.id));
            const rollup = rollupStages(workerStages);
            // Each worker's collapsed bare line + expanded detail now live INSIDE the orchestrator's
            // own AgentRow (workers are no longer their own selectable rows). Pre-compute the minimal
            // per-worker view-model here, where stageOf/status/branchStatus/shippedOf are in scope.
            const workerDetails = workers.map((w) => {
              const wst = status[w.id] ?? "stopped";
              const wcolor =
                AGENT_STATUS[wst].color === AGENT_STATUS.done.color
                  ? C.agentIdle
                  : AGENT_STATUS[wst].color;
              return {
                id: w.id,
                name: w.name,
                autoTitle: w.autoNameVariants?.title?.trim() || null,
                description: w.autoNameVariants?.description?.trim() || "",
                stage: stageOf(w.id) as WorkflowStageId | null,
                status: wst,
                statusColor: wcolor,
                branchStatus: branchStatus[w.id],
                shipped: shippedOf(w.id),
                worktreePath: w.worktreePath,
                baseBranch: w.baseBranch,
                onLand: () => onLand(w),
              };
            });
            const renderRow = (
              a: (typeof project.agents)[number],
              trackerStage: WorkflowStageId | null,
              rowIndex?: number,
            ) => {
          const st = status[a.id] ?? "stopped";
          // Resolve the status color to a light-mode-legible TEXT ink: the brand gray (idle,
          // blocked, done, stopped) and the brand green (working) are too light on the white
          // light sidebar, so statusInk darkens both in light mode while keeping them brand-color
          // in dark; red/amber pass through. (See statusInk — it tracks the AGENT_STATUS taxonomy.)
          const color = statusInk(AGENT_STATUS[st].color);
          const isActive = !activeSpecial && project.selectedAgentId === a.id;
          const bs = branchStatus[a.id];
          // The ✓ on the head row reflects the whole build: itself OR any worker that has shipped.
          const rowShipped =
            shippedOf(a.id) || (a.id === top.id && workers.some((w) => shippedOf(w.id)));
          // Indent by tree position, not by parentId: the group head (top) sits at depth 0 — so
          // an orphaned worker surfaced as its own head isn't mis-indented — and real children at 1.
          const depth = a.id === top.id ? 0 : 1;
          return (
            <AgentRow
              key={a.id}
              project={project}
              a={a}
              depth={depth}
              isActive={isActive}
              st={st}
              statusColor={color}
              bs={bs}
              trackerStage={trackerStage}
              shipped={rowShipped}
              workerCount={a.id === top.id ? workers.length : 0}
              workers={a.id === top.id ? workerDetails : []}
              orderedIndex={rowIndex}
              dragActive={dragId != null}
              onDragStartAgent={onAgentDragStart}
              onDragEndAgent={onAgentDragEnd}
              onDropAgent={onAgentDrop}
              editing={editing === a.id}
              setEditing={setEditing}
              onSelect={() => onSelect(a.id)}
              onLand={() => onLand(a)}
              onClose={() => onClose(a.id)}
            />
          );
            }; // end renderRow

            // The orchestrator's own chevron: the roll-up of its workers, or its own git stage when
            // it has none. Think/shell agents have no git workflow → no tracker (null).
            const headStage: WorkflowStageId | null =
              top.kind === "think" || top.kind === "shell"
                ? null
                : rollup
                  ? rollup.stage
                  : stageOf(top.id);
            // The orchestrator's head row now owns its workers: each worker renders as a bare
            // indented progress line below the head (collapsed), and as a stacked detail block on
            // the head's hover overlay (expanded) — see AgentRow's `workers` prop. The old
            // collapse/expand roll-up bar and per-worker rows are gone.
            return <div key={top.id}>{renderRow(top, headStage, orderedIndex)}</div>;
          });
        })()}
        {/* Per-mode empty hint: the dashed "+ New …" row above is the call to action. */}
        {project &&
          mode === "build" &&
          topLevelAgents.filter((a) => a.kind !== "think").length === 0 && (
            <div style={{ color: C.muted, fontSize: 12, padding: "2px 10px 10px", lineHeight: 1.5 }}>
              No Build agents yet — use <strong>+ New Build Agent</strong> above to start one.
            </div>
          )}
        {project &&
          mode === "think" &&
          aiBrainstorm &&
          topLevelAgents.filter((a) => a.kind === "think").length === 0 && (
            <div style={{ color: C.muted, fontSize: 12, padding: "2px 10px 10px", lineHeight: 1.5 }}>
              No Think agents yet — use <strong>+ New Think Agent</strong> above to start one.
            </div>
          )}
        {!project && (
          <div style={{ color: C.muted, fontSize: 12, padding: 10, lineHeight: 1.5 }}>
            Create a project to add agents.
          </div>
        )}
      </div>

      {/* Pinned above the footer: the Sparkle self-improvement agent. Always present (even with
          no project open), can't be closed — it works on Sparkle itself, not the user's project. */}
      <SparkleAgentRow
        active={activeSpecial === "sparkle"}
        status={status[SPARKLE_AGENT_ID] ?? "stopped"}
        onSelect={onSelectSparkle}
      />

      {/* Bottom-left: version + "Show logs". Pinned under the agent list. */}
      <StatusBar />

      {/* "Close this worker?" nudge, shown when a worker's branch reaches Merged. */}
      {mergePromptId && (
        <CloseWorkerPrompt onClose={onMergePromptClose} onKeep={onMergePromptKeep} />
      )}

      {/* Ship / Save / Discard, shown when closing an agent that has unmerged work. */}
      {closingAgent && (
        <CloseAgentPrompt
          onShip={onShipClose}
          onSave={onSaveClose}
          onDiscard={onDiscardClose}
          onCancel={() => setClosePromptId(null)}
        />
      )}

      {/* Drag handle on the right edge — resize the column wider/narrower. */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        style={{
          // Kept fully inside the column (right:0) so the 6px hit area can't intercept
          // clicks on the adjacent panel's left edge.
          position: "absolute",
          top: 0,
          right: 0,
          width: 6,
          height: "100%",
          cursor: "col-resize",
          zIndex: 1,
        }}
      />
    </div>
  );
}

// The leading glyph slot is a fixed height so the glyph AND the title beside it sit at the exact
// same spot whether the card is collapsed or expanded — on hover the card only grows DOWNWARD,
// so the eye never sees the pickaxe or title jump. Module-level so the elapsed timer can match it.
const GLYPH_SLOT_H = 20;

// Format an elapsed duration (ms) for the sidebar timer: integer seconds while under 100s (each
// second is visible there), then minutes / hours / days each to one decimal with a trailing ".0"
// stripped (so 2 minutes reads "2m", 1.5 reads "1.5m"). Pure + exported for testing.
export function formatElapsed(ms: number): string {
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (ms < 100 * SEC) return `${Math.floor(ms / SEC)}s`;
  const oneDp = (n: number) => {
    const s = n.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (ms < 100 * MIN) return `${oneDp(ms / MIN)}m`;
  if (ms < 24 * HOUR) return `${oneDp(ms / HOUR)}h`;
  return `${oneDp(ms / DAY)}d`;
}

/**
 * One ticking clock per agent row. Returns a `now` (epoch ms) that advances every 1s while the
 * agent has been idle under 100s (where each second matters) and relaxes to a 5s beat after that.
 * Owned ONCE by the row and shared by BOTH the collapsed and the hover-overlay ElapsedTimer, so the
 * elapsed count is identical in both — going on/off hover never swaps to a second timer with its own
 * out-of-phase clock, which previously made the count visibly jump backward (read as a spurious
 * "reset"). `since` is the user's last interaction; null means no timer, so the interval is skipped.
 */
function useRowClock(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const fast = since != null && now - since < 100_000;
  useEffect(() => {
    if (since == null) return;
    const id = setInterval(() => setNow(Date.now()), fast ? 1000 : 5000);
    return () => clearInterval(id);
  }, [fast, since]);
  return now;
}

/**
 * Presentational elapsed counter: shows how long since `since` (the user's last interaction with the
 * agent — a composer Send or terminal keystroke) given the row's shared `now`. The value resets only
 * when `since` advances (a new prompt/keystroke), never on hover. Takes the agent's status color so
 * the counter matches the name (green / red / gray); tabular-nums so it never jitters as digits
 * change. Stateless by design — the ticking clock lives in useRowClock so both render sites agree.
 */
function ElapsedTimer({ since, now, color }: { since: number; now: number; color: string }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: GLYPH_SLOT_H,
        display: "flex",
        alignItems: "center",
        fontSize: 11,
        color,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatElapsed(Math.max(0, now - since))}
    </div>
  );
}

// The minimal per-worker view-model an orchestrator row needs to render its workers itself: one
// bare indented progress line per worker collapsed, and a stacked Location/Status/Progress block
// per worker in the hover overlay. Computed in AgentSidebar (where stageOf/status/branchStatus are
// in scope) and threaded down so workers share the orchestrator's single hover target. `onLand`
// fires the same merge as a standalone worker row's green pill did. `[]` for non-orchestrator rows.
type WorkerDetail = {
  id: string;
  name: string;
  autoTitle: string | null;
  description: string;
  stage: WorkflowStageId | null;
  status: AgentTabStatus;
  statusColor: string;
  branchStatus?: BranchStatus;
  shipped: boolean;
  worktreePath: string | null;
  baseBranch: string | null;
  onLand: () => void;
};

/**
 * One agent row. Collapsed (default) it shows: the kind glyph, the status dot, the width-fitted
 * name, a behind/ahead pill, and a thin progress line across the bottom. On hover the row "slides
 * out" to the right OVER the terminal (a fixed-position overlay, not a modal), revealing the full
 * name, the working-directory path, and the progress line's status label. The build glyph sits left
 * of the dot, the dot left of the name (per spec). An orchestrator row additionally renders its
 * `workers` inline: a bare indented progress line each (collapsed) and a stacked detail block each
 * (expanded), so the whole build reads as one card and selecting any part opens the orchestrator.
 */
// Stable empty fallback for the beads selector — a `?? []` literal in a zustand selector returns a
// fresh reference every render and loops the store. Reuse one array.
const NO_BEADS: Bead[] = [];

function AgentRow({
  project,
  a,
  depth,
  isActive,
  st,
  statusColor,
  bs,
  trackerStage,
  shipped,
  workerCount,
  workers,
  orderedIndex,
  dragActive,
  onDragStartAgent,
  onDragEndAgent,
  onDropAgent,
  editing,
  setEditing,
  onSelect,
  onLand,
  onClose,
}: {
  project: Project;
  a: AgentTab;
  depth: number;
  isActive: boolean;
  st: AgentTabStatus;
  statusColor: string;
  bs?: BranchStatus;
  trackerStage: WorkflowStageId | null;
  /** This agent has reached On Main at least once → render a sticky ✓ on the progress line. */
  shipped?: boolean;
  // Number of workers under this row (orchestrators only; 0 for workers/leaf agents) — shown in
  // the hover card's "Progress" line.
  workerCount: number;
  // The orchestrator's workers, rendered inline on this row (collapsed lines + expanded detail).
  // `[]` for every non-orchestrator row.
  workers: WorkerDetail[];
  // The agent's current row in the ordered top-level stack (undefined for nested workers).
  // Passed to renameAgent so a manual rename anchors the row there (the unified pin). Also the
  // drop index for drag-reorder. The drag props are only acted on for top-level rows.
  orderedIndex?: number;
  dragActive: boolean;
  onDragStartAgent: (id: string) => void;
  onDragEndAgent: () => void;
  onDropAgent: (index: number, targetId: string) => void;
  editing: boolean;
  setEditing: (id: string | null) => void;
  onSelect: () => void;
  onLand: () => void;
  onClose: () => void;
}) {
  const renameAgent = useProjectStore((s) => s.renameAgent);
  const unpinAgent = useProjectStore((s) => s.unpinAgent);
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  // Beads for this project (stable fallback to avoid a re-render loop). Drives the Build-tab
  // linkage hovers: a worker shows the bead it's on; an orchestrator shows its epic.
  const beads = useBeadsStore((s) => s.byProject[project.id]?.beads ?? NO_BEADS);
  const beadHover = a.kind === "worker" ? beadLabel(beads, a.beadId) : null;
  const epicHover = a.kind === "build" ? epicForBuild(beads, project.agents, a.id) : null;

  const rowRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  // Set true the instant Escape is pressed so the input's trailing blur (which fires when the field
  // unmounts in this Chromium webview) discards instead of committing — Escape must always cancel.
  const cancelNextBlur = useRef(false);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);

  // Hover open/close with a short close delay, so moving the cursor from the in-flow row onto the
  // overlay sitting on top of it (which fires the row's mouseleave) doesn't flicker it shut.
  const show = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    const el = rowRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width });
    }
    setHover(true);
  };
  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 60);
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  // The overlay is pinned to the row's rect captured at hover time; if the sidebar scrolls (or the
  // window resizes) while it's open it would detach from its row, so just close it on either.
  useEffect(() => {
    if (!hover) return;
    const close = () => setHover(false);
    window.addEventListener("scroll", close, true); // capture: catch the sidebar's inner scroll too
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [hover]);

  const busy = st === "working";
  // The behind/ahead pill + its branch-status geometry now live in AgentDetailLines, which renders
  // the Location/Status/Progress block for this row AND for each inline worker (same logic, no dupe).

  const kindGlyph =
    a.kind === "think" ? (
      <TbBulb size={16} />
    ) : a.kind === "worker" ? (
      "↳"
    ) : a.kind === "shell" ? (
      "▶"
    ) : (
      "⚒"
    );
  // Width of the leading glyph slot, kept identical for the glyph and its hover-state × so the
  // name never shifts horizontally when the row expands.
  const glyphWidth = a.kind === "build" ? 24 : a.kind === "think" ? 20 : 12;

  // Rebase a branch (this row's, or one of its inline workers') onto its base. Parameterized by id +
  // base so the orchestrator's own Status pill and each worker's Status pill share one code path.
  const refreshBranch = async (id: string, base: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Re-read status at click time: the closed-over `busy` could be stale, and this gate is the
    // only thing stopping a rebase under a live agent.
    const liveBusy = useRuntimeStore.getState().status[id] === "working";
    const r = await refreshAgentBranch(project.rootPath, project.id, id, base, liveBusy);
    if (r.ok) void pollBranchStatus(project.rootPath, project.id, id, base);
    else console.warn("refresh blocked:", r.reason, r.files ?? ""); // toast UI is a follow-up
  };
  const handleRefresh = (e: React.MouseEvent) => refreshBranch(a.id, a.baseBranch ?? "", e);

  // The auto-name title (shown truncated when collapsed) and its one-sentence description (revealed
  // on hover). Legacy/manual agents have no title → fall back to the canonical `name`.
  const autoTitle = a.autoNameVariants?.title?.trim() || null;
  const fullTitle = autoTitle || a.name;
  const description = a.autoNameVariants?.description?.trim() || "";
  // Overall completion for the hover "Progress" line: the same fraction the thin line fills to.
  const progressPct = trackerStage ? Math.round(stageFraction(trackerStage) * 100) : null;

  // Epoch ms of the user's last INTERACTION with this agent — the collapsed-row timer counts up
  // from here and resets to 0 the instant the user touches the agent again. "Interaction" is the
  // later of: the most recent composer Send (promptHistory) and the most recent terminal keystroke
  // (interactionStore, throttled). Anchoring to interaction — not just composer prompts — is why a
  // terminal-driven Send now resets the timer too. undefined until the first interaction (no timer).
  const lastInteractionAt = useInteractionStore((s) => s.lastAt[a.id]);
  const lastPromptAt = a.promptHistory[a.promptHistory.length - 1]?.at;
  const lastTouchAt =
    Math.max(lastPromptAt ?? 0, lastInteractionAt ?? 0) || undefined;
  // One clock for the row, shared by the collapsed timer AND the hover-overlay timer so the elapsed
  // count is identical in both and never jumps when the cursor moves on/off the row (see useRowClock).
  const clockNow = useRowClock(lastTouchAt);

  // The pin chip (manual pin: name frozen + row anchored). Click to release. Shared by both states.
  const pinChip = a.namePinned ? (
    <span
      onClick={(e) => {
        e.stopPropagation();
        unpinAgent(project.id, a.id);
      }}
      title="Pinned — won't auto-rename or reorder. Click to unpin."
      style={{ display: "inline-flex", flex: "0 0 auto", cursor: "pointer", lineHeight: 1, color: C.muted }}
    >
      <TbPinFilled size={11} />
    </span>
  ) : null;

  // The card's TOP STRIP: glyph/× + timer + name (or rename input) + the progress bar. It's the
  // SAME element collapsed (in the column) and expanded (the unified hover card's top strip, which
  // spans the column into the terminal area) — `expanded` only swaps the glyph for the × close,
  // reveals the full title + description, and widens the progress bar's status label. The detail
  // (Location/Status/Progress + per-worker blocks) is NOT here — it lives in CardDetail so the card
  // can be L-shaped (strip full width, detail dropping only on the terminal side). `ownsInput`
  // renders the rename <input>; only the collapsed column row ever owns it (the card is suppressed
  // during a rename), so there is always exactly one input.
  const CardHeader = ({ expanded, ownsInput }: { expanded: boolean; ownsInput: boolean }) => (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        {/* Leading glyph slot — a FIXED-height box so the glyph (and the title beside it) sit at the
            same vertical spot collapsed or expanded; the card only grows downward on hover. The
            glyph IS the status indicator (its color = the agent's status) and on hover it morphs
            into the × close control in this same slot, so nothing shifts. */}
        <div
          style={{
            flex: "0 0 auto",
            width: glyphWidth,
            height: GLYPH_SLOT_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {expanded ? (
            <CloseAgentButton onClose={onClose} width={glyphWidth} />
          ) : (
            <span
              title={`${a.kind} — ${AGENT_STATUS[st].label}`}
              style={{
                fontSize: a.kind === "build" ? 28.8 : a.kind === "think" ? 19.5 : 12,
                color: statusColor,
                // line-height 0 lets the enlarged ⚒ overflow its line box (staying centered in the
                // slot) without driving the row's height.
                lineHeight: 0,
              }}
            >
              {kindGlyph}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {ownsInput ? (
            <input
              autoFocus
              defaultValue={a.name}
              onBlur={(e) => {
                // Escape requested a cancel → consume the flag and discard without committing.
                if (cancelNextBlur.current) {
                  cancelNextBlur.current = false;
                  setEditing(null);
                  return;
                }
                // Only commit a real change. A no-op blur (double-click to edit, then click away
                // without typing) must NOT pin the name or wipe the auto-name.
                const next = e.target.value;
                if (next.trim() && next !== a.name) renameAgent(project.id, a.id, next, orderedIndex);
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  // Mark cancel BEFORE blurring so the resulting onBlur discards the edit.
                  cancelNextBlur.current = true;
                  (e.target as HTMLInputElement).blur();
                }
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                background: C.deepForest,
                color: C.cream,
                border: `1px solid ${C.teal}`,
                borderRadius: 4,
                padding: "2px 6px",
                fontSize: 13,
                outline: "none",
                minWidth: 0,
                boxSizing: "border-box",
              }}
            />
          ) : expanded ? (
            // Expanded: the SAME leading "elapsed since last prompt" timer as collapsed (kept
            // visible on hover, not dropped), then the bold title + ": " + the regular-weight
            // description, wrapping. The timer and the title's first line are both GLYPH_SLOT_H
            // tall (top-aligned) so they stay level with the glyph as the card grows down to fit
            // the description. gap:8 matches the collapsed row's timer↔name spacing.
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
              {lastTouchAt != null && (
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={statusColor} />
              )}
              <div
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditing(a.id);
                }}
                style={{ flex: 1, minWidth: 0, lineHeight: `${GLYPH_SLOT_H}px` }}
              >
                <span
                  style={{
                    color: statusColor,
                    fontSize: 13,
                    fontWeight: isActive ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
                  }}
                >
                  {fullTitle}
                </span>
                {description && (
                  <span style={{ color: statusColor, fontSize: 13, fontWeight: FONT_WEIGHT.regular }}>
                    {`:  ${description}`}
                  </span>
                )}
                {pinChip}
              </div>
            </div>
          ) : (
            // Collapsed: the live "elapsed since last prompt" timer (once there's a prompt to time
            // from), then the bold title truncated with an ellipsis (the hover card reveals the full
            // title + description). The timer leads the row — rather than sitting outside this name
            // column — so the thin progress line below spans under the timer too, not just the name.
            // gap:8 matches the glyph↔content spacing; the name+pin sub-row keeps its tighter gap:4.
            // Fixed to the glyph-slot height so the title line aligns with the glyph.
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, height: GLYPH_SLOT_H }}>
              {lastTouchAt != null && (
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={statusColor} />
              )}
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                <FittedAgentName
                  title={autoTitle}
                  name={a.name}
                  color={statusColor}
                  active={isActive}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(a.id);
                  }}
                />
                {pinChip}
              </div>
            </div>
          )}
          {/* The thin progress line under the title. Collapsed it's just the line (no text);
              expanded (on hover) it grows a status label to the RIGHT of the bar describing the
              current stage — the same bar+readout in both states, so the hover card keeps the
              visual progress bar, not only the worded "Progress" detail line below. */}
          {trackerStage && (
            <div style={{ marginTop: 1 }}>
              <WorkflowLine stage={trackerStage} expanded={expanded} shipped={shipped} />
            </div>
          )}
          {/* Collapsed: one bare indented progress line per worker, directly under the
              orchestrator's own line. No name / timer / "committed" text — each line's fill +
              color alone says how far that worker has gotten. Indented an extra 16px past the
              orchestrator's line so the head-vs-worker hierarchy reads at a glance. */}
          {!expanded && workers.some((w) => w.stage) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 3, marginLeft: 16 }}>
              {workers.map((w) =>
                w.stage ? (
                  <WorkflowLine key={w.id} stage={w.stage} expanded={false} shipped={w.shipped} />
                ) : null,
              )}
              {beadHover && (
                <DetailLine label="Bead">
                  <span style={{ color: C.muted, fontSize: 11 }}>{beadHover}</span>
                </DetailLine>
              )}
              {epicHover && (
                <DetailLine label="Epic">
                  <span style={{ color: C.muted, fontSize: 11 }}>{epicHover}</span>
                </DetailLine>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );

  // The card's DETAIL region — this row's Location / Status / Progress, then one stacked block per
  // inline worker. Rendered ONLY in the unified hover card, offset to the terminal side so it drops
  // below the strip without covering the column rows beneath it (the L-shape). Collapsed, none of
  // this shows; the column row keeps just the bare per-worker progress lines (in CardHeader above).
  const CardDetail = () => (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <AgentDetailLines
        worktreePath={a.worktreePath}
        rootPath={project.rootPath}
        bs={bs}
        baseBranch={a.baseBranch}
        isWorker={a.kind === "worker"}
        busy={busy}
        shipped={shipped}
        progressPct={progressPct}
        workerCount={workerCount}
        onLand={onLand}
        onRefresh={handleRefresh}
      />
      {/* One stacked detail block per worker — as if every worker had been expanded onto this single
          orchestrator card. Each shows the worker's own title/description, its OWN progress bar (with
          the stage status label, just like the orchestrator's), then its Location / Status / Progress.
          Indented 16px so they read as nested. */}
      {workers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, marginLeft: 16 }}>
          {workers.map((w) => (
            <div key={w.id} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <div style={{ minWidth: 0, lineHeight: 1.3 }}>
                <span style={{ color: w.statusColor, fontSize: 12, fontWeight: FONT_WEIGHT.semibold }}>
                  {w.autoTitle || w.name}
                </span>
                {w.description && (
                  <span style={{ color: w.statusColor, fontSize: 12, fontWeight: FONT_WEIGHT.regular }}>
                    {`:  ${w.description}`}
                  </span>
                )}
              </div>
              {/* The worker's progress bar moves DOWN to here on hover (collapsed it's the bare
                  indented line under the orchestrator in the column). Expanded, so it carries the same
                  stage status label the orchestrator's bar gets. */}
              {w.stage && (
                <div style={{ marginTop: 2 }}>
                  <WorkflowLine stage={w.stage} expanded shipped={w.shipped} />
                </div>
              )}
              <AgentDetailLines
                worktreePath={w.worktreePath}
                rootPath={project.rootPath}
                bs={w.branchStatus}
                baseBranch={w.baseBranch}
                isWorker
                busy={w.status === "working"}
                shipped={w.shipped}
                progressPct={w.stage ? Math.round(stageFraction(w.stage) * 100) : null}
                workerCount={0}
                onLand={w.onLand}
                onRefresh={(e) => refreshBranch(w.id, w.baseBranch ?? "", e)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // The unified hover card is ONE L-shaped card pinned to the row's OWN position (not a separate
  // pop-out to the side). Its top strip starts at the row's left edge and WIDENS right into the
  // terminal area (so the single progress bar just gets wider); the detail drops down only on the
  // terminal side. The in-flow column row is hidden while it's open (the card stands in for it), so
  // the name + progress bar never duplicate.
  //  • cardLeft/cardTop — pinned to the captured rect so the strip sits exactly over the row.
  //  • colW             — the column row's width; the detail is offset by this so it lands past the
  //                       sidebar's right edge (terminal area) and never covers the rows below.
  //  • ext              — terminal-side room added to the right (≥220, capped to the viewport).
  //  • maxH             — height cap for the detail so a tall card (many workers) scrolls.
  const cardLeft = rect ? rect.left : 0;
  const colW = rect ? rect.width : 0;
  const ext = rect ? Math.max(220, Math.min(360, window.innerWidth - (rect.left + colW) - 16)) : 320;
  const totalW = colW + ext;
  // Anchor the card at the row's top — but if the row sits so low that the remaining room can't hold
  // a reasonable card, shift the anchor UP so there's always room for the strip (which doesn't shrink)
  // plus some detail (standard popover viewport-flip). For the common case cardTop === rect.top, so
  // the strip sits exactly over the row; only a bottom-of-viewport row nudges upward.
  const MIN_CARD_H = 180;
  const cardTop = rect ? Math.max(8, Math.min(rect.top, window.innerHeight - 16 - MIN_CARD_H)) : 0;
  const maxH = rect ? window.innerHeight - cardTop - 16 : undefined;
  // Three shading states read at a glance: the row you're IN is the starker ROW_ACTIVE_BUBBLE; a row
  // you're hovering (its unified card) is CHAT_USER_BUBBLE; idle rows are transparent.
  const cardBg = isActive ? ROW_ACTIVE_BUBBLE : CHAT_USER_BUBBLE;
  // Show the slide-out only while hovering AND not renaming. Suppressing it during a rename means
  // the in-flow row is the SOLE owner of the rename <input> — the field never swaps mount points on
  // a hover change, so a trailing unmount-blur can't silently commit a half-typed name.
  const showOverlay = hover && !editing;

  // The drag handle for reorder (top-level rows only; workers keep insertion order). Grab and drop
  // on another row to pin this agent at that row's position (manual-agent-reorder-pin). Suppressed
  // while renaming so the <input> behaves normally. These props go on the in-flow row AND on BOTH
  // halves of the unified card (strip + detail): on hover the row is visibility:hidden and the card
  // stands in over it, so the card must carry the drag grab — and because the card can shift up for a
  // bottom-of-viewport row, the cursor may sit over the detail (not the strip) when it opens, so the
  // whole card is grabbable rather than the strip alone.
  const dragProps =
    orderedIndex != null && !editing
      ? {
          draggable: true,
          // Signal draggability to assistive tech without an aria-label (which would override the
          // row's name). aria-roledescription supplements the announced content instead.
          "aria-roledescription": "draggable agent card",
          onDragStart: (e: ReactDragEvent) => {
            e.stopPropagation();
            onDragStartAgent(a.id);
          },
          onDragEnd: onDragEndAgent,
        }
      : {};

  return (
    <>
      <div
        ref={rowRef}
        {...dragProps}
        onClick={onSelect}
        onMouseEnter={show}
        onMouseLeave={hide}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "8px 10px",
          marginLeft: depth * 16,
          borderRadius: 8,
          cursor: "pointer",
          // The whole card is a drag handle for reorderable rows — suppress text selection so a
          // drag grabs the card instead of highlighting the name underneath the cursor. Gated on
          // !editing (like dragProps) so the rename <input> keeps normal text selection.
          userSelect: orderedIndex != null && !editing ? "none" : undefined,
          // Active row is the starker ROW_ACTIVE_BUBBLE (one of three shading states); idle is
          // transparent. The hover state's CHAT_USER_BUBBLE lives on the unified card, not here.
          background: isActive ? ROW_ACTIVE_BUBBLE : "transparent",
          marginBottom: 2,
          // Hidden while the unified card is open: the card stands in for the row (anchored at the
          // same spot) and widens into the terminal area, so the name + progress bar render exactly
          // once. visibility:hidden keeps the row's layout slot, so the rows below never jump.
          visibility: showOverlay ? "hidden" : "visible",
        }}
      >
        {CardHeader({ expanded: false, ownsInput: editing })}
        {/* Drop target — only while a drag is in flight and only on top-level rows. Dropping here
            pins the dragged agent at THIS row's index (manual-agent-reorder-pin). */}
        {orderedIndex != null && dragActive && (
          <div
            data-testid="agent-drop-target"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onDropAgent(orderedIndex, a.id);
            }}
            style={{ position: "absolute", inset: 0, zIndex: 2 }}
          />
        )}
      </div>
      {showOverlay &&
        rect &&
        createPortal(
          // Outer wrapper is pure positioning and NON-interactive (pointerEvents:none): its
          // transparent lower-left quadrant — under the column, beside the dropped-down detail —
          // passes hover/clicks straight through to the rows beneath, which is what keeps them live.
          // The two children below re-enable pointer events and carry the hover/click handlers. One
          // drop-shadow on the wrapper traces the L outline (the lower-left is transparent). It's a
          // flex column capped to maxH (the room from the row's top to the viewport bottom): the
          // strip takes its natural height and the detail flex-shrinks + scrolls within the rest, so
          // a tall card can't run past the viewport (the cap is on the whole card, not just detail).
          <div
            data-testid="agent-hover-card"
            style={{
              position: "fixed",
              left: cardLeft,
              top: cardTop,
              width: totalW,
              maxHeight: maxH,
              zIndex: 50,
              pointerEvents: "none",
              display: "flex",
              flexDirection: "column",
              filter: "drop-shadow(0 8px 16px rgba(0,0,0,0.45))",
              animation: "-slide 140ms ease-out",
            }}
          >
            {/* TOP STRIP — full width, spanning the column into the terminal area; the single progress
                bar widens with it. Rounded except the bottom-RIGHT inner corner, where the detail
                steps down to form the L. A drag grab on hover (see dragProps) — BOTH the strip and
                the detail carry it, so the WHOLE card is grabbable: the cursor lands over the detail
                when the card is shifted up for a bottom-of-viewport row, so the strip alone wouldn't
                be reachable to start a drag there. */}
            <div
              {...dragProps}
              onClick={onSelect}
              onMouseEnter={show}
              onMouseLeave={hide}
              style={{
                pointerEvents: "auto",
                boxSizing: "border-box",
                flex: "0 0 auto",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                padding: "8px 10px",
                cursor: "pointer",
                userSelect: orderedIndex != null && !editing ? "none" : undefined,
                background: cardBg,
                border: `1px solid ${C.forest}`,
                borderRadius: "8px 8px 0 8px",
              }}
            >
              {CardHeader({ expanded: true, ownsInput: false })}
            </div>
            {/* DETAIL — offset right by the column width so it drops ONLY on the terminal side (column
                rows below stay visible). marginTop:-1 laps the strip's bottom border so the two read
                as one card; the strip's bottom border then shows only in the column-width "step". Also
                carries dragProps (see the strip) so the whole card is a drag handle. */}
            <div
              {...dragProps}
              onClick={onSelect}
              onMouseEnter={show}
              onMouseLeave={hide}
              style={{
                pointerEvents: "auto",
                boxSizing: "border-box",
                marginLeft: colW,
                marginTop: -1,
                width: ext,
                userSelect: orderedIndex != null && !editing ? "none" : undefined,
                // flex-shrink + scroll within the wrapper's maxH budget (minus the strip), so the
                // detail's scroll boundary lands inside the viewport even for a tall card.
                flex: "1 1 auto",
                minHeight: 0,
                overflowY: "auto",
                padding: "2px 10px 8px",
                cursor: "pointer",
                background: cardBg,
                borderLeft: `1px solid ${C.forest}`,
                borderRight: `1px solid ${C.forest}`,
                borderBottom: `1px solid ${C.forest}`,
                borderRadius: "0 0 8px 8px",
              }}
            >
              {CardDetail()}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** The Location / Status / Progress detail block for ONE agent in the hover card. Shared by the
 *  orchestrator's own detail and each of its inline workers, so the behind/ahead pill logic lives
 *  in exactly one place. `onRefresh` rebases the branch onto its base (red "behind" pill, gated on
 *  `busy`); `onLand` merges it forward (green "ahead" pill). `isWorker` only swaps the green pill's
 *  wording (merge into the worker's orchestrator vs. into the base). */
function AgentDetailLines({
  worktreePath,
  rootPath,
  bs,
  baseBranch,
  isWorker,
  busy,
  shipped,
  progressPct,
  workerCount,
  onLand,
  onRefresh,
}: {
  worktreePath: string | null;
  rootPath: string;
  bs?: BranchStatus;
  baseBranch: string | null;
  isWorker: boolean;
  busy: boolean;
  shipped?: boolean;
  progressPct: number | null;
  workerCount: number;
  onLand: () => void;
  onRefresh: (e: React.MouseEvent) => void;
}) {
  const behind = bs?.behind ?? 0;
  const ahead = bs?.ahead ?? 0;
  // The pill: RED "-N" when the branch is behind its base (click rebases it — catch YOU up), else
  // GREEN "+N" when it's ahead (click merges it — catch the base up to you). Behind wins when both.
  const showPill = !!bs && (behind > 0 || ahead > 0);
  const pillBehind = behind > 0;
  // Behind is INFORMATIONAL, not an alarm: a branch trailing its base is normal (the base moves) and
  // says nothing about whether the work shipped — so it reads as a calm, muted OUTLINE pill (no red,
  // no fill). Red is reserved for genuine errors. Ahead stays the green actionable "land" pill with
  // the faint `${C.success}22` alpha tint — which is why the green path uses the BRAND-literal hex
  // C.success (a CSS var can't take a hex-alpha suffix); the muted path is a var() and uses no tint.
  const pillInk = pillBehind ? C.muted : C.successInk;
  const baseLabel = baseBranch ?? "main";
  // Shared pill geometry — squared off to roughly match the Land/old action pills (borderRadius 5),
  // not a fully-round chip. The behind/ahead variants layer color + action on top.
  const pillBase: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
    fontFamily: FONT.ui,
    padding: "2px 7px",
    borderRadius: 5,
    flex: "0 0 auto",
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
      <DetailLine label="Location">
        <PathReveal path={worktreePath ?? rootPath} />
      </DetailLine>
      <DetailLine label="Status">
        {showPill ? (
          pillBehind ? (
            // BEHIND (red): click rebases this branch onto its base — catches YOU up. Gated on the
            // agent not actively writing (a rebase under a live PTY would race).
            <button
              disabled={busy}
              onClick={onRefresh}
              style={{
                ...pillBase,
                color: pillInk,
                background: "transparent",
                border: `1px solid ${pillInk}`,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy
                ? `Update available · ${behind} behind ${baseLabel} — pause the agent to catch up`
                : `Update available · ${behind} behind ${baseLabel} — click to catch up`}
            </button>
          ) : (
            // AHEAD (green): click merges this branch forward — catches the base up to you.
            <button
              onClick={(e) => {
                e.stopPropagation();
                onLand();
              }}
              style={{
                ...pillBase,
                color: pillInk,
                background: `${C.success}22`,
                border: `1px solid ${pillInk}`,
                cursor: "pointer",
              }}
            >
              {isWorker
                ? `${ahead} ahead. Click to merge into this worker's orchestrator`
                : `${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${baseLabel}. Click to merge`}
            </button>
          )
        ) : (
          <span style={{ color: C.muted, fontSize: 11 }}>Up to date with {baseLabel}</span>
        )}
      </DetailLine>
      {progressPct != null && (
        <DetailLine label="Progress">
          <span style={{ color: C.muted, fontSize: 11 }}>
            {workerCount > 0 ? `${workerCount} worker${workerCount === 1 ? "" : "s"}. ` : ""}
            {progressPct}% complete{workerCount > 0 ? " overall" : ""}.
            {/* Carry the sticky "landed" signal into the expanded card too, so the ✓ doesn't
                vanish on hover — it persists even after the bar resets for a new cycle. */}
            {shipped && (
              <span style={{ color: C.successInk, fontWeight: 600 }}> ✓ Landed</span>
            )}
          </span>
        </DetailLine>
      )}
    </div>
  );
}

/** One "Label: value" line in the hover card (Location / Status / Progress). The label is a muted
 *  fixed-width-content prefix; the value flexes and is allowed to shrink (minWidth:0) so a long
 *  path or status button can ellipsize/wrap instead of forcing the card wider. */
function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ flex: "0 0 auto", color: C.muted, fontSize: 11, fontWeight: FONT_WEIGHT.semibold }}>
        {label}:
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center" }}>{children}</span>
    </div>
  );
}

/** The agent's working-directory path in the expanded row. Click to reveal the folder in Finder
 *  (Tauri opener `revealItemInDir`); underlines on hover so it reads as clickable. */
function PathReveal({ path }: { path: string }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onClick={(e) => {
        e.stopPropagation(); // don't also select the agent
        revealItemInDir(path).catch((err) => console.error("reveal in Finder failed:", err));
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Click to reveal this folder in Finder"
      style={{
        color: hover ? C.accentInk : C.muted,
        fontSize: 11,
        fontFamily: FONT.mono,
        whiteSpace: "nowrap",
        cursor: "pointer",
        textDecoration: hover ? "underline" : "none",
        // Ellipsize a long path inside the DetailLine instead of forcing the card wider.
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
        display: "block",
      }}
    >
      {path}
    </span>
  );
}

/** Close (×) control that stands in for the leading kind glyph while a row is hovered. It takes
 *  the glyph's slot width so the name doesn't shift on hover, with a thin pill that fades in to
 *  make the hit target feel intentional. */
function CloseAgentButton({ onClose, width }: { onClose: () => void; width: number }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Close agent"
      aria-label="Close agent"
      style={{
        color: hover ? C.accentInk : C.muted,
        fontSize: 18,
        lineHeight: 1,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        // Width matches the glyph slot so the name stays put; the pill stays a comfortable 22 tall.
        width,
        height: 22,
        padding: 0,
        cursor: "pointer",
        borderRadius: 999,
        border: `1px solid ${hover ? C.muted : "transparent"}`,
        background: hover ? C.deepForest : "transparent",
        transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
      }}
    >
      ×
    </button>
  );
}

/** The pinned, always-present Sparkle self-improvement agent row. Distinct from project agents:
 *  a ✨ glyph, a subtitle, no close button — it works on Sparkle itself, not the user's project. */
function SparkleAgentRow({
  active,
  status,
  onSelect,
}: {
  active: boolean;
  status: AgentTabStatus;
  onSelect: () => void;
}) {
  const color = statusInk(AGENT_STATUS[status].color);
  return (
    <div
      onClick={onSelect}
      title="Sparkle Improvement Agent — reviews your usage to make Sparkle better"
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "0 8px 6px",
        padding: "8px 10px",
        borderRadius: 8,
        cursor: "pointer",
        // Match the agent rows' selected treatment: a clean lighter lift, no accent bar.
        background: active ? CHAT_USER_BUBBLE : "transparent",
        borderTop: `1px solid ${C.forest}`,
      }}
    >
      <StatusDot status={status} />
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>
        ✨
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            color,
            fontSize: 13,
            fontWeight: active ? FONT_WEIGHT.semibold : FONT_WEIGHT.medium,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {SPARKLE_AGENT_NAME}
        </span>
        <span
          style={{
            color: C.muted,
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Improve Sparkle
        </span>
      </div>
    </div>
  );
}
