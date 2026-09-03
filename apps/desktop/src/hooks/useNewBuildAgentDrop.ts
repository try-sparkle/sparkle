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
import {
  isOverDndTarget,
  NEW_BUILD_AGENT_DND_TARGET,
  noteDropArrived,
  reportDropWithNoTarget,
} from "../services/dndTargets";
import { sideOf, type PairAssignment, type PairSide } from "../engine/pairs";
import { safeUnlisten } from "../services/safeUnlisten";
import { describePaths } from "../services/logSafePaths";
import { withDropPaths } from "../services/dropPaths";
import { log } from "../logger";
import type { Project } from "../types";

/**
 * The epic a drop on "+ New Build Agent" is being made AGAINST, or `undefined` for none.
 *
 * ── WHY THE DROP HAD TO ASK THIS AT ALL (bead sparkle-70cu4y) ─────────────────────────────────
 * One button, two gestures, and they disagreed. `AgentSidebar` renders the button with
 * `onLocalClick={() => spawnBuildAgent(epicFocusId ?? undefined)}`, so a CLICK from an epic-focused
 * sidebar reaches `spawnBuildAgentInProject` carrying the epic: the row's `epicId` is stamped and
 * the auto-bead is minted as a CHILD of that epic. The DROP called `spawnRef.current()` with no
 * arguments, so the epic the app already had in hand was discarded between the gesture and the
 * shared spawn — and because an omitted `epicId` is also how an honestly epic-less spawn is spelled
 * (the empty-state button, the babysit dispatcher), nothing downstream could tell the two apart.
 *
 * The cost is not cosmetic. `epicSweepRunner.boundAgentsFor` is `kind === "build" && epicId ===
 * <epic>` and reads the ROW ALONE — no bead, no parent edge. It is the RAW BINDING, read by the
 * sweep's watch gate, the sweep's marker self-heal, and `planView.orchestratorNameForEpic`; the
 * LIVENESS readings (`candidateFor`'s `orchestratorAlive`, `pusherMount.improveUnstaffedEpics`)
 * resolve through `epicSweepRunner.staffingAgentsFor` instead, since bead `sparkle-n2feho.5`. A
 * dropped spawn that discards the epic is invisible to BOTH — the row carries neither an `epicId`
 * nor a bead parented to the epic — so the epic sat unstaffed with a live agent working it.
 *
 * ── READ LIVE, AT THE DROP, AND FROM THE OWNING SIDE ─────────────────────────────────────────
 * Two things this deliberately does NOT do:
 *
 *   1. It is not captured in the effect. The webview listener registers ONCE (its deps are
 *      `[setBuildAgentHover]`) and the focus moves constantly, so a closed-over value would bind a
 *      drop to whatever epic happened to be focused when the Workspace mounted. The focus at the
 *      INSTANT OF THE DROP is the only answer that matches what the user was looking at, and it is
 *      the same instant the click path reads its own.
 *   2. It does not take `epicFocusBySide` whole. The focus is PER PAIR, and this listener is
 *      window-global: the other column can be focused on an epic that has nothing to do with the
 *      project being dropped into. Binding to it would attribute an agent to work nobody aimed it
 *      at — the false-positive direction, and the one that cannot be walked back, since the epic
 *      then reads STAFFED by an agent doing something else entirely. So the side is resolved from
 *      the project, exactly as `AgentSidebar` resolves its own `pairSide`.
 *
 * A `null` project returns `undefined` and never consults the map: `sideOf(assignment, "")` answers
 * `"right"` by design, so asking with no project would hand back the right pair's focus for a
 * window that is rendering no button at all.
 */
export function epicFocusForDrop(
  projectId: string | null,
  pairAssignment: PairAssignment,
  epicFocusBySide: Readonly<Record<PairSide, string | null>>,
): string | undefined {
  if (!projectId) return undefined;
  // `?? undefined` rather than the raw value: `null` is how the store spells "nothing focused", and
  // `SpawnBuildAgentOpts.epicId` spells the same state as ABSENT. Handing the spawn a `null` would
  // be a third spelling of one fact, which is how a binding ends up written as a garbage id.
  return epicFocusBySide[sideOf(pairAssignment, projectId)] ?? undefined;
}

export function useNewBuildAgentDrop(project: Project | null): void {
  const spawnBuildAgent = useSpawnBuildAgent(project);
  // The listener registers once but must spawn against the CURRENT project — keep the latest
  // spawn closure in a ref so the handler never captures a stale project.
  const spawnRef = useRef(spawnBuildAgent);
  spawnRef.current = spawnBuildAgent;
  // The project id travels the same way and for the same reason the spawn closure does: the
  // listener registers once, and the drop must resolve the epic focus for whichever project is
  // current AT THE DROP, not the one that was open when the Workspace mounted.
  const projectIdRef = useRef(project?.id ?? null);
  projectIdRef.current = project?.id ?? null;
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
          noteDropArrived(p.position, p.paths);
          if (!isOverDndTarget(p.position, NEW_BUILD_AGENT_DND_TARGET)) {
            // Not ours — usually because another target owns it, in which case this is silent.
            // It only speaks up when the drop matched NOTHING, which is the coordinate-space bug
            // signature the last regression had no log line for at all.
            reportDropWithNoTarget(p.position);
            return;
          }
          // Recovered rather than silently discarded when the drag carried no paths — see
          // services/dropPaths. The spawn happens AFTER the paths resolve, deliberately: spawning
          // first would leave an empty agent behind for a drag that turns out to carry no file.
          withDropPaths(p.paths, "new-build-agent", (paths) => {
            // JOIN THE FOCUSED EPIC, exactly as a CLICK on this same button does — see
            // `epicFocusForDrop` for why the read is live and side-scoped. Read through
            // `getState()` rather than a subscription: this is an imperative event handler, and a
            // subscribed value would re-run the effect (re-registering the webview listener) every
            // time the founder moved the epic focus, for a value only ever read on drop.
            const ui = useUiStore.getState();
            const epicId = epicFocusForDrop(projectIdRef.current, ui.pairAssignment, ui.epicFocusBySide);
            // `undefined` is passed as NO OPTIONS AT ALL, so the honest epic-less drop is
            // byte-for-byte the call it has always made: the row carries no `epicId`, the auto-bead
            // stays top-level, and no staffing reader is told a binding exists.
            const id = spawnRef.current(epicId ? { epicId } : undefined);
            if (!id) return; // no project open — no button rendered either; nothing to do
            // Kinds, never paths — the log ships with support tickets and crash reports
            // (see services/logSafePaths).
            log.info("composer", `dropped ${paths.length} file(s) on + New Build Agent`, {
              agentId: id,
              ...describePaths(paths),
            });
            // The new composer hasn't mounted yet — queue the paths for it to drain on mount.
            usePendingAttachmentsStore.getState().add(id, paths);
          });
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
