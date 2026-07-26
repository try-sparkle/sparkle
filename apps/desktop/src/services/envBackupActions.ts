import {
  envScan,
  opBackup,
  opListBackups,
  type EnvFile,
  type OpBackupRecord,
  type ScanRoot,
} from "./onepassword";
import { backupTitle, joinBackups, type EnvBackupRow } from "../engine/envBackup";

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

/** Project rows from the project store into the scan input the backend expects. */
export function toScanRoots(
  projects: readonly { id: string; name: string; rootPath: string }[],
): ScanRoot[] {
  return projects.map((p) => ({ projectId: p.id, projectName: p.name, rootPath: p.rootPath }));
}

export type { EnvFile, OpBackupRecord };
