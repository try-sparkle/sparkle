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
 * The opening line of the FAILURE section — research that stopped without an answer.
 */
export const RESEARCH_FAILED_PREAMBLE_HEADER =
  "RESEARCH DID NOT COME BACK — research you dispatched stopped without an answer, and the founder " +
  "has NOT seen this. Say so plainly if it bears on what he is asking, and re-dispatch it (deeper, " +
  "or as a narrower question) rather than waiting: nothing else is going to retry it. Oldest first.";

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
  const items = tasks.map((t, i) => {
    // `cancelled` has no error by construction — the founder killed it, and that is the whole story.
    const why = t.status === "cancelled" ? "You stopped it." : (t.error ?? "No reason was recorded.");
    return `${i + 1}. You asked: ${t.question}\n   What happened: ${why}`;
  });
  return [`${RESEARCH_FAILED_PREAMBLE_HEADER} ${tasks.length} of them:`, "", ...items].join("\n");
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
   * Separate from `peek` because it covers what the preamble deliberately cannot: `isUnread` is
   * `done`-only, so a task that FAILED or was CANCELLED never appears in a prompt — and the
   * concierge that dispatched it would otherwise wait forever on an answer that is never coming.
   * The event log is the surface for that (see `stores/conciergeEventLog`).
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
