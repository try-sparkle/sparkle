import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TbPinFilled } from "react-icons/tb";
import { C, AGENT_STATUS, FONT_WEIGHT, CHAT_USER_BUBBLE, ON_BRAND_FILL, ON_BRAND_FILL_DARK } from "../theme/colors";
import type { Project, AgentTabStatus } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { removeAgentWorktree } from "../services/worktree";
import { refreshAgentBranch } from "../services/branchStatus";
import { SPARKLE_AGENT_ID, SPARKLE_AGENT_NAME } from "../services/sparkleAgent";
import { stalenessTier, growNudge } from "../engine/nudges";
import { spawnWorker } from "../services/workerSpawn";
import { sortAgentsByAttention } from "../engine/agentOrdering";
import { StatusDot } from "./StatusDot";
import { StatusBar } from "./StatusBar";
import { Tooltip } from "./Tooltip";
import { LogoWaveform } from "./LogoWaveform";
import { FittedAgentName } from "./FittedAgentName";

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
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  const agentOrdering = useUiStore((s) => s.agentOrdering);
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
  const onClose = (id: string) => {
    if (!project) return;
    // Closing a build agent cascades to its workers in the store; clean up each one's worktree.
    const childIds = project.agents.filter((a) => a.parentId === id).map((a) => a.id);
    for (const cid of [id, ...childIds]) {
      close(cid);
      void removeAgentWorktree(project.rootPath, project.id, cid).catch(() => {});
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
            ✦ Brainstorm
          </button>
          <button
            onClick={onAddBuild}
            title="A master orchestrator that spawns worker agents to get work done"
            style={createBtnStyle(C.accentMid, C.teal, ON_BRAND_FILL)} // blue leads (matches logo's right side); white icon+text
          >
            ⚒ Build
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
            return (
              <div key={top.id}>
                {[top, ...workers].map((a) => {
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
          const kindGlyph = a.kind === "brainstorm" ? "✦" : a.kind === "worker" ? "↳" : "⚒";
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
                style={{ fontSize: a.kind === "build" ? 14.4 : 12, color: C.muted, flex: "0 0 auto", width: 12, textAlign: "center" }}
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
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(a.id);
                }}
                title="Close agent"
                style={{ color: C.muted, fontSize: 15, lineHeight: 1, flex: "0 0 auto" }}
              >
                ×
              </span>
            </div>
          );
                })}
                {/* Under a build agent: spawn another worker into the tree. */}
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
            No agents yet. Start a <strong>✦ Brainstorm</strong> to think with Chief, or a{" "}
            <strong>⚒ Build</strong> to orchestrate workers.
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
