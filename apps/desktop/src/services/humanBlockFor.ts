// humanBlockFor — the ONE spelling of "look up what this agent's nudger flag says a PERSON has to
// do about it".
//
// TWO LOOKUPS NOW, NOT ONE (bead sparkle-qg71dl), and they are not alternatives. `humanBlockIn`
// relays an answer the agent GAVE ("blocked-on-human"); `loginStanddownIn` relays a stand-down the
// LADDER concluded ("login-expired") about an agent that could not answer at all, and carries the
// login name Rust paid IO to resolve. They read different fields of the same flag, so a caller
// that treats one as an `else` for the other silently drops whichever fires second.
//
// WHY THIS MODULE EXISTS (roborev 65373). `humanBlockOf(nudgeFlagFor(id))` had been written out
// FOUR times across the app — twice in `AgentSidebar`, once in `AgentRow`, once in
// `MountedAgentNotices` — plus a fifth spelling in `agentGoalReading`, and a sixth as the inline
// predicate `(id) => humanBlockOf(nudgeFlagFor(id)) !== undefined`. Every one of those is a seam
// between the engine (which cannot import `services/`) and the flag table (which lives there), and
// a seam repeated six times is one a refactor changes in five places.
//
// ⚠️ THE INLINE PREDICATE WAS THE DANGEROUS ONE, and it is the `sparkle-lgbwf` "defaulted seam"
// shape: `withNudgeLoopCalm`'s parameter defaulted to `() => false` — precisely the demoting
// behaviour the exemption exists to stop — while every test injected its own predicate. So the one
// line supplying the real value was covered by NOTHING: deleting it left the whole suite green while
// the founder's row went back to amber. That parameter is now REQUIRED, so a dropped argument is a
// typecheck failure rather than a silent behaviour revert.
//
// ⚠️ THERE IS NO MODULE-LEVEL PREDICATE HERE ANY MORE, deliberately (roborev 65473). An
// `isHumanBlocked(id)` reading the live table used to sit beside these, and once the rollup seams
// took the SNAPSHOT it had no consumers left — while its docblock still advertised it as the wired-
// up path. An exported, unsubscribed, live-table read inside the module that calls itself "the ONE
// spelling" is exactly the no-dependency-anything-can-see read this branch removed everywhere else,
// and leaving it documented as sanctioned is how it comes back. Components take the snapshot;
// services (`agentGoalReading`) use `humanBlockFor`, which re-reads on every call and so cannot go
// stale.
import { humanBlockOf, type HumanBlock, type HumanBlockFlag } from "../engine/humanBlock";
import {
  loginStanddownOf,
  type LoginStanddown,
  type LoginStanddownFlag,
} from "../engine/loginStanddown";
import { nudgeFlagFor } from "./authRecovery";

/**
 * The fields of a raised nudger flag that are CHANGE-DETECTED, and therefore the only ones a
 * snapshot may carry.
 *
 * An INTERSECTION of the two engine judgements' structural inputs rather than a hand-written list,
 * so adding a field to either judge is a typecheck failure here until `authRecovery.publishFlagSnapshot`
 * supplies it and `flagIdentity` watches it. That is the seam bead sparkle-qg71dl was filed on:
 * `standdown` and `account` reached `NudgeFlag` correct and were read by nothing for weeks.
 */
export type JudgedNudgeFlag = HumanBlockFlag & LoginStanddownFlag;

/** The immutable flag table a React derivation reads — see `useNudgeFlags.useNudgeFlagSnapshot`.
 *
 *  Deliberately the JUDGED fields only, not the whole `NudgeFlag`: the poll's change-detection
 *  excludes the climbing counters (else it is a 30s heartbeat again), so a snapshot exposing them
 *  would hand out values frozen at the last identity change. See `authRecovery.nudgeFlagsSnapshot`. */
export type NudgeFlagSnapshot = ReadonlyMap<string, JudgedNudgeFlag>;

/**
 * The snapshot-taking forms, for anything MEMOIZED.
 *
 * ⚠️ USE THESE IN COMPONENTS, not the module-level readers below (roborev 65409). A `useMemo` that
 * reads the module table directly has no dependency the compiler or the lint rule can see, so its
 * freshness rests on a hand-written dep array that `react-hooks/exhaustive-deps` actively argues
 * should be deleted. Taking the snapshot as an ARGUMENT makes the dependency real: the value is read
 * inside the closure, so the rule now demands it, and dropping it fails to compile.
 */
export function humanBlockIn(snapshot: NudgeFlagSnapshot, agentId: string): HumanBlock | undefined {
  return humanBlockOf(snapshot.get(agentId));
}

/** Predicate form of {@link humanBlockIn}. */
export function isHumanBlockedIn(snapshot: NudgeFlagSnapshot, agentId: string): boolean {
  return humanBlockIn(snapshot, agentId) !== undefined;
}

/**
 * The login stand-down this agent is under, or `undefined` — the snapshot-taking form, for anything
 * MEMOIZED. Same rule as {@link humanBlockIn}: take it as an ARGUMENT so the dependency is one the
 * lint rule demands rather than one it argues should be deleted.
 *
 * ⚠️ NOT MUTUALLY EXCLUSIVE WITH {@link humanBlockIn}, and the caller must not treat it as an
 * `else`. They read different fields (`reply` vs `standdown`) and in practice describe disjoint
 * populations — an agent that can still answer, and one whose session is gone — but nothing in the
 * wire format forbids a flag carrying both, and dropping one because the other fired would silently
 * lose the half that names an action.
 */
export function loginStanddownIn(
  snapshot: NudgeFlagSnapshot,
  agentId: string,
): LoginStanddown | undefined {
  return loginStanddownOf(snapshot.get(agentId));
}

/**
 * The human block this agent has asserted, or `undefined`.
 *
 * ⚠️ THE MODULE-LEVEL READER — correct for a SERVICE, wrong for a memoized component. Services
 * (`agentGoalReading`) re-read on every call, so there is nothing to go stale; a `useMemo` does not,
 * which is what {@link humanBlockIn} is for.
 *
 * Thin by design — the JUDGEMENT lives in `engine/humanBlock.humanBlockOf`, which is pure and
 * unit-tested; this only supplies the lookup that an engine module may not perform for itself.
 */
export function humanBlockFor(agentId: string): HumanBlock | undefined {
  return humanBlockOf(nudgeFlagFor(agentId));
}
