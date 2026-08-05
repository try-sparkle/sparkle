import { invoke } from "@tauri-apps/api/core";
// A LEAF module, deliberately: `normalizeProjectName` is the single definition of how a project
// name becomes a title segment, and this boundary must speak the same dialect the titles were
// written in. Importing it from the engine would put a value edge back into a module that imports
// this one (type-only today) — a cycle waiting for someone to add a value import. backupTitle.ts
// imports nothing, so neither direction can ever cycle.
import { normalizeProjectName } from "../engine/backupTitle";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The FROZEN IPC contract for the 1Password env-backup feature (bead sparkle-ywcl).
//
// Every unit of this feature — the Rust backend, the drift engine, the settings pane, and the
// worktree auto-seed — is written against the types and command names in THIS file. It is the
// single point of agreement between units built in parallel, so treat the shapes below as fixed:
// widen them in a follow-up, don't redefine them mid-build.
//
// WHY THIS FEATURE EXISTS. `.env` and `.env.*` are gitignored (.gitignore:44-47), so a git
// worktree never carries one. Sparkle cuts a fresh worktree for every worker agent, which means
// every agent starts life missing the secrets its project needs — `naming.rs:91-130` already
// hardcodes a `$HOME/Projects/sparkle/.env.local` fallback purely to paper over this. Backing the
// files up to 1Password and restoring them into new worktrees fixes the cause.
//
// WHY IT CAN BE ONE CLICK. 1Password 8 exposes a CLI↔desktop-app integration (1Password →
// Settings → Developer → "Integrate with 1Password CLI"). With it enabled, `op` authenticates via
// Touch ID through the already-unlocked desktop app: no `op signin`, no session token, no account
// entry, and no credential ever passing through Sparkle. Sparkle's whole job is to install `op`,
// confirm that toggle, and remember a vault id.
//
// SECURITY INVARIANTS — every unit is bound by these:
//   • Secret CONTENTS never cross this boundary. `op` reads and writes the real file on disk
//     directly (`op document create <path>` / `op document get --output <path>`), so plaintext
//     never lands in a temp file, a log line, an event payload, or the PTY transcript.
//   • Only ids and hashes are persisted in Sparkle's config: a vault id, item ids, and content
//     hashes. Never a value, never a filename's contents.
//   • Restores that would clobber a differing file on disk require an explicit confirmation.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How far along the user is toward a working `op`. Drives which affordance the Tools pane shows. */
export type OpReadiness =
  /** `op` is not installed — offer `brew install --cask 1password-cli`. */
  | "cli-missing"
  /** `op` runs but reports no authenticated account — the desktop-app integration toggle is off. */
  | "integration-off"
  /** `op` runs and is authenticated, but several accounts are signed in and none has been chosen
   *  (or the chosen one is no longer signed in). Every vault call would fail with "multiple
   *  accounts found", so this is a needs-setup state — show the account picker, not the table. */
  | "account-ambiguous"
  /** `op` runs, is authenticated, and the account to act as is unambiguous. Backup/restore are
   *  available. */
  | "ready";

/** One signed-in 1Password account. Mirrors Rust `OpAccount`.
 *
 *  KEY ON `userUuid`, NEVER on email: a person can be signed in to two accounts under the SAME
 *  email (a personal one and a family/team membership), and those rows are identical in every other
 *  field. An email-keyed picker cannot express the choice between them. */
export interface OpAccount {
  /** Sign-in address, e.g. `my.1password.com`. */
  url: string | null;
  email: string | null;
  /** The stable identifier persisted as `[onepassword].account_id` and passed as `--account`. */
  userUuid: string;
  /** Account (rather than user) uuid, when `op` reports one. */
  accountUuid: string | null;
}

/** Result of probing the `op` CLI. Mirrors Rust `OpStatus`. */
export interface OpStatus {
  readiness: OpReadiness;
  /** Absolute path to the `op` binary — pass to subsequent calls so PATH is resolved once. */
  path: string | null;
  /** `op --version` output, when it resolves. */
  version: string | null;
  /** The signed-in account's sign-in address (e.g. `my.1password.com`), when authenticated. */
  accountUrl: string | null;
  /** The account `op` will actually act as — the chosen one, or the only one signed in. Null while
   *  the choice is still ambiguous. */
  accountId: string | null;
  /** Every signed-in account, for the picker. Carried on the status rather than fetched by a
   *  separate command: the probe already ran `op account list`, and a second run is a second Touch
   *  ID prompt. Empty when `op` couldn't enumerate them. */
  accounts: OpAccount[];
  /** Present when the probe failed for a reason the user can act on; already redacted for display. */
  error: string | null;
}

/** Probe the `op` CLI: installed? authenticated? Resolved via the LOGIN shell, because a
 *  Finder/Dock-launched macOS app does not inherit the shell PATH that Homebrew installs into.
 *  The resolved path is cached per app session — see {@link refreshOpPreflight}. */
export function opPreflight(): Promise<OpStatus> {
  return invoke<OpStatus>("op_preflight");
}

/** Drop the cached `op` path and re-probe — call after installing the CLI or flipping the
 *  desktop-app integration toggle, so the pane reflects reality without an app restart. */
export function refreshOpPreflight(): Promise<OpStatus> {
  return invoke<OpStatus>("op_refresh");
}

/** Install the 1Password CLI via Homebrew (`brew install --cask 1password-cli`) and re-probe.
 *  Rejects with a displayable message when Homebrew is absent or the install fails. */
export function installOpCli(): Promise<OpStatus> {
  return invoke<OpStatus>("op_install");
}

/** A vault the signed-in account can write to. Mirrors Rust `OpVault`. */
export interface OpVault {
  id: string;
  name: string;
}

/** List the account's vaults (`op vault list`), for the one-time vault picker. */
export function opVaults(): Promise<OpVault[]> {
  return invoke<OpVault[]>("op_vaults");
}

/** A project root to scan, projected from the project store so Rust needs no store access. */
export interface ScanRoot {
  projectId: string;
  projectName: string;
  rootPath: string;
}

/** An env file found on disk. Mirrors Rust `EnvFile`. Carries a hash, never contents. */
export interface EnvFile {
  projectId: string;
  projectName: string;
  /** Path relative to the project root, e.g. `.env.local` or `apps/web/.env.local`. */
  relPath: string;
  /** Absolute path — passed straight to `op` for backup/restore. */
  absPath: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the file's bytes. The sole basis for drift detection. */
  sha256: string;
  /** Last-modified time, ISO 8601. */
  modifiedAt: string;
}

/** Find every `.env*` file under the given project roots.
 *
 *  Excludes `.env.example` and any other `*.example`/`*.sample` template (they're committed and
 *  carry no secrets), skips `node_modules`, `.git`, `target`, and `dist`, and bounds recursion to
 *  a few levels so a monorepo scan stays fast. */
export function envScan(roots: ScanRoot[]): Promise<EnvFile[]> {
  return invoke<EnvFile[]>("env_scan", { roots });
}

/** A Document item in the vault that Sparkle wrote. Mirrors Rust `OpBackupRecord`. */
export interface OpBackupRecord {
  /** 1Password item id — the stable handle for restore and re-backup. */
  itemId: string;
  /** `<projectName>/<relPath>`, e.g. `sparkle/.env.local`. Stable across versions of the file. */
  title: string;
  /** SHA-256 of the bytes as they were at backup time, stored on the item as a custom text field
   *  named `sparkle_sha256`. Comparing this to {@link EnvFile.sha256} is what surfaces drift. */
  sha256: string;
  /** When the item was last updated in 1Password, ISO 8601. */
  updatedAt: string;
}

/** List the Document items Sparkle has written to this vault (filtered by the `` tag),
 *  so the pane can pair each on-disk file with its vault copy. */
export function opListBackups(vaultId: string): Promise<OpBackupRecord[]> {
  return invoke<OpBackupRecord[]>("op_list_backups", { vaultId });
}

/** Arguments for {@link opBackup}. */
export interface OpBackupArgs {
  vaultId: string;
  /** Absolute path of the file to upload — `op` reads it directly; Sparkle never buffers it. */
  absPath: string;
  /** `<projectName>/<relPath>`. Identifies the item; reused on every subsequent backup. */
  title: string;
  /** Hash of the bytes being uploaded, recorded on the item for later drift comparison. */
  sha256: string;
  /** Existing item to update in place (`op document edit`), creating a new version in 1Password's
   *  item history. Omit to create (`op document create`). */
  itemId?: string;
}

/** Back a single env file up to the vault, as a Document item tagged ``.
 *
 *  Creating vs. editing matters: editing an existing item preserves 1Password's item history, so
 *  the user keeps every prior version of the file and can roll back inside 1Password itself.
 *  Returns the resulting record so the caller can update its drift state without a re-list. */
export function opBackup(args: OpBackupArgs): Promise<OpBackupRecord> {
  return invoke<OpBackupRecord>("op_backup", { args });
}

/** Arguments for {@link opRestore}. */
export interface OpRestoreArgs {
  itemId: string;
  /** Absolute destination path. Parent directories are created as needed. */
  absPath: string;
  /** Required to overwrite an existing file whose contents differ. Without it, a differing file
   *  on disk makes the restore fail rather than silently destroying uncommitted local edits — the
   *  one irreversible thing this feature can do. A byte-identical file is a no-op either way. */
  overwrite: boolean;
}

/** Restore one backed-up env file to disk, written with `0600` permissions. */
export function opRestore(args: OpRestoreArgs): Promise<void> {
  return invoke<void>("op_restore", { args });
}

/** Which of these paths are directories that exist on this machine, in the same order.
 *
 *  A plain filesystem probe — no `op`, no secrets, no prompt. It exists so the restore planner can
 *  tell "the folder is there, write into it" from "this row's folder is a worktree this machine has
 *  never cut", which is a decision that must not be guessed at (see `planRestore`). One call covers
 *  every destination, so a bulk restore adds exactly one IPC round trip, not one per file. */
export function envDirsExist(paths: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("env_dirs_exist", { paths });
}

/** Copy every backup-worthy `.env*` file from `sourceRoot` into `destRoot` at the same relative
 *  path, and return the relative paths actually written.
 *
 *  THIS IS THE WORKTREE SEED PATH, and it deliberately does not touch 1Password.
 *
 *  A worktree's `.env.local` is a copy of the one already sitting in the project checkout, so the
 *  vault was never the nearest source — it was just the one we happened to build first. Going
 *  through `op` made every agent spawn a sporadic CLI invocation, and 1Password's app-integration
 *  authorization is granted to the CALLING PROCESS (Sparkle) and expires after ten minutes of
 *  inactivity. Sporadic is exactly the shape that re-prompts: one burst per spawn, then silence, so
 *  a fleet of agents opened over an afternoon re-authorized once per agent (bead sparkle-y5xc9).
 *  A local copy makes the spawn path incapable of prompting because it makes no call at all.
 *
 *  Never overwrites: a file already present in the destination is left untouched and omitted from
 *  the result. Files inside a `worktrees/` path segment are skipped — those are themselves seeded
 *  copies, and re-seeding them would nest one worktree's env files inside another's. */
export function envSeedFromCheckout(sourceRoot: string, destRoot: string): Promise<string[]> {
  return invoke<string[]>("env_seed_from_checkout", { sourceRoot, destRoot });
}

/** Restore every `` document belonging to `projectName` into `destRoot`, recreating the
 *  relative layout the titles encode. Returns the relative paths actually written.
 *
 *  This is the worktree auto-seed entry point: a freshly cut agent worktree has no `.env.local`,
 *  and this is what puts it there. Never overwrites — a file already present in the destination is
 *  left untouched and omitted from the result.
 *
 *  Pass the RAW project name from the store. The backend matches items by the literal
 *  `<projectName>/` title prefix, and titles were written through `backupTitle`, so the name is
 *  normalized here — at the boundary that owns the invariant — rather than at each call site.
 *  (Normalization is idempotent, so passing an already-normalized name is fine.) */
export function opSeedWorktree(vaultId: string, projectName: string, destRoot: string): Promise<string[]> {
  return invoke<string[]>("op_seed_worktree", {
    vaultId,
    projectName: normalizeProjectName(projectName),
    destRoot,
  });
}
