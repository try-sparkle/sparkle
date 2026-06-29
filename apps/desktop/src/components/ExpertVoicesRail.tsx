// The expert-voices surface for the Think tab: shows the slate of personas Chief "spun up"
// when the user @mentions @chief, and lets the user @mention any one back into the composer
// to consult its perspective. Presentational only — ThinkPanel owns the data + generation.
import { FiUsers, FiLoader, FiAlertCircle } from "react-icons/fi";
import { C } from "../theme/colors";
import type { VoiceDef } from "../services/voices";

export type VoicesStatus = "idle" | "generating" | "error";

export function ExpertVoicesRail({
  voices,
  status,
  error,
  onMention,
}: {
  voices: VoiceDef[];
  status: VoicesStatus;
  error?: string;
  /** Insert an @mention for this voice into the composer. */
  onMention: (name: string) => void;
}) {
  // Nothing to show until Chief has spun up voices (or is mid-flight / errored).
  if (status === "idle" && voices.length === 0) return null;

  return (
    <div
      style={{
        width: 260,
        borderLeft: `1px solid ${C.deepForest}`,
        background: C.forest,
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
      data-testid="expert-voices-rail"
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: `1px solid ${C.deepForest}`,
          color: C.muted,
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <FiUsers aria-hidden size={13} /> Expert voices
      </div>

      {status === "generating" && (
        <div
          style={{ padding: "10px 12px", color: C.muted, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
        >
          <FiLoader aria-hidden size={13} /> Chief is spinning up expert voices…
        </div>
      )}

      {status === "error" && (
        <div
          style={{ padding: "10px 12px", color: C.sienna ?? C.muted, fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
        >
          <FiAlertCircle aria-hidden size={13} /> {error || "Couldn't spin up voices."}
        </div>
      )}

      {voices.map((v) => (
        <button
          key={v.name}
          type="button"
          onClick={() => onMention(v.name)}
          title={`Mention @${v.name} in your next message`}
          style={{
            textAlign: "left",
            background: "transparent",
            border: "none",
            borderBottom: `1px solid ${C.deepForest}`,
            padding: "10px 12px",
            cursor: "pointer",
            color: C.cream,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: C.accentInk }}>@{v.name}</span>
          {v.oneLiner && <span style={{ fontSize: 11, color: C.muted }}>{v.oneLiner}</span>}
        </button>
      ))}
    </div>
  );
}
