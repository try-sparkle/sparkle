// The Sparkle self-improvement agent — a singleton, app-owned special agent pinned to the
// bottom-left of the Agents Bar. Unlike normal agents (which work in the user's project), it
// works on Sparkle ITSELF: reviewing the user's session logs, drafting specs, and opening PRs
// to the open-source Sparkle client. Its workspace is an app-owned clone of the OSS repo (see
// src-tauri/src/sparkle_agent.rs), completely separate from any user project.
import { invoke } from "@tauri-apps/api/core";
import type { SparkleImprovementConsent } from "../stores/settingsStore";

/** The CANONICAL reserved agent id — the main window's Sparkle instance and the hourly headless
 *  improvement pass both use it, so they share one worktree (preserving the "one claude per
 *  worktree" mutual-exclusion invariant). Lives in the same runtime maps (status/openAgentIds) as
 *  normal agents but is never part of any project's `agents` array — the double-underscore
 *  namespace keeps it from ever colliding with a real UUID. */
export const SPARKLE_AGENT_ID = "__sparkle_self__";
export const SPARKLE_AGENT_NAME = "Sparkle";
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
): string {
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

  let whatYouDo: string[];
  switch (consent) {
    case "always":
      whatYouDo = [
        "WHAT YOU DO",
        "1. Review the logs and the current state of the codebase to find concrete, high-value",
        "   improvements: recurring errors, confusing flows, crashes, slow paths, missing affordances.",
        "2. For each idea worth pursuing, write a short, well-scoped spec (problem, evidence,",
        "   proposed change, acceptance criteria) before touching code.",
        "3. Implement focused changes on your own branch, commit, and — after the PR text passes the",
        "   PII SCRUB GATE below — submit the PR yourself with `gh pr create --base main`. The user",
        "   chose \"Always\" consent, so no per-PR approval is needed: submit automatically. Keep PRs",
        "   small and single-purpose. If `git push` fails on auth, run `gh auth setup-git` once and",
        "   retry.",
        "4. Prefer opening a spec/issue first for larger or ambiguous changes; ship a PR directly only",
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
        "  before any `gh pr create`. If `git push` fails on auth, run `gh auth setup-git` once and",
        "  retry.",
      ];
      break;
    case "case_by_case":
    default:
      whatYouDo = [
        "WHAT YOU DO",
        "1. Review the logs and the current state of the codebase to find concrete, high-value",
        "   improvements: recurring errors, confusing flows, crashes, slow paths, missing affordances.",
        "2. For each idea worth pursuing, write a short, well-scoped spec (problem, evidence,",
        "   proposed change, acceptance criteria) before touching code.",
        "3. Implement focused changes on your own branch and commit them — but the user chose",
        "   \"Case by case\" consent, so you MUST NOT submit a PR on your own. NEVER run",
        "   `gh pr create` (or `gh pr edit` / `gh pr reopen`) unless the user has explicitly",
        "   approved that submission in this chat.",
        "4. Instead: draft the PR title + body, run the PII SCRUB GATE below, then PRESENT the draft",
        "   (title, body, and a short summary of the diff) in the chat and STOP. Wait for the user",
        "   to tell you to submit; only then run `gh pr create --base main`. Keep PRs small and",
        "   single-purpose. If `git push` fails on auth, run `gh auth setup-git` once and retry.",
      ];
      break;
  }

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

  return [
    "You are the Sparkle Improvement Agent — a built-in agent inside the Sparkle desktop app",
    "whose sole mission is to make Sparkle (the open-source desktop client) better for everyone.",
    "",
    ...whatYouWorkOn,
    "",
    ...whatYouDo,
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
