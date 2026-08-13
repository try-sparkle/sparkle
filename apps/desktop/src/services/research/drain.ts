// THE TURN-START DRAIN — how a research finding reaches the concierge. Bead `sparkle-s7rfc`.
//
// ══ THE DELIVERY DECISION, AND WHY IT IS NOT A PUSH ═════════════════════════════════════════════
//
// PRD/sparkle/agent-concierge-reporting-channel.md §3.3, approved by the founder 2026-08-06:
// "Every concierge turn drains the queue into its prompt preamble before the founder's message. No
// proactive push, no notification." Completed-and-unclaimed findings are folded into the prompt the
// brain is already being handed, ahead of what the founder said.
//
// The rejected alternative is the one that looks better and is worse: firing a proactive push per
// finding would spend the shared six-an-hour ceiling (`conciergeProactive.PROACTIVE_MAX_PER_HOUR`)
// on routine results, so a genuine blocker at minute 40 gets rate-limited out — rebuilding exactly
// the failure the reporting channel exists to prevent. Worst-case latency here is "until the founder
// next speaks", which is minutes; the cost is zero and it cannot spam.
//
// §3.3's own free improvement is taken: the drain runs at BOTH prompt-building seams — user turns
// (`ConciergeHost.dispatchTurn` over `engine/conciergeSnapshot.buildSnapshot`) and proactive turns
// (`conciergeProactive.buildProactivePrompt`). Both already build their lines through
// `engine/conciergeRosterLine`, so covering the second is one extra call site and strictly reduces
// latency.
//
// ══ THE ONE RULE THAT MATTERS: PEEK MUST NEVER CLAIM ════════════════════════════════════════════
//
// `peek()` builds the preamble and stamps NOTHING. The claim (`settle`) happens only once the turn
// that carried the finding has genuinely delivered — for a user turn, its `concierge:done`.
//
// This is not fastidiousness. The concierge is one `claude -p` per turn and ONE turn process-wide:
// `concierge.rs` installs a new turn and KILLS the child it evicts, and `may_install` /
// `SUPERSEDED_ERR` / `CANCELLED_ERR` exist because that is the ordinary case, not an edge one. A
// turn that is superseded, cancelled, errored, or killed by the app quitting has told the founder
// NOTHING — and a finding claimed when the preamble was built would be gone forever, with no
// residue, no retry and no way for anyone to know it existed. Claiming after delivery makes the
// worst case a REPEAT (the finding is told twice) instead of a LOSS, and a repeat is recoverable
// where a loss is not. That direction is this repo's standing rule for every cap and every queue.
//
// ══ PURE CORE, INJECTED EDGES ══════════════════════════════════════════════════════════════════
//
// The same shape `services/conciergeProactive` uses. `buildResearchPreamble` and
// `withResearchPreamble` are data-in-data-out; the drain takes its clock, its view of the task
// list, the claim itself and the event recorder as dependencies. That is what lets exactly-once —
// and, more importantly, "a dropped turn does not drop the finding" — be tested as arithmetic
// rather than by mounting an app.
import { isNoticePending, isTerminal, type ResearchTask } from "./types";
import { unreadTasks } from "./store";
import type { ConciergeEventPayload } from "../../stores/conciergeEventLog";

// ---------------------------------------------------------------------------------------------
// The preamble — pure
// ---------------------------------------------------------------------------------------------

/**
 * The opening line of the section, exported so a test asserts the shipped string rather than its
 * own copy of it.
 *
 * Written as an INSTRUCTION, for the same reason `PUSHER_NOTICE_PREAMBLE` is: the failure being
 * prevented is a concierge that reads a finding and does nothing with it. The founder asked a
 * question; a task he dispatched came back; the answer is in front of the brain when it replies.
 */
export const RESEARCH_PREAMBLE_HEADER =
  "RESEARCH BACK — research you dispatched has finished since you last spoke, and the founder has " +
  "NOT seen any of it. Use it in what you say next: if it answers what he is asking, answer with " +
  "it rather than saying you looked into it. Oldest first.";

/**
 * Render unread findings into the section that carries them. `""` when there is nothing.
 *
 * THE EMPTY CASE RETURNS AN EMPTY STRING, NOT AN EMPTY HEADER. A "RESEARCH BACK — (none)" line in
 * every prompt is noise the brain has to read past on every single turn, and worse, it teaches it
 * that the section is usually empty — so the one turn that carries something gets skimmed.
 *
 * FINDINGS ARE VERBATIM AND ARE NEVER TRUNCATED, matching `ResearchTask.findings`' own rule: a
 * clipped finding is a confidently-wrong answer, which is strictly worse than a long one. If this
 * ever has to bound its length, it must say what it withheld and how much — a cap without a
 * disclosure is the defect `buildNoticeSection` was rewritten to remove.
 *
 * The caller is responsible for the ORDER (see `unreadTasks`, which is oldest-first on purpose);
 * this renders what it is handed, in the order it is handed it, so the ordering rule has exactly
 * one owner.
 */
export function buildResearchPreamble(tasks: readonly ResearchTask[]): string {
  if (tasks.length === 0) return "";
  const items = tasks.map((t, i) => {
    // `findings` is `string | null` and `isUnread` already required it non-null; the fallback is
    // belt-and-braces for a caller that hands this an arbitrary list rather than a filtered one.
    const findings = t.findings ?? "";
    return [`${i + 1}. You asked: ${t.question}`, "   What came back:", findings].join("\n");
  });
  return [`${RESEARCH_PREAMBLE_HEADER} ${tasks.length} finding(s):`, "", ...items].join("\n");
}

/**
 * The opening line of the NO-FINDINGS section.
 *
 * ══ PURELY DESCRIPTIVE, AND THE GUIDANCE LIVES PER ITEM (roborev 63268) ═════════════════════════
 *
 * The first version put one instruction here — "re-dispatch it rather than waiting: nothing else is
 * going to retry it" — and that was a REMEDY STRING WITH NO SAFETY ANALYSIS, which `AGENTS.md` calls
 * out as needing the same scrutiny as the code path it replaces. The section carries `cancelled`
 * tasks, i.e. runs the founder deliberately KILLED, and the concierge owns a dispatch tool. So the
 * copy told the model to re-spawn the exact run he had just stopped to save tokens — while the rest
 * of the stack states the opposite invariant explicitly (`research.rs::cancel_task` records no
 * `error` because "a task the founder killed is not a broken one", and a test asserts "a task he
 * killed is never re-narrated"). The only hedge, "if it bears on what he is asking", attaches
 * grammatically to "say so", not to "re-dispatch".
 *
 * The header was also FALSE for one of the three shapes it covers: a `done` task with no findings
 * DID come back — it found nothing. "Did not come back" is a claim about the world, and it was wrong.
 *
 * So the header now only says what is true of all three, and what to do is decided per item against
 * that item's actual status. See {@link noFindingsLine}.
 */
export const RESEARCH_FAILED_PREAMBLE_HEADER =
  "RESEARCH WITHOUT FINDINGS — research you dispatched has ended without an answer, and the founder " +
  "has NOT seen this. Say so plainly if it bears on what he is asking. Each item says what happened " +
  "and what to do about it; follow that per item rather than treating them alike. Oldest first.";

/**
 * How many items the section RENDERS before it starts withholding.
 *
 * ══ WHY A CAP EXISTS AT ALL, AND WHY IT IS NOT A CAP ON WHAT IS CLAIMED (roborev 63268) ═════════
 *
 * This section is unlike the findings one in a way that only bites once: findings accumulate a few
 * at a time, but NO failed/cancelled/empty task has ever carried a `readAt`, because until this
 * feature existed nothing ever claimed one. `list_tasks` returns every JSON record on disk with no
 * cap and nothing prunes the research dir — so the FIRST peek after this ships folds every such task
 * in the install's entire history into a single prompt. On the founder's own machine that is the 11
 * red rows plus every cancelled or empty run ever dispatched; on an older install it is unbounded.
 *
 * The cap is on the RENDERING only. Every id still goes into `taskIds`, so every one is still
 * claimed and every row still retires — capping the claim instead would leave the backlog on screen
 * forever, which is the bug this whole change exists to fix.
 *
 * And it DISCLOSES what it withheld, per `buildResearchPreamble`'s own standing rule: "if this ever
 * has to bound its length, it must say what it withheld and how much — a cap without a disclosure is
 * the defect `buildNoticeSection` was rewritten to remove."
 */
export const MAX_RENDERED_NO_FINDINGS = 5;

/**
 * How many withheld ids the disclosure note NAMES, and how much of each question it carries.
 *
 * ══ A DISCLOSURE THAT GROWS WITH HISTORY UNDOES THE CAP IT DISCLOSES (roborev 63377) ════════════
 *
 * Naming the ids is what makes `research get <id>` reachable (see the note below), but the first
 * version named ALL of them and carried each question verbatim — so the section grew linearly with
 * total history again, which is the exact unbounded-prompt problem `MAX_RENDERED_NO_FINDINGS`
 * exists to stop. What the item cap saves is two fixed guidance strings (~150 constant chars); the
 * question is the VARIABLE-length part, so keeping every one of them costs more than the cap saved.
 *
 * So the id list is bounded too, and the remainder is disclosed in the same sentence rather than
 * dropped — the standing rule is that a cap must say what it withheld and how much, and that rule
 * applies to a cap inside a disclosure exactly as it does to the one it is disclosing.
 *
 * WHICH ones are named: the NEWEST of the withheld set, mirroring the render cap's own choice. The
 * withheld are the oldest tasks by construction, so the newest of them are the ones nearest to what
 * is rendered and the likeliest to still matter.
 */
export const MAX_DISCLOSED_IDS = 20;
export const MAX_DISCLOSED_QUESTION_CHARS = 120;

/**
 * One question, safe to put on ONE line of the id list.
 *
 * Two hazards, both of which break the format rather than merely lengthen it: an embedded newline
 * splits the entry across lines (so the `   <id> — ` prefix no longer introduces what follows, and
 * the closing `)` drifts), and an unbounded question is the growth this cap exists to bound.
 */
function clipQuestion(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_DISCLOSED_QUESTION_CHARS) return flat;
  return `${flat.slice(0, MAX_DISCLOSED_QUESTION_CHARS - 1).trimEnd()}…`;
}

/**
 * What the ID list says about the ids IT could not name — the disclosure of the inner cap.
 *
 * Two pieces, and they must agree: the sentence has to stop claiming the list is the whole withheld
 * set (`Ids of the newest N of them:`), and the count of what is missing has to be stated.
 *
 * ══ WHY THIS IS A FUNCTION AND NOT TWO INLINE TERNARIES (roborev 63561) ═════════════════════════
 *
 * Inline, neither branch could be mutation-checked: deleting the clause left the note counting 27
 * and listing 20 with no word about the gap — the untruthful partial disclosure this whole change
 * exists to remove — and the suite stayed green, because the only case covering the over-cap regime
 * asserted the remainder LINE and never the sentence clause that pairs with it. The `unnamed <= 0`
 * guard could not be judged at all: the mutant broke parsing inside the array literal. Pulled out,
 * each line is an independently mutable statement, which is the thing the check needs to bite on.
 */
function subCapDisclosure(named: number, unnamed: number): { clause: string; line: string[] } {
  if (unnamed <= 0) return { clause: "", line: [] };
  return {
    clause: ` of the newest ${named} of them`,
    line: [`   … and ${unnamed} further item(s) older than these, whose ids are not named here.`],
  };
}

/**
 * What to tell the brain about ONE task that produced no findings — decided by its actual status.
 *
 * The three shapes are genuinely different events and the guidance is not interchangeable:
 *
 *   • `failed` — the run broke. Nothing retries it, so re-dispatching is the useful move, and the
 *     runner's own sentence usually names the cap or the cause it should adjust for.
 *   • `cancelled` — the FOUNDER stopped it. Re-dispatching is undoing a decision he made, on his
 *     behalf, without being asked. The instruction is explicitly NOT to.
 *   • `done` with no findings — it ran fine and found nothing. That is an answer, not a fault, and
 *     saying "it did not come back" about it would be false.
 */
function noFindingsLine(task: ResearchTask): { what: string; then: string } {
  if (task.status === "cancelled") {
    return {
      what: "You stopped it.",
      then: "Do NOT re-dispatch it — he chose to stop it. Only run it again if he asks.",
    };
  }
  if (task.status === "done") {
    return {
      what: "It ran to completion and found nothing.",
      then: "Treat that as the answer. Re-dispatch only if a narrower question would help.",
    };
  }
  return {
    what: task.error ?? "No reason was recorded.",
    then: "Nothing will retry it. Re-dispatch it — deeper, or as a narrower question — if it still matters.",
  };
}

/**
 * Render unclaimed FAILED/CANCELLED tasks into their own short section. `""` when there is nothing.
 *
 * ══ WHY THIS EXISTS, WHEN `isUnread` DELIBERATELY EXCLUDED FAILURES ═════════════════════════════
 *
 * `isUnread`'s own note says a failure "is not worth spending prompt preamble on — the concierge
 * asked for findings, and 'there are none' is not a finding", and points at the row as the surface
 * the founder chose. That judgement was reasonable and it was wrong in practice, on evidence:
 *
 *   • The failures were NOT reaching anyone. They went only to `stores/conciergeEventLog`, which is
 *     plain module state that does not survive an app reload — so a failure could be recorded and
 *     then silently lost with no residue at all.
 *   • And they were not rare. Five of six dispatches in one evening died on the 3-minute quick-tier
 *     wall clock, which the dispatching agent discovered only by explicitly listing tasks. A
 *     research surface that fails most of the time AND fails silently is worse than none.
 *   • The row was not the backstop it was assumed to be: 28 rows had stacked up, 11 of them red, so
 *     "the founder can see it there" had stopped being true through sheer volume.
 *
 * So a failure now gets exactly ONE line, on the one channel the brain is guaranteed to read. It is
 * deliberately terse — a failure is not a finding and must not read like one — and it carries the
 * runner's own sentence rather than a reconstruction.
 *
 * IT IS ALSO WHAT LETS THE ROW RETIRE. Being in the preamble means being staged and then CLAIMED on
 * delivery, exactly like a finding; and `isRetired` reads that same claim. Without this, a failed
 * task would be owed to nobody, could never be claimed, and its row could never go away.
 */
export function buildResearchFailurePreamble(tasks: readonly ResearchTask[]): string {
  if (tasks.length === 0) return "";
  // NEWEST KEPT, OLDEST WITHHELD. The caller hands these oldest-first (the narrative order), so the
  // tail is the recent end — and on the first drain after this ships, the head is years of history
  // while the tail is what just happened. Rendered back in the caller's order.
  const shown = tasks.slice(Math.max(0, tasks.length - MAX_RENDERED_NO_FINDINGS));
  const withheld = tasks.length - shown.length;

  const items = shown.map((t, i) => {
    const { what, then } = noFindingsLine(t);
    return `${i + 1}. You asked: ${t.question}\n   What happened: ${what}\n   What to do: ${then}`;
  });
  // THE DISCLOSURE IS NOT OPTIONAL — a cap that stays quiet reports a partial list as a whole one.
  //
  // ══ AND IT MUST BE TRUE AT THE MOMENT IT IS WRITTEN (roborev 63305, two Mediums) ═══════════════
  //
  // The first version got both halves wrong, and both are the same trap this function's own header
  // was rewritten to fix — a remedy the reader cannot act on, and a claim that is not yet a fact:
  //
  //   • IT POINTED AT A SURFACE THAT STRUCTURALLY CANNOT RETURN THESE. "Ask for the research list"
  //     resolves to `conciergeTools/research.listResearchTasks`, which is NEWEST-first capped at
  //     `MAX_RECENT_RESEARCH`. The items withheld here are by construction the OLDEST, so on the
  //     very scenario the cap exists for — an install's whole history arriving at once — they are
  //     precisely the ones that list will never contain. And `research get <id>` was unreachable
  //     too, because the rows are retired by then and the preamble carried no ids. So the ids are
  //     now IN the note: one compact `id — question` line each, which is what makes `get` work.
  //     That still saves the bulk of the cap (the per-item "what happened"/"what to do" pair).
  //
  //   • IT ASSERTED A CLAIM ONLY `settle` CAN MAKE. It said the withheld items "have been marked as
  //     told and their rows retired" — but this string is built by `peek`, and PEEK CLAIMS NOTHING.
  //     A turn that is superseded, cancelled, errored or killed calls `abandon`, nothing is stamped,
  //     and the same items come back next turn. This file's header stresses that outcome is the
  //     ORDINARY one, not an edge case. So the prompt was stating a false state to a model that may
  //     relay it to the founder and will use it to decide not to mention them. It is now written
  //     FORWARD-LOOKING: it describes what this reply landing will do, which is true either way.
  //
  //   • AND THE DISCLOSURE ITSELF IS BOUNDED (roborev 63377). Naming every withheld id, each with
  //     its verbatim question, put the unbounded growth straight back — see {@link MAX_DISCLOSED_IDS}
  //     for why that costs more than the item cap saves, and why the remainder is still disclosed.
  const named = tasks.slice(Math.max(0, withheld - MAX_DISCLOSED_IDS), withheld);
  const unnamed = withheld - named.length;
  const withheldIds = named.map((t) => `   ${t.id} — ${clipQuestion(t.question)}`);
  const overflow = subCapDisclosure(named.length, unnamed);
  const note =
    withheld > 0
      ? [
          "",
          `(${withheld} older item(s) are not detailed above, oldest first. Delivering this reply ` +
            `marks them as told, after which they will not be offered again — so if any of them ` +
            `matter, use \`research get <id>\` now. Ids${overflow.clause}:`,
          ...withheldIds,
          ...overflow.line,
          ")",
        ]
      : [];
  return [
    `${RESEARCH_FAILED_PREAMBLE_HEADER} ${tasks.length} of them:`,
    "",
    ...items,
    ...note,
  ].join("\n");
}

/**
 * Join the two sections, skipping the empty ones.
 *
 * The empty case must stay EXACTLY `""` — `withResearchPreamble` keys on that to return the prompt
 * object unchanged, so a "join" that produced `"\n\n"` for two empty sections would put a blank line
 * on every prompt the app has ever sent.
 */
function joinSections(...sections: readonly string[]): string {
  return sections.filter((s) => s !== "").join("\n\n");
}

/**
 * Put the preamble in front of a prompt.
 *
 * IDENTITY WHEN THERE IS NOTHING — the same prompt object, not a prompt with a blank line on it.
 * Both seams call this unconditionally, so "no unread findings adds NOTHING to the prompt" has to
 * be a property of this function rather than a discipline at two call sites.
 */
export function withResearchPreamble(preamble: string, prompt: string): string {
  return preamble === "" ? prompt : `${preamble}\n\n${prompt}`;
}

// ---------------------------------------------------------------------------------------------
// The drain — the injected edges
// ---------------------------------------------------------------------------------------------

export interface ResearchDrainDeps {
  now(): number;
  /** Every task this window knows about. The store's `allTasks()` in production; an array in a
   *  test. The drain filters and orders it itself, through the store's own selectors, so there is
   *  no second definition of "unread" or of "oldest first". */
  tasks(): readonly ResearchTask[];
  /**
   * THE CLAIM. `markResearchRead` in production.
   *
   * Fire-and-forget by design: a failed claim means the finding is told again next turn, which is
   * the recoverable direction. Errors are the edge's to log.
   */
  markRead(taskIds: string[], at: number): void;
  /** `recordConciergeEvent`. Optional so a test can assert the drain works without one. */
  recordEvent?(payload: ConciergeEventPayload, at: number): void;
}

/** What one peek staged: the text, and the ids it named. */
export interface ResearchStaging {
  /** `""` when nothing is unread. */
  preamble: string;
  /** Oldest first, matching the preamble's numbering. */
  taskIds: readonly string[];
}

export interface ResearchDrainStats {
  /** Peeks that carried at least one finding. */
  peeked: number;
  /** Tasks actually stamped `readAt`. */
  claimed: number;
  /** Turns that carried findings and died without delivering — the findings stayed unread. */
  abandoned: number;
  /** Staged turns evicted by the cap before they reported an outcome. Those findings stay unread
   *  too, so this counts REPEATS, never losses. */
  evicted: number;
}

export interface ResearchDrain {
  /**
   * Note the current state of the task list, recording a `research_completed` event for anything
   * that has newly reached a terminal state.
   *
   * Separate from `peek` because it records a DIFFERENT account of the same fact. It used to be the
   * only channel for a failure — `isUnread` is `done`-only, so a FAILED or CANCELLED task reached no
   * prompt at all — and that is no longer true: `buildResearchFailurePreamble` now carries them, and
   * `isNoticePending` is what selects them. So this is a duplicate record, not the sole one.
   *
   * It is still worth keeping, and not merely for symmetry: it records `done` too, so the stream is
   * a complete account of how each task ENDED, on a cursor a turn can replay — where the preamble is
   * a one-shot that is claimed on delivery and then gone. What changed is which one is load-bearing.
   */
  observe(tasks?: readonly ResearchTask[]): void;
  /** Build the preamble. STAMPS NOTHING — see this file's header. */
  peek(): ResearchStaging;
  /**
   * Remember that `turnId` is carrying these findings. Called once the transport has returned a
   * real turn id, i.e. once `invoke("concierge_turn")` has RESOLVED and the turn installed.
   *
   * Staging is still not claiming: an installed turn can be superseded a second later, and
   * `concierge.rs` will kill its child without it ever emitting a reply.
   */
  stage(turnId: string, taskIds: readonly string[]): void;
  /** THE TURN DELIVERED. Claim what it carried; returns the ids claimed. */
  settle(turnId: string): readonly string[];
  /** The turn died — superseded, cancelled, errored. Release the staging; the findings stay
   *  unread and come back on the next turn. */
  abandon(turnId: string): void;
  stats(): ResearchDrainStats;
}

/**
 * How many in-flight turns may be staged at once.
 *
 * The same 16 `ConciergeHost.pushDigestRef` uses, and for the same reason: nothing else prunes this
 * map, and a turn that neither completes nor errors (the webview reloads, the child is orphaned)
 * would otherwise leave an entry behind for the life of the page. Eviction is the SAFE direction by
 * construction — an evicted staging is never claimed, so its findings are told again.
 */
export const MAX_STAGED_TURNS = 16;

/**
 * How many claimed ids are remembered locally.
 *
 * `markRead` writes through to disk, but the store is a CACHE refreshed by a poll — so between the
 * claim and the next refresh, `unreadTasks` still reports the finding as unread and the very next
 * turn (seconds later) would repeat it. This set closes that window. Eviction is again the safe
 * direction: an evicted id can only produce a repeat, and only if the refresh has not landed yet.
 */
export const MAX_LOCAL_CLAIMS = 256;

/** How many terminal task ids are remembered for event de-duplication. Same eviction posture: a
 *  forgotten id can at worst re-record one event, which the log's own cursor makes harmless. */
const MAX_REPORTED_TERMINAL = 256;

/** Drop oldest-first until the set is within `cap`. Insertion order is the iteration order of a
 *  `Set`, so the first key is the oldest. */
function trim(set: Set<string>, cap: number): void {
  while (set.size > cap) {
    const oldest = set.keys().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}

export function createResearchDrain(deps: ResearchDrainDeps): ResearchDrain {
  /** turnId → the ids that turn's prompt named. */
  const staged = new Map<string, readonly string[]>();
  /** Claimed here, possibly not yet reflected by the store's cache. See {@link MAX_LOCAL_CLAIMS}. */
  const claimed = new Set<string>();
  /** Task ids already reported terminal, so a re-observation of the same list is silent. */
  const reportedTerminal = new Set<string>();
  const stats: ResearchDrainStats = { peeked: 0, claimed: 0, abandoned: 0, evicted: 0 };

  const observe = (tasks?: readonly ResearchTask[]) => {
    const all = tasks ?? deps.tasks();
    const record = deps.recordEvent;
    if (!record) return;
    for (const t of all) {
      if (!isTerminal(t.status)) continue;
      if (reportedTerminal.has(t.id)) continue;
      reportedTerminal.add(t.id);
      // NO QUESTION TEXT AND NO FINDINGS. The event log's fourth property: these records are handed
      // to a model and may be quoted back, so they carry ids, statuses and outcomes — never user
      // content. The findings reach the brain through the preamble, which is the surface that is
      // actually meant to carry them.
      record(
        {
          kind: "research_completed",
          taskId: t.id,
          projectId: t.projectId,
          status: t.status,
        },
        t.finishedAt ?? deps.now(),
      );
    }
    trim(reportedTerminal, MAX_REPORTED_TERMINAL);
  };

  return {
    observe,

    peek() {
      const all = deps.tasks();
      observe(all);
      // `unreadTasks` owns both the filter and the oldest-first order (store.ts). The local claim
      // set is the only thing layered on top, and it can only ever REMOVE — so this can never
      // surface something the store considers read.
      const pending = unreadTasks(all).filter((t) => !claimed.has(t.id));
      // The other half of what a terminal task can be owed. `isNoticePending` is defined as the
      // COMPLEMENT of `isUnread` within the terminal phase, so these two lists cannot overlap and
      // cannot leave a gap — a task is in exactly one of them until it is claimed.
      const failures = all
        .filter((t) => isNoticePending(t) && !claimed.has(t.id))
        .sort((a, b) => a.createdAt - b.createdAt);
      const preamble = joinSections(
        buildResearchPreamble(pending),
        buildResearchFailurePreamble(failures),
      );
      if (pending.length > 0 || failures.length > 0) stats.peeked++;
      // ONE LIST OF WHAT THIS TURN IS ACCOUNTABLE FOR — findings and failures together, because both
      // are delivered by the same prompt and must therefore be claimed by the same `settle`. Nothing
      // is stamped here; peek still never claims.
      return {
        preamble,
        taskIds: [...pending.map((t) => t.id), ...failures.map((t) => t.id)],
      };
    },

    stage(turnId, taskIds) {
      if (taskIds.length === 0) return;
      staged.set(turnId, [...taskIds]);
      while (staged.size > MAX_STAGED_TURNS) {
        const oldest = staged.keys().next();
        if (oldest.done) break;
        staged.delete(oldest.value);
        stats.evicted++;
      }
    },

    settle(turnId) {
      const ids = staged.get(turnId);
      if (!ids || ids.length === 0) return [];
      staged.delete(turnId);
      // Only ids not already claimed by an overlapping turn — two turns can legitimately carry the
      // same finding (the first was superseded and told the founder nothing, so the second repeated
      // it), and stamping it twice would be a second pointless write.
      const fresh = ids.filter((id) => !claimed.has(id));
      if (fresh.length === 0) return [];
      for (const id of fresh) claimed.add(id);
      trim(claimed, MAX_LOCAL_CLAIMS);
      stats.claimed += fresh.length;
      deps.markRead(fresh, deps.now());
      return fresh;
    },

    abandon(turnId) {
      // NOTHING IS STAMPED HERE. That is the whole point of the split: the findings this turn
      // carried are still unread, so the next `peek` names them again.
      if (staged.delete(turnId)) stats.abandoned++;
    },

    stats: () => ({ ...stats }),
  };
}
