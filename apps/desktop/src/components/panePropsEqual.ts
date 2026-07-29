// `React.memo`'s comparator for the live agent pane — lifted OUT of `AgentPane.tsx` so it can be
// imported without the pane's module graph.
//
// That graph is the whole reason this file exists. `AgentPane.tsx` pulls in xterm, the Tauri core
// bridge, the worktree/spawn services and a dozen stores at module scope, so any test that wants the
// COMPARATOR — including the render-cost harness, which mocks the pane away and re-wraps a counting
// stub in the real predicate — had to load all of it to get at four lines of prop comparison. Worse,
// a mock factory that reached for `vi.importActual("./AgentPane")` would be loading the very module
// it is replacing. One tiny leaf module makes the predicate cheap to import and impossible to fake.
//
// `AgentPane.tsx` re-exports it, so `import { arePanePropsEqual } from "./AgentPane"` still resolves.
import type { AgentTab, Project } from "../types";

/** Skip a re-render when nothing THIS pane depends on changed. A projectStore write for a SIBLING
 *  agent (a status flip, an activity narration, a prompt append) mints a new `projects` array + a new
 *  project object (mapProject/mapAgent) and re-renders Workspace — which, unmemoized, re-rendered
 *  EVERY mounted pane (terminal + composer) on every such write. But mapAgent replaces only the
 *  touched agent's object, so this pane's own `agent` ref is preserved, and the only `project` fields
 *  this pane's render (and ThinkPanel) read are the four scalars below. So when `agent` and `visible`
 *  and those scalars are unchanged, the pane's output is identical and we can safely bail. `agent`
 *  referential equality already re-renders on this pane's own updates; `visible` re-renders on switch.
 *  Internal store subscriptions (composerMinimized, scrollIntent, AI gates) are unaffected — memo only
 *  gates PARENT-driven re-renders, not the component's own subscriptions.
 *
 *  NOTE WHAT IS DELIBERATELY ABSENT: the stage the pane is displayed in. Since panes portal into
 *  their stage (`PaneHost` in Workspace.tsx), moving a project between pairs changes the portal's
 *  DESTINATION, not this component's props — so a side change must NOT re-render the pane, and there
 *  is nothing here for it to compare. See `engine/pairs.ts`. */
export function arePanePropsEqual(
  a: { project: Project; agent: AgentTab; visible: boolean; calm?: boolean },
  b: { project: Project; agent: AgentTab; visible: boolean; calm?: boolean },
): boolean {
  return (
    a.agent === b.agent &&
    a.visible === b.visible &&
    !!a.calm === !!b.calm &&
    a.project.id === b.project.id &&
    a.project.rootPath === b.project.rootPath &&
    a.project.name === b.project.name &&
    a.project.defaultBranch === b.project.defaultBranch
  );
}
