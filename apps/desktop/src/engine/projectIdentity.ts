// "Is this project ALREADY OPEN?" — the pure rules behind an idempotent project open.
//
// THE BUG THIS EXISTS FOR. The founder had one repository on screen twice: `/Users/…/Projects/
// sparkle` in the right pair and `/Users/…/Projects/sparkle-desktop` in the left. Those are two
// different folders, so every dedupe the app had — `services/openTarget.resolveOpenTarget`'s
// case-folded path compare and `conciergeTools/workspace.addProjectFromFolder`'s exact one — was
// correct in its own terms and still produced two tabs. `sparkle-desktop` is a linked git WORKTREE
// of `sparkle` (`git rev-parse --git-common-dir` resolves to the same `.git`), and a human calls
// that "the same project".
//
// So identity here is the REPOSITORY, not the path:
//
//     two projects are the same project when they share a repo key,
//     falling back to the normalized path when a repo key is unknown.
//
// WHY A FALLBACK AND NOT JUST THE REPO KEY. A repo key is resolved by a git subprocess
// (`services/repoKey`), so it is absent for a folder that is not a repo, for a project recorded
// before this change and not yet backfilled, and for the moment between hydrate and the first
// sweep. Falling back to the path makes the rule TOTAL and monotonic: with no keys it degrades to
// exactly the path dedupe the app already had, and each key that arrives can only ever merge two
// records, never split one. There is no state in which this is weaker than what it replaced.
//
// WHY IT NEVER FORBIDS. Sparkle's whole agent model is worktrees, and opening two worktrees of one
// repo side by side is a real thing to want (compare a branch against main). The founder chose
// "warn + focus, allow override" over a hard refusal for exactly that reason. So this module
// answers a QUESTION — "what is already open that is the same as this?" — and the callers focus the
// incumbent and say so. `DuplicateOpen` carries everything the copy needs; nothing here decides to
// block, and no caller may use it to.
//
// Pure (no store, no React, no Tauri) so every rule below is unit-testable on its own — the same
// split engine/openProjects.ts and engine/pairs.ts use.

import { normalizeProjectPath } from "../services/openTarget";
import type { PairAssignment, PairSide } from "./pairs";
import { sideOf } from "./pairs";
import { isProjectOpen, type OpenProjectIds } from "./openProjects";

/** The minimum a project has to expose to be compared. `Project` satisfies it structurally. */
export interface IdentifiableProject {
  id: string;
  name: string;
  rootPath: string;
  /** Canonical `.git` common dir — see services/repoKey. Absent until resolved; never invented. */
  repoKey?: string | null;
}

/**
 * A folder path in the one form two spellings of the same folder agree on.
 *
 * `services/openTarget.normalizeProjectPath` composed with a case fold.
 *
 * This USED to be a hand copy of that expression, justified here on the grounds that "the engine
 * may not depend on a service (every other `engine/*` module holds that line)". THAT RULE DOES NOT
 * EXIST. No lint rule, eslint config, or dependency check anywhere in the repo enforces an
 * engine→services boundary, and MOST non-test `engine/*` modules import from `../services` today —
 * `statusEngine`, `agentCta`, `workerAttention`, `screenClassifier`, `quotaBlock`, `epicFocus` and
 * many more take VALUES, not just types.
 *
 * `openTarget` is in any case a zero-import pure leaf (no store, no React, no Tauri, by its own
 * header), so importing it costs this module none of the properties it actually holds.
 *
 * DON'T TRUST THE NUMBER, RE-MEASURE IT. This paragraph used to hard-code a count of twelve. That
 * was accurate the day it was written and had grown by the time anyone re-read it — an unbacked
 * integer in prose is the same defect one layer down (bead sparkle-4r68r7, AGENTS.md meta-rule 1).
 * One line settles it:
 * `grep -l 'from "\.\./services' apps/desktop/src/engine/*.ts | grep -vc '\.test\.'`
 *
 * NOR WAS THIS THE ONLY PLACE THE RULE WAS STATED, as this comment once claimed it was.
 * `engine/humanBlock.ts` and `engine/loginStanddown.ts` each restated it to justify hand-restating
 * `services/authRecovery.NudgeFlag` instead of importing it; all three sites now record it as
 * false, and `engine/nudgeFlagWireDrift.test.ts` pins the drift those two were carrying unguarded.
 *
 * The copy was also less safe than it read. Its drift pin fed only ASCII, lowercase,
 * trailing-slash inputs, so it pinned the separator strip and NOTHING ELSE: deleting
 * `.normalize("NFC")` from either side left the pin — and every other test in the desktop suite —
 * green, while silently breaking the NFD/NFC dedupe that is one of the two reasons the
 * normalization exists at all. One implementation cannot drift from itself, so composing DELETES
 * that failure mode rather than testing for it.
 *
 * Case-folded for the default case-insensitive macOS volume; NFC-normalized (inside
 * `normalizeProjectPath`) because the native picker hands back NFD for accented segments while a
 * typed or stored path is usually NFC — the two compare unequal as UTF-16 and name the same
 * directory.
 */
export function pathKey(rootPath: string): string {
  return normalizeProjectPath(rootPath).toLowerCase();
}

/**
 * The value two projects are compared ON.
 *
 * Prefixed by kind so a repo key can never collide with a path key. They are both absolute paths
 * and a `.git` common dir IS a real directory, so without the prefix a project whose ROOT happened
 * to be another project's `.git` dir would read as the same project.
 */
export function identityKey(p: IdentifiableProject): string {
  const repo = p.repoKey?.trim();
  return repo ? `repo:${pathKey(repo)}` : `path:${pathKey(p.rootPath)}`;
}

/** Do these two records name the same project? Reflexive, symmetric, and total. */
export function isSameProject(a: IdentifiableProject, b: IdentifiableProject): boolean {
  return identityKey(a) === identityKey(b);
}

/**
 * What an "already open" notice needs to say, and where to send the user.
 *
 * `viaWorktree` is the distinction the copy turns on, and it is why this is a record rather than a
 * bare project. "sparkle is already open" is confusing when the tab the user is looking for says
 * `sparkle-desktop` — the two records have DIFFERENT names, and a message naming only the incumbent
 * would read as being about some other project entirely. The founder's own case is this one.
 */
export interface DuplicateOpen {
  /** The project that already holds a tab — the one to focus. */
  existing: IdentifiableProject;
  /** Which pair is showing it. */
  side: PairSide;
  /** True when the match came from the repo key over DIFFERENT folders — i.e. a linked worktree. */
  viaWorktree: boolean;
}

/**
 * The already-open project that `candidate` duplicates, or `null`.
 *
 * `candidate` may be a project record that exists (a reopen, a concierge open) or a synthetic one
 * standing for a folder the user just picked and that has no record yet — which is the case that
 * has to work, because that is where a SECOND RECORD would be created.
 *
 * Excludes the candidate itself by id, so re-opening a project that is already open reports no
 * duplicate against itself. That case is not "a duplicate"; it is an ordinary idempotent open, and
 * `openAlreadyOpen` below is the predicate for it.
 *
 * Only OPEN projects count. A closed project shares its repo with nothing on screen — reopening it
 * cannot put two tabs of one repo up, because closing is a view operation that leaves the record
 * alone (engine/openProjects). Refusing on a closed record would resurrect the exact defect
 * `ProjectTabsBar`'s picker refusal was narrowed to avoid: telling the user something "is already
 * open" about a project that is not open anywhere.
 */
export function findDuplicateOpen(
  candidate: IdentifiableProject,
  projects: readonly IdentifiableProject[],
  openIds: OpenProjectIds,
  assignment: PairAssignment,
): DuplicateOpen | null {
  const key = identityKey(candidate);
  const candidatePath = pathKey(candidate.rootPath);
  for (const p of projects) {
    if (p.id === candidate.id) continue;
    if (identityKey(p) !== key) continue;
    if (!isProjectOpen(p.id, openIds)) continue;
    return {
      existing: p,
      side: sideOf(assignment, p.id),
      // Same repo, different folder → a linked worktree. Same folder is an ordinary duplicate
      // record, which is a different sentence.
      viaWorktree: pathKey(p.rootPath) !== candidatePath,
    };
  }
  return null;
}

/** Is THIS EXACT project already showing a tab? The idempotent-open predicate, distinct from
 *  `findDuplicateOpen`, which is about a DIFFERENT record naming the same project. */
export function openAlreadyOpen(
  projectId: string,
  openIds: OpenProjectIds,
): boolean {
  return isProjectOpen(projectId, openIds);
}

/**
 * The sentence shown when an open is deduped.
 *
 * Follows the app's established shape for this idea — AgentPill's `"<name> is already open in
 * <where>."` — so there is ONE convention for "you already have that", not two. `where` is the pair
 * rather than a project, because that is the thing a user can act on here.
 *
 * It NAMES BOTH FOLDERS in the worktree case. "sparkle is already open in the left pair" sends
 * someone hunting for a tab labelled `sparkle` when the tab actually says `sparkle-desktop`; the
 * message has to close that gap itself, because the tab cannot.
 *
 * No imperative ("switch to that strip to see it") — the caller has already focused the incumbent
 * by the time this renders, so telling the user to go do it would describe work that is done. A
 * remedy string is an instruction the user will follow (AGENTS.md), and the remedy here is "look,
 * it is in front of you".
 */
export function alreadyOpenMessage(dup: DuplicateOpen, candidateName: string): string {
  const where = `the ${dup.side} pair`;
  if (!dup.viaWorktree) return `${dup.existing.name} is already open in ${where}.`;
  return (
    `${candidateName} is the same repository as ${dup.existing.name}, ` +
    `which is already open in ${where}.`
  );
}
