import { AGENT_STATUS } from "@sparkle/ui";
import type { AgentTabStatus } from "../types";

/**
 * A colored mark conveying an agent tab's status (spec §6). `working` pulses.
 *
 * `shape="dot"` (default) is a full circle for a top-level agent. `shape="half"` is a
 * half-disc — a straight vertical left edge with the right side rounded into a semicircle,
 * i.e. a capital "D" — used to mark a sub-agent (worker) in the TopBar dot cluster so it
 * reads as nested under the full dot that precedes it.
 */
export function StatusDot({
  status,
  size = 9,
  shape = "dot",
}: {
  status: AgentTabStatus;
  size?: number;
  shape?: "dot" | "half";
}) {
  const meta = AGENT_STATUS[status];
  const half = shape === "half";
  return (
    <span
      title={half ? `${meta.label} (sub-agent)` : meta.label}
      className={status === "working" ? "sparkle-pulse" : undefined}
      style={{
        display: "inline-block",
        // A "D": square left corners (flat diameter), fully rounded right corners (the bulge).
        width: half ? size * 0.6 : size,
        height: size,
        borderRadius: half ? "0 50% 50% 0 / 0 50% 50% 0" : "50%",
        background: meta.color,
        flex: "0 0 auto",
      }}
    />
  );
}
