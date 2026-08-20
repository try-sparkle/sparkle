import { describe, expect, it } from "vitest";
import { withNudgeLoopCalm, isNudgeLoopCalmed } from "./nudgeLoopCalm";
import { bandOfStatus } from "./buildSections";
import { AGENT_STATUS } from "@sparkle/ui";
import type { StatusMap } from "./attention";
import type { AgentTabStatus } from "../types";
import type { ThrashReport } from "./agentThrash";

// CASE 2 of bead sparkle-hpbkw — agent 6d644864 ("Typing Never Wedges"). It read status `waiting`,
// needsYou TRUE, goal `met`, having swallowed FOUR of Sparkle's own automated pings. The founder was
// told it needed him. It did not; our own nudger was arguing with itself.
const agents = (...ids: string[]) => ids.map((id) => ({ id }));

const report = (verdict: ThrashReport["verdict"], n = 3): ThrashReport => ({
  verdict,
  thrashing: verdict !== "healthy",
  turnsWithoutTool: n,
  nudgesWithoutProgress: verdict === "nudge-loop" ? n : 0,
  recentCompactions: 0,
  detail: "",
});

// All three take an id and ignore it, so the sweep below can call them uniformly. Typed as the
// accessor the transform actually receives, so a signature drift fails here rather than at a call
// site — `none` previously took zero arguments, which vitest cannot see but `tsc` does.
// The id is OPTIONAL so these double as zero-arg fixtures in the direct-assertion cases below,
// while still being assignable to the `(id: string) => …` accessor the transform takes.
type ThrashOf = (id?: string) => ThrashReport | undefined;
const loop: ThrashOf = () => report("nudge-loop");
const healthy: ThrashOf = () => report("healthy", 0);
const none: ThrashOf = () => undefined;
/** No agent has answered that a person is blocking it — the ordinary case for every test in this
 *  file, which is about what a nudge LOOP does. The exemption itself is covered by its own block
 *  below and by the composed-chain test in `stallEscalation.test.ts`. Written out rather than
 *  defaulted: the parameter is REQUIRED precisely so a caller cannot forget it (roborev 65373). */
const noBlock = () => false;

describe("a nudge loop stops the row asking", () => {
  it("demotes the measured case — `waiting`, four pings, nothing moved", () => {
    const published: StatusMap = { a: "waiting" };
    const out = withNudgeLoopCalm(agents("a"), published, loop, noBlock);
    expect(out.a).toBe("lapsed");
    // THE ASSERTION THAT MATTERS: it is out of the band the needs-you chip counts and the concierge
    // digest reports. Asserted on the BAND, not on the status string, because the band is what
    // decides whether he is told about it.
    expect(bandOfStatus(out.a!)).not.toBe("needs_you");
  });

  it("demotes a `blocked` row the same way — the other INFERRED red", () => {
    expect(withNudgeLoopCalm(agents("a"), { a: "blocked" }, loop, noBlock).a).toBe("lapsed");
  });

  it("REFUSES to silence a structural ask, however long the loop has run", () => {
    // The safety limit, and the reason the demotable set is two statuses rather than five.
    // `approval` and `questions` are matched off a real rendered menu; `errored` means it crashed.
    // Silencing any of those would let a nudge loop hide something a person is genuinely sitting on
    // — the failure Sparkle's standing rule exists to prevent.
    for (const s of ["approval", "questions", "errored"] as const) {
      expect(withNudgeLoopCalm(agents("a"), { a: s }, loop, noBlock).a, `${s} must survive`).toBe(s);
    }
  });

  it("does nothing without positive evidence — no report, and a healthy one", () => {
    // `undefined` is NOT healthy: it means this window has seen no hook events for the agent. Both
    // leave the row exactly as it was, because neither is evidence that our pings went nowhere.
    expect(withNudgeLoopCalm(agents("a"), { a: "waiting" }, none, noBlock).a).toBe("waiting");
    expect(withNudgeLoopCalm(agents("a"), { a: "waiting" }, healthy, noBlock).a).toBe("waiting");
  });

  it("does not touch a row that was never red to begin with", () => {
    for (const s of ["working", "idle", "unmerged", "lapsed", "done"] as const) {
      expect(withNudgeLoopCalm(agents("a"), { a: s }, loop, noBlock).a).toBe(s);
    }
  });

  it("returns the SAME reference when nothing changes — no render churn", () => {
    const published: StatusMap = { a: "working", b: "approval" };
    expect(withNudgeLoopCalm(agents("a", "b"), published, loop, noBlock)).toBe(published);
  });

  it("never invents a status for an agent it was given nothing about", () => {
    expect(withNudgeLoopCalm(agents("ghost"), {}, loop, noBlock).ghost).toBeUndefined();
  });

  it("demotes only the looping agent, leaving its neighbours alone", () => {
    const published: StatusMap = { loops: "waiting", asks: "waiting" };
    const out = withNudgeLoopCalm(
      agents("loops", "asks"),
      published,
      (id) => (id === "loops" ? loop() : undefined),
      noBlock,
    );
    expect(out.loops).toBe("lapsed");
    expect(out.asks).toBe("waiting");
  });
});

describe("the predicate and the transform are ONE rule", () => {
  const ALL = Object.keys(AGENT_STATUS) as AgentTabStatus[];

  it("agree across every status, under a loop and without one", () => {
    for (const s of ALL) {
      for (const t of [loop, healthy, none]) {
        const out = withNudgeLoopCalm(agents("a"), { a: s }, t, noBlock);
        const calmed = isNudgeLoopCalmed(s, t("a"));
        expect(out.a, `${s} / ${t.name}`).toBe(calmed ? "lapsed" : s);
      }
    }
  });

  it("the predicate is not vacuous in either direction", () => {
    // Without this the sweep above would pass for a predicate that is constantly true OR constantly
    // false, since it is compared against itself.
    expect(isNudgeLoopCalmed("waiting", loop())).toBe(true);
    expect(isNudgeLoopCalmed("waiting", healthy())).toBe(false);
    expect(isNudgeLoopCalmed("approval", loop())).toBe(false);
  });
});
