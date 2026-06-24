import { AGENT_STATUS } from "@sparkle/ui";
import type { AgentTabStatus } from "../types";

/** A colored dot conveying an agent tab's status (spec §6). `working` pulses. */
export function StatusDot({
  status,
  size = 9,
}: {
  status: AgentTabStatus;
  size?: number;
}) {
  const meta = AGENT_STATUS[status];
  return (
    <span
      title={meta.label}
      className={status === "working" ? "sparkle-pulse" : undefined}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: meta.color,
        flex: "0 0 auto",
      }}
    />
  );
}
