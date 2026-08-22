// ── IS THIS ACCOUNT IN ROTATION, AND IS ROTATION RUNNING AT ALL? ────────────────────────────────
//
// The founder's ask, in his words: "If it's in rotation, let's just have a green dot and have it say
// in rotation. If it's not in rotation, for some reason, give it a red dot and say out of rotation.
// And then in the three dot menu, give me the option to take it out of rotation if it's in rotation
// or put it in rotation if it's out of rotation." Plus a fleet-wide control: "there would just be a
// pause button. And I could pause the fleet rotation."
//
// TWO THINGS LIVE HERE AND THEY ARE DIFFERENT KINDS OF THING.
//
//   * The PURE derivation ({@link accountRotationState}) — given what is already known about an
//     account, is it in rotation, and if not, why not. No IO, no storage, no clock. It is the single
//     answer the card's dot, the card's kebab and the header's count all render, so those three can
//     never disagree about whether an account is in the pool. Disagreement is the specific failure
//     the founder kept hitting on this screen: a green row that could not receive an agent.
//
//   * The PERSISTED state — the manual opt-outs and the pause — read through `localStorage` on every
//     call, the same discipline `accountStore`'s pin map and preferred-account use, and for the same
//     three reasons: these are consumed OUTSIDE React (the spawn path calls them), they must survive
//     a restart (a pause that evaporates is not a pause), and a cached module-level copy would mask
//     another window's write.
//
// WHY MANUAL OPT-OUT IS NOT JUST A UI FLAG. A toggle that greys a dot and changes nothing about where
// agents go would be the worst thing this screen could ship: it is precisely the "control that
// silently re-routes an invisible fleet" problem, inverted. So `outOfRotationIds` is fed to
// `PickOptions` and demotes exactly like `clobberedIds` / `unauthedIds` — out of `candidates`, never
// out of `eligible`, so taking every account out of rotation degrades to "least-bad" rather than
// blocking every spawn. Same discipline as every other exclusion in `partitionAccounts`.

/** localStorage key holding the ids the user has manually taken OUT of rotation. Exported for tests. */
export const ROTATION_OUT_STORAGE_KEY = "sparkle.rotationOut.v1";

/** localStorage key holding the fleet-wide pause. Exported for tests. */
export const ROTATION_PAUSED_STORAGE_KEY = "sparkle.rotationPaused.v1";

/** Why an account is not in rotation. Ordered by PRECEDENCE in {@link accountRotationState}: the
 *  first true one is the one shown, because a card has room for one reason and the most fundamental
 *  is the one worth acting on. */
export type OutOfRotationReason =
  /** No Claude login in this config dir at all. The card's own "Finish sign-in" is the remedy. */
  | "not-signed-in"
  /** A login was there and Claude now rejects it. "Reconnect" is the remedy. */
  | "login-expired"
  /** A second registration of a login another row already holds. Two rows, one quota — putting this
   *  one in rotation would buy nothing, which is why the toggle is refused rather than merely unused. */
  | "duplicate"
  /** The user took it out from the kebab. The only reason that is reversible from this screen. */
  | "manual";

export interface AccountRotationState {
  /** True when this account can receive a spawn from rotation right now. */
  inRotation: boolean;
  /** Null exactly when `inRotation` is true. */
  reason: OutOfRotationReason | null;
  /** Whether the kebab's in/out toggle is offered. False for the three STRUCTURAL reasons — the
   *  founder asked for this on duplicates ("the ability to put it into rotation would be grayed out
   *  … because it's a duplicate") and the same argument is what makes it right for the other two: a
   *  toggle that cannot change the outcome is a lie about what the user controls. Signing in or
   *  reconnecting is what puts those rows back in the pool, and each card already offers that button. */
  canToggle: boolean;
}

export interface AccountRotationInput {
  /** Has a real Claude login (uuid OR email) — `AccountsScreen`'s `isSignedIn`. */
  signedIn: boolean;
  /** The live `claude auth status` probe says the session is dead. */
  loginExpired: boolean;
  /** A row for a login another account already claims — `duplicateAccountIds` / `rotationReadiness`'s
   *  `redundant` bucket. */
  duplicate: boolean;
  /** The user took this one out from the kebab. */
  manuallyOut: boolean;
}

/** The ONE answer to "is this account in rotation". Pure.
 *
 *  Precedence is deliberate and is not alphabetical: a not-signed-in duplicate is reported as not
 *  signed in, because that is the fact a human can act on and "duplicate" would send them to fix the
 *  wrong thing. `manual` sorts last for the mirror-image reason — it is the only reason that is a
 *  CHOICE, so reporting it over a structural block would present a reversible state where the real
 *  one is not reversible from here. */
export function accountRotationState(input: AccountRotationInput): AccountRotationState {
  if (!input.signedIn) return { inRotation: false, reason: "not-signed-in", canToggle: false };
  if (input.loginExpired) return { inRotation: false, reason: "login-expired", canToggle: false };
  if (input.duplicate) return { inRotation: false, reason: "duplicate", canToggle: false };
  if (input.manuallyOut) return { inRotation: false, reason: "manual", canToggle: true };
  return { inRotation: true, reason: null, canToggle: true };
}

/** Short label for the dot beside it. The founder's own words, both of them. */
export function rotationLabel(state: AccountRotationState): string {
  return state.inRotation ? "in rotation" : "out of rotation";
}

/** The sub-label under "out of rotation" naming WHY, or null when the row is in rotation.
 *
 *  `duplicate` is the founder's literal ask ("below that say duplicate"). The other three follow the
 *  same shape — one word or two, no sentence — because the card already carries a full explanation
 *  for each of them in its own banner, and repeating it here would be the wall of text he asked to
 *  have removed from the top of this screen. */
export function rotationReasonLabel(state: AccountRotationState): string | null {
  switch (state.reason) {
    case "duplicate":
      return "duplicate";
    case "not-signed-in":
      return "not signed in";
    case "login-expired":
      return "login expired";
    case "manual":
      return "you took it out";
    default:
      return null;
  }
}

// ── PERSISTED: the manual opt-outs ──────────────────────────────────────────────────────────────

/** The account ids the user has taken out of rotation.
 *
 *  A corrupt or non-array entry reads as EMPTY — i.e. everything stays in rotation. That direction is
 *  chosen on purpose: the failure mode of guessing wrong here is either "an account you excluded gets
 *  a spawn" or "your whole fleet silently stops receiving spawns", and only the first is recoverable
 *  by looking at the screen. */
export function rotationOutIds(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(ROTATION_OUT_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string" && v.length > 0));
  } catch {
    return new Set(); // unreadable storage → nothing is excluded
  }
}

/** Put `accountId` in or out of rotation. Idempotent. */
export function setAccountInRotation(accountId: string, inRotation: boolean): void {
  const next = new Set(rotationOutIds());
  // Putting an account back IN rotation ends the auth-lapse rescue's episode for it, so a later
  // opt-out is answered fresh rather than falling under a memory from months ago. The rescue's own
  // write lands here too — it marks AFTER calling `recordPreference`, so its mark survives.
  if (inRotation) forgetRescuedOnto(accountId);
  if (inRotation) next.delete(accountId);
  else next.add(accountId);
  try {
    globalThis.localStorage?.setItem(ROTATION_OUT_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Storage unavailable or over quota. Never let recording a preference break a spawn.
  }
}

// ── PERSISTED: the fleet-wide pause ─────────────────────────────────────────────────────────────

/** What a pause remembers.
 *
 *  WHY IT CARRIES AN ACCOUNT ID. "Pause the rotation" cannot mean "stop spawning" — that would turn a
 *  glance-level toggle into a fleet outage, and the founder described it as a pause, not a stop. It
 *  means the thing rotation actually DOES stops: Sparkle stops re-ranking accounts by headroom and
 *  keeps sending new agents to the account that was leading when you paused. So the pause freezes a
 *  target, and resuming forgets it.
 *
 *  `accountId` may be null — paused with nothing usable to freeze onto. That degrades to ordinary
 *  auto-pick rather than blocking, exactly like every other unusable preference in this codebase. */
export interface RotationPause {
  /** Epoch ms the pause was set, for the header's tooltip. */
  at: number;
  /** The account new agents are frozen onto while paused, or null when there was none to freeze. */
  accountId: string | null;
}

/** The current pause, or null when rotation is running.
 *
 *  Tolerates a legacy/corrupt entry by reading any truthy stored value as "paused with no frozen
 *  account" rather than throwing it away: a pause that silently un-pauses itself is the one outcome a
 *  user would not forgive here, and "paused, freezing nothing" is the safe half of the state. */
export function rotationPause(): RotationPause | null {
  try {
    const raw = globalThis.localStorage?.getItem(ROTATION_PAUSED_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === false || parsed == null) return null;
    if (typeof parsed === "object") {
      const o = parsed as Partial<RotationPause>;
      return {
        at: typeof o.at === "number" ? o.at : 0,
        accountId: typeof o.accountId === "string" && o.accountId.length > 0 ? o.accountId : null,
      };
    }
    return { at: 0, accountId: null };
  } catch {
    return null; // unreadable storage → rotation runs, which is the pre-pause behaviour
  }
}

/** Is rotation paused? The boolean the header renders. */
export function isRotationPaused(): boolean {
  return rotationPause() != null;
}

/** Pause rotation, freezing new agents onto `accountId` (null when nothing is usable). */
export function pauseRotation(accountId: string | null, now: number = Date.now()): void {
  try {
    globalThis.localStorage?.setItem(
      ROTATION_PAUSED_STORAGE_KEY,
      JSON.stringify({ at: now, accountId } satisfies RotationPause),
    );
  } catch {
    // Same as above — recording a pause must never break a spawn.
  }
}

/** Resume rotation and forget the frozen account. */
export function resumeRotation(): void {
  try {
    globalThis.localStorage?.removeItem(ROTATION_PAUSED_STORAGE_KEY);
  } catch {
    // Same as above.
  }
}

// ── ELECTING THE POOL, PER LOGIN RATHER THAN PER ROW ────────────────────────────────────────────

/** Re-elect each login group's representative from the members that are still in rotation.
 *
 *  WHY THIS EXISTS. `rotationReadiness` partitions accounts into `usable` (one representative per
 *  distinct login) and `redundant` (the rest of each group), and it picks the representative by
 *  INPUT ORDER, before anything about the user's choices is known. Netting an opt-out off `usable`
 *  afterwards is therefore wrong in a way that depends on registration order: with a login
 *  registered twice as A and A′, taking A out drops the whole login from the count — while agents
 *  can still reach it through A′, because `partitionAccounts` excludes duplicates from nothing and
 *  `outOfRotationIds` is per-id. Taking A′ out instead correctly changes nothing. Same fleet, two
 *  different answers, decided by which row happened to be listed first.
 *
 *  So the election is redone with the exclusions in hand: a login is IN the pool when any member is
 *  still eligible, and the first such member represents it. The rows that lose stay redundant, and
 *  the rows that were excluded say so for their own reason — which is what keeps the count and the
 *  cards derived from one partition instead of two.
 *
 *  Pure, and generic over the row type, so the accounts screen and the concierge's `read_usage` can
 *  share it rather than each netting its own way. */
export function electRotationPool<T extends { id: string }>(
  /** Every SIGNED-IN account, in list order — `readiness.usable` and `readiness.redundant` together. */
  signedIn: readonly T[],
  /** id → its login group key. An id with no entry is its own login (nothing proved it shares one). */
  groupKeyById: ReadonlyMap<string, string>,
  /** Ids that cannot receive a spawn: manual opt-outs, and anything else the caller excludes. */
  excluded: ReadonlySet<string>,
): { pool: T[]; redundant: T[] } {
  const pool: T[] = [];
  const claimedBy = new Map<string, string>();
  for (const a of signedIn) {
    if (excluded.has(a.id)) continue; // out for its own reason — it cannot represent its login
    const key = groupKeyById.get(a.id) ?? a.id;
    if (claimedBy.has(key)) continue;
    claimedBy.set(key, a.id);
    pool.push(a);
  }
  // REDUNDANCY IS ABOUT THE LOGIN, NOT ABOUT THE EXCLUSION, and computing it from the rows the
  // election skipped got that backwards. A row that is BOTH a duplicate and manually out would fall
  // out of `redundant` entirely, so the card reported `manual` — inverting the precedence
  // `accountRotationState` documents, where `manual` sorts LAST because it is the only reversible
  // reason. The visible cost was a live "Put in rotation" on a shared-quota row: clicking it re-ran
  // the election, the sibling reclaimed the login, and the row came straight back as a duplicate.
  // The control did nothing, which is the exact state the disabled toggle exists to prevent.
  //
  // So a row is redundant when its login is represented in the pool BY SOMEONE ELSE — whether or not
  // this row is also excluded for a reason of its own.
  const redundant = signedIn.filter((a) => {
    const holder = claimedBy.get(groupKeyById.get(a.id) ?? a.id);
    return holder != null && holder !== a.id;
  });
  return { pool, redundant };
}

// ── THE AUTH-LAPSE RESCUE'S MEMORY ──────────────────────────────────────────────────────────────

/** localStorage key holding the accounts the auth-lapse rescue has steered onto OVER AN OPT-OUT. */
export const RESCUED_ONTO_STORAGE_KEY = "sparkle.rescuedOnto.v1";

/** The accounts `ReadinessGate.ensureUsablePreferred` has already rescued onto over a standing
 *  opt-out — so it does it once each, and a second opt-out stands.
 *
 *  IT EXISTS TO MAKE THE RESCUE FIRE ONCE, between two failures that are both real:
 *
 *  • RESCUE EVERY TIME and it re-clears the user's opt-out on every window focus, because `probe()`
 *    runs on every focus. The kebab click cannot hold.
 *  • NEVER RESCUE ONTO AN OPTED-OUT ACCOUNT and the fleet strands on the expired default. Not the
 *    harmless outcome it looks like: `leastBad` runs only when `candidates` is EMPTY, and at
 *    `chooseAccountForAgent` the lapsed default is still a candidate — its recorded email keeps it in
 *    `signedInIds`, and it carries no wall and no live-spent row. The opted-out alternative is
 *    filtered out, the expired default is all that is left, and every agent opens on a login prompt.
 *
 *  A SET, NOT A LAST-WINS STRING. With three accounts a single value is reassigned out from under an
 *  answer the user already gave: rescue onto `b`, user takes `b` out, the next pick returns `c` (the
 *  ranking is lowest-usage-first and usage moves as agents run) so the memory becomes `c`, user takes
 *  `c` out, the pick returns `b` — and with the memory now naming `c` the guard misses and `b`'s
 *  opt-out is reverted. Unbounded, just on a longer cycle.
 *
 *  EPISODES, NOT ONCE-EVER. {@link setAccountInRotation} drops an id from this set when an account is
 *  put back IN rotation, so a deliberate put-back starts the clock again. The rescue's own write goes
 *  through `recordPreference` (which puts the account back in rotation) BEFORE it marks, so its mark
 *  survives its own clear — see the call order in `ensureUsablePreferred`. */
export function rescuedOntoIds(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(RESCUED_ONTO_STORAGE_KEY);
    if (typeof raw !== "string" || raw.length === 0) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string" && v.length > 0));
  } catch {
    // Unreadable storage → no memory → the rescue fires. Better a rescue than a strand.
    return new Set();
  }
}

/** Record that the rescue steered onto `accountId` over a standing opt-out. */
export function markRescuedOnto(accountId: string): void {
  const next = new Set(rescuedOntoIds());
  next.add(accountId);
  try {
    globalThis.localStorage?.setItem(RESCUED_ONTO_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Never let bookkeeping break a rescue.
  }
}

/** Forget that the rescue steered onto `accountId`, so a later opt-out gets a fresh episode. */
export function forgetRescuedOnto(accountId: string): void {
  const next = new Set(rescuedOntoIds());
  if (!next.delete(accountId)) return;
  try {
    globalThis.localStorage?.setItem(RESCUED_ONTO_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Same as above.
  }
}
