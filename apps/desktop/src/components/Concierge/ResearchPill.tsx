// The pill a RESEARCH TASK draws as when the concierge names one it dispatched, and the click that
// opens that task's row in the "Concierge Agents" group. The founder's ask: a dispatched research
// agent should read in chat as a clickable link into its row, exactly the way a builder agent does
// (bead `sparkle-jce9`; the row itself is `ConciergeAgentsRow`, bead `sparkle-s7rfc`).
//
// The third sibling of `AgentPill` / `BeadPill`, built to the same three rules so the three kinds of
// reference read as ONE vocabulary in a sentence:
//
//   1. IT RE-READS LIVE STATE ON EVERY RENDER. Never a snapshot. The status dot follows the task
//      from queued → running → done, and a task that has RETIRED (the concierge was told, the row
//      tore down) stops being a pill and becomes plain text — because a link into a row that no
//      longer exists is the dead link `AgentPill.deadEnd.test.tsx` forbids.
//   2. EVERY CLICK PRODUCES A VISIBLE RESULT. Clicking sets the store's `openTaskId`, which
//      `ConciergeAgentsRow` reads to EXPAND its group and scroll that child into view. A pill whose
//      task is not currently visible does not render as a button at all — it is prose.
//   3. INLINE ELEMENTS ONLY. This renders inside `<Markdown>`, i.e. inside a `<p>`, where a `<div>`
//      is invalid nesting the browser silently reparents.
//
// ══ WHY NO CONTEXT / PROVIDER (UNLIKE AgentPill AND BeadPill) ══════════════════════════════════
// Those two travel their live roster by CONTEXT to avoid defeating `<Markdown>`'s `memo` (which is
// keyed on `text` alone). A zustand hook does not go through props or context, so it defeats nothing
// — `BeadPill`'s own card reads `useBeadsStore` directly for exactly this reason. The research store
// is a single global singleton mirrored from disk (`services/research/store`), and the reveal is one
// of its actions, so this pill reads and writes it directly and needs no wrapper. That also makes it
// window-agnostic: the sidebar that shows the row reads the same store, wherever it is mounted.
import { type CSSProperties } from "react";
import { C } from "../../theme/colors";
import { MENTION_PILL_FILL } from "./MentionPill";
import { StatusDot } from "../StatusDot";
import { useResearchStore } from "../../services/research/store";
import { openResearchTaskInPane } from "../../services/research/selection";
import { isRetired } from "../../services/research/types";
import { agentStatusForResearch } from "../ConciergeAgentsRow";

/** The shared shape, mirroring `AgentPill.base` / `BeadPill.base` — same radius, padding and
 *  baseline alignment, so a research reference and an agent reference in one sentence read alike. */
const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  borderRadius: 4,
  padding: "1px 5px",
  // A pill broken across two lines stops reading as one object.
  whiteSpace: "nowrap",
  fontSize: "inherit",
  fontFamily: "inherit",
  lineHeight: "inherit",
  verticalAlign: "baseline",
  maxWidth: "100%",
  minWidth: 0,
};

/** The label span — clippable, so a long question ellipsizes rather than widening the bubble. Uses
 *  the same clip class `AgentPill` uses (hidden→clip under `@supports`, defined in index.css) so the
 *  baseline is untouched and the "…" still paints. */
const labelText: CSSProperties = {
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

/**
 * One research-task reference.
 *
 * `taskId` is what the persona wrote after `sparkle-research:`. `fallbackLabel` is the link's visible
 * text (the question, as the model wrote it) — used only when the live task carries no question of
 * its own to prefer, mirroring how `AgentPill` prefers the live roster name over the written label.
 */
export function ResearchPill({
  taskId,
  fallbackLabel,
}: {
  taskId: string;
  fallbackLabel: string;
}) {
  // RE-READ EVERY RENDER — rule 1. The subscription repaints the pill the instant the task's status
  // moves or it retires, with no snapshot held anywhere.
  const task = useResearchStore((s) => s.byId[taskId]);
  // The live question wins when there is one, so a pill reads what the task actually asked rather
  // than whatever label the model happened to type. Falls back to the written label, then the id.
  const label = task?.question?.trim() || fallbackLabel.trim() || taskId;

  // ── IT DOES NOT RESOLVE TO A VISIBLE TASK ─────────────────────────────────────────────────────
  // Plain text, no wrapper — rule 2. A retired task (the concierge was told, the row is gone) and an
  // unknown id alike fall here: there is nothing to open, so the reference is the prose it was.
  // Deliberately NOT a muted "closed" span: unlike an agent, a retired research task's disappearance
  // is the normal, expected end of its life, and its answer has already been woven into the chat.
  if (task === undefined || isRetired(task)) {
    return <>{label}</>;
  }

  const st = agentStatusForResearch(task.status);
  return (
    <button
      type="button"
      data-testid="concierge-research-pill"
      data-task-id={task.id}
      data-status={task.status}
      title={`${label} — research (${task.status})`}
      // THE REVEAL. Opens the task in the MAIN pane (founder 2026-08-17: a research agent works like
      // any other worker — its click shows it on the right, not inline). `openResearchTaskInPane`
      // sets `openTaskId` (so `ConciergeAgentsRow` expands its group and scrolls the child into view,
      // exactly as before) AND flips `activeSpecial` to "research" so the pane is the active surface.
      // A plain action, no navigation, so there is no updater-purity hazard of the kind
      // `AgentPill`/`BeadPill` design around.
      onClick={() => openResearchTaskInPane(task.id)}
      style={{
        ...base,
        border: "none",
        cursor: "pointer",
        // The mention vocabulary's teal wash, from the shared constant rather than re-spelled — the
        // same fill the agent and bead pills take, so all three read as one thing.
        background: MENTION_PILL_FILL,
        color: C.cream,
      }}
    >
      <StatusDot status={st} size={7} label={task.status} />
      <span className="clip-no-scroll" style={labelText}>
        {label}
      </span>
    </button>
  );
}
