// The mounted agent's notices, as PILLS above the composer — where the words live now.
//
// ══ THE ASK (bead sparkle-tyter, and he made it twice) ═══════════════════════════════════════════
// *"I had asked you to just show me the exclamation point icon or the the little mailbox icon. And
// then when I click on the agent to mount the concierge, I get pills on top of the composed window
// that tell me any notices or warnings."*
//
// The sidebar row half of that is done: `components/AgentSidebar` now renders one wordless mark per
// notice class, because rendering the WORDS there was squeezing the agent's name to zero width and
// eight rows had no name at all. This is the other half — the place the words went.
//
// ══ WHY PILLS AND NOT A SENTENCE ════════════════════════════════════════════════════════════════
// An agent can be several things at once: rate limited AND holding an unmerged PR AND carrying two
// queued messages. Prose would have to rank and join them; pills let each one be its own object
// with its own affordance, which is what makes the next part possible.
//
// ══ EXPANDING IS THE POINT, NOT DECORATION ══════════════════════════════════════════════════════
// *"I don't really understand what rate limited means or what Looping means so there's no reason to
// tell me if you're not gonna execute, explain it to me in some place, or let me do something about
// it."*
//
// He is right, and it is the sharpest thing said about this feature. A label is not an explanation:
// "Looping" is a token `engine/agentThrash` produces for a condition with a cause and a next step,
// and the word carries neither. So a pill EXPANDS IN PLACE to `NOTICE_EXPLAINER` — plain English,
// written for someone who does not work on this app — and the inbox pill expands to the actual
// queued messages, which is his own worked example:
//
//   *"For the mailbox it's pretty obvious. If I were to click on the mailbox icon on the row then
//   the mailbox could expand on the mounted concierge and then could show me the actual queued
//   messages. That would be a pretty easy one for example."*
//
// ══ HALF OF THAT EXAMPLE IS NOT WIRED YET, AND THIS SAYS SO (roborev 58774) ═════════════════════
// The mailbox pill here expands to the queued messages — that part is real. What does NOT work is
// the ROW half of his sentence: the sidebar row deliberately passes no `pendingInbox` into
// `agentNotices` (its mailbox stays `AgentInboxBadge`, which owns its own popover), so no
// `message`-class mark exists there and the two writers of `focusedNoticeBySide` are both warning
// marks. `focusedNoticeBySide` can therefore never hold `"inbox"` today, and clicking the row's
// mailbox opens the popover instead of mounting. Reaching the mailbox PILL means mounting the agent
// and clicking it here. Wiring the badge to mount-and-expand is a real change to an affordance that
// already does something, so it is recorded as outstanding rather than smuggled in — this header
// used to describe the whole example as delivered, which it was not.
//
// ══ WHAT IS DELIBERATELY MISSING, AND WHY IT IS NOT AN OVERSIGHT ════════════════════════════════
// He also asked for an "Ask about this" action that would drop a mentionable pill into the compose
// box so he could just type "why?". It is NOT here yet, and shipping it as a button that did
// nothing would have been worse than omitting it — this app's own rule is that an affordance with
// nothing behind it teaches the user to stop trusting the surface, which is the exact failure the
// notices are recovering from. The obstacle is concrete and worth writing down: `ComposeBox` holds
// its draft in local `useState` (`const [text, setText] = useState("")`), so there is no store or
// handle an outside component can write into. Giving it one is a real change to a 1900-line file
// that four suites cover. Tracked, not forgotten.
//
// ══ THIS COMPONENT READS ITS OWN STORES ═════════════════════════════════════════════════════════
// `ConciergeColumn` is a pure renderer and must stay one, so this follows `AgentInboxBadge`'s shape
// (a component handed an `agentId` that asks the stores itself) rather than adding view-model props.
// Same reason `countdownSlot` is a slot rather than a field.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  FiAlertOctagon,
  FiAlertTriangle,
  FiCheckCircle,
  FiChevronDown,
  FiChevronRight,
  FiClock,
  FiInbox,
  FiTarget,
} from "react-icons/fi";
import type { IconType } from "react-icons";

import {
  agentNotices,
  NOTICE_EXPLAINER,
  resolveNoticeId,
  type AgentNotice,
  type NoticeGlyph,
} from "../agentNotices";
import { isStalled, stallReport } from "../../engine/agentStall";
import { calmStatusOf } from "../../engine/unmergedAttention";
import { resolveStage } from "../../engine/workflowStage";
import { thrashReportFor } from "../../engine/agentThrash";
import { quotaBlockForAgent } from "../../engine/engineRegistry";
import { hasUnmetGoal } from "../../engine/agentGoal";
import { goalBadgeFor, stallInputsFor } from "../rowAttention";
import { awaitingCloseEvidenceFor } from "../../services/agentGoalReading";
import { humanBlockIn } from "../../services/humanBlockFor";
import { useNudgeFlagSnapshot } from "../../useNudgeFlags";
import { pendingCount, useAgentInbox } from "../../stores/inboxStore";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useUiStore } from "../../stores/uiStore";
import { C, FONT_WEIGHT } from "../../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../../theme/scale";
import { DELIVERY_LABEL } from "../inboxCopy";
import type { PairSide } from "../../engine/cable";
import { anyPeer, isPeerSender, peerAttributionLine } from "../../services/peerAttribution";

export const NOTICE_PILL_TESTID = "composer-notice-pill";
export const NOTICE_DETAIL_TESTID = "composer-notice-detail";
export const NOTICE_MESSAGE_TESTID = "composer-notice-message";
export const NOTICE_PEER_TESTID = "composer-notice-peer";
/** The notice's OWN words — this agent's goal text, or the engine's sentence — as opposed to the
 *  generic explainer above it. */
export const NOTICE_OWN_WORDS_TESTID = "composer-notice-own-words";

/** Same marks as the row, so the two surfaces cannot disagree about what a class looks like. */
const GLYPH_ICON: Record<NoticeGlyph, IconType> = {
  alert: FiAlertTriangle,
  escalated: FiAlertOctagon,
  inbox: FiInbox,
  // The three goal marks, matching AgentSidebar's GOAL_CHIP_ICON exactly — the pill has to wear the
  // same glyph the row does, or a founder who clicked a blue target lands on a pill showing
  // something else and has to work out for himself that they are the same thing.
  target: FiTarget,
  clock: FiClock,
  check: FiCheckCircle,
};

/** Goal pills take the row's own goal ink, for the same reason they take its glyph — these are the
 *  exact values in `AgentSidebar.GOAL_CHIP_COLOR`, so the mark he clicked and the pill he lands on
 *  are the same colour as well as the same shape. */
const GOAL_PILL_INK: Partial<Record<NoticeGlyph, string>> = {
  target: C.accentInk,
  clock: C.amberInk,
  check: C.successInk,
};

/** How often the thrash/stall readings are re-sampled.
 *
 *  `thrashReportFor` reads a window-local, NON-REACTIVE registry and both verdicts are functions of
 *  a clock, so nothing re-renders this on its own — a memo would freeze the pills on whatever was
 *  true when the agent was mounted. 5s matches the calm end of the sidebar's own row tick; these
 *  verdicts move on the scale of minutes, so anything faster would just re-render the column. */
const SAMPLE_MS = 5_000;

export function MountedAgentNotices({ agentId, side }: { agentId: string; side: PairSide }) {
  // The clock the two verdicts are asked against. Both readings take the SAME `now`, so one pill row
  // can never describe two different moments.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), SAMPLE_MS);
    return () => clearInterval(t);
  }, []);

  // RAW store values, deliberately. `rowAttention` needs `undefined` to mean "we never looked this
  // up" and returns no claim for it; defaulting any of these to a resolved value would have the
  // pills assert things nobody checked — the failure mode that file exists to prevent.
  const status = useRuntimeStore((s) => s.status[agentId]);
  const bs = useRuntimeStore((s) => s.branchStatus[agentId]);
  const ws = useRuntimeStore((s) => s.workflowState[agentId]);
  const stageOverride = useRuntimeStore((s) => s.workflowStage[agentId]);
  // Subscribed to drive the recompute below, exactly as `AgentRow` does: the merge watermark is what
  // makes `awaiting_close` reachable, and a composer pill that lags the row's chip is the
  // cross-surface divergence every comment in this block is guarding against.
  // ⚠️ OPTIONAL-CHAINED, and not defensively for its own sake. Several suites mock `useRuntimeStore`
  // with a partial state that predates these two maps, so a bare index throws inside the selector and
  // takes the whole component down — 72 tests across four files, none of them about goals. Every
  // other reader of these maps (`landedEvidenceFor`, `shippedAfterGoalSet`) already chains for the
  // same reason: an absent map means "not looked up", which is a real answer here.
  const shipped = useRuntimeStore((s) => s.workflowShipped?.[agentId]);
  const shippedAt = useRuntimeStore((s) => s.workflowShippedAt?.[agentId]);
  const goal = useProjectStore(
    (s) => s.projects.flatMap((p) => p.agents).find((a) => a.id === agentId)?.goal,
  );
  const entries = useAgentInbox(agentId);
  const pending = pendingCount(entries);
  // THE LIST AND THE COUNT MUST ANSWER THE SAME QUESTION (roborev 58774). The pill's label counts
  // `pending` only, but `inbox_peek` deliberately returns delivered and acknowledged entries too —
  // so expanding "1 queued message" was showing three, on the one surface whose entire purpose is
  // letting the founder verify that the concierge really queued what it said it did.
  const pendingEntries = entries.filter((e) => e.state === "pending");

  // ── ASK THE ENGINES ONCE PER READING, NOT ONCE PER RENDER ────────────────────────────────────
  // This row lives inside the concierge column, which re-renders on every streamed delta and every
  // keystroke in the composer — while these two verdicts only change when `now` ticks (5s) or a
  // store value moves. Recomputing `stallReport` + `thrashReportFor` on every frame of a stream is
  // pure waste, and it is measurable: it is what pushed ConciergeHost.liveness's 50-send row over
  // its timeout once this component was mounted in the column. The memo is keyed on every input,
  // so it cannot serve a stale verdict — including `now`, which is what makes a verdict APPEAR.
  // Read as a SNAPSHOT so the memo's dependency on the flag table is one the linter can see and
  // the compiler enforces — a counter nothing read was reported as an "unnecessary dependency"
  // whose suggested removal silently restores the stale reading (roborev 65409).
  const nudgeFlags = useNudgeFlagSnapshot();
  const notices = useMemo(() => {
    const quota = quotaBlockForAgent(agentId, now);
    const thrash = thrashReportFor(agentId, now, {
      goalOutstanding: hasUnmetGoal(goal, now),
      quotaBlock: quota,
    });
  // ── THE SAME STATUS THE ROW ASKED ABOUT (roborev 58774, a High) ──────────────────────────────
  // This read the RAW status and defaulted it to `idle`. Both were wrong, and together they broke
  // the headline gesture: a finished agent holding committed-but-unlanded work is `done` raw, which
  // `agentStall.isQuiet` REJECTS — while the row asks about the calm map, where the same agent is
  // `unmerged`, which it accepts. So the row drew its alert glyph, the click mounted the agent and
  // patched the cable, and this component rendered nothing at all. `calmStatusOf` is the row's own
  // derivation, extracted so the two surfaces cannot answer this differently again; absent defaults
  // to `stopped` like every other reader, so an unobserved agent still makes no claim.
    const calmStatus = calmStatusOf(status, resolveStage(bs, stageOverride));
    const stall = stallReport(
      // `humanBlock` for the same reason `quota` is here: this surface computes its OWN report, so
      // omitting it left the composer's pill row unable to emit `stall:blocked-on-human` — making the
      // explainer copy for it unreachable while the row's dot was red (roborev 65339).
      stallInputsFor(
        calmStatus,
        now,
        goal,
        { bs, ws, stageOverride },
        quota,
        humanBlockIn(nudgeFlags, agentId),
        // …and the third input, so this surface can emit `stall:awaiting-close` at all. Omitting it
        // would leave that pill's explainer copy unreachable while the row's chip already said
        // "done — awaiting your close" — the same unreachable-explainer defect roborev 65339 caught
        // one cause over.
        awaitingCloseEvidenceFor(agentId, goal),
      ),
    );
    // Referenced so the two subscriptions above are not read as unused — they exist to drive this
    // recompute, whose evidence is read from the store rather than passed in.
    // REACTIVITY ANCHORS, not dead code — `awaitingCloseEvidenceFor` reads the watermark from the
    // store rather than taking it as an argument, so these are what put it in this memo's deps.
    void shipped;
    void shippedAt;
    return agentNotices({
      thrash,
      ...(isStalled(stall) ? { stall } : {}),
      pendingInbox: pending,
      // Only PENDING entries: a delivered message is not a notice, so a peer message that has
      // already landed must not keep the header disclaimed.
      pendingInboxHasPeer: anyPeer(entries.filter((e) => e.state === "pending")),
      // THE GOAL, which the ROW does not pass (its own chip is that mark) and this surface must.
      // The founder's second scope addition: clicking the row's blue target or red octagon opens
      // the pill that says what it means, and the pill has to exist for that click to land on.
      // With the evidence, same reason as the stall input above: the composer's goal pill and its
      // stall pill sit in the same row and must not describe the agent differently.
      goal: goalBadgeFor(goal, now, awaitingCloseEvidenceFor(agentId, goal)),
    });
  }, [agentId, now, goal, status, bs, ws, stageOverride, shipped, shippedAt, pending, entries, nudgeFlags]);

  // ── WHICH PILL IS OPEN ───────────────────────────────────────────────────────────────────────
  // One at a time: two open explainers push the composer down twice as far, and the pill row sits
  // directly above the thing the user is trying to type into.
  const [openId, setOpenId] = useState<string | null>(null);
  // A row mark's click names a pill (uiStore.focusedNoticeBySide) — the founder's "click the mailbox
  // on the row, the mailbox expands here". CONSUMED, not merely read: it is cleared the moment it is
  // applied, so a later manual collapse sticks instead of being re-opened on the next render.
  const focused = useUiStore((s) => s.focusedNoticeBySide[side]);
  const setFocusedNotice = useUiStore((s) => s.setFocusedNotice);
  // NOT CONSUMED BY A RENDER WITH NOTHING TO OPEN (roborev 58774). This effect runs before the
  // `notices.length === 0` early return below, so a request that arrived one render ahead of the
  // notice it names — or against a reading that produced none — was cleared and silently dropped,
  // and the click looked like it did nothing. Only a request this render can actually honour is
  // consumed; anything else is left in the store for the render that can.
  // RESOLVED, not matched literally (roborev 59236). The row's goal chip asks for `goal:<state>`,
  // and `agentNotices` suppresses that pill whenever the equivalent stall cause is present — which
  // is every RESTING goal-bearing row, including the escalated one the founder photographed. A
  // literal match therefore found nothing and the click did nothing: the very bug this feature
  // exists to fix, surviving inside its own fix. `resolveNoticeId` follows the goal↔stall alias to
  // whichever pill actually carries the fact, so either name reaches the one explanation.
  const resolvedFocus = resolveNoticeId(focused, notices);
  useEffect(() => {
    if (resolvedFocus === null) return;
    setOpenId(resolvedFocus);
    setFocusedNotice(side, null);
  }, [resolvedFocus, side, setFocusedNotice]);
  // AN OPEN PILL BELONGS TO THE AGENT THAT OPENED IT (roborev 58774). Notice ids are class-level
  // (`stall:open-pr`, `inbox`) rather than agent-scoped, and this component is not keyed by agent —
  // so mounting a different agent on the same side kept the previous one's pill expanded, showing
  // an explainer the user never opened, about an agent they had just switched to.
  //
  // DURING RENDER, not in an effect, and that ordering is the whole point: the focus effect above
  // runs on this same agent change (clicking a row mark BOTH mounts the agent and names a pill), so
  // a reset effect declared after it would fire second and wipe the pill the click just asked for —
  // re-breaking the headline gesture in a way that looks identical to the bug being fixed. React's
  // documented "adjust state when a prop changes" pattern happens before any effect, so the reset
  // lands first and the focus request still wins.
  const lastAgentRef = useRef(agentId);
  if (lastAgentRef.current !== agentId) {
    lastAgentRef.current = agentId;
    if (openId !== null) setOpenId(null);
  }

  // NULL, NOT AN EMPTY STRIP. The compose box auto-grows against the space above it, so a reserved
  // row would take height from the thread for a message that is not there — the same rule
  // `MountedNotice` states for itself one row up.
  if (notices.length === 0) return null;

  return (
    <div
      data-testid="composer-notices"
      role="group"
      aria-label="Notices for the mounted agent"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: 4,
        padding: "0 12px 6px",
      }}
    >
      {notices.map((n) => (
        <NoticePill
          key={n.id}
          notice={n}
          open={openId === n.id}
          onToggle={() => setOpenId((cur) => (cur === n.id ? null : n.id))}
          inbox={n.id === "inbox" ? pendingEntries : undefined}
        />
      ))}
    </div>
  );
}

/** Structure DRAWN, not filled — the direction's rule, and what `MountedNotice` beside this row
 *  already wears. A filled banner would read as a modal interruption over a column that has just
 *  flooded to the terminal plane. */
const pillBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 7px",
  borderRadius: RADIUS.sm,
  fontSize: TYPE.small,
  fontWeight: FONT_WEIGHT.semibold,
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
};

function NoticePill({
  notice,
  open,
  onToggle,
  inbox,
}: {
  notice: AgentNotice;
  open: boolean;
  onToggle: () => void;
  /** Present only on the inbox pill — the queued messages themselves. */
  // `from` is load-bearing, not decoration: it decides whether a queued message is drawn as
  // carrying the concierge's (i.e. the founder's) authority. See `services/peerAttribution.ts`.
  inbox?: readonly { id: string; text: string; state: string; severity: string; from?: string }[];
}) {
  const Glyph = GLYPH_ICON[notice.glyph];
  // THE `escalated → DANGER` SPECIAL CASE IS GONE (2026-08-06, roborev 59969). `escalated-goal`
  // moved to the amber `lapsed` tier, and THIS is the surface that actually renders it: the sidebar
  // strips the notice via `withoutSeparatelyDrawn` whenever a goal badge exists — always, since the
  // cause derives from `goalStateOf` — so the composer pill was the only place the founder ever saw
  // it, and it was painting the one cause that needs NOTHING from him in the alarm colour, text and
  // border both. (The first pass at this fixed the sidebar's unreachable branch and left this one:
  // the ink was corrected on the surface where the notice is invisible.)
  //
  // The octagon SHAPE stays the distinction, exactly as argued for the sidebar mark, and the row's
  // DOT is what carries the red/amber tier.
  const ink = GOAL_PILL_INK[notice.glyph] ?? C.amberInk;
  // ── BOTH, NOT ONE OR THE OTHER (roborev 59253) ───────────────────────────────────────────────
  // This read `NOTICE_EXPLAINER[id] ?? notice.detail`, so the moment a notice HAD an explainer its
  // `detail` became unreachable — and every notice has one. For a goal pill that detail is the
  // goal's own words ("land the retry PR"), which is the only part of the pill that is about THIS
  // agent rather than about the state in general; the model carried it and nothing rendered it. The
  // explainer says what the state MEANS, the detail says what this agent's instance of it IS.
  // Never a fabricated one: a notice with neither simply says less.
  const explainer = NOTICE_EXPLAINER[notice.id];
  const detail = notice.detail;

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0, maxWidth: "100%" }}>
      <button
        type="button"
        data-testid={NOTICE_PILL_TESTID}
        data-notice-id={notice.id}
        data-notice-open={open}
        aria-expanded={open}
        onClick={onToggle}
        style={{ ...pillBase, color: ink, border: `1px solid ${ink}` }}
      >
        <Glyph size={11} style={{ flex: "0 0 auto" }} aria-hidden />
        {/* THE WORDS, at last — this is the surface that has room for them. */}
        <span>{notice.label}</span>
        {open ? <FiChevronDown size={10} aria-hidden /> : <FiChevronRight size={10} aria-hidden />}
      </button>
      {open && (
        <div
          data-testid={NOTICE_DETAIL_TESTID}
          role="region"
          style={{
            marginTop: 4,
            padding: "6px 8px",
            borderRadius: RADIUS.sm,
            border: `1px solid color-mix(in srgb, currentColor 30%, transparent)`,
            color: C.conciergeMuted,
            fontSize: TYPE.small,
            lineHeight: 1.45,
            maxWidth: 420,
          }}
        >
          {explainer !== undefined && <div>{explainer}</div>}
          {detail !== undefined && detail !== explainer && (
            <div
              data-testid={NOTICE_OWN_WORDS_TESTID}
              style={{
                marginTop: explainer !== undefined ? 6 : 0,
                color: C.cream,
                whiteSpace: "pre-wrap",
              }}
            >
              {detail}
            </div>
          )}
          {/* The founder's own easy case: the mailbox expands to what is actually queued, so
              "did the concierge really send it" stops being a thing to take on trust. */}
          {inbox !== undefined && inbox.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              {inbox.map((e) => (
                <div key={e.id} data-testid={NOTICE_MESSAGE_TESTID}>
                  {/* Same rule as the other four renderers: a peer's message says so. This mailbox
                      exists so "did the concierge really send it" stops being taken on trust, which
                      it cannot do while a peer's message is indistinguishable from the concierge's. */}
                  {isPeerSender(e.from) && (
                    <div
                      data-testid={NOTICE_PEER_TESTID}
                      style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: C.muted }}
                    >
                      {peerAttributionLine(e.from)}
                    </div>
                  )}
                  <div style={{ color: C.cream, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {e.text}
                  </div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: C.muted }}>
                    {e.severity === "act" ? "ACT" : "FYI"} ·{" "}
                    {DELIVERY_LABEL[e.state as keyof typeof DELIVERY_LABEL] ?? e.state}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
