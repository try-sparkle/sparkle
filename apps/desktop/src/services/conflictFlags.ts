// THE PROBE SIDE OF `pr-conflicting` — one Tauri command, one event, and a parser that refuses to
// guess.
//
// ── WHY THERE IS A PARSER AT ALL ─────────────────────────────────────────────────────────────────
// `invoke` and `listen` both hand back `unknown` that TypeScript is happy to have asserted into a
// typed array. `ConflictingPr` is a FROZEN wire contract shared with Rust (`conflict_flags` +
// `conflict://detected`, serde camelCase), and the one thing a cast cannot do is notice that the two
// sides have drifted. A renamed field would produce entries whose `kind` is `undefined` and whose
// `commitsBehind` is `NaN`, and the report would compose confident sentences out of them.
//
// ── AND WHY IT IS ALL-OR-NOTHING ─────────────────────────────────────────────────────────────────
// A payload with one unreadable entry returns `undefined` — WE DID NOT LOOK — rather than the
// entries that did parse. Keeping the good ones looks generous and is the wrong trade here: the
// caller cannot tell a filtered list from a complete one, so a version skew that dropped four of
// five PRs would be delivered as a confident report about the fifth, and the four would be exactly
// as invisible as they were before this class existed. Silence is recoverable and says so; a
// partial answer presented as a whole one is the failure being fixed.
//
// ── FAIL CLOSED AT THIS SEAM, NOT DOWNSTREAM ─────────────────────────────────────────────────────
// Nothing here ever writes `[]` on a failure. An empty list reaches the store only when the probe
// genuinely answered with one, because `[]` is a CLAIM — "every open PR can merge" — and it is the
// claim an unauthenticated `gh` is most likely to produce by accident.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ConflictingPr } from "@sparkle/core";
import { log } from "../logger";
import { safeUnlisten } from "./safeUnlisten";
import { useConflictStore } from "../stores/conflictStore";

/** MUST match the Rust event name. */
export const CONFLICT_DETECTED_EVENT = "conflict://detected";

/** MUST match the Rust command name. */
export const CONFLICT_FLAGS_COMMAND = "conflict_flags";

/**
 * Whether `conflict_flags` is COMPLETE. Its whole reason to exist is the empty list: the producer's
 * per-PR fail-closed path cannot cover a `gh` that never worked at all, so without this an empty
 * answer and a never-completed sweep are the same bytes.
 */
export const CONFLICT_PROBE_STATUS_COMMAND = "conflict_probe_status";

/**
 * How often the probe is re-run.
 *
 * TEN MINUTES, an order of magnitude slower than the sweep's one-minute tick, because the two are
 * bounded by different things. A sweep is a store read; a probe is a `gh` round-trip per open PR,
 * against an API with a rate limit shared with everything else the app does. Nothing is lost by the
 * gap: a PR that goes conflicting is reported late by minutes on a condition measured in hours, the
 * event below closes even that when Rust volunteers it, and the report's own four-hour cooldown
 * dwarfs both.
 */
export const CONFLICT_POLL_MS = 10 * 60_000;

/** Is this one entry the frozen shape, in full? Extra fields are fine; missing or mistyped are not. */
function parseOne(v: unknown): ConflictingPr | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const kind = o["kind"];
  const owner = o["ownerAgentId"];
  const blockedBy = o["blockedBy"];
  // WHOLE, POSITIVE NUMBERS ONLY. A fraction or a negative is not a thing GitHub produces, so it is
  // evidence the payload is not what this build thinks it is — and a negative count in particular
  // would render as `-5` and get the whole report refused as `fabricated-citation`, silently.
  if (!Number.isSafeInteger(o["pr"]) || (o["pr"] as number) <= 0) return undefined;
  if (typeof o["branch"] !== "string") return undefined;
  // `null` is the CONTRACT's "unresolved", so it is valid input and must survive the parse; an
  // absent key is not the same thing and is rejected, because the producer is required to state it.
  if (owner !== null && typeof owner !== "string") return undefined;
  if (kind !== "conflicting" && kind !== "stale") return undefined;
  if (!Number.isSafeInteger(o["commitsBehind"]) || (o["commitsBehind"] as number) < 0) return undefined;
  if (typeof o["untested"] !== "boolean") return undefined;
  if (!Number.isSafeInteger(o["unresolvedSecs"]) || (o["unresolvedSecs"] as number) < 0) return undefined;
  // `null` AND absent both mean "no hold reason", and the producer sends the first: `blocked_by` is
  // a Rust `Option<String>`, and serde with no `skip_serializing_if` renders `None` as JSON `null`.
  // Accepting only `undefined` here rejected every successfully-read PR — and because the caller is
  // all-or-nothing, one such entry turned the whole sweep into "we did not look", so the class could
  // never fire. Unlike `ownerAgentId`, where `null` is a distinct FACT (unresolved) that must
  // survive, `null` here carries no information the absent key does not, so it normalises to absent.
  if (blockedBy !== undefined && blockedBy !== null && typeof blockedBy !== "string") return undefined;
  return {
    pr: o["pr"] as number,
    branch: o["branch"],
    ownerAgentId: owner,
    kind,
    commitsBehind: o["commitsBehind"] as number,
    untested: o["untested"],
    unresolvedSecs: o["unresolvedSecs"] as number,
    ...(typeof blockedBy === "string" ? { blockedBy } : {}),
  };
}

/**
 * A whole payload, or `undefined` for "we could not read this".
 *
 * Exported for the tests, which is the only way the all-or-nothing rule above can be pinned — the
 * live path swallows the answer into a store.
 */
export function parseConflictFlags(payload: unknown): ConflictingPr[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const out: ConflictingPr[] = [];
  for (const raw of payload) {
    const one = parseOne(raw);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

/**
 * Run the probe once and record whatever it says.
 *
 * Returns whether a reading was recorded, so a caller can tell "no conflicts" from "no answer" —
 * the same distinction the store exists to hold, surfaced for anyone driving this by hand.
 */
export async function pollConflictFlags(): Promise<boolean> {
  let payload: unknown;
  try {
    payload = await invoke(CONFLICT_FLAGS_COMMAND);
  } catch (e) {
    // Includes the case that matters most on an older backend: the command does not exist. That is
    // WE DID NOT LOOK, and the store is deliberately left as it was.
    log.debug("conflict", "conflict probe unavailable", { error: String(e) });
    return false;
  }
  const parsed = parseConflictFlags(payload);
  if (parsed === undefined) {
    log.warn("conflict", "conflict probe returned a payload this build cannot read; staying quiet");
    return false;
  }
  // AN EMPTY LIST IS NOT AN ANSWER UNTIL THE PRODUCER SAYS IT SWEPT SOMETHING.
  //
  // The `catch` above cannot cover this: the producer's per-PR fail-closed path only keeps
  // ALREADY-TRACKED PRs climbing, so a `gh` that is absent or unauthenticated from process start
  // means nothing is ever tracked and `conflict_flags` SUCCEEDS with `[]` — forever. Read alone that
  // is "we swept everything and it all merges", which is the one thing this module may never say.
  //
  // Only the empty case needs the proof. A non-empty list is self-evidently a real reading — the
  // producer cannot invent a conflicting PR it failed to read — and discarding it because some
  // OTHER repo was unreadable would trade a false all-clear for a false silence.
  if (parsed.length === 0 && !(await sweptSomething())) return false;
  useConflictStore.getState().setConflictFlags(parsed);
  return true;
}

/**
 * Did the last sweep actually READ anything? Fail-closed: anything short of a clear yes — the
 * command missing on an older backend, a malformed reply, a repo it could not read — is "no proof",
 * because the only alternative is publishing an all-clear nobody measured.
 */
async function sweptSomething(): Promise<boolean> {
  let status: unknown;
  try {
    status = await invoke(CONFLICT_PROBE_STATUS_COMMAND);
  } catch (e) {
    log.debug("conflict", "no probe status; an empty list proves nothing", { error: String(e) });
    return false;
  }
  if (typeof status !== "object" || status === null) return false;
  const s = status as Record<string, unknown>;
  if (s["everProbed"] !== true) {
    log.debug("conflict", "probe has never completed a sweep; staying quiet");
    return false;
  }
  if (typeof s["unreadable"] !== "number" || s["unreadable"] > 0) {
    log.warn("conflict", "sweep could not read every repo; an empty list is not an all-clear", {
      unreadable: s["unreadable"],
      lastError: s["lastError"],
    });
    return false;
  }
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;
let startPromise: Promise<() => void> | undefined;

/**
 * Start following conflict state: the event when Rust volunteers it, the poll as the floor.
 *
 * BOTH, not either. The event is what makes a newly-conflicting PR visible within one sweep; the
 * poll is what makes the feature work at all when the event is never emitted — which is every build
 * where the Rust side has not landed yet, and any window that started after the last event fired.
 * A detector whose only input is an event it does not control is a detector that reports an
 * all-clear whenever the producer is quiet, which is the shape of bug this class was written for.
 *
 * Singleton-guarded like `startAiServiceHealthListener`: StrictMode and HMR both double-mount, and
 * a second interval would double the `gh` traffic for no additional information.
 */
export function startConflictFlags(): Promise<() => void> {
  startPromise ??= doStart().catch((e: unknown) => {
    startPromise = undefined;
    throw e;
  });
  return startPromise;
}

async function doStart(): Promise<() => void> {
  const unlisten = await listen(CONFLICT_DETECTED_EVENT, (event) => {
    // The payload IS the current full set, not a delta — a delta would need a merge rule here, and
    // that rule would be a second opinion about state Rust already holds. An unreadable payload
    // leaves the store alone rather than half-updating it.
    const parsed = parseConflictFlags(event.payload);
    if (parsed === undefined) {
      log.warn("conflict", "conflict event payload unreadable; keeping the last reading");
      return;
    }
    useConflictStore.getState().setConflictFlags(parsed);
  });

  // Probe immediately, then on the floor. Unlike the Pusher's own sweep there is nothing to gain by
  // waiting: this reads state that is already true, and the two-observation rule downstream is what
  // decides whether it may be spoken about.
  void pollConflictFlags();
  timer = setInterval(() => void pollConflictFlags(), CONFLICT_POLL_MS);

  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    // Through `safeUnlisten`: Tauri's unlisten is async, so a bare call hands back a rejected
    // promise on the teardown race rather than throwing.
    void safeUnlisten(unlisten);
    startPromise = undefined;
  };
}

/** Test seam: forget that anything was started. */
export function _resetConflictFlagsForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  startPromise = undefined;
}
