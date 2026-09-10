import { describe, expect, it } from "vitest";
import {
  attributeSpendToAgents,
  evaluateSpendCap,
  NEAR_FRACTION,
  normalizeCapUsd,
  rosterFromProjects,
  worktreeFolder,
  type AgentIdentity,
  type AgentSpendRow,
} from "./agentSpend";
import type { Bucket, ProjectTotal, SpendReport } from "../services/spendApi";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
//
// EVERY numeric field is a PARAMETER. A fixture that pins one of them to a literal makes the suite
// structurally unable to express a defect in it (`scripts/lib/vacuous-fixture-guard.sh`), and the
// two that matter most here are exactly the ones an all-literal helper would freeze:
// `estimatedCostUsd` (what the cap compares) and `unpricedTokens` (what makes a cost UNKNOWN).

function bucket(opts: {
  total: number;
  messages: number;
  estimatedCostUsd: number;
  unpricedTokens: number;
}): Bucket {
  return {
    tokens: {
      input: opts.total,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
      total: opts.total,
    },
    estimatedCostUsd: opts.estimatedCostUsd,
    unpricedTokens: opts.unpricedTokens,
    messages: opts.messages,
  };
}

function project(opts: {
  project: string;
  total: number;
  messages: number;
  estimatedCostUsd: number;
  unpricedTokens: number;
  sessions: number;
  lastActive: string;
}): ProjectTotal {
  return {
    ...bucket(opts),
    project: opts.project,
    sessions: opts.sessions,
    lastActive: opts.lastActive,
  };
}

function report(opts: { projects: ProjectTotal[]; totals: Bucket; windowDays: number }): SpendReport {
  return {
    windowDays: opts.windowDays,
    generatedAt: 0,
    days: [],
    models: [],
    projects: opts.projects,
    sessions: [],
    totals: opts.totals,
    unknownModels: [],
    filesScanned: opts.projects.length,
    truncated: false,
    roots: [],
    pricingNote: "estimates only",
    timezone: "UTC",
  };
}

function agent(opts: Partial<AgentIdentity> & { agentId: string }): AgentIdentity {
  return {
    name: opts.name ?? opts.agentId,
    projectName: opts.projectName ?? "sparkle",
    worktreePath: opts.worktreePath ?? `/wt/${opts.agentId}`,
    agentId: opts.agentId,
  };
}

function row(opts: Partial<AgentSpendRow> & { agentId: string }): AgentSpendRow {
  return {
    agentId: opts.agentId,
    name: opts.name ?? opts.agentId,
    projectName: opts.projectName ?? "sparkle",
    folder: opts.folder ?? opts.agentId,
    sessions: opts.sessions ?? 1,
    messages: opts.messages ?? 10,
    totalTokens: opts.totalTokens ?? 1_000,
    estimatedCostUsd: opts.estimatedCostUsd ?? 0,
    unpricedTokens: opts.unpricedTokens ?? 0,
    lastActive: opts.lastActive ?? "2026-09-01",
  };
}

// ── worktreeFolder ──────────────────────────────────────────────────────────────────────────

describe("worktreeFolder", () => {
  it("takes the trailing segment of a posix path", () => {
    expect(worktreeFolder("/Users/x/Application Support/worktrees/parent/abc-123")).toBe("abc-123");
  });

  it("ignores a trailing separator rather than yielding an empty folder", () => {
    // A path stored with a trailing slash would otherwise resolve to "", which matches no rollup
    // row AND, worse, would collide with every other trailing-slash agent in the ambiguity map.
    expect(worktreeFolder("/wt/abc-123/")).toBe("abc-123");
  });

  it("reads a missing worktree as no folder at all", () => {
    expect(worktreeFolder(null)).toBe("");
    expect(worktreeFolder(undefined)).toBe("");
    expect(worktreeFolder("")).toBe("");
  });
});

// ── attribution ─────────────────────────────────────────────────────────────────────────────

describe("attributeSpendToAgents", () => {
  it("names the agent that owns a project rollup row", () => {
    const r = report({
      windowDays: 28,
      projects: [
        project({
          project: "abc-123",
          total: 900,
          messages: 9,
          estimatedCostUsd: 3.5,
          unpricedTokens: 0,
          sessions: 2,
          lastActive: "2026-09-02",
        }),
      ],
      totals: bucket({ total: 900, messages: 9, estimatedCostUsd: 3.5, unpricedTokens: 0 }),
    });

    const { rows, unattributed } = attributeSpendToAgents(r, [
      agent({ agentId: "a1", name: "Cost Visibility", worktreePath: "/wt/abc-123" }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Cost Visibility");
    expect(rows[0]!.estimatedCostUsd).toBe(3.5);
    expect(rows[0]!.totalTokens).toBe(900);
    expect(rows[0]!.sessions).toBe(2);
    expect(rows[0]!.lastActive).toBe("2026-09-02");
    // Everything was attributed, so there is nothing left over.
    expect(unattributed.totalTokens).toBe(0);
    expect(unattributed.estimatedCostUsd).toBe(0);
  });

  it("reports the spend no agent could be matched to instead of dropping it", () => {
    // THE SIDE EFFECT UNDER TEST: rows + remainder === the report's own headline. A per-agent table
    // that silently discards the difference is how a spend view understates what was spent.
    const r = report({
      windowDays: 28,
      projects: [
        project({
          project: "abc-123",
          total: 400,
          messages: 4,
          estimatedCostUsd: 1,
          unpricedTokens: 0,
          sessions: 1,
          lastActive: "2026-09-02",
        }),
        project({
          project: "my-terminal-project",
          total: 600,
          messages: 6,
          estimatedCostUsd: 2,
          unpricedTokens: 0,
          sessions: 3,
          lastActive: "2026-09-03",
        }),
      ],
      totals: bucket({ total: 1000, messages: 10, estimatedCostUsd: 3, unpricedTokens: 0 }),
    });

    const { rows, unattributed } = attributeSpendToAgents(r, [
      agent({ agentId: "a1", worktreePath: "/wt/abc-123" }),
    ]);

    expect(rows.map((x) => x.agentId)).toEqual(["a1"]);
    expect(unattributed.totalTokens).toBe(600);
    expect(unattributed.estimatedCostUsd).toBe(2);
    expect(unattributed.messages).toBe(6);
  });

  it("refuses to attribute a folder two agents both claim, and names it", () => {
    const r = report({
      windowDays: 28,
      projects: [
        project({
          project: "shared",
          total: 500,
          messages: 5,
          estimatedCostUsd: 4,
          unpricedTokens: 0,
          sessions: 1,
          lastActive: "2026-09-02",
        }),
      ],
      totals: bucket({ total: 500, messages: 5, estimatedCostUsd: 4, unpricedTokens: 0 }),
    });

    const { rows, unattributed, ambiguousFolders } = attributeSpendToAgents(r, [
      agent({ agentId: "a1", worktreePath: "/one/shared" }),
      agent({ agentId: "a2", worktreePath: "/two/shared" }),
    ]);

    expect(rows).toEqual([]);
    expect(ambiguousFolders).toEqual(["shared"]);
    // The money did not disappear — it moved to the remainder.
    expect(unattributed.estimatedCostUsd).toBe(4);
    expect(unattributed.totalTokens).toBe(500);
  });

  it("omits an agent with no worktree and one whose folder never spent anything", () => {
    const r = report({
      windowDays: 28,
      projects: [
        project({
          project: "abc-123",
          total: 100,
          messages: 1,
          estimatedCostUsd: 0.5,
          unpricedTokens: 0,
          sessions: 1,
          lastActive: "2026-09-02",
        }),
      ],
      totals: bucket({ total: 100, messages: 1, estimatedCostUsd: 0.5, unpricedTokens: 0 }),
    });

    const { rows } = attributeSpendToAgents(r, [
      agent({ agentId: "a1", worktreePath: "/wt/abc-123" }),
      agent({ agentId: "no-worktree", worktreePath: null }),
      agent({ agentId: "idle", worktreePath: "/wt/never-ran" }),
    ]);

    expect(rows.map((x) => x.agentId)).toEqual(["a1"]);
  });

  it("orders the heaviest agent first", () => {
    const mk = (name: string, total: number) =>
      project({
        project: name,
        total,
        messages: 1,
        estimatedCostUsd: 0,
        unpricedTokens: 0,
        sessions: 1,
        lastActive: "2026-09-02",
      });
    const r = report({
      windowDays: 28,
      projects: [mk("light", 10), mk("heavy", 900), mk("middle", 300)],
      totals: bucket({ total: 1210, messages: 3, estimatedCostUsd: 0, unpricedTokens: 0 }),
    });

    const { rows } = attributeSpendToAgents(r, [
      agent({ agentId: "l", worktreePath: "/wt/light" }),
      agent({ agentId: "h", worktreePath: "/wt/heavy" }),
      agent({ agentId: "m", worktreePath: "/wt/middle" }),
    ]);

    expect(rows.map((x) => x.agentId)).toEqual(["h", "m", "l"]);
  });
});

describe("rosterFromProjects", () => {
  it("flattens every project's agents and keeps the project name for each", () => {
    const roster = rosterFromProjects([
      { name: "sparkle", agents: [{ id: "a1", name: "One", worktreePath: "/wt/a1" }] },
      { name: "other", agents: [{ id: "b1", name: "Two", worktreePath: null }] },
    ]);
    expect(roster).toEqual([
      { agentId: "a1", name: "One", projectName: "sparkle", worktreePath: "/wt/a1" },
      { agentId: "b1", name: "Two", projectName: "other", worktreePath: null },
    ]);
  });
});

// ── the cap ─────────────────────────────────────────────────────────────────────────────────

describe("normalizeCapUsd", () => {
  it("reads every non-positive or malformed value as NO CAP", () => {
    // Failing towards "off" is the safe direction: a cap of $0 would report every agent as over.
    expect(normalizeCapUsd(null)).toBeNull();
    expect(normalizeCapUsd(undefined)).toBeNull();
    expect(normalizeCapUsd(0)).toBeNull();
    expect(normalizeCapUsd(-5)).toBeNull();
    expect(normalizeCapUsd(Number.NaN)).toBeNull();
    expect(normalizeCapUsd(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeCapUsd("5" as unknown as number)).toBeNull();
  });

  it("keeps a real positive cap", () => {
    expect(normalizeCapUsd(12.5)).toBe(12.5);
  });
});

describe("evaluateSpendCap", () => {
  it("is inert with no cap set, however much has been spent", () => {
    const v = evaluateSpendCap([row({ agentId: "a", estimatedCostUsd: 9_999 })], null);
    expect(v.state).toBe("off");
    expect(v.over).toEqual([]);
    expect(v.near).toEqual([]);
    expect(v.capUsd).toBeNull();
  });

  it("reports an agent AT the cap as over, not merely near it", () => {
    // The boundary is inclusive on purpose: "you have reached your cap" is the moment to say so.
    const v = evaluateSpendCap([row({ agentId: "a", estimatedCostUsd: 10 })], 10);
    expect(v.state).toBe("over");
    expect(v.over.map((r) => r.agentId)).toEqual(["a"]);
  });

  it("reports an agent past the near fraction but under the cap as near", () => {
    const v = evaluateSpendCap([row({ agentId: "a", estimatedCostUsd: 10 * NEAR_FRACTION })], 10);
    expect(v.state).toBe("near");
    expect(v.near.map((r) => r.agentId)).toEqual(["a"]);
    expect(v.over).toEqual([]);
  });

  it("leaves a light agent alone", () => {
    const v = evaluateSpendCap([row({ agentId: "a", estimatedCostUsd: 1 })], 10);
    expect(v.state).toBe("under");
    expect(v.near).toEqual([]);
    expect(v.over).toEqual([]);
  });

  it("will not call an agent with an UNKNOWN cost either over or within the cap", () => {
    // THE SIDE EFFECT: an all-unpriced agent lands in `unjudged` and in NEITHER verdict list. It
    // burned 2M tokens; treating a cost we cannot compute as $0 would report it as comfortably
    // under budget, which is the single most misleading thing this pane could say.
    const unknown = row({
      agentId: "mystery",
      estimatedCostUsd: 0,
      unpricedTokens: 2_000_000,
      totalTokens: 2_000_000,
    });
    const v = evaluateSpendCap([unknown], 1);
    expect(v.unjudged.map((r) => r.agentId)).toEqual(["mystery"]);
    expect(v.over).toEqual([]);
    expect(v.near).toEqual([]);
    expect(v.state).toBe("under");
  });

  it("still judges a PARTLY unpriced agent by the cost it does know", () => {
    // Some unpriced tokens is not the same fact as no priced ones: the known cost already breaches.
    const v = evaluateSpendCap(
      [row({ agentId: "a", estimatedCostUsd: 12, unpricedTokens: 500 })],
      10,
    );
    expect(v.over.map((r) => r.agentId)).toEqual(["a"]);
    expect(v.unjudged).toEqual([]);
  });

  it("puts the worst offender first when several are over", () => {
    const v = evaluateSpendCap(
      [
        row({ agentId: "small", estimatedCostUsd: 11 }),
        row({ agentId: "huge", estimatedCostUsd: 40 }),
        row({ agentId: "mid", estimatedCostUsd: 20 }),
      ],
      10,
    );
    expect(v.over.map((r) => r.agentId)).toEqual(["huge", "mid", "small"]);
  });

  it("prefers OVER to NEAR when both exist, because that is the one to act on", () => {
    const v = evaluateSpendCap(
      [row({ agentId: "near", estimatedCostUsd: 9 }), row({ agentId: "over", estimatedCostUsd: 30 })],
      10,
    );
    expect(v.state).toBe("over");
    expect(v.over.map((r) => r.agentId)).toEqual(["over"]);
    expect(v.near.map((r) => r.agentId)).toEqual(["near"]);
  });

  it("treats a malformed persisted cap as off rather than as a cap of zero", () => {
    const v = evaluateSpendCap([row({ agentId: "a", estimatedCostUsd: 0.01 })], Number.NaN);
    expect(v.state).toBe("off");
    expect(v.over).toEqual([]);
  });
});
