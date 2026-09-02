// THE SWEEP THAT STARTS `/babysit-pr` BY ITSELF — and the two things it must never do.
//
// It must never dispatch TWO drivers for one PR (two overlapping passes replying to the same
// comments, published to a human's pull request), and it must never dispatch on a schedule rather
// than on evidence (an agent per PR per sweep burns the fleet). Both are asserted here against the
// SIDE EFFECT — whether a spawn happened, whether a lease was released — never against a
// precondition, because a precondition assertion would have passed before this module existed.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const invokeMock = vi.fn();
const spawnMock = vi.fn();
const fetchOpenPrsMock = vi.fn();
const capacityMock = vi.fn(() => ({ atCapacity: false, used: 0, limit: 8, basis: "test" }));
const logInfoMock = vi.fn();
const logDebugMock = vi.fn();
// Capturable, not `vi.fn()` inline: a lease refused for a reason OTHER than `held-live` is a bug in
// this module's own arguments, and "it was reported at warn, naming the reason" is the assertion —
// the previous silent `return null` is what hid a total outage (sparkle-2hsrlz).
const logWarnMock = vi.fn();
// Capturable for the same reason `logWarnMock` is, and it is a SEPARATE mock on purpose: a
// malformed call and an unreadable store are opposite instructions to this sweep (never retry vs.
// retry next tick), so "it was reported" is not the assertion — WHICH STREAM it was reported on is
// (sparkle-nlxgd2, sparkle-wb5pqe). Folding them into one mock is what let one word carry both.
const logErrorMock = vi.fn();

// The logger is mocked so the sweep rollup's LEVEL is assertable. `logger.ts` does not forward
// DEBUG to the persistent log in production, so "which hold fired" is only answerable if this line
// is info — see the rollup-level describe at the bottom of this file for what that cost once.
vi.mock("../logger", () => ({
  log: {
    info: (...a: unknown[]) => logInfoMock(...a),
    debug: (...a: unknown[]) => logDebugMock(...a),
    warn: (...a: unknown[]) => logWarnMock(...a),
    error: (...a: unknown[]) => logErrorMock(...a),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("./buildAgentSpawn", () => ({ spawnBuildAgentInProject: (...a: unknown[]) => spawnMock(...a) }));
vi.mock("./agentCapacity", () => ({ localAgentCapacity: () => capacityMock() }));
// The production tick reads the real store and the real window-ownership election; both are
// stubbed so the deadline test can drive `startBabysitDispatcher` itself.
// `processAliveFor` is passed through REAL, not stubbed. It is the shared tri-state liveness
// answer the duplicate-spawn fix turns on, and a stub here would let the guard pass against a
// predicate this file invented — the vacuity shape AGENTS.md names. Only the window-ownership
// election is replaced, because the production tick reads a real store.
vi.mock("./goalContinuationRunner", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, ownsProjectInThisWindow: () => true };
});
vi.mock("./openPrs", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, fetchOpenPrs: (...a: unknown[]) => fetchOpenPrsMock(...a) };
});

import {
  BABYSIT_HOLDER_ID_MAX_LEN,
  BABYSIT_LEASE_ACQUIRE_COMMAND,
  BABYSIT_LEASE_HEARTBEAT_COMMAND,
  BABYSIT_LEASE_LIST_COMMAND,
  BABYSIT_LEASE_REASON_HELD_LIVE,
  BABYSIT_LEASE_REASON_INVALID,
  BABYSIT_LEASE_REASON_UNKNOWN,
  BABYSIT_LEASE_RELEASE_COMMAND,
  mintDispatchHolderId,
  _resetBabysitDispatcherForTests,
  babysitPrompt,
  sweepAllProjects,
  startBabysitDispatcher,
  BABYSIT_REFUSAL_STREAK_WEDGED,
  BABYSIT_SWEEP_ABANDON_MS,
  BABYSIT_SWEEP_MS,
  babysitSweepProject,
  checkRollupOf,
  repoSlugFromPrUrl,
  standingFor,
  driverSightingFor,
  isBabysitDriverFor,
  BABYSIT_UNOBSERVED_HOLD_MS,
  NO_DRIVER_SIGHTED,
} from "./babysitDispatcher";
// The ONE command constant lives with the ONE adapter that uses it.
import { KNIGHTWATCH_PROBE_GATE_COMMAND, readProbeGate } from "./probeGate";
import { log } from "../logger";
import { resolveBabysitConfig } from "@sparkle/core";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTab, Project } from "../types";

// `agents: []` is REQUIRED on the fixture, not defaulted away in the source. Project.agents is a
// required field and every production path supplies it, so a `?? []` in the sweep would exist
// only to serve this fixture — and would silently resolve "nobody supplied a roster" to the
// PERMISSIVE verdict, which is backwards for this module: conservative here means HOLD.
const PROJECT = { id: "p1", name: "sparkle", rootPath: "/repo", agents: [] } as unknown as Project;
const T0 = 1_700_000_000_000;
const REPO = "drodio/sparkle";
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
/**
 * `ProbeGate::unknown("boom")` EXACTLY as serde puts it on the wire.
 *
 * Every `Option::None` on the Rust struct is `null`, not an absent field — there is no
 * `skip_serializing_if` on `ProbeGate`. Building the fixture by hand with `undefined` is how the
 * null path stayed untested through several passes over this file.
 */
function unknownGateOnTheWire() {
  return {
    applicable: true,
    probes: null,
    error: "boom",
    overridden: false,
    reviewedHead: null,
    reviewStale: false,
  };
}

function wireInvoke(opts: {
  gate?: unknown;
  leases?: unknown[];
  acquired?: boolean;
  acquireThrows?: boolean;
  /** The Rust `AcquireOutcome.reason`. Crosses the wire as `null` when acquired, never absent. */
  acquireReason?: string | null;
  /** The Rust `AcquireOutcome.detail`. Same null-not-absent rule. */
  acquireDetail?: string | null;
  /** The project's `[review]` table. Omitted = the shipped default: a reviewer, key NOT armed. */
  review?: { pr_reviewer?: string; require_review?: boolean };
  /** Make `get_config` throw, so the fail-closed path in `readReviewPolicy` is drivable. */
  configThrows?: boolean;
}): void {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_config") {
      if (opts.configThrows) throw new Error("config unreadable");
      return {
        config: { review: opts.review ?? { pr_reviewer: "sparkle-reviewer", require_review: false } },
        warnings: [],
      };
    }
    if (cmd === BABYSIT_LEASE_LIST_COMMAND) {
      if (opts.leases === undefined) throw new Error("unreadable");
      return opts.leases;
    }
    if (cmd === KNIGHTWATCH_PROBE_GATE_COMMAND) return opts.gate ?? gateWithUnansweredBlocking();
    if (cmd === BABYSIT_LEASE_ACQUIRE_COMMAND) {
      if (opts.acquireThrows) throw new Error("bridge down");
      const acquired = opts.acquired ?? true;
      return {
        acquired,
        reason: acquired ? null : (opts.acquireReason ?? BABYSIT_LEASE_REASON_HELD_LIVE),
        detail: opts.acquireDetail ?? null,
      };
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
  logInfoMock.mockReset();
  logDebugMock.mockReset();
  logWarnMock.mockReset();
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
  const projectB = { id: "p2", name: "other", rootPath: "/repo2", agents: [] } as unknown as Project;

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

// ── THE HOLD ROLLUP MUST REACH THE PERSISTENT LOG ───────────────────────────────────────────────
//
// ── A PERMANENTLY REFUSED PR IS NOT A DECISION (the streak) ─────────────────────────────────────
//
// `lease-lost-or-spawn-refused` lands in the same `holds` map as every deliberate hold, so ONE of
// them and a THOUSAND of them render identically in the rollup. Measured on the founder's machine:
// one PR held at that reason on every sweep for over two days — ~58 consecutive identical INFO
// lines at the 180 s cadence — dispatching nothing and escalating nothing.
//
// Every assertion below is on the OUTCOME/side effect (`wedged`, which mock received a call), never
// on the streak field itself: `refusalStreak` is module-private state, and a test that read it back
// would pass for a counter wired to nothing.
describe("consecutive refusals — one is contention, a run of them is wedged", () => {
  /** Sweeps that all decide to dispatch and all get refused. The FIRST sweep is the two-observation
   *  hold, so `n` refusals needs `n + 1` sweeps. Returns the last sweep's outcome. */
  async function refuse(n: number, startAt = T0) {
    wireInvoke({ leases: [], acquired: false });
    let out = await babysitSweepProject(PROJECT, startAt, CONFIG);
    for (let i = 1; i <= n; i += 1) {
      out = await babysitSweepProject(PROJECT, startAt + i * 60_000, CONFIG);
    }
    return out;
  }

  it("stays QUIET below the threshold — a lost acquire race is what the compare-and-set is for", async () => {
    logWarnMock.mockClear();
    const out = await refuse(BABYSIT_REFUSAL_STREAK_WEDGED - 1);

    // The refusals really did happen — without this the test would pass on a sweep that never ran.
    expect(out.holds["lease-lost-or-spawn-refused"]).toBe(1);
    expect(out.wedged).toBe(0);
    expect(logWarnMock.mock.calls.filter((c) => c[1] === "a PR keeps being chosen for a driver and keeps not getting one")).toHaveLength(0);
  });

  it("reports WEDGED and warns once when the run reaches the threshold", async () => {
    logWarnMock.mockClear();
    const out = await refuse(BABYSIT_REFUSAL_STREAK_WEDGED);

    expect(out.wedged).toBe(1);
    const warns = logWarnMock.mock.calls.filter((c) => c[1] === "a PR keeps being chosen for a driver and keeps not getting one");
    expect(warns).toHaveLength(1);
    // It has to name WHICH PR, or the warn is no more actionable than the info line it replaces.
    expect(warns[0]?.[2]).toMatchObject({
      repo: "drodio/sparkle",
      pr: 1251,
      consecutiveRefusals: BABYSIT_REFUSAL_STREAK_WEDGED,
    });
  });

  it("does NOT re-warn every sweep once wedged, but keeps COUNTING it", async () => {
    logWarnMock.mockClear();
    // A few sweeps past the threshold, still well short of the re-warn interval.
    const out = await refuse(BABYSIT_REFUSAL_STREAK_WEDGED + 3);

    // Still visible in the summary a human reads, every single sweep...
    expect(out.wedged).toBe(1);
    // ...but the warn fired once, not four times. A line that repeats forever reads as background
    // noise — that is the 143-warns-a-day failure this file's rollup describe records.
    expect(logWarnMock.mock.calls.filter((c) => c[1] === "a PR keeps being chosen for a driver and keeps not getting one")).toHaveLength(1);
  });

  // NOT "the dispatch branch resets the counter" — that reset was written, MUTATION-TESTED, and
  // deleted as unreachable: the sweep after a dispatch always holds first, so the hold branch has
  // already zeroed the streak. What is asserted here is the CAPABILITY, which is real and which
  // no other test covers: a PR that was just given a driver must never be reported wedged.
  it("a PR THAT WAS JUST GIVEN A DRIVER is never reported wedged", async () => {
    await refuse(BABYSIT_REFUSAL_STREAK_WEDGED - 1);

    // The acquire succeeds: a real driver exists, so the run is broken.
    wireInvoke({ leases: [], acquired: true });
    const dispatched = await babysitSweepProject(PROJECT, T0 + BABYSIT_REFUSAL_STREAK_WEDGED * 60_000, CONFIG);
    expect(dispatched.dispatched).toHaveLength(1);

    // Past the recovery cooldown, so the next sweep genuinely re-decides to dispatch. The sweep at
    // +45m takes the exit edge and holds `cooling-down`; the one at +90m is the refusal.
    wireInvoke({ leases: [], acquired: false });
    await babysitSweepProject(PROJECT, T0 + 45 * 60_000, CONFIG);
    const after = await babysitSweepProject(PROJECT, T0 + 90 * 60_000, CONFIG);

    expect(after.holds["lease-lost-or-spawn-refused"]).toBe(1);
    // Without the reset this is the 5th refusal and reports wedged — which would tell a human a PR
    // is stuck when a driver was dispatched for it minutes ago.
    expect(after.wedged).toBe(0);
  });

  it("a sweep that DECIDED NOT TO DISPATCH breaks the run too — the count is consecutive", async () => {
    await refuse(BABYSIT_REFUSAL_STREAK_WEDGED - 1);

    // An unreadable lease store: judged, held, no dispatch attempted — so not a refusal.
    wireInvoke({ leases: undefined });
    const held = await babysitSweepProject(PROJECT, T0 + BABYSIT_REFUSAL_STREAK_WEDGED * 60_000, CONFIG);
    expect(held.holds["lease-unknown"]).toBe(1);

    wireInvoke({ leases: [], acquired: false });
    const after = await babysitSweepProject(PROJECT, T0 + (BABYSIT_REFUSAL_STREAK_WEDGED + 1) * 60_000, CONFIG);

    expect(after.holds["lease-lost-or-spawn-refused"]).toBe(1);
    expect(after.wedged).toBe(0);
  });
});

// The rollup LEVEL, for the same reason the describe below pins the info level: a wedged sweep that
// reports at `info` is indistinguishable from a quiet one that decided to leave things alone, which
// is exactly how the measured two-day stall stayed invisible.
describe("sweepAllProjects — a WEDGED sweep is promoted out of info", () => {
  it("emits the rollup at warn, with the wedged count, once a PR is stuck", async () => {
    logWarnMock.mockClear();
    wireInvoke({ leases: [], acquired: false });

    for (let i = 0; i <= BABYSIT_REFUSAL_STREAK_WEDGED; i += 1) {
      const at = T0 + i * BABYSIT_SWEEP_MS;
      await sweepAllProjects(CONFIG, {
        ownsProject: () => true,
        projects: () => [PROJECT],
        dispatchClock: () => at,
        sweepClock: () => at,
      });
    }

    const warned = logWarnMock.mock.calls.filter((c) => c[0] === "babysit" && c[1] === "sweep could not dispatch a PR it keeps choosing");
    expect(warned).toHaveLength(1);
    expect((warned[0]?.[2] as { wedged: number }).wedged).toBe(1);

    // The half that makes this non-vacuous: at `info` the assertion above would be empty and the
    // wedged sweep would sit in the same bucket as the quiet ones.
    const quiet = logInfoMock.mock.calls.filter((c) => c[0] === "babysit" && c[1] === "sweep");
    expect(quiet.every((c) => (c[2] as { wedged: number }).wedged === 0)).toBe(true);
  });
});

// This asserts a LEVEL, which is unusual, so here is why it earns a test. The rollup is the only
// record of WHICH hold fired. `logger.ts` skips forwarding DEBUG to disk in production builds, so
// while this line was `log.debug` the answer to "why has nothing dispatched?" existed only in a
// devtools console nobody had open.
//
// It cost a full day. The shipped build threw out of every sweep and dispatched nothing; the sole
// evidence was 128 identical per-project catch WARNs that named the throw but never the decision.
// The module header calls silence this system's most likely failure — a rollup that cannot be read
// in the shipped build is that silence.
//
// Asserted against the SIDE EFFECT (which mock received the call), not against a precondition: a
// test that merely checked "a rollup was emitted" passes identically at either level and would have
// proven nothing.
describe("sweepAllProjects — the hold rollup is INFO, so it survives to the log file", () => {
  it("emits the rollup at info and NOT at debug", async () => {
    wireInvoke({ leases: [] });
    fetchOpenPrsMock.mockResolvedValue([prWithProbe()]);

    // One sweep: the two-observation rule holds it at `single-observation`, which is exactly the
    // shape whose invisibility this pins — a hold, no dispatch, and nothing else to see.
    await sweepAllProjects(CONFIG, {
      ownsProject: () => true,
      projects: () => [PROJECT],
      dispatchClock: () => T0,
      sweepClock: () => T0,
    });

    const rollups = logInfoMock.mock.calls.filter((c) => c[0] === "babysit" && c[1] === "sweep");
    expect(rollups).toHaveLength(1);
    expect((rollups[0]?.[2] as { holds: Record<string, number> }).holds["single-observation"]).toBe(1);

    // The half that makes this non-vacuous: at `log.debug` the assertion above would be empty and
    // this one would hold the call instead.
    expect(logDebugMock.mock.calls.filter((c) => c[0] === "babysit" && c[1] === "sweep")).toHaveLength(0);
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

    // Current through ALL THREE checkpoints — top of loop, post-probe-read, and the one inside
    // dispatchOne after the acquire — so the supersession lands only once the agent exists. That
    // third checkpoint is the #1298 probe-1 fix; before it there were two, and this counter said 2.
    let calls = 0;
    const out = await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG, () => ++calls <= 3);

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

// END-TO-END for the trigger that re-arms the gate: the sweep must turn a PR whose head has outrun
// knightwatch into a real dispatch, and must NOT invent one from a head it could not read.
describe("commits pushed since the last review — through the whole sweep", () => {
  const HEAD = `4d3030a${"1".repeat(33)}`;

  /** A green, probe-free PR at `HEAD` — nothing to dispatch on EXCEPT review coverage. */
  function greenPr(headRefOid: string | undefined = HEAD) {
    return { ...prWithProbe(1273), headRefOid };
  }

  /** A gate with no probes at all, whose newest review read `reviewedHead`. */
  function coverage(reviewedHead: string | undefined, reviewStale = false) {
    return { applicable: true, probes: [], error: null, overridden: false, reviewedHead, reviewStale };
  }

  it("dispatches when the head has moved past what the newest review read", async () => {
    fetchOpenPrsMock.mockResolvedValue([greenPr()]);
    // knightwatch read 9c65efe; the head is now 4d3030a. #1273, exactly.
    wireInvoke({ leases: [], gate: coverage("9c65efe") });

    const out = await sweepTwice();

    expect(out.dispatched).toEqual([{ repo: "drodio/sparkle", pr: 1273, agentId: "agent-1" }]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("survives `reviewedHead: null` on the wire — a lifecycle post must not abort the sweep", async () => {
    // knightwatch #1317 probe 1, the second half. `reviewed_head: None` is a NORMAL successful
    // reading — a PR whose newest knightwatch comment is a `👀 reviewing` lifecycle post, or whose
    // status form the parser does not recognise, produces it — and serde writes it as `null`.
    // The core tests `reviewedHead !== undefined && reviewedHead.length > 0`, and `null !==
    // undefined` is TRUE, so an unnormalised `null` THROWS on `.length`, out of the per-PR loop and
    // through the whole project's sweep. Every fixture above passes `undefined`, which cannot.
    fetchOpenPrsMock.mockResolvedValue([greenPr()]);
    wireInvoke({
      leases: [],
      gate: { applicable: true, probes: [], error: null, overridden: false, reviewedHead: null, reviewStale: false },
    });

    const out = await sweepTwice();

    // No coverage claim can be made from an unknown, so nothing is dispatched — but the sweep must
    // REACH that verdict rather than dying on the way to it.
    expect(out.holds["no-evidence"]).toBe(1);
    expect(out.dispatched).toHaveLength(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when the review covers the head — the healthy steady state", async () => {
    fetchOpenPrsMock.mockResolvedValue([greenPr()]);
    wireInvoke({ leases: [], gate: coverage(HEAD.slice(0, 7)) });

    const out = await sweepTwice();

    expect(out.dispatched).toHaveLength(0);
    expect(out.holds["no-evidence"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("dispatches on the ⚠️ Stale self-label even though the sha matches", async () => {
    fetchOpenPrsMock.mockResolvedValue([greenPr()]);
    wireInvoke({ leases: [], gate: coverage(HEAD.slice(0, 7), true) });

    expect((await sweepTwice()).dispatched).toHaveLength(1);
  });

  it("an EMPTY headRefOid never manufactures a dispatch", async () => {
    // The Rust decoder fills this field with `str_field`, so an absent oid arrives as "" rather than
    // as absent. Passed through unmapped it would clear the core's `headSha !== undefined` guard and
    // then fail every prefix test — inventing "unreviewed" for a PR whose head we could not read.
    fetchOpenPrsMock.mockResolvedValue([greenPr("")]);
    wireInvoke({ leases: [], gate: coverage("9c65efe") });

    const out = await sweepTwice();

    expect(out.dispatched).toHaveLength(0);
    expect(out.holds["no-evidence"]).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("a lifecycle repost that names no head never manufactures a dispatch", async () => {
    // The repost storm: `⏸ knightwatch paused` carries the marker, names no sha, reposts every ~2
    // minutes. Coverage UNKNOWN must stay a hold, however many sweeps see it.
    fetchOpenPrsMock.mockResolvedValue([greenPr()]);
    wireInvoke({ leases: [], gate: coverage(undefined) });

    for (let i = 0; i < 6; i += 1) {
      await babysitSweepProject(PROJECT, T0 + i * 60_000, CONFIG);
    }
    expect(spawnMock).not.toHaveBeenCalled();
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

// ── STOPPING MUST CANCEL THE SWEEP IN FLIGHT (knightwatch #1291 probe 1) ────────────────────────
//
// Driven through `startBabysitDispatcher` and the stopper IT returns — not a hand-rolled fence —
// because the fix is the generation bump inside that stopper, and a test that supplies its own
// `isCurrent` proves nothing about it.
describe("the stopper cancels a running sweep", () => {
  it("a sweep already awaiting is fenced out by stop(), so no driver is spawned", async () => {
    useProjectStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id });
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(4001)]);

    // FIRST SIGHTING, recorded through the real path. Without it the two-observation rule alone
    // would stop the dispatch and the fence would never be the reason — which is exactly how the
    // first version of this test passed against a deleted generation bump.
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(spawnMock).not.toHaveBeenCalled();

    // Now the sweep that WOULD dispatch, parked on its probe-gate read.
    let releaseGate: (v: unknown) => void = () => {};
    let gateCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === BABYSIT_LEASE_LIST_COMMAND) return [];
      if (cmd === KNIGHTWATCH_PROBE_GATE_COMMAND) {
        gateCalls += 1;
        return new Promise((r) => {
          releaseGate = r;
        });
      }
      if (cmd === BABYSIT_LEASE_ACQUIRE_COMMAND) return { acquired: true };
      return null;
    });

    const stop = startBabysitDispatcher();
    await vi.waitFor(() => expect(gateCalls).toBe(1));

    // The user switches babysit off while that read is still outstanding.
    stop();
    releaseGate(gateWithUnansweredBlocking());
    await new Promise((r) => setTimeout(r, 0));

    // The parked sweep resumed and fenced out instead of walking on to dispatch.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("stop() DURING lease acquisition releases the lease and spawns nothing", async () => {
    // knightwatch #1298 probe 1. The acquire is an await, so stop() can land inside it. Until the
    // spawn the sweep holds nothing a caller can see — the lease is ours but NO AGENT EXISTS — so
    // standing down costs only a release. The previous version checked no further than the probe
    // read, so a stop during the acquire still produced a driver.
    useProjectStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id });
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(4003)]);
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(spawnMock).not.toHaveBeenCalled();

    let releaseAcquire: (v: unknown) => void = () => {};
    let acquireCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === BABYSIT_LEASE_LIST_COMMAND) return [];
      if (cmd === KNIGHTWATCH_PROBE_GATE_COMMAND) return gateWithUnansweredBlocking();
      if (cmd === BABYSIT_LEASE_ACQUIRE_COMMAND) {
        acquireCalls += 1;
        return new Promise((r) => {
          releaseAcquire = r;
        });
      }
      return null;
    });

    const stop = startBabysitDispatcher();
    await vi.waitFor(() => expect(acquireCalls).toBe(1));

    stop();
    releaseAcquire({ acquired: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(spawnMock).not.toHaveBeenCalled();
    // And the lease we took is given back, so the PR is not silenced until it goes stale.
    const released = invokeMock.mock.calls.filter((c) => c[0] === BABYSIT_LEASE_RELEASE_COMMAND);
    expect(released).toHaveLength(1);
  });

  it("...and WITHOUT the stop it does dispatch — the fence is the reason, not the setup", async () => {
    // The paired direction, and the one that makes the test above non-vacuous.
    useProjectStore.setState({ projects: [PROJECT], selectedProjectId: PROJECT.id });
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(4001)]);
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);

    let releaseGate: (v: unknown) => void = () => {};
    let gateCalls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === BABYSIT_LEASE_LIST_COMMAND) return [];
      if (cmd === KNIGHTWATCH_PROBE_GATE_COMMAND) {
        gateCalls += 1;
        return new Promise((r) => {
          releaseGate = r;
        });
      }
      if (cmd === BABYSIT_LEASE_ACQUIRE_COMMAND) return { acquired: true };
      return null;
    });

    const stop = startBabysitDispatcher();
    await vi.waitFor(() => expect(gateCalls).toBe(1));
    releaseGate(gateWithUnansweredBlocking());
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    stop();
  });
});

// ── THE updatedAt GATE (the probe read is the sweep's only real cost) ───────────────────────────
//
// One `knightwatch_probe_gate` per open PR per tick, each a `gh` subprocess under a 45 s timeout —
// ~200 calls/hour at ten PRs, almost all re-reading PRs that did not change. Every assertion here
// is on the SIDE EFFECT (did a probe read happen), never on cache internals.
describe("the updatedAt gate", () => {
  const gateReads = () =>
    invokeMock.mock.calls.filter((c) => c[0] === KNIGHTWATCH_PROBE_GATE_COMMAND).length;

  it("SKIPS the probe read when updatedAt is unchanged", async () => {
    fetchOpenPrsMock.mockResolvedValue([{ ...prWithProbe(5001), updatedAt: "2026-08-05T10:00:00Z" }]);
    wireInvoke({ leases: [] });

    await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(gateReads()).toBe(1);
    await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG);
    expect(gateReads()).toBe(1); // reused, not re-read
  });

  it("RE-READS when updatedAt moves — a new comment must be seen", async () => {
    fetchOpenPrsMock.mockResolvedValue([{ ...prWithProbe(5002), updatedAt: "2026-08-05T10:00:00Z" }]);
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(gateReads()).toBe(1);

    fetchOpenPrsMock.mockResolvedValue([{ ...prWithProbe(5002), updatedAt: "2026-08-05T11:00:00Z" }]);
    await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG);
    expect(gateReads()).toBe(2);
  });

  it("an ABSENT updatedAt always re-reads — two absents must not compare equal", async () => {
    // A gh that stopped returning the field would otherwise silence this PR forever.
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(5003)]); // no updatedAt
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);
    await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG);
    expect(gateReads()).toBe(2);
  });

  it("an UNKNOWN reading is never cached — one failed gh must not retire the PR", async () => {
    // THE REAL WIRE SHAPE, NOT A FABRICATED ONE (knightwatch #1317 probe 1). This used to pass
    // `probes: undefined`, which no `invoke` can ever produce: `ProbeGate` in `knightwatch.rs`
    // carries no `skip_serializing_if`, so `ProbeGate::unknown(..)` serialises `probes` as JSON
    // `null` — a PRESENT field. The old fixture therefore tested a value the boundary never sees
    // and the `!== undefined` cache test passed a `null` straight through into the cache.
    fetchOpenPrsMock.mockResolvedValue([{ ...prWithProbe(5004), updatedAt: "2026-08-05T10:00:00Z" }]);
    wireInvoke({ leases: [], gate: unknownGateOnTheWire() });
    const first = await babysitSweepProject(PROJECT, T0, CONFIG);
    expect(gateReads()).toBe(1);
    // The side effect that says the UNKNOWN survived the boundary: the core must SAY it could not
    // look. `no-evidence` here would be the same "we looked; this PR is fine" claim a failed `gh`
    // read cannot support.
    expect(first.holds["probe-read-unknown"]).toBe(1);
    expect(first.holds["no-evidence"]).toBeUndefined();
    // Same updatedAt, but the cached value would have been UNKNOWN — it must re-read anyway.
    await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG);
    expect(gateReads()).toBe(2);
  });

  it("the skip does NOT stop a dispatch — a cached gate still carries its evidence", async () => {
    // The gate exists to save a subprocess, not to change the verdict. Two sweeps, one read, and
    // the second still dispatches on the cached probe.
    fetchOpenPrsMock.mockResolvedValue([{ ...prWithProbe(5005), updatedAt: "2026-08-05T10:00:00Z" }]);
    wireInvoke({ leases: [] });
    await babysitSweepProject(PROJECT, T0, CONFIG);
    const out = await babysitSweepProject(PROJECT, T0 + 60_000, CONFIG);
    expect(gateReads()).toBe(1);
    expect(out.dispatched).toHaveLength(1);
  });
});

// ── ONE BAD PR MUST NOT STARVE THE PRs BEHIND IT ────────────────────────────────────────────────
//
// The failure this closes is NOT a crash — it is the blast radius of one. Until now the only
// `catch` was `sweepAllProjects`'s, one level up and OUTSIDE the per-PR loop, so ANY throw while
// judging a single PR abandoned that project's whole sweep: every PR behind it went unjudged, on
// every 180 s tick, for as long as the condition held. Measured on 2026-08-05/06: 143 `sweep failed
// for a project` warnings across three projects in five hours, zero dispatches ever, and nine PRs
// nobody looked at.
//
// Two causes have already been fixed one at a time (`reviewedHead: null` reading `.length` in
// `aa0ed31e`, the IPC boundary in PR #1317) and the blast radius survived both, which is the
// argument for pinning the RADIUS rather than the causes. So these tests deliberately use two
// UNRELATED throw sites: what is asserted is that the PRs behind the bad one were still judged.
describe("per-PR failure isolation", () => {
  const GOOD_A = 4001;
  const BAD = 4002;
  const GOOD_B = 4003;

  /** Route each PR its own gate, keyed on the `number` the sweep passes to the command. */
  function wirePerPr(gates: Record<number, unknown>): void {
    invokeMock.mockImplementation(async (cmd: string, args?: { number?: number }) => {
      if (cmd === BABYSIT_LEASE_LIST_COMMAND) return [];
      if (cmd === KNIGHTWATCH_PROBE_GATE_COMMAND) return gates[args?.number ?? -1];
      if (cmd === BABYSIT_LEASE_ACQUIRE_COMMAND) return { acquired: true };
      if (cmd === BABYSIT_LEASE_RELEASE_COMMAND) return null;
      throw new Error(`unexpected command ${cmd}`);
    });
  }

  /**
   * A gate that PASSES the adapter's validation and throws afterwards — the only fault shape that
   * still reaches the sweep.
   *
   * This used to be `probes: [null]`, chosen because no fix addressed it. `readProbeGate` now
   * validates probe ELEMENTS, so that reply is normalised to the UNKNOWN reading at the boundary
   * and never throws again: the fixture stopped injecting a fault and the two assertions below —
   * `failed`, and the summary line that is emitted only when `failed > 0` — silently stopped being
   * about isolation at all. The radius is what these tests pin, so the injection has to move ahead
   * of the newest guard rather than be deleted with it.
   *
   * `severity` reads clean ONCE (that is `isProbeList`, which short-circuits on the first spelling)
   * and throws on every read after it — which is the filter inside the judgement, past every
   * boundary check. `readProbeGate` wraps its whole body in a `try`, so a value that threw any
   * EARLIER would be caught there and returned as UNKNOWN; a lazily-throwing element is what
   * survives the adapter and lands in the loop this describe block is about.
   *
   * FRESH PER READ, and that is load-bearing: `prWithProbe` carries no `updatedAt`, so the gate is
   * never cached and `sweepTwice` reads it again — a shared counter would be exhausted by the first
   * sweep, throw inside the adapter on the second, and hand the assertions the sweep whose fault
   * never fired.
   */
  function gateThatThrowsAfterValidation(): unknown {
    let severityReads = 0;
    return {
      applicable: true,
      probes: [
        {
          commentId: 9,
          index: 1,
          get severity(): string {
            severityReads += 1;
            if (severityReads > 1) throw new TypeError("probe reading is unreadable");
            return "blocking";
          },
          from: null,
          text: "x",
          url: "u",
          answered: false,
        },
      ],
      error: null,
      overridden: false,
      reviewedHead: null,
      reviewStale: false,
    };
  }

  it("a PR that THROWS while being judged is skipped; the PRs behind it still dispatch", async () => {
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(GOOD_A), prWithProbe(BAD), prWithProbe(GOOD_B)]);
    wirePerPr({
      [GOOD_A]: gateWithUnansweredBlocking(),
      // A reply that is well-formed to every boundary check and unreadable to the judgement — see
      // `gateThatThrowsAfterValidation`. The type also said `reviewedHead` could not be `null`, and
      // it was, three releases running; what the isolation has to survive is the NEXT cause, so the
      // fixture stays deliberately ahead of the newest guard rather than modelling a shape that
      // guard already neutralises.
      get [BAD]() {
        return gateThatThrowsAfterValidation();
      },
      [GOOD_B]: gateWithUnansweredBlocking(),
    });

    const out = await sweepTwice();

    // THE ASSERTION THAT FAILS WITHOUT THE FIX: GOOD_B — the PR sitting BEHIND the bad one — was
    // judged at all. Without per-PR isolation the throw leaves `babysitSweepProject` entirely and
    // this call rejects, so nothing behind BAD is ever reached.
    expect(out.dispatched.map((d) => d.pr)).toEqual([GOOD_A, GOOD_B]);
    expect(out.failed).toBe(1);
  });

  it("a spawn that throws is isolated too — the radius is closed, not one throw site", async () => {
    // `spawnBuildAgentInProject` reaches into three zustand stores, so it is a second, unrelated
    // throw site: what is proven is the loop's isolation, not a guard aimed at one payload.
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(BAD), prWithProbe(GOOD_B)]);
    wirePerPr({ [BAD]: gateWithUnansweredBlocking(), [GOOD_B]: gateWithUnansweredBlocking() });
    spawnMock.mockImplementation((_project: unknown, opts: { prompt: string }) => {
      if (opts.prompt === babysitPrompt(BAD)) throw new Error("addAgent blew up");
      return "agent-2";
    });

    const out = await sweepTwice();

    expect(out.failed).toBe(1);
    expect(out.dispatched).toEqual([{ repo: "drodio/sparkle", pr: GOOD_B, agentId: "agent-2" }]);
  });

  it("a spawn that throws GIVES THE LEASE BACK — a counted failure is not a held PR", async () => {
    // Only the falsy-return path released. A THROW skipped it and left the synthetic holder standing
    // for the full 90-minute stale threshold, so the PR was un-babysittable — and the per-PR
    // isolation above swallows the throw, which makes that leak silent and repeatable.
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(BAD)]);
    wirePerPr({ [BAD]: gateWithUnansweredBlocking() });
    spawnMock.mockImplementation(() => {
      throw new Error("addAgent blew up");
    });

    const out = await sweepTwice();

    expect(out.failed).toBe(1);
    // THE SIDE EFFECT, not the count: the holder acquired for this PR was handed back.
    // One release, not two: the two-observation rule means only the SECOND sweep gets as far as
    // acquiring, so exactly one holder is ever taken — and it is handed back.
    const released = invokeMock.mock.calls.filter((c) => c[0] === BABYSIT_LEASE_RELEASE_COMMAND);
    expect(released).toHaveLength(1);
    expect(released[0]?.[1]).toMatchObject({ repo: "drodio/sparkle", pr: BAD });
  });

  it("a sweep whose every PR threw still reports it, at a level a release build keeps", async () => {
    // THE SHAPE THAT EMITTED NOTHING. A project where every PR throws dispatches nothing and holds
    // nothing, so the old summary predicate (dispatched OR holds) did not match and no line was
    // written at all. Counting skips and then not reporting them would repeat, inside this fix, the
    // very defect it is for: `logger.ts` forwards `debug` only when `import.meta.env.DEV`, so a
    // release build discards it — which is how 143 failures a day went unseen.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    try {
      fetchOpenPrsMock.mockResolvedValue([prWithProbe(BAD)]);
      wirePerPr({
        get [BAD]() {
          return gateThatThrowsAfterValidation();
        },
      });

      await sweepAllProjects(CONFIG, {
        ownsProject: () => true,
        projects: () => [PROJECT],
        dispatchClock: () => Date.now(),
        sweepClock: () => Date.now(),
      });

      const summaries = warn.mock.calls.filter((c) => c[1] === "sweep skipped PRs that threw");
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]?.[2] as { failed: number } | undefined;
      expect(summary?.failed).toBe(1);
      // and it must NOT be hidden at debug, which production drops
      expect(debug.mock.calls.filter((c) => c[1] === "sweep")).toHaveLength(0);
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });
});

// ── THE BOUNDARY NORMALISES ON SHAPE, NOT ON NULLISHNESS ────────────────────────────────────────
//
// `?? undefined` defeats exactly one non-conforming value — the `null` serde writes today. The cast
// on `invoke` is unchecked, so any OTHER drift is passed through and read as AUTHORITATIVE.
describe("readProbeGate — a reply that drifted from the contract is UNKNOWN", () => {
  // Each row gives one field whose value is subsequently ITERATED or INDEXED a value of the wrong
  // SHAPE — not merely null, which is the only drift a `??` can see.
  it.each([
    { field: "probes" as const, drifted: { probes: { items: [] }, reviewedHead: null } },
    { field: "reviewedHead" as const, drifted: { probes: [], reviewedHead: 12345 } },
  ])("a `$field` of the wrong shape is UNKNOWN, not something to read", async ({ field, drifted }) => {
    invokeMock.mockResolvedValueOnce({
      applicable: true,
      error: null,
      overridden: false,
      reviewStale: false,
      ...drifted,
    });
    expect((await readProbeGate("/repo", 1))[field]).toBeUndefined();
  });

  it("an authoritative reply is passed through untouched — the guard only ever narrows", async () => {
    const probes = gateWithUnansweredBlocking().probes;
    invokeMock.mockResolvedValueOnce({
      applicable: true,
      probes,
      error: null,
      overridden: false,
      reviewedHead: "9c65efe",
      reviewStale: false,
    });
    const gate = await readProbeGate("/repo", 1);
    expect(gate.probes).toEqual(probes);
    expect(gate.reviewedHead).toBe("9c65efe");
  });

  it("through the whole sweep: a drifted reply HOLDS probe-read-unknown and never throws", async () => {
    // The discriminator between the two fixes on this branch. Without the SHAPE normalisation the
    // non-array reaches `babysitEvidenceFor`, which does `for (const probe of probes ?? [])` and
    // throws — which per-PR isolation would then record as `failed: 1`. Only the boundary fix
    // produces the honest verdict: we could not read this PR, so we hold.
    fetchOpenPrsMock.mockResolvedValue([prWithProbe(4100)]);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === BABYSIT_LEASE_LIST_COMMAND) return [];
      if (cmd === KNIGHTWATCH_PROBE_GATE_COMMAND) {
        return {
          applicable: true,
          probes: { items: [] },
          error: null,
          overridden: false,
          reviewedHead: null,
          reviewStale: false,
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const out = await babysitSweepProject(PROJECT, T0, CONFIG);

    expect(out.holds["probe-read-unknown"]).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.holds["no-evidence"]).toBeUndefined();
  });
});


// -------------------------------------------------------------------------------------------------
// The producer half of `never-reviewed` — the wiring, which is the part that was missing
// -------------------------------------------------------------------------------------------------
//
// The core owns the DECISION and is tested there. What cannot be tested there is whether this module
// ever supplies the two fields the decision reads: a snapshot that never carries them renders the
// whole feature permanently inert while every core test stays green. That is the "defaulted seam"
// shape AGENTS.md names — delete the line that supplies the real value and the suite says nothing —
// so these assertions drive the REAL sweep and read the dispatch it produces.
describe("`never-reviewed` — the sweep carries the repo's review policy into the snapshot", () => {
  /** A PR with NO review of any kind: `applicable: false` is the gate's "asked; nobody has looked". */
  function prNeverReviewed(number = 1400) {
    return {
      number,
      title: "add the thing",
      url: `https://github.com/drodio/sparkle/pull/${number}`,
      headRefOid: "c0ffee11".padEnd(40, "0"),
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
    };
  }
  const NOT_APPLICABLE = { applicable: false, probes: [], error: null, overridden: false };

  it("dispatches on an unreviewed PR when the repo has ARMED require_review", async () => {
    fetchOpenPrsMock.mockResolvedValue([prNeverReviewed()]);
    wireInvoke({
      gate: NOT_APPLICABLE,
      leases: [],
      review: { pr_reviewer: "sparkle-reviewer", require_review: true },
    });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(1);
  });

  it("PAIRED: the SAME PR does NOT dispatch while the key is unarmed — the shipped default", async () => {
    // Without this pair the test above would pass for a sweep that dispatches on every PR, which is
    // the failure the key exists to avoid. Identical fixture; only the policy differs.
    fetchOpenPrsMock.mockResolvedValue([prNeverReviewed()]);
    wireInvoke({
      gate: NOT_APPLICABLE,
      leases: [],
      review: { pr_reviewer: "sparkle-reviewer", require_review: false },
    });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);
    expect(out.holds["no-evidence"]).toBe(1);
  });

  it("THE `none` HATCH survives the wiring: an armed key with no reviewer still never dispatches", async () => {
    fetchOpenPrsMock.mockResolvedValue([prNeverReviewed()]);
    wireInvoke({ gate: NOT_APPLICABLE, leases: [], review: { pr_reviewer: "none", require_review: true } });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);
    expect(out.holds["no-evidence"]).toBe(1);
  });

  it("FAILS CLOSED: an unreadable config dispatches nothing, rather than the whole fleet", async () => {
    // The dangerous direction. A config read that throws must not be read as "armed" — that would
    // put a driver on every open PR at once on the strength of a failure.
    fetchOpenPrsMock.mockResolvedValue([prNeverReviewed()]);
    wireInvoke({ gate: NOT_APPLICABLE, leases: [], configThrows: true });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);
    // THE HOLD REASON IS THE ASSERTION, not just the empty dispatch list. A sweep that THREW while
    // reading the config would also dispatch nothing — but it would land in `failed`, having judged
    // the PR not at all. `no-evidence` is the only outcome that says the PR was judged and the
    // unreadable policy was correctly read as NOT ARMED.
    expect(out.holds["no-evidence"]).toBe(1);
    expect(out.failed).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE HOLDER ID — the string the acquire is actually taken under.
//
// This module dispatched ZERO drivers for the entire history of the repo because the id it minted
// contained `:`, `/` and `#`, which `babysit_lease.rs::is_agent_id` rejects — and `dispatchOne`
// turned that rejection into a bare `return null` (sparkle-2hsrlz). Neither suite could see it: the
// TS side stubbed `invoke` and returned `{acquired: true}` unconditionally, and the Rust side fed
// hand-written ids ("driver-1", "old-driver") that all happened to be valid. NEITHER EVER SAW THE
// STRING PRODUCTION MINTS — the defaulted-seam shape AGENTS.md names.
//
// So the pin is a SHARED FIXTURE: `apps/desktop/shared/babysit-holder-id.fixture.json` holds what
// `mintDispatchHolderId` produces, this file asserts the mint still produces it, and
// `babysit_lease.rs` feeds those exact strings to the REAL validator and the REAL `acquire_at`.
// Change the mint and this half reds; update the fixture and the Rust half reds if the new shape is
// one the store will not take. They fail together, which is the only arrangement that holds.
describe("mintDispatchHolderId — the lease store has to ACCEPT it", () => {
  const fixture = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../shared/babysit-holder-id.fixture.json", import.meta.url)), "utf8"),
  ) as {
    maxLen: number;
    cases: { why: string; repo: string; pr: number; nowMs: number; holder: string }[];
  };

  it("the fixture is non-empty and carries the real production case", () => {
    // Guards the guard: an empty `cases` array would make every `for` below vacuously pass.
    expect(fixture.cases.length).toBeGreaterThanOrEqual(4);
    expect(fixture.cases.map((c) => c.repo)).toContain("drodio/sparkle");
    expect(fixture.maxLen).toBe(BABYSIT_HOLDER_ID_MAX_LEN);
  });

  it("produces EXACTLY the string the Rust suite validates, for every fixture case", () => {
    for (const c of fixture.cases) {
      expect(mintDispatchHolderId(c.repo, c.pr, c.nowMs), c.why).toBe(c.holder);
    }
  });

  it("folds every character the validator rejects, and never overruns its length ceiling", () => {
    // A LOCAL RESTATEMENT of `is_agent_id`, and worth only what a restatement is worth — it cannot
    // notice the Rust rule changing. It earns its place as the fast signal; `babysit_lease.rs`'s
    // fixture test is what actually ties this to the validator.
    for (const c of fixture.cases) {
      const id = mintDispatchHolderId(c.repo, c.pr, c.nowMs);
      expect(id, c.why).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(BABYSIT_HOLDER_ID_MAX_LEN);
    }
  });

  it("keeps pr and now WHOLE, so two sweeps on one PR cannot collide on the id", () => {
    // The truncation budget is spent on the repo half deliberately. If it ate the timestamp instead,
    // a 140-char slug would mint the SAME id twice and the second acquire would look like a retake.
    const long = `${"o".repeat(39)}/${"n".repeat(100)}`;
    const a = mintDispatchHolderId(long, 2658, 1756180000000);
    const b = mintDispatchHolderId(long, 2658, 1756180000001);
    expect(a).not.toBe(b);
    expect(a.endsWith("_2658_1756180000000")).toBe(true);
    expect(b.endsWith("_2658_1756180000001")).toBe(true);
  });

  it("THE SIDE EFFECT: the id the sweep actually SENDS to the acquire is a valid one", async () => {
    // The assertion the outage needed. Not "the mint is correct" — that is a precondition — but
    // "the string that reached `babysit_lease_acquire` on the real dispatch path is one the store
    // accepts". Before the fix this arg was `babysit-dispatch:drodio/sparkle#1251:...`.
    wireInvoke({ leases: [] });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(1);

    const acquireCalls = invokeMock.mock.calls.filter((c) => c[0] === BABYSIT_LEASE_ACQUIRE_COMMAND);
    expect(acquireCalls).toHaveLength(1);
    const sent = (acquireCalls[0]?.[1] as { agentId: string }).agentId;
    expect(sent).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    // And it is this module's own mint, not some other string that merely happens to be valid.
    expect(sent).toBe(mintDispatchHolderId("drodio/sparkle", 1251, T0 + 60_000));
  });

  it("THE RELEASE uses the SAME id, or the lease is unreleasable for 90 minutes", async () => {
    // A release keyed to a different string is refused, and the PR then sits held by a driver that
    // never started. A spawn that yields no agent forces that path: acquired, then nothing to run.
    spawnMock.mockReturnValue(null);
    wireInvoke({ leases: [] });
    await sweepTwice();

    const acquired = invokeMock.mock.calls.filter((c) => c[0] === BABYSIT_LEASE_ACQUIRE_COMMAND);
    const released = invokeMock.mock.calls.filter((c) => c[0] === BABYSIT_LEASE_RELEASE_COMMAND);
    expect(acquired).toHaveLength(1);
    expect(released).toHaveLength(1);
    expect((released[0]?.[1] as { agentId: string }).agentId).toBe(
      (acquired[0]?.[1] as { agentId: string }).agentId,
    );
  });
});

describe("a refused acquire SAYS WHY — the silence is what made the outage invisible", () => {
  it("reports a RETRYABLE refusal at warn, naming the reason and the id it was refused for", async () => {
    // `unknown` is what an unreadable or locked store comes back as. It is not a decision, so it
    // must not be swallowed the way the ordinary one-driver-per-PR case is — but it clears on its
    // own, so it stays a WARNING and the next sweep is the right response.
    wireInvoke({
      leases: [],
      acquired: false,
      acquireReason: BABYSIT_LEASE_REASON_UNKNOWN,
      acquireDetail: "could not take the lease store lock",
    });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);

    const warned = logWarnMock.mock.calls.filter((c) => String(c[1]).includes("REFUSED"));
    expect(warned).toHaveLength(1);
    const fields = warned[0]?.[2] as {
      reason: string;
      holder: string;
      detail: string | null;
      retryable?: boolean;
      recognisedReason?: boolean;
    };
    expect(fields.reason).toBe("unknown");
    expect(fields.holder).toBe(mintDispatchHolderId("drodio/sparkle", 1251, T0 + 60_000));
    expect(fields.detail).toContain("lock");
    expect(fields.retryable).toBe(true);
    // `unknown` is IN this file's vocabulary, so the retry is a decision rather than a fallback.
    expect(fields.recognisedReason).toBe(true);
    // …and it is NOT on the permanent stream. Without this the split below is satisfied by a
    // module that reports everything twice.
    expect(logErrorMock.mock.calls.filter((c) => String(c[1]).includes("MALFORMED"))).toHaveLength(0);
  });

  it("marks a reason OUTSIDE its vocabulary as unrecognised, while still retrying it", async () => {
    // THE PAIRED HALF. Asserting `recognisedReason: true` on `unknown` alone is satisfied by a
    // module that hardcodes `true` — which would report a token this file has never heard of as
    // one it understands, and a vocabulary that drifts apart silently is the entire defect this
    // split exists to fix. A token from a FUTURE Rust version must read as unrecognised.
    wireInvoke({
      leases: [],
      acquired: false,
      acquireReason: "some-token-this-file-has-never-heard-of",
      acquireDetail: "a reason added on the Rust side after this file was written",
    });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);

    const warned = logWarnMock.mock.calls.filter((c) => String(c[1]).includes("REFUSED"));
    expect(warned).toHaveLength(1);
    const fields = warned[0]?.[2] as { reason: string; retryable?: boolean; recognisedReason?: boolean };
    expect(fields.reason).toBe("some-token-this-file-has-never-heard-of");
    // Still retried — an unknown token is treated as transient because that is the SAFE default,
    // not because it was understood. Both halves matter: dropping the retry would strand a PR.
    expect(fields.retryable).toBe(true);
    expect(fields.recognisedReason).toBe(false);
    // And an unrecognised token is NOT escalated to the permanent stream — only `invalid` is.
    expect(logErrorMock.mock.calls.filter((c) => String(c[1]).includes("MALFORMED"))).toHaveLength(0);
  });

  it("reports a MALFORMED call at error — a permanent refusal is not a transient one", async () => {
    // THE SPLIT. `invalid` is the Rust side saying these arguments will never be accepted, so a
    // retry is a busy-loop and the fix is in this module. Before the reason existed, this arrived
    // spelled `unknown` — one word for "ask again" and "stop asking" (sparkle-nlxgd2,
    // sparkle-wb5pqe). Assert the SIDE EFFECT: which stream carried it, and that it named the
    // holder the call was refused for, so the bad argument is readable from the log alone.
    wireInvoke({
      leases: [],
      acquired: false,
      acquireReason: BABYSIT_LEASE_REASON_INVALID,
      acquireDetail: 'invalid pr 1251 or agent id "babysit-dispatch:drodio/sparkle#1251:1"',
    });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);

    const errored = logErrorMock.mock.calls.filter((c) => String(c[1]).includes("MALFORMED"));
    expect(errored).toHaveLength(1);
    const fields = errored[0]?.[2] as { reason: string; holder: string; detail: string | null };
    expect(fields.reason).toBe("invalid");
    expect(fields.holder).toBe(mintDispatchHolderId("drodio/sparkle", 1251, T0 + 60_000));
    expect(fields.detail).toContain("invalid pr");
    // A permanent refusal must not ALSO land on the retryable stream — that would put it back in
    // the bucket a reader scans for blips, which is the confusion this whole split removes.
    expect(logWarnMock.mock.calls.filter((c) => String(c[1]).includes("REFUSED"))).toHaveLength(0);
  });

  it("does NOT warn when another driver simply holds it — that one is a decision, not a bug", async () => {
    // The paired half. Without it, "warns on refusal" is satisfied by a module that warns on every
    // refusal, which would make the normal exclusion path scream once per sweep per busy PR.
    wireInvoke({ leases: [], acquired: false, acquireReason: BABYSIT_LEASE_REASON_HELD_LIVE });
    const out = await sweepTwice();
    expect(out.dispatched).toHaveLength(0);
    expect(logWarnMock.mock.calls.filter((c) => String(c[1]).includes("REFUSED"))).toHaveLength(0);
    expect(
      logDebugMock.mock.calls.filter((c) => String(c[1]).includes("another driver already holds")),
    ).toHaveLength(1);
  });
});

// ── THE ROSTER AXIS (bead `sparkle-rk0k8o`) ────────────────────────────────────────────────────
//
// FALSE-ABSENCE CASE: corpus instance `babysit-lease-blind-to-roster`, contract
// `apps/desktop/shared/false-absence-corpus.json`. The lease store is not the population the claim
// is about, so an empty read is a could-not-look, never "this PR is unowned".
//
// The spawner consulted `babysit-leases.json` and NOTHING ELSE, so a PR whose driver was alive and
// plainly on the roster still read as free. Measured over one night: #69, #70, #72 and #74 each
// ended up with two agents, #74 twice — and the duplicates could not be retired, because by the
// time anyone looked they ALREADY HELD uncommitted work on the branch their twin owned.
//
// Every assertion below is on the SIDE EFFECT (did a spawn happen, what standing came out), never
// on a precondition — the sweep's own header rule, and the reason these can fail.

/** A roster row for a babysit driver on `pr`, as `dispatchOne` actually creates it. */
function driverRow(id: string, pr: number, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: `Babysit #${pr}`,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: babysitPrompt(pr),
    promptHistory: [{ id: "p0", text: babysitPrompt(pr), at: T0 }],
    ...over,
  } as unknown as AgentTab;
}

/** PROJECT, but carrying a roster — the input the dispatcher never used to read. */
function projectWith(agents: AgentTab[]): Project {
  return { ...PROJECT, agents } as unknown as Project;
}

/** Seed this window's liveness maps. `status` present ⇒ `livenessOf` says "local" (authoritative);
 *  absent but in `openAgentIds` ⇒ "other-window"; neither ⇒ "unknown". The last two are both
 *  NOT-OBSERVED, which is the state the old code read as "no driver". */
function seedLiveness(status: Record<string, string>, openAgentIds: string[] = []): void {
  useRuntimeStore.setState({ status, openAgentIds } as never);
}

describe("isBabysitDriverFor — a driver is identified by more than its name", () => {
  it("matches the name dispatchOne spawns with", () => {
    expect(isBabysitDriverFor(driverRow("a", 74), REPO, 74)).toBe(true);
  });

  it("STILL matches after the agent renames itself", () => {
    // `rename_agent` is a control op any agent may call, so a name is a label that drifts. The
    // latched `/babysit-pr <n>` in promptHistory is what survives it — and survives a relaunch.
    const renamed = driverRow("a", 74, { name: "PR 74 cleanup", lastPrompt: "carry on" });
    expect(isBabysitDriverFor(renamed, REPO, 74)).toBe(true);
  });

  it("matches a driver started by the SKILL, which writes no lease at all", () => {
    // SKILL.md never acquires a lease — it assumes the dispatcher took one on its behalf. So a
    // `/babysit-pr 74` typed by a human is a real driver with no lease row, and the prompt is the
    // only trace of it. This is the case that produced the duplicates.
    const handRolled = driverRow("a", 74, { name: "Some agent", promptHistory: [] });
    expect(isBabysitDriverFor(handRolled, REPO, 74)).toBe(true);
  });

  it("does NOT confuse #7 with #70 — a prefix is not a match", () => {
    // `startsWith`/`includes` here would either suppress a legitimate dispatch on #70 forever or
    // let one through onto #7. Exact match on the trimmed string is the only safe test.
    expect(isBabysitDriverFor(driverRow("a", 7), REPO, 70)).toBe(false);
    expect(isBabysitDriverFor(driverRow("a", 70), REPO, 7)).toBe(false);
  });
});

describe("driverSightingFor — 'I cannot see it' is not 'it is not there'", () => {
  const alive = (map: Record<string, boolean | undefined>) => (id: string) => map[id];

  it("an OBSERVED-RUNNING driver is live, and is named", () => {
    expect(driverSightingFor([driverRow("owner", 74)], REPO, 74, alive({ owner: true }), T0)).toEqual({
      verdict: "live",
      agentId: "owner",
    });
  });

  it("a driver this window CANNOT OBSERVE is unobservable, NOT absent", () => {
    // `processAliveFor` returns undefined for an agent with no open pane in this window. That is
    // the absence of an observation, never a death — and reading it as "no driver" is the whole
    // bug: agent 7d023a66 had owned #74 for two hours when a second was spawned onto it.
    expect(driverSightingFor([driverRow("owner", 74)], REPO, 74, alive({}), T0)).toEqual({
      verdict: "unobservable",
      agentId: "owner",
    });
  });

  it("a driver this window WATCHED EXIT is passed over", () => {
    // The other direction has to work too, or one finished driver suppresses every future dispatch
    // on that PR forever. `false` is a real observation; `undefined` is not.
    expect(driverSightingFor([driverRow("gone", 74)], REPO, 74, alive({ gone: false }), T0)).toBe(
      NO_DRIVER_SIGHTED,
    );
  });

  it("an observed-live driver outranks an unobservable one, whatever the roster order", () => {
    const rows = [driverRow("cannot-see", 74), driverRow("running", 74)];
    expect(driverSightingFor(rows, REPO, 74, alive({ running: true }), T0)).toEqual({
      verdict: "live",
      agentId: "running",
    });
  });

  it("no driver row for this PR is 'none' — the lease still decides", () => {
    expect(driverSightingFor([driverRow("other", 99)], REPO, 74, alive({ other: true }), T0)).toBe(
      NO_DRIVER_SIGHTED,
    );
  });
});

describe("standingFor — the roster outranks the lease, in BOTH directions", () => {
  it("a live driver makes a LEASELESS PR held, not free", () => {
    // THE MEASURED BUG. `[]` is a perfectly readable lease store with no row for this PR, and it
    // used to answer `free` — which is a dispatch. A driver started by the skill, a human or an
    // orchestrator lands here every single time.
    expect(standingFor([], "a/b", 74, { verdict: "live", agentId: "owner" })).toBe("held-live");
  });

  it("a live driver overrides a dead-stale lease", () => {
    // `babysit_lease_heartbeat` has NO FRONTEND CALLER — it is in
    // scripts/tauri-command-callers.allow as a known-dead command — so `heartbeat_at_ms` is stamped
    // once at acquire and never refreshed. Every driver is therefore reclassified dead at 90
    // minutes WHILE STILL RUNNING, and the recovery cooldown dispatches its replacement 5 minutes
    // later. The skill self-paces at ~28 minutes a pass, so this is the normal case, not the edge.
    const stale = [{ lease: { repo: "a/b", pr: 74 }, standing: "dead-stale" }];
    expect(standingFor(stale, "a/b", 74)).toBe("held-dead");
    expect(standingFor(stale, "a/b", 74, { verdict: "live", agentId: "owner" })).toBe("held-live");
  });

  it("an UNOBSERVABLE driver holds — it does not fall through to the lease", () => {
    expect(standingFor([], "a/b", 74, { verdict: "unobservable", agentId: "owner" })).toBe("unknown");
  });

  it("a sighting of NONE leaves the original lease logic exactly as it was", () => {
    // The recovery path a genuinely dead driver depends on must be untouched, or a crashed driver
    // is never replaced.
    expect(standingFor([], "a/b", 74, NO_DRIVER_SIGHTED)).toBe("free");
    expect(standingFor(undefined, "a/b", 74, NO_DRIVER_SIGHTED)).toBe("unknown");
    const dead = [{ lease: { repo: "a/b", pr: 74 }, standing: "dead-epoch" }];
    expect(standingFor(dead, "a/b", 74, NO_DRIVER_SIGHTED)).toBe("held-dead");
  });
});

describe("the sweep does not put a SECOND driver on a PR that already has one", () => {
  afterEach(() => {
    seedLiveness({}, []);
  });

  it("REFUSES to spawn when a live driver is on the roster and no lease row exists", async () => {
    // End to end through the real sweep, driving the exact production shape: readable lease store,
    // no row for this PR, and an owner this window can see running. Before the roster axis existed
    // this spawned a duplicate; `spawnMock` is the side effect that proves it no longer does.
    seedLiveness({ owner: "working" });
    wireInvoke({ leases: [] });
    const project = projectWith([driverRow("owner", 1251)]);

    await babysitSweepProject(project, T0, CONFIG);
    const out = await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
  });

  it("NAMES the agent that already owns it, at a level a shipped build keeps", async () => {
    // The only pre-existing message naming an owner was a `log.debug` on the acquire path, and
    // `logger` drops debug in shipped builds — so when four PRs had two agents each, nothing in any
    // log said which agent held which, and they were untangled by hand. A refusal that cannot name
    // what it deferred to reads as the dispatcher being broken.
    seedLiveness({ owner: "working" });
    wireInvoke({ leases: [] });
    const project = projectWith([driverRow("owner", 1251)]);

    await babysitSweepProject(project, T0, CONFIG);
    await babysitSweepProject(project, T0 + 60_000, CONFIG);

    const named = logInfoMock.mock.calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("already has a driver"),
    );
    expect(named).toBeDefined();
    expect(named?.[2]).toMatchObject({ pr: 1251, owner: "owner", sighting: "live" });
  });

  it("REFUSES when the owner is on the roster but this window cannot observe it", async () => {
    // No status entry and no open pane: `processAliveFor` answers undefined. That is precisely the
    // reading the old code folded onto "no driver", and it is the state of every agent whose pane
    // is closed — which is most of them, most of the time.
    seedLiveness({}, []);
    wireInvoke({ leases: [] });
    const project = projectWith([driverRow("owner", 1251)]);

    await babysitSweepProject(project, T0, CONFIG);
    await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("STILL dispatches when the roster shows a driver this window watched EXIT", async () => {
    // The guard must not become a permanent mute. A `done` row is an OBSERVED death, so the PR is
    // genuinely unowned and the ordinary lease logic takes over.
    seedLiveness({ owner: "done" });
    wireInvoke({ leases: [] });
    const project = projectWith([driverRow("owner", 1251)]);

    await babysitSweepProject(project, T0, CONFIG);
    const out = await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(out.dispatched).toEqual([{ repo: "drodio/sparkle", pr: 1251, agentId: "agent-1" }]);
  });
});

// ── THE HOLD IS BOUNDED, OR IT IS A SILENT MUTE ────────────────────────────────────────────────
//
// The first cut of the roster guard held a PR for any never-observed driver row, forever. Review
// caught that this is the same defect pointed the other way, and STRICTLY WORSE than the duplicates
// it replaces, because nothing recovers from it. The mechanism is exact and it fires on every
// relaunch: `runtimeStore`'s `partialize` EXCLUDES `status` while PERSISTING `openAgentIds`, and a
// roster row is destroyed only by an explicit `removeAgent`. So a `Babysit #<pr>` row left by a
// driver that finished days ago reads `other-window` → `processAliveFor: undefined` → hold, on
// every sweep, for that PR, permanently.
//
// These cases pin the CAPABILITY the guard protects — "a PR that is genuinely unowned still gets a
// driver" — rather than the raw verdict, so the bound cannot be removed without one going red.
describe("an unobservable driver holds, but not forever", () => {
  const alive = (map: Record<string, boolean | undefined>) => (id: string) => map[id];
  const OLD = T0 - BABYSIT_UNOBSERVED_HOLD_MS - 60_000;

  it("THE LATCH SHAPE: a row from before a relaunch stops holding once it ages out", async () => {
    // The exact production shape the review named, and the one no earlier test reached: `status`
    // empty (it is never persisted) while the id is still in the persisted `openAgentIds`, which is
    // `livenessOf → "other-window"`. Stale row ⇒ the PR is dispatchable again.
    const stale = driverRow("owner", 74, { promptHistory: [{ id: "p0", text: babysitPrompt(74), at: OLD }] });
    expect(driverSightingFor([stale], REPO, 74, alive({}), T0)).toBe(NO_DRIVER_SIGHTED);
  });

  it("PAIRED — a RECENT never-observed row still holds", () => {
    // Without this the bound could be widened to zero and the guard would be gone, which is the
    // duplicate-spawn bug back again.
    const fresh = driverRow("owner", 74, { promptHistory: [{ id: "p0", text: babysitPrompt(74), at: T0 - 60_000 }] });
    expect(driverSightingFor([fresh], REPO, 74, alive({}), T0)).toEqual({
      verdict: "unobservable",
      agentId: "owner",
    });
  });

  it("`activityAt` refreshes the bound — a driver narrating an hour ago is recent", () => {
    // A long-lived driver re-prompted or narrating recently is not stale however long ago it was
    // spawned, so the newest stamp wins. Otherwise the bound would age out exactly the drivers that
    // have been working hardest.
    const chatty = driverRow("owner", 74, {
      promptHistory: [{ id: "p0", text: babysitPrompt(74), at: OLD }],
      activityAt: T0 - 60 * 60 * 1000,
    });
    expect(driverSightingFor([chatty], REPO, 74, alive({}), T0)).toEqual({
      verdict: "unobservable",
      agentId: "owner",
    });
  });

  it("an OBSERVED-LIVE row is never aged out — an observation beats a bound", () => {
    // The bound stands in for an observation we could not make. Where we DID make one it has no
    // business overriding it, or a long-running driver we can plainly see gets a twin.
    const old = driverRow("owner", 74, { promptHistory: [{ id: "p0", text: babysitPrompt(74), at: OLD }] });
    expect(driverSightingFor([old], REPO, 74, alive({ owner: true }), T0)).toEqual({
      verdict: "live",
      agentId: "owner",
    });
  });

  it("a row carrying NO stamp at all still holds — an unmeasurable age is not a stale one", () => {
    // Deliberately asymmetric. Nothing to age out means nothing to age out; the harm of an
    // unbounded hold here is one PR unwatched, and the harm of dispatching is two agents on one
    // branch. The latch the review found always carries a prompt stamp, so the bound still bites
    // exactly where the defect is.
    const stampless = driverRow("owner", 74, { promptHistory: [], lastPrompt: babysitPrompt(74) });
    expect(driverSightingFor([stampless], REPO, 74, alive({}), T0)).toEqual({
      verdict: "unobservable",
      agentId: "owner",
    });
  });

  it("END TO END: an aged-out row does not mute the PR — a driver is dispatched", async () => {
    // The capability, through the real sweep. This is the assertion that fails if anyone removes
    // the bound, and it is on the SIDE EFFECT.
    seedLiveness({}, ["owner"]);
    wireInvoke({ leases: [] });
    const project = projectWith([
      driverRow("owner", 1251, { promptHistory: [{ id: "p0", text: babysitPrompt(1251), at: OLD }] }),
    ]);

    await babysitSweepProject(project, T0, CONFIG);
    const out = await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(out.dispatched).toEqual([{ repo: "drodio/sparkle", pr: 1251, agentId: "agent-1" }]);
  });

  it("END TO END: a RECENT unobservable row on the persisted set still refuses", async () => {
    seedLiveness({}, ["owner"]);
    wireInvoke({ leases: [] });
    const project = projectWith([
      driverRow("owner", 1251, { promptHistory: [{ id: "p0", text: babysitPrompt(1251), at: T0 - 60_000 }] }),
    ]);

    await babysitSweepProject(project, T0, CONFIG);
    await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ── THE HEARTBEAT NOW HAS A CALLER ─────────────────────────────────────────────────────────────
//
// `babysit_lease.rs` calls a lease dead once its heartbeat is 90 minutes old, and NOTHING in the
// app had ever invoked `babysit_lease_heartbeat` — it sat in `scripts/tauri-command-callers.allow`
// as a known-dead command. So `heartbeat_at_ms` was stamped once at acquire and never moved, every
// driver was reclassified `dead-stale` at 90 minutes WHILE STILL RUNNING, and the recovery cooldown
// dispatched its replacement. A pass self-paces at ~28 minutes, so crossing 90 is ordinary.
describe("the lease heartbeat is refreshed from an observation", () => {
  it("stamps the HOLDER's id when the roster shows the driver running", async () => {
    seedLiveness({ owner: "working" });
    wireInvoke({ leases: [{ lease: { repo: "drodio/sparkle", pr: 1251, agentId: "holder-9" }, standing: "live" }] });

    await babysitSweepProject(projectWith([driverRow("owner", 1251)]), T0, CONFIG);

    // The HOLDER id, not the agent's own: the lease is held under the minted dispatch id, and
    // `heartbeat_at` matches on it. Stamping the wrong id is a silent no-op in Rust.
    expect(invokeMock).toHaveBeenCalledWith(BABYSIT_LEASE_HEARTBEAT_COMMAND, {
      repo: "drodio/sparkle",
      pr: 1251,
      agentId: "holder-9",
    });
  });

  it("does NOT stamp one for a driver this window cannot observe", async () => {
    // The heartbeat must carry an OBSERVATION. Stamping it for a row we merely cannot see would
    // keep a dead driver's lease alive forever and re-break the recovery path from the other end.
    seedLiveness({}, ["owner"]);
    wireInvoke({ leases: [{ lease: { repo: "drodio/sparkle", pr: 1251, agentId: "holder-9" }, standing: "live" }] });

    await babysitSweepProject(projectWith([driverRow("owner", 1251)]), T0, CONFIG);

    expect(invokeMock).not.toHaveBeenCalledWith(BABYSIT_LEASE_HEARTBEAT_COMMAND, expect.anything());
  });

  it("a failing heartbeat does not take the sweep down", async () => {
    // Best-effort bookkeeping: the roster guard already holds the PR without it, so a throw here
    // must not turn a working sweep into a failed one.
    seedLiveness({ owner: "working" });
    const base = invokeMock.getMockImplementation();
    wireInvoke({ leases: [{ lease: { repo: "drodio/sparkle", pr: 1251, agentId: "holder-9" }, standing: "live" }] });
    const wired = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd: string, ...rest: unknown[]) => {
      if (cmd === BABYSIT_LEASE_HEARTBEAT_COMMAND) throw new Error("bridge down");
      return (wired ?? base)?.(cmd, ...rest);
    });

    const out = await babysitSweepProject(projectWith([driverRow("owner", 1251)]), T0, CONFIG);

    expect(out.failed).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ── THE (repo, pr) GAP IS KNOWN AND DELIBERATELY LEFT OPEN ─────────────────────────────────────
//
// Neither `Babysit #<pr>` nor `/babysit-pr <pr>` carries a repo, so a driver on another repo's PR
// of the same number cannot be told apart here. An earlier cut narrowed on `assignmentRepos` and
// review measured it worse than the gap in BOTH directions: inert where aimed (dispatcher-spawned
// drivers latch `[]`, because the babysit prompt names no repo) and harmful where not (the latch
// fires on any GitHub URL in an agent's FIRST prompt, so a hand-typed `/babysit-pr 74` in such an
// agent would be un-identified — and a hand-rolled driver writes no lease, so nothing else catches
// it). The asymmetry decides it: a missed hold costs a duplicate driver on a human's PR, a spurious
// hold costs one deferred dispatch. Closing it properly means carrying the slug in the babysit
// assignment itself, which is a change to the skill's argument contract.
describe("driver identity ignores the repo, and that is a stated gap not an oversight", () => {
  const alive = (map: Record<string, boolean | undefined>) => (id: string) => map[id];

  it("a foreign-repo latch does NOT un-identify a driver — the narrowing is gone and stays gone", () => {
    const elsewhere = driverRow("owner", 74, { assignmentRepos: ["otherowner/otherrepo"] });
    expect(isBabysitDriverFor(elsewhere, REPO, 74)).toBe(true);
    expect(driverSightingFor([elsewhere], REPO, 74, alive({ owner: true }), T0)).toEqual({
      verdict: "live",
      agentId: "owner",
    });
  });

  it("the PR NUMBER still discriminates — #7 is not #70", () => {
    // The one half of identity this function CAN honour, and the load-bearing one: a prefix match
    // would either suppress #70 forever or let a driver through onto #7.
    expect(isBabysitDriverFor(driverRow("a", 7), REPO, 70)).toBe(false);
    expect(isBabysitDriverFor(driverRow("a", 70), REPO, 7)).toBe(false);
  });
});


// ── THE HOLD MUST BE ABLE TO END, WHATEVER WROTE THE LEASE ─────────────────────────────────────
//
// An earlier cut let a same-launch lease bypass the bound. Review caught that the epoch is per APP
// LAUNCH, not per driver, and that NOTHING releases a lease when a driver ends normally — the only
// release is the spawn-refused path, and the skill never releases. So an orphan lease from a driver
// that finished an hour ago reads `dead-stale` for the rest of the app's life, and the bypass
// turned that into a mute lasting days. One bound now, no bypass.
describe("an orphan lease cannot mute a PR for the life of the app", () => {
  const alive = (map: Record<string, boolean | undefined>) => (id: string) => map[id];
  const OLD = T0 - BABYSIT_UNOBSERVED_HOLD_MS - 60_000;
  const ancient = (pr: number) =>
    driverRow("owner", pr, { promptHistory: [{ id: "p0", text: babysitPrompt(pr), at: OLD }] });

  it("THE MUTE: an aged row with an equally-aged dead-stale lease is RELEASED", () => {
    // The driver ended; nobody released its lease and nobody can observe its roster row. Both
    // stamps are past the bound, so the row stops counting and the ordinary lease logic resumes.
    expect(
      driverSightingFor([ancient(74)], REPO, 74, alive({}), T0, {
        acquiredAtMs: OLD,
        heartbeatAtMs: OLD,
      }),
    ).toBe(NO_DRIVER_SIGHTED);
  });

  it("PAIRED — a RECENTLY-stamped lease still holds the same aged row", () => {
    // The lease's stamps feed the SAME bound rather than bypassing it, so recent evidence from
    // either source holds and stale evidence from both releases. This is the case that proves the
    // lease is still consulted at all.
    expect(
      driverSightingFor([ancient(74)], REPO, 74, alive({}), T0, { heartbeatAtMs: T0 - 60_000 }),
    ).toEqual({ verdict: "unobservable", agentId: "owner" });
  });

  it("END TO END: an orphaned dead-stale lease eventually hands the PR to a replacement", async () => {
    // The recovery this module exists to provide. Before the bound was made unconditional, this PR
    // stayed at `lease-unknown` until the app restarted.
    seedLiveness({}, ["owner"]);
    wireInvoke({
      leases: [
        {
          lease: { repo: "drodio/sparkle", pr: 1251, agentId: "holder-9", acquiredAtMs: OLD, heartbeatAtMs: OLD },
          standing: "dead-stale",
        },
      ],
    });
    const project = projectWith([ancient(1251)]);

    await babysitSweepProject(project, T0, CONFIG);
    const out = await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(out.dispatched).toEqual([{ repo: "drodio/sparkle", pr: 1251, agentId: "agent-1" }]);
  });

  it("a hand-typed driver in an agent whose FIRST prompt linked another repo is still recognised", async () => {
    // `assignmentRepos` records the OPENING assignment, not the babysit target, and the latch fires
    // on any GitHub URL in an ordinary prompt. Narrowing on it un-identified exactly the driver that
    // writes no lease — so nothing else would have caught it, and a twin would be spawned onto a
    // branch holding uncommitted work. The narrowing is gone; this pins that it stays gone.
    seedLiveness({ owner: "working" });
    wireInvoke({ leases: [] });
    const project = projectWith([
      driverRow("owner", 1251, {
        name: "Some other agent",
        assignmentRepos: ["try-sparkle/sparkle"],
        lastPrompt: babysitPrompt(1251),
        promptHistory: [{ id: "p0", text: "look at github.com/try-sparkle/sparkle/pull/9", at: T0 - 60_000 }],
      }),
    ]);

    await babysitSweepProject(project, T0, CONFIG);
    await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ── A DEAD-EPOCH LEASE IS NOT EVIDENCE THAT ANY PROCESS EXISTS ─────────────────────────────────
//
// `dead-epoch` is positive proof the holder's app launch is over, so its stamps — however recent —
// must not feed the bound. Folding them in let a lease left by a previous launch keep a dead roster
// row "fresh" for the whole 12-hour window, preempting the recovery `standingFor` still implements
// (dead-epoch → held-dead → cooldown → replacement). The heartbeat wiring makes this concrete: it
// stamps `heartbeatAtMs` on every sweep that observes a driver, so a lease surviving a restart
// carries a stamp only minutes old.
describe("a lease from a previous app launch cannot keep a dead row alive", () => {
  const OLD = T0 - BABYSIT_UNOBSERVED_HOLD_MS - 60_000;
  const ancient = (pr: number) =>
    driverRow("owner", pr, { promptHistory: [{ id: "p0", text: babysitPrompt(pr), at: OLD }] });

  it("END TO END: a dead-epoch lease with a RECENT heartbeat still hands the PR over", async () => {
    // The exact post-restart shape: openAgentIds persisted so the row survives with no observable
    // status, the lease file survived with a stamp from minutes before the quit, and `list_at`
    // reports it dead-epoch under the new process_epoch(). Before the guard this held for 12h.
    seedLiveness({}, ["owner"]);
    wireInvoke({
      leases: [
        {
          lease: {
            repo: "drodio/sparkle",
            pr: 1251,
            agentId: "holder-9",
            acquiredAtMs: T0 - 120_000,
            heartbeatAtMs: T0 - 60_000,
          },
          standing: "dead-epoch",
        },
      ],
    });
    const project = projectWith([ancient(1251)]);

    await babysitSweepProject(project, T0, CONFIG);
    const out = await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(out.dispatched).toEqual([{ repo: "drodio/sparkle", pr: 1251, agentId: "agent-1" }]);
  });

  it("PAIRED — the SAME recent stamps under a dead-stale (this-launch) lease still hold", async () => {
    // Only the standing differs, so this pins that the guard keys on `dead-epoch` and not on the
    // stamps themselves — otherwise it would be a blanket refusal to consult the lease at all.
    seedLiveness({}, ["owner"]);
    wireInvoke({
      leases: [
        {
          lease: {
            repo: "drodio/sparkle",
            pr: 1251,
            agentId: "holder-9",
            acquiredAtMs: T0 - 120_000,
            heartbeatAtMs: T0 - 60_000,
          },
          standing: "dead-stale",
        },
      ],
    });
    const project = projectWith([ancient(1251)]);

    await babysitSweepProject(project, T0, CONFIG);
    await babysitSweepProject(project, T0 + 60_000, CONFIG);

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ── THE HEARTBEAT AWAIT IS FENCED, AND BOTH DIRECTIONS ARE PINNED ──────────────────────────────
//
// The two sibling fences each carry a paired test, including an explicit "a fence that always
// reported superseded would pass above" direction — this one shipped with neither, so if it were
// misplaced or inert nothing would have said so. That is the shape the rest of this work is about.
//
// The reachable harm here is narrower than at the other two: we are inside a `live` sighting, so
// `observeLease` short-circuits on `held-live` and never reaches the exit stamp. What a superseded
// sweep would still do is write `sawLive = true` over a replacement's newer state and walk on
// through PRs 2..N against a pre-deadline clock and lease snapshot.
describe("the fence after the heartbeat await", () => {
  it("ABANDONS the sweep when it is superseded during the heartbeat invoke", async () => {
    // A live sighting is what reaches the heartbeat at all, so seed one; the lease supplies the
    // holder id the stamp needs. `isCurrent` stays true for the two earlier fences and flips on the
    // third call — the one after the invoke.
    seedLiveness({ owner: "working" });
    wireInvoke({
      leases: [{ lease: { repo: "drodio/sparkle", pr: 1251, agentId: "holder-9" }, standing: "live" }],
    });
    const project = projectWith([driverRow("owner", 1251)]);

    let calls = 0;
    const out = await babysitSweepProject(project, T0, CONFIG, () => ++calls <= 2);

    expect(out.abandoned).toBe(true);
    // It stopped BEFORE judging this PR, so nothing downstream ran on the stale snapshot.
    expect(out.holds).toEqual({});
  });

  it("PAIRED — a sweep that stays current is NOT abandoned", async () => {
    // Without this, a fence hard-wired to report superseded would satisfy the case above. The same
    // fixture, the same heartbeat, the only difference being that nothing supersedes it.
    seedLiveness({ owner: "working" });
    wireInvoke({
      leases: [{ lease: { repo: "drodio/sparkle", pr: 1251, agentId: "holder-9" }, standing: "live" }],
    });
    const project = projectWith([driverRow("owner", 1251)]);

    const out = await babysitSweepProject(project, T0, CONFIG);

    expect(out.abandoned).toBeUndefined();
    // …and it went on to judge the PR, holding it because a live driver already owns it.
    expect(out.holds).toEqual({ "driver-alive": 1 });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
