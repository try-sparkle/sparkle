// @vitest-environment jsdom
//
// AN OBSERVED WALL MOVES THE FLEET BY ITSELF; AN ESTIMATE STILL ASKS.
//
// `switchRecommendation` carries a `reason`, and the two values are different KINDS of claim:
//
//   "exhausted"   — an observed rate-limit event. `headroom.ts`: "authoritative … outranks any
//                   estimate". The account HAS hit its limit.
//   "approaching" — the LEARNED ceiling, an estimate with a measured CoV of 0.24. That imprecision
//                   is exactly why `headroom.ts` declined to re-spawn a running fleet unasked.
//
// So they get different answers, and this suite pins the split. Acting on the observed one is safe
// for the same reason the manual path is: `advanceSwitch` moves an agent only at a boundary where
// `isSafeToSwitch` holds, so nothing is re-spawned mid-turn. It is worth doing because the
// alternative is not a short wait — an agent behind a session wall is refused by
// `decideContinuation` until that account's window resets, up to five hours.
//
// WHY THE PAIRED NEGATIVE IS LOAD-BEARING (AGENTS.md, "assert the SIDE EFFECT"): asserting only
// that an exhausted account produces a plan would also pass if the hook auto-accepted EVERY
// recommendation — which would re-spawn the fleet on a 0.24-CoV guess, the precise thing the design
// refuses. Only the "approaching" case going the other way proves the reason is what drives it.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../services/accountStore";
import type { AgentTabStatus } from "../types";

const h = vi.hoisted(() => ({
  // null = `switchRecommendation` finds nothing to suggest. That is NOT the same as "no wall":
  // it also fires when every other account is itself exhausted or merely `warn`, which is the
  // exact confusion `retireStaleWallDismissals` must not make.
  reason: "approaching" as "exhausted" | "approaching" | null,
  from: "acct-a",
  // The OBSERVED exhaustion, which is what the retirement helper judges on. Only the two fields it
  // reads; `loadAccountState` supplies the rest in production.
  usage: [] as { id: string; exhaustedUntil: number | null }[],
  // `loadAccountState` RESOLVES to EMPTY with this set rather than throwing, so a broken bridge
  // reaches the hook looking exactly like a healthy account list that happens to be empty. Carrying
  // the flag here is what lets a test tell those two apart — see `accountSelection.ts`: "the
  // coercion above would quietly launder 'the bridge is broken' into 'you have no accounts'".
  failed: false,
  restart: vi.fn((_agentId: string) => true),
  setPin: vi.fn((_agentId: string, _accountId: string) => {}),
  statuses: {} as Record<string, AgentTabStatus | undefined>,
  paneAccounts: {} as Record<string, string | undefined>,
}));

vi.mock("../services/paneControl", () => ({
  restartPane: (id: string) => h.restart(id),
  paneAccountMap: () => h.paneAccounts,
  busiestPaneAccount: () => "acct-a",
}));

vi.mock("../services/accountStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountStore")>()),
  setPinFromSwitch: (agentId: string, accountId: string) => h.setPin(agentId, accountId),
  listCeilings: async () => [],
}));

vi.mock("../services/accountSelection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/accountSelection")>()),
  loadAccountState: async () => ({
    accounts: [],
    usage: h.usage,
    identities: [],
    failed: h.failed,
  }),
  invalidateAccountState: () => {},
}));

const acct = (id: string): Account => ({
  id,
  nickname: id,
  configDir: `/cfg/${id}`,
  isDefault: false,
  createdAt: 0,
});

// The ONE thing this suite varies. Everything else is held constant so the reason is the only
// possible cause of a difference between the two tests.
vi.mock("../services/headroom", () => ({
  switchRecommendation: () =>
    h.reason === null
      ? null
      : {
          from: acct(h.from),
          to: acct("acct-b"),
          fraction: 0.95,
          reason: h.reason,
        },
}));

vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ status: h.statuses }) },
}));

const { useAccountSwitch, SWITCH_ADVANCE_MS } = await import("./useAccountSwitch");

/** How often phase 1 re-evaluates in this suite. Short so a test can drive a SECOND evaluation. */
const POLL_MS = 1_000;

/** Flush the phase-1 tick's awaits (loadAccountState, listCeilings) so its result is committed. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** A five-hour session wall, live as of now. Fake timers move `Date.now()`, so this is computed at
 *  use rather than hoisted. */
function wall(id: string) {
  return { id, exhaustedUntil: Date.now() + 5 * 60 * 60 * 1_000 };
}

/** The same account with its window reset — the wall episode is over. */
function reset(id: string) {
  return { id, exhaustedUntil: null };
}

/** Mount and let the first phase-1 evaluation land. */
async function mounted() {
  const view = renderHook(() => useAccountSwitch(POLL_MS));
  await settle();
  return view;
}

/** Drive one FURTHER phase-1 evaluation — the interval fire, then its awaits. */
async function repoll() {
  await act(async () => {
    vi.advanceTimersByTime(POLL_MS);
  });
  await settle();
}

/** Mount with phase 1's interval effectively disabled, so a later `advance()` is the only thing
 *  that runs. Phase 1 still evaluates once at mount — that is what raises the plan — but it never
 *  re-fires to re-plan agents the fixture's static `paneAccountMap` still reports on the old
 *  account. Use this for anything asserting on phase 2. */
async function mountedQuiet() {
  const view = renderHook(() => useAccountSwitch(10 * SWITCH_ADVANCE_MS));
  await settle();
  return view;
}

/** Drive one PHASE-2 advance. `settle()` only flushes microtasks, so without this the 3s interval
 *  that actually moves agents never fires and every `restart` assertion is vacuous. */
async function advance() {
  await act(async () => {
    vi.advanceTimersByTime(SWITCH_ADVANCE_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.restart.mockClear();
  h.setPin.mockClear();
  h.paneAccounts = { a1: "acct-a", a2: "acct-a" };
  h.statuses = { a1: "idle", a2: "idle" };
  h.reason = "approaching";
  h.from = "acct-a";
  h.usage = [wall("acct-a")];
  h.failed = false;
});

describe("an OBSERVED wall migrates running agents without being asked", () => {
  it("auto-starts the switch when the account has actually hit its limit", async () => {
    h.reason = "exhausted";

    const view = await mounted();

    // THE SIDE EFFECT: a plan exists, and nobody called `accept()`. The agents already running on
    // the dead account are enrolled to move at their next safe boundary.
    expect(view.result.current.plan).not.toBeNull();
    expect(view.result.current.plan?.pending.length).toBe(2);
    // And the banner is NOT left asking a question that has already been answered by acting.
    expect(view.result.current.recommendation).toBeNull();
  });

  it("still ASKS when the account is only approaching its learned ceiling", async () => {
    h.reason = "approaching";

    const view = await mounted();

    // The paired negative. Identical fixture, one field different — so this failing while the test
    // above passes is the only outcome consistent with "the reason drives it".
    expect(view.result.current.plan).toBeNull();
    expect(view.result.current.recommendation).not.toBeNull();
    // Nothing was re-spawned on the strength of an estimate.
    expect(h.restart).not.toHaveBeenCalled();
  });

  it("a dismissed warning does not keep agents parked on an account that later hits the wall", async () => {
    // `dismissed` records "stop nagging me that this is getting close" — a wave-off of the
    // PREDICTION. Reading it as a standing refusal to leave an account that has since actually hit
    // its limit would turn one impatient click into hours of idle fleet.
    h.reason = "approaching";
    const view = await mounted();
    expect(view.result.current.recommendation).not.toBeNull();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // Now the estimate becomes an observed fact, and phase 1 re-evaluates.
    h.reason = "exhausted";
    await repoll();

    expect(view.result.current.plan?.pending.length).toBe(2);
  });

  it("enrolls agents but does NOT re-spawn one that is mid-turn", async () => {
    // The safety property the whole design rests on: enrolment is immediate, movement waits for a
    // boundary. `isSafeToSwitch` excludes `working`, so a busy agent keeps its in-flight turn.
    h.reason = "exhausted";
    h.statuses = { a1: "working", a2: "working" };

    const view = await mountedQuiet();
    expect(view.result.current.plan?.pending.length).toBe(2);

    // WITHOUT THIS THE ASSERTION BELOW IS VACUOUS. Phase 2 moves agents on a 3s interval and
    // `settle()` only flushes microtasks — so `restart` is un-called at mount no matter what
    // `isSafeToSwitch` says, and the test stays green against a hook with no safety rule at all.
    await advance();

    expect(h.restart).not.toHaveBeenCalled();
    // Still enrolled, still waiting — not dropped from the plan.
    expect(view.result.current.plan?.pending.length).toBe(2);
  });

  it("re-spawns those same agents once their turn ends", async () => {
    // The paired positive for the test above. Identical fixture but for the statuses, so that one
    // staying green can only be `isSafeToSwitch` excluding `working` — not phase 2 never running.
    h.reason = "exhausted";
    h.statuses = { a1: "idle", a2: "idle" };

    const view = await mountedQuiet();
    expect(view.result.current.plan?.pending.length).toBe(2);

    await advance();

    expect(h.restart).toHaveBeenCalledWith("a1");
    expect(h.restart).toHaveBeenCalledWith("a2");
    // Everyone moved, so the plan retires — which is also what re-arms recommendations.
    expect(view.result.current.plan).toBeNull();
  });

  it("raises the banner instead of spinning an EMPTY plan when nothing can be moved", async () => {
    // Reachable whenever the wall is real but `planSwitch` finds no candidates — e.g. every agent
    // on the account carries a human pin, so `unpinnedRunning` drops them all. Phase 2 never
    // retires a plan with no pending agents, so an empty one would poll forever AND suppress every
    // later recommendation via the `planRef` guard.
    h.reason = "exhausted";
    h.paneAccounts = {};

    const view = await mounted();

    expect(view.result.current.plan).toBeNull();
    expect(view.result.current.recommendation).not.toBeNull();
  });

  it("still raises that banner when the ESTIMATE for the same account was dismissed", async () => {
    // The fall-through's half of "a dismissal waves off the prediction, not an observed wall".
    // Nothing is movable here, so the banner is the ONLY signal left — and silencing it on the
    // strength of an earlier impatient click leaves the fleet parked behind a live wall with
    // nothing said at all, which is the exact harm the automation exists to remove.
    h.reason = "approaching";
    h.paneAccounts = {};
    const view = await mounted();
    expect(view.result.current.recommendation).not.toBeNull();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    h.reason = "exhausted";
    await repoll();

    expect(view.result.current.plan).toBeNull();
    expect(view.result.current.recommendation).not.toBeNull();
  });

  it("but dismissing the WALL banner itself does stick", async () => {
    // The other side of keying `dismissed` by reason, and the reason it is keyed that way rather
    // than exempting `"exhausted"` from the filter. Nothing is movable, so phase 1 re-evaluates
    // every `pollMs` for as long as the account stays walled — up to a ~5h session window. An
    // exempt reason would re-raise this banner on every one of those ticks, making its dismiss
    // button a control that visibly does nothing.
    h.reason = "exhausted";
    h.paneAccounts = {};
    const view = await mounted();
    expect(view.result.current.recommendation).not.toBeNull();

    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    await repoll();

    // Still down — the wave-off was recorded against THIS claim, so it matches on the next pass.
    expect(view.result.current.recommendation).toBeNull();
  });

  it("but it does NOT survive the wall it declined — a later wall speaks again", async () => {
    // The LIFETIME half. A wall wave-off means "I know acct-a is walled right now", not a standing
    // preference: acct-a walls at 09:00 with a fully pinned fleet and the user waves it off; the
    // window resets; acct-a walls again at 19:00. That second wall is a claim nobody declined, and
    // the test above's key would silence it — the same fleet-behind-a-live-wall silence this banner
    // exists to prevent, displaced by one window.
    h.reason = "exhausted";
    h.paneAccounts = {};
    const view = await mounted();
    act(() => view.result.current.dismiss());

    // The window RESETS. `exhaustedUntil` clearing is the observable fact that ends the episode —
    // not the recommendation changing, which the two tests below pin as a different question.
    h.usage = [reset("acct-a")];
    h.reason = "approaching";
    await repoll();

    // The SAME account walls again. New episode, new `exhaustedUntil`, claim nobody declined.
    h.usage = [wall("acct-a")];
    h.reason = "exhausted";
    await repoll();

    expect(view.result.current.recommendation?.reason).toBe("exhausted");
  });

  it("and it survives a tick with NO recommendation while the wall is still live", async () => {
    // "No recommendation this tick" is NOT "the wall is over", and treating it as one is the whole
    // defect this pins. `switchRecommendation` also returns null when there is simply nowhere to
    // go — every other account exhausted, or merely past WARN_FRACTION. A rival's 5h fraction flaps
    // across that threshold on a 120s poll, so retiring on the proxy re-raises a declined banner
    // over and over for the full ~5h wall: the "dismiss button that does nothing" defect again.
    h.reason = "exhausted";
    h.paneAccounts = {};
    const view = await mounted();
    act(() => view.result.current.dismiss());

    // No eligible target this tick — but acct-a is still walled, so nothing about the wave-off
    // has stopped being true.
    h.reason = null;
    await repoll();
    expect(view.result.current.recommendation).toBeNull();

    // A target reappears and the SAME live wall is recommended against again.
    h.reason = "exhausted";
    await repoll();

    expect(view.result.current.recommendation).toBeNull();
  });

  it("and it survives a tick whose account load FAILED — we could not look is not the wall is over", async () => {
    // The same defect as the test above, through the one door that door's fix left open. A failed
    // load does NOT throw: `loadAccountState` RESOLVES to `EMPTY = { …, usage: [], failed: true }`
    // on any IPC rejection, and sets `failed: !shapeOk` on a malformed reply — so the `catch` never
    // sees it and the tick reads `usage: []`. By row alone that is indistinguishable from "no
    // account is walled", which would retire EVERY live wave-off on one transient hiccup. The tick
    // itself is silent (no accounts ⇒ no recommendation), so the damage only shows on the next
    // healthy tick, which re-raises the banner the user already declined — and a flapping bridge
    // repeats that for the whole ~5h window.
    h.reason = "exhausted";
    h.paneAccounts = {};
    // Held in a local so the recovery below can restore the SAME row. `exhaustedUntil` is a fixed
    // timestamp the backend already decided; our failure to read it does not move it, so minting a
    // fresh `wall()` here would be staging a different episode and testing the wrong thing.
    const episode = wall("acct-a");
    h.usage = [episode];
    const view = await mounted();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // The bridge hiccups. Empty usage, but `failed` says we did not LOOK — not that nothing is
    // there. `accountSelection.ts` keeps this distinction for exactly this reason.
    h.failed = true;
    h.usage = [];
    await repoll();

    // It recovers, and the SAME episode's wall is still live. Nobody asked the user about a new
    // one, so the wave-off they gave for this one must still hold.
    h.failed = false;
    h.usage = [episode];
    await repoll();

    expect(view.result.current.recommendation).toBeNull();
  });

  it("and it does NOT survive a new episode whose gap no tick ever observed", async () => {
    // `retireStaleWallDismissals` asks "is this account walled RIGHT NOW", which can only tell two
    // episodes apart if some evaluation happens to land in the gap between them. Nothing guarantees
    // one does: the poll is 120s, and retirement sits after `if (planRef.current) return`, so it
    // does not run AT ALL while a switch plan is outstanding — and a plan is held open until every
    // pending agent reaches a safe boundary, which one agent stuck `working` can stretch for hours.
    // Dismiss acct-a's wall, let the window reset and acct-a re-wall inside that blind stretch, and
    // set membership sees acct-a walled on every tick that runs: the stale wave-off is kept and a
    // wall nobody declined is silenced — the fleet-parked-behind-a-live-wall silence this banner
    // exists to prevent. `exhaustedUntil` is the episode's own identity, so comparing it is exact
    // no matter which ticks ran.
    h.reason = "exhausted";
    h.paneAccounts = {};
    // A wall that LAPSES inside a single poll interval, so the reset and the re-wall both fall
    // between two ticks and no evaluation ever observes acct-a unwalled. Re-walling while the
    // declined wall is still live would be a different scenario entirely — that is an in-place
    // EXTENSION, which the test below pins as the opposite answer.
    h.usage = [{ id: "acct-a", exhaustedUntil: Date.now() + POLL_MS / 2 }];
    const view = await mounted();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // The window resets and acct-a walls AGAIN, both inside that one blind stretch.
    h.usage = [wall("acct-a")];
    await repoll();

    // A claim nobody declined.
    expect(view.result.current.recommendation?.reason).toBe("exhausted");
  });

  it("but an in-place EXTENSION of the same wall does not revoke it", async () => {
    // `exhaustedUntil` is NOT immutable within one episode, which is what makes comparing it subtle.
    // `pendingExhaustions` extends a LIVE bench in place when a fresh limit lands — its docblock:
    // "A LATER reset does update — a fresh limit after a partial recovery extends it" — it polls at
    // 60s, FASTER than this hook's 120s, and it fans the same extension across sibling accounts.
    // So a continuously-walled account's `exhaustedUntil` moves from T1 to T2 with the wall never
    // once ending and no new claim the user could have been asked about.
    //
    // Reading that as a new episode would re-raise a banner the user declined for a wall that never
    // stopped — and would be strictly WORSE than the plain membership rule this replaced, which
    // could not see the change at all. So the episode comparison has to tell "extended" from "new",
    // and the discriminator is whether the declined wall had already lapsed.
    h.reason = "exhausted";
    h.paneAccounts = {};
    const first = wall("acct-a");
    h.usage = [first];
    const view = await mounted();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // The SAME wall, still live, now benched an hour longer.
    h.usage = [{ id: "acct-a", exhaustedUntil: first.exhaustedUntil + 60 * 60 * 1_000 }];
    await repoll();

    expect(view.result.current.recommendation).toBeNull();
  });

  it("and with NO episode recorded it falls back to plain is-it-walled-now", async () => {
    // The fallback arm. A claim is stamped with the `exhaustedUntil` observed for its account, but
    // that can be `null` — nothing was known about the account when the user acted. Episode identity
    // is then unavailable and the only honest question left is the weaker one, "is it walled right
    // now". This pins that arm on its own: without it, a null-episode claim would match no
    // retirement rule at all and outlive every wall forever, which is the permanent version of the
    // silence the whole helper exists to prevent.
    //
    // It errs toward SPEAKING, deliberately — the same trade the docblock names. A spurious re-raise
    // costs a click; a spurious silence costs a fleet idle for five hours.
    h.reason = "exhausted";
    h.paneAccounts = {};
    h.usage = []; // no row for acct-a, so `dismiss` has no episode to stamp
    const view = await mounted();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // acct-a is not walled as far as anything observable says, so there is no live episode for that
    // wave-off to still be about.
    await repoll();

    expect(view.result.current.recommendation?.reason).toBe("exhausted");
  });

  it("and a NULL-episode wave-off still holds while the account IS walled", async () => {
    // The OTHER arm of the same fallback, and the one that actually pins the null check. The test
    // above is retired by the "no live wall at all" rule, which fires for every claim whatever its
    // episode — so on its own it asserts nothing about `episode === null` and the null guard could
    // be deleted with the suite still green. This is the case that separates them: with no episode
    // recorded there is nothing to compare, so the weaker membership rule is all that is left and it
    // must KEEP the wave-off while the account is walled. Without it a null-episode claim would be
    // retired on every tick and the banner would re-raise forever — the exact defect the docblock
    // promises does not happen.
    h.reason = "exhausted";
    h.paneAccounts = {};
    h.usage = []; // no row for acct-a, so `dismiss` has no episode to stamp
    const view = await mounted();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    // Now acct-a is observably walled. Nothing can say whether this is the episode that was
    // declined, so the only safe reading of an un-comparable claim is that it still stands.
    h.usage = [wall("acct-a")];
    await repoll();

    expect(view.result.current.recommendation).toBeNull();
  });

  it("and a wall on a DIFFERENT account does not retire it either", async () => {
    // The other way the proxy leaked: keying retirement off "the one key this tick claims" deletes
    // every other account's wave-off outright, so a momentary `busiestPaneAccount()` flip to acct-c
    // and back re-raises acct-a's declined banner. Observed exhaustion is per-account, so it can't.
    h.reason = "exhausted";
    h.paneAccounts = {};
    h.usage = [wall("acct-a"), wall("acct-c")];
    const view = await mounted();
    act(() => view.result.current.dismiss());

    h.from = "acct-c";
    await repoll();
    expect(view.result.current.recommendation?.from.id).toBe("acct-c");

    h.from = "acct-a";
    await repoll();

    expect(view.result.current.recommendation).toBeNull();
  });

  it("while an ESTIMATE wave-off is a standing preference and outlives a wall", async () => {
    // The paired asymmetry. Both wave-offs expiring on the same rule would make this one useless —
    // "stop nagging me that acct-a is getting close" is not a statement about one episode, so
    // nothing about a wall coming and going revokes it.
    //
    // THE FIXTURE HAS TO MOVE WITH THE NARRATIVE, not just `h.reason`. Retirement judges on the
    // OBSERVED `exhaustedUntil` in `usage`, so if acct-a stayed walled for the whole test — as the
    // `beforeEach` default leaves it — `!walled.has("acct-a")` would be false at every step and the
    // `reason === "exhausted"` half of the predicate could never decide anything. Deleting that
    // clause, i.e. expiring BOTH kinds of wave-off and destroying the asymmetry this test names,
    // would then leave this test and the entire file green. Unwalling acct-a when the wall "goes"
    // is what makes the reason the only thing keeping this wave-off alive.
    h.reason = "approaching";
    h.paneAccounts = {};
    h.usage = [reset("acct-a")];
    const view = await mounted();
    act(() => view.result.current.dismiss());

    // A wall comes...
    h.reason = "exhausted";
    h.usage = [wall("acct-a")];
    await repoll();
    expect(view.result.current.recommendation?.reason).toBe("exhausted");
    // ...and goes. The episode is now observably over, which is exactly what retires a WALL
    // wave-off — so this is the instant an estimate's wave-off has to prove it is made of
    // something else.
    h.reason = "approaching";
    h.usage = [reset("acct-a")];
    await repoll();

    // The estimate is still waved off. It was never a statement about that episode.
    expect(view.result.current.recommendation).toBeNull();
  });

  it("and that wave-off does not silence a DIFFERENT account", async () => {
    // The account half of the composite key, kept honest alongside the reason half.
    h.reason = "exhausted";
    h.paneAccounts = {};
    const view = await mounted();
    act(() => view.result.current.dismiss());
    expect(view.result.current.recommendation).toBeNull();

    h.from = "acct-c";
    await repoll();

    expect(view.result.current.recommendation?.from.id).toBe("acct-c");
  });
});
