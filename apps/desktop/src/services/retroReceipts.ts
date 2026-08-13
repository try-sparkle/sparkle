// THE TS SIDE OF THE RETIREMENT RECEIPT STORE — read on every status poll, written by four paths.
//
// Thin by design: `src-tauri/src/retro_receipt.rs` owns the file, the lock and the fail-safe
// degradation. This module owns the CACHE the build column reads synchronously while rendering, and
// the four `record*` helpers that name each writer's intent so a call site cannot invent a state.
//
// ── WHY A CACHE AT ALL ───────────────────────────────────────────────────────────────────────────
// `retirementPill` is pure and is called during render, once per row. It cannot await. Every other
// per-row datum the sidebar shows (branch status, workflow stage, goal) already works this way —
// a poller writes a store, the row reads it. This is that, for receipts.
//
// ── EVERY FAILURE READS AS "HAS NOT REPORTED" ────────────────────────────────────────────────────
// A failed invoke leaves the cache untouched and logs; it never writes an empty entry and never
// invents a receipt. That is the same fail-safe direction the Rust store takes, for the same
// reason: an agent that reads as unreported gets ASKED, which is recoverable. An agent that falsely
// reads as settled gets a RETIREMENT RECOMMENDED badge it did not earn, which is the exact silent
// skip bead sparkle-0l9xk exists to close.
import { invoke } from "@tauri-apps/api/core";
import { log } from "../logger";
import { assessNoRetroReason } from "../engine/retroMuster";
import { isNoRetroReason } from "../engine/retroReceiptTypes";
import type { RetroReceipt } from "../engine/retroReceiptTypes";

/** projectId → agentId → receipt. Module-level, like the other poll-backed caches the sidebar reads. */
const cache = new Map<string, Map<string, RetroReceipt>>();

/** Bumped on every mutation so a React caller can `useSyncExternalStore`/re-render off it without
 *  diffing the whole map. */
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

/** Subscribe to receipt changes. Returns the unsubscribe. */
export function subscribeRetroReceipts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Monotonic snapshot token for `useSyncExternalStore`. */
export function retroReceiptsVersion(): number {
  return version;
}

/**
 * The cached receipt for one agent, or `undefined` when none is known.
 *
 * SYNCHRONOUS AND CACHE-ONLY — safe to call during render. `undefined` here means "not in the
 * cache", which covers both "the agent has not reported" and "we have not loaded this project yet".
 * Both must be treated as unsettled, and `engine/retroReceiptTypes.retroSettled` does exactly that.
 */
export function cachedReceipt(projectId: string, agentId: string): RetroReceipt | undefined {
  return cache.get(projectId)?.get(agentId);
}

/** Load every receipt for a project into the cache. Called by the status poll. */
export async function loadRetroReceipts(projectId: string): Promise<void> {
  try {
    const all = await invoke<Record<string, RetroReceipt>>("retro_receipt_all", { projectId });
    // REPLACE the project's map rather than merging into it: a receipt can only ever be added or
    // overwritten on disk, never deleted, so a wholesale replace cannot lose one — and merging
    // would keep a stale entry alive if the store were ever reset out from under us.
    cache.set(projectId, new Map(Object.entries(all ?? {})));
    emit();
  } catch (e) {
    // Leave the cache exactly as it was. See the header: a read failure must not manufacture a
    // settled reading, and must not erase receipts we already hold.
    log.debug("retro-receipts", "load failed", { projectId, error: String(e) });
  }
}

/** Write one receipt through to disk and into the cache. Returns whether the write landed.
 *
 *  The cache is updated ONLY on success. Optimistically caching a receipt whose write failed would
 *  show RETIREMENT RECOMMENDED for a step that was never durably recorded — and the row can be
 *  retired (and the record consulted) long after this process is gone. */
async function record(
  projectId: string,
  agentId: string,
  receipt: RetroReceipt,
): Promise<boolean> {
  try {
    await invoke("retro_receipt_record", { projectId, agentId, receipt });
    let byAgent = cache.get(projectId);
    if (!byAgent) {
      byAgent = new Map();
      cache.set(projectId, byAgent);
    }
    byAgent.set(agentId, receipt);
    emit();
    return true;
  } catch (e) {
    log.warn("retro-receipts", "record failed", { agentId, error: String(e) });
    return false;
  }
}

/** A real retro was observed. `painPointCount` of ZERO is a complete retro, not a missing one —
 *  pass it through rather than collapsing it to undefined.
 *
 *  ── NO PRODUCTION WRITER YET, AND EVERY READER MUST BE READ IN THAT LIGHT (roborev 58771/59153) ──
 *  `recordRetroExcused` has a live caller (`conciergeTools/lifecycle`'s `close_agent` no-retro arm)
 *  and `recordRetroOverridden` has the human one. This has NEITHER: the PR-marker parse that would
 *  call it is the next phase of bead `sparkle-0l9xk`, not this one. So no `captured` receipt can
 *  exist yet, and the copy keyed on that STATE specifically — the confirm dialog's quoted `tldr`,
 *  and anything reading `source: "pr-marker" | "result-json"` — is unreachable in production.
 *
 *  WHAT THIS DOES NOT MEAN, because an earlier version of this header said it and it was wrong
 *  (roborev 59704): it does NOT mean `retirementPill` cannot return `"ready"`, and it does NOT mean
 *  a measurement taken today reads 100% `retro-pending`. `retroSettled` is `receipt != null` — it
 *  does not look at `state` — so the `excused` receipt written by `close_agent`'s no-retro arm
 *  settles a row that then STAYS (a landed row still comes back `needs-human-confirm`), and that row
 *  paints `ready` and gets the dialog's settled wording. A `ready` sighting today is therefore an
 *  agent's own excuse, never an observed retro; read it that way rather than as impossible.
 *
 *  The gap is stated rather than fixed, and the distinction the reviews kept re-raising is the
 *  important one: this is not dead code and must not be deleted, and it is not a bug in the readers
 *  either. They are already correct for the day the producer arrives — `retroSettled` is fail-closed
 *  toward unsettled, so an ABSENT receipt reads as "we have not been told", never as a false gap. */
export function recordRetroCaptured(
  projectId: string,
  agentId: string,
  from: { source: "pr-marker" | "result-json"; prNumber?: number; tldr?: string; painPointCount: number },
): Promise<boolean> {
  return record(projectId, agentId, {
    state: "captured",
    at: Date.now(),
    source: from.source,
    ...(from.prNumber !== undefined ? { prNumber: from.prNumber } : {}),
    ...(from.tldr ? { tldr: from.tldr } : {}),
    painPointCount: from.painPointCount,
  });
}

/**
 * What happened to an agent's stated excuse. THREE outcomes, not a boolean (roborev 59215).
 *
 * A bare `false` collapsed two failures whose remedies are OPPOSITE: a rejected WORDING wants the
 * agent to rephrase (and `why` says how), a failed WRITE wants a retry of the identical text. An
 * agent handed the same generic message for both retries the wording that was just refused —
 * defeating the entire purpose of `MusterResult.why`, which exists so the re-ping is actionable.
 */
export type ExcuseOutcome =
  /** Written to disk and cached. */
  | { status: "recorded" }
  /** The reason did not pass muster. NOTHING was written; `why` is the phrase to relay verbatim. */
  | { status: "rejected"; why: string }
  /** The reason was fine; the store could not be written. Retrying the same text is correct. */
  | { status: "write-failed" };

/** The agent stated a reason for having no retro. THE MUSTER CHECK IS ENFORCED HERE.
 *
 *  It used to say "callers MUST run the muster check first" and then not run it — a documented
 *  obligation with nothing holding anyone to it, which is the shape that lets an unchecked excuse
 *  reach disk the first time somebody wires a new caller. `excused` is the one state an AGENT can
 *  write about itself, so it is the one that most needs a gate it cannot forget to call.
 *
 *  `assessNoRetroReason` stays exported and PURE, so the verdict is still reachable from the
 *  lifecycle tool and from a test with no Tauri boundary in the way — the reason the check lived
 *  outside in the first place. What changes is only that skipping it is no longer possible from
 *  here: a rejected reason returns `{ status: "rejected", why }` and NOTHING is written. Fail-closed
 *  in the same direction as everything else in this file — an agent that fails muster reads as not
 *  having reported, which gets it asked again; the opposite writes an excuse nobody vetted.
 *
 *  `reasonCode`/`reasonText` are `unknown` ON PURPOSE: the live caller is a concierge TOOL, so these
 *  arrive off the wire as whatever an agent typed. Taking them typed would have pushed the
 *  validation back out to the caller — the arrangement this function was just fixed for. */
export async function recordRetroExcused(
  projectId: string,
  agentId: string,
  // OPTIONAL keys, not just `unknown` values: `z.unknown()` infers an OPTIONAL property, so the tool
  // boundary hands over `{ reasonCode?: unknown }`. Requiring the keys here made the registry fail
  // to typecheck — and a missing key is a real wire case anyway, which muster already rejects.
  reason: { reasonCode?: unknown; reasonText?: unknown; branchEvidence?: string },
): Promise<ExcuseOutcome> {
  const muster = assessNoRetroReason(reason.reasonCode, reason.reasonText);
  if (muster.verdict === "rejected") {
    log.warn("retro-receipts", "excuse REFUSED, nothing recorded", { agentId, why: muster.why });
    return { status: "rejected", why: muster.why };
  }
  // Muster already established both, but narrowing here rather than casting keeps the write unable
  // to store a shape the contract does not allow, even if the check above is ever loosened.
  if (!isNoRetroReason(reason.reasonCode) || typeof reason.reasonText !== "string") {
    return { status: "rejected", why: "the reason is not one of the recognized kinds" };
  }
  const wrote = await record(projectId, agentId, {
    state: "excused",
    at: Date.now(),
    source: "agent-declared",
    reasonCode: reason.reasonCode,
    reasonText: reason.reasonText,
    ...(reason.branchEvidence ? { branchEvidence: reason.branchEvidence } : {}),
  });
  return wrote ? { status: "recorded" } : { status: "write-failed" };
}

/** A human retired an agent that could not answer. The `overridden` state a PERSON writes — the
 *  concierge writes the same state through `recordRetroConciergeOverride`, and `source` is the only
 *  thing that tells the two apart.
 *
 *  Must be awaited BEFORE the row is removed: `removeAgent` is a hard delete, so once it runs the
 *  agent id is gone from the store and there is nothing left to attribute the gap to. */
export function recordRetroOverridden(
  projectId: string,
  agentId: string,
  reason: { reasonText: string; branchEvidence?: string },
): Promise<boolean> {
  return record(projectId, agentId, {
    state: "overridden",
    at: Date.now(),
    source: "human-override",
    reasonCode: "other",
    reasonText: reason.reasonText,
    ...(reason.branchEvidence ? { branchEvidence: reason.branchEvidence } : {}),
  });
}

/** The CONCIERGE retired an agent that had no retro anywhere, on the founder's standing
 *  authorization. Same `overridden` state as the human path above, but honestly attributed.
 *
 *  ── WHY A SEPARATE WRITER RATHER THAN REUSING `recordRetroOverridden` ────────────────────────────
 *  Because the gap note is a PERMANENT, undeletable mark (there is no receipt delete path anywhere),
 *  and reusing the human writer would stamp `source: "human-override"` on a decision no person took.
 *  Anyone later auditing who accepted a gap would read a human's judgement into a machine's, with
 *  nothing on disk to contradict it. `engine/retroEvidence.mayRecordRetroGap` is what decides
 *  whether this may be called at all — it permits only `absent`, i.e. no receipt AND a trustworthy
 *  read of the backlog that found nothing.
 *
 *  ── THE RETURN VALUE GATES A TEARDOWN ────────────────────────────────────────────────────────────
 *  `true` ONLY when the write actually landed, exactly like `recordRetroOverridden` — the caller
 *  removes the row on the strength of it, and `removeAgent` is a hard delete. Answering `true` over
 *  a failed write would destroy the row and its record in the same breath, leaving no trace that the
 *  agent ever existed, let alone that its retro was missing. `record` already reports it that way
 *  and caches nothing on failure; do not wrap it in anything more optimistic.
 *
 *  `branchEvidence` accepts `null` as well as `undefined`: it is measured upstream and a measurement
 *  that could not be taken arrives as `null`. Both mean "no evidence to show", so both leave the
 *  field ABSENT rather than writing an empty one. */
export function recordRetroConciergeOverride(
  projectId: string,
  agentId: string,
  fields: { reasonText: string; branchEvidence?: string | null },
): Promise<boolean> {
  return record(projectId, agentId, {
    state: "overridden",
    at: Date.now(),
    source: "concierge-override",
    reasonCode: "other",
    reasonText: fields.reasonText,
    ...(fields.branchEvidence ? { branchEvidence: fields.branchEvidence } : {}),
  });
}

/** TEST SEAM ONLY — drop everything cached. Never call this from app code: a cleared cache reads as
 *  "nobody has reported", which would re-ping a fleet that already complied. */
export function __resetRetroReceiptsForTest(): void {
  cache.clear();
  emit();
}
