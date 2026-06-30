import { useState } from "react";
import { C, DANGER, FONT_WEIGHT } from "../theme/colors";
import { ModalShell } from "./ModalShell";

/**
 * Shown when a user closes a Build agent that still has UNMERGED work at risk (see
 * engine/closeAgent.shouldPromptOnClose). Offers three lifecycle choices instead of silently
 * dropping the work:
 *   - Ship it    → push the branch + open a PR (so it goes through review) — local merge fallback
 *                  when there's no remote. The recommended, safe action.
 *   - Save for later → keep the branch (backed up to the remote when one exists); remove the
 *                  worktree. Never loses work.
 *   - Discard    → permanently delete the worktree, branch, and bead — behind an explicit confirm.
 * Escape / backdrop / "keep open" = cancel (the non-destructive default).
 */
export function CloseAgentPrompt({
  agentName,
  unsaved,
  onShip,
  onSave,
  onDiscard,
  onCancel,
}: {
  agentName: string;
  unsaved: boolean; // true when there are uncommitted changes (vs only committed-but-unmerged)
  onShip: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const primaryBtn = (label: string, onClick: () => void, color: string) => (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        color,
        border: `1px solid ${color}`,
        borderRadius: 8,
        padding: "9px 18px",
        cursor: "pointer",
        fontSize: 14,
        fontWeight: FONT_WEIGHT.semibold,
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      {label}
    </button>
  );

  const quietLink = (label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        color: C.muted,
        border: "none",
        cursor: "pointer",
        fontSize: 13,
        textDecoration: "underline",
        padding: 0,
        fontFamily: '"IBM Plex Sans", sans-serif',
      }}
    >
      {label}
    </button>
  );

  if (confirmingDiscard) {
    return (
      // Escape/backdrop in the confirm step backs OUT to the choice screen (not a full dismiss), so
      // a stray Escape can't be mistaken for confirming, and we never leave confirm-state stuck.
      <ModalShell width={440} zIndex={200} onCancel={() => setConfirmingDiscard(false)}>
        <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.bold, marginBottom: 8 }}>
          Discard “{agentName}” permanently?
        </div>
        <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
          This deletes the agent’s branch and its tracked task for good. The work is{" "}
          <strong>not</strong> merged anywhere — it cannot be recovered. Choose “Save for later”
          instead if you might want it back.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {primaryBtn("Delete permanently", onDiscard, DANGER)}
          {quietLink("back", () => setConfirmingDiscard(false))}
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell width={460} zIndex={200} onCancel={onCancel}>
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.bold, marginBottom: 8 }}>
        Close “{agentName}” — what about its work?
      </div>
      <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
        {unsaved
          ? "This agent has uncommitted changes that aren’t on main yet. Closing without choosing would lose them."
          : "This agent has committed work that hasn’t landed on main yet. Decide what to do with it."}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {primaryBtn("Ship it", onShip, C.success)}
          <span style={{ color: C.muted, fontSize: 12 }}>push &amp; open a PR for review</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {primaryBtn("Save for later", onSave, C.accent)}
          <span style={{ color: C.muted, fontSize: 12 }}>keep the branch; close the agent</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {primaryBtn("Discard", () => setConfirmingDiscard(true), DANGER)}
          <span style={{ color: C.muted, fontSize: 12 }}>delete the branch &amp; task</span>
        </div>
      </div>
      <div style={{ marginTop: 18 }}>{quietLink("keep it open", onCancel)}</div>
    </ModalShell>
  );
}
