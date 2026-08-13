// deathRecordWriter — THE MOUNT for `engine/deathRecord`: gather what this window observed, classify
// it, and write the verdict where a dying app cannot erase it.
//
// `engine/deathRecord.classifyDeath` is pure and deliberately reads nothing — its header says the
// caller gathers the observation, and that is not a style preference. `classifyDeath`'s Gate 0
// exists because `engineRegistry`'s readers return `undefined` for BOTH "this agent is healthy" and
// "there is no pane for it in this window", so a classifier that reached into them ITSELF could not
// tell the two apart. Making `liveness` an input forces whoever calls it to say which it is. This
// module is that whoever.
//
// ── THE OPEN IS THE LOAD-BEARING WRITE, NOT THE CLOSE ─────────────────────────────────────────
// The ledger is open/close, opened at SPAWN, and the reason is the measured one: app restart is the
// largest single killer of agents in this app (54 `SessionEnd` in one minute on 2026-08-06 at 18:20,
// 49 more at 18:47), and it is exactly the case where the WebView gets no chance to write anything
// down. A design whose durability depended on a write AT death would lose its biggest case by
// construction. So `openDeathRecord` runs on every spawn, unconditionally and cheaply, and
// `agent_life::seal_stale_at` infers `app-restart` at the next launch from what was left open.
//
// ── NO MODEL CALL ON ANY PATH ─────────────────────────────────────────────────────────────────
// Inherited from everything it touches, and it holds here: this module is registry reads, one pure
// function, and one `invoke`.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import type { AgentGoal } from "../engine/agentGoal";
import {
  type BlockingTool,
  type DeathObservation,
  type Terminator,
  classifyDeath,
} from "../engine/deathRecord";
import type { DeathVerdict } from "../engine/deathTypes";
import {
  lastFailureForAgent,
  quotaBlockForAgent,
  recentFailureForAgent,
} from "../engine/engineRegistry";
import type { QuotaBlock } from "../engine/quotaBlock";
import { log } from "../logger";
import { useProjectStore } from "../stores/projectStore";
import {
  mergeOpenAgentIds,
  readPersistedOpenAgentIds,
  useRuntimeStore,
} from "../stores/runtimeStore";
import { type AgentLiveness, livenessOf } from "./agentLiveness";

/** Everything this module reaches for, as injected edges — so every rule below is testable without
 *  a Tauri host, a store, or a terminal. Same "PURE CORE, INJECTED EDGES" split
 *  `services/apiRecoveryRunner` uses. */
export interface DeathRecordDeps {
  quota: (agentId: string, now: number) => QuotaBlock | undefined;
  lastFailure: (agentId: string) => { message: string; at: number } | undefined;
  /**
   * The RETAINED API-error banner, bounded by recency — `engineRegistry.recentFailureForAgent`.
   *
   * Takes `now` for the same reason `quota` does: the window is applied against the clock this call
   * already read, so the classification cannot straddle two different readings of "now".
   */
  recentFailure: (agentId: string, now: number) => { message: string; at: number } | undefined;
  liveness: (agentId: string) => AgentLiveness;
  goal: (agentId: string) => AgentGoal | undefined;
  /**
   * The blocking tool from this agent's last `PreToolUse`, when there was one.
   *
   * DEFAULTS TO `undefined`, and that is sound rather than a stub — but only because of an
   * equivalence worth stating, since it looks like a hole. Without it a genuinely blocked agent
   * whose PTY exits classifies `unknown` instead of `blocked-on-human`, and
   * `deathTypes.isResurrectable` answers FALSE for both. So the resurrection behaviour is identical;
   * only the recorded label is less specific. The safe direction, in the one place where being
   * wrong would mean respawning an agent that is waiting on a person.
   *
   * It is a dep rather than a hardcoded `undefined` so the day a per-agent blocking-tool record
   * exists, this is one line. Deliberately NOT sourced from `runtimeStore.status` being
   * `questions`/`approval`: `deathRecord.ts` states outright that coupling a death classification to
   * a pill's colour would let a labelling change silently reclassify deaths.
   */
  blockingTool: (agentId: string) => BlockingTool | undefined;
  invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
  now: () => number;
}

/** The real edges. A function, not a constant, so each call reads current store state. */
export function liveDeps(): DeathRecordDeps {
  return {
    quota: quotaBlockForAgent,
    lastFailure: lastFailureForAgent,
    recentFailure: recentFailureForAgent,
    liveness: (agentId) => {
      const rt = useRuntimeStore.getState();
      // Built EXACTLY as `goalContinuationRunner` and `conciergeTools` build it: the in-memory set
      // goes stale between open()/close() across windows, so the persisted one is merged in.
      const openIds = new Set(
        mergeOpenAgentIds(rt.openAgentIds ?? [], readPersistedOpenAgentIds()),
      );
      return livenessOf(agentId, rt.status, openIds);
    },
    goal: (agentId) => {
      for (const p of useProjectStore.getState().projects) {
        const a = p.agents.find((agent) => agent.id === agentId);
        if (a) return a.goal;
      }
      return undefined;
    },
    blockingTool: () => undefined,
    invoke: (cmd, args) => tauriInvoke(cmd, args),
    now: () => Date.now(),
  };
}

/**
 * Open (or reopen) this agent's durable record. Called at SPAWN, always.
 *
 * NEVER THROWS. A ledger write is a recovery affordance, and a recovery affordance that can break
 * the thing it protects is worse than not having one — a rejected `invoke` here must not stop a
 * terminal from coming up. Returns whether the write landed, so a caller (and a test) can assert the
 * outcome rather than a spy.
 */
export async function openDeathRecord(
  agentId: string,
  projectId: string,
  worktree: string,
  deps: DeathRecordDeps = liveDeps(),
): Promise<boolean> {
  try {
    await deps.invoke("agent_life_open", { agentId, projectId, worktree });
    return true;
  } catch (e) {
    log.warn("resurrection", "could not open the agent-life record", {
      agentId,
      error: String(e),
    });
    return false;
  }
}

/**
 * WHAT THE RETIRER WAS LOOKING AT — the durable half of the concierge's `retire_agent` verb.
 *
 * Mirrors `agent_life::RetiredEvidence`. The concierge closes finished agents unattended and with NO
 * cap; the founder's condition for that is a record he can read afterwards, and it has to outlive an
 * app restart, which is why it goes to the ledger rather than to the in-memory concierge audit log.
 *
 * ── EVERY OPTIONAL FIELD IS `?: T | null`, NOT `?: T` (AGENTS.md, and it is load-bearing) ──────
 * A Rust `Option` crosses the wire as `null` unless its field carries `skip_serializing_if`, and
 * TypeScript's `?: T` means `T | undefined` — which does NOT include `null`. A type written `?: T`
 * therefore describes a shape the wire can produce and the parser rejects. Read `null` and absent as
 * the SAME thing; the Rust side accepts both on the way in (`the_wire_accepts_both_an_explicit_null_
 * and_an_omitted_key` pins that) and omits unknown fields on the way out.
 *
 * `worktreeRisk` and `retroStanding` carry an explicit `"unknown"` rather than defaulting to the
 * reassuring value: a reading that FAILED must never be indistinguishable from one that came back
 * safe.
 */
export type RetiredEvidence = {
  worktreeRisk: "clean" | "dirty" | "unknown";
  landed?: boolean | null;
  stage?: string | null;
  branch?: string | null;
  ahead?: number | null;
  retroStanding: "settled" | "reported" | "unknown" | "absent";
  gapReceiptWritten: boolean;
  /** VERBATIM live-scrollback excerpt. Never trimmed or normalised on either side of the wire. */
  terminalEvidence?: string | null;
  /** Epoch ms at which the excerpt above was read. */
  terminalEvidenceObservedAt?: number | null;
};

/**
 * Retire an agent's durable record, stamped with WHO did it and what they acted on.
 *
 * ── THE RETURN VALUE IS A GATE, NOT A LOG LINE ────────────────────────────────────────────────
 * `true` means the durable write ACTUALLY LANDED. The caller tears the agent's row down on the
 * strength of it, so a `true` on a failed write destroys the row and its record together — which is
 * precisely the failure this record exists to prevent. The `catch` below therefore returns `false`;
 * it must never widen into a swallowed success.
 *
 * NEVER THROWS, for the same reason `openDeathRecord` does not: this is an accountability
 * affordance, and one that can crash its caller is worse than none. The boolean is how the caller
 * learns, rather than an exception it might not be positioned to handle.
 *
 * `deps` is an optional trailing parameter so a test can drive a genuinely failing write; the
 * contract callers are written against is the single `args` object.
 */
export async function recordAgentRetirement(
  args: {
    agentId: string;
    reason: string;
    retiredBy: "concierge" | "human";
    evidence: RetiredEvidence;
  },
  deps: DeathRecordDeps = liveDeps(),
): Promise<boolean> {
  const { agentId, reason, retiredBy, evidence } = args;
  try {
    await deps.invoke("agent_life_retire", { agentId, reason, retiredBy, evidence });
    log.info("resurrection", "retired an agent", {
      agentId,
      retiredBy,
      worktreeRisk: evidence.worktreeRisk,
      retroStanding: evidence.retroStanding,
    });
    return true;
  } catch (e) {
    // NOT `true`. The caller gates a teardown on this.
    log.warn("resurrection", "could not record the retirement", {
      agentId,
      retiredBy,
      error: String(e),
    });
    return false;
  }
}

/**
 * Classify what just ended this agent's session and write the verdict.
 *
 * Returns the verdict it wrote, or `null` when nothing was written — which is what lets the tests
 * assert the DECISION rather than counting calls on a spy.
 *
 * TWO REFUSALS, both of which are the whole point of the module:
 *
 *  1. A window that did not watch the agent writes NOTHING here. `classifyDeath` already answers
 *     `{unknown, none}` for that (Gate 0), and persisting it would overwrite a record another window
 *     wrote with real evidence — turning an observation into an erasure.
 *  2. `unknown` from a bare terminator is written, but it is NOT resurrectable, and that asymmetry
 *     is deliberate rather than incidental: a human clicking stop produces exactly a clean PTY exit
 *     with no banner, no wall and no met goal. Recording it keeps the reaper honest; refusing to act
 *     on it keeps the fleet from restarting agents their owner just killed.
 */
export async function recordDeath(
  agentId: string,
  terminator: Terminator,
  deps: DeathRecordDeps = liveDeps(),
): Promise<DeathVerdict | null> {
  try {
    const now = deps.now();
    const observation: DeathObservation = {
      quota: deps.quota(agentId, now),
      lastFailure: deps.lastFailure(agentId),
      recentFailure: deps.recentFailure(agentId, now),
      liveness: deps.liveness(agentId),
      goal: deps.goal(agentId),
      blockingTool: deps.blockingTool(agentId),
      terminator,
      now,
    };
    const verdict = classifyDeath(observation);

    // Refusal 1. `evidence: "none"` is the shape Gate 0 returns, and it means "this window has
    // nothing to say" — never "the agent is fine". Writing it would clobber a real verdict.
    if (verdict.evidence === "none") {
      return null;
    }

    // ── REFUSAL 2: A WALLED AGENT IS NOT A DEAD ONE ────────────────────────────────────────────
    //
    // `quota-trip` fires while the process is explicitly still running — `deathRecord.ts` says so
    // outright: "A quota wall tripped the engine. The agent may still be alive; it simply cannot
    // proceed." Closing the record there sets `LifeState::Dead` on a LIVE agent, and everything
    // downstream believes it: `derive` reports `alive: false` for a running process, the revival
    // thread publishes it as due the moment the wall's reset passes, and the sweep then refuses it
    // `already-live` on every scan forever — a permanent loop over an agent that was never dead.
    // A walled-then-recovered agent would also keep a Dead record until something reopened it.
    //
    // `note_wall_at` exists for exactly this and its doc says exactly this: "Record a wall without
    // closing the record. Used when an agent is walled but still alive." The wall is written, the
    // record stays open, and `close_at` NEVER drops a wall already on the record — so if the agent
    // does then die, the wall it hit rides along with the death and recovery gets both facts:
    // resurrect because it died, but not before the reset.
    if (terminator === "quota-trip") {
      if (verdict.wall === undefined) return null;
      await deps.invoke("agent_life_note_wall", { agentId, wall: verdict.wall });
      log.info("resurrection", "noted a wall on a still-running agent", {
        agentId,
        resetParsed: verdict.wall.resetParsed,
      });
      return verdict;
    }

    await deps.invoke("agent_life_close", {
      agentId,
      death: {
        cause: verdict.cause,
        evidence: verdict.evidence,
        at: now,
        message: verdict.message,
        goalMetAt: verdict.goalMetAt,
      },
      // The wall travels SEPARATELY from the cause, and `close_at` never drops one already on the
      // record. An agent walled at 18:19 and killed by the app quitting at 18:20 has both facts
      // true, and recovery needs both: resurrect BECAUSE the app died, but NOT before the reset.
      wall: verdict.wall ?? null,
    });
    log.info("resurrection", "recorded a death", {
      agentId,
      cause: verdict.cause,
      evidence: verdict.evidence,
    });
    return verdict;
  } catch (e) {
    log.warn("resurrection", "could not record the death", { agentId, error: String(e) });
    return null;
  }
}
