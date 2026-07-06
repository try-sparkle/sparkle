// Mobile-faithful web re-creation of apps/mobile/src/app/(app)/index.tsx for the menu-bar
// popover panel. Drops the phone-only "Connected to your Mac" relay row (the tray is local).
//
// WorkflowLine decision: we use <WorkflowLine> (reuses the existing component, DRY) with a
// string-to-WorkflowStageId cast. The truthiness guard (agent.workflow_stage &&) ensures the
// stage is non-null/empty before passing it through. If the value is not a valid WorkflowStageId
// (e.g. an unknown future stage), stageFraction returns 0 and the bar renders empty — safe fallback.
// The inline stageFraction/stageLineColor approach would also require the same type cast, so there
// is no advantage to inlining here.
import { Fragment } from "react";
import { C } from "@sparkle/ui";
import { formatElapsed } from "../components/AgentSidebar";
import type { WorkflowStageId } from "../engine/workflowStage";
import { WorkflowLine } from "../components/WorkflowLine";
import { TrayKindIcon } from "./TrayKindIcon";
import { rankCmp, type TrayAgent, type TrayRoster } from "./trayRoster";

const NEEDS_YOU = new Set(["waiting", "approval"]);

/** Show the first ~4 words of a prompt, adding an ellipsis when there's more. Keeps each breadcrumb
 *  crumb short so several recent prompts fit on one row. */
function truncateWords(text: string, maxWords = 4): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ") + "…";
}

export function TrayDashboard({
  roster, now, onOpen,
}: {
  roster: TrayRoster;
  now: number;
  onOpen: (projectId: string, agentId: string, promptId?: string) => void;
}) {
  const pending: Array<{ projectId: string; projectName: string; agent: TrayAgent }> = [];
  for (const p of roster.projects)
    for (const a of p.agents)
      if (NEEDS_YOU.has(a.status)) pending.push({ projectId: p.id, projectName: p.name, agent: a });

  return (
    <div style={{ background: C.forest, minHeight: "100%", padding: 16, display: "flex", flexDirection: "column", gap: 8, boxSizing: "border-box" }}>
      {pending.length > 0 && (
        <div style={{ background: "rgba(224,83,63,0.12)", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ color: "#ff8a7a", fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>Needs you</div>
          {pending.map(({ projectId, projectName, agent }) => (
            <button key={agent.id} onClick={() => onOpen(projectId, agent.id)}
              style={{ all: "unset", cursor: "pointer", display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ color: C.cream, fontSize: 15, fontWeight: 700 }}>{projectName} · {agent.name}</div>
              <div style={{ color: C.muted, fontSize: 13 }}>{agent.status_label}</div>
            </button>
          ))}
        </div>
      )}

      {roster.projects.length === 0 ? (
        <div style={{ color: C.muted, fontSize: 15, marginTop: 24, textAlign: "center" }}>No projects running.</div>
      ) : (
        [...roster.projects].sort((a, b) => a.name.localeCompare(b.name)).map((project) => {
          const tops = project.agents.filter((a) => a.kind !== "worker").sort(rankCmp);
          return (
            <div key={project.id} style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ color: C.muted, fontSize: 12, fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>{project.name}</div>
              {tops.map((agent) => {
                const workers = project.agents.filter((w) => w.kind === "worker" && w.parent_id === agent.id).sort(rankCmp);
                return (
                  <div key={agent.id}>
                    <AgentRow agent={agent} now={now} onOpen={(promptId) => onOpen(project.id, agent.id, promptId)} />
                    {workers.map((w) => (
                      <AgentRow key={w.id} agent={w} now={now} depth={1} onOpen={(promptId) => onOpen(project.id, w.id, promptId)} />
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

function AgentRow({ agent, now, depth = 0, onOpen }: { agent: TrayAgent; now: number; depth?: number; onOpen: (promptId?: string) => void }) {
  const needsYou = NEEDS_YOU.has(agent.status);
  const elapsed = agent.last_activity_at != null ? formatElapsed(Math.max(0, now - agent.last_activity_at)) : null;
  const crumbs = agent.recent_prompts ?? [];
  return (
    // A plain container div (no role/tabindex — that would invalidly nest the crumb <button>s inside
    // a role="button"). The real keyboard-accessible controls are the inner buttons: each crumb, and
    // the fallback title. The div's onClick is just a redundant mouse affordance over the row's
    // non-interactive area (dot/icon/status). Clicking a crumb opens + scrolls to that prompt and
    // stops propagation so the row handler doesn't also fire.
    <div onClick={() => onOpen()}
      style={{ cursor: "pointer", display: "block", width: "100%", boxSizing: "border-box",
        padding: `10px 12px 10px ${12 + depth * 22}px`, borderRadius: 10, background: "rgba(255,255,255,0.04)", marginBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: agent.status_color || C.muted, flex: "0 0 auto" }} />
        {/* The worker "↳" return-arrow glyph is intentionally suppressed; other kinds keep their icon. */}
        {agent.kind !== "worker" && (
          <span style={{ width: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>
            <TrayKindIcon kind={agent.kind} color={agent.status_color} />
          </span>
        )}
        {elapsed && <span style={{ fontSize: 11, fontVariantNumeric: "tabular-nums", color: agent.status_color, flex: "0 0 auto" }}>{elapsed}</span>}
        {crumbs.length > 0 ? (
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
            {crumbs.map((c, i) => {
              const isLast = i === crumbs.length - 1;
              return (
                <Fragment key={c.id}>
                  {i > 0 && <span aria-hidden style={{ color: C.muted, opacity: 0.6, fontSize: 12, flex: "0 0 auto" }}>›</span>}
                  <button type="button" title={c.text}
                    onClick={(e) => { e.stopPropagation(); onOpen(c.id); }}
                    style={{ all: "unset", cursor: "pointer", fontWeight: 400, whiteSpace: "nowrap",
                      color: isLast ? C.cream : C.muted, fontSize: isLast ? 16 : 13,
                      overflow: "hidden", textOverflow: "ellipsis", minWidth: 0,
                      // Keep the most-recent (rightmost) prompt fully visible; let earlier crumbs shrink first.
                      flex: isLast ? "0 0 auto" : "0 1 auto" }}>
                    {truncateWords(c.text)}
                  </button>
                </Fragment>
              );
            })}
          </div>
        ) : (
          <button type="button" title={agent.name} onClick={(e) => { e.stopPropagation(); onOpen(); }}
            style={{ all: "unset", cursor: "pointer", color: C.cream, fontSize: 16, fontWeight: 400, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name}</button>
        )}
        <span style={{ color: needsYou ? C.sienna : C.muted, fontSize: 12, fontWeight: needsYou ? 700 : 400, flex: "0 0 auto" }}>{agent.status_label}</span>
      </div>
      {agent.workflow_stage && <WorkflowLine stage={agent.workflow_stage as WorkflowStageId} />}
    </div>
  );
}
