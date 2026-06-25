import { useState, useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TbPinFilled } from "react-icons/tb";
import { C, AGENT_STATUS, FONT_WEIGHT, CHAT_USER_BUBBLE, ON_BRAND_FILL, ON_BRAND_FILL_DARK } from "../theme/colors";
import type { Project, AgentTab, AgentTabStatus } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { removeAgentWorkspace } from "../services/worktree";
import { refreshAgentBranch, landAgentBranch } from "../services/branchStatus";
import { SPARKLE_AGENT_ID, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";
import { stalenessTier, growNudge } from "../engine/nudges";
import { spawnWorker } from "../services/workerSpawn";
import { sortAgentsByAttention } from "../engine/agentOrdering";
import { StatusDot } from "./StatusDot";
import { StatusBar } from "./StatusBar";
import { Tooltip } from "./Tooltip";
import { LogoWaveform } from "./LogoWaveform";
import { FittedAgentName } from "./FittedAgentName";
import { WorkflowTracker } from "./WorkflowTracker";
import { resolveStage, rollupStages, stageMeta, stageIndex } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";

/**
 * Left column: the current project's agents as a vertical list (spec layout, revised).
 * Each row is a status dot + the agent name rendered in that status's color; click a row
 * to open the agent, double-click the agent name to rename it, ×
 * to close. "+ Agent" adds one.
 */
// Shared style for the two create buttons (Brainstorm / Build): a solid gradient fill with
// NO border/stroke, so the button reads as a button without an edge of a different shade on
// its sides. The gradient runs left→right to reproduce the Sparkle logo's blue→cyan fade:
// Brainstorm runs blue→mid, Build picks up mid→cyan. `fillText` is the per-button ink chosen
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
  const renameAgent = useProjectStore((s) => s.renameAgent);
  const setNamePinned = useProjectStore((s) => s.setNamePinned);
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
          a.kind !== "brainstorm" && a.kind !== "shell"; // those have no git workflow
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
  const onAddBrainstorm = () => {
    if (!project) return;
    setActiveSpecial(null); // creating an agent leaves the special (Sparkle) view
    // One brainstorm agent per project by convention — reuse it if it already exists.
    const existing = project.agents.find((a) => a.kind === "brainstorm");
    const id = existing ? existing.id : addAgent(project.id, { kind: "brainstorm" });
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
  // Temporary manual trigger for spawning workers (Plan 2 will replace this with autonomous
  // orchestration via the MCP bridge). Prompts the user for a task description, cuts the
  // worker worktree from the parent build agent's branch, and opens the new worker tab.
  const onAddWorker = (parentId: string) => {
    if (!project) return;
    const task = window.prompt("Worker task?")?.trim();
    if (!task) return;
    setActiveSpecial(null);
    spawnWorker({ projectId: project.id, parentAgentId: parentId, task })
      .then((id) => {
        selectAgent(project.id, id);
        open(id);
      })
      .catch((e) => console.error("spawnWorker failed", e));
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
      <div style={{ padding: "14px 14px 6px" }}>
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
          <button
            onClick={onAddBrainstorm}
            title="Chat with Chief over this project's knowledge"
            style={createBtnStyle(C.accent, C.accentMid, ON_BRAND_FILL_DARK)} // cyan (the "S" color) leads; black icon+text
          >
            {/* translateY corrects the glyph's font-baseline offset so its ink centers on the
                label (measured: ✦ otherwise sits ~2px low, ⚒ ~6px low against these fonts). */}
            <span style={{ fontSize: 19.5, lineHeight: 0, transform: "translateY(-0.5px)" }}>✦</span>
            <span>Brainstorm</span>
          </button>
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
              ? sortAgentsByAttention(topLevel, status)
              : topLevel;
          return ordered.map((top) => {
            const workers =
              top.kind === "build"
                ? project.agents.filter((w) => w.parentId === top.id)
                : [];
            // The orchestrator's chevron rolls up its workers (overall = least-advanced worker);
            // with no workers it just shows its own git stage. A worker/brainstorm/shell row shows
            // its own. (Brainstorm has no worktree, so it resolves to the harmless start stage and
            // we simply don't render a tracker for it — see renderRow.)
            const workerStages = workers.map((w) => stageOf(w.id));
            const rollup = rollupStages(workerStages);
            const collapsed =
              top.kind === "build" && workers.length > 0 && (collapsedOrchestrators[top.id] ?? true);
            const renderRow = (a: (typeof project.agents)[number], trackerStage: WorkflowStageId | null) => {
          const st = status[a.id] ?? "stopped";
          // Idle/inactive agents (idle, blocked, errored, done, stopped all share the brand
          // GRAY) use a themed gray that's much darker in light mode for readability; active
          // green/red statuses keep their brand color. Compare to a known-gray status ("done")
          // instead of enumerating, so this tracks the AGENT_STATUS taxonomy if it changes.
          const color =
            AGENT_STATUS[st].color === AGENT_STATUS.done.color ? C.agentIdle : AGENT_STATUS[st].color;
          const isActive = !activeSpecial && project.selectedAgentId === a.id;
          const bs = branchStatus[a.id];
          const tier = bs ? stalenessTier(bs.behind) : "none";
          const grow = bs ? growNudge(bs) : false;
          const busy = st === "working";
          // Indent by tree position, not by parentId: the group head (top) sits at depth 0 — so
          // an orphaned worker surfaced as its own head isn't mis-indented — and real children at 1.
          const depth = a.id === top.id ? 0 : 1;
          const kindGlyph =
            a.kind === "brainstorm" ? "✦" : a.kind === "worker" ? "↳" : a.kind === "shell" ? "▶" : "⚒";
          return (
            <div
              key={a.id}
              onClick={() => onSelect(a.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                marginLeft: depth * 16,
                borderRadius: 8,
                cursor: "pointer",
                // Selected agent: a lighter, bluer lift (reads as "raised/active") with no
                // border or accent bar — a clean filled highlight, no edge of a different shade.
                background: isActive ? CHAT_USER_BUBBLE : "transparent",
                marginBottom: 2,
              }}
            >
              <span
                title={a.kind}
                style={{
                  fontSize: a.kind === "build" ? 28.8 : a.kind === "brainstorm" ? 19.5 : 12,
                  color: C.muted,
                  flex: "0 0 auto",
                  width: a.kind === "build" ? 24 : a.kind === "brainstorm" ? 20 : 12,
                  textAlign: "center",
                  // Keep the enlarged Build (⚒) / Brainstorm (✦) glyphs from driving the row's
                  // height — line-height 0 lets the big glyph overflow its line box (it stays
                  // centered) so rows keep their original, compact height.
                  lineHeight: 0,
                }}
              >
                {kindGlyph}
              </span>
              <StatusDot status={st} />
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                {editing === a.id ? (
                  <input
                    autoFocus
                    defaultValue={a.name}
                    onBlur={(e) => {
                      // Only commit a real change. A no-op blur (double-click to edit, then
                      // click away without typing) must NOT pin the name or wipe the auto-name
                      // variants — that would silently freeze width-fitting for this agent.
                      const next = e.target.value;
                      if (next.trim() && next !== a.name) {
                        renameAgent(project.id, a.id, next);
                      }
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
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
                    <FittedAgentName
                      variants={a.autoNameVariants}
                      name={a.name}
                      color={color}
                      active={isActive}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditing(a.id);
                      }}
                    />
                    {a.namePinned && (
                      // Pinned = a name the user set by hand; it won't auto-change. Click to
                      // unpin and let the agent name itself again on the next prompt.
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          setNamePinned(project.id, a.id, false);
                        }}
                        title="Name pinned — won't auto-rename. Click to unpin."
                        style={{ display: "inline-flex", flex: "0 0 auto", cursor: "pointer", lineHeight: 1, color: C.muted }}
                      >
                        <TbPinFilled size={11} />
                      </span>
                    )}
                  </div>
                )}
                {/* The agent's working directory — truncated to the column width,
                    full path in a styled "Working in:" card on hover. The agent runs
                    inside its isolated worktree; fall back to the project root until
                    that worktree is created. */}
                <Tooltip
                  label="Working in:"
                  value={
                    a.worktreePath ??
                    "Worktree is created when this agent first starts"
                  }
                >
                  <span
                    style={{
                      color: C.muted,
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      // Show the agent's full working path including the worktree ID;
                      // fall back to the project root until the worktree exists. `rtl`
                      // truncates at the START (keeping the worktree-ID tail visible);
                      // the LTR isolate (U+2066…U+2069) around the string below keeps
                      // its slashes/segments in correct order under bidi.
                      direction: "rtl",
                      textAlign: "left",
                    }}
                  >
                    {/* ⁦ = LTR isolate, ⁩ = pop directional isolate */}
                    {"⁦" + (a.worktreePath ?? project.rootPath) + "⁩"}
                  </span>
                </Tooltip>
                {/* Domino's-tracker chevrons: how far this work has progressed toward merged.
                    For an orchestrator this is the roll-up of its workers; for a worker it's its
                    own git stage. Brainstorm agents have no worktree, so trackerStage is null. */}
                {trackerStage && (
                  <div style={{ marginTop: 3 }}>
                    <WorkflowTracker
                      stage={trackerStage}
                      labelPrefix={a.kind === "build" && workers.length > 0 ? "Overall: " : undefined}
                    />
                  </div>
                )}
              </div>
              {bs && (tier !== "none" || grow) && (
                <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "0 0 auto" }}>
                  {tier !== "none" && (
                    <button
                      disabled={busy}
                      onClick={async (e) => {
                        e.stopPropagation();
                        // Re-read status at click time: the closed-over `busy` could be stale,
                        // and this gate is the only thing stopping a rebase under a live agent.
                        const liveBusy =
                          useRuntimeStore.getState().status[a.id] === "working";
                        const base = a.baseBranch ?? "";
                        const r = await refreshAgentBranch(
                          project.rootPath,
                          project.id,
                          a.id,
                          base,
                          liveBusy,
                        );
                        if (r.ok) {
                          void pollBranchStatus(project.rootPath, project.id, a.id, base);
                        } else {
                          // dirty/busy/conflict — surface via title; full toast UI is a follow-up.
                          console.warn("refresh blocked:", r.reason, r.files ?? "");
                        }
                      }}
                      title={
                        busy
                          ? "Pause the agent before refreshing"
                          : `${bs.behind} behind ${a.baseBranch ?? "the integration branch"} — click to refresh`
                      }
                      style={{
                        fontSize: 10,
                        color: tier === "warn" ? C.accentInk : C.muted,
                        background: "transparent",
                        border: "none",
                        cursor: busy ? "not-allowed" : "pointer",
                        opacity: busy ? 0.5 : 1,
                        padding: 0,
                      }}
                    >
                      ↻ {bs.behind}
                    </button>
                  )}
                  {grow && (
                    <span
                      title="Large branch — consider landing or splitting"
                      style={{ fontSize: 10, color: C.muted }}
                    >
                      ⤴
                    </span>
                  )}
                </div>
              )}
              {/* Land: offer the merge-to-integration action while the agent has unlanded commits
                  and hasn't reached On Main yet. A worker lands into its orchestrator; a build agent
                  into the project default. */}
              {bs &&
                bs.ahead > 0 &&
                a.kind !== "brainstorm" &&
                a.kind !== "shell" &&
                stageIndex(stageOf(a.id)) < stageIndex("main") && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onLand(a);
                    }}
                    title={
                      a.kind === "worker"
                        ? "Land this worker into its orchestrator's branch"
                        : "Land this work into the project's default branch"
                    }
                    style={{
                      fontSize: 10,
                      color: stageMeta("main").color,
                      background: "transparent",
                      border: `1px solid ${stageMeta("main").color}`,
                      borderRadius: 5,
                      cursor: "pointer",
                      padding: "1px 5px",
                      flex: "0 0 auto",
                      fontFamily: '"IBM Plex Sans", sans-serif',
                    }}
                  >
                    ⬆ Land
                  </button>
                )}
              <CloseAgentButton onClose={() => onClose(a.id)} />
            </div>
          );
            }; // end renderRow

            // The orchestrator's own chevron: the roll-up of its workers, or its own git stage when
            // it has none. Brainstorm/shell agents have no git workflow → no tracker (null).
            const headStage: WorkflowStageId | null =
              top.kind === "brainstorm" || top.kind === "shell"
                ? null
                : rollup
                  ? rollup.stage
                  : stageOf(top.id);
            const dom = rollup ? stageMeta(rollup.dominant) : null;
            return (
              <div key={top.id}>
                {renderRow(top, headStage)}
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
                {/* Expanded: each worker's own row + tracker. */}
                {top.kind === "build" &&
                  !collapsed &&
                  workers.map((w) => renderRow(w, stageOf(w.id)))}
                {/* Under a build agent: spawn another worker into the tree. Shown regardless of
                    collapse state so adding a worker never requires expanding the subtree first. */}
                {top.kind === "build" && (
                  <button
                    onClick={() => onAddWorker(top.id)}
                    title="Spawn a worker agent under this build agent"
                    style={{
                      marginLeft: 16,
                      marginBottom: 4,
                      padding: "4px 8px",
                      background: "transparent",
                      color: C.muted,
                      border: `1px dashed ${C.forest}`,
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12,
                      fontFamily: '"IBM Plex Sans", sans-serif',
                    }}
                  >
                    + worker
                  </button>
                )}
              </div>
            );
          });
        })()}
        {project && project.agents.length === 0 && (
          <div style={{ color: C.muted, fontSize: 12, padding: 10, lineHeight: 1.5 }}>
            <div>No agents are running.</div>
            <div style={{ marginTop: 8 }}>
              • Start a <strong>✦ Brainstorm</strong> agent to define what you want to build
            </div>
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

/** Close (×) control on each agent row. ~50% larger than the old glyph, with a thin pill
 *  that fades in on hover to make the hit target feel intentional. */
function CloseAgentButton({ onClose }: { onClose: () => void }) {
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
        // Glyph kept smaller than the 22px box so the × sits comfortably inside the hover pill.
        fontSize: 18,
        lineHeight: 1,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
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
