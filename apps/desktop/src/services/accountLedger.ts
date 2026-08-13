// WHICH ACCOUNT DID THAT SPAWN ACTUALLY RUN UNDER — the durable answer.
//
// Sparkle has picked a Claude account per spawn since Phase 0, and picked it PROACTIVELY (before an
// account hits its wall) since #1463. Neither of those was ever RECORDED anywhere. The chosen
// account lived in one React `useState` inside the pane that spawned it and died with the pane, so
// the question "which account did the last N spawns use, and did that change when one approached
// its ceiling" had no answer — not for the founder, and not for an agent asked to prove rotation
// works. Being told twice that rotation "landed" while seeing nothing change is the direct
// consequence: an unobservable behaviour is indistinguishable from an absent one.
//
// So every account resolution appends a line to `<app_data_dir>/account-spawn-log.jsonl` (Rust
// `accounts_record_spawn`). One JSON object per line, on purpose — the file IS the evidence, and it
// has to be readable with `cat` by a human who is not running the app.
//
// WHAT IS RECORDED IS THE DECISION, NOT JUST THE OUTCOME. `accountId` alone cannot distinguish "it
// picked this account because it was the best of several" from "this was the only account it was
// allowed to choose" — and on the founder's machine it is the second one, which is the whole reason
// he cannot see rotation. `eligibleCount`, `signedInCount` and `candidateIds` are what make that
// visible in the log itself rather than requiring someone to re-derive it.
import { invoke } from "@tauri-apps/api/core";

/** One recorded account selection. Field names are the camelCase wire contract of the Rust
 *  `SpawnLogEntry` (`accounts_record_spawn` / `accounts_spawn_log`); they are pinned on both sides
 *  because this repo has already shipped a snake_case/camelCase mismatch that made every field read
 *  `undefined` on the JS side while typechecking perfectly (`RawUsage`, accountStore.ts). */
export interface SpawnLogEntry {
  /** Epoch MS of the selection. */
  at: number;
  /** Who was being resolved: an agent id, `sparkle:concierge`, or the Improve Sparkle namespace. */
  key: string;
  /** null when no account was chosen at all — the spawn inherits whatever the shell is logged into. */
  accountId: string | null;
  nickname: string | null;
  configDir: string | null;
  /** The account's REAL authenticated identity, which is the trustworthy label. The nickname is
   *  user-typed and has no bearing on which login a config dir actually holds. */
  email: string | null;
  reason: SelectionReason;
  // ── THE MEASURED FIELDS ──────────────────────────────────────────────────────────────────────
  // Every one of these is `| null`, and null means NOT EVALUATED — distinct from evaluated-and-zero.
  //
  // That distinction is the whole integrity of this file. `reason: "remembered"` fires only when the
  // accounts backend could not be read at all, so there is no usage, no identity and no ceiling to
  // report. Writing the obvious zeros there would state, in the vocabulary this very interface
  // defines, that every account was exhausted (`candidateIds: []`), that nobody was signed in
  // (`signedInCount: 0`) and that the chosen account was idle (`tokens5h: 0`) — three measurements
  // nobody took, recorded as fact, in a file whose only purpose is being trusted later by someone
  // reconstructing what happened. A transient IPC hiccup would read back as a fleet-wide outage.
  //
  // It is the same "never coerce null to zero" rule the selection code applies to an unlearned
  // ceiling, and it matters more here, because a reader of a log cannot re-run the moment.
  /** Trailing-5h consumption of the chosen account. Null when not evaluated. */
  tokens5h: number | null;
  /** Learned ceiling, or null when there is not enough history to estimate one (or it wasn't
   *  evaluated). NEVER read null as zero — an unmeasured account is not an empty one. */
  ceiling: number | null;
  /** `tokens5h / ceiling`, null when the ceiling is unknown. Can exceed 1: the ceiling is a MEDIAN
   *  of past limit episodes, so by construction about half of them sit above it. */
  fraction: number | null;
  /** How many accounts auto-pick was allowed to choose from. Null when not evaluated. */
  eligibleCount: number | null;
  /** How many registered accounts are actually signed in. **1 here means rotation was impossible at
   *  this instant** regardless of what the selection rule would have done. Null when not evaluated —
   *  which must NOT be read as "nobody is signed in". */
  signedInCount: number | null;
  /** The ids that were healthy candidates at this instant. EMPTY means every account was exhausted
   *  or over its act line and the pick came from the least-bad fallback; NULL means the pool was
   *  never evaluated. */
  candidateIds: string[] | null;
}

/** Why this account was chosen. Distinguishing these is the difference between "rotation ran and
 *  chose this" and "there was nothing else it could have chosen". */
export type SelectionReason =
  | "pinned" // a human pinned this agent to this account; the pin overrides every judgement
  // A human ACTIVATED this account for the whole fleet ("Activate this account" in the accounts
  // modal) and it is still real, signed in and not rate-limited. Distinct from "pinned" — that is
  // one agent, this is every future spawn — and distinct from "auto", which is what this degrades
  // to the moment the preference stops describing a usable account. Recording them apart is the
  // only way to read back whether the founder's choice was actually in force at a given spawn.
  | "preferred"
  | "auto" // ordinary auto-pick: lowest usage among healthy, signed-in accounts
  | "sticky" // a sticky key (concierge / Improve Sparkle) reusing its still-healthy account
  | "fallback" // every account was exhausted or near its ceiling; this was the least-bad one
  | "remembered" // the accounts backend was unreadable; carried this key through on its last answer
  | "none"; // no account chosen (none configured, or the backend is unreadable with no history)

/** Append one selection to the on-disk ledger.
 *
 *  NEVER REJECTS, and that is load-bearing rather than defensive habit: this is called from the
 *  spawn path, and losing a log line must never cost a spawn. A backend that predates the command
 *  rejects the invoke, which is exactly as harmless as the file being unwritable — both mean "no
 *  evidence recorded", never "no agent started". */
export async function recordSelection(entry: SpawnLogEntry): Promise<void> {
  try {
    await invoke("accounts_record_spawn", { entry });
  } catch (e) {
    warnOnceThatNothingIsBeingRecorded(e);
  }
}

/** Have we already said the ledger isn't reaching a backend? */
let warnedAboutBackend = false;

/** Say ONCE that nothing is being written, then never again.
 *
 *  Silence here was a real hazard rather than a tidy default: a build whose Rust side lacks
 *  `accounts_record_spawn` rejects every call, so the log file is never created — and with the
 *  rejection swallowed, that state is by construction undetectable at runtime. The result would be
 *  an observability feature that is itself unobservable when broken, which is precisely the
 *  "told it landed, nothing changed" failure this ledger exists to end.
 *
 *  Once, not per call, and that is the reason it was silent to begin with: `chooseAccountForAgent`
 *  runs on every spawn and every concierge turn, so a warn per rejection would be a console flood
 *  during a fleet storm. One line is discoverable; hundreds are noise that gets filtered out. */
function warnOnceThatNothingIsBeingRecorded(cause: unknown): void {
  if (warnedAboutBackend) return;
  warnedAboutBackend = true;
  console.warn(
    "accountLedger: could not record which account this spawn used — no account-spawn-log.jsonl " +
      "will be written, so the Accounts screen's spawn history will stay empty. This build's " +
      "backend may predate the accounts_record_spawn command.",
    cause,
  );
}

/** The most recent `limit` selections, NEWEST FIRST.
 *
 *  An empty array is the honest answer for both "nothing recorded yet" and "the ledger could not be
 *  read" — this is a read-only diagnostic surface, so degrading to "no evidence" is correct. A
 *  caller must not present an empty result as "no rotation happened". */
export async function readSpawnLog(limit = 50): Promise<SpawnLogEntry[]> {
  try {
    const rows = await invoke<SpawnLogEntry[]>("accounts_spawn_log", { limit });
    // Shape-checked, not merely error-checked: a bridge that RESOLVES something that isn't an array
    // (an older backend, a non-Tauri host) sails past the catch and would throw on `.map` in the
    // renderer instead — outside this guard.
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// ── Which resolutions are worth a line ────────────────────────────────────────────────────────
//
// `chooseAccountForAgent` is NOT called once per spawn for every key. A build agent resolves once,
// at spawn — but the concierge resolves once per TURN and Improve Sparkle once per hourly pass plus
// every time its pane opens. Logging all of them unfiltered would bury the handful of real spawn
// decisions under thousands of concierge turns that chose the same account every time, inside a
// file capped at 2000 lines. The evidence would evict itself.
//
// So: a NON-sticky key (an ordinary agent) is logged every time, because each of those resolutions
// really is a distinct spawn. A STICKY key is logged only when its answer CHANGES — which is
// precisely the event worth recording, since a sticky key moving is a rotation.

/** Last recorded account per sticky key, so an unchanged sticky resolution is not re-logged.
 *  Process-lifetime only: after a restart the first resolution of each key is logged again, which is
 *  correct — a restart genuinely re-decides, and the log should say which account it landed on. */
const lastLoggedForStickyKey = new Map<string, string | null>();

/** Should this resolution be written to the ledger? See the note above for why stickiness decides.
 *
 *  Exported for tests, and pure so the policy can be asserted without touching the IPC boundary. */
export function shouldLogSelection(
  key: string,
  accountId: string | null,
  isSticky: boolean,
): boolean {
  if (!isSticky) return true;
  const seen = lastLoggedForStickyKey.has(key);
  const previous = lastLoggedForStickyKey.get(key) ?? null;
  lastLoggedForStickyKey.set(key, accountId);
  // A key we have never logged is always worth a line — otherwise the very first account a sticky
  // key settles on, which is the baseline every later change is measured against, is never recorded.
  return !seen || previous !== accountId;
}

/** Forget the sticky de-dupe state and the once-only backend warning (tests). */
export function resetSelectionLog(): void {
  lastLoggedForStickyKey.clear();
  warnedAboutBackend = false;
}
