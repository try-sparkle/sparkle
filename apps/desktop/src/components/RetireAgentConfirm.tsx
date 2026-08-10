import { C, FONT_WEIGHT } from "../theme/colors";
import { RADIUS, FONT_UI, FONT_MONO } from "../theme/scale";
import { ModalShell } from "./ModalShell";
import type { RetroReceipt } from "../engine/retroReceiptTypes";
import { retroStanding, type FeedbackEvidence } from "../engine/retroEvidence";

/**
 * THE HUMAN CONFIRM. Shown when closing a build agent whose work has LANDED
 * (`engine/closeAgent.closeDecision` → `retirement-confirm`).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
 * The founder, verbatim: *"the build agent shouldn't be removed from the build list until I, as the
 * human, confirm that."* Before this, a merged or shipped agent was the ONE population that
 * disappeared on a single click with no prompt of any kind — `shouldPromptOnClose` returned `false`
 * for it and the sidebar read that as permission to tear down.
 *
 * ── IT IS NOT AN ALARM, AND IT IS NOT `CloseAgentPrompt` ─────────────────────────────────────────
 * `CloseAgentPrompt` exists because work could be LOST; its whole job is to make you stop. Nothing
 * is at risk here — the work already landed. This dialog is a confirmation, so it takes the calm
 * ink (`C.accent`), never `DANGER`, and its default action is the affirmative one. The only thing
 * it can cost you is the row, and the row is the thing you asked to remove.
 *
 * ── THE RECEIPT DECIDES WHAT IT SAYS, NEVER WHETHER IT APPEARS ───────────────────────────────────
 * Three shapes, and the difference between them is the honesty of the claim:
 *   • a captured retro → a recommendation, with the retro's own TL;DR quoted
 *   • an excused one   → the agent's reason VERBATIM, plus any contradicting branch measurement
 *   • nothing on file  → a request, not a recommendation; the Pusher is already asking
 * A settled retro does not skip the dialog. That would satisfy the retro half of his ask and drop
 * the half he stated in his own words.
 */

/** The settled lede, ONE SENTENCE PER RECEIPT STATE — keyed on `state`, never on `settled`.
 *
 *  `settled` is `receipt != null` and cannot tell the three apart, so a single sentence written for
 *  `captured` gets printed over the other two (roborev 59891). It said "its feedback is logged",
 *  which for an `excused` receipt is a claim that a bead exists to read when the agent explicitly
 *  reported it filed none — and the same modal then rendered "It gave no retro, and said why:" four
 *  lines below it. A dialog that contradicts itself inside one screen is worse than a vague one.
 *
 *  `excused` is not a corner case to be tidy about: it is the ONLY state with a live production
 *  writer today (`close_agent`'s no-retro arm), so until the PR-marker parse lands it is what almost
 *  every settled row here actually is. */
const SETTLED_LEDE: Record<RetroReceipt["state"], string> = {
  captured: "Its work has landed and its feedback is logged.",
  excused: "Its work has landed, and it recorded why it has no retro to file.",
  overridden: "Its work has landed, and you accepted the gap where its retro would be.",
};

/** …and the sentence for a state this build has never heard of (roborev 59893).
 *
 *  The union is a COMPILE-TIME fact only. `src-tauri/src/retro_receipt.rs` declares `state` as a
 *  `String` deliberately — so a receipt written by a NEWER frontend deserializes here instead of
 *  being silently dropped — and `services/retroReceipts.ts` casts the invoke result without
 *  validating it. So a fourth state can genuinely arrive off disk, index to `undefined`, and render
 *  the settled paragraph with no lede at all: a leading space, then "Retiring removes the row…".
 *
 *  A missing sentence is the worst outcome on this particular surface, because the button under it
 *  is irreversible. This says only what is true of EVERY settled receipt — the same thing the row's
 *  tooltip says, and for the same reason. */
const SETTLED_LEDE_UNKNOWN = "Its work has landed, and its retro step is on file.";

export function RetireAgentConfirm({
  agentName,
  receipt,
  /**
   * Whether this agent filed `agent:<id>` feedback beads — the SECOND source, and the one whose
   * absence produced the contradiction in bead `sparkle-y2p4f`.
   *
   * The receipt store and the beads store are different stores, and only the beads store is written
   * by the real retro pipeline. Without this the dialog told every agent that ever reported that
   * "nothing has been recorded", because no production path writes a `captured` receipt at all.
   *
   * THREE-VALUED ON PURPOSE. `unknown` (a starved or disabled beads store) must not render as an
   * accusation — see `engine/retroEvidence`.
   */
  feedback,
  /** False when the agent is dead, crashed or quota-blocked — see engine/retirementReadiness. */
  canAnswer,
  /**
   * Uncommitted files in this agent's worktree, right now (knightwatch probe 1).
   *
   * The landed arm of `closeDecision` deliberately wins over `bs.dirty` — a landed row must never
   * close silently — but the consequence was that retiring it force-removes the worktree and takes
   * post-merge edits with it, while this dialog said the work had landed and was safe. That is true
   * of the CODE and a lie about the WORKTREE. So retirement is BLOCKED while files are uncommitted:
   * the action here is irreversible, and no confirmation is informed if it does not name what it
   * would destroy.
   */
  dirtyFiles,
  /** `BranchStatus.dirty` — the RAW safety reading, and the one the gate is keyed on. */
  dirty,
  /** `BranchStatus.dirtyCount` — the TRUE total. `dirtyFiles` is capped at 5. */
  dirtyCount,
  onRetire,
  onCancel,
}: {
  agentName: string;
  receipt: RetroReceipt | null | undefined;
  feedback: FeedbackEvidence;
  canAnswer: boolean;
  dirtyFiles?: readonly string[];
  dirty?: boolean;
  dirtyCount?: number;
  onRetire: () => void;
  onCancel: () => void;
}) {
  /** FOUR-WAY, not the old `receipt != null` boolean. `absent` — the only standing that may accuse
   *  the agent or write a permanent gap note — now requires positive evidence that it reported
   *  nothing, rather than merely the absence of a receipt nothing writes. */
  const standing = retroStanding(receipt != null, feedback);
  // `receipt != null`, NOT `standing.kind === "settled"`, even though the two are equivalent by
  // construction (`retroStanding` returns `settled` for exactly this condition). TypeScript cannot
  // narrow `receipt` through the standing's discriminant, so keying the JSX branch on the tag would
  // make `receipt.state` below an error — and casting it away would drop the null check that the
  // `SETTLED_LEDE_UNKNOWN` fallback exists to honour.
  const settled = receipt != null;
  // GATED ON THE SAFETY FIELD, NOT THE DISPLAY PREVIEW (roborev 59423). `dirtyFiles` is capped at
  // STATUS_DIRTY_FILES_CAP and `undefined` means "this build cannot tell you" — NOT "no files".
  // Keying the gate on the preview meant a reading with `dirty: true` and no array restored the
  // retire button and force-removed the worktree: the exact data-loss path probe 1 exists to close.
  const hasUncommitted = dirty === true || (dirtyCount ?? 0) > 0 || (dirtyFiles?.length ?? 0) > 0;
  const namedFiles = dirtyFiles ?? [];
  const unnamedCount = Math.max(0, (dirtyCount ?? namedFiles.length) - namedFiles.length);

  const primaryBtn = (label: string, onClick: () => void, color: string) => (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        color,
        border: `1px solid ${color}`,
        borderRadius: RADIUS.input,
        padding: "9px 18px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: FONT_WEIGHT.semibold,
        fontFamily: FONT_UI,
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
        fontFamily: FONT_UI,
      }}
    >
      {label}
    </button>
  );

  /** The agent's own words, quoted rather than summarized.
   *
   *  VERBATIM IS THE POINT. The human is being asked to judge a claim that no code can verify —
   *  `engine/retroMuster` checks only that the sentence is well-formed — and a paraphrase of a
   *  claim is not the claim. Monospaced and boxed so it reads as quoted evidence rather than as the
   *  app's own voice. */
  const quote = (text: string) => (
    <div
      data-testid="retire-reason-quote"
      style={{
        fontFamily: FONT_MONO,
        fontSize: 12,
        lineHeight: 1.5,
        color: C.cream,
        // The SPEC'S FIELD PAIR, not the shell's planes. `modalChrome.test.ts` ratchets the
        // deepForest+hairline borrow downward and this file is new, so borrowing here would have
        // raised a ceiling whose whole purpose is to fall.
        background: C.inputSurface,
        border: `1px solid ${C.inputEdge}`,
        borderRadius: RADIUS.input,
        padding: "8px 10px",
        margin: "10px 0",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </div>
  );

  return (
    <ModalShell width={470} zIndex={200} onCancel={onCancel}>
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.bold, marginBottom: 8 }}>
        {/* "without its retro?" IS AN ACCUSATION, and it now requires evidence. It used to ride on
            `receipt == null`, which is true of every agent in the fleet because nothing writes a
            `captured` receipt — so it was asked about agents whose own row showed FEEDBACK 7. */}
        {standing.kind === "absent"
          ? `Retire “${agentName}” without its retro?`
          : `Retire “${agentName}”?`}
      </div>

      <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5 }}>
        {settled ? (
          <>
            {SETTLED_LEDE[receipt.state] ?? SETTLED_LEDE_UNKNOWN} Retiring removes the row from your build list; the branch
            and whatever was recorded are kept.
          </>
        ) : standing.kind === "reported" ? (
          /* IT REPORTED. Credit it by COUNT, using the same number the row's pill shows, so the two
             surfaces visibly agree — the founder's complaint was that they did not. What is missing
             here is the app's own bookkeeping, and saying so precisely is the whole fix: the earlier
             copy generalised a missing receipt into "nothing has been recorded about what it
             learned", which was false about the agent and unfair to it. */
          <span data-testid="retire-feedback-credit">
            Its work has landed, and it did report:{" "}
            {standing.count === 1
              ? "1 piece of feedback is"
              : `${standing.count} pieces of feedback are`}{" "}
            on file from it, on your Plan board. The only thing missing is this app’s own retro
            receipt, which the feedback pipeline doesn’t write.
          </span>
        ) : standing.kind === "unknown" ? (
          /* WE COULD NOT LOOK. Distinct from "it reported nothing" — the beads store is shared and
             routinely starved, so this is a normal condition, not an edge. Naming the cause keeps
             the human from reading it as a verdict on the agent. */
          <span data-testid="retire-unknown-note">
            Its work has landed. I can’t tell whether it recorded anything — your backlog isn’t
            readable right now, so I won’t record anything against this agent either.
          </span>
        ) : (
          <>
            Its work has landed, but nothing has been recorded about what it learned.{" "}
            {/* NOT "it's still running" — that asserted liveness from a status that is merely
                UNKNOWN whenever no pane is mounted (roborev 59423). It may be long dead. */}
            {canAnswer
              ? "It may still be reachable, and the Pusher is asking it — leaving this open gives it a chance to answer."
              : "It can’t be asked: this agent is stopped, crashed, or blocked on an account limit."}
          </>
        )}
      </div>

      {receipt?.state === "captured" && receipt.tldr ? quote(receipt.tldr) : null}

      {receipt?.state === "excused" && receipt.reasonText ? (
        <>
          <div style={{ color: C.muted, fontSize: 12, marginTop: 12 }}>
            It gave no retro, and said why:
          </div>
          {quote(receipt.reasonText)}
          {/* DISPLAY, NEVER A GATE. The founder chose well-formedness over git evidence for muster,
              so this measurement does not change the verdict — it is here so that when an agent
              claims "no changes" over three unpushed commits, the person clicking the button can
              see that, rather than the app silently overruling either of them. */}
          {receipt.branchEvidence ? (
            <div data-testid="retire-branch-evidence" style={{ color: C.muted, fontSize: 12 }}>
              Its branch: {receipt.branchEvidence}
            </div>
          ) : null}
        </>
      ) : null}

      {/* UNCOMMITTED FILES BLOCK THE RETIREMENT (knightwatch probe 1). NAMED, not counted: a number
          tells the founder how many things he is about to lose; what he needs in order to decide is
          which ones. `dirtyFiles` is the capped preview `BranchStatus` already carries. */}
      {hasUncommitted ? (
        <div
          data-testid="retire-uncommitted-block"
          style={{ color: C.cream, fontSize: 12, lineHeight: 1.5, marginTop: 12 }}
        >
          Its worktree still holds uncommitted changes, and retiring removes the worktree — so these
          would be lost:
          <div style={{ fontFamily: FONT_MONO, marginTop: 6 }}>
            {namedFiles.map((f) => (
              <div key={f}>{f}</div>
            ))}
            {/* The preview is capped at 5, so without this the founder commits the named files,
                retries, and is blocked again by files the dialog never mentioned. */}
            {unnamedCount > 0 ? <div>+{unnamedCount} more</div> : null}
            {namedFiles.length === 0 ? <div>(this build can’t list them)</div> : null}
          </div>
          Commit or discard them first; the row stays until you do.
        </div>
      ) : null}

      {/* No Plan-board promise here. This used to say the gap is recorded "as a task on your Plan
          board"; nothing in the app creates one, and a dialog that promises a durable artifact
          nobody writes is worse than one that promises nothing (knightwatch probe 8). What IS true
          is the note against the agent, which `confirmRetire` writes and awaits before teardown. */}
      {/* GATED ON THE BUTTON, NOT ON `!canAnswer` AND NOT ON `!settled` ALONE. Two corrections,
          in opposite directions, and the rule underneath them is the same one: this paragraph
          explains what the retire button WRITES, so it must be on screen exactly when that button
          is, never in either gap.

          • It used to also require `!canAnswer`, back when the button itself did — so when the
            override was restored for the reachable case (roborev 59423, which is the NORMAL case:
            an unknown status reads as reachable), the only copy explaining what "record the gap"
            writes was hidden in exactly that case. Button with no explanation.
          • Dropping that left the MIRROR hole (roborev 59545): the button is withheld while the
            worktree is dirty, so an unsettled DIRTY row rendered "Retiring now records a note…"
            directly under "Commit or discard them first; the row stays until you do", with no
            retire control anywhere on the dialog. Explanation with no button — and the only thing
            the human can actually do here is cancel.

          So it is keyed on `!hasUncommitted`, the same expression the primary button is keyed on.
          If a third gate is ever added to that button, add it here in the same commit. */}
      {standing.kind === "absent" && !hasUncommitted ? (
        <div
          data-testid="retire-gap-note"
          style={{ color: C.muted, fontSize: 12, lineHeight: 1.5, marginTop: 12 }}
        >
          Retiring now records a note against this agent saying no retro was on file at the time
          {canAnswer ? ", even if it was about to answer" : ""} — so a pattern of agents leaving
          without reporting becomes visible instead of vanishing with the row.
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 20 }}>
        {/* THE DIALOG ALWAYS HAS A COMPLETION PATH (roborev 59423, reversing my own probe-8 fix).
            Suppressing the retire action on `canAnswer` was wrong twice over:

            `canAnswer` IS NOT A LIVENESS READING. `canAnswerRetroPing(undefined)` returns TRUE by
            design — fail-closed toward ASKING — and `runtimeStore.status` is written by exactly one
            thing, a mounted AgentPane. After a relaunch, or for any project not currently hosted in
            a column, `status[id]` is undefined, so EVERY landed row read as "still being asked" and
            offered nothing but keep-it. Since nothing writes a `captured` receipt yet, that is the
            normal case, not an edge: the row had no way out of the build list at all — and probe 2
            now routes a successful ship straight here.

            And the reason it was hidden no longer exists. The receipt used to assert the agent
            "could not be asked"; the probe-4 commit rewrote it to "no retro receipt on file at the
            time", which is true whether or not the agent was reachable. The false claim the button
            was withheld to avoid is already gone. */}
        {/* THE BUTTON NAMES WHAT IT WRITES, so it may promise a gap only when one may be written.
            Keyed on the SAME `standing.kind === "absent"` as the gap note above and as
            `mayRecordRetroGap` in the engine — if a fourth standing is ever added, all three move
            together or the button offers to record something the writer then declines to record. */}
        {hasUncommitted
          ? null
          : primaryBtn(
              standing.kind === "absent" ? "Retire anyway — record the gap" : "Retire it",
              onRetire,
              C.accent,
            )}
        {quietLink(
          hasUncommitted ? "keep it in the list — it has uncommitted files" : "keep it in the list",
          onCancel,
        )}
      </div>
    </ModalShell>
  );
}
