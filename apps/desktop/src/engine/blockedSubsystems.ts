// blockedSubsystems — "which named subsystems are COMPLETELY BLOCKED right now, and why".
//
// THE INCIDENT THIS EXISTS FOR. The founder's "Improve Sparkle" agent was completely blocked — its
// account had hit its Claude session limit and no retry could clear it — while the top-of-window
// banner only softly said "AI-Enhanced features are paused … we keep retrying automatically". A
// total block was narrated as a mild, self-healing degradation. The worst true condition has to win
// the banner, and it has to NAME what is blocked so the reader knows the blast radius.
//
// WHY A "BLOCKED" LIST AND NOT JUST A FLAG (the Part-A topology, proven in the code). Every AI
// subsystem here runs on the user's OWN `claude` CLI subscription login — there is no BYOK key and
// no Sparkle-hosted proxy any more (`claude_oneshot.rs`, `naming.rs`). An "account" is a
// `CLAUDE_CONFIG_DIR` with its own login and its own subscription usage window (the budget bucket).
// Different subsystems land on an account differently:
//   • AI-Enhanced features (naming, judge, attention, suggestions) do NOT rotate — they inherit the
//     ambient config dir, i.e. the DEFAULT account (`oneshotAccountId`).
//   • Improve Sparkle and the Concierge are STICKY consumers of the rotation pool — each settles on
//     one pool account (`stickyAccountSnapshot`).
//   • Build agents pick a pool account per spawn; a MOUNTED pane's binding is observable
//     (`paneAccountMap`).
// So when one account's session limit is exhausted, EVERY subsystem currently bound to that account
// is blocked together — which for a single-account user (what the founder had) is Improve Sparkle
// AND AI-Enhanced features at once. That is exactly the co-failure he saw, and the list is how the
// banner says it truthfully instead of guessing.
//
// HONESTY BOUNDARY (do not fabricate a signal). The only "blocked" evidence we trust is a live
// per-account `exhaustedUntil` (a real reset instant, benched from a structured `error: "rate_limit"`
// record — `services/limitSync.ts`). A subsystem is listed ONLY when its OBSERVABLE account binding
// resolves to an exhausted account. Build agents are therefore listed only while their pane is
// mounted (the only place the binding is observable); a headless agent on an exhausted account is
// not invented into the list. This under-reports rather than over-reports — the safe direction for a
// claim the user will act on.
//
// PURE. `now` and every binding are passed in, so the rule is arithmetic over data and tested
// without a React tree, timers, or IPC.

/** A stable identity for a subsystem/agent that can be blocked, plus the label the user reads. */
export interface BlockedSubsystem {
  /** Stable key for React lists and de-duplication. */
  key: string;
  /** Human display name, e.g. "Improve Sparkle agent", "AI Enhancement Features", or a build
   *  agent's sidebar name. */
  label: string;
}

/** One mounted build-agent pane and the account it is running under (from `paneAccountMap`). */
export interface PaneBinding {
  agentId: string;
  accountId: string | undefined;
}

/** Everything the derivation needs, all already read from the observable seams by the caller. */
export interface BlockedSubsystemsInput {
  /** Injected clock (epoch ms). */
  now: number;
  /** Per-account observed exhaustion. `exhaustedUntil` is epoch ms, or null when not benched. */
  usage: readonly { id: string; exhaustedUntil: number | null }[];
  /** The account AI-Enhanced one-shot calls run under (the default account), or null if unknown. */
  oneshotAccountId: string | null;
  /** The account the Improve Sparkle sticky consumer is currently bound to, or null. */
  improveSparkleAccountId: string | null;
  /** The account the Concierge sticky consumer is currently bound to, or null. */
  conciergeAccountId: string | null;
  /** Mounted build-agent panes and their account bindings. */
  panes: readonly PaneBinding[];
  /** agentId → sidebar display name, for labelling build agents. */
  agentNames: Readonly<Record<string, string>>;
  /** True for any id in the Improve Sparkle namespace — the canonical `__sparkle_self__` AND its
   *  per-window `__sparkle_self__-win-<uuid>` variants (pass `services/sparkleAgent.isSparkleAgentId`).
   *  Its pane, in any window, is the same subsystem already covered by {@link improveSparkleAccountId},
   *  so it must not be double-listed — and a raw per-window id must never fall through to user copy. */
  isImproveSparkleAgentId: (agentId: string) => boolean;
}

/** Stable keys for the three fixed subsystems, exported so tests and callers never re-spell them. */
export const AI_ENHANCED_KEY = "ai-enhanced";
export const IMPROVE_SPARKLE_KEY = "improve-sparkle";
export const CONCIERGE_KEY = "concierge";

/** The labels the banner shows for the three fixed subsystems. Exported for tests. */
export const AI_ENHANCED_LABEL = "AI Enhancement Features";
export const IMPROVE_SPARKLE_LABEL = "Improve Sparkle agent";
export const CONCIERGE_LABEL = "Concierge";

/** Fallback label for an exhausted build-agent pane whose display name has not resolved yet — never
 *  the raw internal id. Exported for tests. */
export const GENERIC_AGENT_LABEL = "Build agent";

/**
 * The set of account ids with a LIVE limit right now: benched (`exhaustedUntil`) to a future instant.
 *
 * A past instant is not a limit — `<= now` is the only thing that clears a stale bench in the ~15s
 * window before the next account fetch drops it from the wire (mirrors `engine/usageLimit.ts`). Pure.
 */
export function exhaustedAccountIds(
  usage: readonly { id: string; exhaustedUntil: number | null }[],
  now: number,
): Set<string> {
  const out = new Set<string>();
  for (const u of usage) {
    if (u.exhaustedUntil != null && u.exhaustedUntil > now) out.add(u.id);
  }
  return out;
}

/**
 * Compute the ordered, de-duplicated list of subsystems that are completely blocked right now.
 *
 * Order is deterministic and worst-blast-radius-first among the fixed subsystems, then build agents
 * by display name — so the banner reads the same way every render and the overflow drops the same
 * tail. Returns `[]` when nothing is blocked (the healthy case), which is the caller's cue that the
 * red banner must not show.
 */
export function computeBlockedSubsystems(input: BlockedSubsystemsInput): BlockedSubsystem[] {
  const exhausted = exhaustedAccountIds(input.usage, input.now);
  if (exhausted.size === 0) return [];

  const out: BlockedSubsystem[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, label });
  };

  // Fixed subsystems first, in blast-radius order: AI-Enhanced (every enhancement feature at once),
  // then the two named agents.
  if (input.oneshotAccountId != null && exhausted.has(input.oneshotAccountId)) {
    push(AI_ENHANCED_KEY, AI_ENHANCED_LABEL);
  }
  if (input.improveSparkleAccountId != null && exhausted.has(input.improveSparkleAccountId)) {
    push(IMPROVE_SPARKLE_KEY, IMPROVE_SPARKLE_LABEL);
  }
  if (input.conciergeAccountId != null && exhausted.has(input.conciergeAccountId)) {
    push(CONCIERGE_KEY, CONCIERGE_LABEL);
  }

  // Mounted build-agent panes, sorted by the name the user sees so the list is stable.
  const agents = input.panes
    .filter((p) => p.accountId != null && exhausted.has(p.accountId))
    // The Improve Sparkle pane (canonical OR any per-window `-win-<uuid>` id) is the same subsystem
    // already covered above — never list it a second time, and never let its raw id reach the copy.
    .filter((p) => !input.isImproveSparkleAgentId(p.agentId))
    // A raw internal id must never reach user copy, but a real total block must never render as
    // NOTHING either (silence is the worse failure for a "worst true condition" bar). So a pane
    // whose display name has not resolved yet — e.g. `projectStore` hydrating after the first poll
    // tick — is kept under a generic label rather than dropped; the next tick upgrades it to the
    // real name.
    .map((p) => ({ key: `agent:${p.agentId}`, label: input.agentNames[p.agentId] || GENERIC_AGENT_LABEL }))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const a of agents) push(a.key, a.label);

  return out;
}

/** The visible-vs-overflow split of a blocked list for a bar that shows at most `maxVisible` names.
 *
 *  A width bound is not knowable in jsdom, so the count is capped rather than measured: the banner
 *  shows the first `maxVisible` labels and rolls the rest into a "+N more". Pure and total. */
export interface BlockedSummary {
  visible: string[];
  overflow: number;
}

/**
 * Split a blocked list into the labels a bar can show and the count it must summarise as "+N more".
 *
 * `maxVisible` must be >= 1. When the list fits, `overflow` is 0 and every label is visible; when it
 * does not, exactly `maxVisible` labels show and the remainder becomes the overflow count — so the
 * bar can never be pushed past its width by an unbounded list.
 */
export function summarizeBlocked(
  blocked: readonly BlockedSubsystem[],
  maxVisible: number,
): BlockedSummary {
  const cap = Math.max(1, Math.floor(maxVisible));
  if (blocked.length <= cap) {
    return { visible: blocked.map((b) => b.label), overflow: 0 };
  }
  return {
    visible: blocked.slice(0, cap).map((b) => b.label),
    overflow: blocked.length - cap,
  };
}
