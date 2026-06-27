import { useEffect, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { Project } from "../types";
import type { Bead } from "../services/beads";
import { useBeadsStore } from "../stores/beadsStore";

// The four board columns, in display order, paired with the Board snapshot key each reads.
const COLUMNS: { key: "backlog" | "inProgress" | "done" | "delivered"; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "inProgress", label: "In Progress" },
  { key: "done", label: "Done" },
  { key: "delivered", label: "Delivered" },
];

const DESC_PREVIEW = 120;

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
              onOpen={(b) => setSelected(b)}
            />
          ))}
        </div>
      )}

      {selected && <DetailOverlay bead={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Column({
  label,
  beads,
  onOpen,
}: {
  label: string;
  beads: Bead[];
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
          beads.map((b) => <Card key={b.id} bead={b} onOpen={onOpen} />)
        )}
      </div>
    </div>
  );
}

function Card({ bead, onOpen }: { bead: Bead; onOpen: (b: Bead) => void }) {
  const preview =
    bead.description.length > DESC_PREVIEW
      ? `${bead.description.slice(0, DESC_PREVIEW)}…`
      : bead.description;
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
    </button>
  );
}

function DetailOverlay({ bead, onClose }: { bead: Bead; onClose: () => void }) {
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
      </div>
    </div>
  );
}
