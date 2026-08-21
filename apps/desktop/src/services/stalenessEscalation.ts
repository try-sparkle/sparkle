// WHY A SILENT REFUSAL IS WORSE THAN NO AUTOMATION AT ALL (bead sparkle-v38y1n).
//
// The unattended fast-forward in `useProjectStaleness` was never missing and was never broken. It
// ran every 60 seconds for ten days against the founder's shared checkout, refused every single
// time, and said nothing — its own doc comment made the silence a feature: "a remedy that could not
// be applied simply leaves the badge exactly where it was." So the checkout fell 1,175 commits
// behind while the machinery built to prevent exactly that reported success by reporting nothing.
//
// A badge that reads "1,175 behind" is not the missing signal. The badge was there the whole time.
// What was missing is the SECOND fact — that something has been trying, and failing, and here is
// the path in the way — because that is the only version a person can act on. This module holds it.
//
// FOUR PROPERTIES, and each one is a way the previous design failed:
//
// 1. IT COUNTS CONSECUTIVE DECLINES, NOT DECLINES. One refusal is nothing: a checkout goes dirty
//    for thirty seconds while someone saves a file, and a notice about it would be noise. A refusal
//    that survives three consecutive checks is a wedge, which is a different thing and deserves a
//    different volume.
//
// 2. IT FIRES ONCE PER STREAK. A notice that repeats every minute gets muted, and a muted notice is
//    the silence we started from — with the added cost that the user now believes they are being
//    told. So the streak escalates on the Nth decline and then goes quiet until something resets it.
//
// 3. IT NAMES THE PATHS. "Dirty tree" is not actionable and was never actionable; the whole point of
//    `StaleDiagnosis.blockingPaths` is that the app now knows WHICH file is in the way. Of the five
//    dirty entries on the founder's checkout exactly one was a real blocker — a notice naming all
//    five, or naming none, would have sent them to the wrong place or to no place.
//
// 4. IT NAMES THE STATE, AND A DELIBERATE STATE IS NOT AN ALARM. The two commonest reasons this
//    poll declines in this repo are not faults at all: a main checkout PARKED on a feature branch
//    (`land.sh` parks it, and AGENTS.md's rule is that a parked tree stays parked) and a DETACHED
//    HEAD. Both fell to the catch-all and escalated as "the reason could not be established" —
//    which for the parked case repeats for as long as the park lasts, i.e. forever. A false alarm
//    that repeats forever is worse than no alarm: it is what teaches the reader to skip the notice
//    that finally matters. So each has its own arm, and the parked one counts WITHOUT speaking.
//
// 5. A HELD LEASE IS NOT A PROBLEM TO REPORT AS ONE. When a live session holds the worktree, NOT
//    merging is the correct behaviour and there is nothing for anyone to fix — changing files
//    beneath a running agent is bead sparkle-jgctmg (P1, SEV4), which recorded four clobbering
//    incidents. That case still escalates, because a silently-parked checkout is what we are fixing,
//    but it says what it is: a wait, not a chore.
import type { StaleDiagnosis } from "./staleness";

/**
 * Consecutive declines before the streak escalates — roughly three minutes at the 60s poll.
 *
 * A MODULE CONSTANT AND NOT A CONFIG KEY, deliberately. This is the threshold at which silence
 * becomes a bug, and there is no operator for whom the right answer is "never tell me"; a knob here
 * would mostly serve to turn the signal off again. Three is chosen against the poll: long enough
 * that saving a file mid-poll cannot trip it, short enough that a real wedge is named the same
 * morning it starts rather than the following week.
 */
export const DECLINES_BEFORE_ESCALATION = 3;

/** What kind of decline this is — what the notice is FOR, not what it says. `message` is the text. */
export type StalenessDeclineKind =
  /** Local work sits on a path the fast-forward would overwrite. Someone has to move it. */
  | "blocked-by-local-work"
  /** A live session holds this worktree. Correct to wait; nothing to do. */
  | "held-by-a-live-session"
  /** The checkout has commits the base does not — a human decision, and no path to move. */
  | "needs-a-human-decision"
  /** Parked on a branch that is not the default one. Usually deliberate; see `QUIET_KINDS`. */
  | "parked-on-another-branch"
  /** HEAD is on no branch, so this checkout tracks nothing and can never catch up on its own. */
  | "detached-head"
  /** We could not establish the facts (status unreadable, base unresolvable, IPC failed). */
  | "could-not-tell";

/** One escalation. `message` is the whole of what a person needs; the fields are for callers that
 *  want to lay it out themselves rather than re-derive any of it. */
export interface StalenessNotice {
  root: string;
  /** How many consecutive declines produced this — always `DECLINES_BEFORE_ESCALATION` today. */
  declines: number;
  kind: StalenessDeclineKind;
  /** Commits behind the base, from the diagnosis. */
  behind: number;
  /** e.g. `origin/main`. Empty when the diagnosis could not resolve one. */
  base: string;
  /** The EXACT paths in the way. Empty for the kinds where no path is the reason. */
  blockingPaths: string[];
  /** Branch checked out there; empty when detached, unborn, or undiagnosed. The two branch-shaped
   *  arms turn on this, so it is carried rather than left for a caller to re-derive. */
  headBranch: string;
  /** The branch the base is measured against, e.g. `main`. Empty when undiagnosed. */
  defaultBranch: string;
  /** The backend's own sentence — its `cause`, or git's refusal text out of a `RemedyOutcome`.
   *  Verbatim; `remedy_at` already peels git's words out of the wrapped error via `git_words()`. */
  detail: string;
  /** The complete notice, ready to render. Never contains the string "dirty tree". */
  message: string;
}

/** What a decline reports. Either half may be missing: the diagnosis fails on its own sometimes. */
export interface StalenessDecline {
  /** The fresh diagnosis, when we got one. */
  diagnosis?: StaleDiagnosis | null;
  /** The refusal text — a `RemedyOutcome.reason`, or the message of a throw. */
  reason?: string;
}

interface Streak {
  declines: number;
  /** Whether this streak has already spoken. Property 2: once per streak, not once per poll. */
  escalated: boolean;
  last: StalenessNotice | null;
}

const streaks = new Map<string, Streak>();
const listeners = new Set<(n: StalenessNotice) => void>();
// A SEPARATE CHANNEL FOR "IT CLEARED", not a null on the one above. A subscriber that renders the
// escalation has to be told when the streak ends, or it goes on showing a wedge that is gone — the
// mirror image of the bug this module fixes, and just as misleading.
const resolvedListeners = new Set<(root: string) => void>();

/**
 * THE TOKEN THAT MEANS "A LIVE SESSION HOLDS THIS WORKTREE".
 *
 * Matched as a token rather than a substring so `in-user`-ish text cannot trip it: the Rust park
 * path emits the bare reason `in-use` (see `services/improvementPass.ts`'s `refusalDetail`), and a
 * false positive here would tell a user to sit and wait for a respawn that is never coming.
 */
function mentionsALiveLease(text: string): boolean {
  return /(^|[^a-z-])in-use([^a-z-]|$)/i.test(text);
}

function classify(d: StaleDiagnosis | null | undefined, reason: string): StalenessDeclineKind {
  // The lease reads FIRST. It is the one kind where declining is the right answer, so it must not
  // be described as a blockage someone has to clear.
  if (mentionsALiveLease(reason) || d?.remedy === "blocked-held-elsewhere") {
    return "held-by-a-live-session";
  }
  if (!d || d.unknown || d.remedy === "unknown") return "could-not-tell";
  // THE STRUCTURAL VERDICTS BEFORE THE FALLBACK, and each of them before `blockingPaths`. A
  // checkout that cannot be fast-forwarded for a structural reason declines whether or not it is
  // also dirty, so leading with the dirt would send someone to move a file that was never what
  // stopped it. There is no file to move in any of these three.
  //
  // DETACHED IS ITS OWN ARM, not a share of the diverged one (roborev 66891). "No fast-forward
  // exists for this checkout" is simply false here — one may well exist, HEAD is just on no branch
  // to receive it — and a reader given that sentence has nothing to act on. The cure is one
  // command and the arm names it.
  if (d.remedy === "blocked-detached" || d.detached) return "detached-head";
  if (d.remedy === "blocked-diverged") return "needs-a-human-decision";
  // PARKED ON SOMETHING ELSE. `autoSafe` requires `headBranch === defaultBranch`, so a parked
  // checkout declines every single poll for as long as it is parked — and in this repo that is the
  // NORMAL state of the main checkout, not an incident. Before this arm it reached the catch-all
  // and reported "the reason could not be established" forever.
  if (d.headBranch && d.defaultBranch && d.headBranch !== d.defaultBranch) {
    return "parked-on-another-branch";
  }
  if (d.blockingPaths.length > 0) return "blocked-by-local-work";
  // Everything left is a refusal we cannot attribute to a named cause — say we could not tell
  // rather than inventing one.
  //
  // `blockersKnown` is NOT consulted here, deliberately: the backend leaves `blockingPaths` empty
  // whenever it is false, so a clause for it would decide nothing and was measured surviving its
  // own mutation. The distinction it carries is real but it is a distinction in the WORDING — see
  // the `could-not-tell` arm below, where "we could not work out which changes are in the way" and
  // "we could not tell at all" are two different things to be told.
  return "could-not-tell";
}

/**
 * KINDS THAT COUNT BUT NEVER SPEAK.
 *
 * The founder's rule everywhere else in this module is that a decline must be loud. This is the one
 * exception, and it is the same rule applied honestly rather than a hole in it: escalation exists
 * so a WEDGE gets named, and a checkout parked on a non-default branch is not wedged — it is doing
 * what somebody asked it to do. `land.sh` parks the main checkout, AGENTS.md's rule is that a
 * parked tree stays parked, and `scripts/main-checkout-fresh.sh` already reports that shape as a
 * silent N/A rather than a finding. An escalation here would contradict the repo's own guard and
 * would repeat for the entire life of the park — a permanent false alarm, which costs more than
 * silence because it is what trains the reader to skip the notice that finally matters.
 *
 * IT COUNTS ANYWAY, and it deliberately does NOT set `escalated`. So the streak keeps climbing
 * underneath, and the moment that same root declines for a reason that IS a wedge — the branch got
 * checked out, a real blocker appeared — it escalates on that very poll instead of serving out
 * another three-check wait. Quiet is about the kind, never about the counter.
 *
 * DETACHED IS NOT IN HERE. A detached project root can never catch up by itself and is almost never
 * what anyone intended, so it is worth saying once — which is exactly what once-per-streak gives.
 */
const QUIET_KINDS: readonly StalenessDeclineKind[] = ["parked-on-another-branch"];

/** How far behind, said the way a person reads it. Empty when there is no honest number. */
function behindPhrase(behind: number, base: string): string {
  if (!base || behind <= 0) return "";
  const n = behind.toLocaleString();
  return ` It is ${n} commit${behind === 1 ? "" : "s"} behind ${base}.`;
}

/** Compose the whole notice. Exported for the test, so the wording is pinned as a pure function
 *  rather than through a mocked poll — and so a future edit that reintroduces "dirty tree" fails. */
export function buildStalenessNotice(
  root: string,
  declines: number,
  { diagnosis, reason = "" }: StalenessDecline,
): StalenessNotice {
  const d = diagnosis ?? null;
  const kind = classify(d, reason);
  const behind = d?.behind ?? 0;
  const base = d?.base ?? "";
  // The named paths are what makes this actionable — but only for the kind where a path IS the
  // reason. Carrying them into the lease case would tell someone to go and move a file when the
  // thing actually in the way is a running session.
  const blockingPaths = kind === "blocked-by-local-work" ? (d?.blockingPaths ?? []) : [];
  const headBranch = d?.headBranch ?? "";
  const defaultBranch = d?.defaultBranch ?? "";
  // The backend's own sentence, verbatim. `reason` wins when we have one, because a
  // `RemedyOutcome.reason` is git's own refusal text and is more specific than any diagnosis cause.
  const detail = reason.trim() || d?.cause?.trim() || "";

  const lead =
    `Sparkle has not been able to fast-forward ${root} for ${declines} checks in a row.` +
    behindPhrase(behind, base);

  let body: string;
  switch (kind) {
    case "blocked-by-local-work":
      body =
        ` Uncommitted work sits on ${blockingPaths.length === 1 ? "a path" : "paths"} the ` +
        `fast-forward would overwrite: ${blockingPaths.join(", ")}. Commit, stash or revert ` +
        `${blockingPaths.length === 1 ? "it" : "them"} and the next check will carry the checkout ` +
        `forward on its own.`;
      break;
    case "held-by-a-live-session":
      body =
        " A live session holds this worktree, so nothing was merged underneath it — that is" +
        " deliberate, not a failure: changing files beneath a running agent has clobbered work" +
        " before (bead sparkle-jgctmg). Propagation waits for that session to end and the worktree" +
        " to respawn naturally. There is nothing to do here.";
      break;
    case "needs-a-human-decision":
      body =
        " No fast-forward exists for this checkout, so no automation can move it. It needs a" +
        " person to decide what to do with what is already there.";
      break;
    case "parked-on-another-branch":
      // Said, never shouted — this arm does not escalate (see `QUIET_KINDS`). The wording still
      // has to be right, because the panel renders a standing notice verbatim and a reader who
      // opens it deserves the actual state rather than a shrug.
      body =
        ` This checkout is parked on ${headBranch || "another branch"} rather than` +
        ` ${defaultBranch || "its default branch"}, and a branch Sparkle did not put you on is not` +
        " one it will move under you. That is usually deliberate, so there is nothing to fix here:" +
        ` check out ${defaultBranch || "the default branch"} in that directory if you want it kept` +
        " current, and it will start catching up on its own again.";
      break;
    case "detached-head":
      body =
        " HEAD there is on no branch at all, so this checkout tracks nothing and can never catch" +
        " up on its own — every check from here will decline for the same reason." +
        ` \`git checkout ${defaultBranch || "the default branch"}\` in that directory puts it back` +
        " on the branch this count is measured against.";
      break;
    case "could-not-tell":
      // TWO DIFFERENT FACTS, and reporting the second as the first is what sends someone away
      // reassured. `blockersKnown: false` means we HAVE a diagnosis and could not work out which of
      // the local changes the merge would touch — its empty `blockingPaths` is "we did not look",
      // never "there are none".
      body =
        d && !d.blockersKnown
          ? " Which of the local changes this fast-forward would touch could not be worked out, so" +
            " nothing was attempted — an empty list there means we did not look, not that the tree" +
            " is clear."
          : " The reason could not be established, so nothing was attempted — this is the" +
            " fail-closed path, not a green light.";
      break;
  }

  const tail = detail ? `\n${detail}` : "";
  return {
    root,
    declines,
    kind,
    behind,
    base,
    blockingPaths,
    headBranch,
    defaultBranch,
    detail,
    message: lead + body + tail,
  };
}

/**
 * Record ONE unattended decline for `root`. Returns the notice on the escalating decline, and
 * `null` on every other one — including every further decline in the same streak.
 *
 * Callers do not have to decide whether to be loud; calling this is how they are loud, and the
 * return value exists only for a caller that wants to render it somewhere of its own.
 */
export function noteStaleDecline(root: string, decline: StalenessDecline): StalenessNotice | null {
  const s = streaks.get(root) ?? { declines: 0, escalated: false, last: null };
  s.declines += 1;
  streaks.set(root, s);
  // Property 2: the streak speaks once. A notice every 60 seconds is a notice that gets muted, and
  // a muted notice is the silence this module exists to end.
  if (s.declines < DECLINES_BEFORE_ESCALATION || s.escalated) return null;
  // Property 4: a deliberate state is not an alarm. Read BEFORE `escalated` is set, so a root that
  // later declines for a real reason still gets its one notice — see `QUIET_KINDS`.
  if (QUIET_KINDS.includes(classify(decline.diagnosis, decline.reason ?? ""))) return null;
  s.escalated = true;
  const notice = buildStalenessNotice(root, s.declines, decline);
  s.last = notice;
  // console.error and not console.warn: this is a checkout that has stopped catching up, and the
  // log is where an agent (and the founder) actually look.
  console.error(`[staleness] ${notice.message}`);
  for (const fn of listeners) {
    try {
      fn(notice);
    } catch {
      // A broken listener must not stop the others being told, and must not throw into a timer.
    }
  }
  return notice;
}

/**
 * The streak is over: this checkout advanced, or was found not to need advancing. Clears BOTH the
 * count and the already-spoken flag, so a wedge that comes back is announced again.
 *
 * FOUR CALLERS, and the last three are all the same bug seen from different sides (roborev 66891):
 * a counter left primed by something the USER did re-escalates on the next unrelated hiccup, with a
 * notice about a wedge that is already gone.
 *
 *   • the unattended fast-forward succeeded;
 *   • a poll measured the root and found it not stale, i.e. someone fixed it by hand;
 *   • the panel's own Fast-forward button succeeded — the remedy this module's notice is telling
 *     the reader to press, which used to leave the streak exactly where it was;
 *   • the project opted OUT of unattended fast-forwarding, at which point Sparkle is no longer
 *     trying and a notice saying it cannot is describing a decision the user made themselves.
 */
export function noteStaleResolved(root: string): void {
  // Nothing was standing, so there is nothing to announce. Without this guard every clean poll on
  // every fresh project would wake every subscriber, sixty times an hour, forever.
  if (!streaks.has(root)) return;
  streaks.delete(root);
  for (const fn of resolvedListeners) {
    try {
      fn(root);
    } catch {
      // Same posture as above: one broken listener must not take the others down, or throw into a
      // timer.
    }
  }
}

/** Consecutive declines recorded for `root` right now. 0 when the streak is clear. */
export function stalenessDeclines(root: string): number {
  return streaks.get(root)?.declines ?? 0;
}

/** The notice this root escalated with, or null if this streak has not escalated. */
export function stalenessNotice(root: string): StalenessNotice | null {
  return streaks.get(root)?.last ?? null;
}

/** Be told when a streak escalates. Returns the unsubscribe. */
export function subscribeStalenessNotices(fn: (n: StalenessNotice) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Be told when a root's streak ENDS — the signal a renderer needs to stop showing the notice.
 *  Returns the unsubscribe. */
export function subscribeStalenessResolved(fn: (root: string) => void): () => void {
  resolvedListeners.add(fn);
  return () => resolvedListeners.delete(fn);
}

/** Test-only: forget every streak. Module state outlives a test file otherwise. */
export function resetStalenessEscalation(): void {
  streaks.clear();
}
