// The single "+ New Build Agent" action, runtime-aware (Service B, W5). Both places that offer it
// (the sidebar row and the Workspace empty-state button) call THIS, so the Local/Cloud toggle
// governs them identically.
//
// Local is unchanged: create the tab synchronously and return its id (callers use it to queue
// dropped files into the new agent's composer). Cloud can't work that way — the server must start
// the session before a tab exists, and it needs a goal + repo up front — so it opens the create
// dialog and returns null ("no agent yet"), which every caller already handles (that's the
// no-project return too).

import { useUiStore } from "../stores/uiStore";
import { useSpawnBuildAgent } from "./useSpawnBuildAgent";
import type { Project } from "../types";

export function useNewAgent(project: Project | null): () => string | null {
  const spawnLocal = useSpawnBuildAgent(project);
  const runtime = useUiStore((s) => s.newAgentRuntime);
  const setCloudCreateOpen = useUiStore((s) => s.setCloudCreateOpen);
  return () => {
    if (project && runtime === "cloud") {
      setCloudCreateOpen(true);
      return null;
    }
    return spawnLocal();
  };
}
