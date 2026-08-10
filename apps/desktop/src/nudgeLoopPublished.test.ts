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
import { publishedStatusFor } from "./useAttentionNotifications";
import { noteThrashEvent, resetThrashTracking, NUDGE_LOOP_LIMIT } from "./engine/agentThrash";
import { bandOfStatus } from "./engine/buildSections";
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
