// PRODUCTION WIRING for the bead-comment @mention router — the half that makes it REACHABLE.
//
// This file exists because the two features before it did not have one. `mention.rs` shipped four
// registered Tauri commands with ZERO frontend callers, and the mention compose UI shipped seventeen
// components nothing mounts: both are complete, both are tested, and neither has ever run. A router
// with no caller is a router that cannot wake anybody, so the wiring is the deliverable, not the
// finishing touch (bead `sparkle-wyc9j`: six PRs merged with zero consumers).
//
// ── COST: THIS ADDS NO `bd` CALLS ────────────────────────────────────────────────────────────────
// The trigger rides the bulk `bd list --all --json` the board already polls — `commentCount` per row,
// which the normalizer now carries through. Only a bead whose count actually ROSE costs a per-bead
// read. The beads store is one embedded single-writer Dolt DB shared by every worktree in the repo,
// and its poll is already duty-cycle-budgeted to stay off that lock; adding a second independent
// sweep would be a lock convoy, so we subscribe to the poll rather than starting one.

import { useProjectStore } from "../../stores/projectStore";
import { useBeadsStore } from "../../stores/beadsStore";
import { agentDisplayName } from "../../engine/agentDisplayName";
import { openAgentIdSet } from "../knownAgents";
import { beadsComment, beadsDetail } from "../beadsCommands";
import { invoke } from "@tauri-apps/api/core";
import { SPECIAL_HANDLE_NAMES, resolveSpecialHandle, wireHandleFor } from "./specialTargets";
import type { MentionCandidate } from "../agentMentionResolve";
import {
  emptyRouterState,
  runMentionTick,
  type BeadCommentCount,
  type DoorbellState,
  type RouterDeps,
  type RouterState,
} from "./beadMentionRouter";

/** The anti-loop ceiling we ask the mention channel for, per BEAD. See the note at its call site:
 *  the channel's own default is sized for a reply chain, not for a bead's whole lifetime. */
const MENTION_ROUNDS_PER_BEAD = 50;

/** How often we consider routing. The bead poll is adaptive (5s floor, 60s ceiling); this is a
 *  separate, slower beat because routing does per-bead reads and posts comments, and neither wants
 *  to run at the board's repaint cadence. */
const TICK_MS = 20_000;

/** Where the router's memory lives across restarts. Losing it is SAFE by construction — a bead with
 *  no baseline is seeded rather than routed — so localStorage is the right tier: no Tauri command,
 *  no file, and a corrupt value degrades to "seed everything again", which wakes nobody.
 *
 *  KEYED PER PROJECT, and that is a correctness fix rather than tidiness. The ledger outlives a
 *  project switch (entries live up to 13h), while `postComment` is bound to whatever project is
 *  selected NOW. One shared ledger therefore posts project A's UNDELIVERED report into project B's
 *  bd store, where that bead id does not exist — so the write fails, `reportedUndelivered` is never
 *  latched, and the doomed comment is retried every tick for 13 hours. Worse, the guarantee that
 *  makes this feature worth having ("a doorbell nobody received is SAID to be undelivered")
 *  evaporates in exactly the case it exists for. Per-project state parks A's ledger until A is
 *  selected again, which is late but never wrong. */
export function storageKeyFor(projectId: string): string {
  return `sparkle.beadMentions.routerState.v1.${projectId}`;
}

/**
 * THE AUTHORITY, with `localStorage` as a write-through cache behind it.
 *
 * Making storage the only authority looked tidier and was a silent-failure machine: `saveState`
 * deliberately swallows write errors, so one `QuotaExceededError` (this origin also holds the
 * project store, the concierge threads, and account pins) meant every later tick loaded an EMPTY
 * state, re-seeded every bead, found nothing to read, and routed nothing — forever, with no signal.
 * That is precisely the "channel that stops silently" this module exists to remove, and it would
 * also have stranded every outstanding doorbell's UNDELIVERED report.
 *
 * With the map in front, an unwritable store costs persistence across a RESTART and nothing else.
 */
const memory = new Map<string, RouterState>();

/** Test-only: drop the in-memory authority so a suite can start from a known state. */
export function resetMentionStateCache(): void {
  memory.clear();
}

function loadState(projectId: string): RouterState {
  const cached = memory.get(projectId);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(storageKeyFor(projectId));
    if (raw === null) return emptyRouterState();
    const parsed = JSON.parse(raw) as Partial<RouterState>;
    return {
      baselines: parsed.baselines ?? {},
      // REHYDRATED, and this line is load-bearing. `saveState` writes `accounted`, but rebuilding
      // the state from an explicit literal without it silently dropped it on every cold start — so
      // the slice offset fell back to the list count, which is exactly the defect `accounted`
      // exists to remove. The "legacy state" fallback in the router was then not a legacy path at
      // all: it was the path taken on every restart, forever.
      accounted:
        parsed.accounted && typeof parsed.accounted === "object" ? parsed.accounted : {},
      processed: Array.isArray(parsed.processed) ? parsed.processed : [],
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : [],
    };
  } catch {
    return emptyRouterState();
  }
}

let warnedAboutStorage = false;

function saveState(projectId: string, state: RouterState): void {
  // The in-memory map is written FIRST and unconditionally — it is what the next tick reads, so a
  // storage failure can never cost delivery, only durability across a restart.
  memory.set(projectId, state);
  try {
    localStorage.setItem(storageKeyFor(projectId), JSON.stringify(state));
  } catch (err) {
    // Surfaced once rather than swallowed: a permanently unwritable store is a real degradation
    // (baselines stop surviving a restart), and an invisible one is how this class of bug persists.
    if (!warnedAboutStorage) {
      warnedAboutStorage = true;
      console.warn("[beadMentions] could not persist router state; continuing in memory:", err);
    }
  }
}

/**
 * Who can be addressed right now.
 *
 * TWO RULES, both deliberate:
 *  - Names go through `agentDisplayName`, the SAME rule the roster prints and the same one
 *    `send_peer_message` resolves against. A name a human reads on screen must be a name they can
 *    type into a comment; a second naming rule here would make some agents unaddressable for reasons
 *    invisible from the UI.
 *  - Only OPEN agents are candidates. An agent whose pane is closed cannot be handed a queued message
 *    by any delivery path, so offering it as a target would manufacture exactly the silent
 *    non-delivery this feature exists to remove. It reports as an unknown handle instead — which is
 *    visible, and true.
 *  - RESOLUTION NEVER LEAVES THE PROJECT WHOSE BEAD WE ARE READING, mirroring the identical rule in
 *    `handleSendPeerMessage`. The list is built FROM that project rather than gathered globally and
 *    filtered later, because a global list is one early return away from leaking. Two things go
 *    wrong without it, and the second is the bad one: a comment on project A's bead can doorbell an
 *    agent that exists only in project B, and an ambiguity refusal posted onto A's bead ENUMERATES
 *    agent ids from B — writing another project's roster into a shared, founder-visible bd store.
 */
export function liveMentionCandidates(projectId: string): MentionCandidate[] {
  const open = openAgentIdSet();
  const rows = (
    useProjectStore.getState().projects.find((p) => p.id === projectId)?.agents ?? []
  )
    .filter((a) => open.has(a.id))
    .map((a) => ({ id: a.id, name: agentDisplayName(a) }));
  // NOTE: the reserved handles are deliberately NOT concatenated here. They resolve ahead of the
  // roster through `resolveSpecialHandle`, so a user agent sharing one of their names cannot shadow
  // the app's own address — see `specialTargets`.
  return rows;
}

/** The queue's own verdict for one agent's messages, read WITHOUT claiming any of them.
 *
 *  `inbox_peek` is read-only and that is load-bearing: a poll that claimed would BE a delivery path,
 *  so merely looking would consume messages the agent never saw — the silent drop this feature is
 *  about, reintroduced by the code meant to detect it. */
async function readDoorbellStates(agentId: string): Promise<ReadonlyMap<string, DoorbellState>> {
  const views = await invoke<Array<{ agentId: string; entries: Array<{ id: string; state: DoorbellState }> }>>(
    "inbox_peek",
    { agentIds: [agentId] },
  );
  // SHAPE-GUARDED, and it fails CLOSED. An unexpected payload (a renamed field on the Rust side, a
  // command that answered something else) must not silently produce an EMPTY map — the router reads
  // a missing id as `missing` and would then announce every outstanding doorbell as undelivered.
  // Throwing routes it to `onError`, which leaves the ledger untouched for the next tick, and that
  // is the only safe direction: never invent a verdict for a queue we could not read.
  if (!Array.isArray(views)) {
    throw new Error(`inbox_peek returned ${typeof views}, expected an array of inbox views`);
  }
  const out = new Map<string, DoorbellState>();
  for (const view of views) {
    if (!Array.isArray(view?.entries)) {
      throw new Error("inbox_peek view is missing its entries array");
    }
    for (const entry of view.entries) {
      // PER-ENTRY VALIDATION, not just the wrappers. `DoorbellState` is a serde-renamed Rust enum,
      // so a variant can be renamed or added with NO TypeScript error — the `invoke<…>` type
      // argument is an unchecked assertion. Admitting an unknown string would fail OPEN: the
      // router treats anything that is not `pending`/`missing` as a terminal success, so a future
      // `expired` variant would silently retire every outstanding doorbell unreported. Note
      // `missing` is OUR sentinel for "not listed", never a wire value, so it is not accepted here.
      if (typeof entry?.id !== "string" || !WIRE_STATES.has(entry?.state)) {
        throw new Error(`inbox_peek returned an unrecognized delivery state: ${String(entry?.state)}`);
      }
      out.set(entry.id, entry.state);
    }
  }
  return out;
}

/** The states the Rust side can actually send. Deliberately excludes our `missing` sentinel. */
const WIRE_STATES = new Set(["pending", "delivered", "acknowledged"]);

/** The beads currently on the board, as `{ id, commentCount }`. Read from the store the poll already
 *  fills — no `bd` call of our own. */
function boardCounts(projectId: string): BeadCommentCount[] {
  const beads = useBeadsStore.getState().byProject[projectId]?.beads ?? [];
  // `?? 0` because `commentCount` is optional on `Bead` — see the note there. A bead from `bd`
  // always carries a number; only a hand-built fixture can omit it, and 0 is its correct reading.
  return beads.map((b) => ({ id: b.id, commentCount: b.commentCount ?? 0 }));
}

export function createRouterDeps(projectId: string, projectPath: string): RouterDeps {
  return {
    listCandidates: () => liveMentionCandidates(projectId),
    fetchComments: async (beadId) => {
      const detail = await beadsDetail(projectPath, beadId);
      return detail.comments.map((c) => ({ id: c.id, author: c.author, text: c.text }));
    },
    // `inbox_send` verifies persistence by reading the record back through the reader's own parser
    // before it returns an id, and returns a typed failure otherwise (the `sparkle-bbghz` fix). That
    // is why this path is used directly rather than `send_peer_message`, which still returns a bare
    // `{ok, messageId}` with no delivery vocabulary attached.
    //
    // Severity `act` matches the existing mention channel: a coordination doorbell is meant to be
    // seen at the next turn boundary, not filed away.
    enqueueDoorbell: (agentId, text, from) =>
      invoke<string>("inbox_send", { agentId, text, severity: "act", from }),
    postComment: (beadId, text) => beadsComment(projectPath, beadId, text),
    readDoorbellStates,
    // THE WAKE. `mention_send` posts nothing new (the body is already the bead comment we just
    // read — `bodyOnThread: true`), enqueues the doorbell, and then does the thing a bare enqueue
    // cannot: it WAKES the target. `@improve` gets a scoped responder spawned; `@sparkle` gets the
    // event the frontend turns into an immediate concierge turn. Neither has a live session between
    // passes, so without this they wait on their own cadence — up to an hour for `@improve`.
    //
    // `body` is a one-line pointer rather than the comment text: the channel refuses an empty body,
    // and its own rule 1 is that the inbox never carries the message. `provenance: "own"` is
    // accurate — this router is describing what it observed, never quoting the founder to an agent
    // he did not address (the relayGate rule mention.rs enforces).
    sendViaMentionChannel: async (agentId, beadId, from) => {
      // The CANONICAL handle, never the token the author typed — see `wireHandleFor`.
      const handle = wireHandleFor(agentId);
      if (handle === null) throw new Error(`no mention-channel handle for ${agentId}`);
      const outcome = await invoke<{
        round: number;
        doorbelled: boolean;
        spawned: boolean;
        wakeSparkle: boolean;
        capped: boolean;
        messageId: string | null;
      }>("mention_send", {
        projectPath,
        target: handle,
        threadRef: beadId,
        body: `${from} mentioned you in a comment on bead ${beadId} — the message is that comment.`,
        from,
        provenance: "own",
        bodyOnThread: true,
        // The channel's default cap (6) is sized for a two-agent REPLY CHAIN. Here `threadRef` is a
        // long-lived BEAD, and the counter latches `ended` permanently — so six reserved mentions
        // EVER on a bead would kill every later one on precisely the busiest beads. A larger finite
        // cap keeps a genuine runaway bounded (our own routing of a reply could still feed itself)
        // without retiring the bead.
        maxRounds: MENTION_ROUNDS_PER_BEAD,
      });
      return {
        round: outcome.round,
        doorbelled: outcome.doorbelled,
        spawned: outcome.spawned,
        wakeSparkle: outcome.wakeSparkle,
        capped: outcome.capped,
        messageId: outcome.messageId,
      };
    },
    readMentionStatus: async (beadId) => {
      const st = await invoke<{
        round: number;
        awaitingAckRound: number;
        acked: boolean;
        overdue: boolean;
      }>("mention_status", { projectPath, threadRef: beadId });
      return {
        round: st.round,
        awaitingAckRound: st.awaitingAckRound,
        acked: st.acked,
        overdue: st.overdue,
      };
    },
    resolveSpecialHandle,
    specialHandleNames: SPECIAL_HANDLE_NAMES,
    now: () => Date.now(),
    onError: (where, err) => {
      console.warn(`[beadMentions] ${where}:`, err);
    },
  };
}

/**
 * Start the watcher. Returns a stop function.
 *
 * MAIN WINDOW ONLY at the call site, and for correctness rather than cost: this WRITES — it queues
 * messages and posts bead comments — so N windows would mean N doorbells and N comments for one
 * mention. (Contrast `InboxWatch`, which only reads and therefore runs everywhere.)
 */
export function startBeadMentionWatch(): () => void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const { projects, selectedProjectId } = useProjectStore.getState();
      const project = projects.find((p) => p.id === selectedProjectId);
      if (!project?.rootPath) return;

      const counts = boardCounts(project.id);
      if (counts.length === 0) return;

      // Loaded per tick, keyed by the project it belongs to — never carried across a switch.
      const state = loadState(project.id);
      const { state: next } = await runMentionTick(
        state,
        counts,
        createRouterDeps(project.id, project.rootPath),
      );
      saveState(project.id, next);
    } catch (err) {
      // The watcher must survive anything one tick throws; a channel that stops silently is the
      // failure mode this whole feature exists to remove.
      console.warn("[beadMentions] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
