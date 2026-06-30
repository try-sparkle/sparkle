// Publishes the desktop's live agent roster (projects → agents → status) to the phone via the
// relay, re-pushing whenever projects, statuses, the open-window set, or interaction times change.
// Mounted once in App.tsx.
//
// Only projects currently OPEN in a window are published — the phone mirrors what you actually have
// open on the desktop, not every project that's ever been in Recent. "Open" = a window is showing
// it (the shared window registry), the same predicate the desktop UI uses.
import { useEffect, useState } from "react";
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { pushRoster, type RosterPayload } from "./services/relayClient";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useInteractionStore } from "./stores/interactionStore";
import { findWindowForProject, onWindowRegistryChange } from "./services/windowRegistry";
import type { AgentTab, Project } from "./types";

const DEFAULT_STATUS: AgentTabStatus = "stopped";

/** The name we show — Claude Code's title if known, else the auto-name, else the fallback. */
function displayName(a: AgentTab): string {
  return a.aiTitle || a.autoNameVariants?.title || a.name;
}

/** The user's last touch of this agent (composer Send or terminal keystroke), or undefined. Mirrors
 *  the sidebar's elapsed-timer anchor so the phone's timer matches the desktop's exactly. */
function lastActivityAt(a: AgentTab, interaction: Record<string, number>): number | null {
  const lastPromptAt = a.promptHistory[a.promptHistory.length - 1]?.at;
  const touch = Math.max(lastPromptAt ?? 0, interaction[a.id] ?? 0);
  return touch > 0 ? touch : null;
}

function buildRoster(
  projects: Project[],
  status: Record<string, AgentTabStatus>,
  workflowStage: Record<string, string>,
  interaction: Record<string, number>,
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
          last_activity_at: lastActivityAt(a, interaction),
        };
      }),
    })),
  };
}

export function useRosterPublisher(): void {
  const projects = useProjectStore((s) => s.projects);
  const status = useRuntimeStore((s) => s.status);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const interaction = useInteractionStore((s) => s.lastAt);

  // The window registry isn't reactive (it's localStorage), so bump a tick whenever a window opens
  // or closes a project, to re-evaluate the open set and re-push.
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => onWindowRegistryChange(() => setRegistryTick((n) => n + 1)), []);

  useEffect(() => {
    // Coalesce rapid changes into one push.
    const t = setTimeout(() => {
      const open = projects.filter((p) => findWindowForProject(p.id) != null);
      pushRoster(buildRoster(open, status, workflowStage, interaction));
    }, 250);
    return () => clearTimeout(t);
  }, [projects, status, workflowStage, interaction, registryTick]);
}
