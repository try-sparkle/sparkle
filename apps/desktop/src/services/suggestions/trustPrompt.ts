// Claude Code's FOLDER-TRUST dialog — the one every Sparkle agent meets on its first frame:
//
//   Quick safety check: Is this a project you created or one you trust? (Like your own code,
//   a well-known open source project, or work from your team). If not, take a moment to review
//   what's in this folder first.
//   Claude Code'll be able to read, edit, and execute files here.
//   > 1. Yes, I trust this folder
//     2. No, exit
//
// Every agent spawns into a FRESH git worktree that Claude Code has never seen, so it raises this
// dialog before the agent has run a single tool. The PRIMARY fix is in Rust: the spawn path
// pre-seeds the trust key into the account config, so the dialog never renders. This module is the
// SCREEN-LEVEL BACKSTOP for the two cases that seed cannot cover — it lost a race with the spawn, or
// it is absent (an older config, a hand-launched pane, a worktree created before the seed shipped).
//
// ── MATCHED BY QUESTION TEXT, NEVER BY OPTION NUMBER ───────────────────────────────────────────
// The same rule `planPrompt` documents and for the same reason: "1." labels identical menus across
// completely different questions. The ordinal is READ OFF the parsed picker AFTER the question has
// been recognised, and the option is chosen BY LABEL. A build that reorders the two rows still
// answers correctly; a build that renames the affirmative past {@link TRUST_SAFE_YES_LABEL} answers
// nothing at all, which is the safe direction.
//
// ══ THE SAFETY SCOPE IS THE WHOLE POINT ════════════════════════════════════════════════════════
// This dialog is the ONE prompt in Claude Code whose entire purpose is to ask a human "do you
// actually trust this folder?" — answering that by machine for an arbitrary directory does not
// automate a chore, it DELETES the control. So the auto-answer is scoped to folders SPARKLE ITSELF
// MINTED: `<app data>/worktrees/<project id>/<agent id>`, cut by `worktree.rs::worktree_path` from
// validated ids, for this very agent. A folder the founder opened by hand is never one of those, so
// the genuine "do you trust this?" still reaches him, unanswered.
//
// The scope is enforced by {@link isManagedWorktreePath} over TWO independent facts, and BOTH must
// agree or the answer is refused:
//
//   1. THE AGENT'S OWN RECORDED WORKTREE. `AgentTab.worktreePath` has exactly one writer
//      (`projectStore.setAgentWorktree`), fed the path Rust minted — so it is not a guess, and it is
//      not anything a model said. This is the authority.
//   2. THE PATH THE DIALOG NAMES, when it renders one ({@link workspacePathFromDialog}). It must be
//      the recorded worktree or live under it. A dialog naming somewhere else is a dialog about a
//      DIFFERENT folder than the one we are authorised for, whatever the roster says.
//
// The structural test in (1) is deliberately redundant with the store's provenance rather than
// trusting it: a future writer that puts some other path in that field must not silently widen what
// gets auto-trusted. Redundancy here costs one regex and buys the property that widening the scope
// takes an edit to THIS file.
//
// FAIL CLOSED, ALWAYS. No recorded worktree, a worktree that does not match the managed layout, a
// dialog naming a path we cannot reconcile with it, a path we cannot parse — every one of those
// DECLINES and hands the dialog to the human. "I could not establish the path" is not "the path is
// fine"; treating it as such is the only way this module could ever do harm.
import { parsePickerOptions } from "./heuristics";
import { pickerQuestionBlock } from "../pickerFingerprint";
import { normalizePromptText } from "./planPrompt";

/** The trust question, tested against a border/whitespace-normalized question block.
 *
 *  Two independent clauses, both required. "Quick safety check" is the dialog's own opening and is
 *  what names THIS prompt; the trust clause corroborates it, so a build that reworks the preamble
 *  around the same ask still matches on the half that carries the meaning. */
const TRUST_QUESTION = /\bquick\s+safety\s+check\b/i;
const TRUST_CORROBORATION = /\b(?:trust|trusted)\b/i;

/** An affirmative row of ANY breadth — used only to RECOGNISE the dialog, never to choose a row.
 *
 *  Deliberately loose, and that is the point: {@link isFolderTrustDialog} must recognise the dialog
 *  even when its only affirmative is one we refuse to press, so `maybeAutoTrust` can CLAIM the
 *  screen and decline it. If recognition were as strict as {@link TRUST_SAFE_YES_LABEL}, a
 *  widening-only dialog would fall through to the general answerers — and this screen already
 *  satisfies `approvalClassifier.looksLikePermission` and classifies as `bash` off the word
 *  "execute", so a user with `bash = "always"` would have it auto-pressed for ANY folder. Claiming
 *  is what prevents that.
 *
 *  Loose, but NOT a bare `^yes`: it must still be a yes that says TRUST. An ordinary bash prompt's
 *  rows are a plain "Yes" and "Yes, and don't ask again for rm commands", so a bare `^yes` matches
 *  them — and a bash prompt drawn under a still-visible trust question would then be claimed as this
 *  dialog and taken away from `maybeAutoApprove`, silently breaking `bash = "always"`. That is a
 *  real regression a test in this suite catches; keep the trust clause. */
const TRUST_AFFIRMATIVE_ROW = /^\s*yes\b[^.]*\btrust\b/i;

/** The ONE affirmative that is safe to press: the plain, single-folder answer, whole-label.
 *
 *  ── AN ALLOWLIST, NOT A BLACKLIST — THE POLARITY IS THE SAFETY PROPERTY ──────────────────────
 *  This was a blacklist: "a yes that says trust", minus {@link TRUST_STICKY_LABEL}'s enumerated
 *  widening phrasings. That is the exact shape that already failed once — the enumeration was
 *  complete against the wordings someone thought of, and "…and its subdirectories" was not one of
 *  them, so it passed and would have been auto-pressed. Enumerating harder does not fix a
 *  blacklist; every unlisted future wording ("…and everything under it", "…and remember this
 *  choice", "…trust all its contents") is another silent grant.
 *
 *  The asymmetry decides the polarity. An over-strict affirmative merely SURFACES the dialog to the
 *  human — the module's documented fail-closed direction, and a rename costs one prompt. An
 *  under-strict blacklist SILENTLY grants a standing or recursive trust. So the whole label must be
 *  the plain answer: any extra clause declines by construction rather than by enumeration.
 *
 *  {@link TRUST_STICKY_LABEL} is kept as a secondary belt-and-braces check, not as the guard. */
const TRUST_SAFE_YES_LABEL =
  /^\s*yes[,!]?\s+(?:i\s+)?trust\s+(?:this|the)\s+(?:folder|directory|project)\s*[.!]?\s*$/i;

/** Any option that widens the answer past THIS folder — "…every folder", "…all folders", "…this
 *  directory and its subdirectories", "…don't ask again". A SECONDARY check on top of
 *  {@link TRUST_SAFE_YES_LABEL}'s allowlist — belt-and-braces, no longer the guard itself.
 *
 *  ── IT IS PINNED DIRECTLY, BECAUSE THE ALLOWLIST SHORT-CIRCUITS IT ───────────────────────────
 *  Read this before trusting a green suite here. `TRUST_SAFE_YES_LABEL` anchors with `$` right
 *  after `folder|directory|project`, so NO label can satisfy the allowlist and still contain one of
 *  the branches below — every one of them needs extra tokens the anchor forbids. That makes
 *  `!TRUST_STICKY_LABEL.test(...)` at the call site unreachable in practice, and it means the
 *  `detectTrustPrompt` refusal cases say NOTHING about this alternation: they would all stay green
 *  with this constant deleted outright.
 *
 *  So it is exported and asserted DIRECTLY, phrasing by phrasing, in `trustPrompt.test.ts`. That is
 *  the only thing keeping it honest, and it matters because this layer becomes load-bearing again
 *  the moment someone loosens the allowlist to accept a renamed upstream label (say
 *  "Yes, I trust this folder (recommended)"). Without direct assertions it could rot unnoticed for
 *  an unbounded period and be silently useless at exactly that moment.
 *
 *  Add the branch AND its direct assertion together when a new wording appears. */
export const TRUST_STICKY_LABEL =
  /\b(?:every|all)\s+folders?\b|\bdon['’]?t\s+ask\s+again\b|\balways\s+trust\b|\bsub-?director(?:y|ies)\b|\brecursive(?:ly)?\b|\bparent\s+director(?:y|ies)\b|\ball\s+(?:its\s+)?(?:sub)?directories\b/i;

/** The refusal — "No, exit". Only used to corroborate that a two-row trust menu is on screen. */
const TRUST_NO_LABEL = /^\s*no\b/i;

/**
 * Is this screen Claude Code's folder-trust dialog? The QUESTION-level predicate, deliberately
 * separate from {@link detectTrustPrompt} for the same reason `planPrompt` splits its pair:
 * `detectTrustPrompt` is an ANSWERABILITY predicate and returns null when the question matches but
 * no label does, and a caller asking "is this the trust dialog at all?" — which is what decides
 * whether the screen may be handed to a general answerer — must not get "no" from a rename.
 *
 * ── WHY THAT DISTINCTION IS LOAD-BEARING HERE AND NOT MERELY TIDY ─────────────────────────────
 * This dialog ALREADY satisfies `approvalClassifier.looksLikePermission`: "Yes, I trust this folder"
 * is a plain yes (no `YES_CONTINUATION` word in it) and "No, exit" is a plain no. Its body — "read,
 * edit, and execute files here" — then classifies as `bash` off the word "execute". So a user with
 * `bash = "always"` had this dialog auto-pressed for ANY folder, and one with no rule had it handed
 * to the concierge. Recognising the dialog is therefore what lets `maybeAutoTrust` CLAIM it, in both
 * directions: it answers the in-scope case, and it takes the out-of-scope case away from the general
 * answerers so the founder gets the question the dialog exists to ask.
 */
export function isFolderTrustDialog(scrollback: string): boolean {
  const header = normalizePromptText(pickerQuestionBlock(scrollback, false));
  if (header.length === 0) return false;
  if (!TRUST_QUESTION.test(header) || !TRUST_CORROBORATION.test(header)) return false;
  const opts = parsePickerOptions(scrollback);
  if (opts.length < 2) return false;
  // A trust menu is an affirmative and a way out. Requiring both is what stops an ordinary picker
  // drawn while the trust question is still inside `pickerQuestionBlock`'s ten-line borderless
  // fallback window from being read as this dialog.
  return opts.some((o) => TRUST_AFFIRMATIVE_ROW.test(o.label)) && opts.some((o) => TRUST_NO_LABEL.test(o.label));
}

/**
 * Detect Claude Code's folder-trust prompt. Returns the keystroke for the trust affirmative (ready
 * to `writePty`, e.g. "1\n") plus the workspace path the dialog named, if any — or null when this is
 * not the trust dialog, or when it is but carries no affirmative this build recognises.
 *
 * SECURITY: `workspacePath` is REPORTED, never trusted. It is text scraped off a terminal; the
 * caller reconciles it against the agent's recorded worktree ({@link isManagedWorktreePath}) and
 * declines when the two disagree.
 */
export function detectTrustPrompt(
  scrollback: string,
): { trustOption: string; workspacePath: string | null } | null {
  if (!isFolderTrustDialog(scrollback)) return null;
  const opts = parsePickerOptions(scrollback);
  const yes = opts.find((o) => TRUST_SAFE_YES_LABEL.test(o.label) && !TRUST_STICKY_LABEL.test(o.label));
  if (!yes) return null; // recognised the question, but the only affirmative widens past this folder
  return { trustOption: `${yes.n}\n`, workspacePath: workspacePathFromDialog(scrollback) };
}

/** A WHOLE LINE that is nothing but an absolute path — POSIX (`/a/b`) or Windows (`C:\\a\\b`), with
 *  at least two separators so a bare root cannot qualify.
 *
 *  ANCHORED TO THE LINE, and that is not a stylistic choice. Sparkle's own app-data dir on macOS is
 *  `~/Library/Application Support/ai.sparkle.desktop` — IT CONTAINS A SPACE — so a token-scanning
 *  regex run over the collapsed question text stops at "Application" and reports a path that is not
 *  the one on screen. Since the reported path is then required to CONTAIN the agent's worktree, a
 *  truncated read fails the containment test and silently declines the very case this backstop
 *  exists for. The dialog prints the folder on a line of its own, so the line is the unit that can
 *  be read unambiguously. */
const ABSOLUTE_PATH_LINE =
  /^(?:(?:\/[^/\n]+){2,}\/?|[A-Za-z]:(?:[\\/][^\\/\n]+){2,}[\\/]?)$/;

/** Ink's vertical box borders, stripped per line so a bordered dialog's path line still reads as a
 *  bare path. Deliberately NOT `normalizePromptText`, which collapses the block to ONE line and is
 *  exactly what makes a space-bearing path unreadable (see {@link ABSOLUTE_PATH_LINE}). */
function unborder(line: string): string {
  return line.replace(/[\u2502\u2503|\u254e\u2506\u250a\u2577\u2575]/g, " ").trim();
}

/**
 * The workspace path the trust dialog names, or null when it names none.
 *
 * Claude Code has shipped this dialog both with and without the folder path printed under the
 * question, so ABSENCE IS NORMAL and is not itself a reason to decline — the agent's recorded
 * worktree is the authority either way. What a present path buys is the second, independent check:
 * a dialog about a folder OTHER than the one we are authorised for is refused even when the roster
 * says this agent owns a managed worktree.
 *
 * MORE THAN ONE path line is treated as NONE. Two candidates mean the block is not the shape this
 * reader understands, and picking one of them would be a guess feeding a security gate.
 */
export function workspacePathFromDialog(scrollback: string): string | null {
  const found = pickerQuestionBlock(scrollback, false)
    .split("\n")
    .map(unborder)
    .filter((l) => ABSOLUTE_PATH_LINE.test(l));
  return found.length === 1 ? (found[0] as string) : null;
}

/** Separator- and trailing-slash-normalized, so a Windows path and a POSIX one compare by the same
 *  rules. Case is preserved deliberately: two paths differing only in case are two paths as far as
 *  this gate is concerned, which is the conservative reading on every platform. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Is `child` the same directory as `parent`, or inside it? Boundary-aware, so `/a/worktrees/p/ag`
 *  does NOT contain `/a/worktrees/p/agent-2` — a plain `startsWith` would say it does. */
function isSameOrUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (p.length === 0) return false;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Is `worktreePath` a folder SPARKLE MINTED FOR `agentId`, and therefore one this app may answer the
 * trust dialog for without asking a human?
 *
 * The shape is `worktree.rs::worktree_path`'s output verbatim: `<app data>/worktrees/<project
 * id>/<agent id>`. Three things are checked, and all three must hold:
 *
 *   • it is ABSOLUTE — a relative path names nothing we can reason about;
 *   • it has a `worktrees` segment with EXACTLY TWO segments beneath it — so a folder that merely
 *     happens to live somewhere under a directory called `worktrees` (a user's own repo checked out
 *     at `~/worktrees/mine`, the repo-local `.claude/worktrees/<name>` scratch dirs this codebase
 *     also uses) is refused;
 *   • the LAST segment is THIS AGENT'S ID — so even another agent's managed worktree is out of
 *     scope. That is not paranoia about a peer: it is what makes the check a statement about the
 *     screen in front of us rather than about the folder layout in general.
 *
 * The app-data prefix is deliberately NOT asserted: the renderer cannot resolve it without an async
 * Tauri round-trip, and a check that has to be awaited inside a synchronous answerer would either be
 * skipped or cached wrongly. The provenance of the value carries that half — see this module's
 * header — and the agent-id tail is what makes the structural half specific rather than generic.
 */
export function isManagedWorktreePath(worktreePath: string | null | undefined, agentId: string): boolean {
  if (!worktreePath || !agentId) return false;
  const p = normalizePath(worktreePath);
  const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  if (!absolute) return false;
  const segs = p.split("/").filter((s) => s.length > 0);
  // A `..` anywhere means the textual segments do not describe where the path actually points, so
  // no segment test below can be trusted. Refuse rather than resolve — resolution is the filesystem's
  // job and this module has no filesystem.
  if (segs.includes("..")) return false;
  const i = segs.lastIndexOf("worktrees");
  if (i < 0) return false;
  if (segs.length - i !== 3) return false; // worktrees / <project id> / <agent id>
  return segs[segs.length - 1] === agentId;
}

/**
 * The full safety decision: may this app answer the folder-trust dialog on `scrollback` for
 * `agentId`, given the worktree the project store has recorded for it?
 *
 * Returns the keystroke to press, or null to DECLINE — and every uncertain path returns null. Kept
 * here beside the rules it enforces, rather than in `approvalsRuntime`, so the safety property is
 * testable as a pure function of (screen, agent id, recorded path) with no stores to seed.
 */
export function trustAnswerFor(
  scrollback: string,
  agentId: string,
  worktreePath: string | null | undefined,
): string | null {
  const detected = detectTrustPrompt(scrollback);
  if (!detected) return null;
  if (!isManagedWorktreePath(worktreePath, agentId)) return null;
  // A dialog that names a path must name THIS worktree (or something inside it). One that names no
  // path is answered on the recorded worktree alone — see `workspacePathFromDialog`.
  if (detected.workspacePath && !isSameOrUnder(detected.workspacePath, worktreePath as string)) return null;
  return detected.trustOption;
}
