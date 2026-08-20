// @vitest-environment jsdom
//
// THE ARM THE LEDGER CANNOT SEE: what `maybeAutoPlan` does with a plan prompt when the master
// auto-approve toggle is off.
//
// The defect this pins is an ORDERING one, and it is invisible to every other suite. Reporting a
// decline and THEN letting the caller hand off is the one combination `declineOrHandOff`'s own doc
// forbids, and both outcomes are wrong: a feed rebuild between the two writes latches the sticky
// `gaveUp` and interrupts the founder for a prompt the concierge accepted, and with no rebuild the
// later `escalated` overwrites the `declined` in the last-wins ledger so the report never happens.
//
// It needs its OWN file because it needs the hand-off MOCKED. In an ordinary unit-test window there
// is no concierge notifier, so `handOffToConcierge` always refuses and falls back to `declined` —
// which makes the correct and incorrect implementations record exactly the same thing.
import { describe, it, expect, vi, beforeEach } from "vitest";

const writePty = vi.fn((_id: string, _data: string) => Promise.resolve());
vi.mock("../../pty", () => ({
  writePtyChainedStrict: (id: string, data: string) => writePty(id, data),
}));

const aiFeatureVisibleNow = vi.fn((_key: string) => true);
vi.mock("../aiGate", () => ({ aiFeatureVisibleNow: (key: string) => aiFeatureVisibleNow(key) }));

// THE SEAM. `true` = the concierge accepted the prompt; `false` = it refused (nobody to route to).
const handOffToConcierge = vi.fn((_agentId: string, _scrollback: string) => true);
vi.mock("./conciergeHandoff", () => ({
  handOffToConcierge: (id: string, sb: string) => handOffToConcierge(id, sb),
}));

import { maybeAutoPlan } from "./approvalsRuntime";
import { useSettingsStore } from "../../stores/settingsStore";
import { useApprovalsStore } from "../../stores/approvalsStore";
import { useProjectStore } from "../../stores/projectStore";
import {
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  type PromptAnswerOutcome,
} from "../../engine/blockedPromptGrace";
import { PLAN_EXIT_PROMPT } from "./planPrompt.fixture";

const reported = (agentId: string): PromptAnswerOutcome | undefined =>
  windowPromptGraceLedger().outcome.get(agentId)?.outcome;

beforeEach(() => {
  resetPromptGraceLedgerForTests();
  writePty.mockReset();
  writePty.mockResolvedValue(undefined);
  handOffToConcierge.mockReset();
  handOffToConcierge.mockReturnValue(true);
  aiFeatureVisibleNow.mockReturnValue(true);
  useProjectStore.setState({ projects: [] });
  useApprovalsStore.setState({ byRoot: {}, resumeByRoot: {}, planByRoot: {} });
  useSettingsStore.setState({ approvals: { bash: "always" }, resumeRule: "ask", planRule: "auto" });
});

describe("maybeAutoPlan — the master toggle is off", () => {
  it("offers the prompt to the concierge and records NO decline when it is accepted", () => {
    aiFeatureVisibleNow.mockReturnValue(false);
    expect(maybeAutoPlan("a1", PLAN_EXIT_PROMPT, new Set())).toBeNull();
    expect(handOffToConcierge).toHaveBeenCalledWith("a1", PLAN_EXIT_PROMPT);
    // ← the assertion that fails against a bare `declined()` here: the give-up must not latch for a
    // prompt something else has just taken responsibility for.
    expect(reported("a1")).toBeUndefined();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("records `declined` when the hand-off REFUSES — the founder really is the answerer then", () => {
    // The paired case. Asserting only the absence above would pass just as well against a path that
    // never reports anything at all.
    aiFeatureVisibleNow.mockReturnValue(false);
    handOffToConcierge.mockReturnValue(false);
    expect(maybeAutoPlan("a1", PLAN_EXIT_PROMPT, new Set())).toBeNull();
    expect(reported("a1")).toBe("declined");
  });
});

describe("maybeAutoPlan — an explicit plan='ask' never routes onward", () => {
  it("records `declined` and does NOT offer the prompt to the concierge", () => {
    // "Ask me" is a statement about WHO decides, not merely about who presses. Routing it onward
    // would let the concierge answer the prompt the settings row promised to show him.
    useSettingsStore.setState({ planRule: "ask" });
    expect(maybeAutoPlan("a1", PLAN_EXIT_PROMPT, new Set())).toBe("asked");
    expect(handOffToConcierge).not.toHaveBeenCalled();
    expect(reported("a1")).toBe("declined");
  });
});
