// What the SERVER last said about each cloud session's lifecycle — the cloud counterpart of
// `engine/turnEndAuthority`'s liveness record.
//
// WHY THIS HAD TO EXIST. A local agent witnesses its own liveness: its PTY is on this machine, its
// output is this window's evidence, and `pty:exit` is a real death signal. A cloud agent has none of
// that. Its sandbox lives on someone else's computer, it keeps running while the laptop is shut, and
// the ONLY thing that can tell this desktop whether it is `active`, hibernated (`paused`) or parked
// for credit exhaustion (`waiting`) is `GET /sessions?project_id=` — which, until this module, the
// app called exactly once per project open (services/cloudAgents/reattach) and then threw away.
//
// That gap is not academic. `engine/goalContinuation` decides whether to spend money resuming an
// agent, and for a cloud agent two of those lifecycles must NEVER be resumed:
//
//   • `paused`  — E2B has hibernated the sandbox. Input written at it goes nowhere, and reviving it
//                 is a billing decision that belongs to the user, not to a 15-second timer.
//   • `waiting` — the runner parked the session, on exhaustion or because the agent is asking its
//                 human something. Either way a "keep working" prompt is wrong.
//
// SHAPE, AND WHY IT MIRRORS turnEndAuthority RATHER THAN A ZUSTAND STORE. This is evidence read
// imperatively by a gate, never rendered, and window-local by nature (a satellite window that never
// listed a project's sessions has NOT observed them). A reactive store would invite a component to
// subscribe to it and would have to be persisted to be worth subscribing to — and a PERSISTED
// lifecycle is the exact hazard here: a status remembered across a relaunch is a claim about a
// sandbox nobody has looked at since.
//
// EVERY READING EXPIRES, and that is the load-bearing rule. A reading is a snapshot of a remote
// machine, so it decays: a session that was `active` when the project opened can hibernate an hour
// later with nothing local changing. Past {@link CLOUD_SESSION_STATUS_MAX_AGE_MS} the answer is
// `undefined` — "I do not know" — which every consumer must fail CLOSED on, exactly as
// `processAlive` does. Never spend money on a sandbox you have not looked at recently.
import { log } from "../../logger";
import type { CloudApi } from "./api";

/**
 * How long a lifecycle reading stays usable.
 *
 * Chosen against {@link CLOUD_SESSION_REFRESH_MS} (45s), not in the abstract: the refresher gets four
 * attempts inside this window, so a healthy session with a working connection never expires, while a
 * desktop that has gone offline (or signed out, or whose project lost its cloud binding) stops
 * claiming knowledge it no longer has within three minutes. Longer would let a stale `active` wave
 * through a resume into a sandbox that hibernated half an hour ago; much shorter would refuse every
 * cloud agent on a single dropped request.
 */
export const CLOUD_SESSION_STATUS_MAX_AGE_MS = 180_000;

/**
 * How often a caller may re-list one project's sessions.
 *
 * The goal sweep runs every 15s; listing on every sweep would be three HTTP requests a minute per
 * project for an answer that changes on the scale of minutes. 45s keeps a reading comfortably fresh
 * against the expiry above at one request a minute per project that actually has a cloud agent
 * chasing a goal.
 */
export const CLOUD_SESSION_REFRESH_MS = 45_000;

interface Reading {
  status: string;
  observedAt: number;
}

const byAgent = new Map<string, Reading>();
/** cloudProjectId → when it was last listed. The throttle for {@link refreshCloudSessionStatuses}. */
const lastListedAt = new Map<string, number>();

/**
 * Record what the server said about one session. `agentId` is the session id — for a cloud agent the
 * server session id IS the tab id (spec §Identity), so no mapping is needed.
 *
 * NEWEST WINS, BY ISSUE TIME — not last-write-wins, which is what this was and what made it unsafe.
 * Two producers list independently (the sweep's throttled refresh and `reattach` at project open),
 * and HTTP responses are unordered: a listing issued first can settle second, carrying an older
 * world. Under last-write-wins that stale `active` overwrote a fresh `paused`/`waiting`, and the
 * goal-continuation gate reads exactly this map before deciding whether to resume — so the app
 * could wake and bill a sandbox the server had already parked, which is the one thing the cloud
 * gates exist to prevent.
 *
 * `now` must therefore be the time the REQUEST WAS ISSUED, which is what both producers pass.
 */
export function noteCloudSessionStatus(agentId: string, status: string, now: number): void {
  if (typeof agentId !== "string" || agentId.length === 0) return;
  if (typeof status !== "string" || status.length === 0) return;
  const prev = byAgent.get(agentId);
  // `>` not `>=`: two readings from the SAME issue instant are the same world, so the later write
  // is free to win — only a genuinely older one is refused.
  //
  // THE REFUSAL IS UNCONDITIONAL, and the self-heal for a broken clock lives on the READ side
  // instead (see {@link cloudSessionStatusOf}). A size-based escape hatch here — "a `prev` more
  // than MAX_AGE ahead must be a stepped clock, let the write through" — was tried and is wrong:
  // it cannot tell a stepped clock from an ordinary listing that simply hung longer than MAX_AGE,
  // so a three-minute-late response would overwrite the fresher reading it is supposed to lose to.
  // That is exactly the NEWEST-WINS invariant this guard exists to hold, traded away for a heal
  // the reader can perform on its own with no heuristic at all (roborev 58583).
  if (prev !== undefined && prev.observedAt > now) return;
  byAgent.set(agentId, { status, observedAt: now });
}

/**
 * The last lifecycle this window observed for `agentId`, or `undefined` when it never observed one
 * OR the reading has expired.
 *
 * THE TWO UNDEFINEDS ARE DELIBERATELY THE SAME ANSWER. A consumer that could tell them apart would
 * be tempted to treat "it was active three hours ago" as weaker evidence rather than as none, and
 * there is no honest way to rank a stale claim about a remote sandbox above no claim at all.
 */
export function cloudSessionStatusOf(agentId: string, now: number): string | undefined {
  const found = byAgent.get(agentId);
  if (found === undefined) return undefined;
  // A READING FROM THE FUTURE IS NOT EVIDENCE, AND READING IT IS WHAT DISCARDS IT. `now -
  // observedAt` is negative for one, so the age check below can never fire and it would live
  // forever — the one state this module must not produce, since the goal-continuation gate reads it
  // before deciding to resume and bill.
  //
  // THE DELETE IS THE SELF-HEAL, and it belongs here rather than in the writer. Only a reader holds
  // a WALL-CLOCK `now`; a writer's `now` is a request ISSUE time, legitimately in the past, so a
  // writer cannot tell "the clock stepped back" from "this listing was slow". The writer therefore
  // refuses every out-of-order write unconditionally (NEWEST WINS, no exceptions) and the sweep's
  // own read — which runs at least as often as the listing that would be refused — evicts the
  // impossible reading, leaving the very next listing free to record a fresh one. A stepped clock
  // costs one sweep, not the whole skew window (roborev 58583) — but ONLY because
  // {@link refreshCloudSessionStatuses} applies the same rule to its throttle stamp. Evicting here
  // while the throttle still honoured a future stamp would empty the map and forbid refilling it
  // (roborev 58586); the two halves are one mechanism and must not be changed apart.
  if (found.observedAt > now) {
    byAgent.delete(agentId);
    return undefined;
  }
  if (now - found.observedAt >= CLOUD_SESSION_STATUS_MAX_AGE_MS) return undefined;
  return found.status;
}

/** Epoch ms of the reading behind {@link cloudSessionStatusOf}, ignoring expiry. Introspection only
 *  (tests, a future "last checked" affordance) — no gate may read this instead of the expiring one. */
export function cloudSessionObservedAt(agentId: string): number | undefined {
  return byAgent.get(agentId)?.observedAt;
}

export interface RefreshDeps {
  api: Pick<CloudApi, "listSessions">;
  /** Injected clock, house style. */
  now: number;
}

/**
 * Re-list one SERVER project's sessions and record every lifecycle it reports.
 *
 * Throttled to one request per {@link CLOUD_SESSION_REFRESH_MS} per project — a caller may therefore
 * invoke it on every sweep without thinking about cadence, which is the point: the alternative is a
 * second timer somewhere else that drifts from the sweep it exists to serve.
 *
 * NEVER THROWS and never rejects. Signed out, offline, a 500 — all of them mean "no new reading",
 * and the readings already held simply age out on their own. Returns the number of sessions
 * recorded (0 for a throttled call or a failed one), which is what lets a test tell the two apart
 * from the outside.
 */
export async function refreshCloudSessionStatuses(
  cloudProjectId: string,
  deps: RefreshDeps,
): Promise<number> {
  const last = lastListedAt.get(cloudProjectId);
  // `last <= deps.now` — THE THROTTLE OBEYS THE SAME RULE AS THE READINGS: a stamp ahead of the
  // clock is impossible, not newer. Without it the throttle is the OTHER half of the stepped-clock
  // freeze, and the worse half: `deps.now - last` is negative for a future stamp, which is trivially
  // under the interval, so every refresh returns 0 without listing for the whole skew window — while
  // the read side has meanwhile EVICTED the readings, leaving the map empty with no producer allowed
  // to refill it. Letting an impossible stamp through costs one extra listing; honouring it costs
  // every cloud agent its evidence until the clock catches up (roborev 58586).
  if (last !== undefined && last <= deps.now && deps.now - last < CLOUD_SESSION_REFRESH_MS) return 0;
  // Stamped BEFORE the await, so the sweeps that run while this request is in flight are throttled
  // too. Stamping after would let three 15s sweeps each start their own listing of the same project.
  lastListedAt.set(cloudProjectId, deps.now);
  let sessions;
  try {
    sessions = await deps.api.listSessions(cloudProjectId);
  } catch (err) {
    log.debug("cloud-agents", "session-status refresh failed", err);
    return 0;
  }
  let recorded = 0;
  for (const s of sessions) {
    if (!s || typeof s.id !== "string" || s.id.length === 0) continue;
    if (typeof s.status !== "string" || s.status.length === 0) continue;
    noteCloudSessionStatus(s.id, s.status, deps.now);
    recorded++;
  }
  return recorded;
}

/** Test seam: forget every reading and every throttle stamp. */
export function resetCloudSessionStatusesForTests(): void {
  byAgent.clear();
  lastListedAt.clear();
}
