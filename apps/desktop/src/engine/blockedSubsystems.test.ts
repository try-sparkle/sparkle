import { describe, expect, it } from "vitest";
import {
  AI_ENHANCED_LABEL,
  CONCIERGE_LABEL,
  GENERIC_AGENT_LABEL,
  IMPROVE_SPARKLE_LABEL,
  computeBlockedSubsystems,
  exhaustedAccountIds,
  summarizeBlocked,
  type BlockedSubsystemsInput,
} from "./blockedSubsystems";
// The REAL production predicate, not a hand-mirror — so reverting the wiring to exact-id equality
// (the exact defect the High finding fixed) makes these tests fail.
import { SPARKLE_AGENT_ID, isSparkleAgentId } from "../services/sparkleAgent";

const NOW = 1_000_000;
const SPARKLE_ID = SPARKLE_AGENT_ID;
const isSparkle = isSparkleAgentId;

/** A fully-healthy input: nothing benched, one default account, sticky consumers on it. Each test
 *  perturbs exactly one thing, so a failure names the rule that broke. */
function baseInput(overrides: Partial<BlockedSubsystemsInput> = {}): BlockedSubsystemsInput {
  return {
    now: NOW,
    usage: [{ id: "acct-default", exhaustedUntil: null }],
    oneshotAccountId: "acct-default",
    improveSparkleAccountId: "acct-default",
    conciergeAccountId: "acct-default",
    panes: [],
    agentNames: {},
    isImproveSparkleAgentId: isSparkle,
    ...overrides,
  };
}

const labels = (input: BlockedSubsystemsInput) => computeBlockedSubsystems(input).map((b) => b.label);

describe("exhaustedAccountIds", () => {
  it("includes only accounts benched to a FUTURE instant", () => {
    const ids = exhaustedAccountIds(
      [
        { id: "future", exhaustedUntil: NOW + 1 },
        { id: "past", exhaustedUntil: NOW - 1 },
        { id: "now", exhaustedUntil: NOW }, // boundary: not strictly future → not blocked
        { id: "none", exhaustedUntil: null },
      ],
      NOW,
    );
    expect([...ids].sort()).toEqual(["future"]);
  });
});

describe("computeBlockedSubsystems", () => {
  it("returns nothing when no account is exhausted", () => {
    expect(computeBlockedSubsystems(baseInput())).toEqual([]);
  });

  it("lists AI Enhancement Features when the default (one-shot) account is exhausted", () => {
    const input = baseInput({
      usage: [{ id: "acct-default", exhaustedUntil: NOW + 5000 }],
      improveSparkleAccountId: "acct-other",
      conciergeAccountId: "acct-other",
    });
    expect(labels(input)).toEqual([AI_ENHANCED_LABEL]);
  });

  it("lists BOTH Improve Sparkle and AI Enhancement Features when they SHARE the exhausted account (the founder's single-account case)", () => {
    // AI-Enhanced (default account) and Improve Sparkle both bound to the one benched account — the
    // exact co-failure the founder saw. Both must appear, AI-Enhanced first (worst blast radius).
    const input = baseInput({
      usage: [{ id: "acct-default", exhaustedUntil: NOW + 5000 }],
      oneshotAccountId: "acct-default",
      improveSparkleAccountId: "acct-default",
      conciergeAccountId: "acct-other",
    });
    expect(labels(input)).toEqual([AI_ENHANCED_LABEL, IMPROVE_SPARKLE_LABEL]);
  });

  it("lists Improve Sparkle alone when only ITS account is exhausted (AI-Enhanced on a healthy account)", () => {
    const input = baseInput({
      usage: [
        { id: "acct-default", exhaustedUntil: null },
        { id: "acct-improve", exhaustedUntil: NOW + 5000 },
      ],
      oneshotAccountId: "acct-default",
      improveSparkleAccountId: "acct-improve",
      conciergeAccountId: "acct-default",
    });
    expect(labels(input)).toEqual([IMPROVE_SPARKLE_LABEL]);
  });

  it("names mounted build-agent panes on an exhausted account, sorted by display name, and de-dupes the Improve Sparkle pane", () => {
    const input = baseInput({
      usage: [
        { id: "acct-default", exhaustedUntil: null },
        { id: "acct-pool", exhaustedUntil: NOW + 5000 },
      ],
      // Nothing fixed is blocked; only the pool account holding these panes is.
      oneshotAccountId: "acct-default",
      improveSparkleAccountId: "acct-improve-healthy",
      conciergeAccountId: "acct-default",
      panes: [
        { agentId: "a1", accountId: "acct-pool" }, // "Zebra Flow"
        { agentId: "a2", accountId: "acct-pool" }, // "Alpha Rail"
        { agentId: "a3", accountId: "acct-default" }, // healthy account → not blocked
        { agentId: SPARKLE_ID, accountId: "acct-pool" }, // the main Improve Sparkle pane → deduped
        { agentId: `${SPARKLE_ID}-win-abc`, accountId: "acct-pool" }, // a SATELLITE-window Improve Sparkle pane
        { agentId: "a4", accountId: "acct-pool" }, // exhausted, NO display name → generic label, never raw id
      ],
      agentNames: { a1: "Zebra Flow", a2: "Alpha Rail", a3: "Healthy One" },
    });
    // Sorted by label; a3 excluded (healthy account); BOTH the canonical and the `-win-abc` Improve
    // Sparkle panes excluded (dedup), so no raw internal id leaks; a4 kept under the generic label.
    const out = labels(input);
    expect(out).toEqual(["Alpha Rail", GENERIC_AGENT_LABEL, "Zebra Flow"]);
    expect(out.join(" ")).not.toContain(SPARKLE_ID);
    expect(out.join(" ")).not.toContain("a4"); // the raw id must never appear
  });

  it("keeps a nameless exhausted pane under a generic label rather than rendering nothing (silence is worse than a generic name)", () => {
    // The ONLY blocked binding is a build-agent pane whose name has not hydrated. It must still show.
    const input = baseInput({
      usage: [
        { id: "acct-default", exhaustedUntil: null },
        { id: "acct-pool", exhaustedUntil: NOW + 5000 },
      ],
      oneshotAccountId: "acct-default",
      improveSparkleAccountId: "acct-default",
      conciergeAccountId: "acct-default",
      panes: [{ agentId: "nameless-1", accountId: "acct-pool" }],
      agentNames: {},
    });
    expect(labels(input)).toEqual([GENERIC_AGENT_LABEL]);
  });

  it("orders fixed subsystems AI-Enhanced → Improve Sparkle → Concierge, then agents", () => {
    const input = baseInput({
      usage: [{ id: "acct-default", exhaustedUntil: NOW + 5000 }],
      oneshotAccountId: "acct-default",
      improveSparkleAccountId: "acct-default",
      conciergeAccountId: "acct-default",
      panes: [{ agentId: "a1", accountId: "acct-default" }],
      agentNames: { a1: "Some Build Agent" },
    });
    expect(labels(input)).toEqual([
      AI_ENHANCED_LABEL,
      IMPROVE_SPARKLE_LABEL,
      CONCIERGE_LABEL,
      "Some Build Agent",
    ]);
  });

  it("does not list a subsystem whose account is benched only in the PAST", () => {
    const input = baseInput({
      usage: [{ id: "acct-default", exhaustedUntil: NOW - 1 }],
    });
    expect(computeBlockedSubsystems(input)).toEqual([]);
  });
});

describe("summarizeBlocked", () => {
  const list = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `Item ${i}` }));

  it("shows every label and no overflow when the list fits", () => {
    expect(summarizeBlocked(list(2), 2)).toEqual({
      visible: ["Item 0", "Item 1"],
      overflow: 0,
    });
  });

  it("caps visible labels and rolls the remainder into the overflow count (the '+N more' shape)", () => {
    // 26 blocked, cap 2 → "Item 0, Item 1 + 24 more", matching the founder's own example.
    expect(summarizeBlocked(list(26), 2)).toEqual({
      visible: ["Item 0", "Item 1"],
      overflow: 24,
    });
  });
});
