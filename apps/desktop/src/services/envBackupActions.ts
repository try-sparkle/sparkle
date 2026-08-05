import {
  envDirsExist,
  envScan,
  opBackup,
  opListBackups,
  opRestore,
  type EnvFile,
  type OpBackupRecord,
  type ScanRoot,
} from "./onepassword";
import {
  backupTitle,
  joinBackups,
  planRestore,
  restoreParentDirs,
  rowsNeedingRestore,
  type EnvBackupRow,
  type RestoreRoot,
  type RestoreSkipReason,
} from "../engine/envBackup";

// Orchestration between the pure drift engine and the IPC layer. Kept out of the component so the
// sequencing — scan, list, join, upload — is testable without rendering anything.

/** Scan every project root and pair the results with what's in the vault. */
export async function loadEnvBackupRows(
  vaultId: string,
  roots: readonly ScanRoot[],
): Promise<EnvBackupRow[]> {
  // Both sides are needed before anything can be judged, and neither depends on the other, so
  // they run concurrently rather than one after the other.
  const [files, records] = await Promise.all([
    envScan(roots as ScanRoot[]),
    opListBackups(vaultId),
  ]);
  return joinBackups(files, records, { roots });
}

/** Result of a "Back up all" run: what succeeded, and what didn't and why. */
export interface BackupRunResult {
  uploaded: number;
  failures: { title: string; error: string }[];
}

/** Back up the given rows, one at a time.
 *
 *  SEQUENTIAL ON PURPOSE. Each upload is an `op` invocation that can raise a Touch ID prompt;
 *  firing several concurrently would stack prompts on the user and race the same vault. Env files
 *  number in the handful, so the wall-clock cost is irrelevant next to that.
 *
 *  A single failure does NOT abort the run — the remaining files are still backed up and every
 *  error is collected. A half-finished backup that reports which half failed is strictly better
 *  than one that stops at the first problem and leaves the user guessing what got through. */
export async function backupRows(
  vaultId: string,
  rows: readonly EnvBackupRow[],
  onProgress?: (done: number, total: number) => void,
): Promise<BackupRunResult> {
  const result: BackupRunResult = { uploaded: 0, failures: [] };
  let done = 0;
  for (const row of rows) {
    const file = row.file;
    // A row with no local file has nothing to upload (missing-locally). rowsNeedingBackup already
    // excludes those; this guard keeps the invariant local rather than assumed.
    if (!file) {
      done++;
      continue;
    }
    try {
      await opBackup({
        vaultId,
        absPath: file.absPath,
        // Derived through the engine, never formatted here — a title built twice is a title that
        // eventually diverges, and a diverged title orphans the backup it was meant to update.
        title: backupTitle(file.projectName, file.relPath),
        sha256: file.sha256,
        // Present → edit in place, preserving 1Password's item history (the user's rollback path).
        itemId: row.record?.itemId,
      });
      result.uploaded++;
    } catch (e) {
      result.failures.push({ title: row.title, error: String(e) });
    }
    onProgress?.(++done, rows.length);
  }
  return result;
}

/** Result of a "Restore all" run.
 *
 *  THREE OUTCOMES, never two. A partial restore that reports only a success count is worse than no
 *  restore at all — `.env` files are precisely the thing you must not leave silently half-present —
 *  so every row lands in exactly one bucket and the caller can name each one. */
export interface RestoreRunResult {
  /** Files actually written to disk. */
  restored: string[];
  /** Rows deliberately not attempted, with the reason. See `planRestore`. */
  skipped: { title: string; reason: RestoreSkipReason }[];
  /** Rows attempted that failed, with `op`'s own message. */
  failures: { title: string; error: string }[];
}

/** Restore every row that exists only in the vault, one at a time.
 *
 *  SEQUENTIAL for the same reason `backupRows` is: each restore is an `op` invocation that can sit
 *  behind a biometric prompt, and firing several concurrently would stack prompts and race the same
 *  vault.
 *
 *  `overwrite` is FALSE on every call and that is not a tunable. These rows are `missing-locally` —
 *  there is nothing on disk to clobber by definition. If a file HAS appeared since the scan (a
 *  concurrent restore, a checkout, a hand-edit), the Rust side refuses rather than destroying it,
 *  and the refusal is reported as a failure. A bulk button must never be the thing that overwrites
 *  a file the user is editing.
 *
 *  A single failure does NOT abort the run — the rest are still restored and every error is kept. */
export async function restoreRows(
  rows: readonly EnvBackupRow[],
  roots: readonly RestoreRoot[],
  onProgress?: (done: number, total: number) => void,
): Promise<RestoreRunResult> {
  const result: RestoreRunResult = { restored: [], skipped: [], failures: [] };
  const candidates = rowsNeedingRestore(rows);
  if (candidates.length === 0) return result;

  // ONE round trip for every destination folder, before any `op` runs. Asking per file would make
  // the plan's cost scale with the row count for a question the filesystem answers in bulk.
  const dirs = restoreParentDirs(rows, roots);
  const existing = new Set<string>();
  const answers = await envDirsExist(dirs);
  dirs.forEach((dir, i) => {
    if (answers[i]) existing.add(dir);
  });

  const plan = planRestore(rows, roots, existing);
  for (const skip of plan.skipped) {
    result.skipped.push({ title: skip.row.title, reason: skip.reason });
  }

  let done = 0;
  for (const target of plan.restore) {
    try {
      await opRestore({ itemId: target.itemId, absPath: target.absPath, overwrite: false });
      result.restored.push(target.row.title);
    } catch (e) {
      result.failures.push({ title: target.row.title, error: String(e) });
    }
    onProgress?.(++done, plan.restore.length);
  }
  return result;
}

/** Project rows from the project store into the scan input the backend expects. */
export function toScanRoots(
  projects: readonly { id: string; name: string; rootPath: string }[],
): ScanRoot[] {
  return projects.map((p) => ({ projectId: p.id, projectName: p.name, rootPath: p.rootPath }));
}

export type { EnvFile, OpBackupRecord };
