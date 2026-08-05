/**
 * The concierge's fleet-awareness surface: the Level 0–2 escalation ladder.
 *
 * WHAT THIS REPLACES. Until now the concierge learned an agent's state from surface signals — is a
 * spinner visible, is the screen calm — routed through `runtimeStore`, which is window-local,
 * in-memory, and populated only while a pane is mounted. Consequences: a closed pane reads
 * `unknown`, and because `isRedStatus(undefined)` is `false`, an unwatched agent is indistinguishable
 * from a healthy one. That blindness cost 23.6 aggregate agent-hours across 37 stalls in one day.
 *
 * THE RULE THIS SURFACE ENFORCES. Anything knowable from an ARTIFACT is read from the artifact.
 * An agent's turn is spent only when the concierge has something that agent NEEDS. Concretely,
 * agent responses are NEVER used as a liveness mechanism: a message costs the agent a full turn and
 * can end the turn it was in the middle of, so pinging 40 agents every ten minutes is ~240 turns an
 * hour purely to learn who is alive. `fleet_digest` answers the same question without spending an
 * agent TURN — which is the sense in which it is "free", and the only one. It still costs real disk
 * and git work (~0.27s per agent, measured), so it is polled every thirty seconds rather than run
 * in a loop, and unchanged agents are served from a memo without spawning git.
 *
 * THE TIERING IS THE INCENTIVE DESIGN. `inbox_send` is `routine` (auto-allowed) while
 * `send_to_agent_terminal` is `disruptive` (asks). That asymmetry is deliberate and is the whole
 * mechanism by which Level 3 becomes rare: the non-interrupting channel is frictionless and the
 * interrupting one is not, so the cheap correct choice is also the easy one.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  FleetAgentFacts,
  FleetDigest,
  FleetVerdict,
} from "../../engine/fleetVerdict";
import { verdictsFor } from "../../engine/fleetVerdict";

// ---------------------------------------------------------------------------------------------
// Ops and risk
// ---------------------------------------------------------------------------------------------

export const FLEET_OPS = [
  "fleet_digest",
  "read_agent_stream",
  "read_agent_transcript",
  "inbox_send",
  "inbox_broadcast",
  "inbox_status",
] as const;

export type FleetOp = (typeof FLEET_OPS)[number];

export type FleetRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — a `Record<FleetOp, …>`, so an op added without a classification
 * fails `tsc` rather than defaulting to something permissive.
 *
 * The three reads are `read-only`: each one opens files the app already owns and writes nothing.
 *
 * The two sends are `routine`, NOT `disruptive`, and the distinction is the point of Level 2. A
 * queued message does not touch the agent's PTY, cannot interrupt a turn in progress, and is not
 * seen until the agent reaches a boundary it was going to reach anyway. The cost of a wrong one is
 * that an agent reads a sentence it did not need — recoverable, and far below the cost of a wrong
 * `send_to_agent_terminal`, which can discard work mid-turn. Classifying it `disruptive` would make
 * the concierge ask before every queued note, and an assistant that must ask to leave a message
 * will reach for the terminal instead — which is exactly backwards.
 */
export const FLEET_RISK: Record<FleetOp, FleetRisk> = {
  fleet_digest: "read-only",
  read_agent_stream: "read-only",
  read_agent_transcript: "read-only",
  inbox_send: "routine",
  inbox_broadcast: "routine",
  inbox_status: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results — the diff/board/plans convention
// ---------------------------------------------------------------------------------------------

export interface FleetOk<T> {
  ok: true;
  op: FleetOp;
  risk: FleetRisk;
  data: T;
}

export interface FleetRefusal {
  ok: false;
  op: FleetOp;
  risk: FleetRisk;
  reason: string;
  message: string;
}

export type FleetResult<T> = FleetOk<T> | FleetRefusal;

function ok<T>(op: FleetOp, data: T): FleetOk<T> {
  return { ok: true, op, risk: FLEET_RISK[op], data };
}

function refuse(op: FleetOp, reason: string, message: string): FleetRefusal {
  return { ok: false, op, risk: FLEET_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// Wire shapes (mirrors of the Rust structs)
// ---------------------------------------------------------------------------------------------

export interface StreamPage {
  lines: string[];
  nextCursor: number;
  remainingBytes: number;
  eof: boolean;
  totalBytes: number;
  /**
   * True when a single record was longer than `maxBytes` and this page therefore contains a FRAGMENT
   * of it rather than a whole line — the one case in which the "a page never splits a record"
   * guarantee cannot be kept. It is not exotic for transcripts: one large tool result exceeds the
   * default page budget, and a caller parsing JSONL would otherwise receive unparseable fragments
   * presented as complete lines, with the multi-byte character straddling the cut replaced by U+FFFD.
   * Re-read with a larger `maxBytes`, or stitch across pages.
   */
  partialLine: boolean;
}

export type InboxSeverity = "fyi" | "act";

export interface InboxStatusRow {
  agentId: string;
  pending: number;
  delivered: number;
  acknowledged: number;
  awaitingAck: number;
  pendingIds: string[];
}

/**
 * How far one queued message has got. Mirrors `inbox::DeliveryState`.
 *
 * `InboxStatusRow` above COUNTS these; this names the stage of a SPECIFIC message, which is what a
 * human needs to check a "I sent it" claim rather than merely learn that two things are queued.
 */
export type DeliveryState = "pending" | "delivered" | "acknowledged";

/** One live message with its text and stage. Mirrors `inbox::InboxEntry`. */
export interface InboxEntry {
  id: string;
  ts: number;
  from: string;
  text: string;
  severity: InboxSeverity;
  state: DeliveryState;
  /** When the agent acknowledged, if it did. `null` in every other state. */
  ackedAt: number | null;
  /** The agent's own note on the ack, when it wrote one. */
  ackNote: string | null;
}

/** One agent's live inbox — every message still in flight. Mirrors `inbox::InboxView`. */
export interface InboxView {
  agentId: string;
  entries: InboxEntry[];
}

export interface BroadcastOutcome {
  agentId: string;
  messageId: string | null;
  error: string | null;
}

export interface AgentRef {
  agentId: string;
  projectId: string;
}

/** A digest with the Level 0 verdicts already attached, so the concierge never re-derives them. */
export interface JudgedDigest extends FleetDigest {
  verdicts: FleetVerdict[];
  /** Agents whose verdict says escalate — the shortlist, so the obvious next question is answered. */
  escalate: string[];
}

// ---------------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------------

/** Turn an unknown thrown value into a refusal message. */
function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * LEVEL 0. One call, every agent, artifacts only.
 *
 * `ctxFor` supplies what the artifacts cannot know — how the fleet is currently RENDERING each
 * agent, and whether it has an unmet goal. Both are owned elsewhere (`engine/buildSections.ts`,
 * `engine/agentGoal.ts`) and are passed in rather than re-derived, so this surface never becomes a
 * second opinion about a question another module already answers.
 */
export async function fleetDigest(
  agents: AgentRef[],
  opts: { baseBranch?: string; windowMs?: number } = {},
  ctxFor: (agentId: string) => { renderedTerminal?: boolean; hasUnmetGoal?: boolean } = () => ({}),
): Promise<FleetResult<JudgedDigest>> {
  if (agents.length === 0) {
    return refuse(
      "fleet_digest",
      "no-agents",
      "Name at least one agent as { agentId, projectId }. Every agent you can see in get_state has both.",
    );
  }
  try {
    const digest = await invoke<FleetDigest>("fleet_digest", {
      agents,
      baseBranch: opts.baseBranch,
      windowMs: opts.windowMs,
    });
    const verdicts = verdictsFor(digest, ctxFor);
    return ok("fleet_digest", {
      ...digest,
      verdicts,
      escalate: verdicts.filter((v) => v.shouldEscalate).map((v) => v.agentId),
    });
  } catch (e) {
    return refuse("fleet_digest", "digest-failed", detail(e));
  }
}

/**
 * LEVEL 1. An agent's COMPLETE hook stream, paged.
 *
 * Contrast `read_agent_terminal`, which caps at 4000 characters, keeps the tail, and says nothing
 * about the front it dropped — in practice losing 6k and then 12k characters mid-investigation,
 * which is exactly the content an agent writes when it has something important to say. Here a
 * truncated read is always accompanied by `nextCursor` and `remainingBytes`.
 */
export async function readAgentStream(
  agentId: string,
  cursor?: number,
  maxBytes?: number,
): Promise<FleetResult<StreamPage>> {
  try {
    return ok(
      "read_agent_stream",
      await invoke<StreamPage>("fleet_read_hook_stream", { agentId, cursor, maxBytes }),
    );
  } catch (e) {
    return refuse("read_agent_stream", "stream-unreadable", detail(e));
  }
}

/**
 * LEVEL 1. A Claude Code session transcript, paged.
 *
 * The path is not guessed: `fleet_digest` carries `hooks.transcriptPath` for every agent, taken
 * from its own `Stop` hook lines. The Rust side confines the read to `~/.claude/projects` because
 * that value originates outside our trust boundary.
 */
export async function readAgentTranscript(
  transcriptPath: string,
  cursor?: number,
  maxBytes?: number,
): Promise<FleetResult<StreamPage>> {
  if (!transcriptPath.trim()) {
    return refuse(
      "read_agent_transcript",
      "no-path",
      "Pass the `transcriptPath` from that agent's fleet_digest entry (hooks.transcriptPath). " +
        "If it is null the agent has not completed a turn yet, so there is no transcript to read.",
    );
  }
  try {
    return ok(
      "read_agent_transcript",
      await invoke<StreamPage>("fleet_read_transcript", { transcriptPath, cursor, maxBytes }),
    );
  } catch (e) {
    return refuse("read_agent_transcript", "transcript-unreadable", detail(e));
  }
}

/** LEVEL 2. Queue one non-interrupting message, drained at the agent's next turn boundary. */
export async function inboxSend(
  agentId: string,
  text: string,
  severity: InboxSeverity = "fyi",
): Promise<FleetResult<{ messageId: string }>> {
  try {
    const messageId = await invoke<string>("inbox_send", { agentId, text, severity });
    return ok("inbox_send", { messageId });
  } catch (e) {
    return refuse("inbox_send", "queue-failed", detail(e));
  }
}

/**
 * LEVEL 2. Queue the same message for many agents.
 *
 * Partial failure is reported per agent rather than failing the whole call, so one agent with a full
 * inbox cannot silently prevent the other deliveries.
 *
 * A BROADCAST THAT QUEUED NOTHING IS A REFUSAL, NOT AN `ok` WITH A ZERO IN IT (sparkle-bbghz's rule
 * applied one layer up). `enqueue` now reads each message back before returning an id, so the Rust
 * side is honest per agent — but this wrapper flattened N honest failures into `ok: true` with a
 * `failed` count the caller had to notice on its own. The caller is a language model that has just
 * been asked to instruct a fleet, and `ok: true` is exactly the evidence it uses to tell a human it
 * did. That is the same defect as the bug this pair of beads is about, arriving through the batch
 * path: a positive acknowledgement for something that did not happen.
 *
 * PARTIAL SUCCESS STAYS `ok`, deliberately — some agents really were reached, and refusing the whole
 * call would misreport those as failures and invite a re-send that double-queues them. It carries
 * `failedAgents` so the caller can name who was missed without walking `outcomes` itself; the reason
 * text is already per-agent inside `outcomes`.
 */
export async function inboxBroadcast(
  agentIds: string[],
  text: string,
  severity: InboxSeverity = "fyi",
): Promise<
  FleetResult<{
    outcomes: BroadcastOutcome[];
    queued: number;
    failed: number;
    failedAgents: string[];
  }>
> {
  if (agentIds.length === 0) {
    return refuse("inbox_broadcast", "no-recipients", "Name at least one agentId to broadcast to.");
  }
  try {
    const outcomes = await invoke<BroadcastOutcome[]>("inbox_broadcast", {
      agentIds,
      text,
      severity,
    });
    const queued = outcomes.filter((o) => o.messageId !== null).length;
    const failedOutcomes = outcomes.filter((o) => o.messageId === null);
    if (queued === 0) {
      return refuse(
        "inbox_broadcast",
        "none-queued",
        `Nothing was queued. ${failedOutcomes.length} of ${outcomes.length} agent(s) rejected the ` +
          `message and none accepted it, so no agent has been told anything:\n` +
          failedOutcomes
            .map((o) => `  ${o.agentId}: ${o.error ?? "no message id returned"}`)
            .join("\n"),
      );
    }
    return ok("inbox_broadcast", {
      outcomes,
      queued,
      // Counted off `messageId`, not off `error`. They agree today, but a message id is what a caller
      // would USE as proof of a send — so the count of failures must be the count of agents that have
      // no id, never the count that happened to carry an error string.
      failed: failedOutcomes.length,
      failedAgents: failedOutcomes.map((o) => o.agentId),
    });
  } catch (e) {
    return refuse("inbox_broadcast", "broadcast-failed", detail(e));
  }
}

/**
 * LEVEL 2. Delivery and acknowledgement state.
 *
 * `awaitingAck` is DELIVERY CONFIRMATION, never liveness. An agent that has been delivered to but
 * has not acked is an agent not reaching turn boundaries — which `fleet_digest` already showed for
 * free. It is not a reason to message it again.
 */
export async function inboxStatus(
  agentIds: string[],
): Promise<FleetResult<{ rows: InboxStatusRow[]; awaitingAck: number }>> {
  if (agentIds.length === 0) {
    return refuse("inbox_status", "no-agents", "Name at least one agentId.");
  }
  try {
    const rows = await invoke<InboxStatusRow[]>("inbox_status", { agentIds });
    return ok("inbox_status", {
      rows,
      awaitingAck: rows.filter((r) => r.awaitingAck > 0).length,
    });
  } catch (e) {
    return refuse("inbox_status", "status-failed", detail(e));
  }
}

export type { FleetAgentFacts, FleetDigest, FleetVerdict };
