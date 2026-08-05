// THE SWEEP THAT STARTS `/babysit-pr` BY ITSELF — and the two things it must never do.
//
// It must never dispatch TWO drivers for one PR (two overlapping passes replying to the same
// comments, published to a human's pull request), and it must never dispatch on a schedule rather
// than on evidence (an agent per PR per sweep burns the fleet). Both are asserted here against the
// SIDE EFFECT — whether a spawn happened, whether a lease was released — never against a
// precondition, because a precondition assertion would have passed before this module existed.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();
const spawnMock = vi.fn();
const fetchOpenPrsMock = vi.fn();
const capacityMock = vi.fn(() => ({ atCapacity: false, used: 0, limit: 8, basis: "test" }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("./buildAgentSpawn", () => ({ spawnBuildAgentInProject: (...a: unknown[]) => spawnMock(...a) }));
vi.mock("./agentCapacity", () => ({ localAgentCapacity: () => capacityMock() }));
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
  babysitSweepProject,
  checkRollupOf,
  readProbeGate,
  repoSlugFromPrUrl,
  standingFor,
} from "./babysitDispatcher";
import { resolveBabysitConfig } from "@sparkle/core";
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
    });

    // The unowned project is never even listed — one `fetchOpenPrs`, for the owned one only.
    expect(fetchOpenPrsMock).toHaveBeenCalledTimes(1);
    expect(fetchOpenPrsMock.mock.calls[0]?.[0]).toBe(PROJECT.rootPath);
  });

  it("sweeps BOTH when this window owns both — the gate is a filter, not an off switch", async () => {
    wireInvoke({ leases: [], gate: { applicable: false, probes: [], error: null, overridden: false } });
    await sweepAllProjects(CONFIG, { ownsProject: () => true, projects: () => [PROJECT, projectB] });
    expect(fetchOpenPrsMock).toHaveBeenCalledTimes(2);
  });
});
