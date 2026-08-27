// ONE compact line in the concierge pane: "<Sender> just <verb> on <bead-id>: "<preview>"".
//
// The founder watches @improve ↔ @sparkle coordinate here without relaying between them. The bead id
// is a click-target — clicking it opens that bead — so he can jump from the one-liner to the full
// thread. Purely presentational: it takes a built view-model and an `onOpenBead` callback and touches
// no store (the components/Concierge directory rule). The view-model — sender name, verb, truncated
// preview — is built by `crossAgentNotice.buildNotice`, unit-tested apart from any render.
import { C } from "../../theme/colors";
import type { MentionNoticeView } from "./crossAgentNotice";

export interface CrossAgentMentionNoticeProps {
  notice: MentionNoticeView;
  /** Open the bead the notice is about. Wired by the host to the app's bead-open navigation
   *  (`BeadPill.viewOnBoard` — selectProject + openPlanBoard + setBoardFocusBeadId). */
  onOpenBead?: (beadId: string) => void;
}

export function CrossAgentMentionNotice({ notice, onOpenBead }: CrossAgentMentionNoticeProps) {
  return (
    <div
      data-testid="cross-agent-notice"
      data-from={notice.from}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: 4,
        padding: "4px 8px",
        borderLeft: `2px solid ${C.violetInk}`,
        background: C.conciergeSurfaceLifted,
        borderRadius: 4,
        fontSize: 12,
        color: C.muted,
        lineHeight: 1.5,
      }}
    >
      <span data-testid="cross-agent-sentence">
        <span style={{ color: C.cream, fontWeight: 600 }}>{notice.senderName}</span> just{" "}
        <span data-testid="cross-agent-verb">{notice.verb}</span> on{" "}
      </span>
      <button
        type="button"
        data-testid="cross-agent-bead-link"
        data-bead-id={notice.beadId}
        onClick={() => onOpenBead?.(notice.beadId)}
        disabled={!onOpenBead}
        style={{
          padding: "0 4px",
          background: "transparent",
          border: "none",
          color: C.tealInk,
          cursor: onOpenBead ? "pointer" : "default",
          font: "inherit",
          fontWeight: 600,
          textDecoration: "underline",
        }}
      >
        {notice.beadId}
      </button>
      <span data-testid="cross-agent-preview" style={{ color: C.cream }}>
        : “{notice.preview}”
      </span>
    </div>
  );
}
