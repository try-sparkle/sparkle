/**
 * READING the delegation ledger — by SUBJECT, joined to LIVE state.
 *
 * ── THE RETRIEVAL PATH IS THE FEATURE ────────────────────────────────────────────────────────────
 * The founder's constraint, and it decides this file's whole shape: *"recall must work from the
 * SUBJECT — he says 'preview cards' or 'the inline preview work' and the right agent comes back —
 * not only from an agent name he does not know. A perfect write that cannot be found is worth
 * nothing."*
 *
 * So the query is matched against the ROW TEXT, which is the ask and the brief in the founder's own
 * words, through SQLite's FTS5 index — not against agent names, which he does not know and which
 * change. He has never once asked "what is agent 8f590b78 doing".
 *
 * ── EVERYTHING MUTABLE IS RE-DERIVED HERE, NOT READ OUT OF THE ROW ───────────────────────────────
 * The ledger row holds only what was true at dispatch (services/dispatchLedger.ts explains why).
 * This file supplies the other half: the CURRENT name, whether the agent still exists, and whether
 * it is working. Each is read live, at answer time, from the same sources the sidebar reads.
 *
 * This is the deliberate answer to the bug class the founder has been hitting all week — state
 * stamped once and never re-derived. It is also load-bearing rather than principled: three agents
 * have been observed simultaneously named "Worker 13", so quoting the stamped name would name
 * nobody, and an agent retired an hour after dispatch would be reported as running forever.
 *
 * A rename is REPORTED, not hidden. `name` is live and `nameAtDispatch` is historical, and when they
 * differ `renamedSince` says so — because the founder's own correction on a previous occasion was
 * that being told a name he cannot see on screen is worse than being told nothing ("Build 17 is not
 * the name of the agent right now … that doesn't mean anything to me because I can't see it").
 *
 * ── AND A CLOSED DELEGATION IS STILL AN ANSWER ───────────────────────────────────────────────────
 * Nothing is ever deleted or edited to close a delegation out; `closed` is DERIVED from the agent no
 * longer being resolvable. That matters because the founder's most common question is not "what is
 * running" but *"did we ever do that work?"* — and a ledger that pruned finished delegations would
 * answer it wrongly. Only the live PREAMBLE (stores/conciergeDispatchStore.ts) filters to open ones,
 * because a prompt is a budget; search never does.
 */
import { searchHistory, entriesInRange, type HistoryHit } from "./history";
import {
  parseDispatchText,
  type DispatchChannel,
  type DispatchActor,
  type ParsedDispatch,
} from "./dispatchLedger";
import { findKnownAgent, knownAgentLiveness } from "./knownAgents";
import { useRuntimeStore } from "../stores/runtimeStore";
import { log } from "../logger";

/**
 * Where a delegation got to, as read RIGHT NOW.
 *
 * `unknown` is a first-class verdict and must never be collapsed into `idle`. `runtimeStore.status`
 * is written only by a MOUNTED PANE, so after a relaunch — or for any project no window is hosting —
 * a perfectly healthy agent has no status entry at all. Reporting that as "idle" is the exact
 * staleness bug `liveActivityOf` documents in conciergeTools/lifecycle.ts, and it would have the
 * concierge tell the founder an agent had stopped when it was working the whole time.
 */
export type DispatchStatus = "working" | "idle" | "unknown" | "closed";

export interface RecalledDispatch {
  /** THE handle — an agent id, or a research task id. Stable across renames and restarts, and what
   *  `inbox_send` / `send_to_agent_terminal` take to reach it. */
  targetId: string;
  channel: DispatchChannel;
  /** The name RIGHT NOW. Falls back to the dispatch-time name once the agent is gone — at that point
   *  the historical name is the only name there is, and it is better than a bare uuid. */
  name: string | null;
  /** The name stamped in the row. Reported separately so a rename is visible; see the header. */
  nameAtDispatch: string | null;
  renamedSince: boolean;
  projectId: string | null;
  projectName: string | null;
  /** Epoch ms, from the row's own `created_at` column. */
  dispatchedAtMs: number;
  /** Derived at answer time from `nowMs`, never stored. */
  ageMs: number;
  /** The founder's own words that prompted this, when the write site had them. */
  ask: string | null;
  brief: string;
  briefTruncated: boolean;
  beads: string[];
  mode: "plan" | "build" | null;
  by: DispatchActor;
  status: DispatchStatus;
  /** Can the concierge send this target a message right now? False for anything `closed`, and for a
   *  research task, which has no inbox. Reported rather than left to be inferred from `status`,
   *  because the founder asked for "go check on that agent" to be actionable and a caller must not
   *  have to guess which ids are addressable. */
  addressable: boolean;
}

export interface RecallDispatchesArgs {
  /** The SUBJECT — free text, matched against the ask and the brief. Omitted returns the most recent
   *  delegations by time, which is what "what have you got running?" means. */
  query?: string;
  /** Narrow to one target id, for "check on THAT one" once an id is in hand. */
  targetId?: string;
  /** Only delegations at or after this epoch ms. */
  sinceMs?: number;
  /** Include delegations whose target no longer exists. DEFAULT TRUE — see the header: "did we ever
   *  do that work" is the common question, and it is answered by closed rows. */
  includeClosed?: boolean;
  limit?: number;
}

export interface RecallDispatchesResult {
  dispatches: RecalledDispatch[];
  /** What was actually searched, echoed back so a caller can say "nothing about X" honestly rather
   *  than reporting an empty list against a query it may have mangled. */
  query: string | null;
  /** How many rows matched BEFORE `includeClosed` filtering — so "12 matched, all finished" is
   *  sayable, and a closed-only result never reads as no result. */
  matched: number;
}

/** How far back the no-query / preamble reads look. Long enough to cover any delegation still worth
 *  calling open (an agent alive for a fortnight is an outlier), short enough that the scan is a
 *  handful of rows. A SUBJECT search is not bounded by this — it goes through the FTS index and
 *  reaches the whole ledger. */
export const RECENT_DISPATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const DEFAULT_RECALL_LIMIT = 20;

/** The seams a caller may replace. Everything live is behind one of these so the whole read path is
 *  testable without a database, a store, or a running app. */
export interface RecallDeps {
  /** FTS search over `source='dispatch'`, whole text included. */
  search: (query: string, limit: number) => Promise<HistoryHit[]>;
  /** Time-ordered read of the ledger, used when there is no query. */
  recent: (fromMs: number, toMs: number, limit: number) => Promise<{ text: string; createdAt: number }[]>;
  /** Live agent resolution: the CURRENT name, or null when the agent no longer exists. */
  liveAgent: (id: string) => { name: string | null; exists: boolean };
  /** Live activity for an agent this window can see. */
  activity: (id: string) => DispatchStatus;
  /** Live status of a research task, or null when this build cannot resolve one. */
  researchStatus?: (id: string) => DispatchStatus | null;
  now: () => number;
}

/**
 * The live-agent arm, and BOTH of its lookups are part of the answer.
 *
 * `findKnownAgent` resolves an agent this window has a record of. `knownAgentLiveness` is the
 * SECOND arm and is not redundant: it merges the PERSISTED open-agent set, which crosses windows, so
 * an agent whose pane is mounted in a torn-out satellite still reads as existing. Without it a
 * multi-window session would report live agents as `closed` — telling the founder work had finished
 * while it was still running, which is a worse lie than the one this feature was built to fix.
 *
 * Both live behind ONE dep (`RecallDeps.liveAgent`) rather than two, so a caller cannot inject half
 * an answer and get a reading that is internally inconsistent.
 */
function liveAgentOf(id: string): { name: string | null; exists: boolean } {
  const known = findKnownAgent(id);
  if (known) return { name: known.name ?? null, exists: true };
  return { name: null, exists: knownAgentLiveness(id) !== "unknown" };
}

/**
 * Map the live status map onto this file's four-valued reading.
 *
 * Same mapping `liveActivityOf` uses, and for the same stated reasons: `undefined` becomes
 * `unknown` and NEVER `idle`, and the RED tier (`waiting`/`approval`/`questions`) counts as
 * `working` — those agents are not emitting tokens but each is holding an exchange open with a
 * human, and reporting one as idle is how a question nobody answers gets forgotten.
 */
function activityOf(id: string): DispatchStatus {
  const status = useRuntimeStore.getState().status[id];
  if (status === undefined) return "unknown";
  if (status === "working" || status === "questions" || status === "waiting" || status === "approval") {
    return "working";
  }
  return "idle";
}

export const LIVE_RECALL_DEPS: RecallDeps = {
  search: (query, limit) =>
    searchHistory(query, limit, { sources: ["dispatch"], includeText: true }),
  recent: async (fromMs, toMs, limit) => {
    const rows = await entriesInRange(fromMs, toMs, "dispatch", limit);
    return rows.map((r) => ({ text: r.text, createdAt: r.createdAt }));
  },
  liveAgent: liveAgentOf,
  activity: activityOf,
  now: () => Date.now(),
};

/**
 * Join one parsed row to live state.
 *
 * ── WHY `closed` IS DERIVED FROM RESOLVABILITY AND NOT FROM A WRITTEN FLAG ───────────────────────
 * `findKnownAgent` returns undefined for an id that is retired, discarded, or from a session this
 * window never saw. All three mean the same thing to the founder's question — that delegation is
 * over — and none of them requires anyone to have remembered to write a closing record. A flag
 * would need a writer at every one of those exits, and the exit nobody thinks of (the app was
 * killed) is the one that happens most.
 *
 * Its cost is honest and worth naming: an agent alive in ANOTHER window of a multi-window session
 * can read `closed` here. `knownAgentLiveness` is consulted first precisely to narrow that — it
 * merges the PERSISTED open-agent set, which crosses windows — so the false `closed` is limited to
 * agents this machine has no record of at all.
 */
function joinLive(
  parsed: ParsedDispatch,
  deps: RecallDeps,
  nowMs: number,
): RecalledDispatch {
  // A research task is NOT an agent — its id is a task id and would never resolve against the
  // roster, so asking is not merely wasteful, it would answer `closed` for every one of them.
  const isResearch = parsed.channel === "research";
  const live = isResearch ? { name: null, exists: false } : deps.liveAgent(parsed.targetId);

  let status: DispatchStatus;
  if (isResearch) {
    // `unknown` — NOT `closed` — when this build cannot resolve a research task: the task very
    // likely finished and its findings are still readable through `research({ op: "get" })`, and
    // reporting that as closed would tell the founder the answer is gone when it is sitting there.
    status = deps.researchStatus?.(parsed.targetId) ?? "unknown";
  } else if (!live.exists) {
    status = "closed";
  } else {
    status = deps.activity(parsed.targetId);
  }

  const name = live.name ?? parsed.nameAtDispatch;
  return {
    targetId: parsed.targetId,
    channel: parsed.channel,
    name,
    nameAtDispatch: parsed.nameAtDispatch,
    // Only claim a rename when BOTH names are known. A missing live name means the agent is gone,
    // not that it was renamed to nothing.
    renamedSince:
      live.name !== null && parsed.nameAtDispatch !== null && live.name !== parsed.nameAtDispatch,
    projectId: parsed.projectId,
    projectName: parsed.projectName,
    dispatchedAtMs: parsed.atMs,
    ageMs: Math.max(0, nowMs - parsed.atMs),
    ask: parsed.ask,
    brief: parsed.brief,
    briefTruncated: parsed.briefTruncated,
    beads: parsed.beads,
    mode: parsed.mode,
    by: parsed.by,
    status,
    // A closed target has nothing draining its inbox, and a research task has no inbox at all —
    // `fleet.inboxSend` would refuse both with `undeliverable-recipient`. Saying so here is what
    // stops the concierge offering the founder a channel that does not exist.
    addressable: status !== "closed" && !isResearch,
  };
}

/**
 * Recall delegations by subject.
 *
 * With a `query` this is an FTS search over the WHOLE ledger; without one it is the most recent
 * delegations inside {@link RECENT_DISPATCH_WINDOW_MS}. The two paths share the parse and the live
 * join, so a delegation reads identically whichever way it was reached.
 *
 * NEVER THROWS. This is called on the concierge's answer path, and an unreadable ledger must
 * degrade to "I have no record" — which is at least true — rather than failing the founder's turn.
 * The failure is logged so an empty ledger is never silently mistaken for an empty history.
 */
export async function recallDispatches(
  args: RecallDispatchesArgs = {},
  deps: RecallDeps = LIVE_RECALL_DEPS,
): Promise<RecallDispatchesResult> {
  const nowMs = deps.now();
  const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_RECALL_LIMIT, 100));
  const query = args.query?.trim() || null;
  // Over-fetch, because the filters below (`sinceMs`, `targetId`, `includeClosed`) are applied AFTER
  // the store hands rows back and would otherwise turn a full page into a short one. Bounded so a
  // pathological limit cannot pull the whole ledger into the renderer.
  const fetchLimit = Math.min(limit * 5, 300);

  let rows: { text: string; createdAt: number }[];
  try {
    if (query) {
      const hits = await deps.search(query, fetchLimit);
      // `text` is null when the row was written by a path that did not ask for it — treat that as
      // unreadable rather than parsing the snippet, whose `<b>` markers and ellipses are display
      // artefacts and would corrupt every field.
      rows = hits
        .filter((h) => typeof h.text === "string" && h.text.length > 0)
        .map((h) => ({ text: h.text as string, createdAt: h.createdAt }));
    } else {
      const from = args.sinceMs ?? nowMs - RECENT_DISPATCH_WINDOW_MS;
      rows = await deps.recent(from, nowMs, fetchLimit);
    }
  } catch (e) {
    log.warn("dispatch-recall", "could not read the delegation ledger", e);
    return { dispatches: [], query, matched: 0 };
  }

  const parsed = rows
    .map((r) => parseDispatchText(r.text, r.createdAt))
    .filter((p): p is ParsedDispatch => p !== null && p.targetId !== "");

  const inScope = parsed.filter(
    (p) =>
      (args.sinceMs === undefined || p.atMs >= args.sinceMs) &&
      (args.targetId === undefined || p.targetId === args.targetId),
  );

  const joined = inScope.map((p) => joinLive(p, deps, nowMs));
  // DEFAULT TRUE, deliberately — see the header.
  const includeClosed = args.includeClosed !== false;
  const kept = includeClosed ? joined : joined.filter((d) => d.status !== "closed");

  // NEWEST FIRST, ALWAYS — never alphabetically, and never by FTS rank alone. The failure this
  // feature exists to fix was an eight-minute-old delegation the concierge could not see; recency is
  // the ordering under which that one is line 1. (Rank still decides WHICH rows are fetched; this
  // decides which the founder is shown first.)
  kept.sort((a, b) => b.dispatchedAtMs - a.dispatchedAtMs);
  return { dispatches: kept.slice(0, limit), query, matched: joined.length };
}

/**
 * The OPEN delegations, newest first — what the per-turn preamble folds in.
 *
 * Separate from {@link recallDispatches} because it answers a different question and pays a
 * different price. Search reaches the whole ledger and includes finished work; this is a bounded
 * peek at what is live RIGHT NOW, called on every turn, and it must stay cheap enough that nobody is
 * ever tempted to cache it — a cached roster is the stamped-state bug again.
 */
export async function openDispatches(
  limit = 12,
  deps: RecallDeps = LIVE_RECALL_DEPS,
): Promise<RecalledDispatch[]> {
  const res = await recallDispatches({ includeClosed: false, limit }, deps);
  return res.dispatches;
}
