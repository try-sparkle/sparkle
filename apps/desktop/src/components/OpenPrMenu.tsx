// "N PRs waiting" in the TopBar — a repo-scoped, agent-independent menu of the open pull requests
// this identity owns, with a per-PR Merge, a "Merge all ready", and a jump to the agent that opened
// each one.
//
// Why it lives here and not on the agent row: the per-agent "Merge PR" CTA dies with its agent, and
// every agent leaves the sidebar when its session ends — so a PR opened by a finished session goes
// invisible exactly when it is waiting to be merged. This menu is the durable, always-present gate.
// It replaced the old dot cluster that sat right of the project name.
//
// The Merge action is deliberately gated (prMergeEligibility) and merges with a MERGE COMMIT via the
// Rust `merge_pr` command — never a blind or `--auto` merge. See services/openPrs.ts and AGENTS.md.
import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT_WEIGHT } from "../theme/colors";
import {
  fetchOpenPrs,
  formatPrBadge,
  mergePr,
  prMergeEligibility,
  OPEN_PR_POLL_MS,
  type PrRow,
} from "../services/openPrs";
import { log } from "../logger";
import type { Project } from "../types";

/** A live agent that opened a given PR's branch — enough for the menu to offer "Open agent". */
export interface PrAgentLink {
  agentId: string;
  agentName: string;
  projectId: string;
  /** True when the agent lives in the currently-shown project (a same-window select vs a route). */
  isCurrentProject: boolean;
}

/**
 * The live agent that opened a PR on `branch`, or null. A PR's branch is `sparkle/agent-<id>`, so the
 * agent whose `branch` field EQUALS the PR's `headRefName` is the one that opened it. Searched across
 * ALL projects (a PR you're merging may belong to another project's agent). Pure so the join — the
 * bit most likely to regress (a null branch, a worker sharing a name) — is unit-tested without a
 * component. A null/empty `branch` never matches (an unstarted or think agent has none).
 */
export function agentLinkForBranch(
  branch: string,
  projects: Project[],
  currentProjectId: string | null,
): PrAgentLink | null {
  if (!branch) return null;
  for (const p of projects) {
    const a = p.agents.find((ag) => ag.branch === branch);
    if (a)
      return {
        agentId: a.id,
        agentName: a.name,
        projectId: p.id,
        isCurrentProject: p.id === currentProjectId,
      };
  }
  return null;
}

/** Colour for a PR's aggregate CI rollup, matching the status-dot palette used elsewhere. */
function checksColor(checks: PrRow["checks"]): string {
  switch (checks) {
    case "passing":
      return C.success;
    case "pending":
      return C.amber;
    case "failing":
      return C.sienna;
    default:
      return C.muted; // "none" — no checks at all
  }
}

function checksTitle(checks: PrRow["checks"]): string {
  switch (checks) {
    case "passing":
      return "All checks passed";
    case "pending":
      return "Checks still running";
    case "failing":
      return "Checks failing";
    default:
      return "No checks";
  }
}

export function OpenPrMenu({
  rootPath,
  resolveAgent,
  onOpenAgent,
}: {
  rootPath: string | null;
  resolveAgent: (branch: string) => PrAgentLink | null;
  onOpenAgent: (link: PrAgentLink) => void;
}) {
  const [prs, setPrs] = useState<PrRow[] | null>(null);
  const [open, setOpen] = useState(false);
  // Which PR numbers are mid-merge — drives per-row spinners and disables the row's actions. A Set so
  // "Merge all" can mark several at once without clobbering an in-flight single merge.
  const [merging, setMerging] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Guards the async refetch against a project switch / unmount, exactly like the old badge did: a
  // slow probe for the previous repo must never paint its list under the new repo's name.
  const aliveRef = useRef(true);

  const refetch = useMemo(
    () => async () => {
      if (!rootPath) return;
      const rows = await fetchOpenPrs(rootPath);
      if (aliveRef.current) setPrs(rows);
    },
    [rootPath],
  );

  useEffect(() => {
    aliveRef.current = true;
    if (!rootPath) {
      setPrs(null);
      return;
    }
    // Clear on switch so the previous repo's list can't linger under the new name until the probe
    // returns (up to the network timeout).
    setPrs(null);
    setError(null);
    setOpen(false);
    void refetch();
    const id = window.setInterval(() => void refetch(), OPEN_PR_POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, [rootPath, refetch]);

  const label = formatPrBadge(prs?.length ?? null);
  // Nothing waiting, or we couldn't find out — both render nothing (same rule as the old badge). Also
  // covers the moment a switch clears the list before the new probe returns.
  if (!label) return null;

  const list = prs ?? [];
  const eligible = list.filter((p) => prMergeEligibility(p).canMerge);
  const anyMerging = merging.size > 0;

  const runMerge = async (nums: number[]) => {
    if (!rootPath || nums.length === 0) return;
    setError(null);
    setMerging((prev) => new Set([...prev, ...nums]));
    let firstError: string | null = null;
    // Sequential on purpose: merging PR B right after A picks up A's landing, and it keeps the gh
    // calls from racing each other's rate limit. One failure is recorded but does not abort the rest.
    for (const n of nums) {
      try {
        await mergePr(rootPath, n);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn("open-pr-menu", `merge failed for PR #${n}`, msg);
        if (!firstError) firstError = `PR #${n}: ${msg}`;
      }
    }
    if (aliveRef.current) {
      if (firstError) setError(firstError);
      setMerging((prev) => {
        const next = new Set(prev);
        for (const n of nums) next.delete(n);
        return next;
      });
    }
    // Reconcile with the truth: merged PRs drop out, a failed one stays (now visibly still open).
    // Guarded like the setState calls above: refetch owns its own alive check today, but tightening
    // this here keeps the whole method's after-switch/unmount discipline uniform rather than relying
    // on that internal guard staying put.
    if (aliveRef.current) await refetch();
  };

  const openGithub = (url: string) => {
    if (!url) return;
    void openUrl(url).catch((e) => log.warn("open-pr-menu", "could not open PR", e));
  };

  return (
    <div style={{ position: "relative" }} data-testid="open-pr-menu">
      <button
        data-testid="open-pr-badge"
        title="Open pull requests you have waiting. Click to merge them or jump to their agent."
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refetch(); // refresh on open so the user acts on current state
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "transparent",
          border: `1px solid ${C.violet}`,
          borderRadius: 6,
          color: C.violet,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: FONT_WEIGHT.semibold,
          padding: "3px 8px",
          whiteSpace: "nowrap",
          position: "relative",
          zIndex: 42,
        }}
      >
        {/* The git-branch glyph, matching the "In PR" stage colour (violet) used by WorkflowLine. */}
        <span aria-hidden>⑂</span>
        {label}
        <span aria-hidden style={{ opacity: 0.7 }}>
          ▾
        </span>
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              marginTop: 4,
              minWidth: 340,
              maxWidth: 460,
              maxHeight: 420,
              overflowY: "auto",
              background: C.deepForest,
              border: `1px solid ${C.forest}`,
              borderRadius: 8,
              boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
              padding: 6,
              zIndex: 41,
            }}
          >
            {/* Header: count + Merge all ready. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px 8px",
                borderBottom: `1px solid ${C.forest}`,
                marginBottom: 4,
              }}
            >
              <span style={{ flex: 1, color: C.cream, fontSize: 13, fontWeight: FONT_WEIGHT.semibold }}>
                {list.length} open pull {list.length === 1 ? "request" : "requests"}
              </span>
              <button
                data-testid="merge-all"
                disabled={eligible.length === 0 || anyMerging}
                title={
                  eligible.length === 0
                    ? "No PRs are ready to merge (checks pending/failing or conflicts)"
                    : `Merge the ${eligible.length} PR${eligible.length === 1 ? "" : "s"} whose checks have passed`
                }
                onClick={() => void runMerge(eligible.map((p) => p.number))}
                style={{
                  background: eligible.length === 0 || anyMerging ? "transparent" : C.teal,
                  color: eligible.length === 0 || anyMerging ? C.muted : "#fff",
                  border: `1px solid ${eligible.length === 0 || anyMerging ? C.muted : C.teal}`,
                  borderRadius: 6,
                  padding: "3px 10px",
                  fontSize: 12,
                  fontWeight: FONT_WEIGHT.semibold,
                  cursor: eligible.length === 0 || anyMerging ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {anyMerging ? "Merging…" : `Merge all ready${eligible.length ? ` (${eligible.length})` : ""}`}
              </button>
            </div>

            {error && (
              <div
                data-testid="merge-error"
                style={{
                  color: C.sienna,
                  fontSize: 12,
                  padding: "4px 8px 8px",
                  wordBreak: "break-word",
                }}
              >
                {error}
              </div>
            )}

            {list.map((pr) => {
              const elig = prMergeEligibility(pr);
              const busy = merging.has(pr.number);
              const agent = resolveAgent(pr.headRefName);
              return (
                <div
                  key={pr.number}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 8px",
                    borderRadius: 6,
                  }}
                >
                  <span
                    aria-hidden
                    title={checksTitle(pr.checks)}
                    style={{
                      flex: "0 0 auto",
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: checksColor(pr.checks),
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        color: C.cream,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={pr.title}
                    >
                      <span style={{ color: C.muted }}>#{pr.number}</span> {pr.title || pr.headRefName}
                    </div>
                    <div
                      style={{
                        color: C.muted,
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {pr.headRefName}
                    </div>
                  </div>

                  {agent && (
                    <button
                      data-testid={`open-agent-${pr.number}`}
                      title={`Open ${agent.agentName} — the agent that opened this PR`}
                      onClick={() => {
                        setOpen(false);
                        onOpenAgent(agent);
                      }}
                      style={{
                        flex: "0 0 auto",
                        background: "transparent",
                        color: C.accentInk,
                        border: `1px solid ${C.accentMid}`,
                        borderRadius: 6,
                        padding: "3px 8px",
                        fontSize: 12,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Open agent
                    </button>
                  )}

                  <button
                    data-testid={`open-github-${pr.number}`}
                    title="View this PR on GitHub"
                    onClick={() => openGithub(pr.url)}
                    disabled={!pr.url}
                    style={{
                      flex: "0 0 auto",
                      background: "transparent",
                      color: pr.url ? C.violet : C.muted,
                      border: `1px solid ${pr.url ? C.violet : C.muted}`,
                      borderRadius: 6,
                      padding: "3px 8px",
                      fontSize: 12,
                      cursor: pr.url ? "pointer" : "default",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ↗
                  </button>

                  <button
                    data-testid={`merge-${pr.number}`}
                    disabled={!elig.canMerge || busy}
                    title={elig.canMerge ? "Merge this PR into main (merge commit)" : (elig.reason ?? "")}
                    onClick={() => void runMerge([pr.number])}
                    style={{
                      flex: "0 0 auto",
                      background: elig.canMerge && !busy ? C.teal : "transparent",
                      color: elig.canMerge && !busy ? "#fff" : C.muted,
                      border: `1px solid ${elig.canMerge && !busy ? C.teal : C.muted}`,
                      borderRadius: 6,
                      padding: "3px 10px",
                      fontSize: 12,
                      fontWeight: FONT_WEIGHT.semibold,
                      cursor: elig.canMerge && !busy ? "pointer" : "default",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {busy ? "Merging…" : "Merge"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
