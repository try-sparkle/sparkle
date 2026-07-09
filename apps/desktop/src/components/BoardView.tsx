import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { Project } from "../types";
import {
  childrenOf,
  claimBead,
  labelBead,
  mergeShaOf,
  DELIVERED_LABEL,
  type Bead,
  type BoardColumn,
} from "../services/beads";
import { DECOMPOSE_FAILED_LABEL, DECOMPOSING_LABEL } from "../services/epicDecompose";
import { parsePrdRef } from "../services/tasks";
import { safeUnlisten } from "../services/safeUnlisten";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useShallow } from "zustand/react/shallow";
import { sendToBuild } from "../services/sendToBuild";
import {
  workersForBead,
  epicStatus,
  beadStage,
  epicChildViews,
  orchestratorNameForEpic,
  type EpicStatus,
  type EpicChildView,
} from "../services/planView";
import { WorkflowLine } from "./WorkflowLine";
import { FiUsers } from "react-icons/fi";
import { stageMeta, stageLineColor, type WorkflowStageId } from "../engine/workflowStage";
import type { AgentTab } from "../types";
import { getConfig, onConfigChanged } from "../services/config";
import { readStageDef, isDefined, type StageKey, type StageDefinition } from "../services/stageDefs";
import {
  startDeliveryMonitor,
  stopDeliveryMonitor,
  type DeliveryMonitorUpdate,
  type WatchedBead,
} from "../services/deliveryMonitor";
import { DefineStageModal } from "./DefineStageModal";
import { StageColumnHeader, DefineStageCta, definableStageKey, type DeliveryChip } from "./StageColumnHeader";
import { CardCriteria } from "./CardCriteria";

/** The next board stage a card in `columnKey` is progressing toward (whose criteria we evaluate):
 *  Backlog / In Progress → Done; Done → Delivered; Delivered is terminal (none). */
function nextStageOf(columnKey: BoardColumn): StageKey | null {
  if (columnKey === "backlog" || columnKey === "inProgress") return "done";
  if (columnKey === "done") return "delivered";
  return null;
}

/** Per-project Done/Delivered definitions, read once from config and refreshed on config-changed. */
interface StageDefs {
  done?: StageDefinition;
  delivered?: StageDefinition;
}

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

  // ── Definable Done & Delivered (Unit 5) ──────────────────────────────────────────────────────
  // Which stage's Define/Edit modal is open (null = none).
  const [defineStage, setDefineStage] = useState<StageKey | null>(null);
  // Per-project Done/Delivered definitions: read once per project, refreshed on config-changed.
  const [defs, setDefs] = useState<StageDefs>({});
  // Latest delivery-monitor tick (drives the Delivered header chip + per-card `in_release`).
  const [delivery, setDelivery] = useState<DeliveryMonitorUpdate | null>(null);

  // Load the definitions once per project, then live-refresh on any config write/edit. The modal's
  // save fires `config-changed`, so the board picks up a fresh definition without a manual poll.
  useEffect(() => {
    let cancelled = false;
    const apply = (cfg: Parameters<typeof readStageDef>[0]) => {
      if (cancelled) return;
      setDefs({ done: readStageDef(cfg, "done"), delivered: readStageDef(cfg, "delivered") });
    };
    getConfig(project.rootPath)
      .then((eff) => apply(eff.config))
      .catch(() => {
        /* undefined-as-a-whole is the honest fallback; the board renders as today. */
      });
    let unlisten: (() => void) | undefined;
    onConfigChanged((eff) => apply(eff.config))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // Route teardown through safeUnlisten so the benign Tauri "listeners map already torn
      // down" race (window close / rapid remount) can't surface as an unhandled rejection.
      void safeUnlisten(unlisten);
    };
  }, [project.rootPath]);

  const deliveredDefined = isDefined(defs.delivered);

  // The delivery monitor watches in-flight/closed beads for a shipped-release signal and pushes live
  // updates. It runs only once Delivered is defined (no point otherwise). We feed it a fresh watch
  // set each tick via a ref so add/remove beads don't restart it. Each bead carries the commit SHA
  // its branch landed as (captured at land time onto a `merged-sha:` label, Task B); when present the
  // monitor tests THAT exact commit for release containment, and when absent (shipped via PR, or an
  // older build) it honestly reports not-in-release rather than claiming a delivery it can't verify.
  const boardRef = useRef(board);
  boardRef.current = board;
  useEffect(() => {
    if (!deliveredDefined) {
      stopDeliveryMonitor();
      setDelivery(null);
      return;
    }
    const getBeads = (): WatchedBead[] => {
      const b = boardRef.current;
      if (!b) return [];
      // Candidates for a delivery signal: everything that's reached Done or beyond (plus in-flight).
      return [...b.inProgress, ...b.done, ...b.delivered].map((x) => ({
        beadId: x.id,
        mergeSha: mergeShaOf(x),
      }));
    };
    startDeliveryMonitor(project.rootPath, (u) => setDelivery(u), getBeads);
    return () => stopDeliveryMonitor();
  }, [project.rootPath, deliveredDefined]);

  // Per-bead `in_release` verdict from the latest tick, for the Delivered criteria evaluation.
  const inReleaseByBead = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const s of delivery?.signals ?? []) m.set(s.beadId, s.inRelease);
    return m;
  }, [delivery]);

  const deliveryChip: DeliveryChip | undefined = delivery
    ? // We render our own FiCheck/FiAlertTriangle icon, so strip ANY leading glyph/symbol/space the
      // monitor prepends (⚠/✓ today, but robust to any future marker) to avoid a doubled indicator.
      { detectable: delivery.detectable, label: delivery.status.replace(/^[^\p{L}\p{N}]+/u, "") }
    : undefined;

  // One-shot board-focus handoff (spec §8): the sidebar epic pill sets boardFocusBeadId before
  // switching here; once the bead is present in a snapshot, open its DetailOverlay and clear the
  // handoff. Deliberately left SET while the bead is still missing (e.g. first poll in flight) —
  // the effect re-runs when the snapshot lands, so the jump survives the loading state.
  const boardFocusBeadId = useUiStore((s) => s.boardFocusBeadId);
  useEffect(() => {
    if (!boardFocusBeadId || !snapshot) return;
    const hit = snapshot.beads.find((b) => b.id === boardFocusBeadId);
    if (hit) {
      setSelected(hit);
      useUiStore.getState().setBoardFocusBeadId(null);
    }
  }, [boardFocusBeadId, snapshot]);
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
              columnKey={key}
              label={label}
              beads={board[key]}
              allBeads={allBeads}
              agents={agents}
              project={project}
              defs={defs}
              deliveryChip={deliveryChip}
              inReleaseByBead={inReleaseByBead}
              onDefine={setDefineStage}
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

      {/* Definable Done & Delivered — the Define/Edit modal, opened from a column header or CTA. */}
      {defineStage && (
        <DefineStageModal
          stageKey={defineStage}
          projectName={project.name}
          projectRoot={project.rootPath}
          onClose={() => setDefineStage(null)}
        />
      )}
    </div>
  );
}

function Column({
  columnKey,
  label,
  beads,
  allBeads,
  agents,
  project,
  defs,
  deliveryChip,
  inReleaseByBead,
  onDefine,
  onOpen,
}: {
  columnKey: BoardColumn;
  label: string;
  beads: Bead[];
  allBeads: Bead[];
  agents: AgentTab[];
  project: Project;
  defs: StageDefs;
  deliveryChip?: DeliveryChip;
  inReleaseByBead: Map<string, boolean>;
  onDefine: (key: StageKey) => void;
  onOpen: (b: Bead) => void;
}) {
  // This column's own stage (for the header chip + undefined CTA), and the next stage a card here
  // is progressing toward (whose criteria the cards evaluate).
  const ownStageKey = definableStageKey(columnKey);
  const ownDef = ownStageKey ? defs[ownStageKey] : undefined;
  const ownDefined = isDefined(ownDef);
  const nextStageKey = nextStageOf(columnKey);
  const nextDef = nextStageKey ? defs[nextStageKey] : undefined;
  const nextDefined = isDefined(nextDef);

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
      <StageColumnHeader
        columnKey={columnKey}
        label={label}
        count={beads.length}
        defined={ownDefined}
        deliveryChip={deliveryChip}
        onDefine={onDefine}
      />
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
        {/* Undefined Done/Delivered → the centered blue Define CTA (shown even above legacy cards). */}
        {ownStageKey && !ownDefined && (
          <DefineStageCta stageKey={ownStageKey} label={label} onDefine={onDefine} />
        )}
        {beads.length === 0 ? (
          // Suppress the "nothing here yet" hint when the Define CTA already fills an empty column.
          ownStageKey && !ownDefined ? null : (
            <div style={{ color: C.muted, opacity: 0.5, fontSize: 12, padding: "8px 2px" }}>
              Nothing here yet
            </div>
          )
        ) : (
          beads.map((b) => (
            <Card
              key={b.id}
              bead={b}
              columnKey={columnKey}
              allBeads={allBeads}
              agents={agents}
              project={project}
              nextStageKey={nextDefined ? nextStageKey : null}
              nextDef={nextDefined ? nextDef : undefined}
              inRelease={inReleaseByBead.get(b.id)}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Card({
  bead,
  columnKey,
  allBeads,
  agents,
  project,
  nextStageKey,
  nextDef,
  inRelease,
  onOpen,
}: {
  bead: Bead;
  columnKey: BoardColumn;
  allBeads: Bead[];
  agents: AgentTab[];
  project: Project;
  /** The defined next stage this card evaluates toward (null when that stage is undefined). */
  nextStageKey: StageKey | null;
  nextDef?: StageDefinition;
  inRelease?: boolean;
  onOpen: (b: Bead) => void;
}) {
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
    // The card's visual shell is a div so the interactive Start button can live BESIDE the
    // clickable body (a <button> must not contain a nested <button>). The body button opens detail;
    // StartControls is a sibling, so a Start click never bubbles to the body.
    <div
      style={{
        background: C.forest,
        border: `1px solid ${C.deepForest}`,
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      <button
        onClick={() => onOpen(bead)}
        style={{
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          width: "100%",
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
            <FiUsers size={11} style={{ verticalAlign: "-2px", marginRight: 3 }} aria-hidden />
            {workers.length === 1 ? "1 worker" : `${workers.length} workers`}: {workers.join(", ")}
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
      {/* Backlog epic → Start controls (spec §7): claim + hand off to Build, with the
          decompose-state affordances (disabled while decomposing/childless, retry on failure). */}
      {columnKey === "backlog" && bead.type === "epic" && (
        <StartControls bead={bead} allBeads={allBeads} project={project} />
      )}
      {/* Definable Done & Delivered (Unit 5): when the card's NEXT stage is defined, show its compact
          criteria progress + the confirm-first "Mark as …" control (only when every criterion is met).
          A sibling of the body button so its clicks never open the detail overlay. */}
      {nextStageKey && nextDef && (
        <CardCriteria
          bead={bead}
          stageKey={nextStageKey}
          def={nextDef}
          stage={stage}
          inRelease={inRelease}
          projectRoot={project.rootPath}
        />
      )}
    </div>
  );
}

/**
 * Backlog-epic Start controls (spec §7). Start claims the epic (→ in_progress) and hands it to the
 * Build orchestrator via sendToBuild — PRD path parsed from the epic body, or null for a PRD-less
 * epic (sendToBuild seeds off the epic bead itself). Disabled with a "decomposing…" tooltip while
 * the epic is still being decomposed (zero children) or carries the `decomposing` label; both the
 * `decomposing…` and `decompose failed` badges are click-to-clear (stuck-label recovery / retry —
 * clearing the label lets the next sweep re-decompose). All clicks stopPropagation so they never
 * open the card's detail overlay.
 */
function StartControls({
  bead,
  allBeads,
  project,
}: {
  bead: Bead;
  allBeads: Bead[];
  project: Project;
}) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const isDecomposing = bead.labels.includes(DECOMPOSING_LABEL);
  const isFailed = bead.labels.includes(DECOMPOSE_FAILED_LABEL);
  const noChildren = childrenOf(allBeads, bead.id).length === 0;
  const startDisabled = isDecomposing || noChildren || busy;

  async function handleStart(e: MouseEvent) {
    e.stopPropagation(); // never let Start also open the detail overlay
    if (startDisabled) return;
    setErr("");
    setBusy(true);
    try {
      await claimBead(project.rootPath, bead.id); // → in_progress
      const prd = parsePrdRef(bead.description);
      sendToBuild({ projectId: project.id, epicId: bead.id, prdPath: prd?.relPath ?? null });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function clearLabel(e: MouseEvent, label: string) {
    e.stopPropagation();
    setErr("");
    try {
      await labelBead(project.rootPath, "remove", bead.id, label);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
      <button
        onClick={handleStart}
        disabled={startDisabled}
        title={
          startDisabled
            ? "decomposing…"
            : "Build It — claim this epic and hand it to the Build orchestrator"
        }
        style={{
          background: startDisabled ? C.deepForest : C.teal,
          color: startDisabled ? C.muted : C.cream,
          border: "none",
          borderRadius: 4,
          padding: "3px 12px",
          fontSize: 12,
          fontWeight: FONT_WEIGHT.semibold,
          cursor: startDisabled ? "default" : "pointer",
          fontFamily: '"IBM Plex Sans", sans-serif',
        }}
      >
        Build It
      </button>
      {isDecomposing && (
        <button
          onClick={(e) => clearLabel(e, DECOMPOSING_LABEL)}
          title="Stuck? Click to clear the decomposing label so the next sweep retries"
          style={{
            background: "transparent",
            border: `1px solid ${C.muted}`,
            borderRadius: 4,
            color: C.muted,
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: 11,
            fontFamily: '"IBM Plex Sans", sans-serif',
          }}
        >
          decomposing…
        </button>
      )}
      {isFailed && (
        <button
          onClick={(e) => clearLabel(e, DECOMPOSE_FAILED_LABEL)}
          title="Decompose failed — click to retry (clears the label; the next sweep re-decomposes)"
          style={{
            background: "transparent",
            border: `1px solid ${C.sienna}`,
            borderRadius: 4,
            color: C.sienna,
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: 11,
            fontFamily: '"IBM Plex Sans", sans-serif',
          }}
        >
          decompose failed
        </button>
      )}
      {err && <span style={{ color: C.sienna, fontSize: 11 }}>{err}</span>}
    </div>
  );
}

/**
 * The epic's live build status (spec §7): the bound orchestrator's name + one row per child task
 * showing its live WorkflowLine stage and the workers on it — "see the whole epic's build from
 * Plan". Renders nothing until the epic has children (a still-decomposing epic shows the
 * decomposing badge on its board card instead).
 */
function EpicLiveStatus({
  epicId,
  allBeads,
  agents,
}: {
  epicId: string;
  allBeads: Bead[];
  agents: AgentTab[];
}) {
  const rows = epicChildViews(allBeads, agents, epicId);
  if (rows.length === 0) return null;
  const orchestrator = orchestratorNameForEpic(allBeads, agents, epicId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, fontSize: 13 }}>
        <span style={{ color: C.muted, minWidth: 90 }}>Orchestrator</span>
        <span style={{ color: orchestrator ? C.teal : C.muted }}>
          {orchestrator ?? "not started"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row) => (
          <EpicChildRow key={row.bead.id} row={row} agents={agents} />
        ))}
      </div>
    </div>
  );
}

/** One child-task row of the epic's live status view: title + live stage (from the child's
 *  worker(s), same subscription pattern as the board Card) + the workers on it. */
function EpicChildRow({ row, agents }: { row: EpicChildView; agents: AgentTab[] }) {
  const { bead, workers } = row;
  const workerIds = agents
    .filter((a) => a.kind === "worker" && a.beadId === bead.id)
    .map((a) => a.id);
  const workerStages = useRuntimeStore(
    useShallow(
      (s) => workerIds.map((id) => s.workflowStage[id]).filter(Boolean) as WorkflowStageId[],
    ),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        background: C.forest,
        borderRadius: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, color: C.cream, fontSize: 13 }}>{bead.title}</span>
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
      <WorkflowLine stage={stage} height={3} />
      {workers.length > 0 && (
        <div style={{ color: C.teal, fontSize: 11, lineHeight: 1.4 }}>{workers.join(", ")}</div>
      )}
    </div>
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
  const [buildBusy, setBuildBusy] = useState(false);
  const isEpic = bead.type === "epic";
  const isTask = bead.type === "task";
  const status: EpicStatus | null = isEpic ? epicStatus(allBeads, bead.id) : null;
  const workers = workersForBead(agents, bead.id);
  // The project's checkout root, needed to claim beads before the Build handoff (same as
  // StartControls). Looked up from the store since DetailOverlay only receives the projectId.
  const rootPath = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.rootPath ?? null,
  );
  // The epic body carries "PRD file: <path>" (see tasks.ts / parsePrdRef); pull it back out with the
  // robust parser — null for a PRD-less epic, which NO LONGER blocks the handoff (sendToBuild seeds
  // off `bd show <epicId>` instead).
  const prdPath = parsePrdRef(bead.description)?.relPath ?? null;
  // Sibling epics that share this epic's PRD → offer a "Build all N epics in this PRD" when >1.
  const prdEpics = prdPath
    ? allBeads.filter((b) => b.type === "epic" && parsePrdRef(b.description)?.relPath === prdPath)
    : [];

  // "Build It" (epic): claim this epic (→ in_progress), then hand it to the Build orchestrator,
  // which fans one worker out per child task. A PRD-less epic is fine now — no hard block.
  async function handleBuildIt() {
    if (buildBusy) return;
    setBuildErr("");
    setBuildBusy(true);
    try {
      if (rootPath) await claimBead(rootPath, bead.id); // match StartControls' claim+handoff
      sendToBuild({ projectId, epicId: bead.id, prdPath });
      onClose();
    } catch (e) {
      setBuildErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuildBusy(false);
    }
  }

  // "Build It" (single task): claim this bead, then hand it to the orchestrator in task mode — build
  // THIS one bead on a single isolated worker branch, no fan-out.
  async function handleBuildTask() {
    if (buildBusy) return;
    setBuildErr("");
    setBuildBusy(true);
    try {
      if (rootPath) await claimBead(rootPath, bead.id);
      sendToBuild({ projectId, epicId: bead.id, prdPath, mode: "task" });
      onClose();
    } catch (e) {
      setBuildErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuildBusy(false);
    }
  }

  // "Build all N epics in this PRD": claim + hand off every epic sharing this PRD, in turn.
  async function handleBuildAllPrd() {
    if (buildBusy) return;
    setBuildErr("");
    setBuildBusy(true);
    try {
      for (const epic of prdEpics) {
        if (rootPath) await claimBead(rootPath, epic.id);
        sendToBuild({ projectId, epicId: epic.id, prdPath });
      }
      onClose();
    } catch (e) {
      setBuildErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuildBusy(false);
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
                borderRadius: 4,
                padding: "2px 10px",
              }}
            >
              {status === "in_progress" ? "in progress" : status === "done" ? "done" : "not started"}
            </span>
            <button
              onClick={handleBuildIt}
              disabled={buildBusy}
              title="Build It — claim this epic and hand it to the Build orchestrator, which spawns one worker per task"
              style={{
                background: C.teal,
                color: C.cream,
                border: "none",
                borderRadius: 8,
                padding: "6px 16px",
                fontSize: 13,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: buildBusy ? "default" : "pointer",
                opacity: buildBusy ? 0.7 : 1,
                fontFamily: '"IBM Plex Sans", sans-serif',
              }}
            >
              {buildBusy ? "Building…" : "Build It"}
            </button>
            {/* When this epic shares its PRD with sibling epics, offer to build them all at once. */}
            {prdEpics.length > 1 && (
              <button
                onClick={handleBuildAllPrd}
                disabled={buildBusy}
                title={`Claim and build all ${prdEpics.length} epics that share this PRD`}
                style={{
                  background: "transparent",
                  color: C.teal,
                  border: `1px solid ${C.teal}`,
                  borderRadius: 8,
                  padding: "6px 16px",
                  fontSize: 13,
                  fontWeight: FONT_WEIGHT.semibold,
                  cursor: buildBusy ? "default" : "pointer",
                  opacity: buildBusy ? 0.7 : 1,
                  fontFamily: '"IBM Plex Sans", sans-serif',
                }}
              >
                {`Build all ${prdEpics.length} epics in this PRD`}
              </button>
            )}
            {buildErr && <span style={{ color: C.sienna, fontSize: 12 }}>{buildErr}</span>}
          </div>
        )}

        {/* Task-level Build It: build THIS single bead on one isolated worker branch (no fan-out). */}
        {isTask && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button
              onClick={handleBuildTask}
              disabled={buildBusy}
              title="Build It — build this single task on one isolated worker branch, then verify and integrate it"
              style={{
                background: C.teal,
                color: C.cream,
                border: "none",
                borderRadius: 8,
                padding: "6px 16px",
                fontSize: 13,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: buildBusy ? "default" : "pointer",
                opacity: buildBusy ? 0.7 : 1,
                fontFamily: '"IBM Plex Sans", sans-serif',
              }}
            >
              {buildBusy ? "Building…" : "Build It"}
            </button>
            {buildErr && <span style={{ color: C.sienna, fontSize: 12 }}>{buildErr}</span>}
          </div>
        )}

        {/* Live epic status (spec §7): orchestrator + per-child WorkflowLine stages + workers. */}
        {isEpic && <EpicLiveStatus epicId={bead.id} allBeads={allBeads} agents={agents} />}

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
