// THE WIRING TEST for bead sparkle-hpbkw's Case 1 — step (6) of the published chain.
//
// `engine/finishedHeadCalm` is unit-tested in isolation, which proves the RULE. This proves the rule
// is REACHED: that `publishedStatusFor` threads `isFinishedOf` into `composeRollup` and applies it
// AFTER the worker bubbles, which is the only order in which it can see the inherited red it exists
// to remove. Delete the step and this file goes red while the unit suite stays green.
import { describe, expect, it } from "vitest";
import { publishedStatusFor } from "./useAttentionNotifications";
import { bandOfStatus } from "./engine/buildSections";
import type { AgentTab, AgentTabStatus } from "./types";

function mk(id: string, kind: AgentTab["kind"], parentId: string | null): AgentTab {
  return {
    id, name: id, kind, parentId, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  } as AgentTab;
}

const NO_STAGE = () => undefined as never;
const HEAD_AND_WORKER = [mk("head", "build", null), mk("w1", "worker", "head")];

/** Run the real published chain. `finished` names the ids positively read as finished. */
function published(status: Record<string, AgentTabStatus>, finished: string[] = []) {
  return publishedStatusFor(
    HEAD_AND_WORKER,
    status,
    new Set(["head", "w1"]),
    {},
    NO_STAGE,
    undefined,
    undefined,
    {},
    () => undefined, // no thrash — this file is about the finished-head rule only
    (id) => (finished.length === 0 ? undefined : finished.includes(id)),
  );
}

describe("a FINISHED head does not inherit its worker's red (agent 6dc70c58)", () => {
  it("demotes the head while the worker keeps its own ask", () => {
    // `withRedWorkerAttention` bubbles the worker's `waiting` onto the head; step (6) takes it back
    // off, because the head has been positively read as finished and is not asking anything itself.
    const out = published({ head: "idle", w1: "waiting" }, ["head"]);
    expect(bandOfStatus(out.head!)).not.toBe("needs_you");
    expect(out.head).toBe("lapsed");
    // NOT HIDDEN — the worker's row is still red, and workerExpansion's peek line still names it.
    expect(out.w1).toBe("waiting");
    expect(bandOfStatus(out.w1!)).toBe("needs_you");
  });

  it("KEEPS the head red when nothing was read — the paired negative", () => {
    // Without this, "the head is calm" would also pass for a chain that had stopped bubbling at all.
    // Passing no finished ids makes `isFinishedOf` answer `undefined` for everyone, which is the
    // honest reading for a row nobody polled and must demote nothing.
    const out = published({ head: "idle", w1: "waiting" });
    expect(bandOfStatus(out.head!)).toBe("needs_you");
  });

  it("KEEPS the head red when it is finished but asking on its OWN behalf", () => {
    const out = published({ head: "waiting", w1: "idle" }, ["head"]);
    expect(out.head).toBe("waiting");
    expect(bandOfStatus(out.head!)).toBe("needs_you");
  });

  it("does not calm a head that is finished but has no red to inherit", () => {
    const out = published({ head: "idle", w1: "working" }, ["head"]);
    expect(out.head).not.toBe("lapsed");
  });
});
