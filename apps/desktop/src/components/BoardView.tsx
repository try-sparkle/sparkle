import { useEffect, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { Project } from "../types";
import { DELIVERED_LABEL, type Bead } from "../services/beads";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useShallow } from "zustand/react/shallow";
import { sendToBuild } from "../services/sendToBuild";
import { workersForBead, epicStatus, beadStage, type EpicStatus } from "../services/planView";
import { WorkflowLine } from "./WorkflowLine";
import { stageMeta, stageLineColor, type WorkflowStageId } from "../engine/workflowStage";
import type { AgentTab } from "../types";

// The four board columns, in display order, paired with the Board snapshot key each reads.
const COLUMNS: { key: "backlog" | "inProgress" | "done" | "delivered"; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "inProgress", label: "In Progress" },
  { key: "done", label: "Done" },
  { key: "delivered", label: "Delivered" },
];

const DESC_PREVIEW = 120;

// Stable empty fallback: a `?? []` literal inside a zustand selector returns a NEW reference every
// render, which makes the store re-render in a loop. Reuse one frozen array instead.
const NO_AGENTS: AgentTab[] = [];

/**
 * Read-only Tasks Kanban for a project (bead sparkle-hiju.10). A window, NOT a control panel:
 * it polls `bd` via the beads store and renders the four buckets (Backlog / In Progress / Done /
 * Delivered) as columns of cards. Clicking a card opens a detail overlay. There are deliberately
 * no drag handles, status dropdowns, or any edit controls — nothing here mutates a bead.
 */
export function BoardView({ project }: { project: Project }) {
  const snapshot = useBeadsStore((s) => s.byProject[project.id]);
  const error = useBeadsStore((s) => s.error[project.id]);
  // Which bead's detail overlay is open (null = none). Cleared when the board unmounts.
  const [selected, setSelected] = useState<Bead | null>(null);

  // Live the board off the beads-store poller: start it on mount, stop on unmount. The store is
  // idempotent (one timer per project), so this co-exists with any other viewer of the same project.
  useEffect(() => {
    useBeadsStore.getState().startPolling(project.id, project.rootPath);
    return () => useBeadsStore.getState().stopPolling(project.id);
  }, [project.id, project.rootPath]);

  const board = snapshot?.board;
  const allBeads = snapshot?.beads ?? [];
  // Workers live in the agent store; the Plan view reads them to show who's building each bead.
  const agents = useProjectStore((s) => s.projects.find((p) => p.id === project.id)?.agents ?? NO_AGENTS);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: C.forest,
        color: C.cream,
        minHeight: 0,
      }}
    >
      {/* Header: title + (when present) the error banner. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          borderBottom: `1px solid ${C.deepForest}`,
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
          Tasks — {project.name}
        </div>
        {/* Errors keep any prior snapshot visible; surface the message in sienna without wiping. */}
        {error && (
          <div style={{ color: C.sienna, fontSize: 12, marginLeft: "auto" }}>{error}</div>
        )}
      </div>

      {/* No snapshot yet → loading. Otherwise the four columns. */}
      {!board ? (
        <div style={{ padding: 24, color: C.muted, fontSize: 14 }}>Loading tasks…</div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            gap: 12,
            padding: 16,
            overflowX: "auto",
            minHeight: 0,
          }}
        >
          {COLUMNS.map(({ key, label }) => (
            <Column
              key={key}
              label={label}
              beads={board[key]}
              agents={agents}
              onOpen={(b) => setSelected(b)}
            />
          ))}
        </div>
      )}

      {selected && (
        <DetailOverlay
          bead={selected}
          projectId={project.id}
          allBeads={allBeads}
          agents={agents}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Column({
  label,
  beads,
  agents,
  onOpen,
}: {
  label: string;
  beads: Bead[];
  agents: AgentTab[];
  onOpen: (b: Bead) => void;
}) {
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 220,
        display: "flex",
        flexDirection: "column",
        background: C.deepForest,
        borderRadius: 10,
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 1,
          fontWeight: FONT_WEIGHT.semibold,
          color: C.muted,
        }}
      >
        <span>{label}</span>
        <span style={{ color: C.muted, opacity: 0.7 }}>{beads.length}</span>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "0 10px 12px",
          overflowY: "auto",
          minHeight: 0,
        }}
      >
        {beads.length === 0 ? (
          <div style={{ color: C.muted, opacity: 0.5, fontSize: 12, padding: "8px 2px" }}>
            Nothing here yet
          </div>
        ) : (
          beads.map((b) => <Card key={b.id} bead={b} agents={agents} onOpen={onOpen} />)
        )}
      </div>
    </div>
  );
}

function Card({ bead, agents, onOpen }: { bead: Bead; agents: AgentTab[]; onOpen: (b: Bead) => void }) {
  const preview =
    bead.description.length > DESC_PREVIEW
      ? `${bead.description.slice(0, DESC_PREVIEW)}…`
      : bead.description;
  const workers = workersForBead(agents, bead.id);
  // The unified 9-stage progress for this unit of work: prefer the live build progress of any
  // worker(s) on the bead, else map the bead's own status. Shown as the blue logo-gradient line.
  const workerIds = agents
    .filter((a) => a.kind === "worker" && a.beadId === bead.id)
    .map((a) => a.id);
  // Subscribe to ONLY this bead's workers' stages (shallow-compared) so a stage tick on an
  // unrelated agent doesn't re-render every card on the board.
  const workerStages = useRuntimeStore(
    useShallow(
      (s) => workerIds.map((id) => s.workflowStage[id]).filter(Boolean) as WorkflowStageId[],
    ),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);
  return (
    <button
      onClick={() => onOpen(bead)}
      style={{
        textAlign: "left",
        background: C.forest,
        border: `1px solid ${C.deepForest}`,
        borderRadius: 8,
        padding: "10px 12px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      <div style={{ color: C.cream, fontWeight: FONT_WEIGHT.semibold, fontSize: 13, lineHeight: 1.3 }}>
        {bead.title}
      </div>
      {preview && (
        <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.4 }}>{preview}</div>
      )}
      <div
        style={{
          color: C.muted,
          opacity: 0.7,
          fontSize: 11,
          fontFamily: '"IBM Plex Mono", monospace',
        }}
      >
        {bead.id}
      </div>
      {workers.length > 0 && (
        <div style={{ color: C.teal, fontSize: 11, lineHeight: 1.4 }}>
          ⚙ {workers.length === 1 ? "1 worker" : `${workers.length} workers`}: {workers.join(", ")}
        </div>
      )}
      {/* Unified Think→Plan→Build progress: the blue logo-gradient line + its stage label. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <WorkflowLine stage={stage} height={3} />
        </div>
        <span
          style={{
            flex: "0 0 auto",
            fontSize: 10,
            fontWeight: 600,
            color: stageLineColor(stage),
            whiteSpace: "nowrap",
          }}
        >
          {stageMeta(stage).short}
        </span>
      </div>
    </button>
  );
}

function DetailOverlay({
  bead,
  projectId,
  allBeads,
  agents,
  onClose,
}: {
  bead: Bead;
  projectId: string;
  allBeads: Bead[];
  agents: AgentTab[];
  onClose: () => void;
}) {
  const [buildErr, setBuildErr] = useState("");
  const isEpic = bead.type === "epic";
  const status: EpicStatus | null = isEpic ? epicStatus(allBeads, bead.id) : null;
  const workers = workersForBead(agents, bead.id);
  // The epic body carries "PRD file: <path>" (see tasks.ts); pull it back out for the handoff.
  const prdPath = /PRD file:\s*(\S+)/.exec(bead.description)?.[1] ?? "";

  // "Build It": hand this epic to the Build orchestrator, which spawns one worker per child bead.
  function handleBuildIt() {
    setBuildErr("");
    // Guard a missing PRD link: without it sendToBuild would seed the orchestrator with an empty
    // "read the PRD at  …" path and silently succeed. Surface it instead of a broken handoff.
    if (!prdPath) {
      setBuildErr("This epic has no linked PRD — regenerate it from Think first.");
      return;
    }
    try {
      sendToBuild({ projectId, epicId: bead.id, prdPath });
      onClose();
    } catch (e) {
      setBuildErr(e instanceof Error ? e.message : String(e));
    }
  }

  const meta: { label: string; value: string }[] = [];
  if (bead.type) meta.push({ label: "Type", value: bead.type });
  if (bead.priority !== undefined) meta.push({ label: "Priority", value: String(bead.priority) });
  if (bead.labels.length > 0) meta.push({ label: "Labels", value: bead.labels.join(", ") });
  if (bead.parent) meta.push({ label: "Epic", value: bead.parent });

  return (
    <div
      // Click-outside (the scrim) dismisses. No native confirm/alert — this is a plain overlay.
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 50,
      }}
    >
      <div
        // Stop clicks inside the card from bubbling to the scrim (which would close it).
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(620px, 100%)",
          maxHeight: "100%",
          overflowY: "auto",
          background: C.deepForest,
          border: `1px solid ${C.forest}`,
          borderRadius: 12,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 16, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
            {bead.title}
          </div>
          <button
            aria-label="Close"
            title="Close"
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${C.forest}`,
              borderRadius: 6,
              color: C.muted,
              cursor: "pointer",
              padding: "2px 8px",
              fontSize: 14,
              lineHeight: 1.2,
              fontFamily: '"IBM Plex Sans", sans-serif',
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            color: C.muted,
            opacity: 0.8,
            fontSize: 12,
            fontFamily: '"IBM Plex Mono", monospace',
          }}
        >
          {bead.id}
        </div>

        {isEpic && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: status === "done" ? C.teal : status === "in_progress" ? C.cream : C.muted,
                border: `1px solid ${C.forest}`,
                borderRadius: 999,
                padding: "2px 10px",
              }}
            >
              {status === "in_progress" ? "in progress" : status === "done" ? "done" : "not started"}
            </span>
            <button
              onClick={handleBuildIt}
              title="Hand this epic to the Build orchestrator — it spawns one worker per task"
              style={{
                background: C.teal,
                color: C.cream,
                border: "none",
                borderRadius: 8,
                padding: "6px 16px",
                fontSize: 13,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: "pointer",
                fontFamily: '"IBM Plex Sans", sans-serif',
              }}
            >
              Build It
            </button>
            {buildErr && <span style={{ color: C.sienna, fontSize: 12 }}>{buildErr}</span>}
          </div>
        )}

        {bead.description && (
          <div
            style={{
              color: C.cream,
              fontSize: 14,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap", // preserve newlines in the full description
            }}
          >
            {bead.description}
          </div>
        )}

        {meta.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {meta.map((m) => (
              <div key={m.label} style={{ display: "flex", gap: 8, fontSize: 13 }}>
                <span style={{ color: C.muted, minWidth: 90 }}>{m.label}</span>
                <span style={{ color: C.cream }}>{m.value}</span>
              </div>
            ))}
          </div>
        )}

        {workers.length > 0 && (
          <div style={{ display: "flex", gap: 8, fontSize: 13 }}>
            <span style={{ color: C.muted, minWidth: 90 }}>Workers</span>
            <span style={{ color: C.teal }}>{workers.join(", ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
