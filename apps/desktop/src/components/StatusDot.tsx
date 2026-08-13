import { memo } from "react";
import { AGENT_STATUS } from "@sparkle/ui";
import type { AgentTabStatus } from "../types";

/**
 * A colored mark conveying an agent tab's status (spec §6).
 *
 * It does NOT animate. `working` used to carry a `sparkle-pulse` class (opacity 1 → .35, 1.1s,
 * infinite) to separate "running right now" from "done" at a glance. Once the build column was
 * stripped to a disc and a title, a fleet with several live agents was a column of blinking dots —
 * motion that is always on stops reading as "look here" and becomes the background. The color
 * already carries the distinction, on a mark the eye scans straight down. The `.sparkle-pulse`
 * class itself stays in index.css; MicButton, Composer, RichPlaceholder and ConciergeThread still
 * use it for genuinely transient states.
 *
 * `shape="dot"` (default) is a full circle for a top-level agent. `shape="half"` is a
 * half-disc — a straight vertical left edge with the right side rounded into a semicircle,
 * i.e. a capital "D" — used to mark a sub-agent (worker) in the TopBar dot cluster so it
 * reads as nested under the full dot that precedes it.
 *
 * `React.memo`'d (sparkle-alrm.3): the dot's props are all primitives, so one agent's status
 * flip re-renders only its own dot rather than every dot in the sidebar/TopBar cluster.
 */
export const StatusDot = memo(function StatusDot({
  status,
  size = 9,
  shape = "dot",
  variant = "fill",
  color,
  label,
}: {
  status: AgentTabStatus;
  size?: number;
  shape?: "dot" | "half";
  /** `fill` (default) = THIS ROW is in the state the color names. `ring` = a row UNDER this one is,
   *  and this head is standing in for it.
   *
   *  The founder, on a sidebar where nearly every row was red: *"Why are all these agents showing as
   *  red when they're not blocked by me? As a human."* Part of that wall was heads borrowing their
   *  workers' red, which is legitimate — an orchestrator whose worker is at a permission prompt does
   *  need surfacing — but it was drawn IDENTICALLY to a head blocked in its own right, so the two
   *  could not be told apart at a glance. Same hue (it still has to draw the eye), different fill.
   *
   *  Drawn as an INSET box-shadow rather than a border so the element's box is unchanged: a border
   *  would grow the disc and shift every row's text by a pixel or two as workers come and go. */
  variant?: "fill" | "ring";
  /** Paint this instead of the status color. ONE caller: an orchestrator head whose disc summarizes
   *  its folded workers rather than reporting its own PTY state (engine/workerRollup) — including
   *  the `mixedInk` orange, which has no AGENT_STATUS entry to look up. Everything else omits it and
   *  gets the taxonomy. */
  color?: string;
  /** Tooltip override, which a `color` override almost always needs too: a head painted from its
   *  workers must not keep hovering as its own status, or the dot and the tooltip disagree. */
  label?: string;
}) {
  const meta = AGENT_STATUS[status];
  const half = shape === "half";
  const text = label ?? meta.label;
  const ink = color ?? meta.color;
  const ring = variant === "ring";
  return (
    <span
      title={half ? `${text} (sub-agent)` : text}
      style={{
        display: "inline-block",
        // A "D": square left corners (flat diameter), fully rounded right corners (the bulge).
        width: half ? size * 0.6 : size,
        height: size,
        borderRadius: half ? "0 50% 50% 0 / 0 50% 50% 0" : "50%",
        background: ring ? "transparent" : ink,
        // Inset, so the ring costs no layout — see `variant`.
        boxShadow: ring ? `inset 0 0 0 ${Math.max(1.5, size * 0.22)}px ${ink}` : undefined,
        flex: "0 0 auto",
      }}
    />
  );
});
