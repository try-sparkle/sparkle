// DOUBLE-SPAWN IS THE WORST FAILURE AVAILABLE HERE, AND THESE ARE THE TWO GATES THAT PREVENT IT.
//
// `pty.rs`'s session map is a `HashMap<String, PtySession>` written with `sessions.insert`, which
// REPLACES silently. So a second spawn against one agent id does not fail, does not warn, and does
// not kill anything — it drops the first `PtySession` on the floor. That child keeps running, keeps
// holding its worktree, keeps burning tokens, and is invisible to every surface in the app, because
// nothing holds a handle to it any more. It cannot even be killed from the UI: `pty_kill` looks the
// id up in the map and finds the replacement.
//
// Two independent things could put us there, and they need different gates:
//
//   1. THE PROCESS. `pty_live_sessions` is the app-global reading — the PTY host is shared, so
//      `pty_spawn` from any webview reaches any agent id. `decideResurrection` already requires
//      `processAlive === false`, and this is what makes that input honest.
//   2. THE WINDOW. A torn-off satellite OWNS the panes for the project it displays, and main drops
//      them in the same commit. If this sweep respawned into a project a satellite owns, both
//      webviews would mount an xterm for the same agent — the same collision by a different route.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The abandonment path is a user-facing NOTIFICATION, and its wording is the thing under test — so
// the real notifier is mocked rather than driven, and the mock is asserted on directly.
vi.mock("./attention", () => ({ notifyAttention: vi.fn() }));

import { RESURRECT_LADDER_MS } from "../engine/resurrection";
import { PROBATION_MS } from "../engine/resurrectionCohort";
import { notifyAttention } from "./attention";

import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  type ResurrectionSweepOptions,
  sweepResurrections,
} from "./resurrectionRunner";
import { isAgentAdmitted, resetAdmittedAgents } from "./resurrectionAdmission";

/** `vi.mock` replaces the module at runtime, but the import keeps its real signature — so the mock
 *  surface has to be recovered through `vi.mocked` for the type checker. `tsc` caught this; the
 *  suite was green either way, because vitest transpiles rather than typechecks. */
const notified = vi.mocked(notifyAttention);

const NOW = 1_754_534_400_000;
const FIRST_RUNG = RESURRECT_LADDER_MS[0]!;

function dead(over: Partial<DueAgent> = {}): DueAgent {
  return {
    agentId: "a1",
    projectId: "proj-1",
    worktree: "/wt/a1",
    cause: "transport-transient",
    epoch: "epoch-that-died",
    diedAt: NOW,
    notBeforeMs: NOW,
    message: "API Error: Unable to connect to API (ENOTFOUND)",
    attemptsAt: [],
    ...over,
  };
}

/** Every default is the PERMISSIVE one, so any refusal below is the gate under test doing its job
 *  and not an unrelated precondition quietly failing. `mount` THROWS: nothing in these tests is
 *  supposed to reach it, and a thrown error is louder than an unchecked array. */
function opts(over: Partial<ResurrectionSweepOptions> = {}): ResurrectionSweepOptions {
  return {
    now: NOW + FIRST_RUNG,
    ownsProject: () => true,
    projectTornOut: () => false,
    due: () => Promise.resolve([dead()]),
    liveSessions: () => Promise.resolve([]),
    claim: () => Promise.resolve(true),
    release: () => Promise.resolve(),
    mount: (agentId) => {
      throw new Error(`nothing may mount in this test, but ${agentId} did`);
    },
    suppress: () => {},
    ...over,
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
});

describe("an agent whose PTY is already live is refused", () => {
  it("refuses the id `pty_live_sessions` reports", async () => {
    const outcomes = await sweepResurrections(opts({ liveSessions: () => Promise.resolve(["a1"]) }));

    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "already-live" }]);
    expect(isAgentAdmitted("a1")).toBe(false);
  });

  it("refuses it even though the LEDGER says it is dead", async () => {
    // The two sources genuinely disagree here, and that is the realistic shape rather than a
    // contrived one: the record is stale (the agent was respawned by another window, or the close
    // was written and the pane came back) while the PTY is live RIGHT NOW. The process wins. A
    // runner that trusted the ledger alone would orphan that child.
    const outcomes = await sweepResurrections(
      opts({
        due: () => Promise.resolve([dead({ cause: "app-restart" }), dead({ agentId: "a2" })]),
        liveSessions: () => Promise.resolve(["a1", "a2"]),
      }),
    );

    expect(outcomes.filter((o) => o.action === "respawn")).toEqual([]);
    expect(outcomes.map((o) => o.detail)).toEqual(["already-live", "already-live"]);
  });

  it("does NOT refuse the agents that are genuinely dead alongside it", async () => {
    // The control, and the one that stops this whole file passing vacuously: a live `a1` must not
    // suppress a dead `a2`. Without this, a gate that refused everything would look correct.
    const mounted: string[] = [];
    const outcomes = await sweepResurrections(
      opts({
        // a2 died 500ms BEFORE a1, so its first rung is genuinely due at this clock. (Half a second
        // later and it would be refused `waiting-for-next-rung` — which is the ladder working, but
        // it would make this test prove nothing about the live-session filter.)
        due: () => Promise.resolve([dead(), dead({ agentId: "a2", diedAt: NOW - 500 })]),
        liveSessions: () => Promise.resolve(["a1"]),
        mount: (agentId) => {
          mounted.push(agentId);
                  return "opened" as const;
        },
      }),
    );

    expect(outcomes.find((o) => o.agentId === "a1")?.detail).toBe("already-live");
    // a1 and a2 died 500ms apart of the same verbatim cause, so they ARE one cohort, and a1 — the
    // older death — is who `electCanary` would pick. a1 stays IN the cohort (removing it would
    // dissolve a 2-victim group entirely) and is excluded at ELECTION instead, so a2 is elected and
    // a canary may go immediately.
    //
    // The stall this prevents: elect a live agent and it can never be admitted, so every other
    // member reports `cohort-canary-elected` on every sweep, forever.
    expect(mounted).toEqual(["a2"]);
  });

  it("reads the live set ONCE per sweep, before any admission", async () => {
    // If the set were re-read per agent, a spawn this very sweep started could land between two
    // agents' checks — so the second agent would be judged against a set that already contains the
    // first, and the sweep would be reasoning about a world it changed mid-flight.
    let reads = 0;
    await sweepResurrections(
      opts({
        due: () =>
          Promise.resolve([dead(), dead({ agentId: "a2" }), dead({ agentId: "a3" })]),
        liveSessions: () => {
          reads += 1;
          return Promise.resolve(["a1", "a2", "a3"]);
        },
      }),
    );
    expect(reads).toBe(1);
  });
});

describe("a canary that can no longer serve is re-elected, not waited on forever", () => {
  /** Two agents of the identical cause, 500ms apart — a cohort of exactly 2, which is both the
   *  minimum `groupCohorts` will form and the most common real size. */
  function pair(): DueAgent[] {
    return [
      dead({ agentId: "older", diedAt: NOW - 500 }),
      dead({ agentId: "younger", diedAt: NOW }),
    ];
  }

  it("elects a DIFFERENT member once the elected canary turns up live", async () => {
    // Sweep 1: `older` is elected (oldest death) but the claim is refused, so nothing is admitted
    // and the phase is left at `canary-elected`.
    const swept1 = await sweepResurrections(
      opts({ due: () => Promise.resolve(pair()), claim: () => Promise.resolve(false) }),
    );
    expect(swept1.find((o) => o.agentId === "older")?.detail).toBe("claimed-elsewhere");

    // Sweep 2: the OTHER window respawned `older`, so its PTY is live. Nothing re-derives a stored
    // `canary-elected`, so without the re-election guard `decideCohortAdmission` keeps returning
    // `older` — an id no longer admissible — and `younger` reports `cohort-canary-elected` forever.
    const mounted: string[] = [];
    const swept2 = await sweepResurrections(
      opts({
        due: () => Promise.resolve(pair()),
        liveSessions: () => Promise.resolve(["older"]),
        mount: (agentId) => {
          mounted.push(agentId);
                  return "opened" as const;
        },
      }),
    );

    expect(swept2.find((o) => o.agentId === "older")?.detail).toBe("already-live");
    expect(mounted, "the cohort must elect and admit a new canary, not stall").toEqual(["younger"]);
  });

  it("re-elects when the elected canary leaves the due list entirely", async () => {
    // The "human clicked Start again" route: that pane reopens its record, so the agent drops out
    // of `due` altogether rather than showing up as live.
    await sweepResurrections(
      opts({ due: () => Promise.resolve(pair()), claim: () => Promise.resolve(false) }),
    );

    const mounted: string[] = [];
    await sweepResurrections(
      opts({
        due: () => Promise.resolve([dead({ agentId: "younger", diedAt: NOW })]),
        mount: (agentId) => {
          mounted.push(agentId);
                  return "opened" as const;
        },
      }),
    );
    expect(mounted).toEqual(["younger"]);
  });
});

describe("liveness is a per-sweep fact and must not pollute the DURABLE burned set", () => {
  it("leaves an unrelated live agent electable after a re-election", async () => {
    // `unelectable` is `burned ∪ liveIds`, and `liveIds` is EVERY live PTY in the process — not
    // just this cohort's members. Persisting that whole set into `burnedCanaries` makes every
    // currently-healthy agent permanently unelectable for this cohort key, and
    // `stabilizeCohortKeys`' supersedes copy carries the pollution across every re-key.
    //
    // The rolling-outage shape, in three sweeps.
    const three = [
      dead({ agentId: "older", diedAt: NOW - 1_000 }),
      dead({ agentId: "younger", diedAt: NOW - 500 }),
      dead({ agentId: "stranger", diedAt: NOW }),
    ];
    const mounted: string[] = [];
    const mount = (agentId: string) => {
      mounted.push(agentId);
      return "opened" as const;
    };

    // 1. `older` is elected and the claim is refused, so the phase sticks at `canary-elected`.
    await sweepResurrections(
      opts({ due: () => Promise.resolve(three), claim: () => Promise.resolve(false) }),
    );

    // 2. `older` comes back by another route, and `stranger` happens to be live too. Only `older`
    //    may be burned here — `stranger` is merely healthy at this instant.
    await sweepResurrections(
      opts({
        due: () => Promise.resolve(three),
        liveSessions: () => Promise.resolve(["older", "stranger"]),
        mount,
      }),
    );
    expect(mounted).toEqual(["younger"]);

    // 3. `younger` fails its probation, and `older` has meanwhile left the due list for good (its
    //    record was reopened). The next canary must therefore be `stranger` — which is only
    //    possible if it was never burned. With the pollution, `electCanary` returns null and a
    //    3-agent cohort is abandoned with "no untried victim remains" after ONE failure.
    const swept = await sweepResurrections(
      opts({
        due: () =>
          Promise.resolve(three.filter((d) => d.agentId !== "older")),
        liveSessions: () => Promise.resolve([]),
        mount,
        probationEvidence: () => ({
          exited: true,
          reWalled: false,
          apiBannerAt: undefined,
          hasTurnAuthority: false,
          didWork: false,
        }),
      }),
    );

    expect(
      swept.some((o) => o.detail === "cohort-abandoned"),
      "a single probation failure must not abandon the cohort",
    ).toBe(false);
    expect(mounted).toEqual(["younger", "stranger"]);
  });

  it("re-elects a canary the per-agent gate refuses for good — not just a live one", async () => {
    // `daily-cap-spent` is the only TERMINAL bound in `decideResurrection`, and the agent carrying
    // it is the most likely to be elected: `electCanary` prefers the oldest death, and a flapping
    // agent that has burned its 24 attempts is exactly that. It is dead and still in `due`, so a
    // liveness-only re-election test leaves it elected and the cohort stalls until the rolling 24h
    // window rolls off.
    const spent = Array.from({ length: 24 }, (_, i) => NOW - 60_000 * (i + 1));
    const mounted: string[] = [];

    const swept = await sweepResurrections(
      opts({
        due: () =>
          Promise.resolve([
            dead({ agentId: "capped", diedAt: NOW - 1_000, attemptsAt: spent }),
            dead({ agentId: "healthy", diedAt: NOW }),
          ]),
        mount: (agentId) => {
          mounted.push(agentId);
                  return "opened" as const;
        },
      }),
    );

    expect(swept.find((o) => o.agentId === "capped")?.detail).toBe("daily-cap-spent");
    expect(mounted, "the cohort must move on to a canary that can actually go").toEqual(["healthy"]);
  });

  it("waits — does NOT give up — when every member is merely over the rolling daily cap", async () => {
    // `daily-cap-spent` is counted over a ROLLING 24h window, so it clears by itself. Treating it
    // as terminal would make this cohort `abandoned` — a phase nothing re-derives, so
    // `decideCohortAdmission` returns [] for the life of the key and the agents are unrecoverable
    // without a human. And all-members-capped is the LIKELY state, not an exotic one: cohort members
    // die of one cause and are admitted in the same batches, so their attempt counts move in
    // lockstep.
    const spent = Array.from({ length: 24 }, (_, i) => NOW - 60_000 * (i + 1));
    const bothCapped = [
      dead({ agentId: "one", diedAt: NOW - 500, attemptsAt: spent }),
      dead({ agentId: "two", diedAt: NOW, attemptsAt: spent }),
    ];

    const swept = await sweepResurrections(opts({ due: () => Promise.resolve(bothCapped) }));
    expect(swept.every((o) => o.action === "none")).toBe(true);
    expect(
      swept.some((o) => o.detail === "cohort-abandoned"),
      "a cohort that only needs to wait must not be given up on",
    ).toBe(false);

    // …and once the window has rolled off, the very same cohort recovers.
    const mounted: string[] = [];
    await sweepResurrections(
      opts({
        // A day later: every attempt in `spent` has aged out of the rolling window.
        now: NOW + 25 * 60 * 60_000,
        due: () => Promise.resolve(bothCapped),
        mount: (agentId) => {
          mounted.push(agentId);
                  return "opened" as const;
        },
      }),
    );
    expect(mounted, "the cap lapsed, so the cohort must elect and send a canary").toEqual(["one"]);
  });

  it("still WAITS on a canary whose refusal will clear by itself", async () => {
    // The control that keeps the rule narrow. `waiting-for-next-rung` resolves on its own, so
    // re-electing over it would rotate canaries for no reason and burn the cohort's victims.
    const swept = await sweepResurrections(
      opts({
        now: NOW, // before the first rung for both
        due: () =>
          Promise.resolve([
            dead({ agentId: "older", diedAt: NOW - 500 }),
            dead({ agentId: "younger", diedAt: NOW }),
          ]),
        mount: () => {
          throw new Error("nothing may mount before the first rung");
        },
      }),
    );
    expect(swept.find((o) => o.agentId === "older")?.detail).toBe("waiting-for-next-rung");
  });
});

describe("a cohort IS eventually given up on, and the human is told the truth about why", () => {
  /** Fail every probation, so the cohort burns through its canaries. */
  const ALWAYS_FAILS = () => ({
    exited: true,
    reWalled: false,
    apiBannerAt: undefined,
    hasTurnAuthority: false,
    didWork: false,
  });

  it("reaches `abandoned` and notifies, rather than looping forever", async () => {
    // THE POSITIVE DIRECTION, which nothing asserted. Every other test on this gate is negative
    // ("must NOT be abandoned"), so replacing the guard with a constant `false` — or dropping it
    // entirely — would make `abandoned` permanently unreachable, the cohort would loop silently,
    // no human would ever be told, and the whole suite would stay green. That is exactly the
    // "abandoned unreachable, no human ever asked" regression this module has already had once.
    notified.mockClear();
    const pair = [
      dead({ agentId: "first", diedAt: NOW - 500 }),
      dead({ agentId: "second", diedAt: NOW }),
    ];
    const run = (now: number) =>
      sweepResurrections(
        opts({
          now,
          due: () => Promise.resolve(pair),
          mount: () => "opened" as const,
          probationEvidence: ALWAYS_FAILS,
        }),
      );

    let swept = await run(NOW + FIRST_RUNG);
    // Sweep until the cohort gives up; PROBATION_MS apart so each canary's window closes.
    for (let i = 1; i <= 6 && !swept.some((o) => o.detail === "cohort-abandoned"); i++) {
      swept = await run(NOW + FIRST_RUNG + i * (PROBATION_MS + 1_000));
    }

    expect(
      swept.filter((o) => o.detail === "cohort-abandoned").length,
      "a cohort whose canaries all fail must be given up on, not retried forever",
    ).toBeGreaterThan(0);

    // …and the body must describe what ACTUALLY happened. Both members were sent and both failed,
    // so the "none of these agents could be sent" sentence would be a lie on this path.
    expect(notified).toHaveBeenCalled();
    const body = notified.mock.calls.at(-1)?.[0]?.body ?? "";
    expect(body).toMatch(/canar(y|ies) sent to test it failed/);
    expect(body).not.toMatch(/none of these agents could be sent/);
  });

  it("counts canary failures ACROSS a wait, so the budget cannot restart at 1", async () => {
    // THE TEST THE cohortAttempts FIX NEEDS, and the one it shipped without.
    //
    // Every other test here elects through `observed` with the counter EMPTY, or re-elects through
    // `afterFailure` (which carries its own `state.attempt`), so `cohortAttempts` was written and
    // never read in a way that changed an outcome. Replacing `(cohortAttempts.get(key) ?? 0) + 1`
    // with a literal `1` — the exact bug the previous round filed — left the whole suite green.
    //
    // So this drives the one path that reads it: a probation FAILS, the next sweep finds nobody
    // electable and drops back to `observed`, and the sweep after that must resume at attempt 2
    // rather than starting over. The discriminator is the abandonment REASON: budget-exhausted
    // says "3 canaries failed", while a restarted budget runs out of victims first and says
    // "no untried victim remains".
    notified.mockClear();
    const three = [
      dead({ agentId: "c1", diedAt: NOW - 1_000 }),
      dead({ agentId: "c2", diedAt: NOW - 500 }),
      dead({ agentId: "c3", diedAt: NOW }),
    ];
    const mounted: string[] = [];
    let live: string[] = [];
    const run = (t: number) =>
      sweepResurrections(
        opts({
          now: NOW + FIRST_RUNG + t,
          due: () => Promise.resolve(three),
          liveSessions: () => Promise.resolve(live),
          mount: (agentId) => {
            mounted.push(agentId);
                      return "opened" as const;
          },
          probationEvidence: ALWAYS_FAILS,
        }),
      );

    await run(0); // elect c1 (attempt 1) and send it
    expect(mounted).toEqual(["c1"]);

    // c1 fails; the other two are momentarily live, so nobody is electable and the phase drops
    // back to `observed`. THIS is the wait that used to erase the budget.
    live = ["c2", "c3"];
    await run(1_000);
    expect(mounted, "nobody may be sent while the cohort has no electable victim").toEqual(["c1"]);

    // They are dead again. Resuming correctly means attempt 2, not attempt 1.
    live = [];
    await run(2_000);
    expect(mounted).toEqual(["c1", "c2"]);

    await run(3_000); // c2 fails → c3 elected at attempt 3 and sent
    expect(mounted).toEqual(["c1", "c2", "c3"]);

    const last = await run(4_000); // c3 fails → budget spent
    expect(last.some((o) => o.detail === "cohort-abandoned")).toBe(true);
    const body = notified.mock.calls.at(-1)?.[0]?.body ?? "";
    expect(
      body,
      "abandoning after 3 FAILURES is the budget working; running out of victims first means it restarted",
    ).toMatch(/3 canaries failed/);
  });

  it("stays abandoned when a newcomer re-keys a cohort whose budget is already spent", async () => {
    // THE RUNNER'S OWN BUDGET GATE, which nothing reached (roborev 60378).
    //
    // The test above pins how `nextAttempt` is DERIVED, but it abandons through `afterFailure` in
    // the engine — which carries its own `${MAX_CANARY_ATTEMPTS} canaries failed` copy. So the
    // string it matches comes from the engine, and deleting the runner's
    // `if (nextAttempt > MAX_CANARY_ATTEMPTS)` branch outright left the whole suite green.
    //
    // That branch has exactly one route in production: `stabilizeCohortKeys` mints a fresh key when
    // a cohort GAINS a member, and the carry moves `cohortAttempts` across but NOT an `abandoned`
    // phase (only `released` is carried, deliberately). So the fresh key defaults to `observed`
    // holding a spent budget, and only the runner can stop it electing again.
    //
    // The discriminator is the MOUNT, not the copy: with the branch removed, c4 is untried and
    // unburned, so `electCanary` hands it back and a fourth probation is sent against a door the
    // cohort has already established is shut.
    notified.mockClear();
    const three = [
      dead({ agentId: "c1", diedAt: NOW - 1_000 }),
      dead({ agentId: "c2", diedAt: NOW - 500 }),
      dead({ agentId: "c3", diedAt: NOW }),
    ];
    const mounted: string[] = [];
    let due = three;
    const run = (t: number) =>
      sweepResurrections(
        opts({
          now: NOW + FIRST_RUNG + t,
          due: () => Promise.resolve(due),
          mount: (agentId) => {
            mounted.push(agentId);
            // `mount` reports whether the pane actually came up (`MountResult`), so a stub that
            // returns nothing is a type error under the new seam — and, since the runner now fails
            // closed, would also be REFUSED at runtime as "did not land", short-circuiting before
            // any probation and making the budget assertions below vacuous. Report a real mount so
            // this test keeps exercising the canary budget it is about.
            return "opened";
          },
          probationEvidence: ALWAYS_FAILS,
        }),
      );

    await run(0); // c1 elected, attempt 1
    await run(1_000); // c1 fails -> c2, attempt 2
    await run(2_000); // c2 fails -> c3, attempt 3
    const spent = await run(3_000); // c3 fails -> budget exhausted
    expect(spent.some((o) => o.detail === "cohort-abandoned")).toBe(true);
    expect(mounted).toEqual(["c1", "c2", "c3"]);

    // A fourth agent dies of the SAME cause inside the window, so the cohort is re-keyed and the
    // spent budget is carried onto a key that has no phase.
    due = [...three, dead({ agentId: "c4", diedAt: NOW + 60_000 })];
    const after = await run(4_000);

    expect(
      mounted,
      "a spent budget must survive the re-key: electing c4 here is a fourth probation against a door already known shut",
    ).toEqual(["c1", "c2", "c3"]);
    expect(after.some((o) => o.action === "respawn")).toBe(false);
    expect(after.some((o) => o.detail === "cohort-abandoned")).toBe(true);
  });

  it("says nobody was sent when nobody COULD be — the other branch of the same sentence", async () => {
    // The inverted control. A cohort whose members are all permanently unfit is abandoned on its
    // FIRST sweep with zero probations run, and there the original copy would have been the lie.
    notified.mockClear();
    const swept = await sweepResurrections(
      opts({
        due: () =>
          Promise.resolve([
            dead({ agentId: "done-1", cause: "clean-goal-met", diedAt: NOW - 500 }),
            dead({ agentId: "done-2", cause: "clean-goal-met", diedAt: NOW }),
          ]),
        mount: () => {
          throw new Error("a finished agent must never be mounted");
        },
      }),
    );

    // Each member reports its OWN refusal rather than the cohort's phase — `clean-goal-met` is the
    // useful answer here — so the notification is what proves the cohort was abandoned.
    expect(swept.map((o) => o.detail)).toEqual(["clean-goal-met", "clean-goal-met"]);
    expect(notified).toHaveBeenCalled();
    const body = notified.mock.calls.at(-1)?.[0]?.body ?? "";
    expect(body).toMatch(/none of these agents could be sent/);
    expect(body).not.toMatch(/canar(y|ies) sent to test it failed/);
  });
});

describe("a 2-victim cohort is NOT dissolved when its canary is mounted", () => {
  it("holds the second member back while the canary is on probation", async () => {
    // THE REGRESSION THAT FILTERING-BEFORE-GROUPING CAUSED. `groupCohorts` discards any cluster
    // below SHARED_FAILURE_MIN_VICTIMS (2), so dropping the live canary from the input left ONE
    // member, the cohort vanished, its phase was pruned, and the survivor fell through as a "lone
    // death" and was respawned immediately — while the canary had proven nothing. That is the
    // retry-into-a-closed-door this module exists to prevent.
    const both = [
      dead({ agentId: "canary", diedAt: NOW - 500 }),
      dead({ agentId: "survivor", diedAt: NOW }),
    ];
    const mounted: string[] = [];
    const mount = (agentId: string) => {
      mounted.push(agentId);
      return "opened" as const;
    };

    // Sweep 1 admits the canary.
    await sweepResurrections(opts({ due: () => Promise.resolve(both), mount }));
    expect(mounted).toEqual(["canary"]);

    // Sweep 2: the canary's PTY is live and it is mid-probation. The survivor must WAIT.
    const swept = await sweepResurrections(
      opts({
        due: () => Promise.resolve(both),
        liveSessions: () => Promise.resolve(["canary"]),
        mount,
        probationEvidence: () => ({
          exited: false,
          reWalled: false,
          apiBannerAt: undefined,
          // Nothing proven yet — the boot is still in progress.
          hasTurnAuthority: false,
          didWork: false,
        }),
      }),
    );

    expect(mounted, "the survivor must not be respawned mid-probation").toEqual(["canary"]);
    expect(swept.find((o) => o.agentId === "survivor")?.detail).toBe("cohort-probation");
  });
});

describe("a project a satellite window owns is refused", () => {
  it("refuses to mount into a torn-out project", async () => {
    const outcomes = await sweepResurrections(opts({ projectTornOut: () => true }));

    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "project-torn-out" }]);
    expect(isAgentAdmitted("a1")).toBe(false);
  });

  it("refuses ONLY the torn-out project's agents", async () => {
    // The control again: torn-out is per PROJECT, and an over-broad gate that dropped the whole
    // sweep would satisfy the test above.
    const mounted: string[] = [];
    const outcomes = await sweepResurrections(
      opts({
        due: () =>
          Promise.resolve([
            dead({ agentId: "torn", projectId: "satellite-proj" }),
            dead({ agentId: "mine", projectId: "proj-1" }),
          ]),
        projectTornOut: (projectId) => projectId === "satellite-proj",
        mount: (agentId) => {
          mounted.push(agentId);
                  return "opened" as const;
        },
      }),
    );

    expect(outcomes.find((o) => o.agentId === "torn")?.detail).toBe("project-torn-out");
    expect(mounted).toEqual(["mine"]);
  });

  it("refuses a project another WINDOW owns, which is a different question from torn-out", async () => {
    // `ownsProjectInThisWindow` is the app's existing single-owner election. Torn-out is about a
    // project living in a satellite; ownership is about which window adopted an unowned one. Both
    // must refuse, and they are separate gates because either can be true without the other.
    const outcomes = await sweepResurrections(opts({ ownsProject: () => false }));
    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "not-this-window" }]);
  });
});

describe("a claim another epoch holds is refused", () => {
  it("does not admit when the durable claim is refused", async () => {
    // The CROSS-PROCESS gate, which neither of the two above can provide: a second app instance (or
    // a stale claim from one that died) is already respawning this agent. `claim_at` answering
    // `HeldLive` surfaces here as `false`, and that is a refusal rather than an error.
    const released: Array<[string, boolean]> = [];
    const outcomes = await sweepResurrections(
      opts({
        claim: () => Promise.resolve(false),
        release: (agentId, spawned) => {
          released.push([agentId, spawned]);
          return Promise.resolve();
        },
      }),
    );

    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "claimed-elsewhere" }]);
    // A claim we never took must not be given back — releasing here would clear the HOLDER's claim
    // and hand exclusivity away to whoever asked next.
    expect(released).toEqual([]);
  });
});
