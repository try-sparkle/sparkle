// A freshly spawned, never-briefed agent must not reach the attention machinery.
//
// Three separate surfaces decide whether the human gets told about an agent, and they read DIFFERENT
// sets on purpose (see packages/ui/tokens.ts — "THE TWO SETS ARE DIFFERENT ON PURPOSE, AND THAT IS
// A TRAP"). All three have to agree that a briefless agent is not news:
//
//   • `publishedStatusFor` — the composed map the concierge feed bands (P0/P1/P2) and
//     `useHelperVitalsPublisher` counts as the island's "needs you" number.
//   • `needsAttention`      — the narrow dock-badge / relay set.
//   • `notificationFor` + the notify prefs — the banner.
//
// The regression guard is the second half of every describe: an agent that HAS been briefed, or that
// has actually drawn a question, must be completely unaffected. This change is only allowed to
// remove noise about agents nobody has given work to.
import { describe, it, expect } from "vitest";
import { publishedStatusFor } from "./useAttentionNotifications";
import { needsAttention } from "./engine/attention";
import { DEFAULT_NOTIFY_STATUSES } from "./stores/settingsStore";
import { bandOfStatus } from "./engine/buildSections";
import { NEW_AGENT_GRACE_MS } from "./engine/newAgentAttention";
import type { AgentTab, AgentTabStatus } from "./types";

/** A build agent row. `createdAt` present = spawned in this session; omit `lastPrompt`/`task` for a
 *  briefless one. Mirrors publishedRollupAgreement.test.ts's `mk`, plus the spawn stamp. */
function mk(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    createdAt: Date.now(),
    ...over,
  } as AgentTab;
}

/** The earliest stage — nothing committed, so `withUnmergedWork` never fires and the only overlay
 *  under test here is step (0). */
const NO_WORK_YET = () => "thought" as const;
const publish = (agents: AgentTab[], status: Record<string, AgentTabStatus>) =>
  // `{}` for lastObserved (sparkle-w340, from origin/main): no agent has ever been observed running,
  // which is the shape these rows already assumed before that parameter existed.
  publishedStatusFor(agents, status, new Set(agents.map((a) => a.id)), {}, NO_WORK_YET);

describe("publishedStatusFor — a briefless fresh agent", () => {
  it("publishes `new` instead of red `blocked` (the reported bug)", () => {
    const out = publish([mk("a")], { a: "blocked" });
    expect(out.a).toBe("new");
  });

  it("publishes `new` instead of `idle` — it never had a turn to finish", () => {
    expect(publish([mk("a")], { a: "idle" }).a).toBe("new");
  });

  it("bands with the calm tier, so the digest never counts it under 'Needs you'", () => {
    const out = publish([mk("a")], { a: "blocked" });
    expect(bandOfStatus(out.a!)).toBe("done");
    // The band the fix exists to keep it OUT of.
    expect(bandOfStatus(out.a!)).not.toBe("needs_you");
  });

  it("holds an unclassifiable red inside the backstop and releases it afterwards", () => {
    const fresh = mk("a", { createdAt: Date.now() - 60_000 });
    expect(publish([fresh], { a: "errored" }).a).toBe("new");

    const old = mk("a", { createdAt: Date.now() - (NEW_AGENT_GRACE_MS + 60_000) });
    expect(publish([old], { a: "errored" }).a).toBe("errored");
  });
});

describe("publishedStatusFor — what must NOT change", () => {
  it("still publishes red for a fresh agent that actually ASKED something", () => {
    expect(publish([mk("a")], { a: "waiting" }).a).toBe("waiting");
    expect(publish([mk("a")], { a: "approval" }).a).toBe("approval");
  });

  it("still publishes red `blocked` for a BRIEFED agent, however new it is", () => {
    const briefed = mk("a", { lastPrompt: "go build the thing" });
    expect(publish([briefed], { a: "blocked" }).a).toBe("blocked");
    expect(bandOfStatus(publish([briefed], { a: "blocked" }).a!)).toBe("needs_you");
  });

  it("still publishes red for a WORKER carrying an assigned task — the task is its brief", () => {
    const worker = mk("w", { kind: "worker", parentId: null, task: "fix the parser" });
    expect(publish([worker], { w: "blocked" }).w).toBe("blocked");
  });

  it("leaves a legacy row with no spawn stamp untouched", () => {
    const legacy = mk("a", { createdAt: undefined });
    expect(publish([legacy], { a: "blocked" }).a).toBe("blocked");
  });

  it("leaves a genuinely working fresh agent green", () => {
    expect(publish([mk("a")], { a: "working" }).a).toBe("working");
  });
});

describe("the badge / banner sets agree that `new` is not news", () => {
  it("is not in the narrow dock-badge + relay attention set", () => {
    expect(needsAttention("new")).toBe(false);
    // Sanity: the set still fires for the statuses it is meant to.
    expect(needsAttention("waiting")).toBe(true);
    expect(needsAttention("errored")).toBe(true);
  });

  it("does not raise a banner by default", () => {
    expect(DEFAULT_NOTIFY_STATUSES.new).toBe(false);
  });

  it("a briefless agent's blocked+idle statuses BOTH resolve to a non-notifying status", () => {
    // `idle` is the one that mattered: it pings by DEFAULT ("Finished — your turn"), which is a
    // false claim about an agent that was never given a turn. Both must land on `new`.
    for (const raw of ["blocked", "idle"] as AgentTabStatus[]) {
      const published = publish([mk("a")], { a: raw }).a!;
      expect(DEFAULT_NOTIFY_STATUSES[published], raw).toBe(false);
      expect(needsAttention(published), raw).toBe(false);
    }
  });
});
