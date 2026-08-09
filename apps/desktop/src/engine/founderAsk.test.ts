import { describe, expect, it } from "vitest";
import { askFor, FOUNDER_ASK_LABEL, FOUNDER_ASK_DETAIL, type FounderAsk } from "./founderAsk";
import { isRedStatus } from "../services/windowStatus";
import { needsAttention } from "./attention";
import { bandOfStatus } from "./buildSections";
import type { AgentTabStatus } from "../types";

// The founder, on a finished agent — goal met, six PRs merged, roborev closed, worktree clean:
// *"why it is showing as blocked"*. He opened it expecting a problem and found a completed job.
// And the generalisation he asked for: *"any row where the founder's action is a CONFIRMATION
// rather than an unblocking should name the confirmation. A person should be able to tell 'press
// yes to finish this' from 'something is wrong' without opening the pane."*
//
// This suite pins BOTH halves — the words each ask uses, and the guarantee that naming an ask can
// never change which rows are red.

describe("naming the ask — a red row says what it wants", () => {
  const ask = (status: AgentTabStatus) => askFor({ status });

  it("a question on screen → ANSWER, and the label leads with the verb", () => {
    expect(ask("waiting")).toBe("answer");
    // The founder's complaint was that "Needs you" told him nothing about what to do. The fix is
    // that the label names his next thirty seconds, so it must not be the generic word.
    expect(FOUNDER_ASK_LABEL.answer).toMatch(/^Answer/);
    expect(FOUNDER_ASK_LABEL.answer).not.toMatch(/needs you/i);
  });

  it("a permission prompt → APPROVE", () => {
    expect(ask("approval")).toBe("approve");
    expect(FOUNDER_ASK_LABEL.approve).toMatch(/^Approve/);
  });

  it("crashed or stall-escalated → UNSTICK, the only arm that means something is wrong", () => {
    expect(ask("errored")).toBe("unstick");
    expect(ask("blocked")).toBe("unstick");
    expect(FOUNDER_ASK_DETAIL.unstick).toMatch(/something is wrong/i);
  });

  it("a calm row asks nothing — this is not chrome on every row", () => {
    for (const s of ["idle", "done", "working", "new", "stopped", "lapsed", "unmerged"] as const) {
      expect(ask(s)).toBe(null);
    }
  });

  it("EVERY ask this module can raise is REACHABLE from a real status", () => {
    // ⚠️ THE GUARD THE FIRST CUT LACKED (roborev on 8148084b6). It shipped a `confirm-retire` arm
    // gated on `retirementReady && status === "unmerged"` — two predicates that are DISJOINT over
    // the same stage value, so the arm was dead code. Its test hand-built that pair, pinning the
    // wording while proving nothing about reachability.
    //
    // So this asserts the property that failure violated: every member of the union is produced by
    // SOME status, and the domain is compiler-enforced, so a newly added arm that nothing can reach
    // fails here instead of shipping as decoration.
    const ALL = Object.keys({
      answer: 0,
      approve: 0,
      unstick: 0,
    } satisfies Record<FounderAsk, number>) as FounderAsk[];
    const EVERY_STATUS: AgentTabStatus[] = [
      "waiting", "approval", "errored", "blocked",
      "idle", "done", "working", "new", "stopped", "lapsed", "unmerged", "questions",
    ];
    const reachable = new Set(EVERY_STATUS.map((s) => askFor({ status: s })).filter(Boolean));
    for (const a of ALL) expect(reachable.has(a)).toBe(true);
  });
});

// ── DO NOT REGRESS THE THING THE RED-TIER WORK JUST FIXED ────────────────────────────────────────
//
// `engine/retirementReadiness`'s header is explicit that retirement-readiness must stay OUT of the
// attention taxonomy, because routing it through `bandOfStatus` puts every merged-but-unretired
// agent — most of the list at any moment — into `needs_you`. Naming an ask must not smuggle it in.
describe("naming an ask NEVER changes which rows are red", () => {
  it("no calm status acquires an ask, whatever else is true of the row", () => {
    // THE LOAD-BEARING CASE, and it is now stated in terms `askFor` actually reads. The previous
    // version passed a `retirementReady: true` that production cannot pair with a calm status, so
    // it would have passed with the guard deleted — vacuous in exactly the way it warned against.
    for (const s of ["idle", "done", "stopped", "unmerged", "new", "lapsed"] as const) {
      expect(askFor({ status: s })).toBe(null);
      expect(isRedStatus(s)).toBe(false);
    }
  });

  it("`unmerged` is still GRAY and still not an alarm", () => {
    expect(isRedStatus("unmerged")).toBe(false);
    expect(needsAttention("unmerged")).toBe(false);
    expect(bandOfStatus("unmerged")).not.toBe("needs_you");
  });

  it("the genuinely red statuses are untouched — still red, still notified", () => {
    for (const s of ["waiting", "approval", "errored", "blocked"] as const) {
      expect(isRedStatus(s)).toBe(true);
      // …and each one now has words, which is the entire point.
      const a = askFor({ status: s });
      expect(a).not.toBe(null);
      expect(FOUNDER_ASK_LABEL[a!].length).toBeGreaterThan(0);
    }
    expect(needsAttention("waiting")).toBe(true);
    expect(needsAttention("approval")).toBe(true);
  });

  it("EVERY ask has both a label and a detail — no arm can ship wordless", () => {
    const all: FounderAsk[] = ["answer", "approve", "unstick"];
    for (const a of all) {
      expect(FOUNDER_ASK_LABEL[a].trim().length).toBeGreaterThan(0);
      expect(FOUNDER_ASK_DETAIL[a].trim().length).toBeGreaterThan(10);
    }
    // The actionable asks carry the affordance marker; `unstick` deliberately does not, because it
    // is not a single press.
    for (const a of ["answer", "approve"] as const) {
      expect(FOUNDER_ASK_LABEL[a]).toMatch(/\u203a$/);
    }
    expect(FOUNDER_ASK_LABEL.unstick).not.toMatch(/\u203a$/);
  });
});
