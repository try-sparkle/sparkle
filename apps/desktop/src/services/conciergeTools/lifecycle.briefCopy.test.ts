// THE REMEDY STRING IS CODE — a wrong one is a bug, not phrasing.
//
// `briefFailureCopy` maps a delivery outcome to what the concierge tells the human, and it has been
// wrong four times in the same shape: copy written for one state reaching a different state. Three of
// those were caught by review; the fourth was caught in production, by the founder, after the concierge
// followed its own advice and re-sent an opening brief into three agents that already had it.
//
// These assert the PROPERTY that makes each branch safe (what action it names, and what action it must
// not invite), not the exact prose — prose is allowed to change, the safety is not.
import { describe, it, expect } from "vitest";
import { briefFailureCopy } from "./lifecycle";

const LIVE = true;
const GONE = false;

describe("briefFailureCopy", () => {
  it("says nothing when there is nothing to report", () => {
    expect(briefFailureCopy({ state: "submitted" }, LIVE)).toBeUndefined();
    expect(briefFailureCopy({ state: "no-brief" }, LIVE)).toBeUndefined();
  });

  // A GONE ROW STILL GETS A SENTENCE EVEN WHEN DELIVERY SUCCEEDED — the precedence the docstring
  // states. Extracting this function once put the `submitted`/`no-brief` early return above the
  // `agentExists` check, which silently dropped this sentence; `spawnShortfall` words the receipt
  // from it, so the receipt degraded to a generic "already gone" for the case needing specifics.
  // These two cases were asserted ONLY with LIVE, so nothing pinned the reordering in either
  // direction (roborev, this branch).
  it("still reports a GONE row whose brief HAD been submitted, without claiming it never went in", () => {
    const copy = briefFailureCopy({ state: "submitted" }, GONE)!;
    expect(copy).toMatch(/gone/i);
    // The wrong-remedy trap one layer down: saying the brief never landed invites a re-send into the
    // replacement agent on top of a brief it will already have.
    expect(copy).not.toMatch(/before its opening brief went in/i);
    expect(copy).toMatch(/after its opening brief went in/i);
  });

  // `agent-closed` reaches this function too, and it was falling into a `default: return undefined`
  // that also swallowed any future outcome — the trapdoor that lets a new state ship as `briefed:
  // false` with no `briefFailure`, which `spawnShortfall` then renders as a clean success. Both arms
  // are asserted so the explicit case cannot silently regress to a catch-all.
  it("says the row is gone for `agent-closed` (its whole meaning is that the row went away)", () => {
    const copy = briefFailureCopy({ state: "agent-closed", reason: "agent closed" }, GONE)!;
    expect(copy).toMatch(/gone/i);
  });

  it("stays silent for `agent-closed` against a row that somehow still exists, rather than guessing", () => {
    expect(
      briefFailureCopy({ state: "agent-closed", reason: "agent closed" }, LIVE),
    ).toBeUndefined();
  });

  it("reports a GONE row that was never briefed without inventing a brief to re-send", () => {
    const copy = briefFailureCopy({ state: "no-brief" }, GONE)!;
    expect(copy).toMatch(/gone/i);
    // There was no brief, so no clause may refer to one.
    expect(copy).not.toMatch(/brief/i);
  });

  // A DEAD ROW OUTRANKS THE DELIVERY OUTCOME. Any path that destroys a row without settling the brief
  // leaves the delivery reading as a timeout, so "go and check that agent" was being said about an
  // agent that no longer existed (roborev 55888).
  it.each(["launching", "unconfirmed", "launch-failed"] as const)(
    "says the agent is GONE for a `%s` delivery when the row no longer exists",
    (state) => {
      const copy = briefFailureCopy(
        state === "launch-failed" ? { state, reason: "claude not found" } : { state },
        GONE,
      )!;
      expect(copy).toMatch(/gone/i);
      // Must not send them to look at, or wait for, a row that was deleted.
      expect(copy).not.toMatch(/give it a moment|start again/i);
    },
  );

  // The row survives and `noteBriefFailed` RETAINS the brief, so a restart genuinely re-sends it —
  // and the copy must not describe this as an agent running without an objective, which it isn't.
  it("names the retry for a failed launch, and quotes the reason it failed", () => {
    const copy = briefFailureCopy({ state: "launch-failed", reason: "claude not found" }, LIVE)!;
    expect(copy).toContain("claude not found");
    expect(copy).toMatch(/start again/i);
    expect(copy).toMatch(/nothing needs re-typing/i);
  });

  // THE REGRESSION THIS FILE EXISTS FOR. `launching` means the brief is already in the argv of a live
  // launch, so the only safe action is to wait. Telling the human to go make sure it arrived is what
  // produced the duplicate brief.
  it("tells the human to WAIT on a launch already carrying the brief, and warns off a re-send", () => {
    const copy = briefFailureCopy({ state: "launching" }, LIVE)!;
    expect(copy).toMatch(/give it a moment/i);
    expect(copy).toMatch(/brief it twice/i);
    // The exact instruction that was followed into the bug.
    expect(copy).not.toMatch(/check that it (picked|got)/i);
  });

  // …and the genuinely-unknown case keeps its "go check", because here nothing took the brief at all
  // and a briefless agent really is on the table. If both branches said the same thing, the split
  // would be decorative — so this asserts they DIFFER.
  it("still says to check the agent when nothing ever read the brief to launch with", () => {
    const copy = briefFailureCopy({ state: "unconfirmed" }, LIVE)!;
    expect(copy).toMatch(/check that it got the task/i);
    expect(copy).not.toMatch(/give it a moment/i);
    expect(copy).not.toBe(briefFailureCopy({ state: "launching" }, LIVE));
  });
});
