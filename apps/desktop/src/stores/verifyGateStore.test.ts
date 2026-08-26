// verifyGateStore — the fail-closed rules, and the two folds that must not lose detail.
//
// What these assert is the SIDE EFFECT of a fold, never that a fixture has the fields it was
// written with. The store's whole job is to be the one place the panel reads from, so the failures
// worth catching are: a status poll that silently blanks a report, an unknown gate that renders as
// "clear to open a PR", and a steady-state poll that churns subscribers.
import { beforeEach, describe, expect, it } from "vitest";
import {
  UNKNOWN_PR_GATE,
  emptyEntry,
  entryFor,
  humanMs,
  isJudged,
  isJudgedFailure,
  statusLabel,
  useVerifyGateStore,
  verdictLabel,
  type CheckResult,
  type EvidenceItem,
  type VerifyGateReport,
  type VerifyGateStatus,
} from "./verifyGateStore";

function check(name: string, status: CheckResult["status"]): CheckResult {
  return {
    name,
    cmd: `pnpm run ${name}`,
    status,
    exitCode: status === "pass" ? 0 : status === "fail" ? 1 : null,
    durationMs: 1500,
    tail: "",
    logPath: null,
  };
}

function report(checks: CheckResult[], verdict: VerifyGateReport["verdict"]): VerifyGateReport {
  return {
    version: 1,
    agentId: "a1",
    worktree: "/w/tree",
    // `null`, not undefined — serde emits None as an explicit null (see the store's header).
    branch: null,
    checks,
    verdict,
    startedAt: 1000,
    finishedAt: 4000,
  };
}

function status(over: Partial<VerifyGateStatus> = {}): VerifyGateStatus {
  return {
    agentId: "a1",
    running: false,
    verdict: null,
    checksTotal: 0,
    checksPassed: 0,
    finishedAt: null,
    enabled: true,
    prGate: { allowed: false, reason: "no verification report exists", enforced: true },
    ...over,
  };
}

beforeEach(() => {
  useVerifyGateStore.setState({ byAgent: {} });
});

describe("a never-seen agent is fail-closed, not optimistic", () => {
  it("refuses the PR gate before anything has been read", () => {
    const e = entryFor(useVerifyGateStore.getState(), "never-seen");
    // The side effect that matters: an unknown gate must NOT read as permission.
    expect(e.prGate.allowed).toBe(false);
    expect(e.prGate).toEqual(UNKNOWN_PR_GATE);
    expect(e.report).toBeNull();
  });

  it("hands back a blank rather than undefined", () => {
    expect(entryFor(useVerifyGateStore.getState(), "nobody")).toEqual(emptyEntry());
  });

  it("returns the SAME blank object every time, so a selector cannot loop", () => {
    // Measured regression: `entryFor` used to build a fresh object on a miss. Read inside a zustand
    // selector that returns a new reference on every render, so `Object.is` never short-circuits and
    // React re-renders until "Maximum update depth exceeded" — on exactly the never-run agents the
    // panel exists to handle. Identity, not equality, is the property that fixes it.
    const a = entryFor(useVerifyGateStore.getState(), "nobody");
    const b = entryFor(useVerifyGateStore.getState(), "nobody");
    const c = entryFor(useVerifyGateStore.getState(), "somebody-else");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe("applyStatus", () => {
  it("keeps the report's CHECK DETAIL that a status reply does not carry", () => {
    const s = useVerifyGateStore.getState();
    s.applyReport("a1", report([check("typecheck", "pass"), check("test", "fail")], "fail"), []);
    s.applyStatus(status({ verdict: "fail", checksTotal: 2, checksPassed: 1 }));
    // A poll that replaced the entry with the status payload would leave the panel with a verdict
    // and no rows — it flashes empty between ticks and the failing check's name disappears.
    expect(entryFor(useVerifyGateStore.getState(), "a1").report?.checks).toHaveLength(2);
    expect(entryFor(useVerifyGateStore.getState(), "a1").report?.checks[1]?.name).toBe("test");
  });

  it("adopts a verdict the wire disagrees with, since the FILE is authoritative", () => {
    const s = useVerifyGateStore.getState();
    s.applyReport("a1", report([check("test", "pass")], "pass"), []);
    // Another window re-ran the gate and it went red; our cached report is stale.
    s.applyStatus(status({ verdict: "fail" }));
    expect(entryFor(useVerifyGateStore.getState(), "a1").report?.verdict).toBe("fail");
  });

  it("drops a report the backend says no longer exists", () => {
    const s = useVerifyGateStore.getState();
    s.applyReport("a1", report([check("test", "pass")], "pass"), []);
    s.applyStatus(status({ verdict: null }));
    expect(entryFor(useVerifyGateStore.getState(), "a1").report).toBeNull();
  });

  it("carries the backend's PR-gate decision through verbatim", () => {
    useVerifyGateStore.getState().applyStatus(
      status({
        verdict: "pass",
        prGate: { allowed: true, reason: "all 2 checks passed", enforced: true },
      }),
    );
    const e = entryFor(useVerifyGateStore.getState(), "a1");
    expect(e.prGate.allowed).toBe(true);
    expect(e.prGate.reason).toBe("all 2 checks passed");
  });

  it("does not notify subscribers on an identical repeat", () => {
    let notifications = 0;
    const unsub = useVerifyGateStore.subscribe(() => {
      notifications += 1;
    });
    const s = useVerifyGateStore.getState();
    s.applyStatus(status());
    const afterFirst = notifications;
    s.applyStatus(status());
    s.applyStatus(status());
    unsub();
    // The side effect: a 5s poll on an idle agent must not re-render the panel forever.
    expect(notifications).toBe(afterFirst);
  });
});

describe("applyReport", () => {
  it("stores the evidence list and clears a stale command error", () => {
    const s = useVerifyGateStore.getState();
    s.patch("a1", { error: "could not spawn" });
    const item: EvidenceItem = {
      id: "abc123",
      caption: "signed in",
      fileName: "abc123.png",
      path: "/w/.sparkle/verify-gate/a1/evidence/abc123.png",
      kind: "image",
      bytes: 10,
      at: 5,
      sourcePath: null,
    };
    s.applyReport("a1", report([check("test", "pass")], "pass"), [item]);
    const e = entryFor(useVerifyGateStore.getState(), "a1");
    expect(e.evidence).toHaveLength(1);
    expect(e.error).toBeNull();
  });
});

describe("forget", () => {
  it("removes the entry so a closed agent stops being rendered", () => {
    const s = useVerifyGateStore.getState();
    s.applyReport("a1", report([check("test", "pass")], "pass"), []);
    s.forget("a1");
    expect(useVerifyGateStore.getState().byAgent.a1).toBeUndefined();
  });
});

describe("the judged / unjudged split", () => {
  it("does not treat a timeout or an unrunnable check as a judged failure", () => {
    // The distinction pr-checks.sh draws between its exit 1 and its exit 5: a UI that called an
    // unspawnable `pnpm` "your tests failed" sends someone to read a diff nothing judged.
    expect(isJudgedFailure("fail")).toBe(true);
    expect(isJudgedFailure("timeout")).toBe(false);
    expect(isJudgedFailure("not-run")).toBe(false);
    expect(isJudged("timeout")).toBe(false);
    expect(isJudged("not-run")).toBe(false);
    expect(isJudged("pass")).toBe(true);
  });

  it("labels an unrun verdict as an absence, never as a failure of the code", () => {
    expect(verdictLabel("not-run")).toContain("did not run");
    expect(verdictLabel(null)).toContain("never run");
    expect(verdictLabel("pass")).toBe("Verified");
    // And nothing that never ran may be labelled as verified.
    expect(verdictLabel("not-run")).not.toContain("Verified —");
  });

  it("gives each status its own word", () => {
    const words = (["pass", "fail", "timeout", "not-run"] as const).map(statusLabel);
    expect(new Set(words).size).toBe(4);
    expect(statusLabel("timeout")).toBe("timed out");
  });
});

describe("humanMs matches the Rust renderer", () => {
  it("formats sub-minute durations to a tenth of a second", () => {
    expect(humanMs(1234)).toBe("1.2s");
    expect(humanMs(900)).toBe("0.9s");
  });

  it("switches to minutes at 60s", () => {
    expect(humanMs(125_000)).toBe("2m 5s");
    expect(humanMs(60_000)).toBe("1m 0s");
    expect(humanMs(59_999)).toBe("60.0s");
  });

  it("renders a nonsense duration as a dash rather than NaN", () => {
    expect(humanMs(Number.NaN)).toBe("—");
    expect(humanMs(-1)).toBe("—");
  });
});
