// Red means ONE thing: this agent cannot proceed without you.
//
// The 2026-07-26 report ("agents are red when they don't seem they should be, or vice versa") was
// not a classifier bug — the classifiers were right. It was a TAXONOMY bug: five statuses shared one
// color, and the two that meant "eventually" rather than "now" dominated a real fleet. Measured on
// the live app at the time of the report: 35 of ~40 agents were `idle`, and 27 of 51 sat in the
// committed-but-unlanded band — so 27 rows rendered RED "Needs merge", indistinguishable from the 4
// that were actually asking a question, and undismissable because the dismissal tier never covered
// `unmerged`.
//
// This file pins the separation that fixed it, across every surface that has its own opinion about
// what red means. Scope is deliberately narrow: ONLY facts that span modules live here, because an
// invariant restated in two suites has to be edited in two places (roborev on 4b3ede48). Per-module
// behaviour stays in that module's own suite — in particular every worker→orchestrator bubbling case
// is in workerAttention.test.ts, not here.
//
//   1. `unmerged` is NOT red. Landing state is carried by the workflow line + ✓, not by the alarm
//      color. It still sorts above the calm tier — and stays out of the concierge's calm band, which
//      is what the sidebar dims — so unlanded work stays visible.
//   2. The red COLOR tier (windowStatus.isRedStatus) and the "needs you NOW" set
//      (attention.needsAttention) are different sets, and code that means one must not reach for the
//      other. `blocked` is the status that separates them.
import { describe, expect, it } from "vitest";
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { isRedStatus } from "../services/windowStatus";
import { needsAttention } from "./attention";
import { withUnmergedWork } from "./unmergedAttention";
import { conciergeBand, isCalmBand } from "../services/conciergeFeed";

// ── 1. `unmerged` is not an alarm ────────────────────────────────────────────────────────────────

describe("unmerged is not red", () => {
  it("carries the calm gray ink, not the alarm red", () => {
    expect(AGENT_STATUS.unmerged.color).toBe(AGENT_STATUS.idle.color);
    expect(AGENT_STATUS.unmerged.color).not.toBe(AGENT_STATUS.waiting.color);
  });

  it("is excluded from BOTH red predicates", () => {
    expect(isRedStatus("unmerged")).toBe(false);
    expect(needsAttention("unmerged")).toBe(false);
  });

  it("keeps its own label — the row still says what it needs, just not in red", () => {
    expect(AGENT_STATUS.unmerged.label).toBe("Needs merge");
  });

  it("no longer moves rows around — position is workflow stage, not status", () => {
    // This used to assert an attention SORT put unmerged between the reds and the calm tier. That
    // sort is gone (engine/agentOrdering header): `unmerged` still says what it needs via its label
    // and via WHICH STAGE SECTION its row sits in, but it no longer relocates the row. The banding
    // that survives is the concierge interruption budget, asserted below.
    expect(AGENT_STATUS.unmerged.label).toBe("Needs merge");
  });

  it("escalation still fires — the status is applied, it just isn't an alarm color", () => {
    // The overlay itself is unchanged: a resting agent with unlanded work still reads `unmerged`,
    // which is what drives the sort position and the hover label.
    const agents = [{ id: "a" }];
    const out = withUnmergedWork(agents, { a: "idle" }, () => "building_saved");
    expect(out.a).toBe("unmerged");
    expect(isRedStatus(out.a)).toBe(false);
  });
});

// ── 2. The two sets meet: which module must ask which question ──────────────────────────────────
// The per-case bubbling behaviour lives in workerAttention.test.ts, where it belongs. What is pinned
// HERE is only the cross-module fact that makes those cases correct: `blocked` is red but is not an
// ask, so a module that needs "is this row red" and a module that needs "is this stopping the user"
// cannot share one predicate. Reaching for the wrong one is what shipped the original bug.
describe("the sets are not interchangeable", () => {
  it("blocked is the status that separates them", () => {
    expect(isRedStatus("blocked")).toBe(true);
    expect(needsAttention("blocked")).toBe(false);
  });

  it("every needs-you-now status is also red, but not the reverse", () => {
    const all: AgentTabStatus[] = [
      "working", "idle", "waiting", "approval", "blocked", "errored", "unmerged", "done", "stopped",
    ];
    for (const s of all.filter(needsAttention)) expect(isRedStatus(s)).toBe(true);
    expect(all.filter(isRedStatus).length).toBeGreaterThan(all.filter(needsAttention).length);
  });

  it("`unmerged` is in NEITHER red set", () => {
    expect(isRedStatus("unmerged")).toBe(false);
    expect(needsAttention("unmerged")).toBe(false);
  });
});

// ── 3. Band ≠ dimming: the two questions `unmerged` must answer differently ──────────────────────
// This is the trap the series fell into from both sides in consecutive commits. The concierge band is
// an INTERRUPTION budget (`needs_you` renders a nudge card, counts into "N Need you", lights a
// project tab); dimming is a LEGIBILITY treatment. `unmerged` must be quiet in the first and not
// muted in the second, so anything that conflates them breaks one or the other.
describe("unmerged: no interruption, but not dimmed either", () => {
  it("does not buy a concierge interruption (`done` — no nudge card, no count, no tab glow)", () => {
    // 27 of 51 agents sat in this band on the reported fleet. Banded needs_you that was 27 nudge cards.
    expect(conciergeBand("unmerged")).toBe("done");
  });

  it("`blocked` joins the reds in ONE band — the amber tier is gone", () => {
    // The status that separates isRedStatus from needsAttention (section 2) no longer gets its own
    // interruption tier: a gold "wants you eventually" card and a red "answer now" card both meant
    // "go look", so the second alarm color bought a distinction nobody acted on. It bands with the
    // asks, and the sidebar/tab/nudge treatments it drives are the same red as theirs.
    expect(conciergeBand("blocked")).toBe("needs_you");
    expect(conciergeBand("waiting")).toBe("needs_you");
    expect(isCalmBand("blocked")).toBe(false);
  });

  it("is NOT in the calm band the sidebar grayscales", () => {
    // The predicate AgentSidebar actually calls. Asserting the band instead would stay green while
    // the dimming silently came back.
    expect(isCalmBand("unmerged")).toBe(false);
  });

  it("the genuinely calm statuses still dim, and no red one does", () => {
    // `working` is its own BAND now (Running) and still calm: the band split changed where a row
    // sorts and what it counts toward, not what desaturates.
    for (const s of ["idle", "done", "stopped", "working"] as const) {
      expect(isCalmBand(s)).toBe(true);
    }
    for (const s of ["waiting", "approval", "errored", "blocked"] as const) {
      expect(isCalmBand(s)).toBe(false);
    }
  });
});
