// THE SILENCE THAT COST TEN DAYS (bead sparkle-v38y1n).
//
// The unattended fast-forward refused every 60 seconds for ten days and said nothing, so the shared
// checkout reached 1,175 commits behind with no escalation ever produced. These tests pin the four
// properties that stop that recurring, and each is written so that it FAILS against the behaviour
// that shipped: escalate at all, escalate ONCE, name the exact path, and never say "dirty tree".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaleDiagnosis } from "./staleness";
import {
  DECLINES_BEFORE_ESCALATION,
  buildStalenessNotice,
  noteStaleDecline,
  noteStaleResolved,
  resetStalenessEscalation,
  stalenessDeclines,
  subscribeStalenessNotices,
} from "./stalenessEscalation";

function diag(over: Partial<StaleDiagnosis> = {}): StaleDiagnosis {
  return {
    behind: 1175,
    base: "origin/main",
    headBranch: "main",
    defaultBranch: "main",
    detached: false,
    linkedWorktree: false,
    heldBy: "",
    dirtyCount: 5,
    dirtySample: ["NOTES.md", ".sparkle/config.toml", "images/a.png"],
    blockingPaths: [".sparkle/config.toml"],
    blockersKnown: true,
    canFastForward: true,
    remedy: "fast-forward-dirty",
    cause: "1175 commit(s) behind origin/main; the fast-forward is blocked by .sparkle/config.toml",
    autoSafe: false,
    unknown: false,
    ...over,
  };
}

let errors: string[] = [];

beforeEach(() => {
  resetStalenessEscalation();
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStalenessEscalation();
});

describe("the consecutive-decline counter", () => {
  // (e) THE HEADLINE PROPERTY, both halves. A notice that repeats every minute gets muted, and a
  // muted notice is the silence we started from — so N declines produce EXACTLY ONE escalation, and
  // the (N+1)th and beyond produce none.
  it("escalates exactly once per streak, however long the streak runs", () => {
    const seen: string[] = [];
    const off = subscribeStalenessNotices((n) => seen.push(n.message));

    for (let i = 1; i < DECLINES_BEFORE_ESCALATION; i++) {
      expect(noteStaleDecline("/repos/sparkle", { diagnosis: diag() })).toBeNull();
    }
    // The Nth is the one that speaks.
    const notice = noteStaleDecline("/repos/sparkle", { diagnosis: diag() });
    expect(notice).not.toBeNull();
    expect(notice?.declines).toBe(DECLINES_BEFORE_ESCALATION);

    // Ten more polls' worth of the same wedge. NOT a second word about it.
    for (let i = 0; i < 10; i++) {
      expect(noteStaleDecline("/repos/sparkle", { diagnosis: diag() })).toBeNull();
    }
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(1);
    // ...and the count kept climbing underneath, so the streak is still measurable.
    expect(stalenessDeclines("/repos/sparkle")).toBe(DECLINES_BEFORE_ESCALATION + 10);
    off();
  });

  // The other half of (e): a success RESETS, and a wedge that comes back is announced again. Without
  // this the module would speak once per app run and then be silent forever — the same bug in a
  // slower costume.
  it("resets on a resolution, and a returning wedge escalates again", () => {
    const seen: string[] = [];
    const off = subscribeStalenessNotices((n) => seen.push(n.message));

    for (let i = 0; i < DECLINES_BEFORE_ESCALATION; i++) {
      noteStaleDecline("/repos/sparkle", { diagnosis: diag() });
    }
    expect(seen).toHaveLength(1);

    noteStaleResolved("/repos/sparkle");
    expect(stalenessDeclines("/repos/sparkle")).toBe(0);

    for (let i = 0; i < DECLINES_BEFORE_ESCALATION; i++) {
      noteStaleDecline("/repos/sparkle", { diagnosis: diag() });
    }
    // A wedge that comes back is a new streak and is said again.
    expect(seen).toHaveLength(2);
    off();
  });

  // One checkout's streak must not be advanced by another's declines, or a machine with several
  // projects open would escalate the wrong one after a third of the wait.
  it("counts each root separately", () => {
    for (let i = 0; i < DECLINES_BEFORE_ESCALATION - 1; i++) {
      noteStaleDecline("/repos/a", { diagnosis: diag() });
      noteStaleDecline("/repos/b", { diagnosis: diag() });
    }
    expect(errors).toHaveLength(0);
    expect(noteStaleDecline("/repos/a", { diagnosis: diag() })).not.toBeNull();
    expect(stalenessDeclines("/repos/b")).toBe(DECLINES_BEFORE_ESCALATION - 1);
  });

  // A single blip is not a wedge. Somebody saving a file for thirty seconds must not produce a
  // notice, or the notice is noise and gets muted — which is how this ends up silent again.
  it("says nothing about a lone decline", () => {
    expect(noteStaleDecline("/repos/sparkle", { diagnosis: diag() })).toBeNull();
    expect(errors).toHaveLength(0);
  });
});

describe("what the notice says", () => {
  const escalate = (d: Parameters<typeof noteStaleDecline>[1]) => {
    let last = null;
    for (let i = 0; i < DECLINES_BEFORE_ESCALATION; i++) last = noteStaleDecline("/r", d);
    return last!;
  };

  // THE WHOLE POINT. "Dirty tree" is what the old path could have said and it is not actionable:
  // of five dirty entries on the founder's checkout exactly ONE was in the way. The notice names
  // that one, and does not send the reader after the four that block nothing.
  it("names the exact blocking path, the commits behind, and the cause", () => {
    const n = escalate({ diagnosis: diag() });
    expect(n.kind).toBe("blocked-by-local-work");
    expect(n.message).toContain(".sparkle/config.toml");
    expect(n.message).toContain("1,175 commits behind origin/main");
    expect(n.message).toContain("blocked by .sparkle/config.toml"); // the cause, verbatim
    expect(n.blockingPaths).toEqual([".sparkle/config.toml"]);
    // The dirt that blocks nothing is NOT presented as the thing to go and fix.
    expect(n.message).not.toContain("NOTES.md");
    expect(n.message).not.toContain("images/a.png");
    expect(n.message.toLowerCase()).not.toContain("dirty tree");
  });

  // git's own refusal text beats our cause when we have it — `remedy_at` already peels it out of the
  // wrapped error with `git_words()`, and it names the file more accurately than any pre-check.
  it("prefers the backend's refusal text verbatim over the diagnosis cause", () => {
    const reason =
      "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts";
    const n = escalate({ diagnosis: diag(), reason });
    expect(n.detail).toBe(reason);
    expect(n.message).toContain(reason);
  });

  // A HELD LEASE IS A WAIT, NOT A CHORE. Merging under a live agent is bead sparkle-jgctmg (P1,
  // SEV4, four clobbering incidents), so declining is correct — and the notice has to say that,
  // or someone acts on it and does the exact damage the decline prevented.
  //
  // DRIVEN FROM THE DIAGNOSIS, which is the half of this that the backend actually produces
  // (roborev 66891). `remedy: "blocked-held-elsewhere"` is a real field off a real arm —
  // `repo_freshness.rs` arm 6a, where a linked worktree's branch is checked out somewhere else —
  // so this pins the reachable path rather than a sentence with no producer.
  it("says a live session holds the worktree, and that propagation waits for a natural respawn", () => {
    const n = escalate({
      diagnosis: diag({
        remedy: "blocked-held-elsewhere",
        blockingPaths: [],
        dirtyCount: 0,
        dirtySample: [],
        heldBy: "/wt/other-session",
        detached: true,
        // The cause arm 6a actually writes. Left as `diag()`'s default it would tail a
        // blocking-path sentence onto a notice whose whole point is that no path is the reason —
        // a fixture the backend cannot produce, asserting something it therefore cannot pin.
        cause:
          "this checkout is a linked worktree with a DETACHED HEAD; `main` is held by " +
          "/wt/other-session, so it can never track a branch",
      }),
    });
    expect(n.kind).toBe("held-by-a-live-session");
    expect(n.message).toContain("live session holds this worktree");
    expect(n.message).toContain("respawn naturally");
    expect(n.message).toContain("nothing to do here");
    // It must NOT read as a file to go and move: the thing in the way is a running session, and
    // sending someone to commit a path here is how they end up editing under a live agent.
    expect(n.blockingPaths).toEqual([]);
    expect(n.message).not.toContain(".sparkle/config.toml");
  });

  // THE SECOND LEASE ROUTE IS A GUARD, AND THIS TEST SAYS SO RATHER THAN PRETENDING OTHERWISE.
  //
  // `mentionsALiveLease` also reads the refusal STRING. Nothing on the staleness path produces that
  // string today: `reason` here is a `RemedyOutcome.reason`, i.e. git's own words or the
  // diagnosis's `cause`, and neither carries the park's `in-use` token — that token comes from the
  // Rust park path (`ParkOutcome::declined("in-use")`, `worktree.rs`) and reaches the UI through
  // `improvementPass`'s `refusalDetail`. So the previous version of this test fabricated a sentence
  // and then asserted the sentence, which proved nothing about any shipped code path (roborev
  // 66891).
  //
  // What is worth pinning is the CAPABILITY the guard exists for, in both directions: a lease-shaped
  // refusal must never be dressed up as a file someone should go and move, and ordinary prose that
  // merely contains the letters must never be dressed up as a lease. Both are about what the reader
  // is sent off to DO, which is the part that can cause damage — not about the wording.
  it("never turns a lease-shaped refusal into a file to go and move, or prose into a lease", () => {
    const held = escalate({ diagnosis: diag(), reason: "park refused: in-use" });
    expect(held.kind).toBe("held-by-a-live-session");
    expect(held.blockingPaths).toEqual([]);
    expect(held.message).not.toContain(".sparkle/config.toml");

    resetStalenessEscalation();
    // The token is matched as a TOKEN. A substring match would fire on ordinary prose and tell
    // someone to sit and wait for a respawn that is never coming — and the same diagnosis DOES name
    // its blocking path, so this half also proves the arm above was not simply unreachable.
    const prose = escalate({ diagnosis: diag(), reason: "the file is in-user-config and differs" });
    expect(prose.kind).toBe("blocked-by-local-work");
    expect(prose.blockingPaths).toEqual([".sparkle/config.toml"]);
  });

  // Fail-closed reaches the wording. An intersection we could not compute must never be reported as
  // "nothing is in the way" — that is the sentence that would send someone away reassured.
  it("distinguishes an unknown blocking set from an unknown reason", () => {
    // WE HAVE A DIAGNOSIS and could not work out which changes collide. Its empty `blockingPaths`
    // is "we did not look" — reporting that as "nothing is in the way" is the sentence that sends
    // someone away reassured about a checkout that has stopped catching up.
    const unknownSet = escalate({ diagnosis: diag({ blockersKnown: false, blockingPaths: [] }) });
    expect(unknownSet.kind).toBe("could-not-tell");
    expect(unknownSet.message).toContain("could not be worked out");
    expect(unknownSet.message).toContain("we did not look");

    resetStalenessEscalation();
    // No diagnosis at all is a DIFFERENT fact and must not borrow that sentence.
    const noDiagnosis = escalate({ reason: "ipc failed" });
    expect(noDiagnosis.kind).toBe("could-not-tell");
    expect(noDiagnosis.message).toContain("fail-closed");
    expect(noDiagnosis.message).not.toContain("could not be worked out");
  });

  // A diverged or detached checkout needs a person, and saying "commit or stash something" there is
  // wrong: there is no path to move.
  it("says a diverged checkout needs a human decision", () => {
    const n = escalate({
      diagnosis: diag({ remedy: "blocked-diverged", blockingPaths: [], canFastForward: false }),
    });
    expect(n.kind).toBe("needs-a-human-decision");
    expect(n.message).toContain("needs a person");
  });

  // The quietest failure of all: the diagnosis itself threw, so we have no facts. It still has to
  // escalate — an IPC failure every 60 seconds looks exactly like nothing happening.
  it("escalates a diagnosis that threw, with no diagnosis at all", () => {
    const n = escalate({ reason: "no such command" });
    expect(n.kind).toBe("could-not-tell");
    expect(n.message).toContain("no such command");
    expect(n.behind).toBe(0);
    // No honest number, so none is claimed — a "0 commits behind" here would be a lie.
    expect(n.message).not.toContain("commits behind");
  });

  // ── THE STATES THAT ARE NOT WEDGES (roborev 66891) ─────────────────────────────────────────
  //
  // Both of these fell to the catch-all and escalated as "the reason could not be established",
  // which for the parked case repeats for the entire life of the park. A false alarm that repeats
  // forever costs more than silence: it is what teaches the reader to skip the notice that finally
  // matters, i.e. the exact failure the loud path was built to prevent.

  // A MAIN CHECKOUT PARKED ON A FEATURE BRANCH IS THE NORMAL STATE IN THIS REPO — `land.sh` parks
  // it, AGENTS.md's rule is that a parked tree stays parked, and `main-checkout-fresh.sh` already
  // reports that shape as a silent N/A. So it is named, and it does not shout.
  it("names a parked checkout, stays quiet about it, and speaks the moment it IS a wedge", () => {
    const parked = diag({
      headBranch: "sparkle/agent-7c1e",
      remedy: "fast-forward",
      dirtyCount: 0,
      dirtySample: [],
      blockingPaths: [],
      cause: "3 commit(s) behind origin/main; a fast-forward brings it up to date",
    });

    const n = buildStalenessNotice("/repos/sparkle", 3, { diagnosis: parked });
    expect(n.kind).toBe("parked-on-another-branch");
    expect(n.message).toContain("sparkle/agent-7c1e");
    expect(n.message).toContain("nothing to fix here");
    // The sentence it used to get, and the one this whole arm exists to stop producing.
    expect(n.message).not.toContain("could not be established");

    // ...and however long the park lasts, it never escalates.
    const seen: string[] = [];
    const off = subscribeStalenessNotices((x) => seen.push(x.message));
    for (let i = 0; i < DECLINES_BEFORE_ESCALATION * 4; i++) {
      expect(noteStaleDecline("/repos/parked", { diagnosis: parked })).toBeNull();
    }
    expect(seen).toEqual([]);
    expect(errors).toEqual([]);
    // The counter climbed underneath it: quiet is about the KIND, never about the counter.
    expect(stalenessDeclines("/repos/parked")).toBe(DECLINES_BEFORE_ESCALATION * 4);

    // THE PAIR, on the SAME root and the same primed counter. The moment that checkout declines for
    // a reason that IS a wedge it speaks at once — so the silence above is this arm doing its job,
    // and not an escalator that has simply stopped working.
    const notice = noteStaleDecline("/repos/parked", { diagnosis: diag() });
    expect(notice?.kind).toBe("blocked-by-local-work");
    expect(seen).toHaveLength(1);
    off();

    // AND THE CATCH-ALL IS STILL REACHABLE. Same shape, one field different — on the default branch
    // with nothing else to blame it is still "could not tell", so this is not a `classify` that
    // answers "parked" to everything handed to it.
    const onDefault = buildStalenessNotice("/r", 3, { diagnosis: { ...parked, headBranch: "main" } });
    expect(onDefault.kind).toBe("could-not-tell");
  });

  // A DETACHED PROJECT ROOT can never catch up by itself and is almost never what anyone intended,
  // so unlike the parked case it is worth saying — once. What it must NOT say is the diverged
  // sentence it used to borrow, which is false here and leaves the reader nothing to act on.
  it("names a detached HEAD and the one command that fixes it, and does say it once", () => {
    const detached = diag({
      detached: true,
      headBranch: "",
      remedy: "blocked-detached",
      blockingPaths: [],
      dirtyCount: 0,
      dirtySample: [],
      cause: "HEAD is detached, so this checkout tracks nothing",
    });

    const n = buildStalenessNotice("/repos/sparkle", 3, { diagnosis: detached });
    expect(n.kind).toBe("detached-head");
    expect(n.message).toContain("on no branch");
    expect(n.message).toContain("git checkout main");
    // Not the diverged wording: a fast-forward may well exist here, HEAD is simply on no branch to
    // receive it, and "no fast-forward exists" sends the reader to decide something that is not the
    // question.
    expect(n.message).not.toContain("No fast-forward exists");
    expect(n.message).not.toContain("could not be established");

    // It DOES escalate — once per streak, like every other loud kind.
    for (let i = 0; i < DECLINES_BEFORE_ESCALATION * 2; i++) {
      noteStaleDecline("/repos/det", { diagnosis: detached });
    }
    expect(errors).toHaveLength(1);

    // THE PAIR: the same shape with HEAD on the default branch is not detached and must not borrow
    // this arm, or the test would pass for a `classify` that returns it unconditionally.
    const attached = buildStalenessNotice("/r", 3, {
      diagnosis: { ...detached, detached: false, headBranch: "main", remedy: "fast-forward" },
    });
    expect(attached.kind).toBe("could-not-tell");
  });

  it("is a pure function of its inputs, so the wording can be pinned without a poll", () => {
    const n = buildStalenessNotice("/repos/x", 7, { diagnosis: diag({ behind: 1 }) });
    expect(n.message).toContain("/repos/x");
    expect(n.message).toContain("for 7 checks in a row");
    expect(n.message).toContain("1 commit behind origin/main");
  });
});
