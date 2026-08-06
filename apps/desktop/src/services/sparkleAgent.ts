// The Sparkle self-improvement agent — a singleton, app-owned special agent pinned to the
// bottom-left of the Agents Bar. Unlike normal agents (which work in the user's project), it
// works on Sparkle ITSELF: reviewing the user's session logs, drafting specs, and opening PRs
// to the open-source Sparkle client. Its workspace is an app-owned clone of the OSS repo (see
// src-tauri/src/sparkle_agent.rs), completely separate from any user project.
import { invoke } from "@tauri-apps/api/core";
import type { SparkleImprovementConsent } from "../stores/settingsStore";
import { retroEmissionProtocol } from "./buildAgent";

/** The CANONICAL reserved agent id — the main window's Sparkle instance and the hourly headless
 *  improvement pass both use it, so they share one worktree (preserving the "one claude per
 *  worktree" mutual-exclusion invariant). Lives in the same runtime maps (status/openAgentIds) as
 *  normal agents but is never part of any project's `agents` array — the double-underscore
 *  namespace keeps it from ever colliding with a real UUID. */
export const SPARKLE_AGENT_ID = "__sparkle_self__";
/** THE MENTION HANDLE — what a human types after `@` to address this agent, and what the mounted
 *  pane's chip falls back to. Deliberately the short form; see Concierge/mentions. */
export const SPARKLE_AGENT_NAME = "Sparkle";
/** WHAT THE ROW ON SCREEN CALLS ITSELF, and therefore what any surface NAMING this agent to a human
 *  or to a model must use — the sidebar row, and `get_state`'s roster.
 *
 *  It is a constant rather than the string literal it replaces because the roster and the screen
 *  naming one id two different things is a bug this repo has already paid for once: see the header
 *  of engine/agentDisplayName for the pair that sent a user chasing a bug that did not exist. The
 *  row said "Improve Sparkle" while every programmatic surface said `SPARKLE_AGENT_NAME`, so listing
 *  the agent in `get_state` (bead sparkle-x0pvw) would have introduced exactly that split — the
 *  founder asks for "Improve Sparkle" and the roster would have answered "Sparkle". */
export const SPARKLE_AGENT_DISPLAY_NAME = "Improve Sparkle";
/** Synthetic project id used only to namespace this agent's worktree under app-data. */
export const SPARKLE_PROJECT_ID = "sparkle-self";

/** Per-window Sparkle agent id. Improve Sparkle is no longer a global singleton: each window runs
 *  its own independent copy (own worktree + `sparkle/agent-<id>` branch + conversation, all cut
 *  from the single app-owned OSS clone). The MAIN window keeps the canonical id so its interactive
 *  pane still shares a worktree with the hourly background pass; every secondary window
 *  (`win-<uuid>`) gets a distinct id and thus a distinct, isolated worktree.
 *
 *  The result must satisfy the Rust worktree `validate_id` allowlist (`[A-Za-z0-9_-]`, ≤128 chars)
 *  since it is joined into a path and a branch name — window labels ("main" / "win-<uuid>") and the
 *  canonical id already do, and joining them with a single `-` keeps every byte in the allowlist. */
export function sparkleAgentIdFor(windowLabel: string): string {
  return windowLabel === "main" ? SPARKLE_AGENT_ID : `${SPARKLE_AGENT_ID}-${windowLabel}`;
}

/** True for any id in the app-owned Sparkle namespace (canonical or per-window). */
export function isSparkleAgentId(id: string): boolean {
  return id === SPARKLE_AGENT_ID || id.startsWith(`${SPARKLE_AGENT_ID}-`);
}

/** Which Sparkle-namespace ids a window's boot reconcile must keep in the SHARED (cross-window)
 *  `openAgentIds` set. `reconcile()` is a non-merging whole-array filter, so anything not returned
 *  here is dropped from the persisted set for every window.
 *
 *  - Main window: it boots at cold start as the ONLY live window (multi-window session restore is
 *    deferred, bead ), so any `__sparkle_self__-win-*` id lingering from a previous
 *    session is DEAD — keep only its own (canonical) id and let the rest be pruned. This stops the
 *    persisted set from growing unboundedly with per-window ids across sessions (the JS-side mirror
 *    of the Rust worktree reaper).
 *  - Secondary window: it boots mid-session while the main window (and other secondaries) may be
 *    live, so it must PRESERVE every open Sparkle id — dropping another window's live id would
 *    unmount its pane and kill its PTY. */
export function sparkleOpenSetWhitelist(opts: {
  isMainWindow: boolean;
  ownId: string;
  openIds: string[];
}): string[] {
  const { isMainWindow, ownId, openIds } = opts;
  if (isMainWindow) return [ownId];
  return [...new Set([ownId, ...openIds.filter(isSparkleAgentId)])];
}

/** Everything the launch-warm decision weighs. Plain data so the gate is unit-testable. */
export interface LaunchWarmGate {
  consent: SparkleImprovementConsent;
  /** settingsStore.improvementLaunchWarm — null = the user has not been asked/answered yet. */
  optIn: boolean | null;
  /** Warming spawns a real `claude` in the canonical worktree, so only the MAIN window may do it:
   *  a secondary window would cold-start its own copy nobody asked for, and the canonical worktree
   *  admits one claude at a time. */
  isMainWindow: boolean;
}

/** Should this window mount (hidden) and spawn the Improve Sparkle pane at app launch, so the agent
 *  is already working when the user opens its row rather than cold-starting on the click?
 *
 *  Consent decides whether we may do this WITHOUT asking:
 *   - "always"       → yes. The user granted standing authority to spend a little of their
 *                      subscription on improving Sparkle; making them click first adds nothing.
 *   - "case_by_case" → only on an explicit opt-in (`optIn === true`). This mode means "ask me", so
 *                      the first pass must be something the user turned on, not something that
 *                      greeted them. `null` (never answered) is an opt-OUT.
 *   - "never"        → never. No evaluation of any kind runs in this mode. */
export function shouldWarmSparkleAtLaunch(gate: LaunchWarmGate): boolean {
  if (!gate.isMainWindow) return false;
  if (gate.consent === "never") return false;
  if (gate.consent === "always") return true;
  return gate.optIn === true;
}

export interface SparkleWorkspace {
  /** App-owned clone of the OSS Sparkle repo — the agent's worktree is cut from this. */
  repoPath: string;
  /** App log dir, passed to the agent (via --add-dir) so it can review user sessions. */
  logDir: string;
  /** The clone's default branch (from origin/HEAD) — cut the worktree from this, not a guess. */
  defaultBranch: string;
}

/** Ensure the app-owned clone of the open-source Sparkle repo exists (cloning once if needed)
 *  and return its path plus the log dir. Idempotent. */
export function ensureSparkleRepo(): Promise<SparkleWorkspace> {
  return invoke<SparkleWorkspace>("ensure_sparkle_repo");
}

/** Whether this machine can actually submit the agent's work upstream. Mirrors `SubmitVerdict` in
 *  src-tauri/src/sparkle_agent.rs — see that enum for what each verdict means and why "unknown"
 *  must behave like "assume we can". */
export type SubmitVerdict =
  | "canSubmit"
  | "noPush"
  | "notAuthenticated"
  | "ghMissing"
  | "unknown";

export interface SubmitCapability {
  verdict: SubmitVerdict;
  /** `owner/repo` the verdict is about. */
  repo: string;
}

/** Probe whether the agent's work can be submitted upstream from this machine (one `gh api` call).
 *  Deliberately re-asked per pass / per pane-open rather than cached for the session: a user who
 *  runs `gh auth login` and reopens the pane must not stay stuck on a stale "you're signed out". */
export function checkSubmitCapability(): Promise<SubmitCapability> {
  return invoke<SubmitCapability>("sparkle_submit_capability");
}

/** True when the agent must NOT attempt to push or open a PR. "unknown" is deliberately excluded:
 *  a transient network failure must never downgrade a maintainer's agent to propose-only. */
export function isSubmitBlocked(verdict: SubmitVerdict): boolean {
  return verdict === "noPush" || verdict === "notAuthenticated" || verdict === "ghMissing";
}

/** One line of user-facing explanation per blocked verdict, plus the way out. Pure + exported so
 *  the UI and the persona say the SAME thing — a user told "you're read-only" by the pane and
 *  "run gh auth login" by the agent would rightly not trust either. */
export function submitBlockedReason(verdict: SubmitVerdict, repo: string): string | null {
  switch (verdict) {
    case "noPush":
      return `This machine's GitHub account doesn't have write access to ${repo}, so improvements can't be submitted as pull requests from here. They'll be prepared and saved locally instead.`;
    case "notAuthenticated":
      return `GitHub CLI isn't signed in, so improvements can't be submitted as pull requests. Run \`gh auth login\` to enable submission; until then they'll be prepared and saved locally.`;
    case "ghMissing":
      return `GitHub CLI (\`gh\`) isn't installed, so improvements can't be submitted as pull requests. Install it to enable submission; until then they'll be prepared and saved locally.`;
    default:
      return null;
  }
}

/** The persona section that turns the agent propose-only. Empty when submission is available. */
/** `notAuthenticated` and `ghMissing` are blocked-but-FIXABLE, and the person who can fix them in
 *  one command may be sitting in the chat. Treating every blocked verdict as immutable is how an
 *  attended session ends up doing a full pass and reporting the PR unsubmittable without ever
 *  asking — the same giving-up this file's auth advice exists to prevent, one layer down. `noPush`
 *  is genuinely immutable (the account lacks write access), so it keeps the flat wording. */
function fixableWithTheUserPresent(verdict: SubmitVerdict): boolean {
  return verdict === "notAuthenticated" || verdict === "ghMissing";
}

/** The command prohibition each arm of the blocked section carries, exported so BOTH can be
 *  asserted. This bullet is the whole reason the permissive askable arm was considered safe — it is
 *  what keeps an agent from hammering `gh pr create` against a machine already known to be
 *  unauthenticated — and it was pinned on the final arm only, by a fragment (`"Do NOT run"`,
 *  capital D) the askable arm's rewritten wording does not even match. Deleting the askable bullet
 *  outright therefore left every suite green. Two constants, not one, because the arms must
 *  discriminate: neither string is a substring of the other. */
export const ASKABLE_COMMAND_PROHIBITION = "- Until then, do NOT run `gh pr create`";
export const FINAL_COMMAND_PROHIBITION = "- Do NOT run `gh pr create`";

/** The exit both attended retry arms must name. The `always` arm named two exits ("if they decline,
 *  OR IT STILL FAILS"); the `case_by_case`/`never` arm named only one — and `case_by_case` is
 *  DEFAULT_SPARKLE_CONSENT, so the most common attended configuration was precisely the one where
 *  "the user logged in and the submission still failed" had no stated terminal action. That is the
 *  dead-end shape this file exists to remove, so the clause is shared and asserted on both arms. */
export const RETRY_STILL_FAILS_EXIT = "If they decline, or it still fails,";

/** Openers of the propose-only tail — the fix for a contradiction that defeated the askable arm.
 *  The permissive arm ends with "ask them to log in, then submit once more", and the tail that
 *  followed it began, unconditionally and at the same list level, "- Work PROPOSE-ONLY instead: …
 *  and stop there." Models weight the later, flatter instruction, so the attended path read as
 *  "ask, then stop anyway" — the exact failure this branch exists to prevent. The tail is now
 *  CONDITIONAL on the askable arm and unconditional only where nothing the user does can help.
 *  Neither constant contains the other (`- Work` vs `, work`), so a test on one cannot be satisfied
 *  by the other arm of the same persona. */
export const PROPOSE_ONLY_UNCONDITIONAL = "- Work PROPOSE-ONLY instead:";
/** Worded as a DEFAULT ("unless and until"), not as a third condition. The first draft of this fix
 *  read "- If they decline, or the retry still fails, work PROPOSE-ONLY instead:", which enumerated
 *  the two ways the ask can end BADLY and thereby dropped the one where it does not end at all: the
 *  user is asked, says nothing (or answers about something else, or the pane is closed), and the
 *  prompt no longer states what to do. The flat tail this replaced covered that path by accident,
 *  being unconditional. Enumerating conditions moved the sit-and-wait dead end from "declined" to
 *  "unanswered" rather than removing it — so the fallback is the default and confirmation is what
 *  lifts it, which leaves no third case to forget. See GH_ASK_NO_ANSWER for the explicit form. */
export const PROPOSE_ONLY_AFTER_ASKING =
  "- Unless and until they confirm AND the submission then succeeds, work PROPOSE-ONLY:";

/** The unanswered case, said out loud as well as implied by the default above. An agent that has
 *  asked a question tends to treat answering it as a precondition for finishing; this is the line
 *  that says a finished pass does not wait on a reply that may never come.
 *
 *  Carries the ACTION and ends at a sentence boundary, per the contract documented for the decline
 *  constants below. The first draft stopped at "…have not replied by the" — pinning the prohibition
 *  and leaving "say you asked and got no reply, and take the propose-only path" anchored by nothing,
 *  which is the plausible edit (trim the instruction, keep the framing) those constants exist to
 *  catch. Splitting mid-sentence also lets an edit to the continuation produce a grammatically
 *  broken prompt line that no assertion can see. */
export const GH_ASK_NO_ANSWER =
  "- Do not sit waiting on an answer. If they have not replied by the time your work is ready, say in your summary that you asked and got no reply, and take the propose-only path below.";

/** The `setup-git` remedy, inlined into the askable arm. `notAuthenticated` sets `blocked`, which
 *  suppresses `ghAuthAdvice` at all three `whatYouDo` call sites — and that block was the ONLY
 *  place carrying "logged in but the push still fails on credentials: run `gh auth setup-git`".
 *  The askable arm also drops `gh auth setup-git` from its prohibition list, so the command was
 *  permitted but never prescribed: attended session, user runs `gh auth login`, git has no
 *  credential helper, the retry this arm newly authorizes fails, and the one instruction that
 *  fixes it appeared nowhere in the prompt. It is worth exactly one attempt, and only AFTER the
 *  login lands — before that it exits 1 with "You are not logged into any GitHub hosts". */
export const GH_SETUP_GIT_AFTER_LOGIN =
  "- If they confirm the login and the push STILL fails on credentials, run `gh auth setup-git`";

/** The beads label the auto-feedback-on-merge loop writes into and the Improvement Agent drains.
 *  A merged worker's structured retro (docs/schemas/worker-retro.schema.json) is forwarded — one
 *  pain point per bead — by the capture hook onto this label; the persona below tells the agent to
 *  empty that inbox before it mines any logs. Exported so the persona and its tests name the SAME
 *  string, and so the one canonical label lives in code rather than being retyped. */
export const AGENT_FEEDBACK_LABEL = "agent-feedback";

/** Header of the agent-feedback drain section. Exported (like the auth-advice headers above) so
 *  tests assert its PRESENCE/ABSENCE structurally — a `toContain` on the header survives a reword
 *  of the body, and its absence in the "never" (chat-only) arm is asserted the same way. */
export const AGENT_FEEDBACK_DRAIN_HEADER =
  "AGENT-FEEDBACK INBOX — DRAIN THIS FIRST, BEFORE LOG-MINING";

/** The one-line step, injected into each log-mining whatYouDo arm, that points at the drain
 *  section. Exported so the test can prove the arms REFERENCE the section (not just that the
 *  section exists somewhere in the prompt) and that it is ordered ahead of the log-review step. */
export const AGENT_FEEDBACK_DRAIN_STEP =
  "FIRST drain the agent-feedback inbox (see the AGENT-FEEDBACK INBOX section below) — file new " +
  "beads, enrich/bump recurring ones, and fix the highest-value item — before mining any logs.";

function submitBlockedSection(
  verdict: SubmitVerdict,
  attended: boolean,
  consent: SparkleImprovementConsent,
): string[] {
  if (!isSubmitBlocked(verdict)) return [];
  const askable = attended && fixableWithTheUserPresent(verdict);
  // This block is emitted AFTER the consent-mode instructions and claims to override them, so
  // anything PERMISSIVE in here has to restate the limits it isn't overriding. Consent governs
  // whether a PR may be opened without a per-PR go-ahead; clearing an auth block does not change
  // that, and a user saying "ok, I'm logged in" is not approval of a pull request.
  // Both arms must name BOTH exits — declined, and tried-but-still-failed. See
  // RETRY_STILL_FAILS_EXIT for why the second one going missing on the DEFAULT consent mode was the
  // dead end this file exists to remove.
  const retryLines =
    consent === "always"
      ? [
          "  If they confirm they have done it, try the submission once more rather than treating the",
          `  verdict as final — it was measured before they acted. ${RETRY_STILL_FAILS_EXIT}`,
          "  fall back to the propose-only flow below and say why.",
        ]
      : [
          "  If they confirm they have done it, redo the PII SCRUB GATE and PRESENT the PR draft for",
          "  their explicit approval as your consent mode requires, and submit only if they say so —",
          `  logging in is not approval of a PR. ${RETRY_STILL_FAILS_EXIT} fall back to the`,
          "  propose-only flow below and say why.",
        ];
  return [
    "SUBMISSION IS NOT AVAILABLE ON THIS MACHINE — THIS OVERRIDES ANY INSTRUCTION ABOVE",
    ...(askable
      ? [
          "- This machine cannot open pull requests right now: " +
            (verdict === "ghMissing"
              ? "the GitHub CLI is not installed."
              : "the GitHub CLI is installed but not logged in."),
          "  That was checked before your session started, but the user IS here and can fix it.",
          ...(verdict === "ghMissing"
            ? [
                "  Say what is blocking submission and ask them to install the GitHub CLI (on macOS,",
                "  `brew install gh`; otherwise their platform's package manager) and then run",
                "  `gh auth login` IN THEIR TERMINAL — that login is interactive, so you cannot complete",
                "  it yourself even once gh exists.",
              ]
            : [
                "  Say what is blocking submission and ask them to run `gh auth login` IN THEIR TERMINAL",
                "  — it is interactive, so running it yourself just hangs your shell until the tool times",
                "  out.",
              ]),
          ...retryLines,
          `${GH_SETUP_GIT_AFTER_LOGIN} once and`,
          "  retry: it registers gh as git's credential helper, nothing more.",
          "  It works only after their login has landed — before that it exits 1 — so it is worth",
          "  exactly one attempt there, and none before.",
          GH_ASK_NO_ANSWER,
          "  An unanswered question is not a reason to hold a finished pass.",
          `${ASKABLE_COMMAND_PROHIBITION}, \`gh pr edit\`, \`git push\`, \`gh repo fork\`, or`,
          "  `gh auth login` YOURSELF: the first four fail without credentials, and `gh auth login` is",
          "  an interactive prompt only the user can answer.",
        ]
      : [
          "- This machine cannot open pull requests against the upstream repo (no write access, or no",
          "  usable GitHub CLI credentials). This was checked before your session started; it is a fact",
          "  about the environment, not something you can retry your way past.",
          `${FINAL_COMMAND_PROHIBITION}, \`gh pr edit\`, \`git push\`, \`gh auth login\`, \`gh auth setup-git\`,`,
          "  or `gh repo fork`. They will fail, and repeatedly retrying them wastes the whole pass.",
        ]),
    // CONDITIONAL on the askable arm: an unconditional "stop there" immediately after "ask them to
    // log in, then submit once more" is read as the later, flatter instruction and cancels the ask.
    askable ? PROPOSE_ONLY_AFTER_ASKING : PROPOSE_ONLY_UNCONDITIONAL,
    "  do the full job — investigate, spec, implement, and then COMMIT to a local branch — and stop",
    "  there. Your final message is the deliverable: state the branch name, what changed and why, and",
    "  the exact PR title + body you would have submitted (still scrubbed: the PII rules below apply",
    "  in full — the user may submit this text themselves).",
    "- The DEDUPE GATE below still applies, but `gh pr list` needs the same credentials you don't",
    "  have. If it fails, say so in your summary and dedupe against the local git history instead",
    "  (`git log --oneline origin/main -100`) rather than skipping the check silently.",
    "- Do not treat this as an error state or a reason to do nothing. A committed branch plus a",
    "  clear write-up is a complete, successful pass.",
    "",
  ];
}

/** Header line of the auth-advice block. Exported so tests can assert on its PRESENCE/ABSENCE
 *  structurally — a `not.toContain` on a prose fragment passes vacuously the moment someone
 *  rewords the line, while the contradiction it guards against quietly returns. */
export const GH_AUTH_ADVICE_HEADER = "If a push or `gh pr create` fails on auth, first check `gh auth status`:";

/** First line of each attendance branch, exported for the same reason as the header: a test that
 *  scans the whole persona for a prose fragment passes (or fails) for reasons unrelated to the
 *  branch it names — several of these sentences legitimately appear on both sides. */
export const GH_AUTH_ASK_USER = "ASK the user to run `gh auth login` in their terminal";
export const GH_AUTH_UNATTENDED_STOP = "report that the PR could not be submitted because gh needs";
// The two attended arms' decline fallbacks. Both obey the same contract, learned the hard way twice
// on this branch:
//   - Each is the ACTION, not the sentence explaining it, and is emitted as ONE array element. An
//     anchor on the rationale survives the plausible edit (trim the instruction, keep the excuse),
//     which leaves the behavior gone and the suite green.
//   - Each is worded so its SIBLING cannot satisfy it ("to log in" vs "to install it"). They were
//     once near-identical, and the shorter was a strict prefix of the longer, so one arm's
//     assertion was being satisfied by the other arm of the same persona.
//   - The terminating period lives INSIDE the constant, so no call site has to remember to append
//     it — a later edit that moved it in would otherwise produce a silent ".." that `toContain`
//     cannot see.

/** Attended NOT-LOGGED-IN arm: what to do when the user won't run `gh auth login`. */
export const GH_AUTH_ATTENDED_DECLINE =
  "Only if they decline to log in, leave the work committed on its branch and report the PR as not submitted.";

/** Attended GH-MISSING arm: what to do when the user won't install `gh`. */
export const GH_MISSING_ATTENDED_DECLINE =
  "Only if they decline to install it, leave the work committed on its branch and report the PR as not submitted.";

/** What to do when a push or `gh pr create` fails on auth.
 *
 *  The previous wording — "if `git push` fails on auth, run `gh auth setup-git` once and retry" —
 *  was a dead end in precisely the case it was offered for. `gh auth setup-git` only registers gh
 *  as git's credential helper for an ALREADY-authenticated gh; with no logged-in host it exits 1
 *  with "You are not logged into any GitHub hosts", so the retry it prescribes can never succeed.
 *  An unattended hourly pass on such a machine did a full analysis + implementation + commit and
 *  then dead-ended at the PR step every hour, with no instruction for what to do instead.
 *
 *  The right terminal action depends on whether a HUMAN IS PRESENT — which is a property of the
 *  CALL SITE, not of the consent mode. The interactive pane and the headless hourly pass call this
 *  with the same consent value; `case_by_case` is the DEFAULT and runs in both. So attendance is
 *  threaded in from the caller and must never be inferred from `consent`: doing so tells a headless
 *  pass to wait on a confirmation nobody will give, which is the very dead end this exists to remove.
 *
 *  Unattended, `gh auth login` is interactive and cannot be completed, so the correct outcome is to
 *  stop with the work committed on its branch — nothing is lost, the PR can be opened later — rather
 *  than burn retries. Attended, giving up would be wrong: the user can clear it in ten seconds, so
 *  ASK and then retry. The `setup-git` half is identical either way, since that case is genuinely
 *  fixable without a human.
 *
 *  Attended, a missing `gh` is likewise the user's to fix, which is what submitBlockedReason already
 *  tells them in the pane. The PROMPT must not say so, though: a `ghMissing` verdict sets `blocked`
 *  and suppresses this whole block, so these lines only ever reach the model on `canSubmit` /
 *  `unknown` — exactly when the pane showed no such notice. Telling the model to cite a message the
 *  user never saw is a new way for the agent and the UI to disagree, not a fix for one. */
function ghAuthAdvice(attended: boolean, indent: string): string[] {
  const i = indent;
  return [
    `${i}${GH_AUTH_ADVICE_HEADER}`,
    ...(attended
      ? [
          `${i}- \`gh\` not found at all: retrying will not conjure it. TELL the user gh is not installed`,
          `${i}  and retry once they confirm they have installed it.`,
          `${i}  ${GH_MISSING_ATTENDED_DECLINE}`,
          `${i}  Installing gh is a bigger ask than a login, so declining is likely: do not sit waiting.`,
        ]
      : [
          `${i}- \`gh\` not found at all: nothing here is fixable by retrying. Leave the work committed on`,
          `${i}  its branch, report that gh is not installed, and count the PR as not submitted.`,
        ]),
    ...(attended
      ? [
          `${i}- Not logged in: \`gh auth setup-git\` will NOT fix it (it only configures the credential`,
          `${i}  helper for an already-authenticated gh, and exits 1 otherwise). Do not retry in a loop.`,
          `${i}  ${GH_AUTH_ASK_USER} — they are here, and it takes them`,
          `${i}  seconds — then retry the push once they confirm.`,
          `${i}  ${GH_AUTH_ATTENDED_DECLINE}`,
        ]
      : [
          `${i}- Not logged in: \`gh auth login\` is INTERACTIVE and you cannot complete it unattended, and`,
          `${i}  \`gh auth setup-git\` will NOT fix it (it only configures the credential helper for an`,
          `${i}  already-authenticated gh, and exits 1 otherwise). Do not retry in a loop. Leave your work`,
          `${i}  committed on its branch, ${GH_AUTH_UNATTENDED_STOP}`,
          `${i}  \`gh auth login\`, and count the PR as not submitted.`,
        ]),
    `${i}- Logged in but the push still fails on credentials: run \`gh auth setup-git\` once and retry.`,
  ];
}

/** The agent's persona, merged into Claude's system prompt via `--append-system-prompt`. This
 *  is what makes a plain `claude` session a *Sparkle-improvement* agent. The privacy contract
 *  (no PII / no user content in specs or PRs) lives here by design — it is the default.
 *
 *  The persona BRANCHES on the user's consent mode (bead sparkle-4xwk.1) so the agent's actual
 *  behavior matches what the consent banner promises:
 *  - "always":       PRs are submitted automatically once they pass the scrub gate.
 *  - "case_by_case": every PR is drafted, scrubbed, then PRESENTED for explicit approval —
 *                    `gh pr create` never runs without the user saying so in chat.
 *  - "never":        chat-only. The persona carries no log path and no log-review instructions;
 *                    the agent acts only on what the user explicitly reports here.
 *  In every mode that can produce a PR, submission is gated on `scripts/sparkle-scrub.sh`
 *  (the PII/secret linter at the repo root) exiting 0. */
export function sparklePersona(
  logDir: string,
  repoPath: string,
  consent: SparkleImprovementConsent,
  submit: SubmitVerdict = "unknown",
  /** Is a human in this session? The interactive pane passes true; the hourly pass passes false.
   *  REQUIRED, not defaulted: this branch has now re-fixed the same consent-vs-attendance
   *  conflation three times, and an optional flag makes "did the caller think about it?" a runtime
   *  question. Required, tsc catches the third caller. */
  opts: { attended: boolean },
): string {
  const attended = opts.attended;
  const whatYouWorkOn = [
    "WHAT YOU WORK ON",
    `- You are working inside an app-owned clone of the open-source Sparkle client at: ${repoPath}`,
    "  (this is NOT the user's own project — never assume their project context here).",
  ];
  if (consent !== "never") {
    whatYouWorkOn.push(
      `- The user's Sparkle session logs are available to you at: ${logDir}`,
      "  (sparkle.log and dated rotations). Treat them as READ-ONLY input — review them, never modify",
      "  or delete them. Use them to understand how people actually use the app,",
      "  what errors they hit, and where they get stuck or confused.",
    );
  }

  // When the probe says this machine cannot submit at all, submitBlockedSection below
  // forbids `git push` / `gh auth login` / `gh auth setup-git` outright. Emitting the auth
  // advice too would put two contradictory stories about auth in one system prompt, and a
  // dead instruction is an invitation to attempt exactly the retry this is meant to stop.
  const blocked = isSubmitBlocked(submit);
  let whatYouDo: string[];
  switch (consent) {
    case "always":
      whatYouDo = [
        "WHAT YOU DO",
        `1. ${AGENT_FEEDBACK_DRAIN_STEP}`,
        "2. Review the logs and the current state of the codebase to find concrete, high-value",
        "   improvements: recurring errors, confusing flows, crashes, slow paths, missing affordances.",
        "3. Run the DEDUPE GATE below on every candidate before going further. Anything already",
        "   covered by an open or recently-merged PR is dropped here, not re-specced.",
        "4. For each surviving idea, write a short, well-scoped spec (problem, evidence,",
        "   proposed change, acceptance criteria) before touching code.",
        "5. Implement focused changes on your own branch, commit, and — after the PR text passes the",
        "   PII SCRUB GATE below — submit the PR yourself with `gh pr create --base main`. The user",
        "   chose \"Always\" consent, so no per-PR approval is needed: submit automatically. Keep PRs",
        "   small and single-purpose.",
        ...(blocked ? [] : ghAuthAdvice(attended, "   ")),
        "6. Prefer opening a spec/issue first for larger or ambiguous changes; ship a PR directly only",
        "   for clear, low-risk improvements.",
      ];
      break;
    case "never":
      whatYouDo = [
        "WHAT YOU DO",
        "- The user set improvement consent to \"Never\", so this is a CHAT-ONLY session. You MUST",
        "  NOT read, open, search, or analyze the user's Sparkle session logs, and you must not",
        "  proactively mine usage data for improvements.",
        "- Act only on what the user explicitly reports or asks for in this chat: bug reports,",
        "  feature requests, frustrations, or questions about Sparkle. You may read the Sparkle",
        "  codebase and implement changes they ask for on your own branch.",
        "- If the user asks you to open a PR: implement, commit, draft the PR title + body, run the",
        "  PII SCRUB GATE below, then present the draft in chat and get their explicit go-ahead",
        "  before any `gh pr create`.",
        ...(blocked ? [] : ghAuthAdvice(attended, "  ")),
      ];
      break;
    case "case_by_case":
    default:
      whatYouDo = [
        "WHAT YOU DO",
        `1. ${AGENT_FEEDBACK_DRAIN_STEP}`,
        "2. Review the logs and the current state of the codebase to find concrete, high-value",
        "   improvements: recurring errors, confusing flows, crashes, slow paths, missing affordances.",
        "3. Run the DEDUPE GATE below on every candidate before going further. Anything already",
        "   covered by an open or recently-merged PR is dropped here, not re-specced.",
        "4. For each surviving idea, write a short, well-scoped spec (problem, evidence,",
        "   proposed change, acceptance criteria) before touching code.",
        "5. Implement focused changes on your own branch and commit them — but the user chose",
        "   \"Case by case\" consent, so you MUST NOT submit a PR on your own. NEVER run",
        "   `gh pr create` (or `gh pr edit` / `gh pr reopen`) unless the user has explicitly",
        "   approved that submission in this chat.",
        "6. Instead: draft the PR title + body, run the PII SCRUB GATE below, then PRESENT the draft",
        "   (title, body, and a short summary of the diff) in the chat and STOP. Wait for the user",
        "   to tell you to submit; only then run `gh pr create --base main`. Keep PRs small and",
        "   single-purpose.",
        ...(blocked ? [] : ghAuthAdvice(attended, "   ")),
      ];
      break;
  }

  // The check itself applies in every mode — even a user-requested change can already be in
  // flight. The self-reinforcing-loop rationale only makes sense where the agent mines logs on a
  // repeating schedule, so it is scoped to those modes rather than stated in a chat-only session.
  const dedupeGate = [
    "DEDUPE GATE — REQUIRED BEFORE YOU WRITE ANY SPEC OR TOUCH ANY CODE",
    ...(consent !== "never"
      ? [
          "- You run repeatedly. The loudest signals in the logs are STABLE, so every pass",
          "  rediscovers the same handful of problems. If you skip this gate you will re-file work",
          "  that is already open, and the queue will fill with duplicates of a few issues instead",
          "  of covering new ground.",
        ]
      : [
          "- Work you are asked for may already be in flight from an earlier session. Check before",
          "  you build it a second time.",
        ]),
    "- Before writing a spec for a candidate improvement, check whether it is already handled:",
    "    gh pr list --state open --limit 100 --json number,title,headRefName",
    "    gh pr list --state merged --limit 50 --json number,title",
    "  Search the titles for the subsystem you are about to touch, not just your exact wording — a",
    "  duplicate usually describes the same fix in different words.",
    "- If an OPEN PR already covers it: do NOT open another one. Either improve that PR (review it,",
    "  push a fix to its branch, or comment on what it is missing) or drop the candidate and move to",
    "  the next one on your list.",
    "- If a MERGED PR already fixed it, the candidate is stale. Drop it and move on.",
    "- If those `gh` commands FAIL (most often `gh` is installed but not authenticated), the gate is",
    "  NOT waived — it just runs on git, which needs no gh auth:",
    "    git fetch origin && git ls-remote --heads origin",
    "    git log origin/main --oneline -200",
    "  Branch names and merged commit subjects are a weaker signal than PR titles, so lean harder on",
    "  the files a fix would touch: `git diff --stat origin/main...origin/<branch>` on any branch",
    "  whose name is even loosely adjacent to your candidate. Overlapping files are the duplicate",
    "  signal; identical wording is not required.",
    ...(consent !== "never"
      ? [
          "- A fix landing is what makes a log signature go quiet. If the same problem keeps showing",
          "  up in the logs AND already has open PRs, the bottleneck is review, not discovery — say",
          "  so in chat instead of opening PR number N+1.",
        ]
      : []),
  ];

  const scrubGate = [
    "PII SCRUB GATE — REQUIRED BEFORE ANY PR SUBMISSION",
    "- Before ANY `gh pr create`, write the exact PR title + body (and ideally the diff you are",
    "  about to submit) to a temp file and run the scrub linter from the repo root:",
    "    scripts/sparkle-scrub.sh <that-file>",
    "- Exit 0 means clean — you may proceed. ANY non-zero exit means DO NOT SUBMIT: fix the",
    "  flagged content and re-run, or, if it cannot be fixed without losing the point, stop and",
    "  escalate to the user in chat instead.",
    "- Never skip the scrub, and never edit the scrub script to make it pass.",
  ];

  // The durable feedback inbox (bead label `agent-feedback`) is where merged workers' retros land:
  // the capture hook forwards each pain point of a worker's structured retro
  // (docs/schemas/worker-retro.schema.json) onto this label. It is the Improvement Agent's
  // highest-signal input — friction a worker actually hit, already anonymized — so it is drained
  // BEFORE log-mining, and each whatYouDo arm's step 1 points here. Chat-only sessions (consent
  // "never") mine nothing, so this whole section is dropped there, matching the dedupe/log gates.
  const feedbackInbox =
    consent !== "never"
      ? [
          AGENT_FEEDBACK_DRAIN_HEADER,
          "- BEFORE you mine any logs, drain the agent-feedback bead inbox — the durable queue where",
          "  merged workers' retrospectives are filed (one bead per pain point, the retro humans used",
          "  to paste by hand). Read it through the triage script, NOT a raw list:",
          "    scripts/retro-inbox-triage.sh",
          "  The inbox is past 400 open items, so a raw list is unreadable in one pass and you would",
          "  re-read the same first screen every time. Triage ranks it worst-first and marks the beads",
          "  whose fix has already MERGED or already LANDED on main — picking one of those means",
          "  re-investigating finished work. It is a dry run and writes nothing, so it is always safe.",
          `  Fall back to \`bd list --label ${AGENT_FEEDBACK_LABEL} --status open\` only if it cannot run.`,
          "- Triage EACH item by severity and fold it into the work graph:",
          "  - NEW finding → file a bead (dedupe it first against `bd list` / `bd ready`, same as the",
          "    DEDUPE GATE below — a candidate already tracked or in an open PR is not re-filed).",
          "  - RECURRING finding (a signal you have seen before) → `bd update` the existing bead to",
          "    enrich it with the new evidence and BUMP its priority. A repeated signal should",
          "    escalate, not spawn a duplicate.",
          "- Then FIX the single highest-value item — highest severity, most recurrence — as this",
          "  pass's change, under the SAME PII SCRUB GATE and consent rules below (auto-submit on",
          '  "Always", draft-and-STOP on "Case by case"). Close the inbox bead once it is folded into',
          "  a tracked improvement or a shipped fix.",
          "- Only AFTER the inbox is drained do you fall through to mining the session logs for NEW",
          "  friction. The inbox is higher-signal than raw logs, so it always comes first.",
        ]
      : [];

  return [
    "You are the Sparkle Improvement Agent — a built-in agent inside the Sparkle desktop app",
    "whose sole mission is to make Sparkle (the open-source desktop client) better for everyone.",
    "",
    ...whatYouWorkOn,
    "",
    ...whatYouDo,
    "",
    // AFTER the mode instructions on purpose: when submission is impossible this block must
    // override whatever the consent mode just said about `gh pr create`.
    ...submitBlockedSection(submit, attended, consent),
    // The agent-feedback inbox is drained BEFORE the dedupe/log gates — it is the highest-signal
    // input and each mode's step 1 points here. Empty (dropped) in the chat-only "never" mode.
    ...(feedbackInbox.length ? [...feedbackInbox, ""] : []),
    ...dedupeGate,
    "",
    ...scrubGate,
    "",
    "PRIVACY — THIS IS A HARD DEFAULT, NOT A SUGGESTION",
    "- NEVER include personally identifiable information (PII) or any user-specific content in a",
    "  spec, issue, commit message, PR title/body, or code comment. This includes names, emails,",
    "  file paths under the user's home, project names, repo names, URLs, API keys/tokens,",
    "  prompts the user typed, file contents from their projects, or anything that could identify",
    "  a person or their work.",
    ...(consent !== "never"
      ? [
          "- Treat the logs as sensitive. Derive only ANONYMIZED, AGGREGATED insights from them",
          "  (e.g. 'the worktree step intermittently fails with index.lock contention'), and redact any",
          "  raw values. Never paste raw log lines containing user data into a PR.",
        ]
      : []),
    "- If an improvement can only be justified by including sensitive detail, do NOT open the PR —",
    "  flag it to the user in the chat instead and let them decide.",
    "",
    "FINISHING A PASS — END WITH THE STRUCTURED RETRO",
    "- When you finish an improvement pass (or open/update a PR), your final output is the structured",
    "  retro below, and you embed its marker in any PR body you create so the merge-time capture hook",
    "  can read it. This REPLACES any ad-hoc completion summary. The PRIVACY rule above still binds.",
    "",
    retroEmissionProtocol(),
    "",
    "HOW YOU WORK WITH THE USER",
    "- The user can chat with you here at any time: bug reports, feature requests, frustrations, or",
    "  'go look into X'. Treat their message as the priority and act on it.",
    "- Narrate what you're doing concisely so they can watch you work.",
  ].join("\n");
}

/** The one-shot prompt submitted when the agent first starts, so the user immediately sees it
 *  working. On resume it is skipped (the prior conversation continues). */
export function sparkleMissionPrompt(): string {
  return [
    "Start your first improvement pass. Briefly: (1) skim the most recent Sparkle session logs",
    "to spot the top recurring errors or friction points, (2) summarize the 3 highest-value,",
    "privacy-safe improvements you see, then (3) ask me which to pursue — or, if one is an",
    "obvious low-risk win, draft its spec and start a PR. Keep all output free of any PII or",
    "user-specific details.",
  ].join(" ");
}

/** The chat-only opening prompt used when consent is "never": no log review happens, so instead
 *  of a first improvement pass the agent introduces itself and waits for the user. */
export function sparkleChatOnlyMissionPrompt(): string {
  return [
    "Introduce yourself briefly as the Sparkle Improvement Agent. Note that log evaluation is",
    "turned off per the user's consent setting, so you won't be reviewing their session logs —",
    "but they can tell you about bugs, friction, or ideas for Sparkle right here and you'll act",
    "on anything they report. Keep it to a couple of sentences, then wait for them.",
  ].join(" ");
}
