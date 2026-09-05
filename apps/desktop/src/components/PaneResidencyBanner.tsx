import { type CSSProperties } from "react";
import { FiClock } from "react-icons/fi";

import { C } from "../theme/colors";
import { FONT_UI, SPACE, TYPE } from "../theme/scale";

// THE DEFERRAL, SAID OUT LOUD (bead `sparkle-ftapmp`).
//
// `hooks/usePaneResidencyAdmission` holds a dormant row's pane back when the machine is genuinely at
// its residents ceiling. That gate is what let `services/agentCapacity` stop counting dormant rows
// against a residents-denominated memory ceiling — but a held-back pane has a real, user-visible
// cost, and it is exactly the cost `hooks/useStaggeredPaneMounts` refuses to pay silently:
// `runtimeStore.status` has ONE writer, a MOUNTED `AgentPane`, so an unmounted pane means a frozen
// status and no attention notifications for that agent. Unannounced, that reads as a dead fleet.
//
// So this bar exists to make the deferral legible, and it says the three things a human needs: how
// many are waiting, WHY (memory, not a hang), and that it clears itself. It is NOT dismissible —
// there is nothing to acknowledge, the condition is live and it disappears on its own the moment
// the next memory poll grants room. A dismiss button on a self-clearing condition just teaches
// people to hide the one bar that explains a frozen status.
//
// It joins the shell banner stack in `Workspace` as an ordinary flow child; see
// `Workspace.bannerStack.test.tsx` for why nothing here may be `position: fixed`.

// NOT `pane-…`. Workspace's own suites match mounted agent panes with `/^pane-/`, and a banner whose
// id starts the same way is counted as a seventh pane by every one of them — caught the first time
// this bar was rendered into that harness, where "three panes mounted" read as four.
export const PANE_RESIDENCY_BANNER_TESTID = "agent-residency-banner";

const bar: CSSProperties = {
  flex: "0 0 auto",
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: SPACE.sm,
  padding: `${SPACE.sm}px ${SPACE.lg}px`,
  background: C.deepForest,
  borderBottom: `1px solid ${C.amberInk}`,
  color: C.cream,
  fontSize: TYPE.body,
  fontFamily: FONT_UI,
};

/**
 * @param deferredCount how many panes are being held back. Renders nothing at zero.
 * @param basis the reading's own sentence for WHY, from `CapacityReading.basis`. Optional: a
 *              deferral with no explanation is still worth announcing, and inventing one would be
 *              the "asserted the wrong dimension" bug this app has already been bitten by twice.
 */
export function PaneResidencyBanner({
  deferredCount,
  basis,
}: {
  deferredCount: number;
  basis?: string;
}) {
  if (deferredCount <= 0) return null;
  const noun = deferredCount === 1 ? "agent" : "agents";
  const verb = deferredCount === 1 ? "is" : "are";
  return (
    <div role="status" aria-live="polite" style={bar} data-testid={PANE_RESIDENCY_BANNER_TESTID}>
      <FiClock aria-hidden size={16} style={{ color: C.amberInk, flex: "0 0 auto" }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        {`${deferredCount} ${noun} ${verb} waiting to start — this machine is at the number of ` +
          `agents its memory can hold, so their panes stay closed for now. They start on their own ` +
          `as soon as there is room; closing or finishing an agent frees it sooner.`}
        {basis ? ` (${basis})` : ""}
      </span>
    </div>
  );
}
