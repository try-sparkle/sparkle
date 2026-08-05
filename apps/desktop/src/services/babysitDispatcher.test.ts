// THE SWEEP THAT STARTS `/babysit-pr` BY ITSELF — and the two things it must never do.
//
// It must never dispatch TWO drivers for one PR (two overlapping passes replying to the same
// comments, published to a human's pull request), and it must never dispatch on a schedule rather
// than on evidence (an agent per PR per sweep burns the fleet). Both are asserted here against the
// SIDE EFFECT — whether a spawn happened, whether a lease was released — never against a
// precondition, because a precondition assertion would have passed before this module existed.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
const spawnMock = vi.fn();
const fetchOpenPrsMock = vi.fn();
const capacityMock = vi.fn(() => ({ atCapacity: false, used: 0, limit: 8, basis: "test" }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("./buildAgentSpawn", () => ({ spawnBuildAgentInProject: (...a: unknown[]) => spawnMock(...a) }));
vi.mock("./agentCapacity", () => ({ localAgentCapacity: () => capacityMock() }));
// The production tick reads the real store and the real window-ownership election; both are
// stubbed so the deadline test can drive `startBabysitDispatcher` itself.
vi.mock("./goalContinuationRunner", () => ({ ownsProjectInThisWindow: () => true }));
vi.mock("./openPrs", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchOpenPrs: (...a: unknown[]) => fetchOpenPrsMock(...a) };
});

import {
  BABYSIT_LEASE_ACQUIRE_COMMAND,
  BABYSIT_LEASE_LIST_COMMAND,
  BABYSIT_LEASE_RELEASE_COMMAND,
  KNIGHTWATCH_PROBE_GATE_COMMAND,
  _resetBabysitDispatcherForTests,
  babysitPrompt,
  sweepAllProjects,
  startBabysitDispatcher,
  BABYSIT_SWEEP_ABANDON_MS,
  BABYSIT_SWEEP_MS,
  babysitSweepProject,
  checkRollupOf,
  readProbeGate,
  repoSlugFromPrUrl,
  standingFor,
} from "./babysitDispatcher";
import { resolveBabysitConfig } from "@sparkle/core";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";

const PROJECT = { id: "p1", name: "sparkle", rootPath: "/repo" } as unknown as Project;
const T0 = 1_700_000_000_000;
const CONFIG = resolveBabysitConfig({});

/** A PR carrying one UNANSWERED [blocking] probe — the evidence the whole feature exists for. */
function prWithProbe(number = 1251) {
  return {
    number,
    title: "t",
    headRefName: "b",
    url: `https://github.com/drodio/sparkle/pull/${number}`,
    checks: "passing" as const,
    mergeable: "mergeable" as const,
    mergeStateStatus: "clean" as const,
  };
}

function gateWithUnansweredBlocking() {
  return {
    applicable: true,
    probes: [
      {
        commentId: 9,
        index: 1,
        severity: "blocking",
        from: null,
        text: "x",
        url: "u",
        answered: false,
      },
    ],
    error: null,
    overridden: false,
  };
}

/** Route the three commands the sweep issues. `leases` undefined ⇒ the list call throws. */
function wireInvoke(opts: {
  gate?: unknown;
  leases?: unknown[];
  acquired?: boolean;
  acquireThrows?: boolean;
}): void {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === BABYSIT_LEASE_LIST_COMMAND) {
      if (opts.leases === undefined) throw new Error("unreadable");
      return opts.leases;
    }
    if (cmd === KNIGHTWATCH_PROBE_GATE_COMMAND) return opts.gate ?? gateWithUnansweredBlocking();
    if (cmd === BABYSIT_LEASE_ACQUIRE_COMMAND) {
      if (opts.acquireThrows) throw new Error("bridge down");
      return { acquired: opts.acquired ?? true };
    }
    if (cmd === BABYSIT_LEASE_RELEASE_COMMAND) return null;
    throw new Error(`unexpected command ${cmd}`);
  });
}

/** Run the sweep TWICE — the two-observation rule means one sweep can never dispatch. */
async function sweepTwice() {
  await babysitSweepProject(PROJECT, T0, CONFIG);
  return babysitSweepProject(PROJECT, T0 + 60_000, CONFIG);
}

beforeEach(() => {
  invokeMock.mockReset();
  spawnMock.mockReset();
  fetchOpenPrsMock.mockReset();
  capacityMock.mockReturnValue({ atCapacity: false, used: 0, limit: 8, basis: "test" });
  spawnMock.mockReturnValue("agent-1");
  fetchOpenPrsMock.mockResolvedValue([prWithProbe()]);
  _resetBabysitDispatcherForTests();
});

describe("repoSlugFromPrUrl — identity is (repo, pr), never the bare number", () => {
  it("parses owner/name and lowercases it", () => {
    expect(repoSlugFromPrUrl("https://github.com/DRodio/Sparkle/pull/1251")).toBe("drodio/sparkle");
  });
  it("REFUSES to guess rather than returning a wrong slug", () => {
    // A wrong slug keys the lease against a different repository's PR of the same number.
    expect(repoSlugFromPrUrl("https://github.com/drodio/sparkle/issues/1251")).toBeUndefined();
    expect(repoSlugFromPrUrl("not a url")).toBeUndefined();
    expect(repoSlugFromPrUrl(undefined)).toBeUndefined();
  });
});

describe("checkRollupOf — the empty case is renamed, not dropped", () => {
  it("maps none → absent, so the core never reads it as 'not looked'", () => {
    expect(checkRollupOf({ ...prWithProbe(), checks: "none" } as never)).toBe("absent");
    expect(checkRollupOf({ ...prWithProbe(), checks: "failing" } as never)).toBe("failing");
  });
});

describe("standingFor — three states, and unknown never reads as free", () => {
  it("an unreadable store is unknown, NOT free", () => {
    expect(standingFor(undefined, "a/b", 1)).toBe("unknown");
  });
  it("no row for this PR is free", () => {
    expect(standingFor([], "a/b", 1)).toBe("free");
  });
  it("live holds, both dead flavours are reclaimable", () => {
    const row = (standing: string) => [{ lease: { repo: "a/b", pr: 1 }, standing }];
    expect(standingFor(row("live"), "a/b", 1)).toBe("held-live");
    expect(standingFor(row("dead-epoch"), "a/b", 1)).toBe("held-dead");
    expect(standingFor(row("dead-stale"), "a/b", 1)).toBe("held-dead");
  });
  it("a standing this build does not recognise is not a licence to dispatch", () => {
    expect(standingFor([{ lease: { repo: "a/b", pr: 1 }, standing: "sideways" }], "a/b", 1)).toBe("unknown");
  });
  it("keys on (repo, pr) — the same number in another repo is a different lease", () => {
    const held = [{ lease: { repo: "c/d", pr: 1 }, standing: "live" }];
    expect(standingFor(held, "a/b", 1)).toBe("free");
  });
});

describe("readProbeGate — a failed read is UNKNOWN, never 'no probes'", () => {
  it("an invoke that throws yields probes: undefined", async () => {
    invokeMock.mockRejectedValueOnce(new Error("gh unauthenticated"));
    const gate = await readProbeGate("/repo", 1);
    expect(gate.probes).toBeUndefined();
    expect(gate.applicable).toBe(true);
  });
  it("an unrecognised reply shape is UNKNOWN too", async () => {
    invokeMock.mockResolvedValueOnce({ nonsense: true });
    expect((await readProbeGate("/repo", 1)).probes).toBeUndefined();
  });
});

describe("the sweep", () => {
  it("dispatches ONE driver for a PR with an unanswered blocking probe", async () => {
    wireInvoke({ leases: [] });
    const out = await sweepTwice();

    expect(out.dispatched).toEqual([{ repo: "drodio/sparkle", pr: 1251, agentId: "agent-1" }]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The prompt is the slash command, delivered as claude's positional argv.
    expect(spawnMock.mock.calls[0]?.[1]).toMatchObject({ prompt: babysitPrompt(1251), background: true });
  });

  it("does NOT dispatch on the first sighting — the two-observation rule", async () => {
    wireInvoke({ leases: [] });
    const first = await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(first.dispatched).toHaveLength(0);
    expect(first.holds["single-observation"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT dispatch a green PR with no probes — evidence, never schedule", async () => {
    wireInvoke({ leases: [], gate: { applicable: false, probes: [], error: null, overridden: false } });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);
    expect(out.holds["no-evidence"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when a driver is already live — one driver per PR", async () => {
    wireInvoke({ leases: [{ lease: { repo: "drodio/sparkle", pr: 1251 }, standing: "live" }] });
    const out = await sweepTwice();
    expect(out.holds["driver-alive"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when the lease store is unreadable — fail closed", async () => {
    wireInvoke({ leases: undefined });
    const out = await sweepTwice();
    expect(out.holds["lease-unknown"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when the probe read failed — unknown is not 'nothing to do'", async () => {
    wireInvoke({ leases: [], gate: { applicable: true, probes: undefined, error: "boom", overridden: false } });
    const out = await sweepTwice();
    expect(out.holds["probe-read-unknown"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("LOSING THE ACQUIRE RACE MEANS NO SPAWN — the acquire, not the read, is the exclusion", async () => {
    // Two ticks can both read `free`; only the compare-and-set decides. This is the assertion that
    // pins acquire-before-spawn: with the order reversed, an agent already exists by now.
    wireInvoke({ leases: [], acquired: false });
    const out = await sweepTwice();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(out.dispatched).toHaveLength(0);
  });

  it("a lease that could not be acquired at all does not spawn either", async () => {
    wireInvoke({ leases: [], acquireThrows: true });
    await sweepTwice();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("RELEASES the lease when the spawn is refused, so the PR is not silenced until it goes stale", async () => {
    wireInvoke({ leases: [] });
    spawnMock.mockReturnValue(null); // e.g. at capacity, torn out, or not on screen
    await sweepTwice();

    const released = invokeMock.mock.calls.filter((c) => c[0] === BABYSIT_LEASE_RELEASE_COMMAND);
    expect(released).toHaveLength(1);
    expect(released[0]?.[1]).toMatchObject({ repo: "drodio/sparkle", pr: 1251 });
  });

  // ── THE DISPATCH EDGE'S SUCCESS CONDITION (roborev 58488) ────────────────────────────────────
  //
  // `clocks.sawLive` is stamped only INSIDE `if (agentId)`, and that guard is what these two pin.
  // (The commit that introduced them pinned a `lastDispatchAt` stamp on the same line; that field
  // has since been DELETED as dead — see the note further down — and the guard it shared with
  // `sawLive` is the part that survived and still matters.) Every other clock rule had a test that
  // failed when it moved; this one did not, because the refusal tests all stopped after the refused
  // sweep and none could observe a cooldown that should not exist.
  //
  // It is not hypothetical. `7652ba5` made a background spawn refuse outright for a project the
  // human has not visited this session, so `spawnBuildAgentInProject` returns `null` on EVERY sweep
  // for those projects — with the stamp moved, each such PR is charged a fresh 30-minute
  // `cooling-down` for a driver that was never created, and the PR silently stops being watched.
  it("a LOST ACQUIRE charges no cooldown — the next sweep may still dispatch", async () => {
    wireInvoke({ leases: [], acquired: false });
    await sweepTwice();
    expect(spawnMock).not.toHaveBeenCalled();

    // A third sweep well inside the 30-minute cooldown. Nothing was created, so nothing is owed.
    const third = await babysitSweepProject(PROJECT, T0 + 120_000, CONFIG);
    expect(third.holds["cooling-down"]).toBeUndefined();

    // And once the acquire succeeds, it really does dispatch — still inside that same window.
    wireInvoke({ leases: [], acquired: true });
    const fourth = await babysitSweepProject(PROJECT, T0 + 180_000, CONFIG);
    expect(fourth.dispatched).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("a REFUSED SPAWN charges no cooldown either — the lease came back, so nothing happened", async () => {
    wireInvoke({ leases: [] });
    spawnMock.mockReturnValue(null);
    await sweepTwice();

    const third = await babysitSweepProject(PROJECT, T0 + 120_000, CONFIG);
    expect(third.holds["cooling-down"]).toBeUndefined();

    spawnMock.mockReturnValue("agent-1");
    const fourth = await babysitSweepProject(PROJECT, T0 + 180_000, CONFIG);
    expect(fourth.dispatched).toHaveLength(1);
  });

  // NO "a successful dispatch DOES charge the cooldown" TEST HERE, DELIBERATELY — one was written
  // and DELETED because it could not fail. Deleting `clocks.lastDispatchAt = now` outright left all
  // assertions green: after a dispatch `sawLive` is set, so the very next sweep sees a `free` lease,
  // fires the EXIT edge, and produces `cooling-down` from `lastDriverExitAt` instead. The test read
  // as proof of the dispatch stamp and was really observing the exit clock.
  //
  // The real diagnosis went further (roborev 58509): `lastDispatchAt` was not merely untested, it was
  // STRUCTURALLY UNOBSERVABLE and dead as a limiter — the core short-circuits on `held-live`/`unknown`
  // before the cooldown check, so the first sweep that can reach that check is also the first to fire
  // the exit edge, and `latest()` takes the max, so the exit stamp always shadowed it. It has been
  // DELETED; the exit clock is the sole per-PR limiter in this sweep.
  //
  // What the two refusal tests above pin is therefore `clocks.sawLive`, and that pinning is
  // mutation-proven: hoisting it out of `if (agentId)` makes a refused sweep record a driver that
  // never existed, the next sweep fires a phantom exit edge, and exactly those two tests fail.

  it("an unreadable PR list is reported, not treated as 'no open PRs'", async () => {
    fetchOpenPrsMock.mockResolvedValue(null);
    wireInvoke({ leases: [] });
    const out = await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(out.holds["pr-state-unknown"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("a PR whose repo cannot be identified is counted, never judged", async () => {
    fetchOpenPrsMock.mockResolvedValue([{ ...prWithProbe(), url: "https://example.test/nope" }]);
    wireInvoke({ leases: [] });
    const out = await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(out.unidentified).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("the quota-repost storm produces no dispatch however many sweeps it runs for", async () => {
    // `⏸ knightwatch paused` carries the marker and lists ZERO probes, and it re-posts every ~2
    // minutes for the length of an outage. Keyed on comments this is ~30 dispatches an hour, and the
    // two-observation rule does NOT save you — a repost storm is persistently true.
    wireInvoke({ leases: [], gate: { applicable: true, probes: [], error: null, overridden: false } });
    for (let i = 0; i < 30; i++) await babysitSweepProject(PROJECT, T0 + i * 120_000, CONFIG);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// THE PER-PR COOLDOWN IS ONLY REAL IF THE SWEEP FEEDS THE CLOCKS.
//
// `BabysitFleetState`'s clock fields are OPTIONAL, so a sweep that omits the one it feeds disables
// the cooldown with no type error and no red test — the whole suite above stays green over a
// `cooling-down` hold that can never fire. (`lastDispatchAt` is omitted on purpose and is not a
// cooldown source here; `lastDriverExitAt` is the sole per-PR limiter.) Every assertion here is on
// the side effect — did a SECOND spawn happen — and fails if that field is dropped.
describe("the per-PR cooldown", () => {
  /** Dispatch once: two sweeps with a free lease. Returns the epoch of the dispatch. */
  async function dispatchOnce(): Promise<number> {
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);
    await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    return T0 + 60_000;
  }

  const held = (standing: string) => [{ lease: { repo: "drodio/sparkle", pr: 1251 }, standing }];

  it("a driver that just EXITED is not re-dispatched on the next sweep", async () => {
    const at = await dispatchOnce();
    // The driver ran, answered nothing the sweep can see (the probe is still unanswered), and
    // released its lease. Without the clocks this is a dispatch on the very next 180 s tick.
    wireInvoke({ leases: [] });
    const out = await babysitSweepProject(PROJECT, at + 60_000, CONFIG);

    expect(out.holds["cooling-down"]).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("the cooldown ELAPSES — and the exit is stamped ONCE, not refreshed every sweep", async () => {
    const at = await dispatchOnce();
    wireInvoke({ leases: [] });
    const exitSeen = at + 60_000;
    await babysitSweepProject(PROJECT, exitSeen, CONFIG); // stamps the exit, holds

    // 31 minutes past the EXIT. A caller that re-stamped `lastDriverExitAt` on every sweep that
    // still sees no driver would pin this PR at `cooling-down` forever — the "silently stops being
    // watched" outcome the field's own contract warns about. The second spawn is the proof it does
    // not: it can only happen if the stamp stayed put.
    await babysitSweepProject(PROJECT, exitSeen + 31 * 60_000, CONFIG);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("a DEAD lease cools down on the SHORT clock — but it is a clock, not zero", async () => {
    const at = await dispatchOnce();
    // Sparkle restarted and every PTY died. `held-dead` deliberately falls through `driver-alive`,
    // so with no clocks at all this PR re-dispatches on EVERY sweep — the crash loop
    // `BABYSIT_RECOVERY_COOLDOWN_MS` exists to slow.
    wireInvoke({ leases: held("dead-epoch") });
    const exitSeen = at + 60_000;
    const held1 = await babysitSweepProject(PROJECT, exitSeen, CONFIG);
    expect(held1.holds["cooling-down"]).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Six minutes on — past the 5-minute recovery clock, nowhere near the 30-minute normal one, so
    // this asserts the SHORT clock specifically rather than either "no cooldown" or "the long one".
    await babysitSweepProject(PROJECT, exitSeen + 6 * 60_000, CONFIG);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("an UNREADABLE lease store never manufactures an exit out of ignorance", async () => {
    const at = await dispatchOnce();
    wireInvoke({ leases: undefined });
    const out = await babysitSweepProject(PROJECT, at + 60_000, CONFIG);
    expect(out.holds["lease-unknown"]).toBe(1);

    // The exit edge SURVIVES the sweep that could not look. Read this one 31 minutes after the
    // dispatch, past the normal cooldown, so the dispatch clock alone would permit a second driver:
    // the hold can only come from the exit still being observable. Had `unknown` consumed `sawLive`,
    // no exit would ever be stamped and this sweep spawns.
    wireInvoke({ leases: [] });
    const seen = await babysitSweepProject(PROJECT, at + 31 * 60_000, CONFIG);
    expect(seen.holds["cooling-down"]).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

// ── THE TWO GUARDS IN THE TICK (roborev 58515) ──────────────────────────────────────────────────
//
// Both were added unpinned: every other test drives `babysitSweepProject` directly, so deleting
// `if (!deps.ownsProject(...)) continue;` — or the in-flight guard — left the whole suite green.
// The ownership gate is the more dangerous of the two, because a wrong election SUBTRACTS sweeps
// and reads as "the feature quietly does nothing", which no assertion would otherwise notice.
describe("sweepAllProjects — the single-owner election", () => {
  const projectB = { id: "p2", name: "other", rootPath: "/repo2" } as unknown as Project;

  it("SKIPS a project this window does not own, and sweeps the one it does", async () => {
    wireInvoke({ leases: [], gate: { applicable: false, probes: [], error: null, overridden: false } });
    await sweepAllProjects(CONFIG, {
      ownsProject: (id) => id === PROJECT.id,
      projects: () => [PROJECT, projectB],
      dispatchClock: () => T0,
      sweepClock: () => T0,
    });

    // The unowned project is never even listed — one `fetchOpenPrs`, for the owned one only.
    expect(fetchOpenPrsMock).toHaveBeenCalledTimes(1);
    expect(fetchOpenPrsMock.mock.calls[0]?.[0]).toBe(PROJECT.rootPath);
  });

  it("sweeps BOTH when this window owns both — the gate is a filter, not an off switch", async () => {
    wireInvoke({ leases: [], gate: { applicable: false, probes: [], error: null, overridden: false } });
    await sweepAllProjects(CONFIG, {
      ownsProject: () => true,
      projects: () => [PROJECT, projectB],
      dispatchClock: () => T0,
      sweepClock: () => T0,
    });
    expect(fetchOpenPrsMock).toHaveBeenCalledTimes(2);
  });
});

// ── THE ABANDONED SWEEP MUST STOP WRITING (roborev 58525) ───────────────────────────────────────
//
// The deadline starts a replacement sweep; it does not stop the old one. The abandoned sweep is
// still parked on an await, and when its invoke settles it resumes holding a `now` captured at
// least 12 minutes earlier. The dangerous write is `observeLease` stamping `lastDriverExitAt` with
// that ancient timestamp — on the field this module calls THE SOLE PER-PR LIMITER — so a cooldown
// that should still be owed reads as long expired and the PR is re-dispatchable a full cooldown
// early. The boolean guard this replaced made that impossible; the deadline has to come WITH a
// fence or it trades a visible stall for silent corruption.
describe("the sweep fence", () => {
  it("STOPS at the next PR once superseded, rather than writing stale state", async () => {
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(1), prWithProbe(2), prWithProbe(3)]);
    wireInvoke({ leases: [] });

    // Current for the first PR, superseded from then on.
    let calls = 0;
    const out = await babysitSweepProject(PROJECT, T0, CONFIG, () => ++calls <= 1);

    expect(out.abandoned).toBe(true);
    // Exactly ONE probe-gate read: PR 1's. PRs 2 and 3 were never touched, so nothing of theirs was
    // written with the stale clock.
    const gateReads = invokeMock.mock.calls.filter((c) => c[0] === KNIGHTWATCH_PROBE_GATE_COMMAND);
    expect(gateReads).toHaveLength(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("STOPS after the await that actually wedges — not just before it", async () => {
    // THE CHECK THAT MATTERS. The sweep that gets abandoned is the one parked INSIDE the loop on the
    // probe-gate read; it passed the top-of-iteration fence long before the deadline. A fence checked
    // only there covers PRs 2..N of an abandoned sweep and misses the single PR it was written for.
    //
    // First sweep normally, so the two-observation rule is satisfied and the second sweep WOULD
    // dispatch. Then supersede it after the probe read: call 1 is the top fence (still current),
    // call 2 is the post-await one.
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(spawnMock).not.toHaveBeenCalled();

    let calls = 0;
    const out = await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG, () => ++calls <= 1);

    expect(out.abandoned).toBe(true);
    // Without the post-await fence this sweep reaches the decision and dispatches with its stale
    // clock — which is precisely the corruption the fence exists to stop.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("STILL charges the budget and records the driver when superseded AFTER the spawn", async () => {
    // A dispatch that actually happened is a FACT, not a stale clock. Fencing its accounting off was
    // strictly permissive: the driver was never charged against the hourly ceiling, and `sawLive` was
    // never set — so the exit edge never fired and the PR came back re-dispatchable with NO cooldown,
    // the crash loop the recovery clock exists to slow (roborev 58537).
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);

    // Current through the top fence AND the post-probe fence; superseded only after dispatchOne.
    let calls = 0;
    const out = await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG, () => ++calls <= 2);

    expect(out.dispatched).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // THE SIDE EFFECT THAT WAS BEING DROPPED: `sawLive` was set, so the next sweep sees the exit
    // edge and the PR is cooling down rather than immediately re-dispatchable.
    const next = await babysitSweepProject(PROJECT, T0 + 120_000, CONFIG);
    expect(next.holds["cooling-down"]).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("the dispatch is CHARGED against the hourly ceiling — not merely reported", async () => {
    // Probe 2 on #1266: the test above passes even if only the `recentDispatchAt` write is removed,
    // because it asserts dispatch reporting and `sawLive`/cooldown but never the budget. This is the
    // assertion that pins the accounting: spend the whole hourly ceiling across distinct PRs, then
    // prove the next one is refused for `rate-limited` specifically. Without the append, the counter
    // never grows and the ceiling can never be reached.
    const N = CONFIG.maxDispatchesPerHour;
    let t = T0;
    for (let i = 0; i < N; i++) {
      fetchOpenPrsMock.mockResolvedValue([prWithProbe(9000 + i)]);
      wireInvoke({ leases: [] });
      await babysitSweepProject(PROJECT, t, CONFIG);
      await babysitSweepProject(PROJECT, t + 1000, CONFIG);
      t += 5000;
    }
    expect(spawnMock).toHaveBeenCalledTimes(N);

    // One more distinct PR, still inside the hour: the ceiling is spent.
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(9999)]);
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, t, CONFIG);
    const over = await babysitSweepProject(PROJECT, t + 1000, CONFIG);

    expect(over.holds["rate-limited"]).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(N);
  });

  it("files the budget entry under WHEN THE DISPATCH HAPPENED, not the sweep's start", async () => {
    // Probe 1 on #1266. `now` is captured once at the top of a sweep, which is right for every
    // decision but wrong for the budget: a sweep that wedged for 12+ minutes and then dispatched
    // would file the entry under its ANCIENT start time, so it ages out of the one-hour window early
    // and permits an extra Claude session in the hour.
    //
    // Drive the two apart: sweeps judge at T0, but the dispatches actually happen 59 minutes later.
    const N = CONFIG.maxDispatchesPerHour;
    const LATE = T0 + 59 * 60_000;
    for (let i = 0; i < N; i++) {
      fetchOpenPrsMock.mockResolvedValue([prWithProbe(8000 + i)]);
      wireInvoke({ leases: [] });
      await babysitSweepProject(PROJECT, T0, CONFIG, () => true, () => LATE);
      await babysitSweepProject(PROJECT, T0 + 1000, CONFIG, () => true, () => LATE);
    }
    expect(spawnMock).toHaveBeenCalledTimes(N);

    // At T0+61min, entries filed under T0 would have aged out and this would dispatch. Filed under
    // LATE they are still inside the hour, so the ceiling holds.
    const AFTER = T0 + 61 * 60_000;
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(8999)]);
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, AFTER, CONFIG, () => true, () => AFTER);
    const over = await babysitSweepProject(PROJECT, AFTER + 1000, CONFIG, () => true, () => AFTER);

    expect(over.holds["rate-limited"]).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(N);
  });

  it("runs every PR to completion while it is still current", async () => {
    // The paired direction: without it, a fence that always reported "superseded" would pass above.
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(1), prWithProbe(2), prWithProbe(3)]);
    wireInvoke({ leases: [] });

    const out = await babysitSweepProject(PROJECT, T0, CONFIG, () => true);

    expect(out.abandoned).toBeUndefined();
    expect(invokeMock.mock.calls.filter((c) => c[0] === KNIGHTWATCH_PROBE_GATE_COMMAND)).toHaveLength(3);
  });
});

describe("the abandon deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips while a sweep is young, and ABANDONS one past the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    useProjectStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id });
    // A sweep that never settles — the wedge this deadline exists for.
    fetchOpenPrsMock.mockImplementation(() => new Promise(() => {}));

    const stop = startBabysitDispatcher();
    await Promise.resolve();
    expect(fetchOpenPrsMock).toHaveBeenCalledTimes(1);

    // One period later the first sweep is still wedged and young: SKIPPED, no second sweep.
    vi.setSystemTime(T0 + BABYSIT_SWEEP_MS);
    await vi.advanceTimersByTimeAsync(BABYSIT_SWEEP_MS);
    expect(fetchOpenPrsMock).toHaveBeenCalledTimes(1);

    // Past the deadline the wedged sweep is abandoned and a fresh one starts.
    //
    // A LITERAL 13 MINUTES, deliberately, not `BABYSIT_SWEEP_ABANDON_MS`. Deriving the clock from
    // the constant under test makes the assertion scale WITH the mutation: widening the multiplier
    // from 4 to 4000 left this green, because the test moved its own goalposts. 13 min is just past
    // the documented 4 x 180 s and is what actually pins the value.
    vi.setSystemTime(T0 + 13 * 60_000);
    await vi.advanceTimersByTimeAsync(BABYSIT_SWEEP_MS);
    expect(fetchOpenPrsMock).toHaveBeenCalledTimes(2);
    // And the constant itself is what the code uses, stated once so the literal above is anchored.
    expect(BABYSIT_SWEEP_ABANDON_MS).toBe(4 * BABYSIT_SWEEP_MS);

    stop();
  });
});

// ── THE PRODUCTION CLOCK WIRING (roborev 58566) ─────────────────────────────────────────────────
//
// `dispatchClock` defaults to the sweep's `now`, so the whole fix lives in ONE argument at the
// `sweepAllProjects` call site — and deleting it silently restores the bug (budget entries filed
// under a wedged sweep's ancient start time) with every test green, because each other test injects
// its own clock straight into `babysitSweepProject` and never touches the seam.
describe("sweepAllProjects — the dispatch clock reaches the sweep", () => {
  it("passes its deps' dispatchClock through, so the budget is filed under the REAL time", async () => {
    const LATE = T0 + 59 * 60_000;
    const N = CONFIG.maxDispatchesPerHour;

    // Spend the ceiling through sweepAllProjects, with sweeps judging at "now" but dispatches
    // happening 59 minutes later. If the seam is not wired, entries land under the sweep clock.
    for (let i = 0; i < N; i++) {
      fetchOpenPrsMock.mockResolvedValue([prWithProbe(7000 + i)]);
      wireInvoke({ leases: [] });
      // The two clocks are DISTINCT on purpose: sweeps judge at T0, dispatches happen 59 min later.
      const deps = {
        ownsProject: () => true,
        projects: () => [PROJECT],
        dispatchClock: () => LATE,
        sweepClock: () => T0,
      };
      await sweepAllProjects(CONFIG, deps);
      await sweepAllProjects(CONFIG, deps);
    }
    expect(spawnMock).toHaveBeenCalledTimes(N);

    // Real time is now past the hour relative to T0 but NOT relative to LATE, so a correctly-wired
    // seam still refuses. Driven through babysitSweepProject with the same late clock so only the
    // stored entries' timestamps decide the outcome.
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(7999)]);
    wireInvoke({ leases: [] });
    const AFTER = T0 + 61 * 60_000;
    await babysitSweepProject(PROJECT, AFTER, CONFIG, () => true, () => AFTER);
    const over = await babysitSweepProject(PROJECT, AFTER + 1000, CONFIG, () => true, () => AFTER);

    expect(over.holds["rate-limited"]).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(N);
  });
});

// ── THE KILL SWITCH (bead sparkle-4cd0x follow-up) ──────────────────────────────────────────────
//
// `resolveBabysitConfig({}).enabled` is true, and `startBabysitDispatcher` used to be called with no
// argument at all — so the decision core's `disabled` hold was UNREACHABLE in production and the
// only way to stop a loop that spends a full Claude session per dispatch was to ship a new build.
// These assert the switch on the SIDE EFFECT (did the sweep touch the network), not on the config
// object, because a config-shape assertion would have passed the whole time it was unreachable.
describe("startBabysitDispatcher — the kill switch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enabled: false performs NO sweep — not even the immediate one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    useProjectStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id });
    wireInvoke({ leases: [] });

    const stop = startBabysitDispatcher({ enabled: false });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(BABYSIT_SWEEP_MS * 3);

    // No PR listing, no probe read, no spawn. The loop is genuinely off, not merely quiet.
    expect(fetchOpenPrsMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    stop();
  });

  it("the DEFAULT still sweeps — the switch is a switch, not a deletion", async () => {
    // The paired direction. Without it, breaking the dispatcher entirely also passes the test above.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    useProjectStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id });
    wireInvoke({ leases: [], gate: { applicable: false, probes: [], error: null, overridden: false } });

    const stop = startBabysitDispatcher();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchOpenPrsMock).toHaveBeenCalled();
    stop();
  });
});
