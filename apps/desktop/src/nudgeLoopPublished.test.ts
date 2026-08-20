// THE WIRING TEST for bead sparkle-hpbkw's Case 2 — and it drives the DEFAULT seam on purpose.
//
// `engine/nudgeLoopCalm` is unit-tested in isolation, and that proves the RULE. It cannot prove the
// rule is reached: `composeRollup` takes `thrashOf` as an injected parameter defaulting to the live
// `thrashReportFor` registry, and a suite that always passes its own `thrashOf` would leave the one
// line that supplies the real value covered by nothing — delete it and every other test stays green
// while the founder's rows go back to reading "needs you". That is a defect shape this repo has
// recorded four times (bead sparkle-lgbwf), so this file deliberately does the opposite: it feeds
// the REAL registry through `noteThrashEvent` and calls `publishedStatusFor` with no thrash argument
// at all, exactly as production does.
import { afterEach, describe, expect, it } from "vitest";
import { publishedStatusFor, rollupViewFor } from "./useAttentionNotifications";
import { noteThrashEvent, resetThrashTracking, NUDGE_LOOP_LIMIT } from "./engine/agentThrash";
import { bandOfStatus } from "./engine/buildSections";
import { __setAuthRecoveryDeps, pollNudgeFlags } from "./services/authRecovery";
import type { AgentTab, AgentTabStatus } from "./types";

function mk(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  } as AgentTab;
}

/** A real nudge line, byte-identical in shape to what `nudge_ladder.rs::nudge_text` writes. */
const nudge = (n: number) =>
  `[sparkle-nudge #${n} · no output for ${n * 5}m] Automated ping, not a new task. Resume your goal.`;

/** Drive the ladder against an agent that never does anything — the measured incident. */
function pingIntoSilence(agentId: string, times: number) {
  for (let n = 1; n <= times; n++) {
    noteThrashEvent(agentId, { event: "UserPromptSubmit", prompt: nudge(n), ts: n * 1000 });
    noteThrashEvent(agentId, { event: "Stop", ts: n * 1000 });
  }
}

const NO_STAGE = () => undefined as never;
const published = (agents: AgentTab[], status: Record<string, AgentTabStatus>) =>
  publishedStatusFor(agents, status, new Set(agents.map((a) => a.id)), {}, NO_STAGE);

afterEach(() => resetThrashTracking());

describe("a nudge-looping agent does not reach the needs-you band (agent 6d644864)", () => {
  it("leaves the band through the REAL registry, with no thrash argument passed", () => {
    const agents = [mk("a")];
    pingIntoSilence("a", NUDGE_LOOP_LIMIT);
    const out = published(agents, { a: "waiting" });
    expect(bandOfStatus(out.a!)).not.toBe("needs_you");
    expect(out.a).toBe("lapsed");
  });

  it("an agent NOT being nudged keeps its red — the fix is not a blanket calm", () => {
    // The paired case. Without it, "the row is not red" would also pass for a change that calmed
    // every waiting agent in the fleet, which is the opposite bug and a far more expensive one.
    const agents = [mk("a")];
    const out = published(agents, { a: "waiting" });
    expect(bandOfStatus(out.a!)).toBe("needs_you");
    expect(out.a).toBe("waiting");
  });

  it("an agent that WORKS between our pings keeps its red", () => {
    const agents = [mk("a")];
    for (let n = 1; n <= NUDGE_LOOP_LIMIT + 2; n++) {
      noteThrashEvent("a", { event: "UserPromptSubmit", prompt: nudge(n), ts: n * 1000 });
      noteThrashEvent("a", { event: "PreToolUse", tool: "Edit", ts: n * 1000 });
      noteThrashEvent("a", { event: "Stop", ts: n * 1000 });
    }
    expect(published(agents, { a: "waiting" }).a).toBe("waiting");
  });

  it("stops short of the limit — one ping under, still asking", () => {
    const agents = [mk("a")];
    pingIntoSilence("a", NUDGE_LOOP_LIMIT - 1);
    expect(published(agents, { a: "waiting" }).a).toBe("waiting");
  });
});

// ── THE SAME WIRING QUESTION FOR THE HUMAN-BLOCK EXEMPTION (roborev 65408) ─────────────────────────
//
// `engine/nudgeLoopCalm` is unit-tested and the composed chain is tested in `stallEscalation.test.ts`
// — but both INJECT the predicate, so neither can prove `publishedStatusFor` reaches the real flag
// registry. That is the identical hole this file was written for one parameter over: delete the
// `humanBlockedOf` default and every other test stays green while a stated human block is demoted
// back to amber on the notification and digest paths.
//
// So this drives the REAL table via `pollNudgeFlags` and calls `publishedStatusFor` with NO
// human-block argument, exactly as production does.
describe("a stated human block survives the nudge-loop demotion through the REAL registry", () => {
  const founderFlag = (agentId: string, reply: string) => ({
    agentId,
    target: "founder",
    raisedAtMs: 1,
    nudges: 3,
    delivered: 3,
    blockedBy: null,
    silentSecs: 300,
    reply,
  });

  const raise = async (flags: ReturnType<typeof founderFlag>[]) => {
    __setAuthRecoveryDeps({ readNudgeFlags: async () => flags } as never);
    await pollNudgeFlags();
  };

  afterEach(async () => {
    await raise([]);
    __setAuthRecoveryDeps(null);
  });

  it("the flagged agent keeps its red while a nudge-looping neighbour is demoted", async () => {
    // BOTH IN ONE CALL, which is what makes this about the per-agent lookup rather than a blanket
    // exemption. Both are pinged into silence, so both would be demoted on the old behaviour; only
    // `said` answered that a person is blocking it.
    const agents = [mk("said"), mk("inferred")];
    pingIntoSilence("said", NUDGE_LOOP_LIMIT);
    pingIntoSilence("inferred", NUDGE_LOOP_LIMIT);
    await raise([founderFlag("said", "blocked-on-human")]);
    const out = published(agents, { said: "blocked", inferred: "blocked" });
    expect(out.said).toBe("blocked");
    expect(bandOfStatus(out.said!)).toBe("needs_you");
    expect(out.inferred).toBe("lapsed");
  });

  it("a reply naming a DIFFERENT blocker is demoted like any other loop", async () => {
    // `blocked-on-ci` routes to `Standdown::External`, not to the founder. Without this the
    // assertion above would also pass for a change that exempted every flagged agent.
    const agents = [mk("said")];
    pingIntoSilence("said", NUDGE_LOOP_LIMIT);
    await raise([founderFlag("said", "blocked-on-ci")]);
    expect(published(agents, { said: "blocked" }).said).toBe("lapsed");
  });

  it("with NO flag raised at all the row is demoted — the default is not an exemption", async () => {
    const agents = [mk("said")];
    pingIntoSilence("said", NUDGE_LOOP_LIMIT);
    await raise([]);
    expect(published(agents, { said: "blocked" }).said).toBe("lapsed");
  });

  it("`rollupViewFor`'s OWN default reaches the registry too — one covered site is not both", async () => {
    // ⚠️ A SECOND DEFAULT, AND THE REPO'S RULE IS TO CHECK EACH SITE (bead sparkle-50m03). The cases
    // above cover `publishedStatusFor`'s copy; `rollupViewFor` has its own, reached in production by
    // `services/conciergeTools/sidebarView.ts` passing five args.
    //
    // ⚠️ AND IT HAS TO BE A HEAD WITH A WORKER, which is what the first draft of this test got wrong.
    // `dotOf` reads the OWN map for the row itself — and `own` is deliberately the chain MINUS the
    // calming passes — so for a childless row this default is unobservable and an assertion there
    // passes whatever it does. The default feeds the PUBLISHED map, which `rollupDotAccessor` reads
    // for the WORKERS folded under a head. So the observable claim is: a head whose worker said a
    // person is blocking it keeps a red disc.
    const agents = [mk("head"), { ...mk("w"), kind: "worker" as const, parentId: "head" }];
    pingIntoSilence("w", NUDGE_LOOP_LIMIT);
    await raise([founderFlag("w", "blocked-on-human")]);
    const { dotOf } = rollupViewFor(
      agents,
      { head: "idle", w: "blocked" },
      new Set(["head", "w"]),
      {},
      NO_STAGE,
    );
    expect(dotOf("head")).toBe("red");
  });

  it("…and the head's disc calms when the worker's reply names another blocker", async () => {
    // The paired negative at the same site: identical shape, only the reply differs. Without it the
    // case above would also pass for a change that painted every head red.
    const agents = [mk("head"), { ...mk("w"), kind: "worker" as const, parentId: "head" }];
    pingIntoSilence("w", NUDGE_LOOP_LIMIT);
    await raise([founderFlag("w", "blocked-on-ci")]);
    const { dotOf } = rollupViewFor(
      agents,
      { head: "idle", w: "blocked" },
      new Set(["head", "w"]),
      {},
      NO_STAGE,
    );
    expect(dotOf("head")).not.toBe("red");
  });
});
