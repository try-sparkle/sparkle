// UNBLOCK THE WHOLE FLEET WHEN THE SUBSCRIPTION COMES BACK.
//
// ── THE FAILURE THIS CLOSES (founder, measured; PRD/sparkle/claude-account-identity-truth.md §6) ─
// "A lot of the agents are stuck because they hit session limits. I've relogged in on one but the
// others are still showing green, and yet they are all stuck… anytime the subscription gets
// unblocked, the session limit, it needs to restart up all of the build agents that got stuck."
//
// Nothing did that. `nudger.rs` SEES the session-limit picker and correctly refuses to type into it
// (`Refusal::AwaitingInput`) — the one layer that can see the problem is forbidden to act on it. It
// escalates instead, and `nudger://escalation` / `nudger_flags` had ZERO TypeScript listeners
// (bead sparkle-4cd0x): the deterministic layer flagged into a void. And nothing watched for auth
// recovery at all — the only mid-session release is a human typing to ONE agent
// (`noteUserInput` → `releaseQuotaBlock`), which is exactly why re-logging in on one terminal left
// the others stuck.
//
// ── MODEL-FREE, NON-NEGOTIABLE ────────────────────────────────────────────────────────────────
// `claude_oneshot` is gated by the SAME account limit, so a background model call is not an escape
// hatch: any feature that reports on an outage dies with the fleet if it composes with a model.
// Everything in this module is deterministic — a diff, a ladder comparison, and a pane restart.
// The concierge may narrate afterwards if it happens to be alive; nothing here waits on it.
//
// ── THE TRIGGER IS A REASON CODE, NEVER THE BARE BAND ─────────────────────────────────────────
// This is the single most important correctness rule in the module. `waiting` is the app's most
// common attention state — any mid-stream question sets it, and the idle-only screen escalation
// sets it for permission dialogs, AskUserQuestion menus and `/model` pickers. Acting on the band
// alone would send `Esc` to every correlated agent sitting at a legitimate dialog, cancelling a
// tool approval the human was mid-answer on. Account correlation does NOT narrow this, because a
// fleet is typically all on one account. So the ONLY thing that registers an agent as recoverable
// is the PAIR `status === "waiting" && reason === SESSION_LIMIT_REASON`, funnelled through the one
// predicate {@link isSessionLimitStuck}.
//
// This module does not import W-DETECT's classifier. It consumes the reason code W-DETECT publishes.
//
// ── THE CHANNEL IS `StatusTransition.reason`, NOT THE EVENT ──────────────────────────────────
// §6c permits either a `StatusTransition` field or a dedicated `sparkle://session-limit-picker`
// event, and requires the worker to pick one AND SAY WHICH. It is the transition field:
// `statusRouter` puts the reason on the record, `AgentPane`'s `onTransition` sink hands it to
// {@link noteAgentStatus}, and that is the only path by which an agent is ever registered.
//
// The event lost on SEMANTICS, not on plumbing. It is edge-triggered on the SCREEN, so a listener
// keyed on it un-registers an agent the instant `Esc` dismisses the dialog — before anything knows
// whether the resume took — and §6c's non-negotiable #4 requires the stuck state to persist until
// POSITIVE PROGRESS. Only the router's latch has that property: it drops on a real tool event or
// new agent output and on nothing else. `statusEngine` still dispatches the event as a DOM
// `CustomEvent` for narration; NOTHING in this module reads it.
//
// {@link noteAgentStatus} is the same funnel for in-process callers.
//
// ── THE KEYSTROKE SAFETY RULE ─────────────────────────────────────────────────────────────────
// The only key any path here may cause to be sent at that picker is `Esc` (cancel), and it is not
// even sent from this module: the fallback calls a Rust command whose own gate
// (`nudge_gate::escape_refusal`) re-derives the screen verdict independently and writes exactly
// `nudge_gate::ESCAPE_KEY`. NO numbered option is ever machine-sent, under any recovery path, ever
// — options 2 and 3 on that picker move the user onto paid overage and change their subscription.
// The PRIMARY path never touches the dialog at all: it re-spawns the pane, which resumes the
// conversation with `--resume <session-id>` and leaves the picker unanswered on a dead PTY.
//
// ── VERIFY, DO NOT ASSUME ─────────────────────────────────────────────────────────────────────
// W-DETECT holds the row at `waiting` until real progress, so a resume that silently fails must
// stay visible. Every attempt is therefore checked after {@link VERIFY_WINDOW_MS}: an agent still
// registered stuck at that point is reported as a FAILED recovery
// (`sparkle://auth-recovery-result`), never quietly forgotten and never flipped green from here.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { AgentTabStatus } from "../types";
import { getIdentities, listAccounts, type Account, type Identity } from "./accountStore";
import { isSafeToSwitch, moveAgent } from "./accountSwitch";
import { paneAccountMap, restartPane } from "./paneControl";
import { safeUnlisten } from "./safeUnlisten";
import type { NudgeFlagSnapshot } from "./humanBlockFor";
import { useRuntimeStore } from "../stores/runtimeStore";
import {
  AUTH_RECOVERED_EVENT,
  AUTH_RECOVERY_RESULT_EVENT,
  SESSION_LIMIT_REASON,
  type AuthRecoveredPayload,
} from "./sessionLimitScreen";

// ── TUNABLES ──────────────────────────────────────────────────────────────────────────────────

/** How often the identity reader runs. A re-login is a human action measured in minutes, and this
 *  reader is the fallback for a ledger that pushes; 20s is responsive without being a busy poll. */
export const IDENTITY_POLL_MS = 20_000;

/** How often `nudger_flags` is PULLED. The Rust side emits `nudger://escalation` too, but its own
 *  header is explicit that the event is "an optimisation on top, not the channel": an event alone
 *  is lost across a WebView reload, and the consumer of these flags is a loop whose whole job is to
 *  notice things that got lost. */
export const FLAG_POLL_MS = 30_000;

/** How long a resume gets to produce real progress before it is reported FAILED. Generous, because
 *  a re-spawned Claude Code has to start, resume its session and emit its first output. */
export const VERIFY_WINDOW_MS = 45_000;

/** Minimum gap between two recovery attempts on the SAME agent. Without it, a flapping identity
 *  read (or two recovery sources firing together) would restart a pane repeatedly, and a pane that
 *  is restarted while it is starting never gets far enough to report progress. */
export const ATTEMPT_COOLDOWN_MS = 90_000;

// ── IDENTITY, AND THE LADDER ──────────────────────────────────────────────────────────────────

/** One account's resolved identity, keyed by the config dir it lives behind. */
export interface ResolvedIdentity {
  accountId: string;
  configDir: string;
  accountUuid: string | null;
  email: string | null;
}

/** Is this identity resolvable at all? Neither a uuid nor an email means a dir never logged into,
 *  and §4a's ladder ends "either side unresolvable → NO match, report nothing". */
export function isResolvable(id: ResolvedIdentity | undefined): id is ResolvedIdentity {
  return !!id && (id.accountUuid != null || id.email != null);
}

/** THE §4a LADDER, and the only comparison this module makes.
 *
 *  1. both uuids present → same iff they are equal;
 *  2. either uuid absent → compare EMAILS; same iff both are present and equal;
 *  3. either side unresolvable → NO match.
 *
 *  A bare `uuid === uuid` would be wrong in both directions and the docs say so: `account_uuid` is
 *  `None` on logins predating the field, so uuid-only matching silently matches NOTHING for those
 *  accounts — the recovery would resume nobody and look like it simply never fires. */
export function identitiesMatch(
  a: ResolvedIdentity | undefined,
  b: ResolvedIdentity | undefined,
): boolean {
  if (!isResolvable(a) || !isResolvable(b)) return false;
  if (a.accountUuid != null && b.accountUuid != null) return a.accountUuid === b.accountUuid;
  if (a.email != null && b.email != null) return a.email === b.email;
  return false;
}

/** Join accounts to identities. `Identity.id` IS the account id — the config dir only exists on the
 *  `Account` row, which is why this join is needed at all and why the recovery payload can carry
 *  `configDir` as §6d requires. */
export function resolveIdentities(
  accounts: Account[],
  identities: Identity[],
): Map<string, ResolvedIdentity> {
  const byId = new Map(identities.map((i) => [i.id, i]));
  const out = new Map<string, ResolvedIdentity>();
  for (const a of accounts) {
    const i = byId.get(a.id);
    out.set(a.id, {
      accountId: a.id,
      configDir: a.configDir,
      accountUuid: i?.accountUuid ?? null,
      email: i?.email ?? null,
    });
  }
  return out;
}

/** Which config dirs saw an identity APPEAR or CHANGE — §2's identity-epoch transition, computed
 *  from two snapshots.
 *
 *  A previously-unresolvable dir that is now resolvable counts (that is a fresh `claude auth
 *  login`), and so does a dir whose identity no longer matches the one we last saw. A dir that is
 *  unchanged by the ladder does NOT count — see {@link peerProgressRecovery} for the case the
 *  founder actually hit, where the SAME account is re-logged-in and every field is identical. */
export function identityRecoveries(
  prev: Map<string, ResolvedIdentity>,
  next: Map<string, ResolvedIdentity>,
): ResolvedIdentity[] {
  const out: ResolvedIdentity[] = [];
  for (const [id, now] of next) {
    if (!isResolvable(now)) continue;
    const before = prev.get(id);
    if (!isResolvable(before) || !identitiesMatch(before, now)) out.push(now);
  }
  return out;
}

// ── THE STUCK REGISTRY ────────────────────────────────────────────────────────────────────────

/** THE ONE PREDICATE. Nothing else in this module decides whether an agent is a candidate.
 *
 *  Both halves are required and the reason code is the load-bearing one: an agent at `waiting` for
 *  an ordinary permission dialog must never be touched. */
export function isSessionLimitStuck(status: AgentTabStatus | string, reason?: string): boolean {
  return status === "waiting" && reason === SESSION_LIMIT_REASON;
}

interface StuckAgent {
  agentId: string;
  since: number;
  /** Epoch ms of the last resume attempt, for the cooldown. */
  lastAttemptAt?: number;
}

/** The one raised nudger flag per agent, as `nudger.rs` publishes it. Mirrors `NudgeFlag`. */
export interface NudgeFlag {
  agentId: string;
  target: string;
  raisedAtMs: number;
  nudges: number;
  delivered: number;
  blockedBy: string | null;
  silentSecs: number;
  /** The agent's OWN one-line answer to the nudge — "blocked-on-human" | "blocked-on-ci" |
   *  "blocked-on-another-agent" | "blocked-on-quota" | "not-blocked" — or null if it never answered.
   *
   *  NOT the same question as `blockedBy`, which is why WE could not type at it (a picker, a parked
   *  reader). This is what the AGENT says is stopping IT. Optional so a flag raised by a Rust build
   *  that predates the field still parses. */
  reply?: string | null;
  /** The STAND-DOWN the ladder concluded — `"login-expired"`, `"blocked-on-quota"`,
   *  `"blocked-on-human"`, `"no-task-assigned"`, `"out-of-context"`, … — or null when the ladder is
   *  simply climbing.
   *
   *  A THIRD, DISTINCT fact from `reply` and `blockedBy`, and the only one of the three that
   *  survives an agent being unable to SPEAK. A dead Claude session (`Login expired · Please run
   *  /login`) leaves `reply` null by construction — answering costs the API call that is failing —
   *  and `blockedBy` null too, because the gate had no objection, we simply chose not to write. By
   *  those two fields' own contracts that row reads "quiet for a while, cause unknown", which is
   *  exactly the silence a founder watched four consecutive nudges produce. This is where the cause
   *  arrives. */
  standdown?: string | null;
  /** WHICH LOGIN a human has to fix, when that is the problem — a nickname plus its
   *  `CLAUDE_CONFIG_DIR`, resolved on the Rust side from the PTY's spawn arguments.
   *
   *  Only populated for a `standdown === "login-expired"` row; null everywhere else. Do NOT read a
   *  null as "the default account": the label deliberately conflates nothing, and a null here means
   *  the account could not be identified at all (no PTY session, unreadable `accounts.json`, or a
   *  Rust build predating the field). Sending someone to re-authenticate the wrong login is worse
   *  than telling them it is unknown. */
  account?: string | null;
}

/** What a recovery attempt did, per agent. Emitted on {@link AUTH_RECOVERY_RESULT_EVENT}. */
export interface RecoveryOutcome {
  agentId: string;
  accountId: string;
  /** `"restart"` — the pane was re-spawned (`--resume`, conversation preserved).
   *  `"escape"` — no pane was mounted, so the Rust gate was asked to send its single `Esc`.
   *  `"deferred"` — the agent was `working`; switching would lose in-flight work.
   *  `"cooldown"` — attempted too recently. */
  /** `"escape-failed"` is distinct from `"escape"` on purpose: this trail is what an operator reads
   *  to decide whether recovery works, so it must never claim an action that did not happen. The
   *  Rust gate may also REFUSE on its own screen read — that surfaces as a rejection, i.e. here. */
  action: "restart" | "escape" | "escape-failed" | "deferred" | "cooldown";
  /** Set at verification time: did the agent actually leave the stuck state? `null` until then. */
  progressed: boolean | null;
  source: RecoverySource;
}

/** Where the recovery signal came from. Logged, and carried on the outcome, because "the identity
 *  behind a config dir changed" and "a peer agent on this account started moving again" are
 *  different amounts of evidence and an operator reading the trail should be able to tell them
 *  apart. */
export type RecoverySource = "identity-change" | "peer-progress" | "external-event";

// ── MODULE STATE ──────────────────────────────────────────────────────────────────────────────

const stuck = new Map<string, StuckAgent>();
const flags = new Map<string, NudgeFlag>();
let lastIdentities = new Map<string, ResolvedIdentity>();
/** Set once the first identity snapshot has been read. Before that there is no "previous" state,
 *  and treating an empty map as the previous one would report every signed-in account as a fresh
 *  recovery on boot and restart the whole fleet. */
let identitiesSeeded = false;

// ── DEPENDENCIES, INJECTED ────────────────────────────────────────────────────────────────────
// Every side effect goes through this table so the tests assert what was actually DONE rather than
// re-stating the decision. `sendEscape` in particular must be observable: the safety test asserts
// the byte alphabet of everything this module can cause to be written.

export interface AuthRecoveryDeps {
  listAccounts: () => Promise<Account[]>;
  getIdentities: () => Promise<Identity[]>;
  paneAccounts: () => Record<string, string | undefined>;
  agentStatus: (agentId: string) => AgentTabStatus | undefined;
  restart: (agentId: string) => boolean;
  /** Asks RUST to send its single `Esc`. Never sends a key from JS, and never sends anything but
   *  this — the Rust side re-derives the screen verdict and writes `nudge_gate::ESCAPE_KEY`. */
  sendEscape: (agentId: string) => Promise<void>;
  clearNudgeFlag: (agentId: string) => Promise<void>;
  readNudgeFlags: () => Promise<NudgeFlag[]>;
  emitEvent: (name: string, payload: unknown) => Promise<void>;
  now: () => number;
  log: (msg: string, detail?: unknown) => void;
}

const realDeps: AuthRecoveryDeps = {
  listAccounts,
  getIdentities,
  paneAccounts: paneAccountMap,
  // The recovery path only ever needs "is this agent `working`". An agent the roster has not
  // reported on reads `undefined`, which `isSafeToSwitch` treats as safe — the right default,
  // because the alternative is refusing to unstick an agent purely because the roster is quiet.
  //
  // `runtimeStore`, NOT `projectStore`: live status is not a field on `AgentTab` at all (it is
  // live-only and never persisted, which is exactly why it lives in the runtime store). Reading
  // `a.status` off the project row did not compile.
  agentStatus: (agentId) => useRuntimeStore.getState().status[agentId],
  restart: restartPane,
  sendEscape: (agentId) => invoke("nudger_send_escape", { agentId }),
  clearNudgeFlag: (agentId) => invoke("nudger_clear_flag", { agentId }),
  readNudgeFlags: () => invoke<NudgeFlag[]>("nudger_flags"),
  emitEvent: (name, payload) => emit(name, payload),
  now: () => Date.now(),
  log: (msg, detail) => console.info(`[authRecovery] ${msg}`, detail ?? ""),
};

let deps: AuthRecoveryDeps = realDeps;

/** Test seam. Also resets the registries, so no test inherits another's stuck agents. */
export function __setAuthRecoveryDeps(next: Partial<AuthRecoveryDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
  stuck.clear();
  // ⚠️ THROUGH THE HELPER, NOT A BARE `flags.clear()` (roborev 65432). `publishFlagSnapshot` is the only
  // writer of the snapshot, so a clear that skips it leaves `flagSnapshot` holding the PREVIOUS
  // test's flags — and this seam's own docstring promises the opposite. It bit end to end: a suite
  // that reset via `readNudgeFlags: () => []` then polled got `list.length === flags.size === 0`, so
  // `tableChanged` answered false, no bump happened, and the snapshot kept a `blocked-on-human` flag
  // for the rest of the file. `nudgeFlagFor(id)` then said undefined while the snapshot said
  // founder/blocked-on-human — two readers of one table disagreeing in the same render, which is the
  // failure class this whole branch exists to close.
  clearNudgeFlagTable();
  lastIdentities = new Map();
  identitiesSeeded = false;
  // PENDING VERIFICATIONS TOO (roborev 58167). Without this they survive into the next test, and
  // `__flushVerifications` iterates in Map insertion order — oldest first — emitting every stale
  // verdict through the CURRENT harness's `emitEvent`. A test asserting on "the verified event"
  // then reads an EARLIER test's outcome list. Measured: the flush test saw six verified events,
  // the first being another test's, and only passed on a retry.
  for (const t of [...pendingVerifications.keys()]) clearTimeout(t);
  pendingVerifications.clear();
}

// ── INGEST ────────────────────────────────────────────────────────────────────────────────────

/** THE FUNNEL. Every status report — from the dedicated event or from an in-process caller —
 *  arrives here, and only the reason-code pair registers an agent.
 *
 *  A report that is NOT the pair also un-registers: that is how progress is observed, and it is the
 *  same fact {@link peerProgressRecovery} keys the founder's case on. */
export function noteAgentStatus(
  agentId: string,
  status: AgentTabStatus | string,
  reason?: string,
): void {
  if (isSessionLimitStuck(status, reason)) {
    if (!stuck.has(agentId)) {
      stuck.set(agentId, { agentId, since: deps.now() });
      deps.log(`agent registered stuck at the session-limit picker: ${agentId}`);
    }
    return;
  }
  if (!stuck.has(agentId)) return;

  // ── WHICH NON-PAIR TRANSITIONS ARE PROGRESS, AND WHICH ARE NOT ──────────────────────────────
  //
  // `working` ONLY. Un-registering on any non-pair status read `errored` as progress, and `errored`
  // is REACHABLE while the pierce is latched — a crashed process or an API banner on top of the
  // picker. Three things went wrong at once (roborev 58167): the crashed agent dropped out of the
  // registry so a real recovery would never resume it; `peerProgressRecovery` fired on the strength
  // of an agent that DIED, restarting every walled peer into a still-live wall and burning their
  // 90s cooldown so the genuine recovery then reported `cooldown` and did nothing; and
  // `runVerification` reported `progressed: true` for an agent that provably did not progress —
  // the exact "claim an outcome that did not happen" failure this module exists to avoid.
  //
  // This mirrors the router's own `clearedByProgress`, deliberately: the two must agree on what
  // counts, or the row and the registry drift. A screen or hook `working` is the only positive
  // evidence — a walled agent prints nothing and the spinner only redraws while a turn runs.
  if (status === "working") {
    stuck.delete(agentId);
    // A previously-stuck agent that MOVED is the measured evidence that its account's limit lifted.
    void peerProgressRecovery(agentId);
    return;
  }
  // STILL STUCK, DIFFERENT BAND. `errored` keeps the registration so a later recovery still covers
  // it and `runVerification` still reports it honestly as not-progressed.
  if (status === "errored") return;
  // Anything else is a run that ENDED — the router's `reset()` drops the latch on a re-prepare, so
  // a fresh `idle` can reach this sink. Drop the entry, but claim no progress: nothing here
  // observed the wall lift, so releasing this account's peers on it would be a guess.
  stuck.delete(agentId);
}

/** Agents currently registered stuck. Exported for the concierge / pusher to narrate. */
export function stuckAgentIds(): string[] {
  return [...stuck.keys()];
}

/** The nudger flag raised for an agent, if any. A flag NEVER triggers a resume on its own — the
 *  nudger escalates for any silent agent, not for session-limit pickers specifically — but it is
 *  the deterministic layer's own record of the same stall, and `blockedBy === "awaiting-input"` is
 *  exactly the corroboration that this agent is sitting on an unanswered dialog. */
export function nudgeFlagFor(agentId: string): NudgeFlag | undefined {
  return flags.get(agentId);
}

// ── CORRELATION ───────────────────────────────────────────────────────────────────────────────

/** Which stuck agents belong to the recovered identity.
 *
 *  Mandatory, and not merely a filter: an auth recovery on account A must not resume an agent
 *  walled on account B straight back into a live wall. An agent whose account cannot be resolved to
 *  an identity resumes NOTHING — rung 3 of the ladder. */
export function correlateStuckAgents(
  recovered: ResolvedIdentity,
  paneAccounts: Record<string, string | undefined>,
  identities: Map<string, ResolvedIdentity>,
  candidates: string[],
): { agentId: string; accountId: string }[] {
  if (!isResolvable(recovered)) return [];
  const out: { agentId: string; accountId: string }[] = [];
  for (const agentId of candidates) {
    const accountId = paneAccounts[agentId];
    if (!accountId) continue;
    if (!identitiesMatch(identities.get(accountId), recovered)) continue;
    out.push({ agentId, accountId });
  }
  return out;
}

// ── THE RESUME ────────────────────────────────────────────────────────────────────────────────

/** Resume EVERY correlated stuck agent — the founder's core ask, and the reason this takes a list
 *  rather than an agent. */
async function resumeAll(
  recovered: ResolvedIdentity,
  source: RecoverySource,
): Promise<RecoveryOutcome[]> {
  const identities = lastIdentities;
  const targets = correlateStuckAgents(
    recovered,
    deps.paneAccounts(),
    identities,
    stuckAgentIds(),
  );
  if (targets.length === 0) return [];

  const outcomes: RecoveryOutcome[] = [];
  const now = deps.now();
  for (const { agentId, accountId } of targets) {
    const entry = stuck.get(agentId);
    if (entry?.lastAttemptAt != null && now - entry.lastAttemptAt < ATTEMPT_COOLDOWN_MS) {
      outcomes.push({ agentId, accountId, action: "cooldown", progressed: null, source });
      continue;
    }
    // `isSafeToSwitch` permits everything except `working`. A stuck agent reads `waiting`, so this
    // is a belt-and-braces check against a status that changed between registration and now —
    // re-spawning mid-turn would lose whatever it was doing.
    if (!isSafeToSwitch(deps.agentStatus(agentId))) {
      outcomes.push({ agentId, accountId, action: "deferred", progressed: null, source });
      continue;
    }
    if (entry) entry.lastAttemptAt = now;

    // PRIMARY: re-pin and re-spawn. This touches no billing dialog at all — the picker dies with
    // the old PTY — and `claudeSpawn` resumes with `--resume <session-id>`, so the conversation
    // survives. Pinning to the account the agent is ALREADY on is intentional and not a no-op: it
    // makes the choice explicit so the re-spawn cannot auto-pick a different, still-walled account.
    const restarted = moveAgent(agentId, accountId, deps.restart);
    let action: RecoveryOutcome["action"] = "restart";
    if (!restarted) {
      // FALLBACK, only where a restart is inappropriate — here, no pane is mounted to restart. Ask
      // Rust for its single `Esc`; its own gate refuses unless it independently recognises the
      // session-limit picker. After the dialog is dismissed the nudger's ordinary ladder takes over
      // and re-prompts the agent, with no model call anywhere on the path.
      action = "escape";
      try {
        await deps.sendEscape(agentId);
      } catch (e) {
        // THE OUTCOME MUST NOT CLAIM AN ACTION THAT DID NOT HAPPEN (roborev 58141). This trail is
        // what an operator reads to decide whether recovery works at all; a swallowed rejection
        // recorded as `escape` would make a path that never fired look like one that did — the
        // same "assume, don't verify" failure the module header rules out for the resume itself.
        deps.log(`escape fallback failed for ${agentId}`, e);
        action = "escape-failed";
      }
    }
    // The deterministic layer's flag described this same stall; we have now acted on it. Leaving it
    // up would have the pusher chase an agent already handled, and a channel that reports resolved
    // problems stops being read.
    if (forgetNudgeFlagLocally(agentId)) {
      void deps.clearNudgeFlag(agentId).catch(() => {});
    }
    outcomes.push({ agentId, accountId, action, progressed: null, source });
  }

  deps.log(
    `recovery (${source}) acted on ${outcomes.length} agent(s) for ${recovered.configDir}`,
    outcomes.map((o) => `${o.agentId}:${o.action}`),
  );
  await deps.emitEvent(AUTH_RECOVERY_RESULT_EVENT, { phase: "attempted", source, outcomes });
  scheduleVerification(outcomes, source);
  return outcomes;
}

// ── VERIFICATION ──────────────────────────────────────────────────────────────────────────────

const pendingVerifications = new Map<
  ReturnType<typeof setTimeout>,
  { acted: RecoveryOutcome[]; source: RecoverySource }
>();

/** Check, after {@link VERIFY_WINDOW_MS}, whether each agent actually left the stuck state.
 *
 *  An agent still registered stuck at that point had its resume FAIL — the pane restarted and hit
 *  the wall again, or the Esc never landed. It is reported as such and stays visible; nothing here
 *  marks a row green, and W-DETECT holds the band at `waiting` until real progress regardless. */
function scheduleVerification(outcomes: RecoveryOutcome[], source: RecoverySource): void {
  const acted = outcomes.filter((o) => o.action === "restart" || o.action === "escape");
  if (acted.length === 0) return;
  const t = setTimeout(() => void runVerification(t), VERIFY_WINDOW_MS);
  // Never hold the process open for a verification tick.
  (t as unknown as { unref?: () => void }).unref?.();
  pendingVerifications.set(t, { acted, source });
}

/** THE VERDICT ITSELF, named and reachable from both the timer and {@link __flushVerifications}.
 *
 *  It used to live inline in the `setTimeout` callback, and the flush helper only cleared the timers
 *  — so a test written against that helper asserted nothing about the verify-don't-assume rule the
 *  module header calls non-negotiable, while appearing to cover it (roborev 58141). One
 *  implementation, two callers, so the test exercises the real thing. */
async function runVerification(handle: ReturnType<typeof setTimeout>): Promise<void> {
  const pending = pendingVerifications.get(handle);
  pendingVerifications.delete(handle);
  if (!pending) return;
  const { acted, source } = pending;
  // Still registered stuck ⇒ the resume did NOT take: the pane restarted into the same wall, or the
  // Esc never landed. Reported, never quietly forgotten, and nothing here paints a row green.
  const verified = acted.map((o) => ({ ...o, progressed: !stuck.has(o.agentId) }));
  const failed = verified.filter((o) => !o.progressed);
  if (failed.length > 0) {
    deps.log(
      `recovery did NOT take for ${failed.length} agent(s)`,
      failed.map((o) => o.agentId),
    );
  }
  await deps.emitEvent(AUTH_RECOVERY_RESULT_EVENT, { phase: "verified", source, outcomes: verified }).catch(() => {});
}

/** Test/teardown helper: run every pending verification NOW, exactly as the timer would. Exported
 *  because the alternative — fake timers around a module-level `setTimeout` — makes the assertion
 *  about the timer rather than about the verdict. */
export async function __flushVerifications(): Promise<void> {
  for (const t of [...pendingVerifications.keys()]) {
    clearTimeout(t);
    await runVerification(t);
  }
}

// ── THE RECOVERY SOURCES ──────────────────────────────────────────────────────────────────────

/** Announce a recovery on `sparkle://auth-recovered` and remember that WE emitted it.
 *
 *  The module also LISTENS for that event (the Rust identity-epoch ledger will emit it once it
 *  lands), so without this the two in-module sources would re-enter through their own announcement
 *  and attempt every agent twice. The cooldown would absorb the second pass, but relying on a
 *  cooldown to paper over a loop is not a design — and it would make the attempt COUNT in the
 *  outcome trail wrong, which is the record an operator reads to decide whether recovery works. */
async function announceRecovery(id: ResolvedIdentity): Promise<void> {
  const payload: AuthRecoveredPayload = {
    configDir: id.configDir,
    accountUuid: id.accountUuid,
    email: id.email,
  };
  const key = payloadKey(payload);
  selfEmitted.add(key);
  // Keyed rather than a single flag, so two accounts recovering in the same tick cannot suppress
  // each other. The window only has to outlive the event round-trip.
  const t = setTimeout(() => selfEmitted.delete(key), SELF_EMIT_WINDOW_MS);
  (t as unknown as { unref?: () => void }).unref?.();
  await deps.emitEvent(AUTH_RECOVERED_EVENT, payload);
}

const SELF_EMIT_WINDOW_MS = 5_000;
const selfEmitted = new Set<string>();
/** The separator is U+001F (ASCII Unit Separator) written as an ESCAPE, deliberately.
 *
 *  It was a RAW U+0000 byte, which made this whole source file binary to standard tooling — `file`
 *  reported `data`, `grep` answered "Binary file … matches" instead of printing, and a diff rendered
 *  the NULs as ordinary spaces, so no reviewer could see them (roborev 58141). U+001F cannot occur
 *  in a config path, a uuid or an email, and spelled as an escape it survives an editor that trims
 *  or normalizes control characters. */
function payloadKey(p: AuthRecoveredPayload): string {
  return `${p.configDir}\u001f${p.accountUuid ?? ""}\u001f${p.email ?? ""}`;
}

/** Did this module emit that payload moments ago? Exported so the listener's suppression is
 *  assertable rather than inferred from a call count. */
export function wasSelfEmitted(p: AuthRecoveredPayload): boolean {
  return selfEmitted.has(payloadKey(p));
}

/** Source 1: the identity behind a config dir appeared or changed.
 *
 *  §6d says to read Worker 1's identity-epoch ledger (`<app_data>/account-identity-log.json`)
 *  rather than invent a second source of truth. That ledger has not landed in this worktree, so
 *  this reads `accounts_identities` and diffs per config dir — the same transition, computed here
 *  instead of there. IT IS DELIBERATELY THE ONLY PLACE THAT READS IDENTITIES: swapping to the
 *  ledger is a change to this one function's body and nothing else. */
export async function readIdentitySnapshot(): Promise<Map<string, ResolvedIdentity>> {
  const [accounts, identities] = await Promise.all([deps.listAccounts(), deps.getIdentities()]);
  return resolveIdentities(accounts, identities);
}

/** One identity poll: read, diff, and recover for anything that changed. */
export async function pollIdentities(): Promise<RecoveryOutcome[]> {
  let next: Map<string, ResolvedIdentity>;
  try {
    next = await readIdentitySnapshot();
  } catch (e) {
    deps.log("identity read failed; nothing recovered", e);
    return [];
  }
  const prev = lastIdentities;
  lastIdentities = next;
  if (!identitiesSeeded) {
    // FIRST read establishes the baseline. Diffing against an empty map would report every
    // signed-in account as a fresh recovery and restart the entire fleet on boot.
    identitiesSeeded = true;
    return [];
  }
  const out: RecoveryOutcome[] = [];
  for (const recovered of identityRecoveries(prev, next)) {
    await announceRecovery(recovered);
    out.push(...(await resumeAll(recovered, "identity-change")));
  }
  return out;
}

/** Source 2: a PEER agent on the same account started moving again.
 *
 *  This is the founder's literal case and the identity diff cannot see it. Re-logging into the SAME
 *  Anthropic account rewrites `.claude.json` with an IDENTICAL uuid and email, so
 *  {@link identityRecoveries} correctly reports no change — yet the wall is demonstrably down,
 *  because one of the walled agents is producing output again. That agent leaving the stuck
 *  registry IS the measurement, and it is exactly as deterministic as the diff: no model, no
 *  heuristic about PTY text, just "an agent that was at the picker is not at the picker any more".
 *
 *  It is correlated like everything else, so a peer moving on account A never resumes an agent
 *  walled on account B. */
async function peerProgressRecovery(movedAgentId: string): Promise<void> {
  if (stuck.size === 0) return;
  const accountId = deps.paneAccounts()[movedAgentId];
  if (!accountId) return;
  const identity = lastIdentities.get(accountId);
  if (!isResolvable(identity)) return;
  deps.log(`peer ${movedAgentId} moved; releasing its account's remaining stuck agents`);
  await announceRecovery(identity);
  await resumeAll(identity, "peer-progress");
}

/** Source 3: somebody else emitted `sparkle://auth-recovered` (the Rust identity-epoch ledger, once
 *  it lands, or a future manual "I've logged back in" affordance). Correlated identically. */
export async function onAuthRecovered(payload: AuthRecoveredPayload): Promise<RecoveryOutcome[]> {
  const match = [...lastIdentities.values()].find(
    (i) =>
      i.configDir === payload.configDir ||
      identitiesMatch(i, {
        accountId: "",
        configDir: payload.configDir,
        accountUuid: payload.accountUuid,
        email: payload.email,
      }),
  );
  if (!isResolvable(match)) {
    deps.log("auth-recovered for an identity we cannot resolve; resuming nothing", payload);
    return [];
  }
  return resumeAll(match, "external-event");
}

// ── NUDGER FLAGS — THE LISTENER THAT DID NOT EXIST ────────────────────────────────────────────

/**
 * Notified whenever the flag table CHANGES, so React can re-render on a signal that lives in a plain
 * module-level Map. The `subscribe` half of `useSyncExternalStore`.
 *
 * ⚠️ THE VERSION COUNTER THAT USED TO SIT HERE IS GONE (bead sparkle-qg71dl). `nudgeFlagsVersion()`
 * was the pre-snapshot spelling of this signal and, once the derivations took the snapshot instead,
 * its only importer was this module's own test — so the exported accessor asserted a number nothing
 * in a running app ever read, and `scripts/dormant-exports.mjs` says so. Deleting it is
 * behaviour-preserving because {@link publishFlagSnapshot} — which was called `bumpFlagVersion` for
 * the counter, and is renamed here so it stops naming a thing that no longer exists — already
 * notifies through `flagListeners` and replaces `flagSnapshot`; the counter was a second, unread
 * copy of the same fact. The tests now
 * assert snapshot IDENTITY, which is what `useSyncExternalStore` actually compares.
 *
 * ⚠️ WITHOUT THIS THE FLAG IS INVISIBLE TO THE UI, AND SILENTLY SO (roborev 65339, a Medium). The
 * table is filled by a Tauri event listener and a 30s poll — neither of which is a store, so nothing
 * a component selects on changes when a flag arrives. `engine/humanBlock` reads it during render to
 * colour a row RED, and the sidebar's memo deps (`agentsById`, `calmStatus`, `branchStatus`,
 * `workflowState`, `workflowStage`) do not move on a flag. The row would therefore flip only when
 * some unrelated dep happened to change identity — and the targeted population is precisely agents
 * that are SILENT, whose status and branch facts are static by definition. So the very rows this
 * signal exists for are the ones least likely to repaint.
 *
 * `quotaBlockForAgent` gets away with the same shape because its updates coincide with a StatusEngine
 * status write that re-renders anyway. This one has no such companion.
 */
const flagListeners = new Set<() => void>();

/**
 * An immutable view of the flag table, REPLACED (never mutated) on every change.
 *
 * ⚠️ THIS EXISTS SO A REACT DEP CANNOT BE DROPPED SILENTLY (roborev 65409). The version counter
 * alone was not enough: nothing in a hook body READ it, so `react-hooks/exhaustive-deps` called it
 * an "unnecessary dependency", and the remedy it suggests — delete it — silently restores the stale
 * derivation. A `void` reference plus a comment did not fix that; it is dead at runtime, so deleting
 * all of it changes no behaviour and no test fails. Handing the derivations a SNAPSHOT they actually
 * read makes the dependency load-bearing: drop it and the code does not compile, and the lint rule
 * demands it rather than objecting to it.
 *
 * A fresh `Map` per change is what makes `Object.is` a correct `useSyncExternalStore` comparison —
 * the live `flags` map is a stable reference mutated in place, so it can never signal anything.
 */
let flagSnapshot: NudgeFlagSnapshot = new Map();

/**
 * The current immutable flag table — the `getSnapshot` half of `useSyncExternalStore`.
 *
 * ⚠️ IT EXPOSES ONLY THE JUDGED FIELDS, AND THAT NARROWNESS IS A CORRECTNESS PROPERTY, not tidiness
 * (roborev 65432). The poll rewrites every entry each tick but bumps only when {@link flagIdentity}
 * moved — and that deliberately EXCLUDES `nudges`, `delivered`, `silentSecs` and `blockedBy`, so
 * that a counter climbing every 30s cannot make this a heartbeat again. The consequence is that in
 * the steady state the live `flags` map and this snapshot hold different objects for the same agent,
 * indefinitely. Exposing the whole `NudgeFlag` here would make that a trap: the first consumer to
 * render `silentSecs` ("silent for N minutes") or `blockedBy` would read a value frozen at the last
 * identity change — 60s forever while the live table said four hours — and disagree with
 * `nudgeFlagFor(id)` read on the same tick.
 *
 * Typing it as the fields that ARE change-detected makes a stale read impossible to write. Anything
 * needing the counters must read the live table and accept that it is not a React signal.
 */
export function nudgeFlagsSnapshot(): NudgeFlagSnapshot {
  return flagSnapshot;
}

/** Subscribe to flag-table changes. Returns an unsubscribe, matching `useSyncExternalStore`. */
export function subscribeNudgeFlags(cb: () => void): () => void {
  flagListeners.add(cb);
  return () => flagListeners.delete(cb);
}

function publishFlagSnapshot(): void {
  // Rebuilt here rather than at each mutation site, so no writer can forget it and every change
  // produces exactly one new identity.
  // Built from the judged fields only — see `nudgeFlagsSnapshot` for why exposing the counters here
  // would be a stale-read trap rather than a convenience.
  flagSnapshot = new Map(
    [...flags].map(([id, f]) => [
      id,
      {
        target: f.target,
        reply: f.reply,
        raisedAtMs: f.raisedAtMs,
        // ── THE TWO FIELDS THAT REACHED THE UI CORRECT AND UNREAD (bead sparkle-qg71dl) ────────
        // `standdown` is the only "what is wrong" field that survives an agent being unable to
        // SPEAK, and `account` is the whole reason `nudger::stamp_account` pays for a PTY-table plus
        // `accounts.json` read: it names WHICH of this machine's several logins a person has to
        // sign back into. Both crossed the IPC boundary intact and stopped at a module-level Map.
        standdown: f.standdown,
        account: f.account,
      },
    ]),
  );
  for (const cb of flagListeners) cb();
}

/**
 * Empty the flag table, notifying subscribers.
 *
 * The single spelling of EMPTYING the table — `__setAuthRecoveryDeps` routes through it so a reset
 * cannot leave `flagSnapshot` holding the previous test's flags (roborev 65432).
 *
 * ⚠️ NOT THE ONLY `flags.clear()` IN THE FILE, and the other one is fine: {@link pollNudgeFlags}
 * clears as part of a REWRITE and bumps via `tableChanged`, so it is already covered. Stated so the
 * next reader does not go hunting for a fourth site to route through here.
 */
export function clearNudgeFlagTable(): void {
  if (flags.size === 0 && flagSnapshot.size === 0) return;
  flags.clear();
  publishFlagSnapshot();
}

/**
 * Drop this agent's flag from the LOCAL table, notifying subscribers. Returns whether there was one.
 *
 * ⚠️ THE BUMP HERE IS LOAD-BEARING AND ONLY BECAME SO WHEN THE POLL STOPPED BUMPING UNCONDITIONALLY
 * (roborev 65405). This is a local mutation the poll can never observe as a change: the next read
 * returns a list that already MATCHES the mutated map, so `tableChanged` answers false and no bump
 * would ever happen for this clear. The row would keep its last-painted red until some unrelated dep
 * moved — worst on `resumeAll`'s `cooldown` and `escape-failed` arms, which delete the flag WITHOUT
 * restarting the pane, so nothing else moves either, on a population that is silent by definition.
 * "A red that will not go away is how the colour stops meaning anything."
 *
 * Exported so a test drives the SAME function production does, rather than a re-implementation of
 * it — the two-copies-of-one-rule failure this file has already taken twice.
 */
export function forgetNudgeFlagLocally(agentId: string): boolean {
  if (!flags.has(agentId)) return false;
  flags.delete(agentId);
  publishFlagSnapshot();
  return true;
}

function recordFlag(flag: NudgeFlag): void {
  flags.set(flag.agentId, flag);
  publishFlagSnapshot();
}

/** The fields a reader of this table branches on. Compared to decide whether a poll CHANGED
 *  anything — see {@link pollNudgeFlags}.
 *
 *  ⚠️ `standdown` AND `account` ARE HERE BECAUSE THE ACCOUNT ARRIVES ON A LATER LOOK THAN THE FLAG
 *  (bead sparkle-qg71dl). `nudger.rs` builds the flag on every refresh but stamps the login name
 *  only on the looks that need it — `stamp_account` costs a PTY-table plus `accounts.json` read, so
 *  `build_flag` carries the PREVIOUS value forward and a fresh `login-expired` row can be published
 *  with `account: null` and gain its name a look later. Nothing else about that row moves. Leave
 *  these two out and the poll answers "unchanged", no bump happens, and the pill keeps saying the
 *  login is unknown for as long as the row is up — the failure this whole bead is about, one layer
 *  further in.
 *
 *  The `\u0000` join predates them and is why growing the key is safe: an unseparated key would let
 *  one field's value end where the next begins and collide. */
function flagIdentity(f: NudgeFlag): string {
  return [
    f.agentId,
    f.target,
    f.reply ?? "",
    f.standdown ?? "",
    f.account ?? "",
    String(f.raisedAtMs),
  ].join("\u0000");
}

/** Did this poll actually change the table? */
function tableChanged(list: readonly NudgeFlag[]): boolean {
  if (list.length !== flags.size) return true;
  for (const f of list) {
    const current = flags.get(f.agentId);
    if (current === undefined || flagIdentity(current) !== flagIdentity(f)) return true;
  }
  return false;
}

/** Pull the flag table. See {@link FLAG_POLL_MS} for why a pull exists alongside the event. */
export async function pollNudgeFlags(): Promise<NudgeFlag[]> {
  try {
    const list = await deps.readNudgeFlags();
    // ⚠️ BUMP ON A CHANGE, NOT ON EVERY POLL (roborev 65367). Bumping unconditionally turned the
    // version into a 30-SECOND HEARTBEAT rather than a signal: every `useSyncExternalStore`
    // subscriber re-rendered every 30s on a completely idle app, which recreates `stallReportOf`,
    // recomputes the whole escalate → present → effective chain for every agent — the pass
    // `AgentSidebar.escalationCost.test` exists to ratchet — and re-renders every `AgentRow` THROUGH
    // its `memo` comparator, which a hook subscription bypasses. The cost landed hardest on the
    // quiet fleet that previously did nothing between polls.
    //
    // The de-escalation requirement does not need the heartbeat: a CLEARED flag IS a change (the
    // table shrinks), so change-detection still repaints a row back out of red — which is the arm
    // the test now pins, rather than pinning the churn itself.
    const changed = tableChanged(list);
    flags.clear();
    for (const f of list) flags.set(f.agentId, f);
    if (changed) publishFlagSnapshot();
    return list;
  } catch (e) {
    deps.log("nudger_flags read failed", e);
    return [];
  }
}

// ── MOUNT ─────────────────────────────────────────────────────────────────────────────────────

let started = false;

/** Start the watcher. Idempotent — StrictMode and HMR both double-mount, and two identity pollers
 *  would each see the other's snapshot as the baseline. Returns a teardown. */
export function startAuthRecovery(): () => void {
  if (started) return () => {};
  started = true;

  const unlisteners: Promise<() => void>[] = [];

  // NO LISTENER FOR THE PICKER EVENT HERE, and that is the corrected design (roborev 58141).
  //
  // This used to be `listen(SESSION_LIMIT_PICKER_EVENT)` — Tauri's IPC bus — subscribing to
  // something `statusEngine` publishes as a DOM `CustomEvent`, with a payload shape the handler
  // immediately discarded. It could never fire. But the bug was not just the bus: the screen-edge
  // event is the WRONG SIGNAL for this registry, because it says "the picker is on the grid", and
  // §6c requires the stuck state to persist until POSITIVE PROGRESS. Keyed on the screen edge, an
  // agent would be un-registered the instant `Esc` dismissed the dialog — before anyone knew
  // whether the resume took — which is the invisible-green state this whole change exists to end.
  //
  // The channel is `StatusTransition.reason`, delivered by `AgentPane`'s `onTransition` sink into
  // {@link noteAgentStatus}. The router LATCHES the pierce and drops it only on a real tool event
  // or new agent output, so registration and un-registration both carry the right meaning. The DOM
  // event `statusEngine` dispatches survives as a detection signal for narration; nothing here
  // depends on it.
  unlisteners.push(
    listen<AuthRecoveredPayload>(AUTH_RECOVERED_EVENT, (e) => {
      // Only act on a payload somebody ELSE emitted — see `announceRecovery`.
      if (e.payload && !wasSelfEmitted(e.payload)) void onAuthRecovered(e.payload);
    }),
  );

  // THE LISTENER THAT FLAGGED INTO A VOID (bead sparkle-4cd0x).
  unlisteners.push(listen<NudgeFlag>("nudger://escalation", (e) => e.payload && recordFlag(e.payload)));

  const identityTimer = setInterval(() => void pollIdentities(), IDENTITY_POLL_MS);
  const flagTimer = setInterval(() => void pollNudgeFlags(), FLAG_POLL_MS);
  // Seed the baseline immediately so the first real poll can diff against something.
  void pollIdentities();
  void pollNudgeFlags();

  return () => {
    started = false;
    clearInterval(identityTimer);
    clearInterval(flagTimer);
    for (const u of unlisteners) void safeUnlisten(u);
  };
}
