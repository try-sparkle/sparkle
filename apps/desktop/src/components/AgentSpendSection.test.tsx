// @vitest-environment jsdom
//
// The per-agent spend section and its cap. Rendered from PROPS alone — no store, no Tauri — because
// the two things worth pinning here are display honesty and the cap's default, and neither needs
// either seam. What is asserted is the SIDE EFFECT a reader would act on: the agent's name beside a
// figure, the remainder that makes the figures add up, and a cap that is silent until it is set.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentSpendSection } from "./AgentSpendSection";
import type { AgentIdentity } from "../engine/agentSpend";
import type { Bucket, ProjectTotal, SpendReport } from "../services/spendApi";

afterEach(cleanup);

function bucket(opts: {
  total: number;
  messages: number;
  estimatedCostUsd: number;
  unpricedTokens: number;
}): Bucket {
  return {
    tokens: { input: opts.total, output: 0, cacheCreation: 0, cacheRead: 0, total: opts.total },
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

function report(projects: ProjectTotal[], totals: Bucket): SpendReport {
  return {
    windowDays: 28,
    generatedAt: 1_784_000_000,
    days: [],
    models: [],
    projects,
    sessions: [],
    totals,
    unknownModels: [],
    filesScanned: projects.length,
    truncated: false,
    roots: [],
    pricingNote: "Estimated at published list API rates.",
    timezone: "UTC",
  };
}

function agent(agentId: string, name: string, worktreePath: string | null): AgentIdentity {
  return { agentId, name, projectName: "sparkle", worktreePath };
}

/** One agent ("Cost Visibility") on `abc-123`, plus some spend nobody owns. */
function scene(opts: { agentCost: number; agentUnpriced?: number }) {
  const agentTokens = 1_200_000;
  const strayTokens = 300_000;
  const strayCost = 2;
  const projects = [
    project({
      project: "abc-123",
      total: agentTokens,
      messages: 40,
      estimatedCostUsd: opts.agentCost,
      unpricedTokens: opts.agentUnpriced ?? 0,
      sessions: 2,
      lastActive: "2026-09-02",
    }),
    project({
      project: "some-other-folder",
      total: strayTokens,
      messages: 6,
      estimatedCostUsd: strayCost,
      unpricedTokens: 0,
      sessions: 1,
      lastActive: "2026-09-01",
    }),
  ];
  const totals = bucket({
    total: agentTokens + strayTokens,
    messages: 46,
    estimatedCostUsd: opts.agentCost + strayCost,
    unpricedTokens: opts.agentUnpriced ?? 0,
  });
  return {
    report: report(projects, totals),
    roster: [agent("a1", "Cost Visibility", "/wt/abc-123")],
  };
}

describe("AgentSpendSection", () => {
  it("puts the agent's NAME beside its estimated cost", () => {
    // The defect this closes: the pane could only show `abcdef12`, a session uuid nobody can act on.
    const { report: r, roster } = scene({ agentCost: 14.5 });
    render(
      <AgentSpendSection report={r} roster={roster} capUsd={null} onCapChange={vi.fn()} />,
    );
    expect(screen.getByText("Cost Visibility")).toBeTruthy();
    expect(screen.getByTestId("agent-spend-cost-a1").textContent).toBe("$14.50");
  });

  it("shows the spend no agent owns, so the rows and the remainder add up", () => {
    const { report: r, roster } = scene({ agentCost: 14.5 });
    render(
      <AgentSpendSection report={r} roster={roster} capUsd={null} onCapChange={vi.fn()} />,
    );
    const remainder = screen.getByTestId("agent-spend-unattributed");
    expect(remainder.textContent).toContain("Unattributed");
    // 16.50 total − 14.50 attributed = 2.00 left over.
    expect(remainder.textContent).toContain("$2.00");
  });

  it("is completely silent about the cap when no cap is set", () => {
    // INERT BY DEFAULT is the shipped state: $14.50 with no cap must produce no warning at all.
    const { report: r, roster } = scene({ agentCost: 14.5 });
    render(
      <AgentSpendSection report={r} roster={roster} capUsd={null} onCapChange={vi.fn()} />,
    );
    expect(screen.queryByTestId("agent-spend-cap-banner")).toBeNull();
    expect(screen.getByLabelText(/cap in US dollars/i).getAttribute("value")).toBe("");
  });

  it("names the agent that has passed the cap once one is set", () => {
    const { report: r, roster } = scene({ agentCost: 14.5 });
    render(<AgentSpendSection report={r} roster={roster} capUsd={10} onCapChange={vi.fn()} />);
    const banner = screen.getByTestId("agent-spend-cap-banner");
    expect(banner.textContent).toContain("Cost Visibility");
    expect(banner.textContent).toContain("$10.00");
    // The copy must not overclaim: nothing is actually enforced.
    expect(banner.textContent).toContain("warning");
  });

  it("warns before the cap, not only at it", () => {
    const { report: r, roster } = scene({ agentCost: 8.5 });
    render(<AgentSpendSection report={r} roster={roster} capUsd={10} onCapChange={vi.fn()} />);
    expect(screen.getByTestId("agent-spend-cap-banner").textContent).toContain("Cost Visibility");
  });

  it("says an all-unpriced agent is NOT COSTED, and never reports it as within the cap", () => {
    // The silent-zero this pane exists to prevent: 1.2M tokens on a model with no published rate is
    // an UNKNOWN cost. Rendering "$0.00" — or a green "under cap" — would be the lie.
    const { report: r, roster } = scene({ agentCost: 0, agentUnpriced: 1_200_000 });
    render(<AgentSpendSection report={r} roster={roster} capUsd={1} onCapChange={vi.fn()} />);
    expect(screen.getByTestId("agent-spend-cost-a1").textContent).toBe("not costed");
    expect(screen.queryByTestId("agent-spend-cap-banner")).toBeNull();
    expect(screen.getByTestId("agent-spend-cap-unjudged").textContent).toContain("Cost Visibility");
  });

  it("commits a typed cap on blur, as a number", () => {
    const onCapChange = vi.fn();
    const { report: r, roster } = scene({ agentCost: 14.5 });
    render(<AgentSpendSection report={r} roster={roster} capUsd={null} onCapChange={onCapChange} />);
    const input = screen.getByLabelText(/cap in US dollars/i);
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.blur(input);
    expect(onCapChange).toHaveBeenCalledWith(25);
  });

  it("does NOT commit while the user is still typing the number", () => {
    // Committing per keystroke means typing "10" passes through "1", and a $1 cap flashes a banner
    // saying every agent is over budget — a false alarm produced by the input itself.
    const onCapChange = vi.fn();
    const { report: r, roster } = scene({ agentCost: 14.5 });
    render(<AgentSpendSection report={r} roster={roster} capUsd={null} onCapChange={onCapChange} />);
    const input = screen.getByLabelText(/cap in US dollars/i);
    fireEvent.change(input, { target: { value: "1" } });
    expect(onCapChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.blur(input);
    expect(onCapChange).toHaveBeenCalledTimes(1);
    expect(onCapChange).toHaveBeenCalledWith(10);
  });

  it("clears the cap when the field is emptied", () => {
    const onCapChange = vi.fn();
    const { report: r, roster } = scene({ agentCost: 14.5 });
    render(<AgentSpendSection report={r} roster={roster} capUsd={10} onCapChange={onCapChange} />);
    const input = screen.getByLabelText(/cap in US dollars/i);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCapChange).toHaveBeenCalledWith(null);
  });

  it("says so, rather than showing an empty table, when nothing could be attributed", () => {
    const { report: r } = scene({ agentCost: 14.5 });
    render(<AgentSpendSection report={r} roster={[]} capUsd={null} onCapChange={vi.fn()} />);
    expect(screen.getByTestId("agent-spend-empty").textContent).toContain("worktree");
    expect(screen.queryByTestId("agent-spend-row-a1")).toBeNull();
  });

  it("names a folder two agents both claim instead of picking one", () => {
    const { report: r } = scene({ agentCost: 14.5 });
    render(
      <AgentSpendSection
        report={r}
        roster={[agent("a1", "One", "/one/abc-123"), agent("a2", "Two", "/two/abc-123")]}
        capUsd={null}
        onCapChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("agent-spend-ambiguous").textContent).toContain("abc-123");
    expect(screen.queryByTestId("agent-spend-row-a1")).toBeNull();
    expect(screen.queryByTestId("agent-spend-row-a2")).toBeNull();
  });
});
