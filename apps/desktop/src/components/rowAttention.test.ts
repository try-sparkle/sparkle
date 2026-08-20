// rowAttention — the EVIDENCE mapping is the part with teeth here.
//
// The pure verdicts (engine/agentStall, agentThrash, agentGoal) are tested at their own seams. What
// this file pins is the boundary those cores deliberately left to the caller: turning the sidebar's
// live git state into `StallInput` WITHOUT ever manufacturing a `false`. Every assertion below that
// checks for `undefined` is guarding the same failure — a row reported "genuinely done" on the
// strength of a lookup nobody performed.
import { describe, expect, it } from "vitest";
import {
  formatRemaining,
  goalBadgeFor,
  namedDirtyFiles,
  stallChipFor,
  stallInputsFor,
  thrashChipLabel,
} from "./rowAttention";
import { stallReport } from "../engine/agentStall";
import {
  newGoal,
  escalateGoal,
  markGoalMet,
  chargeGoalDebt,
  goalDebtOf,
  conciergeRearmGoal,
  DEFAULT_GOAL_TTL_MS,
  MAX_CONCIERGE_REARMS,
  type AgentGoal,
} from "../engine/agentGoal";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";
import type { ThrashReport } from "../engine/agentThrash";

const NOW = 1_000_000_000;

const CLEAN_BS: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
};

const BARE_WS: WorkflowState = {
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
};

describe("stallInputsFor — evidence, never inference", () => {
  it("reports every git fact as undefined when nothing has been polled", () => {
    const input = stallInputsFor("idle", NOW, undefined, {});
    expect(input.hasOpenPr).toBeUndefined();
    expect(input.hasUnlandedWork).toBeUndefined();
    expect(input.hasUncommittedChanges).toBeUndefined();
    // …and that is what makes the row `unknown` rather than a false "genuinely done".
    expect(stallReport(input).verdict).toBe("unknown");
  });

  it("reads a null prState as NOT LOOKED UP, not as 'no PR'", () => {
    // Rust returns null both for "probed, no PR" and "this was a fast/local poll". Those are
    // indistinguishable at this boundary, so the honest answer is `undefined`.
    expect(stallInputsFor("idle", NOW, undefined, { ws: BARE_WS }).hasOpenPr).toBeUndefined();
  });

  it("reads an open PR as a stall cause and a merged one as a definite no", () => {
    expect(
      stallInputsFor("idle", NOW, undefined, { ws: { ...BARE_WS, prState: "open" } }).hasOpenPr,
    ).toBe(true);
    expect(
      stallInputsFor("idle", NOW, undefined, { ws: { ...BARE_WS, prState: "merged" } }).hasOpenPr,
    ).toBe(false);
  });

  it("declines to read a PARKED worktree's dirt as this agent's uncommitted work", () => {
    // `worktreeOnBranch: false` means something checked another branch into this tree, so the dirt
    // is not attributable here — neither a cause nor evidence of a clean tree.
    const parked: BranchStatus = { ...CLEAN_BS, dirty: true, worktreeOnBranch: false };
    expect(
      stallInputsFor("idle", NOW, undefined, { bs: parked }).hasUncommittedChanges,
    ).toBeUndefined();
    // …but an on-branch dirty tree IS this agent's outstanding work.
    const own: BranchStatus = { ...CLEAN_BS, dirty: true, worktreeOnBranch: true };
    expect(stallInputsFor("idle", NOW, undefined, { bs: own }).hasUncommittedChanges).toBe(true);
  });

  it("does not let resolveStage's floor manufacture 'nothing unlanded' from an unpolled branch", () => {
    // With no BranchStatus and no watermark, `resolveStage` returns the bottom stage, which reads
    // as "no committed work". That default is right for a progress bar and a lie here.
    expect(stallInputsFor("idle", NOW, undefined, {}).hasUnlandedWork).toBeUndefined();
    // A committed-but-unlanded branch that HAS been polled is a real cause.
    expect(
      stallInputsFor("idle", NOW, undefined, { bs: { ...CLEAN_BS, ahead: 3 } }).hasUnlandedWork,
    ).toBe(true);
    // A clean, never-committed branch that HAS been polled is a real negative.
    expect(stallInputsFor("idle", NOW, undefined, { bs: CLEAN_BS }).hasUnlandedWork).toBe(false);
  });

  it("lets a fully-polled, genuinely-done agent reach the `finished` verdict", () => {
    const input = stallInputsFor("idle", NOW, undefined, {
      bs: CLEAN_BS,
      ws: { ...BARE_WS, prState: "merged" },
    });
    expect(stallReport(input).verdict).toBe("finished");
  });
});

describe("stallChipFor — SAYING WHICH FILE (sparkle-biezi)", () => {
  /** A dirty tree that knows its own paths — what a current Rust build sends. */
  const dirtyBs = (files: string[], count = files.length): BranchStatus => ({
    ...CLEAN_BS,
    dirty: true,
    dirtyFiles: files,
    dirtyCount: count,
  });
  const chip = (bs: BranchStatus) => stallChipFor(stallReport(stallInputsFor("idle", NOW, undefined, { bs })), bs);

  it("names the file instead of saying only 'uncommitted changes'", () => {
    // The founder's complaint: "A row claiming uncommitted work without naming a file cannot be
    // acted on — he cannot tell a forgotten fix from a leftover build artifact."
    const c = chip(dirtyBs(["apps/desktop/src/vite.config.ts"]));
    // No "uncommitted:" prefix — the chip caps at 20ch and the row already carries an "Unsaved"
    // badge and a ⚠ icon, so a prefix truncates the one thing they cannot say. The word survives in
    // the accessible name, which is asserted below.
    expect(c?.text).toBe("vite.config.ts");
    // The bare label is what this replaces — assert it is GONE, not merely that a name is present.
    expect(c?.text).not.toBe("uncommitted changes");
    expect(c?.ariaLabel).toBe("Stalled — uncommitted changes: vite.config.ts");
  });

  it("counts the +N from the TRUE total, not from the capped preview", () => {
    // Rust caps the preview at 5 but always counts them all. Reading the array's length instead
    // would under-report a big mess as exactly "+4" forever.
    const c = chip(dirtyBs(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], 12));
    expect(c?.text).toBe("a.ts +11");
  });

  it("carries the FULL paths for the tooltip, while the chip shows a basename", () => {
    const c = chip(dirtyBs(["apps/desktop/src/x.ts", "dist/bundle.js"], 2));
    expect(c?.text).toBe("x.ts +1");
    expect(c?.files).toEqual(["apps/desktop/src/x.ts", "dist/bundle.js"]);
  });

  it("falls back to the bare label when the Rust build does not send names", () => {
    // `dirtyFiles: undefined` means "this build cannot tell you", NOT "no files". Inventing a name
    // or claiming zero would both be worse than the unchanged label.
    const c = chip({ ...CLEAN_BS, dirty: true });
    expect(c?.text).toBe("uncommitted changes");
    expect(c?.files).toEqual([]);
  });

  it("NEVER names a PARKED tree's files — they belong to another branch", () => {
    // `worktreeOnBranch: false` already suppresses `dirty` as evidence (uncommittedEvidence). Naming
    // the files anyway would pin another branch's work on this agent BY FILENAME, which is a
    // confidently wrong claim rather than a quieter one.
    //
    // ASSERTED ON `namedDirtyFiles` DIRECTLY, and that is deliberate. Going through `stallChipFor`
    // here is VACUOUS: a parked tree reports the `unknown` verdict, so the chip is null and the
    // assertion passes whether or not the gate exists. (Confirmed by mutation — deleting the
    // `worktreeOnBranch` check left the chip-level version of this test green.) The gate lives in
    // this function, so this is where it has to be pinned.
    const parked: BranchStatus = { ...dirtyBs(["someone/elses/file.ts"]), worktreeOnBranch: false };
    expect(namedDirtyFiles(parked)).toEqual([]);
    // …while the SAME reading on the agent's own tree does name it, so the empty answer above is
    // the gate doing its job and not the fixture simply having nothing in it.
    expect(namedDirtyFiles({ ...parked, worktreeOnBranch: true })).toEqual(["someone/elses/file.ts"]);
    // `undefined` is an older Rust build, not a parked tree — it takes the normal path.
    expect(namedDirtyFiles(dirtyBs(["mine.ts"]))).toEqual(["mine.ts"]);
  });

  it("when a MORE actionable cause heads the chip, the paths still reach the tooltip", () => {
    // `causes` is ordered most-actionable-first, so unlanded commits outrank a dirty tree and the
    // chip's one line goes to them — correctly, since landing the work is the bigger ask. The
    // filenames are not lost, though: they ride `files`, which is what the row's tooltip renders.
    // Naming the file in the chip here would have meant DROPPING the more important cause to do it.
    const bs = { ...dirtyBs(["only.ts"]), ahead: 2 };
    const c = stallChipFor(stallReport(stallInputsFor("idle", NOW, undefined, { bs })), bs);
    expect(c?.text).toBe("work not landed +1");
    expect(c?.files).toEqual(["only.ts"]);
  });
});

describe("stallChipFor — naming the outstanding work", () => {
  const chipFor = (over: Parameters<typeof stallInputsFor>[3], goal?: Parameters<typeof stallInputsFor>[2]) =>
    stallChipFor(stallReport(stallInputsFor("idle", NOW, goal, over)));

  it("renders nothing for a finished row", () => {
    expect(chipFor({ bs: CLEAN_BS, ws: { ...BARE_WS, prState: "merged" } })).toBeNull();
  });

  it("renders nothing for an UNKNOWN row — a stall we never looked for is not an alarm", () => {
    expect(chipFor({})).toBeNull();
  });

  it("renders nothing on the red tier, which is already loud", () => {
    expect(
      stallChipFor(stallReport(stallInputsFor("waiting", NOW, undefined, { bs: { ...CLEAN_BS, dirty: true } }))),
    ).toBeNull();
  });

  it("LIVE commits outrank a merged watermark — the new-work cycle", () => {
    // roborev 55334. Merge PR #1 (the watermark latches `merged`), keep working on the same branch,
    // commit three times, turn ends. `resolveStage` takes the MAX of git-derived stage and the
    // monotonic watermark, so `merged` outranked `ahead: 3` and the row reported "genuinely done"
    // with no chip — pixel-identical to a shipped agent, with three unlanded commits.
    const input = stallInputsFor("idle", NOW, undefined, {
      bs: { ...CLEAN_BS, ahead: 3 },
      ws: { ...BARE_WS, prState: "merged" },
      stageOverride: "merged",
    });
    expect(input.hasUnlandedWork).toBe(true);
    expect(stallReport(input).verdict).toBe("stalled");
    expect(stallChipFor(stallReport(input))?.text).toContain("not landed");
  });

  it("the `unmerged` band assembles its own evidence, positively", () => {
    // This mapper always supplies `hasUnlandedWork` explicitly, so it — not agentStall's
    // band-as-evidence backstop — decides whether that band's own self-evidence ever applies. Nothing
    // tied the two together, and it is the most common gray row on the fleet (roborev 55334).
    //
    // Asserted POSITIVELY on purpose. This test used to read `.not.toBe("finished")`, which `unmerged`
    // satisfies under every possible value of `hasUnlandedWork` — true → stalled, undefined → the
    // band fallback makes it true → stalled, false → unknown. It could not fail, so it pinned nothing
    // and named the mapper it was supposed to be guarding (roborev 55456).
    const input = stallInputsFor("unmerged", NOW, undefined, {
      bs: { ...CLEAN_BS, ahead: 2 },
      ws: BARE_WS,
      stageOverride: "building_saved",
    });
    expect(input.hasUnlandedWork).toBe(true);
    expect(stallReport(input).causes).toContain("unlanded-work");
    expect(stallReport(input).verdict).toBe("stalled");
  });

  it("…and the two paths are distinguishable: `unmerged` whose evidence resolves FALSE", () => {
    // The discriminating case the assertion above needs to mean anything. Same band, but the evidence
    // says the work reached origin main, so THIS mapper answers false and the band's backstop in
    // agentStall never gets to overrule it. If the two were fused, `hasUnlandedWork` would be true here.
    const input = stallInputsFor("unmerged", NOW, undefined, {
      bs: CLEAN_BS,
      ws: { ...BARE_WS, inOriginMain: true },
      stageOverride: "merged",
    });
    expect(input.hasUnlandedWork).toBe(false);
    expect(stallReport(input).causes).not.toContain("unlanded-work");
  });

  it("a SQUASH-landed branch is not unlanded work — `ahead` never returns to zero", () => {
    // roborev 55456, the inverse of the new-work cycle above and the more expensive failure. `ahead`
    // counts commits the tip does not share with the base, so a squash/rebase merge holds it at N
    // FOREVER: the work is in main, the tip is not an ancestor. `ws.landed` is Rust's name for exactly
    // that state (`merge_adds_nothing`). Without the yield, the live-commits short-circuit paints a
    // landed agent red `blocked` permanently, with no later signal able to clear it.
    // The real shape carries both signals — GitHub reports the PR merged and `merge_adds_nothing`
    // holds — and pairing this with the next test is what isolates `landed` as the operative one:
    // identical fixture minus `landed` answers TRUE.
    const input = stallInputsFor("idle", NOW, undefined, {
      bs: { ...CLEAN_BS, ahead: 3 },
      ws: { ...BARE_WS, landed: true, prState: "merged" },
      stageOverride: "merged",
    });
    expect(input.hasUnlandedWork).toBe(false);
    expect(stallReport(input).verdict).toBe("finished");
    expect(stallChipFor(stallReport(input))).toBeNull();
  });

  it("…and so is a merge-commit landing whose tip IS in origin main", () => {
    const input = stallInputsFor("idle", NOW, undefined, {
      bs: { ...CLEAN_BS, ahead: 3 },
      ws: { ...BARE_WS, inOriginMain: true },
      stageOverride: "merged",
    });
    expect(input.hasUnlandedWork).toBe(false);
  });

  it("but a merged PR alone does NOT vote it landed — that is the new-work cycle", () => {
    // The guard above must yield to REACHABILITY, never to `prState`. `prState` describes the branch's
    // PR, not the branch: after PR #1 merges, the probe keeps answering "merged" while fresh commits
    // pile up unlanded, and until a second PR exists nothing corrects it. Vetoing on it would hand back
    // the calm-gray-over-outstanding-work bug (roborev 55334) that the short-circuit exists to kill.
    const input = stallInputsFor("idle", NOW, undefined, {
      bs: { ...CLEAN_BS, ahead: 3 },
      ws: { ...BARE_WS, prState: "merged" },
      stageOverride: "merged",
    });
    expect(input.hasUnlandedWork).toBe(true);
    expect(stallReport(input).verdict).toBe("stalled");
  });

  it("a PARKED worktree's `ahead` is still valid evidence — only `dirty` is corrupted by parking", () => {
    // roborev 55456. `BranchStatus` documents that every field but `dirty` is computed from the branch
    // REF and is immune to what is checked out into the tree. The `worktreeOnBranch !== false` gate had
    // been copied here from `uncommittedEvidence`, where it IS correct, and it re-opened this hole: a
    // parked tree with three unlanded commits and a `merged` watermark fell through to `resolveStage`
    // and read as genuinely done.
    const input = stallInputsFor("idle", NOW, undefined, {
      bs: { ...CLEAN_BS, ahead: 3, worktreeOnBranch: false },
      stageOverride: "merged",
    });
    expect(input.hasUnlandedWork).toBe(true);
    // …while the same parked tree's dirt stays unattributable, which is the field parking DOES corrupt.
    expect(
      stallInputsFor("idle", NOW, undefined, {
        bs: { ...CLEAN_BS, dirty: true, worktreeOnBranch: false },
      }).hasUncommittedChanges,
    ).toBeUndefined();
  });

  it("names the cause, and counts the rest", () => {
    const chip = chipFor({
      bs: { ...CLEAN_BS, ahead: 2, dirty: true },
      ws: { ...BARE_WS, prState: "open" },
    });
    // Most-actionable-first: the open PR heads the list, and the "+1" is the dirty worktree. It used
    // to read "+2" because `unlanded-work` was reported beside `open-pr` — the same fact twice, which
    // agentStall now folds (roborev 55298/55379).
    expect(chip?.text).toBe("PR unmerged +1");
    expect(chip?.ariaLabel).toBe("Stalled — PR unmerged +1");
    expect(chip?.escalated).toBe(false);
  });

  it("flags an escalated goal — the mechanism meant to keep it moving has given up", () => {
    const goal = escalateGoal(newGoal("ship the parser", NOW), NOW, "20 continues, no progress");
    const chip = chipFor({ bs: CLEAN_BS, ws: { ...BARE_WS, prState: "merged" } }, goal);
    expect(chip?.escalated).toBe(true);
    expect(chip?.text).toBe("auto-continue gave up");
  });
});

describe("thrashChipLabel — undefined is not healthy", () => {
  const mk = (over: Partial<ThrashReport>): ThrashReport => ({
    verdict: "healthy",
    thrashing: false,
    turnsWithoutTool: 0,
    nudgesWithoutProgress: 0,
    recentCompactions: 0,
    detail: "",
    ...over,
  });

  it("renders nothing for an agent nobody is watching", () => {
    expect(thrashChipLabel(undefined)).toBeNull();
  });

  it("renders nothing for a healthy agent", () => {
    expect(thrashChipLabel(mk({}))).toBeNull();
  });

  it("names the CAUSE for context pressure, not the symptom", () => {
    expect(thrashChipLabel(mk({ verdict: "context-pressure", thrashing: true }))).toBe(
      "Context exhausted",
    );
    expect(thrashChipLabel(mk({ verdict: "repeating-command", thrashing: true }))).toBe("Looping");
    expect(thrashChipLabel(mk({ verdict: "no-progress", thrashing: true }))).toBe("No progress");
  });
});

describe("goalBadgeFor", () => {
  it("is null when there is no goal", () => {
    expect(goalBadgeFor(undefined, NOW)).toBeNull();
  });

  it("shows an active goal with its remaining mandate", () => {
    const goal = newGoal("land PR #42", NOW);
    const badge = goalBadgeFor(goal, NOW + 40 * 60_000);
    expect(badge?.state).toBe("unmet");
    expect(badge?.text).toBe("land PR #42");
    expect(badge?.label).toBe("active · 3h 20m left");
    expect(badge?.escalated).toBe(false);
  });

  it("never words an EXPIRED goal as done — the mandate ran out, the work did not finish", () => {
    const goal = newGoal("land PR #42", NOW);
    const badge = goalBadgeFor(goal, NOW + DEFAULT_GOAL_TTL_MS + 1);
    expect(badge?.state).toBe("expired");
    expect(badge?.label).toBe("ran out of time — never met");
  });

  it("carries the escalation REASON, so the human who now owns it knows why", () => {
    const goal = escalateGoal(newGoal("land PR #42", NOW), NOW, "the build never went green");
    const badge = goalBadgeFor(goal, NOW);
    expect(badge?.escalated).toBe(true);
    expect(badge?.label).toBe("auto-continue gave up — the build never went green");
  });

  // ── THE STALE QUOTE (Bug A) ─────────────────────────────────────────────────────────────────
  //
  // The badge is where the contradiction is most visible: `text` is the LIVE goal and `label`
  // embeds a sentence quoting whatever the goal was when auto-continue gave up. Those can be two
  // different objectives in one object, and nothing said so.
  //
  // `staleQuote` carries the OLD text as DATA rather than folding it into `label`, deliberately.
  // `label` is what the compact column row renders into a `title`/`aria-label`, and the founder's
  // instruction is that the Build column stays icons — so the words go to the card, which decides
  // its own wording from this field.
  describe("a stale escalation quote", () => {
    // The real carry path, not a hand-stamped goal: escalate, then move the goal on through
    // `chargeGoalDebt` exactly as `set_agent_goal` does.
    const movedOnAfterEscalating = (): AgentGoal => {
      const stuck = escalateGoal(
        newGoal("land PR #42", NOW),
        NOW,
        'Auto-continued 3 times with no sign of progress. The goal is still unmet: "land PR #42".',
      );
      return chargeGoalDebt(newGoal("drain roborev findings", NOW), goalDebtOf(stuck));
    };

    it("carries the goal the sentence quotes, so the card can show BOTH", () => {
      const badge = goalBadgeFor(movedOnAfterEscalating(), NOW);
      expect(badge?.staleQuote).toBe("land PR #42");
      // …beside the live one. The pair is the whole point — either alone is what the row already had.
      expect(badge?.text).toBe("drain roborev findings");
    });

    it("DROPS the dead sentence from the label — it is not a live claim (founder, 2026-08-18)", () => {
      // ⚠️ THIS REVERSES AN EARLIER EXPECTATION, AND THE CONSTRAINT BEHIND IT STILL HOLDS. The test
      // here used to assert the label carried the quoted sentence verbatim, under the founder's rule
      // that the chip must not GROW words. It does not grow — this makes it shorter — so that rule is
      // satisfied; what changed is the founder's 2026-08-18 report, where a row read "blocked on
      // human" about a release run that had already terminally failed. `escalationReason` is prose
      // frozen at the give-up instant, and `chargeGoalDebt` deliberately carries it onto whatever the
      // goal becomes next, so it OUTLIVES the work it describes and nothing regenerates it.
      // Interpolated into a one-line label there is no room to say it is out of date, so it reads as
      // current — and was acted on as current.
      const badge = goalBadgeFor(movedOnAfterEscalating(), NOW);
      expect(badge?.label).toBe("auto-continue gave up");
      // ⚠️ WHAT SURVIVES IS THE GOAL TEXT, NOT THE SENTENCE. `staleQuote` is `escalatedGoalText`, so
      // the card's "Gave up on: X. Now working on: Y." line tells the reader the escalation is about
      // older work; the reason sentence is dropped from THIS LABEL and from `agentStall`'s stall
      // detail. It is still carried — marked `escalationStale` — by the roster, the wake-up brief
      // and `goalReading`. See the enumeration on `goalBadgeFor`, which this comment used to
      // contradict in one direction and then the other (roborev 65339, then 65369/65370).
      expect(badge?.staleQuote).toBe("land PR #42");
    });

    it("…while a FRESH escalation still carries its reason — the label is not blanked wholesale", () => {
      // THE PAIRED NEGATIVE, and without it the assertion above is satisfied by a change that drops
      // `escalationReason` from EVERY escalated label. That would delete the one sentence explaining
      // why auto-continue stopped from the common (non-stale) row, which is strictly worse than the
      // bug being fixed. Staleness must be what does the work here, nothing else.
      const fresh = escalateGoal(newGoal("land PR #42", NOW), NOW, "the build never went green");
      expect(goalBadgeFor(fresh, NOW)?.label).toBe(
        "auto-continue gave up — the build never went green",
      );
    });

    it("is ABSENT when the escalation still quotes the goal the agent holds", () => {
      // Without this the field could be a constant, and every escalation would render the
      // two-line "gave up on / now working on" block — including the ones where both are the same
      // sentence, which reads as a bug to whoever is looking at it.
      const badge = goalBadgeFor(
        escalateGoal(newGoal("land PR #42", NOW), NOW, "the build never went green"),
        NOW,
      );
      expect(badge?.escalated).toBe(true);
      expect(badge?.staleQuote).toBeUndefined();
    });

    it("is ABSENT on a goal nobody escalated", () => {
      expect(goalBadgeFor(newGoal("land PR #42", NOW), NOW)?.staleQuote).toBeUndefined();
    });

    // THE SECOND CONSUMER. `staleQuote` is spread onto TWO returns — the first give-up and the
    // re-armed-and-stuck-again row — and every case above lands on the first, because a goal built
    // by `escalateGoal` + `chargeGoalDebt` never sets `conciergeRearms`. Delete the spread from the
    // re-armed return and all four still pass, while that card renders the live goal beside a
    // sentence quoting a dead one.
    //
    // It is the row where it matters MOST and where a human is least likely to catch it: a machine
    // has already put this agent back to work once, so "just restart it" is advice already taken
    // and the reader is leaning on the sentence to decide what else to do.
    //
    // This is the repo's own two-sites-one-check failure (bead sparkle-50m03), and it was caught
    // here by review rather than by the mutation run, which had named only the shared line.
    it("survives onto the RE-ARMED row, which spreads it from a different return", () => {
      // The real path, driven end to end: stuck on A, re-armed (which strips the quote), moved to
      // B, stuck again on B, then moved to C. Only the second escalation's quote should survive.
      let goal = escalateGoal(
        newGoal("land PR #42", NOW),
        NOW,
        'Auto-continued 3 times with no sign of progress. The goal is still unmet: "land PR #42".',
      );
      goal = conciergeRearmGoal(goal, NOW, "unblocked the build");
      goal = chargeGoalDebt(newGoal("drain roborev findings", NOW), goalDebtOf(goal));
      goal = escalateGoal(
        goal,
        NOW,
        'Auto-continued 3 times with no sign of progress. The goal is still unmet: "drain roborev findings".',
      );
      goal = chargeGoalDebt(newGoal("cut the release", NOW), goalDebtOf(goal));

      const badge = goalBadgeFor(goal, NOW);
      // Proves we are on the OTHER return — without this the case could silently drift back onto
      // the `rearms === 0` branch and re-cover the line that was already covered.
      expect(badge?.label.startsWith("re-armed 1× and stuck again")).toBe(true);
      // The SECOND escalation's quote, not the first: the re-arm strips its own, so a "land PR #42"
      // here would mean a dead quote outlived the clear that was supposed to end it.
      expect(badge?.staleQuote).toBe("drain roborev findings");
      expect(badge?.text).toBe("cut the release");
    });
  });

  // A goal the concierge re-armed `times` times and which has escalated AGAIN — the state the
  // human actually meets on the row, built by driving the real engine rather than hand-stamping
  // `conciergeRearms` (a hand-built goal would assert against a shape production may never produce).
  const rearmedAndStuckAgain = (times: number): AgentGoal => {
    let goal = newGoal("land PR #42", NOW);
    for (let i = 0; i < times; i++) {
      goal = escalateGoal(goal, NOW, "the build never went green");
      goal = conciergeRearmGoal(goal, NOW, "unblocked the build");
    }
    return escalateGoal(goal, NOW, "the build never went green");
  };

  it("says a MACHINE already re-armed it, so the human is not reading a first give-up", () => {
    const badge = goalBadgeFor(rearmedAndStuckAgain(1), NOW);
    expect(badge?.escalated).toBe(true);
    // Names the count, and does NOT read as the untouched auto-continue give-up.
    expect(badge?.label).toBe("re-armed 1× and stuck again — the build never went green");
    expect(badge?.label).not.toContain("auto-continue gave up");
  });

  it("says the allowance is SPENT once it is, so retrying is visibly not the next move", () => {
    const badge = goalBadgeFor(rearmedAndStuckAgain(MAX_CONCIERGE_REARMS), NOW);
    expect(badge?.label).toContain(`re-armed ${MAX_CONCIERGE_REARMS}× and stuck again`);
    expect(badge?.label).toContain("no re-arms left, this one is yours");
    expect(badge?.label).toContain("the build never went green");
    // Still AMBER: the escalated flag is what the row paints from, and a spent allowance is not a
    // new alarm tier (escalated-goal left the red tier on 2026-08-06 and is not coming back).
    expect(badge?.escalated).toBe(true);
    expect(badge?.state).toBe("escalated");
  });

  it("keeps the re-armed wording when the escalation recorded no reason", () => {
    let goal = escalateGoal(newGoal("land PR #42", NOW), NOW, "gave up");
    goal = conciergeRearmGoal(goal, NOW, "unblocked it");
    goal = escalateGoal(goal, NOW, "");
    expect(goalBadgeFor(goal, NOW)?.label).toBe("re-armed 1× and stuck again");
  });

  it("reports a met goal as met even after its TTL passes", () => {
    const goal = markGoalMet(newGoal("land PR #42", NOW), NOW + 1000);
    const badge = goalBadgeFor(goal, NOW + DEFAULT_GOAL_TTL_MS + 1);
    expect(badge?.state).toBe("met");
    expect(badge?.escalated).toBe(false);
  });
});

describe("formatRemaining", () => {
  it("is coarse on purpose — nobody acts on the seconds", () => {
    expect(formatRemaining(4 * 60 * 60_000)).toBe("4h");
    expect(formatRemaining(3 * 60 * 60_000 + 20 * 60_000)).toBe("3h 20m");
    expect(formatRemaining(45 * 60_000)).toBe("45m");
    expect(formatRemaining(30_000)).toBe("<1m");
    expect(formatRemaining(0)).toBe("0m");
    expect(formatRemaining(-5)).toBe("0m");
  });
});

// ── `stallInputsFor` MUST CARRY THE HUMAN BLOCK THROUGH (roborev 65339) ────────────────────────────
describe("stallInputsFor threads the human block", () => {
  it("passes a supplied block into the StallInput", () => {
    const input = stallInputsFor("idle", NOW, undefined, {}, undefined, { raisedAtMs: NOW });
    expect(input.humanBlock).toEqual({ raisedAtMs: NOW });
  });

  it("omits the key entirely when there is none — absence must not read as a block", () => {
    // The same spread convention `quotaBlock` uses. An explicit `humanBlock: undefined` would be
    // harmless today but makes `"humanBlock" in input` lie, and this surface's whole discipline is
    // that "not looked up" and "false" stay distinguishable.
    expect("humanBlock" in stallInputsFor("idle", NOW, undefined, {})).toBe(false);
  });
});
