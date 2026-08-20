// THE DISC TEST for the founder's 2026-08-19 rule: gray is legal only in a terminal section.
//
// ⚠️ IT EXERCISES `dotFillFor`, THE EXPORTED DECISION THE ROW ACTUALLY CALLS — not a local copy of
// it. The previous version of this file re-implemented the production expression inline, so it could
// not fail on the change it claimed to guard: reverting the call site left every case green while
// the disc went back to rendering gray. That is the vacuous shape AGENTS.md warns about, and it hid
// a real bug for a whole review round.
//
// THE BUG IT HID, because it explains why the disc is the thing under test and not `statusColor`:
// `AgentSidebar` computes a floored `paintSt` and passes its colour to `AgentRow` as `statusColor`,
// which feeds the founder-ask chip, the kind glyph and the alert toggle ONLY (`AgentRow.tsx:813`).
// `StatusDot` computes `ink = color ?? meta.color`, so a disc handed `undefined` paints from the RAW
// status. An ordinary `unmerged` row in a pre-terminal section therefore kept its gray disc through
// two commits that claimed to have fixed it.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS } from "../src/theme/colors";
import { ROLLUP_DOT_COLOR, dotFillFor } from "./components/rowClock";
import { sectionFromReadings, type BuildSectionId } from "./engine/buildSections";
import type { BranchStatus } from "./services/branchStatus";
import type { RollupDot } from "./engine/workerRollup";
import type { AgentTabStatus } from "./types";

const GRAY = AGENT_STATUS.idle.color;
const AMBER = AGENT_STATUS.lapsed.color;

/** The disc's actual fill, exactly as `StatusDot` resolves it: `ink = color ?? meta.color`. */
function disc(
  status: AgentTabStatus,
  section: BuildSectionId | undefined,
  rollup: RollupDot = "gray",
  overrides = false,
) {
  return dotFillFor(status, section, rollup, overrides) ?? AGENT_STATUS[status].color;
}

const PRE_TERMINAL = [
  "local_none",
  "local_uncommitted",
  "local_committed",
  "local_merged",
  "remote_pushed",
  "remote_pr",
] as const;

describe("the row's DISC is never gray outside a terminal section", () => {
  it("paints amber in every pre-terminal section, for every gray status", () => {
    // Both loops at once: a rule keyed to the wrong rung, or covering only the two statuses the
    // complaint named, fails here rather than passing on the one case someone wrote a test for.
    for (const section of PRE_TERMINAL) {
      for (const st of ["idle", "unmerged", "done", "stopped", "new"] as const) {
        expect(disc(st, section), `${st} in ${section} must not paint gray`).toBe(AMBER);
      }
    }
  });

  it("keeps gray in BOTH terminal sections — the paired positive", () => {
    // Without this, "nothing is gray" would also pass for a rule that repainted unconditionally,
    // destroying the one state the founder said gray is FOR.
    for (const section of ["remote_merged", "remote_shipped"] as const) {
      expect(disc("unmerged", section), section).toBe(GRAY);
      expect(disc("idle", section), section).toBe(GRAY);
    }
  });

  it("EVIDENCE, NOT INFERENCE — an unread section paints unchanged", () => {
    // `resolveStage` floors at the first rung instead of returning undefined, so deriving the
    // section through it would manufacture a pre-terminal section for a row nobody polled and
    // repaint the whole unpolled fleet amber. This is also what keeps a brand-new agent calm.
    expect(disc("idle", undefined)).toBe(GRAY);
    expect(disc("unmerged", undefined)).toBe(GRAY);
    expect(dotFillFor("idle", undefined, "gray", false)).toBeUndefined();
  });

  it("returns undefined for an unaffected row, so StatusDot keeps its own fallback", () => {
    // The helper must not become a second, drifting source of truth for ordinary colours.
    expect(dotFillFor("working", "local_committed", "gray", false)).toBeUndefined();
    expect(dotFillFor("idle", "remote_merged", "gray", false)).toBeUndefined();
  });

  it("never repaints a NON-gray status", () => {
    // Blast radius: keyed on anything but grayness this could repaint a red disc and silently
    // un-page the founder — the exact inverse of the rule.
    for (const st of ["waiting", "approval", "errored", "questions", "working", "blocked"] as const) {
      expect(disc(st, "local_committed"), st).toBe(AGENT_STATUS[st].color);
    }
  });
});

describe("the rolled-up disc obeys the same rule", () => {
  it("repaints a GRAY rollup in a pre-terminal section, and keeps it in a terminal one", () => {
    for (const section of PRE_TERMINAL) {
      expect(dotFillFor("idle", section, "gray", true), section).toBe(AMBER);
    }
    expect(dotFillFor("idle", "remote_merged", "gray", true)).toBe(ROLLUP_DOT_COLOR.gray);
    expect(dotFillFor("idle", undefined, "gray", true)).toBe(ROLLUP_DOT_COLOR.gray);
  });

  it("never touches a rollup dot that is not gray", () => {
    // The subtree colours carry "a worker needs you" and must survive intact.
    for (const r of ["green", "red", "blue", "orange"] as const) {
      expect(dotFillFor("idle", "local_committed", r, true), r).toBe(ROLLUP_DOT_COLOR[r]);
    }
  });

  it("agrees with the row's own disc on the same section", () => {
    // Two paint paths, one rule. A head whose own disc went amber while its rolled-up disc stayed
    // gray is exactly the half-fixed state this keeps being rediscovered as.
    expect(dotFillFor("idle", "local_committed", "gray", true)).toBe(disc("idle", "local_committed"));
  });

  it("the two paints are actually different colours", () => {
    expect(AMBER).not.toBe(GRAY);
  });
});

// ── THE EVIDENCE GUARD ITSELF ───────────────────────────────────────────────────────────────────
// `sectionFromReadings` is what decides whether the rule may speak for a row at all, and its
// `undefined` is load-bearing: `resolveStage` FLOORS at the first rung instead of returning
// undefined, so a section derived through it would be PRE-TERMINAL for every row nobody polled — and
// the gray rule would then repaint the entire unpolled fleet amber on our own ignorance.
//
// Untested until now, and it is exactly the kind of guard that goes quietly wrong: it fails OPEN
// (everything gets a section) rather than closed, so nothing else in the suite would notice.
describe("the section is only derived when the git state was actually read", () => {
  const bs = (ahead: number): BranchStatus => ({
    ahead,
    behind: 0,
    dirty: false,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  });

  it("NEITHER reading — undefined, so nothing is repainted", () => {
    expect(sectionFromReadings(undefined, undefined)).toBeUndefined();
    // …and the rule therefore declines, which is the property that matters downstream.
    expect(dotFillFor("unmerged", sectionFromReadings(undefined, undefined), "gray", false))
      .toBeUndefined();
  });

  it("branch status ALONE is enough to have looked", () => {
    expect(sectionFromReadings(bs(2), undefined)).toBeDefined();
  });

  it("a stage override ALONE is enough to have looked", () => {
    expect(sectionFromReadings(undefined, "merged")).toBe("remote_merged");
    expect(sectionFromReadings(undefined, "building_saved")).toBe("local_committed");
  });

  it("does NOT floor an unread row into a pre-terminal section", () => {
    // The failure this guard exists to prevent, stated as its own case: were it composed as
    // `sectionOfStage(resolveStage(...))`, an unread row would come back `local_uncommitted` — a
    // pre-terminal section — and every unpolled row in the fleet would repaint amber.
    const unread = sectionFromReadings(undefined, undefined);
    expect(unread).not.toBe("local_uncommitted");
    expect(unread).toBeUndefined();
  });
});
