// Publishes the desktop's live agent roster (projects → agents → status) to the phone via the
// relay, re-pushing whenever projects or statuses change. Mounted once in App.tsx.
import { useEffect } from "react";
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { pushRoster, type RosterPayload } from "./services/relayClient";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import type { AgentTab, Project } from "./types";

const DEFAULT_STATUS: AgentTabStatus = "stopped";

/** The name we show — Claude Code's title if known, else the auto-name, else the fallback. */
function displayName(a: AgentTab): string {
  return a.aiTitle || a.autoNameVariants?.title || a.name;
}

function buildRoster(
  projects: Project[],
  status: Record<string, AgentTabStatus>,
  workflowStage: Record<string, string>,
): RosterPayload {
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      agents: p.agents.map((a) => {
        const st = status[a.id] ?? DEFAULT_STATUS;
        const tok = AGENT_STATUS[st] ?? AGENT_STATUS[DEFAULT_STATUS];
        return {
          id: a.id,
          name: displayName(a),
          kind: a.kind,
          status: st,
          status_color: tok.color,
          status_label: tok.label,
          parent_id: a.parentId,
          workflow_stage: workflowStage[a.id] ?? null,
        };
      }),
    })),
  };
}

export function useRosterPublisher(): void {
  const projects = useProjectStore((s) => s.projects);
  const status = useRuntimeStore((s) => s.status);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);

  useEffect(() => {
    // Coalesce rapid changes into one push.
    const t = setTimeout(() => {
      pushRoster(buildRoster(projects, status, workflowStage));
    }, 250);
    return () => clearTimeout(t);
  }, [projects, status, workflowStage]);
}
