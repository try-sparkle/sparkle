// loginStanddown — THE ONE STAND-DOWN A HUMAN, AND ONLY A HUMAN, CAN CLEAR.
//
// ── THE DEFECT (bead sparkle-qg71dl) ──────────────────────────────────────────────────────────
// `nudger.rs` already knows this: `Standdown::LoginExpired` routes to `Escalation::Founder`, and
// `stamp_account` pays real IO — the PTY table plus `accounts.json` — to resolve WHICH of this
// machine's several Claude Max logins has died, precisely so a person is not told to go and guess.
// Both facts crossed the IPC boundary intact, arriving on `services/authRecovery.NudgeFlag` as
// `standdown` and `account`.
//
// Nothing on the TypeScript side ever read either one. The flag went into a module-level `Map`, the
// row it described was drawn from other inputs entirely, and the founder-level escalation the whole
// ladder exists to produce terminated in a log line. The review that filed this found the two fields
// "correct and unread"; this module is the edge that reads them.
//
// ── WHY A SECOND MODULE AND NOT A BRANCH IN `humanBlock` ──────────────────────────────────────
// Because they are different FACTS about different agents, and conflating them would make one of
// them lie. `humanBlock` relays an answer the agent GAVE — `reply === "blocked-on-human"` — so it is
// only ever true of an agent that could still speak. A dead login is the opposite population: the
// session is gone, answering costs the API call that is failing, and `reply` is null BY
// CONSTRUCTION (see `NudgeFlag.standdown`'s own docstring, which records a founder watching four
// consecutive nudges produce nothing). Folding this into `humanBlockOf` would either widen "the
// agent said so" to cover an agent that said nothing, or silently drop the account name, which is
// the only part of this a person can act on.
//
// PURE. Data in, data out; no clock, no registry read, no I/O — same contract as `humanBlock`. The
// caller supplies the flag because `services/authRecovery` OWNS the poll and the module-level flag
// map, and reaching into it would put a live registry read inside a rule that is worth having
// precisely because a test can call it with a literal.
//
// It is NOT because `engine/` may not import `services/`. THAT RULE DOES NOT EXIST — see
// `LoginStanddownFlag` below, and bead sparkle-4r68r7 for what believing it cost.

/**
 * The wire token `nudge_ladder::Standdown::as_str` writes for `Standdown::LoginExpired`.
 *
 * ⚠️ THE STAND-DOWN, NOT THE REPLY. `NudgeFlag` carries three separate "what is wrong" fields and
 * this is the only one that survives an agent being unable to SPEAK — `reply` is the agent's own
 * answer and `blockedBy` is our own gate's, and both are null for a session whose login has expired.
 */
const LOGIN_EXPIRED_STANDDOWN = "login-expired";

/**
 * The escalation target `nudge_ladder::Escalation::Founder` serialises to.
 *
 * REQUIRED IN ADDITION TO THE STAND-DOWN, for `humanBlock.FOUNDER_TARGET`'s reason exactly:
 * `Standdown::flag()` is the authority on who a stand-down is FOR, and it deliberately routes
 * several blocked-shaped stand-downs to `Escalation::Concierge` instead. Asking for BOTH means this
 * notice fires only where Rust already concluded a PERSON is the one who has to act.
 */
const FOUNDER_TARGET = "founder";

/**
 * The shape this module needs from a raised nudger flag.
 *
 * STRUCTURAL ON PURPOSE, and the reason is NARROWNESS, not layering. `NudgeFlag` carries nine
 * fields and this module reads four, so a test builds a literal without inventing `nudges`,
 * `delivered`, `blockedBy` or `silentSecs`, and widening the wire type cannot change what is read
 * here.
 *
 * ⚠️ NOT because `engine/` may not import `services/`. THAT RULE DOES NOT EXIST: no lint rule,
 * eslint config or dependency check anywhere in this repo enforces an engine→services boundary,
 * and most non-test `engine/*` modules import from `../services` today — re-measure with
 * `grep -l 'from "\.\./services' apps/desktop/src/engine/*.ts | grep -vc '\.test\.'` rather than
 * trusting a number in a comment. The claim stood in three files in this directory and had already
 * justified one hand-copied helper before anyone checked it (bead sparkle-4r68r7). It is recorded
 * here as false so it cannot justify a fourth.
 *
 * ⚠️ NARROWNESS HAS A COST, AND IT IS NOT WHAT IT LOOKS LIKE. A hand-restated wire shape drifts
 * silently, and the obvious pin cannot see it: every field this module turns on is OPTIONAL, so
 * `{} as NudgeFlag` satisfies this interface. Rename `standdown` on the wire type and
 * `loginStanddownOf` returns `undefined` forever with the whole suite green.
 * `nudgeFlagWireDrift.test.ts` pins the field NAMES against `NudgeFlag` at typecheck time — that
 * pin is what makes the narrowing safe, and deleting it re-opens the failure.
 */
export interface LoginStanddownFlag {
  /** `"founder"` | `"concierge"` — `nudge_ladder::Escalation::as_str`. */
  target: string;
  /** `nudge_ladder::Standdown::as_str`, or null while the ladder is merely climbing. */
  standdown?: string | null;
  /** The login to re-authenticate, resolved on the Rust side by `nudger::stamp_account`; null when
   *  it could not be identified. */
  account?: string | null;
  /** Epoch ms the episode was first raised — the age of the ASK, carried across refreshes. */
  raisedAtMs: number;
}

/** An agent whose session cannot make model calls until a person signs in again. */
export interface LoginStanddown {
  /**
   * WHICH LOGIN, as a name a person recognises — or `null` when Rust could not tell.
   *
   * ⚠️ `null` IS NOT "THE DEFAULT ACCOUNT", and a renderer must never print it as one. `account_label`
   * returns `None` for an unresolvable spawn (no PTY session left, unreadable `accounts.json`, a Rust
   * build predating the field) and that is a DIFFERENT fact from "the default login died". Sending
   * someone to re-authenticate the wrong one of several Max accounts is worse than telling them it is
   * unknown — `nudger.rs::account_label` says the same thing at the other end of the wire.
   */
  account: string | null;
  /** When the stand-down was first raised — the age a reader needs to tell one minute from six hours. */
  raisedAtMs: number;
}

/**
 * The login stand-down this flag asserts, or `undefined`.
 *
 * ⚠️ `undefined` FOR EVERY UNCERTAIN CASE, matching `humanBlockOf` — no flag, a concierge-level flag,
 * or any other stand-down all return `undefined`. This is the loudest thing the app can say about an
 * agent (it asserts a person must act, and names what they must do), so it fires only where Rust
 * positively concluded both halves.
 *
 * ⚠️ IT DOES NOT REQUIRE AN ACCOUNT. A row that names no login is still worth raising: the founder
 * cannot act on it as directly, but "one of your logins is dead" is strictly more than the silence
 * this replaces, and refusing to raise it would make an IO failure in `stamp_account` suppress the
 * escalation entirely. The account's absence is rendered as unknown, never as a default.
 */
export function loginStanddownOf(
  flag: LoginStanddownFlag | undefined,
): LoginStanddown | undefined {
  if (flag === undefined) return undefined;
  if (flag.target !== FOUNDER_TARGET) return undefined;
  if (flag.standdown !== LOGIN_EXPIRED_STANDDOWN) return undefined;
  return { account: flag.account ?? null, raisedAtMs: flag.raisedAtMs };
}
