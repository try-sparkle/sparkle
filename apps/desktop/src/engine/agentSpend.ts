// Per-AGENT spend attribution and the per-agent cap verdict (bead ).
//
// WHAT WAS ALREADY THERE, AND WHAT WAS NOT. `spend.rs` + `SpendPane` already read Claude Code's own
// transcripts and roll them up by day, model, project and session, with honest cost estimates. Two
// things a BYOK user needs were missing, and both are in this file:
//
//   1. WHOSE spend is that. The pane's heaviest-sessions table shows `a7f3c1d2` — a session uuid —
//      and a project column that, for a Sparkle-managed worktree, is ANOTHER uuid. A user afraid of
//      runaway cost cannot act on either. The agent roster knows the name; nothing joined them.
//   2. A CAP. There was none of any kind — no threshold, no comparison, no state at the limit.
//
// THE JOIN, and why it is the PROJECT rollup rather than the session one. Every Sparkle-managed
// agent runs in its own worktree, and `spend.rs` labels a rollup row with the BASENAME of the
// record's `cwd`. So `basename(agent.worktreePath) === projectTotal.project` attributes an agent's
// whole history in that worktree, across every session it ever resumed.
//
// It is deliberately NOT the session rollup, and that is the one choice here worth arguing with.
// `services/agentTranscriptRegistry.agentSessionIds()` already holds a persisted agent → session-id
// map, so `report.sessions` filtered by it reads as the obvious, more precise join. It is the wrong
// one: `SpendReport.sessions` is CAPPED at the heaviest `MAX_SESSION_ROWS` (50) rows in Rust, so an
// agent outside that top 50 sums to ZERO — not to "unknown" — and a light agent and an unreported
// one render identically. Summing a truncated list silently UNDERSTATES spend with nothing on
// screen saying so, and a number a user reads as money must not be quietly short. `report.projects`
// is uncapped, so it cannot fail that way.
//
// AND THE DOLLARS ARE AN ESTIMATE, NOT A BILL. Sparkle scrubs `ANTHROPIC_API_KEY` from the
// environment it spawns `claude` in (`services/claudeSpawn.ts`), so a LOCAL agent runs on the
// user's own Claude subscription and is not billed per token at all. What these figures answer is
// "what would these tokens cost at published list rates" — which is precisely the question a BYOK
// user is asking, and precisely not a statement about anyone's invoice. `SpendReport.pricingNote`
// says so in the pane's own words, owned by Rust so it cannot drift from the arithmetic; the cap
// copy must stay consistent with it.
//
// WHAT THIS REFUSES TO GUESS. Two agents whose worktrees share a basename cannot be told apart from
// a folder name, so BOTH are left unattributed and the folder is REPORTED as ambiguous. And an
// agent that ran with its cwd somewhere other than its worktree root lands in a folder we do not
// recognise. Neither is hidden: `unattributed` is the report total minus everything attributed, so
// the rows plus the remainder always reconcile to the pane's headline figure. Attribution that
// cannot be checked against a total is how a spend view starts lying.
import type { Bucket, ProjectTotal, SpendReport } from "../services/spendApi";

/** What the agent roster contributes to the join: a name to show and a folder to match on. */
export interface AgentIdentity {
  agentId: string;
  /** The agent's display name, as the sidebar shows it. */
  name: string;
  /** The project the agent belongs to, for a second line of context in the table. */
  projectName: string;
  /** The Sparkle-managed worktree. `null` for an agent that never had one cut. */
  worktreePath: string | null;
}

/** One agent's observed spend over the report's window. */
export interface AgentSpendRow {
  agentId: string;
  name: string;
  projectName: string;
  /** The worktree folder name this row was matched on — shown so the join is auditable. */
  folder: string;
  sessions: number;
  messages: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /** Tokens from models with no published rate. Cost for these is UNKNOWN, never zero. */
  unpricedTokens: number;
  lastActive: string;
}

/** The remainder: everything in the window that no single agent could be held responsible for. */
export interface UnattributedSpend {
  messages: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedTokens: number;
}

export interface AgentSpendBreakdown {
  /** Heaviest first (by total tokens, so an all-unpriced agent still sorts honestly). */
  rows: AgentSpendRow[];
  /** `report.totals` minus every attributed row. Rows + this === the pane's headline. */
  unattributed: UnattributedSpend;
  /**
   * Worktree folder names claimed by more than one agent. Their spend is in `unattributed` on
   * purpose: splitting it would be a guess, and assigning it to one of them would be a lie.
   */
  ambiguousFolders: string[];
}

/** The trailing path segment, with any trailing separators ignored. `""` when there isn't one. */
export function worktreeFolder(worktreePath: string | null | undefined): string {
  if (!worktreePath) return "";
  const trimmed = worktreePath.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** Flatten the project store's nested shape into the roster the join needs. */
export function rosterFromProjects(
  projects: { name: string; agents: { id: string; name: string; worktreePath: string | null }[] }[],
): AgentIdentity[] {
  const out: AgentIdentity[] = [];
  for (const p of projects) {
    for (const a of p.agents) {
      out.push({
        agentId: a.id,
        name: a.name,
        projectName: p.name,
        worktreePath: a.worktreePath,
      });
    }
  }
  return out;
}

function bucketOf(b: Bucket): UnattributedSpend {
  return {
    messages: b.messages,
    totalTokens: b.tokens.total,
    estimatedCostUsd: b.estimatedCostUsd,
    unpricedTokens: b.unpricedTokens,
  };
}

/**
 * Attribute the report's per-project rollup to named agents.
 *
 * An agent with no worktree, or whose folder has no rollup row, produces no row at all — the table
 * lists agents that actually SPENT something in the window, not every agent that ever existed.
 */
export function attributeSpendToAgents(
  report: SpendReport,
  roster: AgentIdentity[],
): AgentSpendBreakdown {
  // Which agents claim each folder. More than one is ambiguous and attributes to neither.
  const byFolder = new Map<string, AgentIdentity[]>();
  for (const a of roster) {
    const folder = worktreeFolder(a.worktreePath);
    if (!folder) continue;
    const list = byFolder.get(folder);
    if (list) list.push(a);
    else byFolder.set(folder, [a]);
  }

  const projectByName = new Map<string, ProjectTotal>();
  for (const p of report.projects) projectByName.set(p.project, p);

  const rows: AgentSpendRow[] = [];
  const ambiguousFolders: string[] = [];
  for (const [folder, claimants] of byFolder) {
    const project = projectByName.get(folder);
    if (!project) continue;
    if (claimants.length > 1) {
      ambiguousFolders.push(folder);
      continue;
    }
    const agent = claimants[0]!;
    rows.push({
      agentId: agent.agentId,
      name: agent.name,
      projectName: agent.projectName,
      folder,
      sessions: project.sessions,
      messages: project.messages,
      totalTokens: project.tokens.total,
      estimatedCostUsd: project.estimatedCostUsd,
      unpricedTokens: project.unpricedTokens,
      lastActive: project.lastActive,
    });
  }

  rows.sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  ambiguousFolders.sort();

  // The remainder is a SUBTRACTION from the report's own totals, never a sum of the rows we chose
  // to skip: that way an attribution bug shows up as a wrong remainder instead of vanishing.
  const totals = bucketOf(report.totals);
  const unattributed: UnattributedSpend = {
    messages: Math.max(0, totals.messages - sum(rows, (r) => r.messages)),
    totalTokens: Math.max(0, totals.totalTokens - sum(rows, (r) => r.totalTokens)),
    estimatedCostUsd: Math.max(0, totals.estimatedCostUsd - sum(rows, (r) => r.estimatedCostUsd)),
    unpricedTokens: Math.max(0, totals.unpricedTokens - sum(rows, (r) => r.unpricedTokens)),
  };

  return { rows, unattributed, ambiguousFolders };
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  return items.reduce((acc, t) => acc + pick(t), 0);
}

// ── the cap ─────────────────────────────────────────────────────────────────────────────────

/**
 * How close the fleet is to the per-agent cap.
 *
 * - `off`    — no cap set. The DEFAULT, and the whole feature is inert there.
 * - `under`  — a cap is set and nobody is near it.
 * - `near`   — at least one agent has crossed [`NEAR_FRACTION`] of the cap.
 * - `over`   — at least one agent has reached or passed it.
 */
export type SpendCapState = "off" | "under" | "near" | "over";

/** The share of the cap at which an agent is called out before it is exceeded. */
export const NEAR_FRACTION = 0.8;

export interface SpendCapVerdict {
  state: SpendCapState;
  /** The cap in effect, or `null` when there isn't one. */
  capUsd: number | null;
  /** Agents at or past the cap, heaviest first. */
  over: AgentSpendRow[];
  /** Agents past [`NEAR_FRACTION`] of it but not yet at it, heaviest first. */
  near: AgentSpendRow[];
  /**
   * Agents whose spend CANNOT be judged against a dollar cap because every token they burned came
   * from a model with no published rate. They are NOT `under`: an unknown cost is not a low one,
   * and reporting it as within budget is the exact silent-zero this pane exists to avoid.
   */
  unjudged: AgentSpendRow[];
}

/** A row whose cost is entirely unknown — tokens were spent, none of them at a price we hold. */
function costIsUnknown(row: AgentSpendRow): boolean {
  return row.estimatedCostUsd <= 0 && row.unpricedTokens > 0;
}

/**
 * Compare each agent against the cap.
 *
 * `capUsd` of `null`, zero, negative or non-finite all mean NO CAP — the feature ships off, and a
 * malformed persisted value must read as off rather than as a cap of $0 that condemns everyone.
 */
export function evaluateSpendCap(
  rows: AgentSpendRow[],
  capUsd: number | null | undefined,
): SpendCapVerdict {
  const cap = normalizeCapUsd(capUsd);
  if (cap === null) {
    return { state: "off", capUsd: null, over: [], near: [], unjudged: [] };
  }

  const over: AgentSpendRow[] = [];
  const near: AgentSpendRow[] = [];
  const unjudged: AgentSpendRow[] = [];
  for (const row of rows) {
    if (costIsUnknown(row)) {
      unjudged.push(row);
      continue;
    }
    if (row.estimatedCostUsd >= cap) {
      over.push(row);
    } else if (row.estimatedCostUsd >= cap * NEAR_FRACTION) {
      near.push(row);
    }
  }

  const byCost = (a: AgentSpendRow, b: AgentSpendRow) => b.estimatedCostUsd - a.estimatedCostUsd;
  over.sort(byCost);
  near.sort(byCost);
  unjudged.sort((a, b) => b.totalTokens - a.totalTokens);

  const state: SpendCapState = over.length > 0 ? "over" : near.length > 0 ? "near" : "under";
  return { state, capUsd: cap, over, near, unjudged };
}

/** The one place a persisted or typed cap becomes a number the rest of the app trusts. */
export function normalizeCapUsd(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}
