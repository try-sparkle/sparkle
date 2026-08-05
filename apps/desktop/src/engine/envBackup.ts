// The drift engine for the 1Password env-backup feature (bead sparkle-ywcl).
//
// PURE BY CONSTRUCTION: no IPC, no Tauri, no React, no filesystem, no clock. Everything here is a
// function over data, which is exactly why every real decision of this feature lives here rather
// than in the settings pane — decisions in a component are decisions you can only verify by
// clicking. The types come from the frozen contract in `../services/onepassword`, imported with
// `import type` so this module stays runnable under plain jsdom with no Tauri runtime present
// (a value import from that file would drag `@tauri-apps/api/core` in and blow up outside the app).
import type { EnvFile, OpBackupRecord, ScanRoot } from "../services/onepassword";

// Titles live in a leaf module both this engine and the IPC boundary can import without any risk
// of a cycle — see backupTitle.ts. Re-exported here because this module is the feature's public
// face and existing callers import them from it.
import {
  backupTitle,
  isTraversal,
  normalizeProjectName,
  normalizeRelPath,
  parseBackupTitle,
} from "./backupTitle";
export { backupTitle, normalizeProjectName, parseBackupTitle } from "./backupTitle";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the pane says about one env file.
 *
 *  `missing-locally` is the fourth state, and it earns its place: a vault item whose on-disk file
 *  is gone (project moved, worktree deleted, file removed) is not "in sync" and not "not backed
 *  up" — it is a backup with no source. Folding it into any of the other three would either
 *  overstate safety or invite a "back up" click with nothing to upload, so the honest thing is to
 *  show it as its own state. It is also the state that tells the user a restore is available. */
export type EnvFileStatus = "in-sync" | "drifted" | "not-backed-up" | "missing-locally";

/** One row of the backup table: a title, and whichever of (file, record) exist for it. */
export interface EnvBackupRow {
  /** `<projectName>/<relPath>` — the join key, and the vault item title. */
  title: string;
  /** Normalized project name (title's first segment). Present for every row, including
   *  `missing-locally` rows where it is recovered from the title. */
  projectName: string;
  /** Normalized project-relative path (the title's remainder). */
  relPath: string;
  /** The scanned file, or `null` when only a vault record exists (`missing-locally`). */
  file: EnvFile | null;
  /** The vault item, or `null` when the file has never been backed up (`not-backed-up`). */
  record: OpBackupRecord | null;
  /** The owning project's id, when a scanned file supplied one. Absent on `missing-locally` rows,
   *  where all we have is a title — so a UI navigating from a row to a project must handle that. */
  projectId?: string;
  /** How many OTHER scanned files collapsed onto this title with DIFFERING contents. Absent (not
   *  0) in the normal case. Non-zero means the pane is showing one row for several genuinely
   *  different files and should say so — the row's status is forced to `drifted` in that case,
   *  since we cannot claim any of them is safely backed up.
   *
   *  NOTE for consumers: because of that forcing, `drifted` does NOT imply `record !== null` — a
   *  conflicted `not-backed-up` row is reported as `drifted` with no record. Anything reaching for
   *  `row.record.itemId` must null-check. Whether a conflicted row is OFFERED for backup depends on
   *  whether the upload would do anything — see `isBackupEligible`: excluded when the kept file is
   *  already in the vault (the click could never clear the conflict, so the button would stay lit
   *  forever), offered when the kept file genuinely differs or was never backed up. */
  conflicts?: number;
  status: EnvFileStatus;
}

/** Normalize a hex digest for comparison: trimmed and lowercased.
 *  The contract says `EnvFile.sha256` is lowercase hex, but the vault side is a free-text custom
 *  field that a human can edit in 1Password, so uppercase on one side must not read as drift. */
function normalizeHash(hash: string): string {
  return hash.trim().toLowerCase();
}

/** Compare a file's hash against its backup's. Drift is determined SOLELY by this comparison —
 *  never by size, never by mtime, both of which change without the contents changing.
 *
 *  An empty hash on either side cannot prove sameness, so it reads as drift. That errs toward
 *  offering a re-backup (cheap, idempotent) rather than claiming a file is safe when we don't
 *  actually know that it is. */
function hashesMatch(fileHash: string, recordHash: string): boolean {
  const a = normalizeHash(fileHash);
  const b = normalizeHash(recordHash);
  if (a === "" || b === "") return false;
  return a === b;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Deterministic, locale-INDEPENDENT string order. `localeCompare` varies by ICU data and would
 *  let the list reorder itself between machines; the UI only needs a stable grouping, so a plain
 *  case-insensitive codepoint compare (with the raw string as tie-break, so `A` and `a` still get
 *  a total order) is both sufficient and reproducible in a test. */
function compareStrings(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareRows(a: EnvBackupRow, b: EnvBackupRow): number {
  return (
    compareStrings(a.projectName, b.projectName) ||
    compareStrings(a.relPath, b.relPath) ||
    compareStrings(a.title, b.title)
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The join
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Options for {@link joinBackups}. */
export interface JoinBackupsOptions {
  /** The roots this scan actually covered. When supplied, vault records belonging to a project
   *  that was NOT scanned are omitted entirely instead of being reported `missing-locally`.
   *
   *  This matters: "the file is gone" and "we never looked for it" are different facts, and
   *  telling the user their `other-project/.env` vanished because they happened to scan only one
   *  project would be a lie the UI can't walk back. Omit this and every unmatched record is
   *  reported as `missing-locally`, which is correct when the scan covered every known project. */
  roots?: readonly ScanRoot[];
}

/** Pair each scanned env file with its vault record by title.
 *
 *  Keyed by the FULL title, never by `relPath` alone — two projects each holding a `.env.local` is
 *  the normal case, and keying by path would silently collapse them into one row and report one
 *  project's hash against the other's file.
 *
 *  Duplicate inputs resolve by two DIFFERENT rules, and the difference is deliberate:
 *    • duplicate FILES (overlapping scan roots, colliding project names, two worktrees of one repo)
 *      collapse per physical file — `(absPath, projectId)`, freshest snapshot kept — and the
 *      survivors resolve to the lowest `absPath`, an intrinsic key, so the winner, its status and
 *      the conflict count are all independent of input order;
 *    • duplicate RECORDS (a duplicated vault item) resolve first-wins in input order, since a
 *      1Password item carries no comparably intrinsic tiebreak. */
export function joinBackups(
  files: readonly EnvFile[],
  records: readonly OpBackupRecord[],
  options: JoinBackupsOptions = {},
): EnvBackupRow[] {
  const recordsByTitle = new Map<string, OpBackupRecord>();
  for (const record of records) {
    const title = backupTitle(...titleParts(record.title));
    if (!recordsByTitle.has(title)) recordsByTitle.set(title, record);
  }

  const rows: EnvBackupRow[] = [];
  const seenTitles = new Set<string>();

  // TWO PHASE, deliberately. Folding the winner and its status together in one pass made both
  // order-dependent: a later winner recomputed `status` from scratch and only re-compared against
  // the file it had just displaced, so an escalation recorded against an EARLIER duplicate was
  // thrown away. With three colliding files (hashes H1, H2, H1 and a vault record of H1) the row
  // could settle on `in-sync` while a genuinely different file sat unbacked — the one lie this pane
  // must never tell — and `conflicts` counted "differed from whoever was kept at the time" rather
  // than from the final winner, so the pane's conflict chip changed with input order.
  //
  // Grouping first makes both a function of the WINNER alone, which is itself chosen by an
  // intrinsic key, so the whole row is independent of how the scan was assembled.
  const byTitle = new Map<string, EnvFile[]>();
  for (const file of files) {
    // A file with no usable TITLE is refused here, exactly as the records loop refuses one:
    //   • a path that normalizes away (traversing/empty relPath — a symlinked scan root, a
    //     hand-typed project root) yields `proj/`, which the records side drops on sight, so
    //     backing it up would create a vault item nothing can ever see again — and every such file
    //     in a project collapses onto that one title;
    //   • a traversing PROJECT NAME (`..`, from a hand-typed root) survives normalizeProjectName —
    //     it only flattens slashes — and yields `../.env.local`, the same unrestorable item via the
    //     other segment. So the check runs on the derived title, not just on the path.
    const title = backupTitle(file.projectName, file.relPath);
    if (normalizeRelPath(file.relPath) === "" || isTraversal(title)) continue;
    const group = byTitle.get(title);
    if (group) group.push(file);
    else byTitle.set(title, [file]);
  }

  for (const [title, group] of byTitle) {
    seenTitles.add(title);
    // WHICH duplicate wins is load-bearing: the winner is the file whose bytes get uploaded under
    // this title. Input order is the user's project order, so first-wins would silently upload a
    // DIFFERENT secret into the same item after a reorder. Pick by an intrinsic key — the lowest
    // absPath — so the choice is stable across runs.
    // ONE physical file is `(absPath, projectId)` — a path under a project registration. Everything
    // else about an entry (hash, size, mtime) is a SNAPSHOT of that file, so two entries sharing the
    // pair are the same file listed twice (a caller concatenating scans, or re-scanning across an
    // edit), never two files in conflict. Collapse them BEFORE choosing a winner or counting
    // conflicts, or a re-scanned file ends up warning about itself.
    //
    // Freshest snapshot wins the collapse: the bytes are re-read from disk at upload time, so
    // backing up a STALE digest records a sha that doesn't match what was uploaded and the row then
    // reports drift forever. `sha256` breaks a same-mtime tie only to keep the result deterministic.
    const distinct = new Map<string, EnvFile>();
    for (const f of group) {
      // JSON rather than a joined string: no separator character can collide with a path.
      const id = JSON.stringify([f.absPath, f.projectId]);
      const held = distinct.get(id);
      if (!held) {
        distinct.set(id, f);
        continue;
      }
      // ONE comparison rather than a freshness test plus a separate `===` tie test. Those two agree
      // TODAY — `compareStrings` returns 0 iff the strings are identical, because it falls back to a
      // raw compare precisely so `A` and `a` still get a total order — but only because of that
      // fallback. Deriving the tie from the same comparison that decides the order means they
      // cannot drift apart if `compareStrings` ever changes.
      //
      // An unreadable mtime reaches us as "" (the Rust side's unwrap_or_default), so two such
      // entries tie and the sha decides: deterministic, though it cannot tell which is newer.
      const fresher =
        compareStrings(f.modifiedAt, held.modifiedAt) || compareStrings(held.sha256, f.sha256);
      if (fresher > 0) distinct.set(id, f);
    }
    const distinctFiles = [...distinct.values()];

    // Among DISTINCT files the winner is the lowest absPath, with projectId as the tiebreak for two
    // registrations of one directory — an intrinsic key either way, so the winner (and `row.file`,
    // `row.status`, `row.projectId`, and the bytes uploaded) never depends on scan order.
    let winner = distinctFiles[0]!;
    for (const f of distinctFiles) {
      const byKey =
        compareStrings(f.absPath, winner.absPath) || compareStrings(f.projectId, winner.projectId);
      if (byKey < 0) winner = f;
    }

    // Counted over DISTINCT files, so a duplicate listing — of the winner or of a loser — can never
    // inflate it. One rule for the rest: count a file unless it is PROVABLY the same bytes as the
    // winner. An unknown hash is not evidence of sameness, and the alternative — collapsing two
    // real files into one row with no warning — is the lie this pane must not tell. A conservative
    // extra warning costs the user a look; a missing one costs them a secret.
    let conflicts = 0;
    for (const f of distinctFiles) {
      if (f !== winner && !hashesMatch(winner.sha256, f.sha256)) conflicts++;
    }

    const record = recordsByTitle.get(title) ?? null;
    const { projectName, relPath } = parseBackupTitle(title);
    // A conflicted row can never be `in-sync`, whatever the winner's own hash says: some other file
    // under this title is unbacked, and only one of them can occupy the item.
    const status: EnvFileStatus =
      conflicts > 0
        ? "drifted"
        : record === null
          ? "not-backed-up"
          : hashesMatch(winner.sha256, record.sha256)
            ? "in-sync"
            : "drifted";

    rows.push({
      title,
      projectName,
      relPath,
      projectId: winner.projectId,
      file: winner,
      record,
      status,
      ...(conflicts > 0 ? { conflicts } : {}),
    });
  }

  const scanned = options.roots
    ? new Set(options.roots.map((r) => normalizeProjectName(r.projectName)))
    : null;

  for (const [title, record] of recordsByTitle) {
    if (seenTitles.has(title)) continue;
    const { projectName, relPath } = parseBackupTitle(title);
    // A title with no path component (`orphan`, hand-edited in 1Password) cannot address a file:
    // re-deriving it would produce `orphan/`, which is NOT the item's real title, and OpBackupArgs
    // requires a title — so a re-backup from such a row would write to a different item than the
    // one it meant to edit. Likewise a traversing title can never be safely restored. Neither is
    // actionable, so neither becomes a row.
    // isTraversal runs on the record's RAW title, which is where a `..` can actually survive:
    // `relPath` here came through normalizeRelPath, which already collapses a traversing path to
    // "". Checking the raw title keeps the guard meaningful instead of dead.
    if (relPath === "" || isTraversal(record.title)) continue;
    if (scanned && !scanned.has(projectName)) continue;
    seenTitles.add(title);
    // Carry the record's OWN title, not the re-derived one, so any later write targets the item
    // that actually exists in the vault.
    rows.push({ title: record.title, projectName, relPath, file: null, record, status: "missing-locally" });
  }

  return rows.sort(compareRows);
}

/** Re-derive a canonical title from whatever a record carries, so a vault item written by an older
 *  build (or hand-titled with a backslash) still joins against today's files. */
function titleParts(title: string): [string, string] {
  const { projectName, relPath } = parseBackupTitle(title);
  return [projectName, relPath];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Counts the pane renders, plus the booleans the two bulk buttons bind to. */
export interface EnvBackupSummary {
  total: number;
  inSync: number;
  drifted: number;
  notBackedUp: number;
  missingLocally: number;
  /** Exactly the number of files a "Restore all" click would ATTEMPT — i.e.
   *  `rowsNeedingRestore(rows).length`. Not every attempt writes a file: a row whose destination
   *  lives inside a worktree this machine has never cut is skipped at plan time (see
   *  {@link planRestore}), which needs the filesystem and so cannot be known here. The button
   *  therefore promises an attempt count, and the run reports what actually landed. */
  needsRestore: number;
  /** True iff a "Restore all" click would attempt anything. `missing-locally` is the only status
   *  with a vault copy and no local file, so it is the only one a restore acts on: restoring an
   *  `in-sync` row rewrites identical bytes, and restoring a `drifted` one would discard local
   *  edits without asking — that is the single-file confirm path, not a bulk button. */
  canRestoreAll: boolean;
  /** Exactly the number of files a "Back up all" click would upload — i.e.
   *  `rowsNeedingBackup(rows).length`, computed from the same predicate so the count and the action
   *  can never disagree. NOT simply `drifted + notBackedUp`: a conflicted row whose kept file is
   *  already in the vault is `drifted` but has nothing to upload. */
  needsBackup: number;
  /** True iff a "Back up all" click would do real work. The button is disabled on `false`, so this
   *  must be `needsBackup > 0` and nothing looser: counting `missing-locally` here (there is no
   *  local file to read) or `in-sync` (the bytes are already in the vault) would enable a button
   *  whose click is a no-op, which reads to the user as the feature being broken. */
  canBackUpAll: boolean;
}

export function summarize(rows: readonly EnvBackupRow[]): EnvBackupSummary {
  let inSync = 0;
  let drifted = 0;
  let notBackedUp = 0;
  let missingLocally = 0;
  for (const row of rows) {
    switch (row.status) {
      case "in-sync":
        inSync++;
        break;
      case "drifted":
        drifted++;
        break;
      case "not-backed-up":
        notBackedUp++;
        break;
      case "missing-locally":
        missingLocally++;
        break;
      default: {
        // Exhaustiveness guard: a fifth status must break the BUILD here, not silently break the
        // `total === inSync + drifted + notBackedUp + missingLocally` invariant at runtime. The
        // THROW matters as much as the type: a row arriving from IPC with an unexpected status
        // would otherwise return a bare string from a function typed to return a summary, and
        // every caller would read `undefined` counts instead of failing loudly.
        const _never: never = row.status;
        throw new Error(`unhandled env backup status: ${String(_never)}`);
      }
    }
  }
  // ONE predicate behind both the count and the action. When these were computed separately, the
  // pane rendered an enabled "Back up 1" whose click uploaded nothing.
  const needsBackup = rows.filter(isBackupEligible).length;
  const needsRestore = rows.filter(isRestoreEligible).length;
  return {
    total: rows.length,
    inSync,
    drifted,
    notBackedUp,
    missingLocally,
    needsBackup,
    canBackUpAll: needsBackup > 0,
    needsRestore,
    canRestoreAll: needsRestore > 0,
  };
}

/** Whether a "Back up all" click would actually upload this row.
 *
 *  `in-sync` is excluded because re-uploading identical bytes just adds a redundant version to the
 *  item's 1Password history; `missing-locally` is excluded because there is no file on disk to
 *  upload — that row's action is a RESTORE, which is a different button.
 *
 *  A CONFLICTED row is the subtle case, and the answer is not a blanket exclusion. The row stands
 *  for several different files sharing one title, and a backup can only upload the KEPT one:
 *    • kept file already matches its vault item → uploading changes nothing, and the next join
 *      re-derives the same conflict, so the button would stay lit forever, adding a redundant
 *      version per click. Not eligible. Resolve it by renaming a project or dropping an
 *      overlapping scan root.
 *    • kept file genuinely differs from the vault (or has no item at all) → the upload is real
 *      work on a real unbacked-up secret, and refusing it would leave that secret unbackable with
 *      no other route. Eligible; the conflict warning stays on the row either way. */
function isBackupEligible(row: EnvBackupRow): boolean {
  if (row.status !== "drifted" && row.status !== "not-backed-up") return false;
  if (!row.conflicts) return true;
  return !(row.record !== null && row.file !== null && hashesMatch(row.file.sha256, row.record.sha256));
}

/** What "Back up all" actually operates on, in display order. See {@link isBackupEligible} — the
 *  same predicate feeds `summarize().needsBackup`, so the button's count can't lie about its click. */
export function rowsNeedingBackup(rows: readonly EnvBackupRow[]): EnvBackupRow[] {
  return rows.filter(isBackupEligible);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Restore — the DOWN direction
//
// The feature shipped with bulk UP and single-file DOWN, which made a portability feature work in
// exactly one direction: a second machine showed a wall of "Only in vault" rows, a primary button
// reading "Back up 0", and no way to bring anything down (bead sparkle-y5xc9). Everything below is
// the mirror of the backup half above — same shape, same one-predicate-behind-count-and-action rule.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a "Restore all" click would attempt this row.
 *
 *  `missing-locally` and nothing else. The other three states all have a local file, and a bulk
 *  button must not touch one: `in-sync` would rewrite identical bytes, and `drifted` /
 *  `not-backed-up` would discard local edits. Overwriting a file the user is editing is the one
 *  irreversible thing this feature can do, so it stays behind the single-file confirm. */
function isRestoreEligible(row: EnvBackupRow): boolean {
  return row.status === "missing-locally" && row.record !== null;
}

/** What "Restore all" attempts, in display order. Same predicate as `summarize().needsRestore`. */
export function rowsNeedingRestore(rows: readonly EnvBackupRow[]): EnvBackupRow[] {
  return rows.filter(isRestoreEligible);
}

/** A project root a restore can write into, projected from the project store. */
export interface RestoreRoot {
  projectName: string;
  rootPath: string;
}

/** Why a candidate row will not be written. Both reasons are reported to the user rather than
 *  silently dropped — a restore that quietly skips files is the failure mode this pane exists to
 *  avoid, since a half-present set of `.env` files is worse than none. */
export type RestoreSkipReason =
  /** No registered project matches the title's first segment, so there is no root to write under. */
  | "unknown-project"
  /** The destination folder is inside a worktree this machine has never cut. See {@link planRestore}. */
  | "worktree-missing";

/** One row paired with the absolute path its bytes would land at. */
export interface RestoreTarget {
  row: EnvBackupRow;
  /** The vault item to download. Non-null by construction — `isRestoreEligible` requires a record. */
  itemId: string;
  absPath: string;
}

export interface RestoreSkip {
  row: EnvBackupRow;
  reason: RestoreSkipReason;
}

export interface RestorePlan {
  restore: RestoreTarget[];
  skipped: RestoreSkip[];
}

/** Join a root path and a project-relative path. Trailing separators on the root are stripped so a
 *  root stored as `/Users/dev/proj/` cannot produce a doubled slash — the path is handed to the
 *  filesystem, and `//` is the one form POSIX leaves implementation-defined. */
export function joinPath(rootPath: string, relPath: string): string {
  return `${rootPath.replace(/[/\\]+$/, "")}/${normalizeRelPath(relPath)}`;
}

/** The directory a restored file would land in — everything before the last separator. */
export function parentDir(absPath: string): string {
  const cut = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  return cut <= 0 ? absPath.slice(0, Math.max(cut, 0)) : absPath.slice(0, cut);
}

/** Whether a project-relative path lives inside a git worktree slot (`.claude/worktrees/<name>/…`,
 *  `.git/worktrees/…`). Checked on SEGMENTS, never as a substring, so a project directory honestly
 *  named `my-worktrees-notes` is not mistaken for one. */
export function isInsideWorktreeSlot(relPath: string): boolean {
  const parts = normalizeRelPath(relPath).split("/");
  // The last segment is the FILE. A file literally named `worktrees` is not a worktree slot.
  return parts.slice(0, -1).some((s) => s === "worktrees");
}

/** Every destination folder {@link planRestore} needs an existence answer for, deduplicated.
 *  Handed to `envDirsExist` so a bulk restore costs ONE filesystem round trip, not one per file. */
export function restoreParentDirs(
  rows: readonly EnvBackupRow[],
  roots: readonly RestoreRoot[],
): string[] {
  const byName = rootsByProjectName(roots);
  const dirs = new Set<string>();
  for (const row of rowsNeedingRestore(rows)) {
    const root = byName.get(row.projectName);
    if (root) dirs.add(parentDir(joinPath(root, row.relPath)));
  }
  return [...dirs];
}

function rootsByProjectName(roots: readonly RestoreRoot[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const r of roots) {
    // Titles were written through `normalizeProjectName`, so the lookup has to speak the same
    // dialect — a project named `acme/web` is stored as `acme-web/…` and would never match raw.
    const key = normalizeProjectName(r.projectName);
    if (!byName.has(key)) byName.set(key, r.rootPath);
  }
  return byName;
}

/** Decide, for every restorable row, whether to write it and where.
 *
 *  THE ONE JUDGEMENT CALL, stated explicitly: a row whose destination folder does not exist AND
 *  whose path lies inside a worktree slot is SKIPPED, not created.
 *
 *  Creating it would be actively harmful, not merely untidy. `git worktree add <path>` refuses a
 *  path that already exists and is non-empty, so materialising `.claude/worktrees/foo/` just to
 *  hold a `.env.local` breaks the later `git worktree add` that wants that slot — the exact failure
 *  `envSeed.ts` already documents on the teardown path. It also leaves a plaintext secret in a
 *  directory that is inside no checkout, that nothing will ever clean up, and that no agent will
 *  ever read. And it buys nothing: worktrees are seeded from the project checkout now, so a
 *  worktree cut later gets its env files without this row existing at all.
 *
 *  Every OTHER missing folder is created by the restore itself (the Rust side's `create_dir_all`).
 *  An `apps/web/.env.local` whose `apps/web` is absent on this branch is an ordinary restore: the
 *  directory is part of the project, not a slot something else owns. */
export function planRestore(
  rows: readonly EnvBackupRow[],
  roots: readonly RestoreRoot[],
  existingDirs: ReadonlySet<string>,
): RestorePlan {
  const byName = rootsByProjectName(roots);
  const restore: RestoreTarget[] = [];
  const skipped: RestoreSkip[] = [];
  for (const row of rowsNeedingRestore(rows)) {
    const root = byName.get(row.projectName);
    if (root === undefined) {
      skipped.push({ row, reason: "unknown-project" });
      continue;
    }
    const absPath = joinPath(root, row.relPath);
    if (!existingDirs.has(parentDir(absPath)) && isInsideWorktreeSlot(row.relPath)) {
      skipped.push({ row, reason: "worktree-missing" });
      continue;
    }
    // Non-null by construction: `rowsNeedingRestore` filters on `record !== null`.
    restore.push({ row, itemId: row.record!.itemId, absPath });
  }
  return { restore, skipped };
}
