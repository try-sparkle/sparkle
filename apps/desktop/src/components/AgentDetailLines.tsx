import { C } from "../theme/colors";
import { FONT_UI, RADIUS } from "../theme/scale";
import { DetailLine, PathReveal } from "./rowCardPrimitives";
import type { BranchStatus } from "../services/branchStatus";

/** The Location / Status / Progress detail block for ONE agent in the hover card. Shared by the
 *  orchestrator's own detail and each of its inline workers, so the behind/ahead pill logic lives
 *  in exactly one place. `onRefresh` rebases the branch onto its base (red "behind" pill, gated on
 *  `busy`); `onLand` merges it forward (green "ahead" pill). `isWorker` only swaps the green pill's
 *  wording (merge into the worker's orchestrator vs. into the base). */
export function AgentDetailLines({
  worktreePath,
  rootPath,
  bs,
  baseBranch,
  isWorker,
  busy,
  shipped,
  progressPct,
  workerCount,
  onLand,
  onRefresh,
}: {
  worktreePath: string | null;
  rootPath: string;
  bs?: BranchStatus;
  baseBranch: string | null;
  isWorker: boolean;
  busy: boolean;
  shipped?: boolean;
  progressPct: number | null;
  workerCount: number;
  onLand: () => void;
  onRefresh: (e: React.MouseEvent) => void;
}) {
  const behind = bs?.behind ?? 0;
  const ahead = bs?.ahead ?? 0;
  // The pill: RED "-N" when the branch is behind its base (click rebases it — catch YOU up), else
  // GREEN "+N" when it's ahead (click merges it — catch the base up to you). Behind wins when both.
  const showPill = !!bs && (behind > 0 || ahead > 0);
  const pillBehind = behind > 0;
  // Behind is INFORMATIONAL, not an alarm: a branch trailing its base is normal (the base moves) and
  // says nothing about whether the work shipped — so it reads as a calm, muted OUTLINE pill (no red,
  // no fill). Red is reserved for genuine errors. Ahead stays the green actionable "land" pill with
  // the faint `${C.success}22` alpha tint — which is why the green path uses the BRAND-literal hex
  // C.success (a CSS var can't take a hex-alpha suffix); the muted path is a var() and uses no tint.
  const pillInk = pillBehind ? C.muted : C.successInk;
  const baseLabel = baseBranch ?? "main";
  // Shared pill geometry — squared off to roughly match the Land/old action pills (borderRadius 5),
  // not a fully-round chip. The behind/ahead variants layer color + action on top.
  const pillBase: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
    fontFamily: FONT_UI,
    padding: "2px 7px",
    // RADIUS.sm, not a hand-typed 5. theme/scale.test.ts is a ratchet on off-scale values and this
    // pill was one of them; 4 vs 5 is imperceptible at this size, and the migration is the
    // direction the ratchet exists to push.
    borderRadius: RADIUS.sm,
    flex: "0 0 auto",
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
      <DetailLine label="Location">
        <PathReveal path={worktreePath ?? rootPath} />
      </DetailLine>
      <DetailLine label="Status">
        {showPill ? (
          pillBehind ? (
            // BEHIND (red): click rebases this branch onto its base — catches YOU up. Gated on the
            // agent not actively writing (a rebase under a live PTY would race).
            <button
              disabled={busy}
              onClick={onRefresh}
              style={{
                ...pillBase,
                color: pillInk,
                background: "transparent",
                border: `1px solid ${pillInk}`,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy
                ? `Update available · ${behind} behind ${baseLabel} — pause the agent to catch up`
                : `Update available · ${behind} behind ${baseLabel} — click to catch up`}
            </button>
          ) : (
            // AHEAD (green): click merges this branch forward — catches the base up to you.
            <button
              onClick={(e) => {
                e.stopPropagation();
                onLand();
              }}
              style={{
                ...pillBase,
                color: pillInk,
                // TRANSPARENT, like the BEHIND variant above — these are one control in two states
                // and there is no reason for one to be tinted. It carried `${C.success}22`, and the
                // ladder's justification table measured `successInk` on the BARE plane (light
                // 4.552 on `barSurface`) rather than on the stack it is actually composited over.
                // Measured there, the 13.3% green wash took it to 4.127 in light — under the AA
                // floor — while buying 1.103:1 against the card, i.e. nothing anyone can see. The
                // chip reads by its border, which is what the behind variant already relies on.
                background: "transparent",
                border: `1px solid ${pillInk}`,
                cursor: "pointer",
              }}
            >
              {isWorker
                ? `${ahead} ahead. Click to merge into this worker's orchestrator`
                : `${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${baseLabel}. Click to merge`}
            </button>
          )
        ) : (
          <span style={{ color: C.muted, fontSize: 12 }}>Up to date with {baseLabel}</span>
        )}
      </DetailLine>
      {progressPct != null && (
        <DetailLine label="Progress">
          <span style={{ color: C.muted, fontSize: 12 }}>
            {workerCount > 0 ? `${workerCount} worker${workerCount === 1 ? "" : "s"}. ` : ""}
            {progressPct}% complete{workerCount > 0 ? " overall" : ""}.
            {/* The sticky "landed" signal, in WORDS. The ✓ glyph that used to lead it went with the
                one on the progress line — the column says "landed" through its stage sections now,
                and two checkmarks for one fact was the thing being cut. The card is the detail
                surface, so the fact itself stays; it just reads rather than decorates. */}
            {shipped && (
              <span style={{ color: C.successInk, fontWeight: 600 }}> Landed</span>
            )}
          </span>
        </DetailLine>
      )}
    </div>
  );
}
