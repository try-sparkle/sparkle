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
import { setPinFromSwitch, hasHumanPin } from "./accountStore";
import { isStickyAccountKey } from "./accountSelection";
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
  return { fromAccountId, toAccountId, pending, moved: [] };
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
  return { fromAccountId: null, toAccountId, pending, moved: [] };
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
  // A STICKY CONSUMER IS RESCUED WITHOUT A PIN — re-spawn only. Only the banner can reach one here
  // (the activation excludes them), and there the point is to get it off an account that has hit
  // its ceiling, which a re-spawn alone achieves: it re-resolves through `chooseAccountForAgent`,
  // and an OBSERVED `exhaustedUntil` is precisely what is allowed to move a sticky selection.
  // Writing a pin instead would do two harms this branch has already had to undo — it launders a
  // machinery choice into the slot the modal renders back as the user's own, and in a satellite
  // window it lands on the `-win-<uuid>` VARIANT, which `stickyPin` prefers over the base key,
  // detaching that window from the modal's control long after the limit resets.
  if (isStickyAccountKey(agentId)) return restart(agentId);
  // `setPinFromSwitch`, not `setPin`: this pin is MACHINERY's, and a later activation has to be able
  // to clear the pins a previous one left without touching the ones a person set by hand.
  setPinFromSwitch(agentId, toAccountId);
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
    moveAgent(agentId, plan.toAccountId, restart);
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
