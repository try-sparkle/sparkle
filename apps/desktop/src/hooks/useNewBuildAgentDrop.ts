// Drop files on the "+ New Build Agent" button to start a NEW build agent with those files
// attached — instead of attaching them to the active agent's composer (the default drop
// behavior everywhere else, owned by Composer.tsx).
//
// This is a SECOND webview-level onDragDropEvent listener (they coexist fine; Tauri fans events
// out to every listener), mounted once per window at the Workspace root so it also works when NO
// agent exists yet (the empty-state button has no active composer to piggyback on). While a drag
// hovers the button it lights the shared buildAgentHover flag — the exact same visual as a mouse
// hover, on BOTH button copies. On drop it spawns a build agent (same hook the click path uses;
// the new agent becomes selected/active immediately) and queues the dropped paths in the
// pending-attachments store, which the new agent's composer drains once it mounts. The Composer's
// own listener independently hit-tests the same position and bails when the drop is over the
// button (no listener-ordering dependence), so the files never double-attach.
import { useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useSpawnBuildAgent } from "./useSpawnBuildAgent";
import { useUiStore } from "../stores/uiStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
import { isOverDndTarget, NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import { safeUnlisten } from "../services/safeUnlisten";
import { log } from "../logger";
import type { Project } from "../types";

export function useNewBuildAgentDrop(project: Project | null): void {
  const spawnBuildAgent = useSpawnBuildAgent(project);
  // The listener registers once but must spawn against the CURRENT project — keep the latest
  // spawn closure in a ref so the handler never captures a stale project.
  const spawnRef = useRef(spawnBuildAgent);
  spawnRef.current = spawnBuildAgent;
  const setBuildAgentHover = useUiStore((s) => s.setBuildAgentHover);
  useEffect(() => {
    const unlistenPromise = getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          // Mouse events don't fire during a native drag, so the button's own onMouseEnter
          // never runs — this flag is the only thing lighting its hover state.
          setBuildAgentHover(isOverDndTarget(p.position, NEW_BUILD_AGENT_DND_TARGET));
        } else if (p.type === "leave") {
          setBuildAgentHover(false);
        } else if (p.type === "drop") {
          setBuildAgentHover(false);
          if (!isOverDndTarget(p.position, NEW_BUILD_AGENT_DND_TARGET)) return;
          const paths = p.paths ?? [];
          if (paths.length === 0) return;
          const id = spawnRef.current();
          if (!id) return; // no project open — no button rendered either; nothing to do
          log.info("composer", `dropped ${paths.length} file(s) on + New Build Agent`, {
            agentId: id,
            paths,
          });
          // The new composer hasn't mounted yet — queue the paths for it to drain on mount.
          usePendingAttachmentsStore.getState().add(id, paths);
        }
      })
      .catch((e) => {
        // A failed listen has no unlisten fn to return; log and let cleanup no-op.
        log.error("composer", "new-build-agent drop listen failed", e);
        return undefined;
      });
    return () => {
      setBuildAgentHover(false);
      // safeUnlisten awaits the listen() promise so a handler that resolves AFTER unmount is
      // still torn down (and the Tauri teardown race is swallowed).
      void safeUnlisten(unlistenPromise);
    };
  }, [setBuildAgentHover]);
}
