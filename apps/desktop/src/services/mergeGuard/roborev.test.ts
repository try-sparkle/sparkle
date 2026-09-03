import { describe, it, expect, vi, beforeEach } from "vitest";

// A PLAIN-FUNCTION `invoke` double rather than `vi.fn()` — same reason as prClaims.test.ts: under
// this suite's config a `vi.fn()` whose result is a rejected promise has that rejection reported as
// a test error even when the code under test catches it and the assertion passes. The probe's whole
// contract is what it does with a FAILING backend, so the double has to be able to fail without the
// harness calling that a failure.
const calls: Array<[string, unknown]> = [];
let handler: (cmd: string, args: unknown) => unknown = () => undefined;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    calls.push([cmd, args]);
    return handler(cmd, args);
  },
}));

import {
  fetchRoborevProbe,
  fetchRoborevReview,
  bodyCarriesNoFinding,
  summarizeRoborev,
  roborevMergeGate,
  parseRoborevFindings,
  highestSeverity,
  ROBOREV_SEVERITY_RANK,
} from "./roborev";
import type { RoborevJobRow, RoborevProbe } from "./types";

function resetInvoke(): void {
  calls.length = 0;
  handler = () => undefined;
}
function resolvesWith(value: unknown): void {
  handler = () => Promise.resolve(value);
}
function rejectsWith(err: unknown): void {
  handler = () => Promise.reject(err);
}

function job(over: Partial<RoborevJobRow> = {}): RoborevJobRow {
  return {
    id: 1,
    branch: "sparkle/left-pair",
    gitRef: "abc1234",
    status: "done",
    verdict: "P",
    closed: false,
    commitSubject: "a commit",
    finishedAt: "2026-07-29T15:49:04Z",
    ...over,
  };
}

function probe(jobs: RoborevJobRow[] | null, enabled = true, error?: string): RoborevProbe {
  return { enabled, jobs, error: error ?? null };
}

// ---------------------------------------------------------------------------------------------

describe("fetchRoborevProbe — the three states must stay distinguishable", () => {
  beforeEach(resetInvoke);

  it("passes the branch through and returns what Rust answered", async () => {
    const rows = [job()];
    resolvesWith({ enabled: true, jobs: rows });
    await expect(fetchRoborevProbe("/repo", "sparkle/left-pair")).resolves.toEqual({
      enabled: true,
      jobs: rows,
      error: null,
    });
    expect(calls[0]).toEqual([
      "roborev_branch_probe",
      { root: "/repo", branch: "sparkle/left-pair", limit: undefined },
    ]);
  });

  it("keeps an EMPTY job list as an answer, not as an unknown", async () => {
    resolvesWith({ enabled: true, jobs: [] });
    const p = await fetchRoborevProbe("/repo", "b");
    expect(p.jobs).toEqual([]);
    expect(p.jobs).not.toBeNull();
    expect(summarizeRoborev(p).known).toBe(true);
  });

  it("a MISSING command reads as 'roborev is not the gate here', so merges do not wedge", async () => {
    rejectsWith(new Error("Command roborev_branch_probe not found"));
    const p = await fetchRoborevProbe("/repo", "b");
    expect(p.enabled).toBe(false);
    // The consequence that actually matters: the gate becomes a no-op rather than a deadlock.
    expect(roborevMergeGate(summarizeRoborev(p)).canMerge).toBe(true);
  });

  it("a 'not found' that does NOT mean the command is absent still BLOCKS", async () => {
    // The one fail-open branch in the module, and the boundary that was undefended: a bare
    // `not found` match would take "repository not found" — an ordinary daemon failure on a branch
    // where roborev IS the gate — down the disable-the-gate path and merge.
    for (const msg of [
      "repository not found in roborev database",
      "branch not found",
      "job not found",
    ]) {
      rejectsWith(new Error(msg));
      const p = await fetchRoborevProbe("/repo", "b");
      expect(p.enabled, msg).toBe(true);
      expect(roborevMergeGate(summarizeRoborev(p)).canMerge, msg).toBe(false);
    }
  });

  it("an unrecognisable payload fails CLOSED, so a Rust rename cannot silently disable the gate", async () => {
    for (const payload of [{}, { ok: true }, { enabled: "yes" }, { enabled: true }]) {
      resolvesWith(payload);
      const p = await fetchRoborevProbe("/repo", "b");
      expect(p.jobs, JSON.stringify(payload)).toBeNull();
      expect(roborevMergeGate(summarizeRoborev(p)).canMerge, JSON.stringify(payload)).toBe(false);
    }
    // Only an EXPLICIT false turns the gate off.
    resolvesWith({ enabled: false, jobs: null });
    expect(roborevMergeGate(summarizeRoborev(await fetchRoborevProbe("/repo", "b"))).canMerge).toBe(
      true,
    );
  });

  it("a half-readable job list is all-or-nothing — half a list is worse than none", async () => {
    resolvesWith({ enabled: true, jobs: [{ id: 1 }, "junk"] });
    const p = await fetchRoborevProbe("/repo", "b");
    expect(p.jobs).toBeNull();
    expect(roborevMergeGate(summarizeRoborev(p)).code).toBe("roborev-unknown");
  });

  it("ANY OTHER failure is unknown-and-blocking, not a pass", async () => {
    rejectsWith(new Error("daemon connection refused"));
    const p = await fetchRoborevProbe("/repo", "b");
    expect(p).toMatchObject({ enabled: true, jobs: null });
    const v = roborevMergeGate(summarizeRoborev(p));
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-unknown");
  });
});

describe("fetchRoborevReview", () => {
  beforeEach(resetInvoke);

  it("returns the review body", async () => {
    resolvesWith("## Review Findings\n- **Severity**: High");
    await expect(fetchRoborevReview("/repo", 55235)).resolves.toContain("Severity");
    expect(calls[0]).toEqual(["roborev_job_review", { root: "/repo", jobId: 55235 }]);
  });

  it("an unreadable body is null (unread), never '' (clean)", async () => {
    rejectsWith(new Error("no such job"));
    await expect(fetchRoborevReview("/repo", 1)).resolves.toBeNull();
    resolvesWith(undefined);
    await expect(fetchRoborevReview("/repo", 1)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("summarizeRoborev", () => {
  it("buckets in-flight, blocking, errored and open-passing separately", () => {
    const s = summarizeRoborev(
      probe([
        job({ id: 1, status: "queued", verdict: null }),
        job({ id: 2, status: "running", verdict: null }),
        job({ id: 3, status: "done", verdict: "F" }),
        job({ id: 4, status: "done", verdict: "P" }),
        job({ id: 5, status: "failed", verdict: null }),
      ]),
    );
    expect(s.inFlight.map((j) => j.id)).toEqual([1, 2]);
    expect(s.blocking.map((j) => j.id)).toEqual([3]);
    expect(s.errored.map((j) => j.id)).toEqual([5]);
    expect(s.openPassing).toBe(1);
    expect(s.total).toBe(5);
  });

  it("a DONE job with a null verdict is unread, not passing", () => {
    const s = summarizeRoborev(probe([job({ id: 9, status: "done", verdict: null })]));
    expect(s.errored.map((j) => j.id)).toEqual([9]);
    expect(s.openPassing).toBe(0);
    expect(roborevMergeGate(s).code).toBe("roborev-unknown");
  });

  it("an UNRECOGNISED status is unknown, not waved through", () => {
    const s = summarizeRoborev(probe([job({ id: 9, status: "kerplunk" })]));
    expect(s.errored.map((j) => j.id)).toEqual([9]);
    expect(roborevMergeGate(s).canMerge).toBe(false);
  });

  it("a CLOSED fail does not block — roborev close is somebody's judgement", () => {
    const s = summarizeRoborev(probe([job({ id: 3, verdict: "F", closed: true })]));
    expect(s.blocking).toEqual([]);
    expect(s.errored).toEqual([]);
    expect(s.total).toBe(1); // still reported as a row that exists
    expect(roborevMergeGate(s).canMerge).toBe(true);
  });

  it("`closed` is honoured FIRST, for every shape that would otherwise land in `errored`", () => {
    // The previous test could not see this: a done/`F` row was never in `errored` anyway, so it
    // stayed green against an implementation that consulted `closed` only in the `blocking` branch.
    // These rows land in `errored` unless `closed` is honoured FIRST — so if the `closed` check ever
    // moves below the status switch, a finished decision starts blocking the merge again.
    for (const row of [
      job({ id: 1, status: "failed", verdict: null, closed: true }),
      job({ id: 2, status: "done", verdict: null, closed: true }),
      job({ id: 3, status: "running", verdict: null, closed: true }),
      job({ id: 4, status: "cancelled", verdict: null, closed: true }),
    ]) {
      const st = summarizeRoborev(probe([row]));
      expect(st.errored, `job ${row.id} must not be errored once closed`).toEqual([]);
      expect(st.inFlight, `job ${row.id} must not be in flight once closed`).toEqual([]);
      expect(roborevMergeGate(st).canMerge).toBe(true);
    }
  });

  it("an OPEN errored job REFUSES until it is named, and names itself in the refusal", () => {
    const st = summarizeRoborev(probe([job({ id: 1, status: "failed", verdict: null })]));
    const v = roborevMergeGate(st);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-unknown");
    // …and it names the job, so the refusal message can tell the reader WHICH one to act on.
    expect(v.jobIds).toEqual([1]);
  });

  it("an unrecognised VERDICT letter is unknown, not passing", () => {
    const st = summarizeRoborev(probe([job({ id: 9, status: "done", verdict: "X" })]));
    expect(st.errored.map((j) => j.id)).toEqual([9]);
    expect(st.openPassing).toBe(0);
    expect(roborevMergeGate(st).canMerge).toBe(false);
  });

  it("reads verdict case-insensitively", () => {
    expect(summarizeRoborev(probe([job({ verdict: "f" })])).blocking).toHaveLength(1);
    expect(summarizeRoborev(probe([job({ verdict: "p" })])).openPassing).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("roborevMergeGate — the #806 gate", () => {
  it("passes when roborev is not in play", () => {
    expect(roborevMergeGate(summarizeRoborev(probe(null, false))).canMerge).toBe(true);
  });

  it("passes on a branch that answered with no reviews at all", () => {
    expect(roborevMergeGate(summarizeRoborev(probe([]))).canMerge).toBe(true);
  });

  it("REFUSES while a round is in flight — the exact state PR #806 was merged in", () => {
    const s = summarizeRoborev(probe([job({ id: 55235, status: "running", verdict: null })]));
    const v = roborevMergeGate(s);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-pending");
    expect(v.jobIds).toEqual([55235]);
  });

  it("an in-flight round CANNOT be acknowledged away — you cannot waive a verdict that does not exist", () => {
    const s = summarizeRoborev(probe([job({ id: 55235, status: "running", verdict: null })]));
    // The caller names the very job it is trying to waive; the gate must still refuse.
    const v = roborevMergeGate(s, [55235]);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-pending");
  });

  it("refuses over open FAIL verdicts", () => {
    const s = summarizeRoborev(probe([job({ id: 7, verdict: "F" }), job({ id: 8, verdict: "F" })]));
    const v = roborevMergeGate(s);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-unresolved");
    expect(v.jobIds).toEqual([7, 8]);
  });

  it("acknowledging EVERY open fail clears it", () => {
    const s = summarizeRoborev(probe([job({ id: 7, verdict: "F" }), job({ id: 8, verdict: "F" })]));
    expect(roborevMergeGate(s, [7, 8]).canMerge).toBe(true);
  });

  it("a PARTIAL acknowledgement still refuses, naming only what is left", () => {
    const s = summarizeRoborev(probe([job({ id: 7, verdict: "F" }), job({ id: 8, verdict: "F" })]));
    const v = roborevMergeGate(s, [7]);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-unresolved");
    expect(v.jobIds).toEqual([8]);
  });

  it("acknowledging a job that is NOT the one blocking does not help", () => {
    // The subtraction is what stops a blanket override: a round that appeared after the caller read
    // the findings is not covered by what it acknowledged.
    const s = summarizeRoborev(probe([job({ id: 99, verdict: "F" })]));
    const v = roborevMergeGate(s, [7, 8]);
    expect(v.canMerge).toBe(false);
    expect(v.jobIds).toEqual([99]);
  });

  it("shows the probe's OWN words for an unreadable reading, not a guess about the daemon", () => {
    // A saturated row window is a HEALTHY daemon. Reporting "the daemon may be down" sends the
    // reader to debug the wrong thing and discards the one detail they can act on.
    const s = summarizeRoborev(
      probe(null, true, "roborev filled its 50-row window for sparkle/left-pair (50 row(s) returned)"),
    );
    expect(s.error).toContain("50-row window");
    const v = roborevMergeGate(s);
    expect(v.canMerge).toBe(false);
    expect(v.reason).toContain("50-row window");
  });

  it("falls back to a plain reason when the probe offered no words", () => {
    const v = roborevMergeGate(summarizeRoborev(probe(null)));
    expect(v.reason).toContain("could not be read");
  });

  it("acknowledgement cannot clear an unreadable probe either", () => {
    const v = roborevMergeGate(summarizeRoborev(probe(null)), [1, 2, 3]);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-unknown");
  });

  // ── The errored bucket is WAIVABLE, and that is what un-wedges the repo ────────────────────────
  // `roborev_probe.rs` keeps a branchless row that git places on this branch precisely because a
  // crashed row "lands in `errored`, which IS waivable by acknowledgement". That exit did not exist
  // here, so such a row blocked the branch permanently and merges were routed around the gate
  // entirely with `gh pr merge` — discarding the genuine FAILs along with it.

  it("naming EVERY errored job clears it — the exit the probe's attribution comment promises", () => {
    const s = summarizeRoborev(
      probe([
        job({ id: 59204, status: "failed", verdict: null }),
        job({ id: 59203, status: "done", verdict: null }),
      ]),
    );
    expect(roborevMergeGate(s).canMerge, "unnamed, it must refuse").toBe(false);
    expect(roborevMergeGate(s, [59204, 59203]).canMerge).toBe(true);
  });

  it("a PARTIAL acknowledgement of errored jobs still refuses, naming only what is left", () => {
    const s = summarizeRoborev(
      probe([
        job({ id: 59204, status: "failed", verdict: null }),
        job({ id: 59203, status: "failed", verdict: null }),
      ]),
    );
    const v = roborevMergeGate(s, [59204]);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-unknown");
    expect(v.jobIds).toEqual([59203]);
  });

  it("naming an errored job does NOT waive a real FAIL that is still open", () => {
    // The waiver is per-id subtraction, not a mode: clearing the unreadable row hands the branch to
    // step 5, which is the one that actually judges verdicts.
    const s = summarizeRoborev(
      probe([job({ id: 1, status: "failed", verdict: null }), job({ id: 2, verdict: "F" })]),
    );
    const v = roborevMergeGate(s, [1]);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-unresolved");
    expect(v.jobIds).toEqual([2]);
  });

  it("naming an errored job does NOT waive an in-flight round", () => {
    const s = summarizeRoborev(
      probe([job({ id: 1, status: "failed", verdict: null }), job({ id: 2, status: "running", verdict: null })]),
    );
    const v = roborevMergeGate(s, [1, 2]);
    expect(v.canMerge).toBe(false);
    expect(v.code).toBe("roborev-pending");
  });

  it("pending outranks unresolved, so the caller is told to WAIT rather than to go read", () => {
    const s = summarizeRoborev(
      probe([job({ id: 1, status: "running", verdict: null }), job({ id: 2, verdict: "F" })]),
    );
    expect(roborevMergeGate(s).code).toBe("roborev-pending");
  });
});

// ---------------------------------------------------------------------------------------------

describe("parseRoborevFindings", () => {
  it("parses a real multi-finding review body", () => {
    const body = [
      "## Review Findings",
      "",
      "- **Severity**: Medium",
      "- **Location**: `apps/desktop/src/components/fontTokens.test.ts:261`",
      "- **Problem**: The interpolation evasion is closed for one form but not the other.",
      "- **Fix**: Make the walk template-aware.",
      "",
      "---",
      "",
      "- **Severity**: High",
      "- **Location**: `apps/desktop/src/services/openPrs.ts:70`",
      "- **Problem**: A pending rollup is treated as passing.",
      "",
      "## Summary",
      "One sentence.",
    ].join("\n");
    const f = parseRoborevFindings(body);
    expect(f).toHaveLength(2);
    expect(f[0]!.severity).toBe("medium");
    expect(f[0]!.location).toContain("fontTokens.test.ts:261");
    expect(f[0]!.problem).toContain("interpolation evasion");
    expect(f[1]!.severity).toBe("high");
    expect(highestSeverity(f)).toBe("high");
  });

  it("a clean review is [] — 'No issues found.' is not a finding", () => {
    expect(parseRoborevFindings("No issues found.\n\nSummary: all good.")).toEqual([]);
  });

  /* bodyCarriesNoFinding — the predicate that stops a FAIL verdict with NOTHING IN IT blocking a
   *  merge. The verdict is derived inside a prebuilt binary we cannot patch, and it is
   *  INTERMITTENTLY wrong: measured in the live review store, 1,649 bodies carry
   *  SEVERITY_THRESHOLD_MET and 74 of those were recorded F, with 11 open and blocking at the time
   *  of writing. So the repo-side fix is to stop treating a bare verdict === "F" as blocking
   *  without reading what the review actually says.
   *
   *  IT IS A SAFETY GATE, so every arm below fails CLOSED: the only way to reach `true` is to
   *  PROVE the body carries no finding. Unreadable, empty, unrecognised — all keep blocking. */
  describe("bodyCarriesNoFinding", () => {
    it("the measured empty-merge body is provably no-finding", () => {
      // 788 occurrences all-time, 54 since 2026-08-01 — the single most common wasted review.
      expect(
        bodyCarriesNoFinding(
          "The diff is empty — this is a merge commit with no changes to review.\n\nSEVERITY_THRESHOLD_MET",
        ),
      ).toBe(true);
    });

    it("the threshold sentinel and a clean review are both no-finding", () => {
      expect(bodyCarriesNoFinding("SEVERITY_THRESHOLD_MET")).toBe(true);
      expect(bodyCarriesNoFinding("No issues found.\n\nSummary: all good.")).toBe(true);
    });

    it("an agent SESSION-STATUS body is no-finding — the job ran the wrong prompt", () => {
      // Verbatim shapes from the store: the review job executed a resume/status prompt and the
      // session's own status report was stored as the review body.
      expect(
        bodyCarriesNoFinding(
          "Working: **yes** — branch sparkle/agent-9261ee4d; task = roborev code review of commit de93136",
        ),
      ).toBe(true);
      expect(bodyCarriesNoFinding("NOTHING TO COMMIT")).toBe(true);
      expect(
        bodyCarriesNoFinding(
          "Review-only session (roborev invoked me to review 2027d5c); I didn't commit, push or open a PR.",
        ),
      ).toBe(true);
    });

    /* THE PAIRED HALF, and the one that matters. Every case above makes the gate MORE permissive,
     *  so on its own it is satisfied by a predicate that returns true unconditionally. These pin
     *  that a real finding still blocks. */
    it("a real finding still blocks, even beside the sentinel", () => {
      const real =
        "## Review Findings\n\n- **Severity**: High\n- **Location**: `src/a.ts:10`\n- **Problem**: leaks a credential\n";
      expect(bodyCarriesNoFinding(real)).toBe(false);
      // A body carrying BOTH a real finding and the sentinel is a finding. Order must not matter.
      expect(bodyCarriesNoFinding(`${real}\nSEVERITY_THRESHOLD_MET`)).toBe(false);
      expect(bodyCarriesNoFinding(`SEVERITY_THRESHOLD_MET\n\n${real}`)).toBe(false);
    });

    it("unreadable, empty and unrecognised bodies all keep blocking", () => {
      // null is "we could not read the review", which is a DIFFERENT fact from a clean review —
      // the same distinction the reporting path already draws with `findings: null`.
      expect(bodyCarriesNoFinding(null)).toBe(false);
      // undefined too, and not merely for tidiness: `fetchRoborevReview` exists because a Tauri
      // invoke can return a non-string, and a predicate that THREW here would crash the merge path
      // from inside a safety check. Caught by six existing merge tests when it did exactly that.
      expect(bodyCarriesNoFinding(undefined)).toBe(false);
      expect(bodyCarriesNoFinding("")).toBe(false);
      expect(bodyCarriesNoFinding("   \n  \n")).toBe(false);
      // Prose with no finding fields AND no recognised sentinel is not proof of anything. The
      // parser alone would return [] here, which is exactly why the sentinel is also required.
      expect(bodyCarriesNoFinding("the reviewer could not reach the model")).toBe(false);
      expect(bodyCarriesNoFinding("Permission denied reading the diff.")).toBe(false);
    });

    it("the sentinel must stand alone on its line, not appear inside prose about it", () => {
      expect(
        bodyCarriesNoFinding("This review does not emit SEVERITY_THRESHOLD_MET because it found a bug"),
      ).toBe(false);
    });
  });

  it("empty or whitespace-only input is []", () => {
    expect(parseRoborevFindings("")).toEqual([]);
    expect(parseRoborevFindings("   \n  \n")).toEqual([]);
  });

  it("reads severity case-insensitively", () => {
    const f = parseRoborevFindings("- **Severity**: HIGH\n- **Problem**: x");
    expect(f[0]!.severity).toBe("high");
  });

  it("keeps a finding whose severity is UNREADABLE rather than dropping it", () => {
    // Losing the worst-understood finding is the failure this guards: an ungradeable finding must
    // still show up, and must not be graded as harmless.
    const f = parseRoborevFindings("- **Severity**: spicy\n- **Problem**: something is wrong");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("unknown");
  });

  it("keeps a finding with NO severity line at all", () => {
    const f = parseRoborevFindings("- **Location**: `a.ts:1`\n- **Problem**: it breaks");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("unknown");
    expect(f[0]!.problem).toContain("it breaks");
  });

  it("missing Location/Problem become null, not empty strings", () => {
    const f = parseRoborevFindings("- **Severity**: Low");
    expect(f).toHaveLength(1);
    expect(f[0]!.location).toBeNull();
    expect(f[0]!.problem).toBeNull();
  });

  it("prose with no finding fields yields nothing", () => {
    expect(parseRoborevFindings("I looked at the diff and it seemed fine to me.")).toEqual([]);
  });
});

describe("severity ranking", () => {
  it("ranks UNKNOWN as high as high — an unreadable severity is not a low one", () => {
    expect(ROBOREV_SEVERITY_RANK.unknown).toBe(ROBOREV_SEVERITY_RANK.high);
    expect(highestSeverity([{ severity: "low", location: null, problem: null }, { severity: "unknown", location: null, problem: null }])).toBe(
      "unknown",
    );
  });

  it("orders high > medium > low", () => {
    expect(ROBOREV_SEVERITY_RANK.high).toBeGreaterThan(ROBOREV_SEVERITY_RANK.medium);
    expect(ROBOREV_SEVERITY_RANK.medium).toBeGreaterThan(ROBOREV_SEVERITY_RANK.low);
  });

  it("is null for no findings", () => {
    expect(highestSeverity([])).toBeNull();
  });
});
