import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { TbPinFilled, TbBulb } from "react-icons/tb";
import { C, AGENT_STATUS, FONT, FONT_WEIGHT, CHAT_USER_BUBBLE, ON_BRAND_FILL, ON_BRAND_FILL_DARK } from "../theme/colors";
import type { Project, AgentTab, AgentTabStatus } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAiFeature } from "../services/aiGate";
import { removeAgentWorkspace } from "../services/worktree";
import { refreshAgentBranch, landAgentBranch } from "../services/branchStatus";
import type { BranchStatus } from "../services/branchStatus";
import { refreshAgentTitle } from "../services/sessionTitle";
import { SPARKLE_AGENT_ID, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";
import { orderAgents } from "../engine/agentOrdering";
import { StatusDot } from "./StatusDot";
import { StatusBar } from "./StatusBar";
import { LogoWaveform } from "./LogoWaveform";
import { FittedAgentName } from "./FittedAgentName";
import { WorkflowLine } from "./WorkflowLine";
import { HistorySearch } from "./HistorySearch";
import { resolveStage, rollupStages, stageMeta } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import { CloseWorkerPrompt } from "./CloseWorkerPrompt";

/**
 * Left column: the current project's agents as a vertical list (spec layout, revised).
 * Each row is a status dot + the agent name rendered in that status's color; click a row
 * to open the agent, double-click the agent name to rename it, ×
 * to close. "+ Agent" adds one.
 */
// Shared style for the two create buttons (Think / Build): a solid gradient fill with
// NO border/stroke, so the button reads as a button without an edge of a different shade on
// its sides. The gradient runs left→right to reproduce the Sparkle logo's blue→cyan fade:
// Think runs blue→mid, Build picks up mid→cyan. `fillText` is the per-button ink chosen
// for contrast on that fill.
function createBtnStyle(from: string, to: string, fillText: string): React.CSSProperties {
  return {
    flex: 1,
    padding: "9px 10px",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 13,
    whiteSpace: "nowrap",
    background: `linear-gradient(90deg, ${from}, ${to})`,
    color: fillText,
    // Flex-center the (enlarged, line-height-0) glyph against the label so the
    // icon sits on the label's vertical center rather than its text baseline.
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  };
}

export function AgentSidebar({ project }: { project: Project | null }) {
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const addAgent = useProjectStore((s) => s.addAgent);
  const removeAgent = useProjectStore((s) => s.removeAgent);
  const open = useRuntimeStore((s) => s.open);
  const close = useRuntimeStore((s) => s.close);
  const status = useRuntimeStore((s) => s.status);
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  const agentOrdering = useUiStore((s) => s.agentOrdering);
  const collapsedOrchestrators = useUiStore((s) => s.collapsedOrchestrators);
  const toggleOrchestratorCollapsed = useUiStore((s) => s.toggleOrchestratorCollapsed);
  // The workflow stage an agent's own git state + any known override resolves to.
  const stageOf = (id: string): WorkflowStageId =>
    resolveStage(branchStatus[id], workflowStage[id]);

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
    // One think agent per project by convention — reuse it if it already exists.
    const existing = project.agents.find((a) => a.kind === "think");
    const id = existing ? existing.id : addAgent(project.id, { kind: "think" });
    selectAgent(project.id, id);
    open(id);
  };
  const onAddBuild = () => {
    if (!project) return;
    setActiveSpecial(null);
    const id = addAgent(project.id, { kind: "build" });
    selectAgent(project.id, id);
    open(id);
  };
  const onSelectSparkle = () => {
    setActiveSpecial("sparkle");
    open(SPARKLE_AGENT_ID);
  };
  // Land an agent's work into its integration target: a worker → its orchestrator's branch; a build
  // agent → the project's default branch. A local --no-ff merge (see Rust land_agent_branch); the
  // tracker then advances to On Main on the next poll. Best-effort feedback via console for now
  // (dirty/conflict/etc.) — a full toast is a follow-up, matching the refresh button's pattern.
  const onLand = async (a: AgentTab) => {
    if (!project) return;
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
    } else {
      console.warn("land blocked:", r.reason, r.files ?? "");
    }
  };
  const onClose = (id: string) => {
    if (!project) return;
    // Closing a build agent cascades to its workers in the store; clean up each one's worktree.
    const childIds = project.agents.filter((a) => a.parentId === id).map((a) => a.id);
    for (const cid of [id, ...childIds]) {
      close(cid);
      void removeAgentWorkspace(project.rootPath, project.id, cid).catch(() => {});
    }
    removeAgent(project.id, id);
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
      <div style={{ padding: "14px 14px 6px", position: "relative", zIndex: 1 }}>
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
      </div>
      <LogoWaveform />
      <div
        style={{
          padding: "6px 14px",
          color: C.muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 1,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        Agents
      </div>

      {project && (
        <div style={{ display: "flex", gap: 8, margin: "0 10px 8px" }}>
          {/* AI feature-gated (the "Enable AI Thinking" toggle): off → the button disappears
              (Build stays). main renamed Brainstorm → Think; the gate flag stays aiBrainstorm. */}
          {aiBrainstorm && (
            <button
              onClick={onAddThink}
              title="Chat with Chief over this project's knowledge"
              style={createBtnStyle(C.accent, C.accentMid, ON_BRAND_FILL_DARK)} // cyan (the "S" color) leads; black icon+text
            >
              <TbBulb size={18} style={{ flexShrink: 0 }} />
              <span>Think</span>
            </button>
          )}
          <button
            onClick={onAddBuild}
            title="A master orchestrator that spawns worker agents to get work done"
            style={createBtnStyle(C.accentMid, C.teal, ON_BRAND_FILL)} // blue leads (matches logo's right side); white icon+text
          >
            <span style={{ fontSize: 26, lineHeight: 0, transform: "translateY(-3.5px)" }}>⚒</span>
            <span>Build</span>
          </button>
        </div>
      )}

      {/* Full-text search across all projects' prompts & responses. Lives directly under the
          Brainstorm/Build buttons (design §Search UX); only shown with a project open. */}
      {project && <HistorySearch />}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        {(() => {
          if (!project) return null;
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
          const topLevel = project.agents.filter(isTopLevel);
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
            const collapsed =
              top.kind === "build" && workers.length > 0 && (collapsedOrchestrators[top.id] ?? true);
            const renderRow = (
              a: (typeof project.agents)[number],
              trackerStage: WorkflowStageId | null,
              rowIndex?: number,
            ) => {
          const st = status[a.id] ?? "stopped";
          // Idle/inactive agents (idle, blocked, errored, done, stopped all share the brand
          // GRAY) use a themed gray that's much darker in light mode for readability; active
          // green/red statuses keep their brand color. Compare to a known-gray status ("done")
          // instead of enumerating, so this tracks the AGENT_STATUS taxonomy if it changes.
          const color =
            AGENT_STATUS[st].color === AGENT_STATUS.done.color ? C.agentIdle : AGENT_STATUS[st].color;
          const isActive = !activeSpecial && project.selectedAgentId === a.id;
          const bs = branchStatus[a.id];
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
              labelPrefix={a.kind === "build" && workers.length > 0 ? "Overall: " : undefined}
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
            const dom = rollup ? stageMeta(rollup.dominant) : null;
            return (
              <div key={top.id}>
                {renderRow(top, headStage, orderedIndex)}
                {/* Collapsible worker roll-up. Workers start collapsed: a compact "N workers ·
                    mostly X" bar the user clicks to expand into each worker's own tracker. */}
                {top.kind === "build" && workers.length > 0 && (
                  <div
                    onClick={() => toggleOrchestratorCollapsed(top.id)}
                    title={collapsed ? "Show worker agents" : "Hide worker agents"}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginLeft: 16,
                      padding: "2px 10px 4px",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ width: 12, textAlign: "center", color: C.muted, fontSize: 10 }}>
                      {collapsed ? "▸" : "▾"}
                    </span>
                    <span style={{ color: C.muted, fontSize: 11, flex: "0 0 auto" }}>
                      {workers.length} worker{workers.length === 1 ? "" : "s"}
                    </span>
                    {collapsed && dom && (
                      <span
                        style={{
                          color: dom.color,
                          fontSize: 10,
                          fontWeight: 600,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        · mostly {dom.label}
                      </span>
                    )}
                  </div>
                )}
                {/* Expanded: each worker's own row + tracker. Workers are spawned by the
                    orchestrator agent (via the MCP bridge), not by hand — so there's no manual
                    "+ worker" affordance here. */}
                {top.kind === "build" &&
                  !collapsed &&
                  workers.map((w) => renderRow(w, stageOf(w.id)))}
              </div>
            );
          });
        })()}
        {project && project.agents.length === 0 && (
          <div style={{ color: C.muted, fontSize: 12, padding: 10, lineHeight: 1.5 }}>
            <div>No agents are running.</div>
            {/* Don't point at the Think button when the AI feature is gated off. */}
            {aiBrainstorm && (
              <div style={{ marginTop: 8 }}>
                • Start a{" "}
                <strong>
                  <TbBulb size={12} style={{ verticalAlign: "-2px" }} /> Think
                </strong>{" "}
                agent to define what you want to build
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              • Start a <strong>⚒ Build</strong> agent to orchestrate workers and get started
              building
            </div>
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

/**
 * One agent row. Collapsed (default) it shows: the kind glyph, the status dot, the width-fitted
 * name, a behind/ahead pill, and a thin progress line across the bottom. On hover the row "slides
 * out" to the right OVER the terminal (a fixed-position overlay, not a modal), revealing the full
 * name, the working-directory path, and the progress line's status label. The build glyph sits left
 * of the dot, the dot left of the name (per spec).
 */
function AgentRow({
  project,
  a,
  depth,
  isActive,
  st,
  statusColor,
  bs,
  trackerStage,
  labelPrefix,
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
  labelPrefix?: string;
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
  const behind = bs?.behind ?? 0;
  const ahead = bs?.ahead ?? 0;
  // The pill: RED "-N" when the branch is behind main (click rebases it onto main — catch YOU up),
  // else GREEN "+N" when it's ahead (click merges it into main — catch MAIN up to you). Behind wins
  // when both: rebase first, and once caught up the pill flips to green to offer the land. None when
  // even with main.
  const showPill = !!bs && (behind > 0 || ahead > 0);
  const pillBehind = behind > 0;
  const pillColor = pillBehind ? C.sienna : C.success;
  const pillText = pillBehind ? `-${behind}` : `+${ahead}`;
  const baseLabel = a.baseBranch ?? "main";
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

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Re-read status at click time: the closed-over `busy` could be stale, and this gate is the
    // only thing stopping a rebase under a live agent.
    const liveBusy = useRuntimeStore.getState().status[a.id] === "working";
    const base = a.baseBranch ?? "";
    const r = await refreshAgentBranch(project.rootPath, project.id, a.id, base, liveBusy);
    if (r.ok) void pollBranchStatus(project.rootPath, project.id, a.id, base);
    else console.warn("refresh blocked:", r.reason, r.files ?? ""); // toast UI is a follow-up
  };

  const fullName = a.autoNameVariants?.long || a.name;

  // The row's inner content, shared by the in-flow (collapsed) and overlay (expanded) renders.
  // `expanded` reveals the path + status label and shows the full name; `ownsInput` renders the
  // rename <input> here. Only the in-flow row ever passes ownsInput=true (the overlay is suppressed
  // during a rename), so there is always exactly one input — see showOverlay below.
  const RowBody = ({ expanded, ownsInput }: { expanded: boolean; ownsInput: boolean }) => (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        {/* Drag grip — top-level rows only (workers keep insertion order). Dragging by the grip
            and dropping on a row pins this agent at that row (manual-agent-reorder-pin). Hidden
            until row hover so the rest stays clean. */}
        {!expanded && orderedIndex != null && (
          <span
            draggable
            role="button"
            aria-label="Drag to reorder agent"
            title="Drag to reorder"
            onDragStart={(e) => {
              e.stopPropagation();
              onDragStartAgent(a.id);
            }}
            onDragEnd={onDragEndAgent}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: "0 0 auto",
              cursor: "grab",
              color: C.muted,
              fontSize: 12,
              lineHeight: 1,
              opacity: hover ? 0.7 : 0,
              userSelect: "none",
            }}
          >
            ⠿
          </span>
        )}
        {/* The kind glyph IS the status indicator now (no separate dot): it takes the agent's
            status color — green (working), red (needs you), gray (idle/done). On hover (the
            expanded overlay) it morphs into the × close control, occupying the same slot so the
            name doesn't shift — there's no longer a separate close button in the right cluster. */}
        {expanded ? (
          <CloseAgentButton onClose={onClose} width={glyphWidth} />
        ) : (
          <span
            title={`${a.kind} — ${AGENT_STATUS[st].label}`}
            style={{
              fontSize: a.kind === "build" ? 28.8 : a.kind === "think" ? 19.5 : 12,
              color: statusColor,
              flex: "0 0 auto",
              width: glyphWidth,
              textAlign: "center",
              // line-height 0 lets the enlarged ⚒ overflow its line box (staying centered) so it
              // doesn't drive the row's height.
              lineHeight: 0,
            }}
          >
            {kindGlyph}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
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
                // without typing) must NOT pin the name or wipe the auto-name variants.
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
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
              {expanded ? (
                // Expanded: the FULL name, no ellipsis — the overlay grows to fit it.
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(a.id);
                  }}
                  title="Double-click to rename"
                  style={{
                    color: statusColor,
                    fontSize: 13,
                    fontWeight: isActive ? FONT_WEIGHT.medium : FONT_WEIGHT.regular,
                    whiteSpace: "nowrap",
                  }}
                >
                  {fullName}
                </span>
              ) : (
                // Collapsed: width-fitted name. Its own hover card is suppressed — the row's
                // slide-out reveals the full name instead of a separate floating tooltip.
                <FittedAgentName
                  variants={a.autoNameVariants}
                  name={a.name}
                  color={statusColor}
                  active={isActive}
                  suppressTooltip
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(a.id);
                  }}
                />
              )}
              {a.namePinned && (
                // Pinned by hand (drag or rename): name frozen AND row anchored. Click to release both.
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
              )}
            </div>
          )}
          {/* The working directory — only on hover (expanded), below the name. Click it to reveal
              the folder in Finder (underlines on hover to signal it's clickable). */}
          {expanded && (
            <PathReveal path={a.worktreePath ?? project.rootPath} />
          )}
        </div>
        {/* Right cluster: the behind/ahead pill (which also IS the catch-up / land action). The
            old separate ⬆ Land button is gone — the green pill lands; the red pill rebases. The
            close × no longer lives here either: on hover the leading kind glyph becomes it. */}
        {showPill &&
          (pillBehind ? (
            // BEHIND (red): click rebases this branch onto main — catches YOU up to main. Gated on
            // the agent not actively writing (a rebase under a live PTY would race).
            <button
              disabled={busy}
              onClick={handleRefresh}
              title={
                busy
                  ? `Pause the agent first — ${behind} behind ${baseLabel}`
                  : `${behind} behind ${baseLabel} — click to rebase onto ${baseLabel} (catch up)`
              }
              style={{
                ...pillBase,
                color: pillColor,
                background: `${pillColor}22`,
                border: `1px solid ${pillColor}`,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {pillText}
            </button>
          ) : (
            // AHEAD (green): click merges this branch into main — catches MAIN up to you (the old
            // Land action). A worker lands into its orchestrator; a build agent into the default.
            <button
              onClick={(e) => {
                e.stopPropagation();
                onLand();
              }}
              title={
                a.kind === "worker"
                  ? `${ahead} ahead — click to merge into this worker's orchestrator branch`
                  : `${ahead} ahead of ${baseLabel} — click to merge into ${baseLabel} (catch main up)`
              }
              style={{
                ...pillBase,
                color: pillColor,
                background: `${pillColor}22`,
                border: `1px solid ${pillColor}`,
                cursor: "pointer",
              }}
            >
              {pillText}
            </button>
          ))}
      </div>
      {/* Thin progress line across the bottom of the row — fills + warms cyan→blue as the work
          advances Uncommitted → Merged. The status label only appears when expanded. */}
      {trackerStage && <WorkflowLine stage={trackerStage} expanded={expanded} labelPrefix={labelPrefix} />}
    </>
  );

  const maxW = rect ? Math.max(220, window.innerWidth - rect.left - 12) : 480;
  // Show the slide-out only while hovering AND not renaming. Suppressing it during a rename means
  // the in-flow row is the SOLE owner of the rename <input> — the field never swaps mount points on
  // a hover change, so a trailing unmount-blur can't silently commit a half-typed name.
  const showOverlay = hover && !editing;

  return (
    <>
      <div
        ref={rowRef}
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
          background: isActive ? CHAT_USER_BUBBLE : "transparent",
          marginBottom: 2,
          // Hide the collapsed content while the overlay stands in for it, so the name underneath
          // doesn't "show through" the slide-out at the row's left edge. While renaming the overlay
          // is suppressed, so the in-flow row (and its input) stays visible.
          visibility: showOverlay ? "hidden" : "visible",
        }}
      >
        {RowBody({ expanded: false, ownsInput: editing })}
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
          <div
            onClick={onSelect}
            onMouseEnter={show}
            onMouseLeave={hide}
            style={{
              position: "fixed",
              left: rect.left,
              top: rect.top,
              zIndex: 50,
              minWidth: rect.width,
              maxWidth: maxW,
              width: "max-content",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: "8px 10px",
              borderRadius: 8,
              cursor: "pointer",
              background: isActive ? CHAT_USER_BUBBLE : C.deepForest,
              border: `1px solid ${C.forest}`,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              animation: "-slide 140ms ease-out",
            }}
          >
            {RowBody({ expanded: true, ownsInput: false })}
          </div>,
          document.body,
        )}
    </>
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
        marginTop: 1,
        cursor: "pointer",
        textDecoration: hover ? "underline" : "none",
        width: "fit-content",
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
  const color = AGENT_STATUS[status].color;
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
