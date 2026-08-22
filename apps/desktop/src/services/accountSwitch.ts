// Moves running agents from one Claude account to another WITHOUT losing work.
//
// The mechanism: an agent's account is just `CLAUDE_CONFIG_DIR` on its spawn, so switching means
// re-spawning with a different dir. Sparkle already resumes a re-spawned agent via
// `--resume <session-id>` (claudeSpawn), so the conversation survives the swap — the agent picks up
// its thread under the new login.
//
// The hard requirement is WHEN. Re-spawning an agent mid-turn loses whatever it was doing and can
// interrupt a tool call, which is exactly the "don't yank a running agent" concern Phase 1 cited
// when it declined to switch at all. So this module never switches a busy agent: it marks the agent
// PENDING and waits for it to reach a safe boundary of its own accord.
//
// "Safe" = any status other than `working`. `working` means Claude Code is actively producing
// output (mid-turn); every other status — idle, waiting, approval, blocked, errored, unmerged,
// done, stopped — means the turn is over and nothing is in flight. Switching then costs the agent
// nothing but a redraw.
//
// Consequence, and it's intentional: agents switch INDEPENDENTLY, each at its own boundary, rather
// than all at once. A fleet of ten agents will migrate over however long it takes each to finish
// its current turn. That's the behavior that loses the least work.

import type { AgentTabStatus } from "../types";
import {
  setPinFromSwitch,
  hasHumanPin,
  clearPin,
  type Account,
  type Usage,
  type Identity,
  type LiveUsage,
} from "./accountStore";
import { isStickyAccountKey, SPARKLE_SELF_ACCOUNT_PREFIX } from "./accountSelection";
import {
  switchRecommendation,
  bestHealthyTarget,
  isHealthyTarget,
  type Ceiling,
} from "./headroom";
import { releaseQuotaBlockForAgent } from "../engine/engineRegistry";

/** Statuses at which an agent can be re-spawned without losing in-flight work. Everything except
 *  `working`; see the module note. */
export function isSafeToSwitch(status: AgentTabStatus | undefined): boolean {
  return status !== "working";
}

/** One agent's participation in a switch. */
export interface SwitchTarget {
  agentId: string;
  /** The account it should end up on. */
  toAccountId: string;
}

/** A switch the user accepted, in progress. Agents leave `pending` as they reach a safe boundary. */
export interface SwitchPlan {
  /** The account being vacated, or NULL when there isn't a single one.
   *
   *  `planSwitch` (the banner's path) always has one: it is built from "this account is running
   *  out". `planSwitchToAccount` (the manual "Activate this account" path) does not — it sweeps
   *  agents from EVERY other account onto the chosen one, so naming any single origin would be a
   *  fiction. Null says "several / not applicable" rather than inventing one, and readers that
   *  render a from-name are already the ones that only ever see a banner plan. */
  fromAccountId: string | null;
  toAccountId: string;
  /** Agents not yet moved. */
  pending: string[];
  /** Agents already re-pinned and re-spawned. */
  moved: string[];
  /** Whether phase 2 may RE-VALIDATE this plan's target mid-migration and re-target it if it went
   *  invalid ({@link revalidateSwitchTarget}). True ONLY for plans whose target THIS oracle chose —
   *  `planSwitch` (auto/accept) and the helper rescue. A MANUAL activation (`planSwitchToAccount`)
   *  leaves it false/absent: the user named that account explicitly, and re-validation would silently
   *  redirect the fleet away from their choice (worse, off a just-added account not yet in the 120s
   *  health snapshot, or off a uuid-only login that reads as "not signed in"). Absent ⇒ false. */
  revalidate?: boolean;
  /** Whether re-targeting this plan also writes the fleet-wide preference (`setPreferredAccountId`).
   *  True ONLY for `planSwitch` (auto/accept), which owns that preference. A HELPER RESCUE carries a
   *  `fromAccountId` but deliberately must NOT touch the fleet preference — it only relocates the
   *  sticky pair — so it sets this false. Absent ⇒ false. */
  ownsPreference?: boolean;
}

/** Entries a migration may touch AT ALL: it is running somewhere, and nobody pinned it by hand.
 *
 *  A HAND PIN OUTRANKS BOTH KINDS OF SWITCH, which is simply what `chooseAccountForAgent` already
 *  says — a per-agent pin sits ABOVE the fleet preference, and above every judgement selection
 *  makes, precisely because a person chose it. A plan that migrated one would overwrite that choice
 *  and re-spawn an agent whose own picker deliberately leaves running ("we don't restart a running
 *  agent out from under the user"). Clearing the pin afterwards is no remedy: by then it points at
 *  the new account. Only pins a MIGRATION wrote are the machinery's to move — `hasHumanPin`.
 *
 *  This applies to the sticky consumers too, and it is what makes the banner's rescue safe: a user
 *  who parked Improve Sparkle on an account with the modal's own control keeps it there even when
 *  that account hits its ceiling, exactly as a pin promises. */
function unpinnedRunning(agentAccounts: Record<string, string | undefined>): [string, string][] {
  return Object.entries(agentAccounts).filter((e): e is [string, string] => {
    if (e[1] == null) return false;
    return !hasHumanPin(e[0]);
  });
}

/** May an ACTIVATION sweep this agent? The {@link unpinnedRunning} rule, plus the sticky consumers.
 *
 *  Improve Sparkle's pane is an ordinary `AgentPane` whose `agent.id` IS its sticky key, so
 *  `registerPaneAccount` puts it in `paneAccountMap()` alongside the build agents, and
 *  {@link planSwitchToAccount} built from that map verbatim moved it. Three things broke:
 *
 *   • it contradicted what the accounts modal says in so many words ("These two stay on one account
 *     on purpose, so activating an account does not move them");
 *   • it silently overwrote the pin the user set with that section's own control, which then
 *     rendered the overwritten value back as if they had chosen it;
 *   • for a SATELLITE window the pin landed on the `-win-<uuid>` VARIANT while the base key was
 *     untouched, splitting one worktree's namespace across two accounts — the exact failure
 *     `isStickyAccountKey` documents itself as existing to prevent.
 *
 *  DELIBERATELY NOT APPLIED TO {@link planSwitch}, and that asymmetry is the point rather than an
 *  oversight. The two paths answer to different promises:
 *
 *   • The MODAL promises these two do not move. Activation is a fleet-wide preference about where
 *     agents run, and moving a sticky consumer is only ever right as a deliberate, per-consumer
 *     choice — which that modal offers separately.
 *   • The BANNER is raised because an account is approaching or has hit its ceiling. Nothing else
 *     re-spawns an Improve Sparkle pane on headroom grounds (`restartPane`'s other callers are auth
 *     recovery, resurrection and concierge lifecycle), so excluding it there strands the pane on the
 *     exhausting account holding a spawn-time `CLAUDE_CONFIG_DIR` — and when it is the ONLY pane
 *     there, routine on a machine running the hourly pass, the accept becomes a silent no-op the
 *     banner re-raises forever.
 *
 *  So: stickiness protects these two from a PREFERENCE, not from a rate limit — and a PIN protects
 *  them from both (see {@link unpinnedRunning}).
 *
 *  WHICH STICKY KEYS CAN APPEAR HERE: `__sparkle_self__` **and its `-win-<uuid>` variants** —
 *  `sparkleAgentIdFor` returns a per-window id for every non-main window, that pane is an ordinary
 *  `AgentPane`, and `AccountSwitchHost` is mounted in each window, so a satellite's own map holds
 *  the variant. Only the concierge can never appear: it is `controlListener`'s caller identity
 *  rather than anything mounted.
 *
 *  A PREDICATE ON ONE ID rather than a filter over the map, because {@link planSwitchToAccount}
 *  cannot reuse {@link unpinnedRunning}'s "has a recorded account" test: an activation enrols a
 *  mounted pane whose account was never recorded (see there), which that test would drop. */
function sweepableByActivation(agentId: string): boolean {
  return !hasHumanPin(agentId) && !isStickyAccountKey(agentId);
}

/** Build the plan: every agent currently running on `fromAccountId` needs to move.
 *  `agentAccounts` maps agentId → the account it's running under.
 *
 *  Includes an unpinned sticky consumer's pane — see {@link migratableAgents} for why the banner and
 *  the activation differ, and {@link moveAgent} for why that one is re-spawned without a pin. */
export function planSwitch(
  fromAccountId: string,
  toAccountId: string,
  agentAccounts: Record<string, string | undefined>,
): SwitchPlan {
  const pending = unpinnedRunning(agentAccounts)
    .filter(([, acct]) => acct === fromAccountId)
    .map(([agentId]) => agentId);
  // Auto/accept: this oracle chose the target and owns the fleet preference, so phase 2 may
  // re-validate + re-target it, and a re-target writes the preference.
  return { fromAccountId, toAccountId, pending, moved: [], revalidate: true, ownsPreference: true };
}

/** Build the plan for "run agents on THIS account": every agent that is not already there needs to
 *  move, whatever it is currently running under.
 *
 *  A SIBLING of {@link planSwitch}, not a replacement, because the two answer different questions
 *  and {@link planSwitch}'s answer is the right one for the banner. The banner is raised about one
 *  account that is running out, so it moves the agents on THAT account and deliberately leaves a
 *  third account's agents alone — they are fine where they are, and re-spawning them would be work
 *  destroyed for nothing.
 *
 *  The manual control is the opposite ask. The founder points at an account and says run agents
 *  there; an agent sitting on a third account is exactly what he is asking to move. Filtering to a
 *  single origin here would leave part of the fleet behind and make the control look broken.
 *
 *  MOUNTED PANES ONLY, and that is deliberate — the PROJECT ROSTER IS NOT A SECOND SOURCE. Enrolling
 *  it looked like thoroughness (the roster names every agent that exists, the pane map only the ones
 *  mounted right now) and was strictly harmful. A roster-only agent has no pane, so `restartPane`
 *  returns false and {@link moveAgent}'s ONLY surviving effect on it is the pin — and a pin is a
 *  WORSE answer than the preference the same click already recorded:
 *
 *   • `chooseAccountForAgent` gates the preference through `usablePreferredAccount` (real, signed in,
 *     not exhausted) and falls through to auto-pick when it fails. A pin is routed straight into
 *     `pickAccount`, which returns it BEFORE any eligibility test.
 *   • So sixty roster agents pinned by one click keep spawning onto the activated account after it
 *     hits its 5h ceiling, where the preference alone would have auto-picked a healthy one. The
 *     banner cannot rescue them either: `planSwitch` sees only mounted panes.
 *   • They also defeat "Back to automatic", which is a statement about the PREFERENCE.
 *
 *  An unmounted agent therefore needs nothing from a plan: the preference already covers it, covers
 *  it with a gate, and covers agents that do not exist yet — which no plan can. What the roster was
 *  reaching for is real (an agent pinned by an EARLIER activation keeps spawning on the old account),
 *  and `recordActivation`'s `clearSwitchWrittenPins` sweep is what answers it — dropping the stale
 *  pin so the agent falls through to the new preference, rather than writing a fresh pin over it.
 *
 *  THE CONCIERGE IS NOT PINNED HERE, deliberately. An earlier implementation of this control pinned
 *  `CONCIERGE_ACCOUNT_KEY` as a second effect, which reads as thoroughness and is the one thing this
 *  path must not do: the concierge is sticky by design, and moving it mid-conversation makes
 *  `rebindSessionToAccount` null both session pointers and re-probe. The accounts modal gives it its
 *  own visible control instead, so parking it is a deliberate per-consumer choice rather than a side
 *  effect of a fleet-wide preference — and the modal says so on screen. */
export function planSwitchToAccount(
  toAccountId: string,
  agentAccounts: Record<string, string | undefined>,
): SwitchPlan {
  // "Enrol unless we can SHOW it is already home" — hence reading the map's KEYS rather than
  // reusing `unpinnedRunning`, whose `acct != null` test would drop a mounted pane with no recorded
  // account. `planSwitch` can lean on that test because its filter is `acct === fromAccountId`,
  // which an unknown account fails anyway; here an unknown account is a pane we cannot prove is on
  // the target, and leaving it behind is the failure the control is judged on.
  const pending = Object.keys(agentAccounts).filter(
    (id) => agentAccounts[id] !== toAccountId && sweepableByActivation(id),
  );
  // MANUAL activation: the user named this account explicitly. Phase 2 must NOT re-validate or
  // re-target it — doing so would silently overrule their choice (and could fire off a just-added
  // account absent from the 120s health snapshot, or a uuid-only login that reads as unsigned).
  return { fromAccountId: null, toAccountId, pending, moved: [], revalidate: false, ownsPreference: false };
}

/** Distinct accounts a STICKY HELPER (Improve Sparkle, or a concierge pane) is currently running
 *  under, read from the live pane map.
 *
 *  This is the set the exhaustion auto-switch was structurally BLIND to. `useAccountSwitch` and
 *  `useLimitSync` only ever evaluated `busiestPaneAccount()`, so a helper pinned to its OWN dedicated
 *  account — the whole reason `isStickyAccountKey` exists — was never checked whenever the build fleet
 *  ran under a different account. That account could sit at 99% and no recommendation was produced,
 *  which is the founder's reported failure: Automatic, helper at 99%, no auto-switch, a hand re-login. */
export function stickyHelperAccounts(
  agentAccounts: Record<string, string | undefined>,
): string[] {
  const seen = new Set<string>();
  for (const [id, acct] of Object.entries(agentAccounts)) {
    if (acct != null && isStickyAccountKey(id)) seen.add(acct);
  }
  return [...seen];
}

/** Build the plan to RESCUE a sticky helper off an exhausted account.
 *
 *  Differs from {@link planSwitch} in exactly one deliberate way: a sticky helper is enrolled even
 *  when it carries a HUMAN PIN. The banner path leaves a hand-pinned agent alone because a pin is a
 *  person's explicit "run here" — but an account at its wall is not a place anything CAN run, and a
 *  pinned helper stranded there is the precise failure this rescue exists to end. Co-located
 *  non-sticky agents keep their pin protection ({@link hasHumanPin}); only the sticky helper is
 *  overridden, and {@link moveAgent} clears its pin on the move so it re-resolves onto the healthy
 *  account rather than bouncing back to the walled one its pin still names. */
export function planHelperRescue(
  fromAccountId: string,
  toAccountId: string,
  agentAccounts: Record<string, string | undefined>,
): SwitchPlan {
  const pending = Object.entries(agentAccounts)
    .filter((e): e is [string, string] => e[1] === fromAccountId)
    .filter(([id]) => isStickyAccountKey(id) || !hasHumanPin(id))
    .map(([id]) => id);
  // Rescue: this oracle chose the target, so re-validate + re-target it if it dies too — but a rescue
  // relocates only the sticky pair and must NOT rewrite the fleet-wide preference (phase 1's own
  // contract), so `ownsPreference` stays false.
  return { fromAccountId, toAccountId, pending, moved: [], revalidate: true, ownsPreference: false };
}

/** Find a sticky helper stranded on an EXHAUSTED account and plan its rescue, or null if none is.
 *
 *  THE FIX FOR THE FOUNDER'S BUG. Sweeps every account a sticky helper actually runs on and asks
 *  {@link switchRecommendation} the SAME authoritative question the fleet path asks about the busiest
 *  account — an observed rate-limit wall, or real Anthropic utilization at/above `LIVE_AVOID_PERCENT`
 *  — about each of them. `switchRecommendation` returns null unless that account is genuinely spent
 *  AND a healthy, signed-in, different-identity target exists, so an UNREADABLE meter (state
 *  "unknown", no live row) is never treated as exhausted and never triggers a false switch; and a
 *  target that is itself exhausted or live-spent is excluded before ranking. Both properties come for
 *  free by reusing the one oracle rather than re-deriving a second exhaustion rule here.
 *
 *  Pure given `switchRecommendation` is pure, so the hooks drive the effects and this stays testable.
 *  Returns the FIRST non-empty rescue plan; the caller executes it through the same safe-boundary
 *  advance (`advanceSwitch`) every other switch uses, so no in-flight turn is lost. */
export function planStrandedHelperRescue(
  accounts: Account[],
  usage: Usage[],
  ceilings: Ceiling[],
  identities: Identity[],
  now: number,
  live: readonly LiveUsage[],
  agentAccounts: Record<string, string | undefined>,
): SwitchPlan | null {
  for (const acct of stickyHelperAccounts(agentAccounts)) {
    const rec = switchRecommendation(acct, accounts, usage, ceilings, identities, now, live);
    if (!rec || rec.reason !== "exhausted") continue;
    const plan = planHelperRescue(acct, rec.to.id, agentAccounts);
    if (plan.pending.length > 0) return plan;
  }
  return null;
}

/** The outcome of re-checking a running plan's destination. `ok` and `retargeted` both hand back a
 *  plan to advance; `held` means the caller must move NOBODY this tick. */
export type TargetRevalidation =
  | { kind: "ok"; plan: SwitchPlan }
  | { kind: "retargeted"; plan: SwitchPlan }
  | { kind: "held"; plan: SwitchPlan };

/** Re-validate a running plan's destination against current account health, re-targeting when it has
 *  gone invalid mid-migration.
 *
 *  A plan's `toAccountId` is chosen ONCE, when the switch starts, but agents migrate onto it over
 *  minutes — each waits for its own safe boundary. In that window the target can go invalid: it hits
 *  its OWN rate-limit wall, its login expires, or the user removes it. Nothing else watches for this
 *  while a plan runs — `useAccountSwitch` phase 1 (the health poll) suppresses itself as soon as a plan
 *  exists — so without this check `advanceSwitch` keeps pinning and re-spawning agents onto a dead
 *  account. Re-pick the destination the SAME way the switch was planned ({@link bestHealthyTarget}, the
 *  shared oracle), excluding the vacated account and the dead target:
 *
 *   - target still a healthy destination  → `ok`, the plan unchanged;
 *   - target invalid, a healthy replacement exists → `retargeted`, the plan pointed at it. Agents
 *     already MOVED onto the now-dead target are folded back into `pending` so they, too, migrate off
 *     it — nothing should be left pinned to a dead account, and re-spawns still respect each agent's
 *     safe boundary. (They are NOT covered by the exhaustion auto-switch: after a retarget the
 *     majority land on the new target, so the dead account is by construction not `busiestPaneAccount`,
 *     and ordinary build agents are not the sticky helpers the stranded-helper sweep watches.)
 *   - target invalid, NO healthy account at all → `held`: the caller retires the plan (rather than
 *     spinning it), which re-arms phase 1 so its recommendation, auto-switch, and helper-rescue sweeps
 *     run again; the fleet stays put and keeps working, and phase 1 re-plans once an account frees up.
 *
 *  PURE: the hook drives the effects (the preference write, the re-spawns, retiring a held plan) so
 *  this stays testable. */
export function revalidateSwitchTarget(
  plan: SwitchPlan,
  accounts: Account[],
  usage: Usage[],
  ceilings: Ceiling[],
  identities: Identity[],
  now: number,
  live: readonly LiveUsage[],
): TargetRevalidation {
  if (isHealthyTarget(plan.toAccountId, accounts, usage, ceilings, identities, now, live)) {
    return { kind: "ok", plan };
  }
  // Dead target: exclude it (and the vacated login) so we never re-pick a sibling of a walled login.
  const exclude = plan.fromAccountId ? [plan.toAccountId, plan.fromAccountId] : [plan.toAccountId];
  const next = bestHealthyTarget(accounts, usage, ceilings, identities, now, live, exclude);
  if (!next) return { kind: "held", plan };
  // Redirect the pending agents AND fold the already-moved back into pending: they are stranded on the
  // dead target and nothing else will move them. `advanceSwitch` still only re-spawns each at a safe
  // boundary, so no in-flight turn is lost.
  return {
    kind: "retargeted",
    plan: {
      ...plan,
      toAccountId: next.id,
      pending: [...plan.pending, ...plan.moved],
      moved: [],
    },
  };
}

/** Which pending agents are ready to move right now, given live statuses. PURE — the caller
 *  performs the effects. */
export function readyToMove(
  plan: SwitchPlan,
  statuses: Record<string, AgentTabStatus | undefined>,
): string[] {
  return plan.pending.filter((id) => isSafeToSwitch(statuses[id]));
}

/** Whether every agent in the plan has moved (so the plan can be retired). */
export function isSwitchComplete(plan: SwitchPlan): boolean {
  return plan.pending.length === 0;
}

/** Apply the move for one agent: pin it to the new account, then re-spawn so the pin takes effect.
 *
 *  Order matters — the pin must be persisted BEFORE the re-spawn, because the spawn path reads the
 *  pin (`chooseAccountForAgent` → `getPin`) while building the exec. Pinning after would re-spawn
 *  the agent onto the account it was already on and silently do nothing.
 *
 *  `restart` is injected (the pane registry's restart for that agent) so this stays testable and so
 *  a missing pane is a no-op rather than a throw. Returns whether the re-spawn was actually
 *  triggered; a pinned-but-not-restarted agent still picks up the new account on its next spawn. */
export function moveAgent(
  agentId: string,
  toAccountId: string,
  restart: (agentId: string) => boolean,
  /** Is the agent ARRIVING from a different account, or being re-pinned where it already is?
   *
   *  This is the seam the two callers actually reach, which is why the distinction lives here rather
   *  than on `setPinFromSwitch` — an earlier cut put it there and every production path took the
   *  same branch, so the flag was dead and the defect it was written for reproduced unchanged.
   *
   *  `advanceSwitch` passes true: that is a migration, and arriving agents make a stale statement of
   *  the target's rotation membership. `authRecovery.resumeAll` passes nothing: it re-pins a stuck
   *  agent to the account it is ALREADY on, so the re-spawn cannot auto-pick a different, still-walled
   *  one. Nothing moves there and nothing is said about the fleet, so nothing about the pool is
   *  revised. Defaults to false so a new caller opts IN to changing the pool. */
  relocating = false,
): boolean {
  // THE WALL BELONGED TO THE ACCOUNT WE JUST LEFT. A quota block is a claim about an account
  // ("you've hit your session limit · resets 4pm"), and this agent is no longer running under that
  // account — so the claim stops describing it here, at the moment of the move.
  //
  // Without this the agent stays walled for whatever the ABANDONED account's window had left (up to
  // five hours for a session limit): the sidebar keeps painting "Rate limited", `stallReport` keeps
  // returning `quota-blocked`, and `decideContinuation` keeps refusing to resume it — all about an
  // account it stopped using. Switching accounts is precisely what a human does to get an agent
  // moving again, so leaving it blocked defeats the switch.
  //
  // Before the restart, mirroring the pin: both are state the re-spawned agent must come up WITHOUT.
  //
  // ABOVE the sticky early-return, deliberately. The two sides of this merge were orthogonal — one
  // refined WHICH pin gets written, the other clears the wall — but a release placed after the
  // return would silently skip the sticky consumers, and those are the agents the banner rescue
  // exists for: it fires precisely because their account hit its ceiling, so they are the ones most
  // likely to be carrying a block.
  releaseQuotaBlockForAgent(agentId);
  // A STICKY CONSUMER IS RESCUED WITHOUT A PIN — re-spawn only. Only the banner and the HELPER
  // RESCUE (planStrandedHelperRescue) can reach one here (the activation excludes them), and in both
  // the point is to get it off an account that has hit its ceiling, which a re-spawn alone achieves:
  // it re-resolves through `chooseAccountForAgent`, and an OBSERVED `exhaustedUntil` is precisely
  // what is allowed to move a sticky selection. Writing a pin instead would do two harms this branch
  // has already had to undo — it launders a machinery choice into the slot the modal renders back as
  // the user's own, and in a satellite window it lands on the `-win-<uuid>` VARIANT, which
  // `stickyPin` prefers over the base key, detaching that window from the modal's control long after
  // the limit resets.
  //
  // But it must also CLEAR any human pin the helper carries. The banner path can never hand a
  // hand-pinned sticky key to this function (`unpinnedRunning` drops it first), so historically the
  // clear was unnecessary; the helper rescue deliberately DOES include a pinned sticky helper,
  // because a pin promising "run here" is meaningless when "here" is a walled account, and the
  // founder set to Automatic still had to re-login by hand. Without the clear, the re-spawn re-reads
  // the pin (`chooseAccountForAgent` → `stickyPin`) and bounces straight back to the walled account.
  // A no-op when there is no pin, so the banner path is unchanged. Both of the helper's components
  // share ONE sticky key, so clearing it relocates the pane and the headless pass together — the
  // invariant the pin protected, kept while the pair moves off the exhausted account.
  if (isStickyAccountKey(agentId)) {
    clearPin(agentId);
    // …AND THE BASE KEY, when this is a satellite VARIANT (roborev 65980). `stickyPin` falls back
    // from a `__sparkle_self__-win-<uuid>` variant to the pin on the base `__sparkle_self__`, so
    // clearing only the exact key removed a variant pin that almost never exists and left the one
    // that actually gets READ. The re-spawn then re-read it and bounced straight back to the walled
    // account — the exact failure this clear was added to prevent, for every satellite window. The
    // fallback is mirrored here rather than inferred: whatever `stickyPin` would resolve is what has
    // to be cleared, or the clear is a no-op against the reader.
    if (agentId.startsWith(`${SPARKLE_SELF_ACCOUNT_PREFIX}-`)) clearPin(SPARKLE_SELF_ACCOUNT_PREFIX);
    return restart(agentId);
  }
  // `setPinFromSwitch`, not `setPin`: this pin is MACHINERY's, and a later activation has to be able
  // to clear the pins a previous one left without touching the ones a person set by hand.
  // Forwarded from `moveAgent`'s own caller — see its `relocating` docblock.
  setPinFromSwitch(agentId, toAccountId, relocating);
  return restart(agentId);
}

/** Advance a plan by moving every agent that's currently safe. Returns the updated plan (immutably)
 *  plus the ids moved on this pass. */
export function advanceSwitch(
  plan: SwitchPlan,
  statuses: Record<string, AgentTabStatus | undefined>,
  restart: (agentId: string) => boolean,
): { plan: SwitchPlan; movedNow: string[] } {
  const ready = readyToMove(plan, statuses);
  const movedNow: string[] = [];
  for (const agentId of ready) {
    // `relocating: true` — a plan MOVES agents from `fromAccountId` to `toAccountId`, so the target
    // rejoins the rotation pool. `authRecovery.resumeAll`, the other caller, passes nothing.
    moveAgent(agentId, plan.toAccountId, restart, true);
    movedNow.push(agentId);
  }
  if (movedNow.length === 0) return { plan, movedNow };
  const movedSet = new Set(movedNow);
  return {
    plan: {
      ...plan,
      pending: plan.pending.filter((id) => !movedSet.has(id)),
      moved: [...plan.moved, ...movedNow],
    },
    movedNow,
  };
}
