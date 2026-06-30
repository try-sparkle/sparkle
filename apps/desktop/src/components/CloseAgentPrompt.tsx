import { C, FONT_WEIGHT } from "../theme/colors";
import { ModalShell } from "./ModalShell";

/**
 * Shown when closing an agent that has UNMERGED work (built but not yet on main). Closing must
 * NEVER silently destroy work, so the user explicitly chooses:
 *   - Ship it          → land the work onto main, then clean the agent up (recommended)
 *   - Keep it for later → close the agent but keep the branch (it stays on the Plan board)
 *   - Discard it        → throw the work away (the only destructive path)
 * Escape / backdrop click = "Keep it for later" — the non-destructive default.
 */
export function CloseAgentPrompt({
  onShip,
  onSave,
  onDiscard,
  onCancel,
}: {
  onShip: () => void;
  onSave: () => void;
  onDiscard: () => void;
  /** Escape / backdrop click — a TRUE no-op: just dismiss the prompt, leave the agent untouched.
   *  (Must NOT be wired to a destructive action — that would invert the safety affordance.) */
  onCancel: () => void;
}) {
  return (
    <ModalShell width={470} zIndex={200} onCancel={onCancel}>
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.bold, marginBottom: 8 }}>
        This agent has work that isn't in your app yet
      </div>
      <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
        Ship it to add it to your app, or keep it for later (its committed work stays on the branch).
        Discard stops tracking it. Unsaved edits in the worktree aren't preserved — commit them first
        if you need them.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        {/* Ship it — recommended + productive: land to main, then clean up. Green-stroke. */}
        <button
          onClick={onShip}
          style={{
            background: "transparent",
            color: C.success,
            border: `1px solid ${C.success}`,
            borderRadius: 8,
            padding: "9px 18px",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: FONT_WEIGHT.semibold,
            fontFamily: '"IBM Plex Sans", sans-serif',
          }}
        >
          Ship it
        </button>
        {/* Keep it for later — close the agent but keep the work (non-destructive). */}
        <button
          onClick={onSave}
          style={{
            background: "transparent",
            color: C.cream,
            border: `1px solid ${C.forest}`,
            borderRadius: 8,
            padding: "9px 18px",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: FONT_WEIGHT.semibold,
            fontFamily: '"IBM Plex Sans", sans-serif',
          }}
        >
          Keep it for later
        </button>
        {/* Discard — the only destructive path; quieter, sienna link. */}
        <button
          onClick={onDiscard}
          style={{
            background: "transparent",
            color: C.sienna,
            border: "none",
            cursor: "pointer",
            fontSize: 13,
            textDecoration: "underline",
            padding: 0,
            fontFamily: '"IBM Plex Sans", sans-serif',
          }}
        >
          Discard it
        </button>
      </div>
    </ModalShell>
  );
}
