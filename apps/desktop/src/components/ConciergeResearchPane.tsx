// THE CONCIERGE RESEARCH VIEW — a research task, shown in the MAIN pane like any other worker's
// terminal. Bead `sparkle-s7rfc`.
//
// Founder, 2026-08-17: a concierge research agent should work "exactly like any other worker" —
// click its name and the RIGHT pane shows what was SENT and what is HAPPENING, with nothing
// expanding inline in the builder column. The founder also said the view MAY look different from a
// real terminal (a research task has no worktree/branch/PTY), so this is a purpose-built view, not
// a PTY. It renders into the primary pair's stage exactly where the Improve-Sparkle pane does,
// gated by `activeSpecial === "research"` (see Workspace.tsx and stores/uiStore.ts).
//
// ══ THE HEADLINE: A LIVE TAIL, NOT JUST A TIMER ════════════════════════════════════════════════
//
// Before this, a running research task showed only "Running deep research 2.8m" — a clock, no
// content. The runner now streams its work (research.rs, `--output-format stream-json`) into a
// capped sidecar; this view POLLS that tail on the existing research cadence while the task is live
// and shows it, so the founder sees the agent read files, run `git log`, search the web, and reason
// — as it happens. The BOUND lives in the runner (a few dozen lines / a few KB), so no matter how
// much the child emits, this reads a small string every few seconds. When the task finishes the
// tail is replaced by the full findings (or the error) — the sidecar is gone by then, by design.
import { useCallback, useEffect, useRef, useState } from "react";
import { C } from "../theme/colors";
import { FONT_MONO, TYPE } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import { StatusDot } from "./StatusDot";
import { useRowClock, formatElapsed } from "./rowClock";
import { paneVisibilityStyle } from "./paneVisibility";
import {
  agentStatusForResearch,
  researchStatusLabel,
  researchTierLabel,
  spanOf,
} from "./ConciergeAgentsRow";
import {
  cancelResearch,
  getResearchTail,
  RESEARCH_POLL_INTERVAL_MS,
  useResearchStore,
} from "../services/research/store";
import { closeResearchPane } from "../services/research/selection";
import { isLive, type ResearchTask } from "../services/research/types";

/**
 * The main-pane view for whichever research task the founder has open (`openTaskId`). Mounted only
 * when `activeSpecial === "research"`; `visible` follows that so the pane hides without collapsing
 * its box, exactly as the agent/Sparkle panes do (see paneVisibility).
 */
export function ConciergeResearchPane({ visible }: { visible: boolean }) {
  const openTaskId = useResearchStore((s) => s.openTaskId);
  // Read the live task off the store so status/findings follow the 5s poll. `undefined` when the id
  // names no task this window knows (a task reaped from disk) — handled below.
  const task = useResearchStore((s) => (openTaskId ? s.byId[openTaskId] : undefined));

  // THE TASK IS GONE — close the pane so `activeSpecial` does not stick on "research" with nothing
  // to show. Only fires when the id resolves to nothing at all; a task that merely retired (its row
  // torn down) still has a readable record and keeps showing its findings.
  useEffect(() => {
    if (visible && openTaskId !== null && task === undefined) closeResearchPane();
  }, [visible, openTaskId, task]);

  if (!task) {
    // Nothing to render (no open task, or it is gone). The box still occupies the stage so the
    // reveal/hide transition matches the other panes.
    return (
      <div
        data-testid="concierge-research-pane"
        style={{ position: "absolute", inset: 0, ...paneVisibilityStyle(visible), background: C.forest }}
      />
    );
  }
  return <ResearchView task={task} visible={visible} />;
}

function ResearchView({ task, visible }: { task: ResearchTask; visible: boolean }) {
  const { since, until } = spanOf(task);
  // Ticks only while live — a finished task registers no timer.
  const clockNow = useRowClock(until === null ? since : undefined);
  const live = isLive(task);
  const elapsed = formatElapsed(Math.max(0, (until ?? clockNow) - since));

  const [cancelling, setCancelling] = useState(false);
  const onCancel = useCallback(async () => {
    setCancelling(true);
    try {
      // THE KILL. The founder chose no cap on concurrent research, so "visible and killable" is the
      // whole guardrail — this is the killable half, kept here because this pane is now the surface
      // that shows the task.
      useResearchStore.getState().upsert(await cancelResearch(task.id));
    } finally {
      setCancelling(false);
    }
  }, [task.id]);

  // ── POLL THE LIVE TAIL WHILE THE TASK RUNS ──────────────────────────────────────────────────
  // Reuses the research cadence rather than opening a new channel (the founder's "don't let it
  // become a big problem"): one small read every RESEARCH_POLL_INTERVAL_MS, only while this pane is
  // visible AND the task is live. When the task goes terminal this effect's deps change, the timer
  // is torn down, and the render below switches from tail to findings/error.
  const [tail, setTail] = useState("");
  useEffect(() => {
    if (!visible || !live) return;
    let cancelled = false;
    const pull = () => {
      void getResearchTail(task.id)
        .then((t) => {
          if (!cancelled) setTail(t);
        })
        .catch(() => {});
    };
    pull();
    const timer = setInterval(pull, RESEARCH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, live, task.id]);

  // Keep the newest output in view as the tail grows (best-effort; jsdom has no layout).
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  const st = agentStatusForResearch(task.status);

  return (
    <div
      data-testid="concierge-research-pane"
      style={{
        position: "absolute",
        inset: 0,
        ...paneVisibilityStyle(visible),
        flexDirection: "column",
        background: C.forest,
        color: C.cream,
      }}
    >
      {/* ── WHAT WAS SENT ─────────────────────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "16px 18px",
          borderBottom: `1px solid ${C.deepForest}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusDot status={st} size={9} label={researchStatusLabel(task.status)} />
          <span style={SECTION_LABEL}>Research agent</span>
        </div>
        {/* The question, verbatim — this is "what was sent" to the research child. */}
        <div
          data-testid="concierge-research-question"
          style={{ fontSize: TYPE.body, lineHeight: 1.45 }}
        >
          {task.question}
        </div>
        {/* Status · tier · elapsed · Cancel — the strip the inline detail used to carry, now here. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            color: C.muted,
            fontFamily: FONT_MONO,
            fontSize: TYPE.micro,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span data-testid="concierge-research-status">{researchStatusLabel(task.status)}</span>
          {/* The tier — the founder's "which model", named by the stable `depth` field. */}
          <span data-testid="concierge-agent-tier">{researchTierLabel(task.depth)}</span>
          <span data-testid="concierge-research-elapsed">{elapsed}</span>
          {live && (
            <button
              onClick={() => void onCancel()}
              disabled={cancelling}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: C.accentInk,
                cursor: cancelling ? "default" : "pointer",
                textDecoration: "underline",
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* ── WHAT IS HAPPENING ─────────────────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {live ? (
          <>
            <div style={{ ...SECTION_LABEL, flex: "0 0 auto", padding: "10px 18px 4px" }}>
              Live output
            </div>
            <div
              ref={tailRef}
              data-testid="concierge-research-tail"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                padding: "0 18px 16px",
                fontFamily: FONT_MONO,
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                color: C.cream,
              }}
            >
              {tail.trim().length > 0 ? (
                tail
              ) : (
                <span style={{ color: C.muted }}>
                  Waiting for the research agent's first output…
                </span>
              )}
            </div>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "14px 18px 18px",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {/* IN FULL, never clipped — types.ts records the same rule on the write side: "a clipped
                finding is a confidently-wrong answer, strictly worse than a long one the reader can
                scroll." */}
            {task.findings !== null && (
              <div data-testid="concierge-agent-findings" style={{ whiteSpace: "pre-wrap" }}>
                {task.findings}
              </div>
            )}
            {task.error !== null && (
              <div data-testid="concierge-agent-error" style={{ color: C.sienna, whiteSpace: "pre-wrap" }}>
                {task.error}
              </div>
            )}
            {task.findings === null && task.error === null && (
              <div style={{ color: C.muted }}>
                {task.status === "cancelled"
                  ? "This research task was cancelled."
                  : "This research task finished without producing any findings."}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
