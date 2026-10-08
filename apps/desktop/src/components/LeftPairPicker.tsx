import { useMemo } from "react";
import { C } from "../theme/colors";
import { FONT_UI, RADIUS, SPACE, TYPE, WEIGHT } from "../theme/scale";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { openProjectsOf } from "../engine/openProjects";
import { projectsOnSide } from "../engine/pairs";

/**
 * THE EMPTY LEFT PAIR'S PROMPT — what the concierge-CENTER layout shows on its left while nothing
 * lives there yet (epic sparkle-5ua3br).
 *
 * The founder chose an EMPTY left side with a prompt over moving a project automatically, so this
 * offers every open right-side project as a one-click "show it here". It is also the ONLY way an
 * existing project reaches the left pair: the hover +/− that used to do it is gone, and the left
 * strip's "+" opens NEW projects only.
 *
 * Moving a project changes which stage its panes are portalled into, never whether they are
 * mounted (engine/pairs, `PaneHost`), so its terminals keep running across the move.
 */
export function LeftPairPicker() {
  const projects = useProjectStore((s) => s.projects);
  const openProjectIds = useUiStore((s) => s.openProjectIds);
  const pairAssignment = useUiStore((s) => s.pairAssignment);
  const assignProjectToPair = useUiStore((s) => s.assignProjectToPair);
  const setLeftProject = useUiStore((s) => s.setLeftProject);
  const candidates = useMemo(
    () => projectsOnSide(openProjectsOf(projects, openProjectIds), pairAssignment, "right"),
    [projects, openProjectIds, pairAssignment],
  );
  return (
    <div
      data-testid="left-pair-picker"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: SPACE.md,
        textAlign: "center",
        padding: SPACE.xl,
        fontFamily: FONT_UI,
      }}
    >
      <div style={{ fontSize: TYPE.title, fontWeight: WEIGHT.bold, color: C.cream }}>Nothing on this side yet</div>
      <div style={{ fontSize: TYPE.body, color: C.muted, maxWidth: 420, lineHeight: 1.5 }}>
        {candidates.length > 0
          ? "Pick a project to show on the left of the concierge, or open a new one with + in the tab strip above."
          : "Open a project with + in the tab strip above."}
      </div>
      {candidates.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.sm, justifyContent: "center", maxWidth: 480 }}>
          {candidates.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`left-pair-pick-${p.id}`}
              title={`Show ${p.name} on the left`}
              onClick={() => {
                assignProjectToPair(p.id, "left");
                setLeftProject(p.id);
              }}
              style={{
                fontFamily: FONT_UI,
                fontSize: TYPE.body,
                color: C.cream,
                background: "transparent",
                border: `1px solid ${C.muted}`,
                borderRadius: RADIUS.input,
                padding: `${SPACE.xs}px ${SPACE.md}px`,
                cursor: "pointer",
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
