import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => h.invoke(...a),
}));

import type { BabysitProbe, BabysitProbeGate } from "@sparkle/core";
import {
  evictProbeGates,
  fetchProbeGates,
  probeStateOf,
  readProbeGate,
  refreshProbeGates,
  unansweredBlockingProbes,
  PROBE_READ_CONCURRENCY,
  __resetProbeGateCacheForTests,
} from "./probeGate";

const probe = (over: Partial<BabysitProbe> = {}): BabysitProbe => ({
  commentId: 5196781304,
  index: 1,
  severity: "blocking",
  from: "shape",
  text: "[bypass] The new raw-event overlay bypasses HookStatusEngine's semantics",
  url: "https://github.com/drodio/sparkle/pull/1325#issuecomment-5196781304",
  answered: false,
  ...over,
});

const gate = (over: Partial<BabysitProbeGate> = {}): BabysitProbeGate => ({
  applicable: true,
  probes: [],
  error: null,
  overridden: false,
  ...over,
});

beforeEach(() => {
  h.invoke.mockReset();
  __resetProbeGateCacheForTests();
});

describe("unansweredBlockingProbes — null is not empty", () => {
  it("returns null for a read that did not answer, NOT an empty list", () => {
    // The one distinction this whole module is written around. `[]` means "asked; none"; `null`
    // means "could not look". A caller that gets `[]` here would report a PR probe-clean on the
    // strength of a failed read.
    expect(unansweredBlockingProbes(gate({ probes: null }))).toBeNull();
    expect(unansweredBlockingProbes(gate({ probes: undefined }))).toBeNull();
    expect(unansweredBlockingProbes(undefined)).toBeNull();
    expect(unansweredBlockingProbes(gate({ probes: [] }))).toEqual([]);
  });

  it("catches serde's null, not just undefined", () => {
    // This type crosses an IPC boundary and serde serialises Option::None as literal `null`. An
    // `=== undefined` guard misses every real unknown the producer sends — the exact bug
    // babysitDispatch.ts documents having shipped once.
    const g = JSON.parse(JSON.stringify(gate({ probes: null }))) as BabysitProbeGate;
    expect(g.probes).toBeNull();
    expect(unansweredBlockingProbes(g)).toBeNull();
  });

  it("counts only BLOCKING probes that are still unanswered", () => {
    const g = gate({
      probes: [
        probe({ index: 1, severity: "blocking", answered: false }),
        probe({ index: 2, severity: "blocking", answered: true }),
        probe({ index: 3, severity: "open", answered: false }),
        probe({ index: 4, severity: "open", answered: true }),
      ],
    });
    const out = unansweredBlockingProbes(g);
    expect(out?.map((p) => p.index)).toEqual([1]);
  });

  it("keeps each probe's identity and link, so a row can cite it", () => {
    // Probe identity is (commentId, index) and NEVER the index alone — numbering restarts in every
    // review, so two reviews both raise a probe 1. The row's "Copy probe id" depends on this.
    const g = gate({ probes: [probe({ commentId: 5182769304, index: 2 })] });
    const [p] = unansweredBlockingProbes(g)!;
    expect(p!.commentId).toBe(5182769304);
    expect(p!.index).toBe(2);
    expect(p!.url).toContain("#issuecomment-");
  });
});

describe("probeStateOf — the projection the readiness rule judges", () => {
  it("carries an unknown read through as a null count", () => {
    expect(probeStateOf(gate({ probes: null }))?.unansweredBlocking).toBeNull();
  });

  it("reports zero for a read that answered with no probes", () => {
    expect(probeStateOf(gate({ probes: [] }))?.unansweredBlocking).toBe(0);
  });

  it("counts unanswered blocking probes", () => {
    const g = gate({
      probes: [probe({ index: 1 }), probe({ index: 2 }), probe({ index: 3, answered: true })],
    });
    expect(probeStateOf(g)?.unansweredBlocking).toBe(2);
  });

  it("reports the real count alongside overridden, rather than zeroing it", () => {
    // The readiness rule decides that an override clears the block; this function only reports. If
    // it zeroed the count, the row could never say "3 probes, waived".
    const g = gate({ probes: [probe(), probe({ index: 2 })], overridden: true });
    const s = probeStateOf(g)!;
    expect(s.unansweredBlocking).toBe(2);
    expect(s.overridden).toBe(true);
  });

  it("distinguishes not-applicable from clean", () => {
    const s = probeStateOf(gate({ applicable: false, probes: [] }))!;
    expect(s.applicable).toBe(false);
    expect(s.unansweredBlocking).toBe(0);
  });

  it("is undefined for no reading at all", () => {
    expect(probeStateOf(undefined)).toBeUndefined();
  });
});

describe("readProbeGate — never throws", () => {
  it("turns a rejected invoke into the UNKNOWN reading, applicable still true", () => {
    h.invoke.mockRejectedValueOnce(new Error("gh: command not found"));
    return readProbeGate("/repo", 1325).then((g) => {
      expect(g.probes).toBeUndefined();
      // NOT `applicable: false` — that would claim this PR has no knightwatch review, on the
      // strength of a read that never happened.
      expect(g.applicable).toBe(true);
      expect(g.error).toMatch(/command not found/);
    });
  });

  it("treats an unrecognisable reply as unknown rather than trusting the cast", () => {
    h.invoke.mockResolvedValueOnce({ nonsense: true });
    return readProbeGate("/repo", 1325).then((g) => {
      expect(g.probes).toBeUndefined();
      expect(g.error).toMatch(/unrecognised/i);
    });
  });

  it("passes root and number through under the names Rust expects", async () => {
    h.invoke.mockResolvedValueOnce(gate());
    await readProbeGate("/repo", 1325);
    expect(h.invoke).toHaveBeenCalledWith("knightwatch_probe_gate", {
      root: "/repo",
      number: 1325,
    });
  });
});

describe("fetchProbeGates — cache, bound, and what it refuses to cache", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ number: 100 + i, updatedAt: `2026-08-05T00:0${i}:00Z` }));

  it("reads every PR once and returns a reading for each", async () => {
    const read = vi.fn(async (_r: string, n: number) => gate({ probes: [probe({ index: n })] }));
    const out = await fetchProbeGates("/repo", rows(5), read);
    expect(out.size).toBe(5);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("does not re-read a PR whose updatedAt has not moved", async () => {
    const read = vi.fn(async () => gate({ probes: [probe()] }));
    await fetchProbeGates("/repo", rows(3), read);
    expect(read).toHaveBeenCalledTimes(3);
    await fetchProbeGates("/repo", rows(3), read);
    expect(read).toHaveBeenCalledTimes(3); // all three served from cache
  });

  it("re-reads a PR whose updatedAt moved", async () => {
    const read = vi.fn(async () => gate({ probes: [probe()] }));
    await fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    await fetchProbeGates("/repo", [{ number: 100, updatedAt: "t2" }], read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("re-reads when a COMMENT lands, even though the head never moved", async () => {
    // THE REASON THIS CACHE IS KEYED ON `updatedAt` AND NOT ON `headRefOid`, and it is correctness
    // rather than tuning. A probe is ANSWERED BY A COMMENT, and a comment never moves the head. A
    // head-keyed cache would therefore pin "Blocked: 1 probe" on a row whose probe had already been
    // answered, until somebody happened to push — the exact false claim this panel exists to stop,
    // inverted. GitHub bumps `updatedAt` on any comment, review, push or label.
    const read = vi
      .fn(async () => gate({ probes: [probe({ answered: true })] }))
      .mockResolvedValueOnce(gate({ probes: [probe({ answered: false })] }));
    const before = await fetchProbeGates("/repo", [{ number: 1325, updatedAt: "before-reply" }], read);
    expect(unansweredBlockingProbes(before.get(1325))).toHaveLength(1);

    // Someone posts a reply citing the probe. The head is unchanged; only `updatedAt` moves.
    const after = await fetchProbeGates("/repo", [{ number: 1325, updatedAt: "after-reply" }], read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(unansweredBlockingProbes(after.get(1325))).toHaveLength(0);
  });

  // NO TEST FOR AN ABSENT/EMPTY `updatedAt`, deliberately — and this note is the finding.
  //
  // roborev flagged the original pair as vacuous, and it was right: both passes fed a stamp-less
  // row, which is never cached, so the second read happened whatever `stillFresh` did. The obvious
  // repair — cache under a good stamp, then re-fetch with an absent one — is ALSO vacuous, which
  // only showed up when the guard was mutated away and the suite stayed green. The reason is
  // structural: nothing stamp-less is ever written to the cache, so `entry.updatedAt` is always
  // non-empty and a plain `===` against an absent stamp is already false. Every implementation of
  // the emptiness rule agrees on every reachable input, so no test can tell them apart.
  //
  // Deleting the assertions rather than keeping decorative ones: a test that cannot fail is worse
  // than no test, because it reports the case as covered. `stillFresh` carries the explanation.

  it("degrades a REJECTING read to the unknown reading instead of rejecting", async () => {
    // `read` is an injectable seam, and the docstring promises this function never rejects. Without
    // the catch, one throwing read propagates out of the Promise.all: the whole accumulated map is
    // discarded and every other queued PR is abandoned mid-flight, so the panel's render path gets
    // an exception in place of readings.
    const read = vi.fn(async (_r: string, n: number) => {
      if (n === 101) throw new Error("gh exploded");
      return gate({ probes: [] });
    });
    const out = await fetchProbeGates("/repo", rows(3), read);
    expect(out.size).toBe(3);
    // `undefined`, not `null`: the UNKNOWN reading is normalised at the IPC boundary (the shape
    // the core's `probe-read-unknown` hold tests for). Consumers test `== null`, so both satisfy them.
    expect(out.get(101)?.probes).toBeUndefined();
    expect(out.get(101)?.error).toMatch(/exploded/);
    // ...and the PRs either side of the failure still got their real answers.
    expect(out.get(100)?.probes).toEqual([]);
    expect(out.get(102)?.probes).toEqual([]);
  });

  it("bounds concurrency across CONCURRENT CALLS, not just within one", async () => {
    // The limiter used to be a local queue inside this function, which bounds one call and nothing
    // else — while the panel issues one call PER SCOPE. Six open projects would then run 6x4 = 24
    // concurrent `gh` subprocesses, which is essentially the number this module exists to prevent.
    let live = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live -= 1;
      return gate({ probes: [] });
    });
    await Promise.all([
      fetchProbeGates("/repo-a", rows(8), read),
      fetchProbeGates("/repo-b", rows(8), read),
      fetchProbeGates("/repo-c", rows(8), read),
    ]);
    expect(peak).toBeLessThanOrEqual(PROBE_READ_CONCURRENCY);
    expect(read).toHaveBeenCalledTimes(24);
  });

  it("joins an identical read already in flight rather than spawning a second", async () => {
    // Reads are bounded at 45s and the poll runs every 180s, so a Refresh landing during a poll is
    // ordinary. The cache cannot help there — nothing has been written yet.
    let resolveRead: ((g: ReturnType<typeof gate>) => void) | undefined;
    const read = vi.fn(
      () => new Promise<ReturnType<typeof gate>>((r) => { resolveRead = r; }),
    );
    const row = [{ number: 100, updatedAt: "t1" }];
    const a = fetchProbeGates("/repo", row, read);
    const b = fetchProbeGates("/repo", row, read);
    await Promise.resolve();
    resolveRead!(gate({ probes: [probe()] }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(unansweredBlockingProbes(ra.get(100))).toHaveLength(1);
    expect(unansweredBlockingProbes(rb.get(100))).toHaveLength(1);
  });

  it("does NOT cache an unknown reading, so a blip does not pin itself to the PR", async () => {
    // A transient gh failure must not become a lasting "we don't know" that only a later event can
    // clear.
    const read = vi.fn(async () => gate({ probes: null, error: "timed out" }));
    const row = [{ number: 100, updatedAt: "t1" }];
    await fetchProbeGates("/repo", row, read);
    await fetchProbeGates("/repo", row, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per repo root, so two repos' PR #1 never collide", async () => {
    const read = vi.fn(async () => gate({ probes: [probe()] }));
    const row = [{ number: 1, updatedAt: "t1" }];
    await fetchProbeGates("/repo-a", row, read);
    await fetchProbeGates("/repo-b", row, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refreshProbeGates drops the cache, so Refresh always re-asks", async () => {
    const read = vi.fn(async () => gate({ probes: [probe()] }));
    const row = [{ number: 100, updatedAt: "t1" }];
    await fetchProbeGates("/repo", row, read);
    refreshProbeGates();
    await fetchProbeGates("/repo", row, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never runs more than PROBE_READ_CONCURRENCY reads at once", async () => {
    // Each read is a `gh` subprocess doing a paginated GitHub read. 27 at once on a machine already
    // running dozens of agents is a real cost, and secondary-rate-limit territory.
    let inFlight = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return gate({ probes: [] });
    });
    await fetchProbeGates("/repo", rows(20), read);
    expect(peak).toBeLessThanOrEqual(PROBE_READ_CONCURRENCY);
    expect(peak).toBeGreaterThan(1); // ...and it is not accidentally serial
    expect(read).toHaveBeenCalledTimes(20);
  });

  it("returns a reading for a FAILED read rather than omitting the key", async () => {
    // A caller must not have to infer "read and unknown" from a missing key — that inference is
    // exactly what the three-state discipline removes.
    const read = vi.fn(async () => gate({ probes: null, error: "offline" }));
    const out = await fetchProbeGates("/repo", rows(2), read);
    expect(out.size).toBe(2);
    expect(out.get(100)?.probes).toBeNull();
  });

  it("resolves to an empty map for an empty PR list without reading anything", async () => {
    const read = vi.fn(async () => gate());
    const out = await fetchProbeGates("/repo", [], read);
    expect(out.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// IN-FLIGHT DEDUP — the three ways a shared promise can hand back the wrong answer.
//
// Dedup is not free: it makes one caller's read the answer to another caller's question, and the
// two questions are only the same if the PR's stamp and the module's generation both match. Each
// case below fails on the version that keyed the in-flight map on (root, number) alone.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("fetchProbeGates — a read is only joinable while it answers the SAME question", () => {
  /** A read that parks until the test releases it, so a second request can arrive mid-flight. */
  function pausedRead() {
    const releases: ((g: BabysitProbeGate) => void)[] = [];
    const read = vi.fn(
      () => new Promise<BabysitProbeGate>((resolve) => releases.push(resolve)),
    );
    return { read, releases };
  }

  it("does not serve a t1 read to a t2 request, nor cache the t1 answer under t2", async () => {
    // THE PIN, IN ITS WORST DIRECTION. The t1 read predates the comment that bumped the stamp, so
    // joining it hands back a reading taken BEFORE the probe was answered — and caching it under
    // t2 makes that stale "blocked" the row's truth until some other event moves the stamp again.
    const { read, releases } = pausedRead();
    const first = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    await Promise.resolve();
    const second = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t2" }], read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2); // NOT joined — a different stamp is a different question

    releases[0]?.(gate({ probes: [probe()] })); // t1: one unanswered blocking probe
    releases[1]?.(gate({ probes: [] })); // t2: answered
    await first;
    const out = await second;
    expect(out.get(100)?.probes).toEqual([]);

    // And the cache now holds the t2 answer, so a third poll at t2 is served the ANSWERED reading.
    const third = vi.fn(async () => gate({ probes: [probe()] }));
    const again = await fetchProbeGates("/repo", [{ number: 100, updatedAt: "t2" }], third);
    expect(third).not.toHaveBeenCalled();
    expect(again.get(100)?.probes).toEqual([]);
  });

  it("still joins a genuinely identical read — dedup has not been disabled", async () => {
    // The counter-guard. If this goes red the fix above has thrown the feature out with the bug:
    // a Refresh landing during a poll would re-issue a subprocess for every PR already being read.
    const { read, releases } = pausedRead();
    const a = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    await Promise.resolve();
    const b = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    releases[0]?.(gate({ probes: [probe()] }));
    expect((await a).get(100)?.probes).toHaveLength(1);
    expect((await b).get(100)?.probes).toHaveLength(1);
  });

  it("a Refresh mid-read forces a fresh read and refuses to cache the pre-Refresh answer", async () => {
    // Refresh's ONLY job is the hole `updatedAt` cannot cover — a probe answered by EDITING an
    // existing reply, which never moves the PR's stamp. Reads run for up to 45 s, so pressing it
    // DURING one is the ordinary case; joining that read would answer the press with the very
    // reading it rejected, and Refresh would be a silent no-op exactly when it is being used.
    const { read, releases } = pausedRead();
    const first = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    await Promise.resolve();

    refreshProbeGates();
    const second = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2); // same stamp, but a new generation

    // POST-REFRESH SETTLES FIRST, THEN THE STALE ONE. The order matters and the original had it
    // backwards, which made the cache half of this test vacuous: with the pre-Refresh read settling
    // first, the post-Refresh write landed after it and last-write-wins produced the right answer
    // whether or not the generation guard existed. Settling the stale read LAST means the only
    // thing that can keep it out of the cache is the guard itself.
    releases[1]?.(gate({ probes: [] })); // what the user pressed Refresh to find out
    await second;
    releases[0]?.(gate({ probes: [probe()] })); // the stale pre-Refresh reading, settling late
    await first;

    // The pre-Refresh read must not have written itself into the cache on its way out.
    const third = vi.fn(async () => gate({ probes: [] }));
    const out = await fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], third);
    expect(third).not.toHaveBeenCalled(); // served from the POST-Refresh entry...
    expect(out.get(100)?.probes).toEqual([]); // ...and that entry is the one the user asked for
  });

  it("does not evict a LIVE in-flight entry when an older read for the same PR settles", async () => {
    // The "only if it is still ours" condition in readOnce's finally. The interleaving that can
    // observe it is the ordinary production one: a t1 read still running when a t2 poll starts. If
    // the t1 completion deletes by key alone it evicts the LIVE t2 entry, and the next caller
    // spawns a third `gh` subprocess for a read already in flight — defeating the dedup entirely.
    const { read, releases } = pausedRead();
    const t1 = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    await Promise.resolve();
    const t2 = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t2" }], read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2); // different stamps, so not joinable

    releases[0]?.(gate({ probes: [probe()] })); // the OLDER read settles while t2 is still live
    await t1;

    // A third caller at t2 must JOIN the running read, not start a fourth.
    const t2again = fetchProbeGates("/repo", [{ number: 100, updatedAt: "t2" }], read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);

    releases[1]?.(gate({ probes: [] }));
    await Promise.all([t2, t2again]);
  });

  it("degrades a read that returns a NON-THENABLE to unknown, rather than TypeError-ing the batch", async () => {
    // `await` does not throw on a plain value — `return await undefined` resolves to undefined — so
    // the try/catch never sees this. Unhandled, `fetchProbeGates` then dereferenced `gate.probes`
    // and TypeError'd INSIDE the Promise.all, rejecting the whole batch: the exact contract
    // violation the guard is documented to prevent. The docstring claimed this case was covered
    // when it was not.
    const read = (() => undefined) as unknown as (
      r: string,
      n: number,
    ) => Promise<ReturnType<typeof gate>>;
    const out = await fetchProbeGates("/repo", [{ number: 100, updatedAt: "t1" }], read);
    expect(out.size).toBe(1);
    expect(out.get(100)?.probes).toBeUndefined();
    expect(out.get(100)?.applicable).toBe(true);
  });

  it("evictProbeGates drops exactly the PRs it is GIVEN, and nothing else", async () => {
    // The caller supplies the verdict. Two earlier versions re-derived one here and both were a
    // probe rule rather than the RANKING — and that drift is structural, since the cache holds only
    // (root, number) -> gate and can never see the facts that outrank probes. A PR that is
    // conflicting, or unmergeable by this viewer, reports that word and has its drawer suppressed,
    // yet was re-read on every open for a reading no value of which can change its row.
    const a = vi.fn(async () => gate({ probes: [probe()] }));
    const b = vi.fn(async () => gate({ probes: [probe()] }));
    await fetchProbeGates("/repo", [{ number: 1, updatedAt: "t1" }], a);
    await fetchProbeGates("/repo", [{ number: 2, updatedAt: "t1" }], b);

    evictProbeGates([{ root: "/repo", number: 1 }]);

    await fetchProbeGates("/repo", [{ number: 1, updatedAt: "t1" }], a);
    await fetchProbeGates("/repo", [{ number: 2, updatedAt: "t1" }], b);
    expect(a).toHaveBeenCalledTimes(2); // named, so evicted and re-read
    expect(b).toHaveBeenCalledTimes(1); // not named, so still cached
  });

  it("scopes eviction to the ROOT, so two repos' PR #1 never evict each other", async () => {
    const a = vi.fn(async () => gate({ probes: [probe()] }));
    await fetchProbeGates("/repo-a", [{ number: 1, updatedAt: "t1" }], a);
    await fetchProbeGates("/repo-b", [{ number: 1, updatedAt: "t1" }], a);
    expect(a).toHaveBeenCalledTimes(2);

    evictProbeGates([{ root: "/repo-a", number: 1 }]);

    await fetchProbeGates("/repo-a", [{ number: 1, updatedAt: "t1" }], a);
    await fetchProbeGates("/repo-b", [{ number: 1, updatedAt: "t1" }], a);
    expect(a).toHaveBeenCalledTimes(3); // only repo-a re-read
  });

  it("degrades a SYNCHRONOUSLY throwing read to unknown instead of losing the whole batch", async () => {
    // `read` is typed as returning a promise, which a PLAIN function satisfies — and a plain
    // function that throws on the CALL blows up before any `.catch` on its return value exists.
    // That error would reject the batch, discarding every other PR's reading with it.
    const read = vi.fn((_r: string, n: number) => {
      if (n === 101) throw new Error("gh: not found");
      return Promise.resolve(gate({ probes: [probe()] }));
    }) as unknown as (r: string, n: number) => Promise<BabysitProbeGate>;
    const out = await fetchProbeGates(
      "/repo",
      [
        { number: 100, updatedAt: "t1" },
        { number: 101, updatedAt: "t1" },
        { number: 102, updatedAt: "t1" },
      ],
      read,
    );
    expect(out.size).toBe(3);
    expect(out.get(101)?.probes).toBeUndefined(); // unknown, not a rejection
    expect(out.get(100)?.probes).toHaveLength(1); // ...and the siblings survived
    expect(out.get(102)?.probes).toHaveLength(1);
  });
});
