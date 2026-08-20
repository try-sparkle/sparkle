// Claude Code's PLAN-EXIT prompt — the dialog an agent stops on the moment it finishes writing a
// plan, and the one thing in this subsystem that nothing used to answer:
//
//   Claude has written up a plan and is ready to execute. Would you like to proceed?
//   ❯ 1. Yes, and use auto mode
//     2. Yes, manually approve edits
//     3. Tell Claude what to change
//
// `classifyApproval` refuses it BY CONSTRUCTION — `looksLikePermission` demands a plain "Yes" AND a
// "No", and every affirmative here is a "Yes, and …" continuation. That refusal is correct and
// stays: pressing a continuation blind is the hazard `approvalClassifier.optionText`'s comment
// records. So this ONE question gets its own detector, exactly as the session-resume prompt does.
//
// ── MATCHED BY QUESTION TEXT, NEVER BY OPTION NUMBER ───────────────────────────────────────────
// "1." labels identical menus across completely different questions — which is precisely why
// Sparkle fingerprints pickers rather than trusting ordinals — so the ordinal is READ OFF the
// parsed picker after the question has been recognised, and by LABEL. A reordered menu still
// answers correctly.
//
// ── WHY THIS LIVES HERE AND NOT IN `heuristics` ────────────────────────────────────────────────
// It needs `pickerQuestionBlock`, the ONE definition of "the dialog's own text" that
// `pickerFingerprint` hashes and `conciergeEscalation` sweeps its deny-list over. `pickerFingerprint`
// imports from `heuristics`, so a detector living there could not call it and would have had to
// re-derive the bounds — and a locator that disagrees with the parse it explains is the standing bug
// class in this subsystem (roborev 55166/55172/55195/63621). Sharing the bounds is not a tidiness
// preference; it is what makes the escalation gate in `approvalsRuntime.maybeAutoPlan` read the same
// text the router would have read.
import { parsePickerOptions } from "./heuristics";
import { pickerQuestionBlock } from "../pickerFingerprint";

/** The plan-exit question, tested against a border/whitespace-normalized question block.
 *
 *  The near-miss it must NOT match is Claude Code's OTHER plan question — "Claude has written up a
 *  plan. Would you like to review it as an artifact first?" — which is a different decision (where
 *  to PUT the plan, not whether to run it) and carries no "ready to execute". */
const PLAN_QUESTION = /written\s+up\s+a\s+plan\b.*\bready\s+to\s+execute\b/i;

/** Any affirmative that proceeds in auto mode: "Yes, and use auto mode", "Yes, and switch to auto
 *  mode", "Yes, auto-accept edits". Deliberately matched on "auto mode" / "auto-accept" rather than
 *  on the exact verb — Claude Code has already shipped three phrasings of this one option, and a
 *  regex pinned to today's verb would make the feature go quietly inert on the next rename. The
 *  narrowing that matters is {@link PLAN_STICKY_LABEL} below, which is a difference in WHAT THE
 *  OPTION DOES rather than in how it is worded. */
const PLAN_AUTO_LABEL = /^\s*yes\b.*\bauto[-\s]?(?:mode|accept)\b/i;

/** "Yes, manually approve edits". */
const PLAN_MANUAL_LABEL = /^\s*yes\b.*\bmanually\s+approve\s+edits\b/i;

/** "Yes, set auto mode as my default permission mode" — a STICKIER decision than this one prompt:
 *  it rewrites the session's DEFAULT permission mode, so its effect outlives the plan being
 *  answered. `[approvals].plan` authorises starting THIS plan, not changing the agent's standing
 *  permissions, so this label is excluded from {@link PLAN_AUTO_LABEL}'s match and the prompt is
 *  surfaced instead. */
const PLAN_STICKY_LABEL = /\bdefault\s+permission\s+mode\b/i;

/** Collapse Ink's vertical box borders and hard-wrapping so a question split across two rendered
 *  lines still reads as one sentence. Without this, a narrow pane turns "…ready to │\n│ execute"
 *  into text no word-boundary regex can match, and the prompt silently stops being recognised at
 *  exactly the widths a side-by-side fleet runs at. */
export function normalizePromptText(s: string): string {
  return s.replace(/[│┃|╎┆┊╷╵]/g, " ").replace(/\s+/g, " ").trim();
}

/** An affirmative, by SHAPE rather than wording — "Yes, and use auto mode", "Yes, proceed
 *  automatically", whatever Claude Code calls it next. Used only to corroborate that the plan
 *  question belongs to the picker on screen (see {@link isPlanExitDialog}), never to choose a
 *  keystroke: {@link PLAN_AUTO_LABEL} and {@link PLAN_MANUAL_LABEL} do that, and they have to stay
 *  specific because pressing the wrong affirmative is the whole hazard. */
const PLAN_AFFIRMATIVE_SHAPE = /^\s*yes\b/i;

/** A plain refusal — the ordinary Yes/No permission-prompt shape. The plan-exit dialog has none:
 *  its way out is "Tell Claude what to change". See {@link isPlanExitDialog}. */
const PLAIN_NO_OPTION = /^\s*no\b/i;

/** The LAST `?`-terminated sentence in a normalized block, or the whole block when it has none.
 *
 *  A stale question inherited from the fallback window is always followed by what the agent printed
 *  next and then by the current dialog's own ask, so being present is cheap and being LAST is not.
 *  Taking the final segment is deliberately tolerant of wrapping (the block is already collapsed to
 *  one line) and of prose above that happens to contain a question mark. */
function lastQuestion(normalized: string): string {
  const parts = normalized.split("?");
  // The text after the final "?" is trailing prose, not a question — drop it and take the segment
  // that ENDS at that "?" (re-appended so a caller's regex can still anchor on it if it wants to).
  const idx = parts.length >= 2 ? parts.length - 2 : 0;
  return `${parts[idx] ?? ""}?`;
}

/** The dialog's own text, border- and wrap-normalized, or "" when there is no picker to read. */
function planHeader(scrollback: string): string {
  // `true` for the yes/no half would be the wrong block: this dialog HAS option rows. The block
  // runs question-first and includes them, which is harmless here — an option label cannot contain
  // the question text — and it is the same text `routeUnclassifiedPrompt` sweeps.
  return normalizePromptText(pickerQuestionBlock(scrollback, false));
}

/**
 * Is this screen Claude Code's plan-exit dialog? The QUESTION-level predicate, deliberately
 * separate from {@link detectPlanPrompt}.
 *
 * WHY THE SPLIT. `detectPlanPrompt` is an ANSWERABILITY predicate: it returns null when the question
 * matches but no option label does, because it has no keystroke to offer. That is the right answer
 * for the answer path and the WRONG one for `conciergeEscalation`, which is asking a different
 * question — "is this a plan, so it gets the three-class arm and the mention-vs-decision rule rather
 * than the general five-class sweep?" Keying the router off answerability meant that the one thing
 * {@link PLAN_AUTO_LABEL}'s own doc anticipates — Claude Code renaming this option again, as it has
 * three times — would put a genuine plan-exit dialog back on the general sweep, where `destructive`
 * and `legal` escalate ordinary engineering prose out of the ten lines of plan text the borderless
 * fallback window pulls in. A rename would then reintroduce the exact stall this feature ends.
 *
 * ── IT IS NOT QUESTION-ONLY, AND THAT IS THE OTHER HALF ──────────────────────────────────────
 * The question alone would be unsafe in the opposite direction. For a dialog with no top border,
 * `pickerQuestionBlock` falls back to a fixed window of the ten preceding lines — which, moments
 * after a plan-exit prompt is answered, still contains "…has written up a plan and is ready to
 * execute…". Any borderless picker drawn inside that window would inherit it. The consequence is a
 * SAFETY DOWNGRADE of exactly the kind `conciergeEscalation`'s header warns about ("a false
 * 'concierge' lets an agent press an irreversible button"): the plan arm deliberately does not
 * escalate `destructive` or `legal`, so the roborev-63621 shape — a neutral header over "Force push
 * over origin/main" / "Open a PR instead" — would go to the concierge instead of the founder.
 *
 * So the question is corroborated TWICE, and the first corroboration is the one that matters:
 *
 *   1. THE PLAN QUESTION MUST BE THE DIALOG'S LAST QUESTION. A stale question is by definition
 *      followed by whatever the agent printed next and then by the CURRENT dialog's own ask, so the
 *      final `?`-terminated sentence before the option rows belongs to the picker on screen. That is
 *      what the fallback window cannot fake: it can put an old question INTO the block, but it
 *      cannot make it the last one.
 *   2. …AND THE OPTIONS MUST NOT BE A PERMISSION PROMPT. A plain `No, …` refusal is the ordinary
 *      Yes/No permission shape, which the plan-exit dialog does not have (its way out is "Tell
 *      Claude what to change"). This is defence in depth rather than the primary test — the first
 *      corroboration already excludes it — and it is why a shape-only rule was not enough: "≥1 yes,
 *      ≥1 not-yes" is EXACTLY the bash prompt (`Yes` / `Yes, and don't ask again for rm commands` /
 *      `No, and tell Claude what to do differently`), so the very next thing an agent draws after a
 *      plan is answered would have satisfied it.
 *
 * Both are shape, not wording, so the rename case above still passes. The cost is that the OLDER
 * plan shape whose way out is "No, keep planning" is excluded here — `isPlanModeDialog` still
 * recognises that one in the router by its option triple, which is the predicate written for it.
 */
export function isPlanExitDialog(scrollback: string): boolean {
  const header = planHeader(scrollback);
  if (header.length === 0 || !PLAN_QUESTION.test(header)) return false;
  if (!PLAN_QUESTION.test(lastQuestion(header))) return false;
  const opts = parsePickerOptions(scrollback);
  if (opts.length < 2) return false;
  if (opts.some((o) => PLAIN_NO_OPTION.test(o.label))) return false;
  return opts.some((o) => PLAN_AFFIRMATIVE_SHAPE.test(o.label));
}

/** Detect Claude Code's plan-exit prompt. Returns the keystroke for each affirmative it could find
 *  (either may be null when that option is not on this build's dialog), or null when the screen is
 *  not the plan-exit prompt at all. Ready to `writePty` (e.g. "1\n"). */
export function detectPlanPrompt(
  scrollback: string,
): { autoOption: string | null; manualOption: string | null } | null {
  if (!isPlanExitDialog(scrollback)) return null;
  const opts = parsePickerOptions(scrollback);
  if (opts.length === 0) return null;
  const auto = opts.find((o) => PLAN_AUTO_LABEL.test(o.label) && !PLAN_STICKY_LABEL.test(o.label));
  const manual = opts.find((o) => PLAN_MANUAL_LABEL.test(o.label));
  if (!auto && !manual) return null; // recognised the question but not a single affirmative → bail
  return {
    autoOption: auto ? `${auto.n}\n` : null,
    manualOption: manual ? `${manual.n}\n` : null,
  };
}
