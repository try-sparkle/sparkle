// The REVIEW domain (concierge PRD section H).
//
// The invariants worth guarding here are not "does it shell out to roborev" — they are the ones
// that decide whether the ANSWER CAN BE BELIEVED:
//
//   • a read that could not reach roborev is never reported as "no findings";
//   • a repo roborev has never reviewed is never reported as a clean one;
//   • a close never happens without a recorded rationale;
//   • a truncated page never reads as a complete one.
//
// Each of those is a way this surface could tell a human their code is fine when nobody has looked.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  REVIEW_OPS,
  REVIEW_RISK,
  REVIEW_REFUSALS,
  parseFindings,
  extractReviewText,
  listFindings,
  getFinding,
  closeFinding,
} from "./review";

const invokeMock = vi.mocked(invoke);
const REPO = "/repo";

/** roborev's list payload, shaped the way the CLI emits it (numeric id, snake_case keys). */
function listOut(rows: unknown[], over: Record<string, unknown> = {}) {
  return { branch: "sparkle/agent-1", limit: 25, json: JSON.stringify(rows), ...over };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(listOut([]));
});

// ---------------------------------------------------------------------------------------------

describe("the risk map is the policy input", () => {
  it("classifies every op, and only the write is above read-only", () => {
    expect(Object.keys(REVIEW_RISK).sort()).toEqual([...REVIEW_OPS].sort());
    expect(REVIEW_RISK.list_findings).toBe("read-only");
    expect(REVIEW_RISK.get_finding).toBe("read-only");
  });

  // `close_finding` destroys reviewer signal, so it must NOT derive to `allow`. The policy layer
  // maps read-only/routine → allow and everything else → ask, so the property to hold is that this
  // op is neither of the two permissive words. Asserted as "not permissive" rather than pinning the
  // exact word, so re-classifying disruptive↔irreversible stays a free choice while downgrading it
  // to routine fails here.
  it("keeps close_finding out of the tiers that derive to `allow`", () => {
    expect(["read-only", "routine"]).not.toContain(REVIEW_RISK.close_finding);
  });
});

// ---------------------------------------------------------------------------------------------
// SCOPE. roborev's store is machine-wide; the useful question never is.
// ---------------------------------------------------------------------------------------------

describe("reads are scoped, not machine-wide", () => {
  it("sends the repo and lets Rust resolve the current branch when none is named", async () => {
    await listFindings(REPO);

    const [cmd, args] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe("roborev_list_findings");
    // `branch: null` is what makes Rust resolve HEAD. Sending nothing at all, or a guessed branch,
    // is what would silently widen or mis-scope the read.
    expect(args).toMatchObject({ repo: REPO, branch: null });
  });

  it("forwards an explicitly named branch instead", async () => {
    await listFindings(REPO, { branch: "main" });
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ branch: "main" });
  });

  // The branch is part of the ANSWER. "No open findings" means nothing without saying on what, and
  // an empty list carries no row to infer it from.
  it("returns the branch that was actually read, even when nothing was found", async () => {
    invokeMock.mockResolvedValue(listOut([], { branch: "sparkle/agent-xyz" }));

    const r = await listFindings(REPO);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.branch).toBe("sparkle/agent-xyz");
    expect(r.ok && r.data.findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// THE FOUR STATES THAT ARE NOT BUGS — and must not read as each other.
// ---------------------------------------------------------------------------------------------

describe("an unreachable roborev is never reported as a clean repo", () => {
  // THE ONE THAT MATTERS MOST. roborev is a CLI over a local daemon: with the daemon stopped every
  // read fails identically, however healthy the install. Reporting that as an empty list tells a
  // human their branch is clear when nothing was able to look.
  it("reports a stopped daemon as its own code, and says it cannot see", async () => {
    invokeMock.mockRejectedValue(new Error("roborev-daemon-down: failed to connect to daemon"));

    const r = await listFindings(REPO);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.daemonDown);
    expect(!r.ok && r.message).toMatch(/can't see|daemon/i);
  });

  // The remedy is an instruction the reader will run, so it must not prescribe the very command that
  // CAUSES the fault. `roborev daemon start` is broken on this macOS (needs setsid) and each failed
  // attempt leaves an orphan daemon on launchd's bare PATH that answers "healthy" while reaching no
  // review agent — review goes dark silently (bead sparkle-wtiu7m). The safe restart hands the port
  // back to launchd, whose plist carries the full PATH. This assertion FAILS the moment the remedy
  // reverts to the bare `roborev daemon start` prescription.
  it("prescribes the launchd restart, never the bare `roborev daemon start` that orphans the daemon", async () => {
    invokeMock.mockRejectedValue(new Error("roborev-daemon-down: failed to connect to daemon"));

    const r = await listFindings(REPO);
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.message : "";
    // Must route the restart through launchd (correct PATH), matching pipeline_health's remedy.
    expect(msg).toContain("launchctl kickstart -k gui/$(id -u)/co.plow.roborev-daemon");
    // Must NOT tell the reader to run the broken command that manufactures the bare-PATH orphan.
    // (A bare `roborev daemon start`; the string is allowed only inside an explicit "Do NOT" warning.)
    expect(msg).not.toMatch(/`roborev daemon start` fixes it/);
    expect(msg).toMatch(/Do NOT run `roborev daemon start`/);
  });

  // A repo roborev has never tracked returns an EMPTY ARRAY from `roborev list`, which is
  // indistinguishable from "registered, nothing open" — Rust probes registration to tell them
  // apart. The two answers mean opposite things: "you're clear" vs "nothing has ever looked".
  it("reports an untracked repo as unregistered, not as zero findings", async () => {
    invokeMock.mockRejectedValue(
      new Error("roborev-unregistered: roborev has never reviewed anything in /repo"),
    );

    const r = await listFindings(REPO);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.unregistered);
    expect(!r.ok && r.message).toMatch(/never/i);
  });

  it("reports a missing binary as the supported state it is", async () => {
    invokeMock.mockRejectedValue(new Error("roborev-missing: the roborev binary isn't installed"));

    const r = await listFindings(REPO);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.missing);
    expect(!r.ok && r.message).toMatch(/optional|works without/i);
  });

  it("reports a detached HEAD as needing a branch, not as a failure", async () => {
    invokeMock.mockRejectedValue(new Error("roborev-detached-head: no current branch"));

    const r = await listFindings(REPO);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.detachedHead);
  });

  // Each remedy is DIFFERENT, which is the whole reason these are four codes and not one. A caller
  // told "roborev is unavailable" cannot say which of four things to do about it.
  it.each([
    [REVIEW_REFUSALS.missing, "roborev-missing: x"],
    [REVIEW_REFUSALS.daemonDown, "roborev-daemon-down: x"],
    [REVIEW_REFUSALS.unregistered, "roborev-unregistered: x"],
    [REVIEW_REFUSALS.timeout, "roborev-timeout: x"],
  ] as const)("%s carries a remedy of its own", async (code, raw) => {
    invokeMock.mockRejectedValue(new Error(raw));
    const r = await listFindings(REPO);
    expect(!r.ok && r.reason).toBe(code);
    expect(!r.ok && r.message.length).toBeGreaterThan(20);
  });

  // An unrecognised failure keeps roborev's own words rather than being dressed as one of ours.
  it("does not guess at an unknown failure", async () => {
    invokeMock.mockRejectedValue(new Error("something nobody has seen"));

    const r = await listFindings(REPO);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.failed);
    expect(!r.ok && r.message).toMatch(/something nobody has seen/);
  });
});

// ---------------------------------------------------------------------------------------------
// PARSING. roborev is a separately versioned binary; its JSON is not ours to assume.
// ---------------------------------------------------------------------------------------------

describe("roborev's JSON is read defensively", () => {
  it("normalizes the CLI's own shape, including a NUMERIC id", async () => {
    invokeMock.mockResolvedValue(
      listOut([
        {
          id: 46911,
          branch: "sparkle/agent-1",
          git_ref: "a088195c9",
          commit_subject: "fix(concierge): take the menu nearest the prompt",
          status: "done",
          verdict: "fail",
          agent: "claude",
          enqueued_at: "2026-07-29 10:00:00",
        },
      ]),
    );

    const r = await listFindings(REPO);
    expect(r.ok && r.data.findings[0]).toEqual({
      // An id is an IDENTIFIER, not a quantity — a caller doing arithmetic on it has already erred.
      id: "46911",
      ref: "a088195c9",
      // POPULATED, not the empty default (roborev 55421). Asserting `""` was true of a
      // `normalizeFinding` that reads the wrong keys, reads none, or hardcodes the fallback — it
      // pinned the default instead of the mapping, on the one field review.ts calls load-bearing
      // ("what lets a human recognise WHICH commit is being talked about; a bare sha does not").
      commitSubject: "fix(concierge): take the menu nearest the prompt",
      status: "done",
      verdict: "FAIL",
      agent: "claude",
      enqueuedAt: "2026-07-29 10:00:00",
    });
  });

  // NO PER-ROW `branch`, deliberately — the module's own header says why: roborev leaves that column
  // empty on every row observed live, and an always-blank field invites the caller to report
  // "branch: (blank)". The branch is RESOLVED once and returned with the list, and every row is on
  // it by construction because the query filtered on it. Pinned here because the row shape above
  // would otherwise look like an omission rather than a decision.
  it("puts the branch on the LIST, never on the row", async () => {
    invokeMock.mockResolvedValue(
      listOut([{ id: 1, branch: "sparkle/agent-1", git_ref: "abc", status: "done", verdict: "fail" }]),
    );

    const r = await listFindings(REPO);

    // The branch `listOut` reports — resolved by Rust, not read off a row.
    expect(r.ok && r.data.branch).toBe("sparkle/agent-1");
    expect(r.ok && r.data.findings[0]).not.toHaveProperty("branch");
  });

  it("reads the camelCase spellings too", () => {
    const [row] = parseFindings(
      JSON.stringify([
        { jobId: 7, gitRef: "abc", commitSubject: "docs: a camelCase subject", enqueuedAt: "t", verdictBool: true },
      ]),
    );
    expect(row).toMatchObject({
      id: "7",
      ref: "abc",
      commitSubject: "docs: a camelCase subject",
      enqueuedAt: "t",
      verdict: "PASS",
    });
  });

  // A review still RUNNING has no verdict, and defaulting that to a pass is the worst available
  // mistake: it reports an unjudged change as reviewed and clean.
  it("reports an unjudged review as null, never as a pass", () => {
    const [row] = parseFindings(JSON.stringify([{ id: 1, status: "running" }]));
    expect(row!.verdict).toBeNull();
  });

  it("reads verdict_bool false as FAIL", () => {
    const [row] = parseFindings(JSON.stringify([{ id: 1, verdict_bool: false }]));
    expect(row!.verdict).toBe("FAIL");
  });

  it("tolerates an empty body and a `{ jobs: [...] }` envelope", () => {
    expect(parseFindings("")).toEqual([]);
    expect(parseFindings("null")).toEqual([]);
    expect(parseFindings(JSON.stringify({ jobs: [{ id: 3 }] }))).toHaveLength(1);
  });

  // AN UNREADABLE ANSWER IS NOT AN EMPTY ONE. A parser that swallowed this would report "no
  // findings" for output it simply could not understand — the same false reassurance as the
  // daemon-down case, arriving by a different route.
  it("refuses unreadable output instead of returning an empty list", async () => {
    invokeMock.mockResolvedValue(listOut([], { json: "not json at all" }));

    const r = await listFindings(REPO);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.unreadable);
  });

  it("refuses a JSON shape that is not a list of reviews", async () => {
    invokeMock.mockResolvedValue(listOut([], { json: '{"error":"nope"}' }));

    const r = await listFindings(REPO);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.unreadable);
  });
});

// ---------------------------------------------------------------------------------------------
// TRUNCATION. A partial page described as the whole answer is a confident, wrong claim.
// ---------------------------------------------------------------------------------------------

describe("a truncated page says so", () => {
  it("is not capped when the page is short of the cap", async () => {
    invokeMock.mockResolvedValue(listOut([{ id: 1 }, { id: 2 }], { limit: 25 }));

    const r = await listFindings(REPO);
    expect(r.ok && r.data.capped).toBe(false);
  });

  it("is capped when the page is full", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i + 1 }));
    invokeMock.mockResolvedValue(listOut(rows, { limit: 3 }));

    const r = await listFindings(REPO);
    expect(r.ok && r.data.capped).toBe(true);
  });

  // THE CAP IS RUST'S, NOT THE CALLER'S. Rust clamps a hallucinated `limit: 5000` down to its own
  // ceiling and reports the cap it applied. Comparing the row count against what the CALLER asked
  // for would report a truncated page as complete — silent truncation, which is exactly what the
  // flag exists to prevent.
  it("measures against the cap Rust applied, not the one that was asked for", async () => {
    // 25 is Rust's MAX_LIMIT — the cap it ACTUALLY applies. Using a number Rust could never
    // report would make this fixture describe a world that cannot happen.
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
    invokeMock.mockResolvedValue(listOut(rows, { limit: 25 }));

    const r = await listFindings(REPO, { limit: 5000 });
    expect(r.ok && r.data.capped).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// get_finding
// ---------------------------------------------------------------------------------------------

describe("get_finding", () => {
  it("returns the review text for an id", async () => {
    invokeMock.mockResolvedValue("Finding: the assertion is vacuous.");

    const r = await getFinding(REPO, "46911");
    expect(invokeMock).toHaveBeenCalledWith("roborev_show_finding", { repo: REPO, id: "46911" });
    expect(r.ok && r.data.review).toMatch(/vacuous/);
  });

  // The valuable part of a finding is the PROSE. Handing back the `--json` envelope would make the
  // model re-parse JSON to reach the one string it wanted, and pay for the rest of the envelope in
  // context permanently.
  it("unwraps the --json envelope to the review prose", async () => {
    invokeMock.mockResolvedValue(
      JSON.stringify({ job_id: 46911, output: "Finding: the assertion is vacuous.", agent: "claude" }),
    );

    const r = await getFinding(REPO, "46911");
    expect(r.ok && r.data.review).toBe("Finding: the assertion is vacuous.");
  });

  // An envelope this build cannot read is NOT dangerous here — unlike the list path, the raw text
  // still contains the review, so returning it is degraded but honest. Refusing would withhold an
  // answer that is sitting right there.
  it("falls back to the raw body rather than withholding an unreadable envelope", () => {
    expect(extractReviewText('{"unexpected": 1}')).toBe('{"unexpected": 1}');
    expect(extractReviewText("{not json")).toBe("{not json");
    expect(extractReviewText("  plain prose  ")).toBe("plain prose");
  });

  it("refuses a blank id rather than asking roborev about nothing", async () => {
    const r = await getFinding(REPO, "  ");
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.badArgs);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("classifies a daemon failure the same way the list op does", async () => {
    invokeMock.mockRejectedValue(new Error("roborev-daemon-down: nope"));

    const r = await getFinding(REPO, "46911");
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.daemonDown);
  });
});

// ---------------------------------------------------------------------------------------------
// close_finding — THE ONE WRITE.
// ---------------------------------------------------------------------------------------------

describe("closing a finding records why", () => {
  // A finding closed with no comment is indistinguishable from one dismissed unread. That is the
  // state AGENTS.md's "close any Low with a stated rationale" exists to prevent, and a blank
  // rationale would SUCCEED at roborev — so the refusal has to happen before the call.
  it.each(["", "   "])("refuses a blank rationale (%p) before calling roborev", async (blank) => {
    const r = await closeFinding(REPO, "46911", blank);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.badArgs);
    expect(!r.ok && r.message).toMatch(/rationale/i);
    // The assertion that matters: nothing was closed.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a blank id before calling roborev", async () => {
    const r = await closeFinding(REPO, " ", "fixed in the same PR");
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.badArgs);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("passes the rationale through so roborev can record it", async () => {
    invokeMock.mockResolvedValue(undefined);

    const r = await closeFinding(REPO, "46911", "  fixed in the same PR  ");

    expect(invokeMock).toHaveBeenCalledWith("roborev_close_finding", {
      repo: REPO,
      id: "46911",
      rationale: "  fixed in the same PR  ",
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toEqual({ id: "46911", rationale: "fixed in the same PR" });
  });

  // A failed close is a REFUSAL, not a success with a sad message. Reporting it as ok would leave
  // the concierge telling the human a finding is resolved while it is still open and still gating.
  it("reports a failed close as a refusal", async () => {
    invokeMock.mockRejectedValue(new Error("roborev-daemon-down: nope"));

    const r = await closeFinding(REPO, "46911", "declined: covered by the new test");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(REVIEW_REFUSALS.daemonDown);
  });

  it("carries the write's risk on the refusal, not a read's", async () => {
    const r = await closeFinding(REPO, "46911", "");
    expect(r.risk).toBe(REVIEW_RISK.close_finding);
  });
});
