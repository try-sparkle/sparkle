import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiCheck, FiDownload, FiLock, FiRefreshCw, FiUploadCloud } from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import {
  setOnePasswordAccount,
  setOnePasswordVault,
  setOnePasswordSeedWorktrees,
  setToolEnabled,
} from "../services/configActions";
import {
  installOpCli,
  opPreflight,
  opVaults,
  refreshOpPreflight,
  type OpAccount,
  type OpStatus,
  type OpVault,
} from "../services/onepassword";
import {
  backupRows,
  loadEnvBackupRows,
  restoreRows,
  toScanRoots,
  type RestoreRunResult,
} from "../services/envBackupActions";
import {
  rowsNeedingBackup,
  rowsNeedingRestore,
  summarize,
  type EnvBackupRow,
  type EnvFileStatus,
} from "../engine/envBackup";
import { CHIP, SECTION_LABEL } from "./labelTreatment";

// The "1Password" settings pane: get `op` working, pick a vault, then see every .env file across
// your projects with its backup state and push the ones that need it.
//
// The pane's real job is HONESTY about a three-step prerequisite chain — the CLI must exist, the
// desktop-app integration must be on, and a vault must be chosen. Each step is separately missable
// and none of them is Sparkle's to perform silently, so the pane names the outstanding one instead
// of showing a dead table.

const CLI_DOCS = "https://developer.1password.com/docs/cli/get-started/";
const INTEGRATION_DOCS = "https://developer.1password.com/docs/cli/app-integration/";

/** `url — email (user id)`. The user id is never dropped: two signed-in accounts can carry the
 *  SAME email (a personal one and a family/team membership), and it's the only field that
 *  distinguishes them — which is also why it, not the email, is what gets persisted. */
function accountLabel(a: OpAccount): string {
  const head = [a.url, a.email].filter(Boolean).join(" — ");
  return head ? `${head} (${a.userUuid})` : a.userUuid;
}

/** One sentence covering ALL THREE outcomes of a restore run, in the order that matters to someone
 *  who just clicked the button: what landed, what was deliberately left alone and why, what broke.
 *
 *  A restore that reports only its successes is the failure this pane exists to prevent — a set of
 *  `.env` files that is silently half-present is worse than one that is honestly absent — so the
 *  skipped and failed counts are never dropped, even when zero files failed. */
export function describeRestore(res: RestoreRunResult): string {
  const parts = [`${res.restored.length} restored`];
  const worktreeSkips = res.skipped.filter((s) => s.reason === "worktree-missing").length;
  const unknownSkips = res.skipped.filter((s) => s.reason === "unknown-project").length;
  if (worktreeSkips > 0) {
    // Say WHY in the same breath. "10 skipped" alone reads as a malfunction; these rows are copies
    // of files that already restored, belonging to worktrees this machine has never cut.
    parts.push(
      `${worktreeSkips} skipped (they belong to agent worktrees this machine hasn’t created — new worktrees get their env files copied from your project, so there’s nothing to do)`,
    );
  }
  if (unknownSkips > 0) {
    parts.push(`${unknownSkips} skipped (no matching project is open in Sparkle)`);
  }
  if (res.failures.length > 0) parts.push(`${res.failures.length} failed`);
  return `${parts.join(" · ")}.`;
}

/** Human label + tone for each drift state. */
const STATUS_META: Record<EnvFileStatus, { label: string; color: string }> = {
  "in-sync": { label: "Backed up", color: C.muted },
  // The two tones are the THEMED inks, not the warm literals they used to be: this pane paints
  // them as text on `deepForest`, where a light-mode literal picked against the dark shell is a
  // washed-out orange. `amberInk` = caution, `dangerInk` = something is wrong.
  drifted: { label: "Changed", color: C.amberInk },
  "not-backed-up": { label: "Not backed up", color: C.dangerInk },
  "missing-locally": { label: "Only in vault", color: C.muted },
};

export function OnePasswordPane() {
  const enabled = useSettingsStore((s) => s.onepasswordEnabled);
  const vaultId = useSettingsStore((s) => s.onepasswordVaultId);
  const accountId = useSettingsStore((s) => s.onepasswordAccountId);
  const seedWorktrees = useSettingsStore((s) => s.onepasswordSeedWorktrees);
  const projects = useProjectStore((s) => s.projects);

  const [status, setStatus] = useState<OpStatus | null>(null);
  const [vaults, setVaults] = useState<OpVault[]>([]);
  const [rows, setRows] = useState<EnvBackupRow[] | null>(null);
  // TWO busy slots, not one. They overlap: an automatic re-scan (a project rename mid-upload) used
  // to clear the shared slot and re-enable "Back up N" while the upload was still running — a
  // second click then ran a concurrent backup against rows that predated the first.
  const [scanBusy, setScanBusy] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const busy = backupBusy ?? scanBusy;
  const [error, setError] = useState<string | null>(null);
  // The OUTCOME of the last bulk run, success included. An error-only banner could report what
  // failed but never what worked, which for a restore is the more important half: "12 restored" is
  // what tells the user their machine is actually set up. Held separately from `error` so a run
  // that both wrote files and skipped some can say both.
  const [notice, setNotice] = useState<string | null>(null);

  // Probe `op` on mount and whenever the tool is switched on, so the pane opens showing the real
  // state rather than an optimistic one.
  useEffect(() => {
    let alive = true;
    void opPreflight()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [enabled]);

  const ready = status?.readiness === "ready";

  // Vaults are only listable once `op` can authenticate.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void opVaults()
      .then((v) => alive && setVaults(v))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [ready]);

  // The scan inputs, as a STABLE string. `projects` is a fresh array on every project-store
  // mutation — an agent status write, a prompt, a rename — so depending on the array itself made an
  // open pane re-run `env_scan` + `op_list_backups` (an `op` subprocess, possibly a Touch ID
  // prompt) on ordinary background activity. Only the roots matter here, so a change in anything
  // else must not re-scan.
  const scanKey = useMemo(
    () => projects.map((p) => `${p.id}\u0000${p.name}\u0000${p.rootPath}`).join("\u0001"),
    [projects],
  );

  // Monotonic generation: overlapping scans (a manual refresh landing on top of an automatic one)
  // must not have the slower one win `setRows`, and the first to finish must not clear `busy` while
  // the other is still running.
  const scanGen = useRef(0);

  const refreshRows = useCallback(async () => {
    if (!ready || !vaultId) return;
    const gen = ++scanGen.current;
    setScanBusy("Scanning…");
    setError(null);
    setNotice(null);
    try {
      const next = await loadEnvBackupRows(vaultId, toScanRoots(projects));
      if (gen !== scanGen.current) return; // a newer scan started; its result is the truth
      setRows(next);
    } catch (e) {
      if (gen === scanGen.current) setError(String(e));
    } finally {
      if (gen === scanGen.current) setScanBusy(null);
    }
    // `projects` is read inside but deliberately NOT a dependency — scanKey is its stable
    // projection, and depending on the array would reintroduce the re-scan storm above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, vaultId, scanKey]);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  const onInstall = async () => {
    setScanBusy("Installing the 1Password CLI…");
    setError(null);
    try {
      setStatus(await installOpCli());
    } catch (e) {
      setError(String(e));
    } finally {
      setScanBusy(null);
    }
  };

  const onRecheck = async () => {
    setScanBusy("Checking…");
    try {
      setStatus(await refreshOpPreflight());
    } catch (e) {
      setError(String(e));
    } finally {
      setScanBusy(null);
    }
  };

  // Choosing an account is what turns `account-ambiguous` into `ready`, so the write MUST be
  // awaited before the re-probe: the backend reads `[onepassword].account_id` when it builds each
  // `op` command line, and a probe issued in parallel would race the config write and report the
  // old, still-ambiguous answer.
  const onPickAccount = async (id: string | null) => {
    setScanBusy("Checking…");
    setError(null);
    try {
      await setOnePasswordAccount(id);
      setStatus(await refreshOpPreflight());
    } catch (e) {
      setError(String(e));
    } finally {
      setScanBusy(null);
    }
  };

  const onBackUpAll = async () => {
    if (!vaultId || !rows) return;
    const pending = rowsNeedingBackup(rows);
    setBackupBusy(`Backing up 0/${pending.length}…`);
    setError(null);
    setNotice(null);
    // Held rather than set immediately: the re-scan below CLEARS the banner on the way in, so a
    // message set here would vanish before the user could read which files didn't make it.
    let failure: string | null = null;
    let outcome: string | null = null;
    try {
      const res = await backupRows(vaultId, pending, (done, total) =>
        setBackupBusy(`Backing up ${done}/${total}…`),
      );
      outcome = `${res.uploaded} of ${pending.length} backed up.`;
      if (res.failures.length > 0) {
        // Name the count and the first failure rather than a generic "something went wrong" — a
        // partial backup the user can't characterize is worse than none.
        failure = `${res.uploaded} backed up, ${res.failures.length} failed. First error: ${res.failures[0]?.error ?? ""}`;
        outcome = null;
      }
    } catch (e) {
      failure = String(e);
    } finally {
      setBackupBusy(null);
      // Re-scan so the rows reflect what actually landed, THEN restore the summary.
      await refreshRows();
      if (failure) setError(failure);
      if (outcome) setNotice(outcome);
    }
  };

  const onRestoreAll = async () => {
    if (!rows) return;
    const pending = rowsNeedingRestore(rows).length;
    setBackupBusy(`Restoring 0/${pending}…`);
    setError(null);
    setNotice(null);
    // Same hold-then-set dance as the backup above, and for the same reason: `refreshRows` clears
    // both banners on the way in.
    let failure: string | null = null;
    let outcome: string | null = null;
    try {
      const res = await restoreRows(rows, toScanRoots(projects), (done, total) =>
        setBackupBusy(`Restoring ${done}/${total}…`),
      );
      outcome = describeRestore(res);
      if (res.failures.length > 0) {
        failure = `${res.failures.length} couldn’t be restored. First error: ${res.failures[0]?.error ?? ""}`;
      }
    } catch (e) {
      failure = String(e);
    } finally {
      setBackupBusy(null);
      await refreshRows();
      if (failure) setError(failure);
      if (outcome) setNotice(outcome);
    }
  };

  if (!enabled) {
    return (
      <div style={block}>
        <p style={body}>
          Back your <code>.env</code> files up to a 1Password vault, and restore them into fresh
          agent worktrees automatically.
        </p>
        <button type="button" style={primaryBtn} onClick={() => void setToolEnabled("onepassword", true)}>
          Turn on 1Password backup
        </button>
      </div>
    );
  }

  // `?? []` rather than `status.accounts`: an older backend (or a mocked status) has no such field,
  // and a settings pane must not crash on a payload that predates it.
  const accounts = status?.accounts ?? [];

  // summarize THROWS on a row with an unrecognized status — correct for a pure engine, but this is
  // a render path: an unexpected payload must degrade to "no counts", not take the settings dialog
  // down with it. The rows themselves still render.
  let summary: ReturnType<typeof summarize> | null = null;
  if (rows) {
    try {
      summary = summarize(rows);
    } catch (e) {
      console.warn("env backup: could not summarize the scanned rows", e);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* ── Step 1/2: get `op` working ─────────────────────────────────────────────────────── */}
      {status?.readiness === "cli-missing" && (
        <div style={noticeStyle}>
          <div style={noticeTitle}>
            <FiLock size={14} /> The 1Password CLI isn’t installed
          </div>
          <p style={body}>
            Sparkle uses 1Password’s own <code>op</code> command to read and write your vault, so
            your secrets never pass through Sparkle.
          </p>
          <div style={btnRow}>
            <button type="button" style={primaryBtn} disabled={!!busy} onClick={() => void onInstall()}>
              Install with Homebrew
            </button>
            <button type="button" style={linkBtn} onClick={() => void openUrl(CLI_DOCS)}>
              Other install options
            </button>
          </div>
        </div>
      )}

      {status?.readiness === "integration-off" && (
        <div style={noticeStyle}>
          <div style={noticeTitle}>
            <FiLock size={14} /> Turn on 1Password’s CLI integration
          </div>
          <p style={body}>
            In 1Password: <strong>Settings → Developer → “Integrate with 1Password CLI”</strong>.
            That’s what lets <code>op</code> unlock with Touch ID through the app you’re already
            signed in to — no password, and nothing for Sparkle to store.
          </p>
          <div style={btnRow}>
            <button type="button" style={primaryBtn} disabled={!!busy} onClick={() => void onRecheck()}>
              I’ve turned it on — re-check
            </button>
            <button type="button" style={linkBtn} onClick={() => void openUrl(INTEGRATION_DOCS)}>
              How to enable it
            </button>
          </div>
        </div>
      )}

      {status?.readiness === "account-ambiguous" && (
        <div style={noticeStyle}>
          <div style={noticeTitle}>
            <FiAlertTriangle size={14} /> Choose which 1Password account to use
          </div>
          <p style={body}>
            {status.error ??
              "You’re signed in to more than one 1Password account, so `op` can’t tell which one to use."}
          </p>
        </div>
      )}

      {/* ── Step 3a: pick an account ───────────────────────────────────────────────────────────
          Shown when there is a choice to MAKE, which is not the same as "more than one account".
          One signed-in account needs no picker — `op` resolves it on its own, and an unset
          account_id means exactly that. But `account-ambiguous` is reachable with a SINGLE account
          (a chosen one that has since been signed out, whose stale id still goes out as
          `--account` on every call), and gating on the count alone left that case rendering a
          notice telling the user to choose with no control to choose WITH — a dead end whose only
          exit was hand-editing config.toml. */}
      {(accounts.length > 1 || status?.readiness === "account-ambiguous") && (
        <div>
          <label style={fieldLabel} htmlFor="op-account">
            Account
          </label>
          <select
            id="op-account"
            style={selectStyle}
            value={accountId ?? ""}
            disabled={!!busy}
            onChange={(e) => void onPickAccount(e.target.value || null)}
          >
            <option value="">Choose an account…</option>
            {accounts.map((a) => (
              <option key={a.userUuid} value={a.userUuid}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
          <div style={hintStyle}>
            Each account is listed with its 1Password user ID — two accounts can share the same
            email address (a personal one and a family or team membership), and the ID is the only
            thing that tells them apart.
          </div>
        </div>
      )}

      {/* ── Step 3: pick a vault ───────────────────────────────────────────────────────────── */}
      {ready && (
        <div>
          <label style={fieldLabel} htmlFor="op-vault">
            Vault
          </label>
          <select
            id="op-vault"
            style={selectStyle}
            value={vaultId ?? ""}
            onChange={(e) => void setOnePasswordVault(e.target.value || null)}
          >
            <option value="">Choose a vault…</option>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <div style={hintStyle}>
            Each <code>.env</code> file is stored as a Document item, so it comes back byte for
            byte — comments and all — and 1Password keeps every previous version.
          </div>
        </div>
      )}

      {/* ── The table ──────────────────────────────────────────────────────────────────────── */}
      {ready && vaultId && (
        <section>
          <div style={tableHead}>
            <span style={groupLabel}>Your .env files</span>
            <div style={btnRow}>
              <button type="button" style={linkBtn} disabled={!!busy} onClick={() => void refreshRows()}>
                <FiRefreshCw size={12} /> Rescan
              </button>
              {/* The DOWN direction, sitting beside the UP one. Its absence is what made a feature
                  built for portability work in exactly one direction: a second machine showed a
                  wall of "Only in vault" rows and a primary button reading "Back up 0" (bead
                  sparkle-y5xc9). Both bulk actions share the `backupBusy` slot, so one can never
                  run while the other is mid-flight. */}
              <button
                type="button"
                style={{ ...secondaryBtn, opacity: summary?.canRestoreAll && !busy ? 1 : 0.5 }}
                disabled={!summary?.canRestoreAll || !!busy}
                onClick={() => void onRestoreAll()}
              >
                <FiDownload size={13} />{" "}
                {busy?.startsWith("Restoring") ? busy : `Restore ${summary?.needsRestore ?? 0}`}
              </button>
              <button
                type="button"
                style={{ ...primaryBtn, opacity: summary?.canBackUpAll && !busy ? 1 : 0.5 }}
                disabled={!summary?.canBackUpAll || !!busy}
                onClick={() => void onBackUpAll()}
              >
                <FiUploadCloud size={13} />{" "}
                {busy?.startsWith("Backing up") ? busy : `Back up ${summary?.needsBackup ?? 0}`}
              </button>
            </div>
          </div>

          {rows === null && <div style={hintStyle}>{busy ?? "Loading…"}</div>}

          {rows !== null && rows.length === 0 && (
            <div style={hintStyle}>
              No <code>.env</code> files found in your projects. (Templates like{" "}
              <code>.env.example</code> are skipped — they’re committed and hold no secrets.)
            </div>
          )}

          {rows !== null &&
            rows.map((row) => {
              // Total by construction: the only payload that can reach the summarize guard above
              // is a row with an out-of-contract status, and reading `meta.color` on an undefined
              // lookup would crash the dialog two lines later — making that guard a no-op for its
              // stated purpose. Show the raw status instead of dying on it.
              const meta = STATUS_META[row.status] ?? { label: String(row.status), color: C.muted };
              return (
                <div key={row.title} style={fileRow}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={fileTitle}>{row.title}</div>
                    {row.conflicts ? (
                      // Several genuinely different files collapsed onto one title. Saying so beats
                      // showing one row that quietly stands for all of them.
                      //
                      // `conflicts` counts files that DIFFER FROM THE WINNER — not distinct
                      // contents, not the group size. "N + 1 different files" overcounted whenever
                      // two losers matched each other, and "N files have different contents" reads
                      // as different FROM EACH OTHER, which is false in that same case. Name the
                      // referent: they differ from the one that will be backed up.
                      <div style={{ ...hintStyle, color: C.amberInk }}>
                        <FiAlertTriangle size={11} />{" "}
                        {row.conflicts === 1
                          ? "1 other file with this name differs from the one that will be backed up"
                          : `${row.conflicts} other files with this name differ from the one that will be backed up`}
                      </div>
                    ) : null}
                  </div>
                  <span style={{ ...statusPill, color: meta.color, borderColor: meta.color }}>
                    {row.status === "in-sync" && <FiCheck size={11} />}
                    {row.status === "missing-locally" && <FiDownload size={11} />}
                    {meta.label}
                  </span>
                </div>
              );
            })}

          {summary && rows !== null && rows.length > 0 && (
            <div style={hintStyle}>
              {summary.inSync} backed up · {summary.drifted} changed · {summary.notBackedUp} never
              backed up
              {summary.missingLocally > 0 ? ` · ${summary.missingLocally} only in your vault` : ""}
            </div>
          )}

          {/* SAY IT BEFORE, not after. 1Password grants CLI access to the calling process and lets
              it lapse after ten minutes idle, so a bulk run that starts cold raises one prompt —
              and being told that up front is the difference between a normal step and the app
              apparently misbehaving. It is ONE prompt, not one per file: the files go out
              back-to-back, and back-to-back activity is what keeps the grant alive. */}
          {summary && rows !== null && rows.length > 0 && (
            <div style={hintStyle}>
              If 1Password has been idle it will ask you to authorize Sparkle once when a backup or
              restore starts. Both buttons work through the whole list in one go, so it asks once,
              not once per file.
            </div>
          )}
        </section>
      )}

      {/* ── Worktree seeding ─────────────────────────────────────────────────────────────────
          NO LONGER GATED ON A VAULT. Seeding copies from the project checkout now (bead
          sparkle-y5xc9), so it touches neither `op` nor the vault — gating the control on a vault
          choice would have hidden the only switch for a feature that no longer depends on one. */}
      {enabled && (
        <section>
          <div style={groupLabel}>New agent worktrees</div>
          <label style={checkRow}>
            <input
              type="checkbox"
              checked={seedWorktrees}
              onChange={(e) => void setOnePasswordSeedWorktrees(e.target.checked)}
            />
            <span>
              <span style={{ color: C.cream }}>Copy env files into every new worktree</span>
              <div style={hintStyle}>
                Every agent gets its own git worktree, and <code>.env</code> files are gitignored —
                so without this, each new agent starts without your project’s secrets. The files are
                copied from your project folder, not downloaded, so opening an agent never asks
                1Password for anything.
              </div>
            </span>
          </label>
        </section>
      )}

      {notice && <div style={hintStyle}>{notice}</div>}

      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────────────────

const block: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" };
const body: CSSProperties = { fontSize: 12, color: C.muted, lineHeight: 1.5, margin: 0 };
const groupLabel: CSSProperties = { ...SECTION_LABEL };
const noticeStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 6,
  border: `1px solid ${C.hairline}`,
};
const noticeTitle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  color: C.cream,
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
};
const btnRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const primaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "none",
  background: C.teal,
  color: ON_BRAND_FILL,
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
};
// The DOWN action. Deliberately NOT `primaryBtn`: two filled buttons side by side read as equally
// weighted, and on the machine where restore matters the up-direction is what you must not click by
// reflex. A hairline outline is the standard secondary treatment in this pane's chrome.
const secondaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: `1px solid ${C.hairline}`,
  background: "transparent",
  color: C.cream,
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
};
const linkBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: 0,
  background: "transparent",
  border: "none",
  color: C.accentInk,
  fontSize: 12,
  cursor: "pointer",
};
const fieldLabel: CSSProperties = { display: "block", fontSize: 12, color: C.muted, marginBottom: 4 };
const selectStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 6,
  border: `1px solid ${C.hairline}`,
  background: "transparent",
  color: C.cream,
  fontSize: 12,
};
const hintStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexWrap: "wrap",
  fontSize: 12,
  color: C.muted,
  marginTop: 6,
  lineHeight: 1.45,
};
const tableHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 6,
};
const fileRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 2px",
  borderBottom: `1px solid ${C.hairline}`,
};
const fileTitle: CSSProperties = {
  fontSize: 12,
  color: C.cream,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
// STATUS IS TEXT, not a control — so this is the spec's chip (`.row .stg`): a hairline box at
// `--r-sm`, never a capsule. The ink is set by the caller; the border inherits it via `border-color`.
const statusPill: CSSProperties = {
  ...CHIP,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flex: "0 0 auto",
  padding: "1px 8px",
  border: "1px solid",
};
const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  fontSize: 12,
  cursor: "pointer",
};
const errorStyle: CSSProperties = {
  fontSize: 12,
  color: C.dangerInk,
  lineHeight: 1.45,
};
