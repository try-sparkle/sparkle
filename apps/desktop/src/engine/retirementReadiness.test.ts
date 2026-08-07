import { describe, it, expect } from "vitest";
import { retirementPill, retirementRecommended, canAnswerRetroPing } from "./retirementReadiness";
import { bandOfStatus, STATUS_BANDS } from "./buildSections";
import { rollupDot } from "./workerRollup";
import type { RetroReceipt } from "./retroReceiptTypes";
import type { AgentTabStatus } from "../types";
import type { WorkflowStageId } from "./workflowStage";

const CAPTURED: RetroReceipt = { state: "captured", at: 1, source: "pr-marker", painPointCount: 3 };
const EXCUSED: RetroReceipt = { state: "excused", at: 1, source: "agent-declared", reasonCode: "no-changes" };
const OVERRIDDEN: RetroReceipt = { state: "overridden", at: 1, source: "human-override", reasonCode: "other" };

const LANDED: readonly WorkflowStageId[] = ["merged", "shipped"];
const NOT_LANDED: readonly WorkflowStageId[] = [
  "thought",
  "specd",
  "planned",
  "building_unsaved",
  "building_saved",
  "pushed",
  "pull_request",
  "merged_local",
];

// EXHAUSTIVE OVER THE UNION, and hoisted so both describes below read the SAME list (roborev
// 59482). It was inline in one test while `canAnswerRetroPing`'s block restated its own subset by
// hand — so when `questions` arrived from main, the typecheck lock caught the copy up here and the
// hand-written one silently kept its ten. One list, derived everywhere it is used.
//
// DERIVED FROM THE TYPE, not restated beside it (roborev 58742). This was a hand-written
// `AgentTabStatus[]`, which made the "nothing retirement-shaped" assertion check the literal
// against ITSELF — green no matter what the union contained, the vacuous shape AGENTS.md calls the
// #1 fleet-wide finding. An exhaustive `Record` cannot be written for a union it does not cover:
// add a twelfth status and this file fails TYPECHECK, which is the lock the prose below claims.
// Excess keys fail the same way, so the map cannot drift the other direction. It has already
// caught one: `questions` arrived from main and this file went red until named.
const ALL_STATUSES: Record<AgentTabStatus, true> = {
  working: true,
  idle: true,
  new: true,
  waiting: true,
  approval: true,
  blocked: true,
  errored: true,
  unmerged: true,
  done: true,
  stopped: true,
  // ADDED BY THE LOCK, not by hand-waving: `questions` (the blue Questions attention state, bead
  // sparkle-345q5) landed on main while this branch was open, and the exhaustive Record failed the
  // TYPECHECK until it was acknowledged here — which is exactly what this shape was written to do.
  // The retirement pill still contributes nothing to the taxonomy.
  questions: true,
  // …and it caught a second one the same way: `lapsed` (the amber "Auto-continue stopped" tier,
  // 2026-08-06) failed this TYPECHECK the moment it was added to AGENT_STATUS, on a branch whose
  // author was not thinking about retirement at all. That is the whole value of the shape.
  //
  // It contributes nothing to the retirement taxonomy, and deliberately: `lapsed` means our retry
  // budget stopped, not that the agent is finished. It is NOT in `UNREACHABLE` below either — a
  // lapsed agent's PTY is alive (stallEscalation only escalates rows `aliveOf` does not deny), so
  // it can still answer a retro ping exactly like `idle`.
  lapsed: true,
};
const ALL = Object.keys(ALL_STATUSES) as AgentTabStatus[];

/** The statuses `canAnswerRetroPing` treats as unreachable. Everything else must be answerable. */
const UNREACHABLE: readonly AgentTabStatus[] = ["stopped", "errored"];

describe("retirementPill", () => {
  it("recommends retirement once a landed build agent's retro is on file", () => {
    for (const stage of LANDED) {
      for (const receipt of [CAPTURED, EXCUSED, OVERRIDDEN]) {
        expect(retirementPill({ kind: "build", stage, receipt })).toBe("ready");
      }
    }
  });

  it("says RETRO PENDING for a landed build agent with nothing on file", () => {
    for (const stage of LANDED) {
      expect(retirementPill({ kind: "build", stage, receipt: undefined })).toBe("retro-pending");
      // `null` is the absence that actually occurs: the receipt crosses the Tauri boundary, where a
      // Rust `Option::None` becomes JSON `null` and never `undefined` (roborev 58719). Reading it
      // as "ready" would put a RETIREMENT RECOMMENDED pill on every agent that never reported.
      expect(retirementPill({ kind: "build", stage, receipt: null })).toBe("retro-pending");
    }
  });

  it("treats a ZERO-pain-point retro as complete, not as missing", () => {
    // The single most important case. Before the receipt existed, a frictionless retro left no
    // trace on disk at all and was indistinguishable from an agent that never ran one — which is
    // why "did it merge a PR" was never a usable proxy for "did it report back".
    const frictionless: RetroReceipt = { ...CAPTURED, painPointCount: 0 };
    expect(retirementPill({ kind: "build", stage: "shipped", receipt: frictionless })).toBe("ready");
  });

  it("shows NO pill before the work has landed, however much is on file", () => {
    for (const stage of NOT_LANDED) {
      expect(retirementPill({ kind: "build", stage, receipt: CAPTURED })).toBeNull();
      expect(retirementPill({ kind: "build", stage, receipt: undefined })).toBeNull();
    }
  });

  it("shows NO pill on any kind but build", () => {
    // Workers report to their orchestrator, not to the founder's build list; a shell has no branch.
    // A pill here would put a retirement recommendation on rows he does not retire.
    for (const kind of ["worker", "shell", "think"]) {
      for (const stage of LANDED) {
        expect(retirementPill({ kind, stage, receipt: CAPTURED })).toBeNull();
        expect(retirementPill({ kind, stage, receipt: undefined })).toBeNull();
      }
    }
  });

  it("retirementRecommended agrees with the pill", () => {
    expect(retirementRecommended({ kind: "build", stage: "merged", receipt: CAPTURED })).toBe(true);
    expect(retirementRecommended({ kind: "build", stage: "merged", receipt: undefined })).toBe(false);
    expect(retirementRecommended({ kind: "worker", stage: "merged", receipt: CAPTURED })).toBe(false);
  });
});

describe("the attention taxonomy is UNTOUCHED by this feature", () => {
  // engine/workerRollup.ts warns twice that the taxonomy has drifted twice before, and
  // components/rowAttention.ts states the rule: a new state is a derived OVERLAY, never a status.
  // These assertions are the lock. If someone later routes the retirement pill through
  // `bandOfStatus` or `rollupDot` to make it filterable, this block fails and they have to come
  // read the reasoning first — which is the whole point of earning the state rather than adding one.

  it("adds no AgentTabStatus of ITS OWN — bandOfStatus still knows exactly twelve", () => {
    // "Exactly twelve" is an assertion rather than a claim in a test name (see ALL_STATUSES above).
    // It was ELEVEN until 2026-08-06, when `lapsed` (the amber "Auto-continue stopped" tier) landed
    // from a different branch. That is not this feature adding a status — which is what this block
    // locks — so the count moves and the four-band literal below does NOT: `lapsed` bands into the
    // gray `done` chip rather than earning a fifth, and the assertion that every status still lands
    // in one of exactly those four is the part that had to keep holding.
    expect(ALL).toHaveLength(12);
    // THE BAND SET IS PINNED TO A LITERAL, and that is the whole lock (roborev 59482). Deriving
    // `BAND_IDS` from `STATUS_BANDS` and asserting `toContain` was a TAUTOLOGY: `bandOfStatus`
    // returns `StatusBand` and `STATUS_BANDS` enumerates every `StatusBand`, so it could not fail
    // for any status — adding a `retirement` band to both sides would have passed silently, which
    // is the exact drift the prose above promises this block prevents. Derived from the type it
    // constrains, a guard proves nothing.
    const BAND_IDS = STATUS_BANDS.map((b) => b.id);
    expect(new Set(BAND_IDS)).toEqual(new Set(["needs_you", "questions", "running", "done"]));
    // And every status still lands in one of those four — checked against the literal, not against
    // whatever `STATUS_BANDS` happens to hold.
    for (const s of ALL) {
      expect(["needs_you", "questions", "running", "done"]).toContain(bandOfStatus(s));
    }
    // And nothing retirement-shaped has been smuggled in as a status. Meaningful only because `ALL`
    // is now exhaustive over the union: an invented member would have to appear here to typecheck.
    for (const invented of ["ready", "retro-pending", "retirement", "retire"]) {
      expect(ALL as string[]).not.toContain(invented);
    }
  });

  it("adds no RollupDot — a landed agent's disc is still decided by its own status alone", () => {
    // `unmerged` is the closest living precedent for "calm but still an ask", and it needed two
    // separate locks to survive the rollup. This feature deliberately contributes nothing here, so
    // a row carrying a RETRO PENDING pill paints exactly as it did before the pill existed.
    expect(rollupDot("done", [])).toBe("gray");
    expect(rollupDot("idle", [])).toBe("gray");
    expect(rollupDot("working", [])).toBe("green");
    expect(rollupDot("waiting", [])).toBe("red");
  });
});

describe("canAnswerRetroPing — the confirm dialog's WORDING, no longer a gate", () => {
  it("says a dead or crashed agent cannot answer", () => {
    // It used to gate the human override itself; roborev 59423 reversed that, because this is not a
    // liveness reading — an unreported status answers `true` (below), so the gate left every landed
    // row unretireable, the exact failure the override exists to prevent. What it decides now is
    // which sentence the dialog shows. Do not re-add the suppression.
    expect(canAnswerRetroPing("stopped")).toBe(false);
    expect(canAnswerRetroPing("errored")).toBe(false);
  });

  it("says a quota-blocked agent cannot answer even while it looks alive", () => {
    // A walled agent can sit in `working` and still be unable to run a turn. Reading the status
    // alone would leave it pinned in RETRO PENDING for as long as the outage lasts.
    expect(canAnswerRetroPing("working", true)).toBe(false);
    expect(canAnswerRetroPing("idle", true)).toBe(false);
  });

  it("says EVERY other status can answer — derived from the union, not a hand-written subset", () => {
    // This list used to be eight statuses typed out by hand, and it was NOT brought along when
    // `questions` arrived from main — so the one status this branch had to acknowledge two blocks
    // up had no assertion here at all (roborev 59482). Derived from `ALL`, a new status is covered
    // the moment the typecheck lock forces it into `ALL_STATUSES`.
    const reachable = ALL.filter((s) => !UNREACHABLE.includes(s));
    // 10 since 2026-08-06: `lapsed` is reachable. A lapsed agent's PTY is ALIVE — stallEscalation
    // refuses to escalate a row `aliveOf` denies — so it answers a retro ping exactly like `idle`.
    expect(reachable).toHaveLength(10);
    for (const s of reachable) expect(canAnswerRetroPing(s)).toBe(true);
    // And the two that cannot, from the same source — so the split is exhaustive by construction.
    for (const s of UNREACHABLE) expect(canAnswerRetroPing(s)).toBe(false);
  });

  it("fails closed TOWARD asking when the status is unknown", () => {
    // Wrong this way costs one unanswered ping. Wrong the other way offers a human an override —
    // a permanent recorded gap in the feedback record — for an agent that was about to reply.
    expect(canAnswerRetroPing(undefined)).toBe(true);
  });
});
