// agentNotices — ONE list of what an agent is currently complaining about, and the ONE place that
// decides how much of it a ROW is allowed to say.
//
// ══ THE BUG THIS EXISTS FOR (bead sparkle-tyter) ════════════════════════════════════════════════
// The sidebar row rendered its notices as PROSE — `thrashChipEl` shipped the literal words "Rate
// limited" / "Looping" / "No progress" / "Context exhausted" into a flex row that also had to hold
// the agent's NAME. It did so with `flex: "0 0 auto"` and `whiteSpace: "nowrap"`, i.e. "I will not
// give up a single pixel", while the name beside it was `flex: 1; minWidth: 0`, i.e. "take
// everything from me first". Flexbox resolved that exactly as written: at the real column width the
// name was shrunk to ZERO and disappeared, leaving the notice sitting flush against the stage chip
// that follows it. That is the founder's screenshot, character for character —
//
//     "Rate limitedShipped"   "Rate limitedUnsaved"   "Rate limitedSaved"   "Looping Shipped"
//
// — eight rows on which the agent's name was ENTIRELY ABSENT. Nothing was painted over anything;
// there is no absolute positioning involved. A zero-width name and a nowrap notice are simply
// adjacent, and the reading collides. It is a correctness failure, not a density complaint: a fleet
// list whose rows cannot say which agent they belong to has stopped being a list of agents.
//
// ══ THE RULE, and why it lives in a module and not in the row ═══════════════════════════════════
// A row may render a GLYPH. It may never render a notice's WORDS. The words are real and worth
// reading — they just belong somewhere with room for them, which is the pills above the composer
// (Concierge/MountedAgentNotices) and the glyph's own hover.
//
// Putting that split in a module rather than in AgentSidebar.tsx is the load-bearing part. There are
// now three surfaces reading the same facts — the row glyph, the composer pill, and the hover — and
// the previous shape had each of them re-deriving wording from the engine verdicts on its own. That
// is precisely the drift engine/workerRollup.ts warns about TWICE in its header, and it has already
// cost this repo two taxonomy splits (see the `blocked` / `unmerged` notes in packages/ui/tokens.ts).
// One producer, three renderers.
//
// ══ NO NEW VERDICTS ════════════════════════════════════════════════════════════════════════════
// Nothing here decides whether an agent is stalled, thrashing or rate limited. engine/agentStall,
// engine/agentThrash and stores/inboxStore already do, they are tested, and this module is a pure
// re-presentation of their output. If you find yourself adding a threshold or a clock here, it
// belongs in the engine instead.
//
// ══ EXTENDING IT (read this before adding a state) ══════════════════════════════════════════════
// `NoticeClass` is the axis the ROW renders, and it is deliberately tiny — the founder's complaint
// was that he "can't read all of these inline notices", so a class per verdict would rebuild the
// same wall of signal in icon form. Add a class only when the new state is a genuinely different
// KIND of thing to do about it, not merely a different cause.
//
// The known incoming one is bead sparkle-345q5, "Questions": an agent in plan mode interviewing the
// founder. That IS a distinct class — it is the good state, and the founder was explicit that it
// must not be red ("I wouldn't want it to be red. Maybe it should be blue.") — so it lands here as
// `"question"` with its own glyph and its own ink, NOT as another `"warning"`. Its verdicts come
// from that bead's own engine work; this module only needs the class, the glyph and the ordering.
import type { StallCause, StallReport } from "../engine/agentStall";
import type { ThrashReport } from "../engine/agentThrash";
import { STALL_CAUSE_LABEL, THRASH_VERDICT_LABEL } from "./rowAttention";
import type { GoalBadge } from "./rowAttention";

/**
 * WHAT KIND of thing this is, from the reader's point of view — the only axis a row renders.
 *
 * Two today. `"warning"` is "something is wrong or outstanding here"; `"message"` is "somebody has
 * queued words for this agent". They are separate because the ACTION differs: one you investigate,
 * the other you read. See the header for why this union stays short, and for the `"question"` class
 * bead sparkle-345q5 is bringing.
 */
export type NoticeClass = "warning" | "message" | "goal";

/**
 * Which mark stands for a class on the row.
 *
 * The founder named two of these himself — *"just show me the exclamation point icon or the the
 * little mailbox icon"* — and they map 1:1 onto the two classes above. `"escalated"` is not a third
 * class; it is the `"warning"` class at its loudest, split out because auto-continue giving up on an
 * agent is categorically different from an agent merely owing work (see `StallChip.escalated`), and
 * a reader scanning forty rows needs that one to be distinguishable at a glance.
 *
 * NAMES, not components. This module is pure and testable without a DOM; the renderers own the
 * react-icons mapping. (Icons, never emoji — this repo's rule.)
 */
export type NoticeGlyph = "alert" | "escalated" | "inbox" | "target" | "clock" | "check";

/** One thing an agent is currently saying, in every register a surface might need. */
export interface AgentNotice {
  /** Stable identity — `"thrash:quota-blocked"`, `"stall:open-pr"`, `"inbox"`. Used as a React key
   *  and as the test handle, so it must not be derived from the (translatable) label. */
  id: string;
  cls: NoticeClass;
  glyph: NoticeGlyph;
  /** THE WORDS. "Rate limited", "PR unmerged", "2 queued messages".
   *
   *  A ROW MUST NEVER RENDER THIS — that is the whole point of the module; see the header. It is the
   *  pill's visible text and part of the row glyph's tooltip, both of which have room for it. */
  label: string;
  /** The engine's full sentence, when that engine produces one. The pill's tooltip. */
  detail?: string;
}

/**
 * WHAT THE WORD MEANS, in plain English, for someone who does not work on this app.
 *
 * ══ WHY THIS EXISTS ═══════════════════════════════════════════════════════════════════════════
 * The founder's own words, and they are the sharpest thing said about this feature: *"I don't
 * really understand what rate limited means or what Looping means so there's no reason to tell me
 * if you're not gonna execute, explain it to me in some place, or let me do something about it."*
 *
 * He is right, and it condemns the shape this module started with. "Looping" is not an explanation;
 * it is a label produced by `engine/agentThrash` for a condition with a specific cause, a specific
 * duration and a specific thing you can do next, none of which the word carries. A row that shows
 * the word and stops has spent the reader's attention to tell them nothing they can act on. So
 * every notice owes two things beyond its label: what actually happened, and a way to act.
 *
 * ══ WHAT IS DELIBERATELY NOT HERE ═════════════════════════════════════════════════════════════
 * No per-notice deep actions ("Switch model", "Open the PR"). Those buttons would each need a real
 * handler, and this app's own rule is that an affordance with nothing behind it is worse than no
 * affordance — a dead button teaches the founder to stop trusting the surface, which is the exact
 * failure the notices themselves are recovering from. The universal action ("Ask about this",
 * which seeds the composer with the agent and the notice) works for every one of these TODAY and
 * is the one he proposed himself. Per-notice actions are a follow-up, added one at a time as each
 * gets a handler that actually runs.
 *
 * Keyed by `AgentNotice.id`, so a notice with no entry simply shows its label and its engine
 * `detail` — never a fabricated explanation.
 */
export const NOTICE_EXPLAINER: Record<string, string> = {
  // ── Thrash: the agent is running, and getting nowhere ────────────────────────────────────────
  // NO PROMISE OF A SELF-RESTART (roborev 58721). The only auto-resume path is
  // `engine/goalContinuation.decideContinuation`, which returns `{action:"none"}` before it reaches
  // the quota arm unless the agent has an OUTSTANDING goal auto-continue is still driving — so the
  // common case (no goal) is released into idle and sits there, which is the incident recorded in
  // `quotaBlock.ts`'s own header. `agentStall.quotaBlockedDetail` already says this surface "must
  // never promise that resuming would fix it"; this copy is held to the same rule.
  "thrash:quota-blocked":
    "This agent has hit Claude's usage limit and cannot make model calls right now. It is not " +
    "broken and it has not lost its work. Unless it has an outstanding goal that auto-continue is " +
    "still driving, it will NOT pick itself back up when the limit resets — it needs a nudge from " +
    "you. Give it a different model if you want it moving before then.",
  "thrash:repeating-command":
    "This agent has run the same command over and over without the result changing. That usually " +
    "means it is stuck on something it cannot see — a failing test it keeps re-running, or a file " +
    "it expects to exist. It will keep going until something changes, so it is worth interrupting.",
  "thrash:no-progress":
    "This agent has taken several turns in a row without using a single tool — no files read, " +
    "nothing run. It is talking rather than working, which usually means it is waiting on a " +
    "decision it never asked you for out loud.",
  "thrash:context-pressure":
    "This agent's conversation has filled up and been compacted more than once in a short window. " +
    "Each compaction throws away detail, so it is now working from a summary of a summary and its " +
    "answers will drift. Better to hand the remaining work to a fresh agent than to push on.",

  // ── Stall: the agent has stopped, and something is still owed ────────────────────────────────
  "stall:escalated-goal":
    "Auto-continue has given up on this agent's goal and handed it back to you. Nothing is coming " +
    "for it — no retry is scheduled and no other agent is watching it. If it is still worth doing, " +
    "it needs you to say so.",
  "stall:expired-goal":
    "The time budget for this agent's goal ran out before the goal was met. The work is unfinished; " +
    "only the window auto-continue was allowed to spend on it has closed.",
  "stall:unmet-goal":
    "This agent has stopped while its stated goal is still unmet — it is idle, and the thing it " +
    "said it was going to finish has not been finished.",
  "stall:open-pr":
    "This agent's pull request is open and has not been merged. The work is written and pushed; it " +
    "is waiting on a review or a merge, which is a decision rather than more building.",
  "stall:unlanded-work":
    "This agent has commits on its branch that never reached main. The work exists and is safe in " +
    "git, but nobody else's copy has it yet.",
  "stall:uncommitted-changes":
    "This agent has edits in its working tree that are not committed to anything. This is the one " +
    "state where closing the agent loses work, so it is worth a look even when nothing else is.",

  // ── Messages ─────────────────────────────────────────────────────────────────────────────────
  // ── Goal: what the blue target and the red octagon on the row actually MEAN ──────────────────
  //
  // ══ WHY THESE EXIST (bead sparkle-tyter, the founder's second scope addition) ═════════════════
  // *"When I click, for example, on screenshot and upload split, there is a blue target and I don't
  // know what that blue target is. When I click on the blue target it doesn't do anything. […]
  // There's another one as well, which is an octagonal red exclamation point. Again I really don't
  // know what's going on."*
  //
  // The goal chip was built as a MARK, not a control, on the premise that its words stay recoverable
  // through the hover title, the accessible name and the detail card. That premise failed in
  // practice for the person it was built for: a sighted mouse user went straight for a click, got
  // silence, and could not recover the meaning at all. Hover is not discoverable, and an a11y name
  // is not a channel he is using. So the words get the one route he actually took — a click.
  "goal:unmet":
    "This agent has a goal it has not reached yet, and the blue target is that goal still being " +
    "aimed at. Nothing is wrong: auto-continue is still driving it, so the agent picks itself back " +
    "up at each turn boundary until the goal is met or its mandate runs out.",
  "goal:met":
    "This agent reached the goal it was given and said so itself. The green check is the agent's " +
    "own report, not a guess from its output — so this row is genuinely finished with what it was " +
    "asked for, and anything further is new work.",
  "goal:expired":
    "This agent's goal ran out of time before it was met. Auto-continue stops driving an expired " +
    "goal, so nothing is coming to finish it: the work is unfinished and waiting on you to either " +
    "re-state the goal or take the remainder somewhere else.",
  "goal:escalated":
    "Auto-continue GAVE UP on this agent and handed it back to you — that is what the red octagon " +
    "means. It retried, hit its ceiling, and stopped rather than looping forever. Nothing further " +
    "will happen on its own; the agent needs a person to look at why it could not finish.",

  inbox:
    "The concierge has queued instructions for this agent that it has not picked up yet. Messages " +
    "are handed over at the agent's next turn boundary rather than interrupting it mid-tool, so a " +
    "queued message is the system working normally — not a delivery that failed.",
};

/** Warning-class ordering: worst first, so a row's single glyph and a pill row's first pill both
 *  lead with the thing most worth doing something about. `escalated-goal` heads it because nothing
 *  is coming for that agent at all — auto-continue has handed it back to the human. */
const STALL_CAUSE_RANK: Record<StallCause, number> = {
  "escalated-goal": 0,
  "expired-goal": 1,
  "unmet-goal": 2,
  "open-pr": 3,
  "unlanded-work": 4,
  "uncommitted-changes": 5,
};

// NO THRASH RANK HERE, deliberately (roborev 58710/58721). A `ThrashReport` carries exactly ONE
// verdict, so `agentNotices` can only ever emit one thrash notice and there is nothing to order.
// The constant that used to sit here was dead code asserting an ordering nothing enforced — and it
// failed `@typescript-eslint/no-unused-vars`, which is an ERROR in eslint.config.base.mjs. If thrash
// ever reports more than one verdict at a time, the rank belongs here and must be USED by
// `rowGlyphsFor`'s loudest-wins tie-break, not merely declared beside it.

/**
 * THE SAME FACT, SAID BY TWO ENGINES — goal state ↔ stall cause.
 *
 * `agentStall` raises `unmet-goal` / `expired-goal` / `escalated-goal` for any quiet agent carrying
 * a goal, and the goal badge describes the identical condition. Emitting both would put one fact in
 * front of the founder twice in two vocabularies, so the stall wording wins (it names the
 * consequence — "auto-continue gave up" — rather than the state).
 *
 * PARTIAL, and `met` is absent rather than mapped to something harmless (roborev 59236): a met goal
 * is not outstanding, so no stall cause can pre-empt it, and `undefined` says that directly. The
 * previous shape pointed `met` at `escalated-goal` behind a guard that made the entry unreachable —
 * dead data whose comment asserted an invariant nothing checked, and a trap if the guard ever moved.
 *
 * EXPORTED because the suppression is only half the contract. The row's goal chip asks for
 * `goal:<state>`; when that pill was suppressed the request matched nothing and the click did
 * NOTHING — the exact bug this feature exists to fix, reproduced on every resting row. See
 * {@link resolveNoticeId}.
 */
export const GOAL_STALL_ALIAS: Partial<Record<GoalBadge["state"], StallCause>> = {
  escalated: "escalated-goal",
  expired: "expired-goal",
  unmet: "unmet-goal",
};

/**
 * The id of the pill that ACTUALLY carries the fact behind `requestedId`, or `null` if none does.
 *
 * ══ WHY THIS EXISTS (roborev 59236, a High) ═══════════════════════════════════════════════════
 * The sidebar's goal chip focuses `goal:<state>`, but `agentNotices` suppresses that notice whenever
 * the equivalent stall cause is present — which is EVERY resting goal-bearing row, including the
 * escalated one the founder photographed, since an escalated agent is by definition idle. The
 * composer's pill row does nothing with a focus request it has no pill for, so the click mounted the
 * agent and produced no explanation at all: the "I click the blue target and nothing happens" bug,
 * still there, in the commit written to fix it. It only appeared to work on a `working` agent, which
 * was the single case the first test seeded.
 *
 * Resolving through the alias keeps ONE pill per fact and still lets either name reach it.
 */
export function resolveNoticeId(
  requestedId: string | null,
  notices: readonly AgentNotice[],
): string | null {
  if (requestedId === null) return null;
  const has = (id: string) => notices.some((n) => n.id === id);
  if (has(requestedId)) return requestedId;
  // goal:<state> → stall:<cause>, the suppression direction.
  const state = requestedId.startsWith("goal:") ? requestedId.slice("goal:".length) : null;
  if (state !== null) {
    const cause = GOAL_STALL_ALIAS[state as GoalBadge["state"]];
    if (cause !== undefined && has(`stall:${cause}`)) return `stall:${cause}`;
  }
  // …and back the other way, so a stall-named request still lands if only the goal pill survives.
  const cause = requestedId.startsWith("stall:") ? requestedId.slice("stall:".length) : null;
  if (cause !== null) {
    for (const [st, c] of Object.entries(GOAL_STALL_ALIAS)) {
      if (c === cause && has(`goal:${st}`)) return `goal:${st}`;
    }
  }
  return null;
}

/** The row's goal glyphs, by state — the same four `AgentSidebar.GOAL_CHIP_ICON` draws, named here
 *  so the pill and the chip cannot show different marks for one state. */
const GOAL_GLYPH: Record<GoalBadge["state"], NoticeGlyph> = {
  escalated: "escalated",
  expired: "clock",
  unmet: "target",
  met: "check",
};

/** The pill's visible words for each goal state. PLAIN, not the engine's token: "escalated" is the
 *  word the founder could not act on, and "auto-continue gave up" is the same fact said usefully. */
const GOAL_NOTICE_LABEL: Record<GoalBadge["state"], string> = {
  escalated: "Auto-continue gave up",
  expired: "Goal expired, never met",
  unmet: "Goal not met yet",
  met: "Goal met",
};

/** Everything a surface needs to gather. Every field optional and every one meaning "not looked
 *  up" when absent — the `undefined`-is-a-value discipline rowAttention.ts is built on. A missing
 *  input produces NO notice, never a reassuring one. */
export interface NoticeInputs {
  /** `engine/agentThrash.thrashReportFor(...)`. `undefined` = never observed, which is not health. */
  thrash?: ThrashReport | undefined;
  /** `engine/agentStall.stallReport(...)`, already gated by `isStalled` at the call site — pass
   *  `undefined`/a non-stalled report and no stall notices are produced. */
  stall?: StallReport | undefined;
  /** `stores/inboxStore.pendingCount(...)`. Pending only; a delivered message is not a notice. */
  pendingInbox?: number | undefined;
  /**
   * `components/rowAttention.goalBadgeFor(...)`. `undefined`/`null` = this agent has no goal, which
   * is not a notice.
   *
   * PRESENT ONLY WHERE THE GOAL CHIP IS NOT ALREADY THE MARK. The sidebar row draws the goal itself
   * (`GOAL_CHIP_ICON`), so it passes this and the row simply does not draw a `goal`-class mark — the
   * same split `pendingInbox` has with `AgentInboxBadge`. The composer's pill row has no such
   * duplicate, so for it this is the only place the goal's words appear.
   */
  goal?: GoalBadge | null | undefined;
}

/**
 * Every notice for one agent, worst-first within class, warnings before messages.
 *
 * PURE. No stores, no clock, no DOM — the caller has already asked the engines. That is what lets
 * the row (which holds these facts as props for memoization reasons) and the composer (which reads
 * them from stores) go through one function instead of two copies of the taxonomy.
 */
/** Which goal state, if any, this stall cause is the engine's word for — the alias read backwards,
 *  and only when the agent actually carries a goal in that state. */
function goalStateForCause(
  cause: StallCause,
  goal: GoalBadge | null | undefined,
): GoalBadge["state"] | null {
  if (goal == null) return null;
  return GOAL_STALL_ALIAS[goal.state] === cause ? goal.state : null;
}

export function agentNotices(input: NoticeInputs): AgentNotice[] {
  const out: AgentNotice[] = [];

  // ── WARNINGS ────────────────────────────────────────────────────────────────────────────────
  // Thrash first: it describes an agent that is BURNING TIME right now, whereas a stall cause
  // describes work merely left owing. Both are amber; the ordering decides which glyph a
  // single-glyph row shows.
  const thrash = input.thrash;
  if (thrash !== undefined && thrash.verdict !== "healthy") {
    out.push({
      id: `thrash:${thrash.verdict}`,
      cls: "warning",
      glyph: "alert",
      label: THRASH_VERDICT_LABEL[thrash.verdict],
      detail: thrash.detail,
    });
  }

  const stall = input.stall;
  if (stall !== undefined && stall.verdict === "stalled") {
    // EVERY cause becomes a pill, not just the head. The row only ever showed the first one and
    // hung a "+N" off it, because a row has space for one phrase — the composer does not have that
    // constraint, and "+2" is exactly the reading the founder cannot act on.
    const causes = [...stall.causes].sort(
      (a, b) => STALL_CAUSE_RANK[a] - STALL_CAUSE_RANK[b],
    );
    for (const cause of causes) {
      // ── THE MARK HE CLICKED MUST BE THE MARK HE LANDS ON (roborev 59253) ────────────────────
      // Three stall causes ARE the goal, said in the engine's vocabulary, and the goal notice is
      // suppressed in their favour below. So a click on the blue target resolves to `stall:unmet-goal`
      // — and that pill wore an amber warning triangle, which is neither the shape nor the colour of
      // the thing he clicked. The pill takes the GOAL's glyph whenever it is standing in for one,
      // which is the glyph-parity invariant both files already state, now actually held across the
      // alias. The LABEL stays the stall's: "PR unmerged"-style wording names the consequence, and
      // that is why the stall pre-empts in the first place.
      const goalStanding = goalStateForCause(cause, input.goal);
      out.push({
        id: `stall:${cause}`,
        cls: "warning",
        glyph:
          goalStanding !== null
            ? GOAL_GLYPH[goalStanding]
            : cause === "escalated-goal"
              ? "escalated"
              : "alert",
        label: STALL_CAUSE_LABEL[cause],
        // ONE detail sentence per report, attached to each of its causes. The engine writes a
        // single sentence covering the verdict rather than one per cause; repeating it is honest
        // (it does describe this cause) and beats leaving most pills with no tooltip at all.
        //
        // …plus the GOAL'S OWN WORDS when this pill is standing in for the goal notice (roborev
        // 59253). "land the retry PR" is the one thing no explainer can supply and the only part
        // that is about THIS agent; suppressing the goal pill must not take it with it.
        detail:
          goalStanding !== null && input.goal != null
            ? `${stall.detail}\n\nGoal: ${input.goal.text}`
            : stall.detail,
      });
    }
  }

  // ── GOAL ────────────────────────────────────────────────────────────────────────────────────
  // After the warnings, before the messages: a goal is a statement about what this agent is FOR,
  // which is context for the warnings above rather than a competitor to them.
  //
  // SUPPRESSED WHEN THE STALL ALREADY SAID IT. `escalated-goal`, `expired-goal` and `unmet-goal` are
  // stall causes in their own right, so a stalled agent would otherwise get two pills carrying one
  // fact in two vocabularies — exactly the taxonomy drift this module exists to prevent. The stall
  // wording wins because it names the consequence ("auto-continue gave up") rather than the state.
  const goal = input.goal;
  if (goal !== undefined && goal !== null) {
    const cause = GOAL_STALL_ALIAS[goal.state];
    const preempted = cause !== undefined && out.some((n) => n.id === `stall:${cause}`);
    if (!preempted) {
      out.push({
        id: `goal:${goal.state}`,
        cls: "goal",
        glyph: GOAL_GLYPH[goal.state],
        label: GOAL_NOTICE_LABEL[goal.state],
        // The goal's OWN WORDS, which no explainer can supply — "land the retry PR" is the whole
        // point of the mark, and the generic paragraph above it explains what the state means.
        detail: goal.text,
      });
    }
  }

  // ── MESSAGES ────────────────────────────────────────────────────────────────────────────────
  // Last, always. A queued instruction is the system working as designed; it must not lead a row
  // on which something is actually wrong.
  const pending = input.pendingInbox ?? 0;
  if (pending > 0) {
    out.push({
      id: "inbox",
      cls: "message",
      glyph: "inbox",
      label: pending === 1 ? "1 queued message" : `${pending} queued messages`,
      detail: "Queued by the concierge · delivered at this agent's next turn boundary",
    });
  }

  return out;
}

/** Sort key for the two classes — warnings ahead of messages, matching `agentNotices`' own order.
 *  Stated once so a renderer that re-sorts (the pill row groups by class) cannot invent a
 *  different priority from the row's. */
const CLASS_RANK: Record<NoticeClass, number> = { warning: 0, goal: 1, message: 2 };

/**
 * What the ROW draws: AT MOST ONE MARK PER CLASS, carrying no words at all.
 *
 * The collapse is the feature, not a shortcut. A row bearing three stall causes and a thrash
 * verdict would otherwise wear four exclamation marks — which rebuilds, in glyph form, the exact
 * wall of signal the founder asked to be rid of. One mark says "this agent has warnings"; `count`
 * says how many; the tooltip lists them; the pills above the composer spell them out.
 *
 * `glyph` takes the LOUDEST in the class (escalated beats alert), so an agent auto-continue has
 * given up on is never hidden behind a milder sibling that happened to sort first.
 */
export interface RowGlyphMark {
  cls: NoticeClass;
  glyph: NoticeGlyph;
  /** How many notices of this class the agent has. `1` is the common case. */
  count: number;
  /** The `AgentNotice.id` this mark stands for — the LOUDEST in its class, the same one that chose
   *  `glyph`.
   *
   *  This is what makes the row mark clickable in a useful way. Clicking it mounts the agent and
   *  expands THIS pill above the composer, which is the founder's own worked example: *"If I were
   *  to click on the mailbox icon on the row then the mailbox could expand on the mounted concierge
   *  and then could show me the actual queued messages."* Without it the click could only say
   *  "something in this class" and the composer would have to guess which pill he meant. */
  leadNoticeId: string;
  /** Every label in the class, newline-joined — the hover reading, which is the founder's
   *  "hover or click reveals the same detail WITHOUT mounting". */
  title: string;
  /** Spoken name. Colour and shape are not accessible channels, and these marks have, by
   *  construction, no visible text to fall back on. */
  ariaLabel: string;
}

/**
 * THE WHOLE ACCESSIBLE NAME for a class's mark, built from the number of notices in it and their
 * labels. These marks have, by construction, no visible text — so this string is the only reading
 * path a screen-reader user has, and the two classes need genuinely different shapes.
 *
 * `warning` prefixes a count, because "1 warning" / "3 warnings" is the one thing the glyph cannot
 * say and the labels ("PR unmerged", "Looping") do not carry.
 *
 * `message` does NOT, and that is the fix for roborev 58710/58721 rather than a style choice. The
 * inbox notice's own label already reads "3 queued messages" — there is exactly ONE message notice
 * ever, carrying the count inside it — so prefixing the class count produced the wrong number
 * attached to a restatement: `"1 queued message: 3 queued messages"`. Its label IS its name.
 */
const CLASS_A11Y: Record<NoticeClass, (n: number, labels: string) => string> = {
  warning: (n, labels) => `${n === 1 ? "1 warning" : `${n} warnings`}: ${labels}`,
  message: (_n, labels) => labels,
  // Like `message`: the goal label already names itself ("Auto-continue gave up"), so a "1 goal:"
  // prefix would only stutter. There is at most one goal notice per agent by construction.
  goal: (_n, labels) => labels,
};

/** Loudest-wins within a class. Only `warning` has two glyphs today. */
const GLYPH_RANK: Record<NoticeGlyph, number> = {
  escalated: 0,
  alert: 1,
  clock: 2,
  target: 3,
  check: 4,
  inbox: 5,
};

/**
 * Collapse a notice list into the marks a row may render.
 *
 * Returns `[]` for an agent with nothing to say — a row with no notice renders exactly as it always
 * did, which is the half of the column that was never broken.
 */
export function rowGlyphsFor(notices: readonly AgentNotice[]): RowGlyphMark[] {
  const byClass = new Map<NoticeClass, AgentNotice[]>();
  for (const n of notices) {
    const bucket = byClass.get(n.cls);
    if (bucket === undefined) byClass.set(n.cls, [n]);
    else bucket.push(n);
  }
  return [...byClass.entries()]
    .sort(([a], [b]) => CLASS_RANK[a] - CLASS_RANK[b])
    .map(([cls, group]) => {
      // Non-null: a bucket only exists because something was pushed into it.
      const loudest = [...group].sort((a, b) => GLYPH_RANK[a.glyph] - GLYPH_RANK[b.glyph])[0]!;
      // NO STUTTER (roborev 58710/58721) — each class owns its WHOLE accessible name, because the
      // message class's label already carries its own count and prefixing another one produced
      // "1 queued message: 3 queued messages". See CLASS_A11Y.
      const labels = group.map((n) => n.label).join(", ");
      return {
        cls,
        glyph: loudest.glyph,
        leadNoticeId: loudest.id,
        count: group.length,
        title: group.map((n) => n.label).join("\n"),
        ariaLabel: CLASS_A11Y[cls](group.length, labels),
      };
    });
}
