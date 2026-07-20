// Per-card criteria progress + confirm-first "Mark as …" control (Definable Done & Delivered,
// Unit 5). For a card whose NEXT stage (Done for backlog/in-progress cards, Delivered for done
// cards) is defined, this shows a compact "N/M" chip; expanding it lists each criterion with its
// met/unmet + auto/manual state, and MANUAL criteria render as checkboxes wired to the persisted
// tick store. When every criterion is met, a "Mark as Done" / "Mark as Delivered" button appears —
// clicking it performs the REAL bd move (close / markBeadDelivered). Nothing auto-moves; the human
// confirms. Spec: docs/superpowers/specs/2026-07-02-definable-done-delivered-design.md
import { useState, type CSSProperties, type MouseEvent } from "react";
import { FiCheck, FiCircle, FiChevronDown, FiChevronUp } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { closeBead, markBeadDelivered, type Bead } from "../services/beads";
import { evaluateStage, type EvalContext } from "../services/criteriaEval";
import { useCriteriaStore } from "../services/criteriaStore";
import type { StageDefinition, StageKey } from "../services/stageDefs";
import type { WorkflowStageId } from "../engine/workflowStage";

export function CardCriteria({
  bead,
  stageKey,
  def,
  stage,
  inRelease,
  projectRoot,
}: {
  bead: Bead;
  /** The NEXT stage this card is progressing toward (its criteria are evaluated). */
  stageKey: StageKey;
  /** That stage's definition (caller guarantees it isDefined). */
  def: StageDefinition;
  /** The card's current 10-stage stage — drives the auto signals (merged_to_main / pushed / …). */
  stage: WorkflowStageId;
  /** Delivery-monitor verdict for this bead (Delivered only); undefined → honest fallback in eval. */
  inRelease?: boolean;
  projectRoot: string;
}) {
  // Subscribe to THIS bead+stage's ticks (serialized) so a manual toggle re-renders + re-evaluates.
  // A primitive-string selector keeps zustand's Object.is check happy (no render loop).
  const ticksKey = useCriteriaStore((s) => JSON.stringify(s.ticks[bead.id]?.[stageKey] ?? {}));
  void ticksKey; // consumed only for its subscription side-effect
  const toggle = useCriteriaStore((s) => s.toggle);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const ctx: EvalContext = { key: stageKey, stage, inRelease };
  const evaluation = evaluateStage(bead, def, ctx);
  const total = evaluation.criteria.length;
  const met = evaluation.criteria.filter((c) => c.state === "met").length;
  const label = stageKey === "done" ? "Done" : "Delivered";

  async function mark(e: MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      if (stageKey === "delivered") await markBeadDelivered(projectRoot, bead.id);
      else await closeBead(projectRoot, bead.id);
      // The beads-store poller reflects the move; no local mutation needed.
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={wrap}>
      <div style={row}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          title={`Acceptance criteria that must be met before this card can move to “${label}” — ${met} of ${total} met`}
          aria-expanded={open}
          style={progressChip}
        >
          <FiCheck
            size={11}
            color={evaluation.allMet ? C.successInk : C.muted}
            aria-hidden
          />
          <span style={{ color: evaluation.allMet ? C.successInk : C.muted, fontWeight: FONT_WEIGHT.semibold }}>
            {met} of {total}
          </span>
          <span style={{ color: C.muted, opacity: 0.85 }}>· {label} criteria</span>
          {open ? <FiChevronUp size={12} aria-hidden /> : <FiChevronDown size={12} aria-hidden />}
        </button>
        {evaluation.allMet && (
          <button type="button" onClick={mark} disabled={busy} style={markButton}>
            {busy ? "Marking…" : `Mark as ${label}`}
          </button>
        )}
      </div>

      {open && (
        <ul style={critList}>
          <li style={critHeader}>{`Acceptance criteria for “${label}”`}</li>
          {evaluation.criteria.map((c, i) => {
            const done = c.state === "met";
            return (
              <li key={i} style={critItem}>
                {c.manual ? (
                  <label style={critLabel} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={(e) => {
                        e.stopPropagation();
                        toggle(bead.id, stageKey, i);
                      }}
                      style={{ margin: 0 }}
                    />
                    <span style={{ color: C.cream }}>{c.criterion.text}</span>
                  </label>
                ) : (
                  <span style={critLabel}>
                    {done ? (
                      <FiCheck size={12} color={C.successInk} aria-hidden />
                    ) : (
                      <FiCircle size={12} color={C.muted} aria-hidden />
                    )}
                    <span style={{ color: C.cream }}>{c.criterion.text}</span>
                  </span>
                )}
                <span style={{ ...tag, color: c.manual ? C.muted : C.successInk, borderColor: c.manual ? C.muted : C.successInk }}>
                  {c.manual ? "manual" : c.state === "unknown" ? "auto · ?" : "auto"}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {err && <div style={{ color: C.sienna, fontSize: 11 }}>{err}</div>}
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────────────────────
const wrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, marginTop: 2 };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

const progressChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  border: `1px solid ${C.deepForest}`,
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
  color: C.muted,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const markButton: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 6,
  padding: "3px 12px",
  fontSize: 11.5,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const critList: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: "6px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  background: C.deepForest,
  borderRadius: 6,
};

const critHeader: CSSProperties = {
  fontSize: 10.5,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.muted,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  paddingBottom: 2,
};

const critItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 11.5,
};

const critLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  cursor: "default",
  minWidth: 0,
};

const tag: CSSProperties = {
  flex: "0 0 auto",
  fontSize: 9.5,
  border: "1px solid",
  borderRadius: 5,
  padding: "0 5px",
  whiteSpace: "nowrap",
  fontFamily: '"IBM Plex Mono", monospace',
};
