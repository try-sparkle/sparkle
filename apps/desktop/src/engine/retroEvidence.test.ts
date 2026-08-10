import { describe, it, expect } from "vitest";
import {
  feedbackEvidence,
  countAgentFeedbackBeads,
  retroStanding,
  mayRecordRetroGap,
  FEEDBACK_EVIDENCE_MAX_AGE_MS,
  type LabelledBead,
} from "./retroEvidence";

const AID = "1aab9bce-c4ad-498f-bb6b-899fc08e1e00";
const NOW = 1_700_000_000_000;

const bead = (...labels: string[]): LabelledBead => ({ labels });
/** Two beads from this agent, plus noise from another agent and an unlabelled one. */
const MIXED: LabelledBead[] = [
  bead("agent-feedback", `agent:${AID}`, "seen-1"),
  bead("agent-feedback", "agent:someone-else"),
  bead("agent-feedback", `agent:${AID}`, "epic:improve-sparkle"),
  bead("chore"),
];

describe("countAgentFeedbackBeads", () => {
  it("counts only beads carrying this agent's label", () => {
    expect(countAgentFeedbackBeads(MIXED, AID)).toBe(2);
  });

  it("does not match on a prefix — `agent:abc` must not count for `agent:ab`", () => {
    // `labels.includes` is an array-membership test, not a substring test. Pinned because the
    // obvious "optimisation" to a `.some(l => l.startsWith(...))` would silently over-count.
    expect(countAgentFeedbackBeads([bead(`agent:${AID}x`)], AID)).toBe(0);
  });
});

describe("feedbackEvidence", () => {
  it("reports the count when the agent has beads", () => {
    expect(feedbackEvidence({ beads: MIXED, polledAt: NOW, agentId: AID, now: NOW })).toEqual({
      kind: "reported",
      count: 2,
    });
  });

  it("says `none` only for a fresh, successful, empty read", () => {
    expect(
      feedbackEvidence({ beads: [bead("agent:other")], polledAt: NOW, agentId: AID, now: NOW }),
    ).toEqual({ kind: "none" });
  });

  // ── THE THREE WAYS WE MUST SAY "I CANNOT TELL" ────────────────────────────────────────────────
  // Each of these previously collapsed into "nothing has been recorded", which is the accusation.

  it("says `unknown` when there is no snapshot at all (beads disabled / never loaded)", () => {
    expect(
      feedbackEvidence({ beads: undefined, polledAt: NOW, agentId: AID, now: NOW }),
    ).toEqual({ kind: "unknown" });
  });

  it("says `unknown` when no successful read has ever completed", () => {
    expect(
      feedbackEvidence({ beads: [], polledAt: undefined, agentId: AID, now: NOW }),
    ).toEqual({ kind: "unknown" });
  });

  it("says `unknown` when the last successful read has aged out — the STARVED-STORE case", () => {
    // `polledAt` is stamped only on success, so a poller that has been failing leaves it frozen and
    // this gate is what turns that into "cannot tell" instead of "reported nothing".
    expect(
      feedbackEvidence({
        beads: [],
        polledAt: NOW - FEEDBACK_EVIDENCE_MAX_AGE_MS - 1,
        agentId: AID,
        now: NOW,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("still trusts a zero that is exactly at the freshness boundary", () => {
    expect(
      feedbackEvidence({
        beads: [],
        polledAt: NOW - FEEDBACK_EVIDENCE_MAX_AGE_MS,
        agentId: AID,
        now: NOW,
      }),
    ).toEqual({ kind: "none" });
  });

  // ── THE ASYMMETRY ─────────────────────────────────────────────────────────────────────────────
  it("trusts a POSITIVE count no matter how stale — staleness downgrades only the negative", () => {
    // Beads on this path are only ever created, so an old sighting of feedback is still proof the
    // agent reported. Ageing this out would re-open the exact false-accusation path being fixed.
    expect(
      feedbackEvidence({
        beads: MIXED,
        polledAt: NOW - FEEDBACK_EVIDENCE_MAX_AGE_MS * 100,
        agentId: AID,
        now: NOW,
      }),
    ).toEqual({ kind: "reported", count: 2 });
  });

  it("trusts a positive count even when no successful read was ever stamped", () => {
    expect(
      feedbackEvidence({ beads: MIXED, polledAt: undefined, agentId: AID, now: NOW }),
    ).toEqual({ kind: "reported", count: 2 });
  });
});

describe("retroStanding", () => {
  it("a receipt on file wins over everything else", () => {
    expect(retroStanding(true, { kind: "none" })).toEqual({ kind: "settled" });
    expect(retroStanding(true, { kind: "reported", count: 9 })).toEqual({ kind: "settled" });
  });

  it("no receipt + feedback beads is `reported`, carrying the count for the copy", () => {
    expect(retroStanding(false, { kind: "reported", count: 2 })).toEqual({
      kind: "reported",
      count: 2,
    });
  });

  it("no receipt + unreadable backlog is `unknown`, never `absent`", () => {
    expect(retroStanding(false, { kind: "unknown" })).toEqual({ kind: "unknown" });
  });

  it("no receipt + a trustworthy empty read is `absent`", () => {
    expect(retroStanding(false, { kind: "none" })).toEqual({ kind: "absent" });
  });
});

describe("mayRecordRetroGap", () => {
  // THE LOAD-BEARING ASSERTION. A gap note is permanent and undeletable, so this is the predicate
  // that decides whether a false mark can be written at all.
  it("permits a gap note ONLY when the agent demonstrably reported nothing", () => {
    expect(mayRecordRetroGap({ kind: "absent" })).toBe(true);
  });

  it("refuses a gap note against an agent that filed feedback", () => {
    expect(mayRecordRetroGap({ kind: "reported", count: 1 })).toBe(false);
  });

  it("refuses a gap note when the backlog could not be read", () => {
    expect(mayRecordRetroGap({ kind: "unknown" })).toBe(false);
  });

  it("refuses a gap note when a receipt already settles it", () => {
    expect(mayRecordRetroGap({ kind: "settled" })).toBe(false);
  });
});

// ── THE END-TO-END SHAPE OF THE BUG THE FOUNDER SAW ──────────────────────────────────────────────
describe("the reported contradiction", () => {
  it("an agent whose row shows FEEDBACK 2 is never in a gap-recording state", () => {
    // Exactly the screenshot: agent "Agents Inherit Permission Allowlist", no receipt, pill "FEEDBACK 2".
    const evidence = feedbackEvidence({ beads: MIXED, polledAt: NOW, agentId: AID, now: NOW });
    const standing = retroStanding(false, evidence);

    expect(standing).toEqual({ kind: "reported", count: 2 });
    expect(mayRecordRetroGap(standing)).toBe(false);
  });
});
