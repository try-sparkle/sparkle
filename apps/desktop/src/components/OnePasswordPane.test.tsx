// @vitest-environment jsdom
//
// The 1Password pane — the feature's only entry point, and the place where a mis-wired prop or an
// inverted `disabled` is invisible to every layer below. What's pinned here is the pane's real job:
// being HONEST about the three-step prerequisite chain (CLI installed → desktop-app integration on
// → vault chosen), and never offering an action that would do nothing.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/configActions", () => ({
  setOnePasswordVault: vi.fn().mockResolvedValue(undefined),
  setOnePasswordAccount: vi.fn().mockResolvedValue(undefined),
  setOnePasswordSeedWorktrees: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

vi.mock("../services/onepassword", () => ({
  opPreflight: vi.fn(),
  refreshOpPreflight: vi.fn(),
  installOpCli: vi.fn(),
  opVaults: vi.fn(),
}));

vi.mock("../services/envBackupActions", async (importOriginal) => ({
  // The REAL toScanRoots: the re-scan tests below are the pin for "scanKey covers every project
  // field the scan reads", and a hand-copied re-implementation here could silently agree with a
  // stale key after someone adds a field to the real projection.
  ...(await importOriginal<typeof import("../services/envBackupActions")>()),
  loadEnvBackupRows: vi.fn(),
  backupRows: vi.fn(),
  restoreRows: vi.fn(),
}));

import { setOnePasswordAccount, setOnePasswordVault } from "../services/configActions";
import {
  installOpCli,
  opPreflight,
  opVaults,
  refreshOpPreflight,
  type OpAccount,
  type OpStatus,
} from "../services/onepassword";
import { backupRows, loadEnvBackupRows, restoreRows } from "../services/envBackupActions";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { joinBackups, type EnvBackupRow } from "../engine/envBackup";
import { OnePasswordPane, describeRestore } from "./OnePasswordPane";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const status = (
  readiness: "ready" | "cli-missing" | "integration-off" | "account-ambiguous",
  error: string | null = null,
  accounts: OpAccount[] = [],
): OpStatus => ({
  readiness,
  path: readiness === "cli-missing" ? null : "/opt/homebrew/bin/op",
  version: readiness === "cli-missing" ? null : "2.30.0",
  accountUrl: readiness === "ready" ? "my.1password.com" : null,
  accountId: readiness === "ready" ? accounts[0]?.userUuid ?? "U1" : null,
  accounts,
  error,
});
const READY = status("ready");

/** Two accounts under the SAME email — the shape that made the old "first account wins" probe
 *  report ready and then fail every call. `userUuid` is the only thing telling them apart. */
const TWINS: OpAccount[] = [
  { url: "my.1password.com", email: "same@person.example", userUuid: "UUID-ONE", accountUuid: null },
  { url: "my.1password.com", email: "same@person.example", userUuid: "UUID-TWO", accountUuid: null },
];

function file(relPath: string, sha256 = HASH_A) {
  return {
    projectId: "p1",
    projectName: "sparkle",
    relPath,
    absPath: `/repo/${relPath}`,
    sizeBytes: 42,
    sha256,
    modifiedAt: "2026-07-24T12:00:00Z",
  };
}
function record(title: string, sha256 = HASH_A) {
  return { itemId: `item-${title}`, title, sha256, updatedAt: "2026-07-24T11:00:00Z" };
}

beforeEach(() => {
  useSettingsStore.setState({
    onepasswordEnabled: true,
    onepasswordVaultId: "vault-abc",
    onepasswordAccountId: null,
    onepasswordSeedWorktrees: false,
  });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "sparkle", rootPath: "/repo", agents: [] }],
  } as never);
  vi.mocked(opPreflight).mockResolvedValue(READY);
  vi.mocked(refreshOpPreflight).mockResolvedValue(READY);
  vi.mocked(opVaults).mockResolvedValue([{ id: "vault-abc", name: "Private" }]);
  vi.mocked(loadEnvBackupRows).mockResolvedValue([]);
  vi.mocked(backupRows).mockResolvedValue({ uploaded: 0, failures: [] });
  vi.mocked(restoreRows).mockResolvedValue({ restored: [], skipped: [], failures: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A result this test resolves by hand, to hold one async step open. */
function deferredRows() {
  let resolve!: (v: EnvBackupRow[]) => void;
  const promise = new Promise<EnvBackupRow[]>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function deferredResult() {
  let resolve!: (v: { uploaded: number; failures: { title: string; error: string }[] }) => void;
  const promise = new Promise<{ uploaded: number; failures: { title: string; error: string }[] }>(
    (r) => {
      resolve = r;
    },
  );
  return { promise, resolve };
}

/** The "Back up N" button, once the in-flight scan has cleared `busy` (it is disabled while
 *  scanning, so clicking too early silently does nothing). */
async function enabledBackUpButton(): Promise<HTMLButtonElement> {
  const btn = (await screen.findByRole("button", { name: /back up/i })) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  return btn;
}

describe("OnePasswordPane — the prerequisite chain is named, never silently skipped", () => {
  it("offers to install when the CLI is missing, and does not scan", async () => {
    vi.mocked(opPreflight).mockResolvedValue(status("cli-missing", "op isn't on PATH"));
    render(<OnePasswordPane />);
    await waitFor(() => expect(screen.getByText(/CLI isn/i)).toBeTruthy());
    // Nothing to scan with: a table here would imply the feature works when it can't.
    expect(loadEnvBackupRows).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Install with Homebrew/i }));
    await waitFor(() => expect(installOpCli).toHaveBeenCalled());
  });

  it("names the desktop-app integration step when `op` can't authenticate", async () => {
    vi.mocked(opPreflight).mockResolvedValue(
      status("integration-off", "Turn on the 1Password desktop app integration"),
    );
    render(<OnePasswordPane />);
    await waitFor(() => expect(screen.getByText(/CLI integration/i)).toBeTruthy());
    expect(loadEnvBackupRows).not.toHaveBeenCalled();
  });

  it("scans once `op` is ready and a vault is chosen", async () => {
    render(<OnePasswordPane />);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalledWith("vault-abc", [
      { projectId: "p1", projectName: "sparkle", rootPath: "/repo" },
    ]));
  });

  it("does not scan while no vault has been chosen, however ready `op` is", async () => {
    useSettingsStore.setState({ onepasswordVaultId: null });
    render(<OnePasswordPane />);
    await waitFor(() => expect(opVaults).toHaveBeenCalled());
    expect(loadEnvBackupRows).not.toHaveBeenCalled();
  });

  it("persists a vault choice through configActions (not the bare store setter)", async () => {
    useSettingsStore.setState({ onepasswordVaultId: null });
    render(<OnePasswordPane />);
    const select = await screen.findByLabelText("Vault");
    // The vault list arrives asynchronously; selecting before its <option> exists silently yields
    // the empty placeholder value, which is a different assertion than the one we mean to make.
    await screen.findByRole("option", { name: "Private" });
    fireEvent.change(select, { target: { value: "vault-abc" } });
    expect(setOnePasswordVault).toHaveBeenCalledWith("vault-abc");
  });
});

describe("OnePasswordPane — which 1Password account", () => {
  const AMBIGUOUS = () =>
    status(
      "account-ambiguous",
      "You’re signed in to 2 1Password accounts, so `op` can’t tell which one to use.",
      TWINS,
    );

  it("names the ambiguity and does NOT scan or offer a vault", async () => {
    // The bug this replaced: readiness read the FIRST account and reported ready, so the pane
    // rendered a vault picker and a table over an `op` that failed every single call.
    vi.mocked(opPreflight).mockResolvedValue(AMBIGUOUS());
    render(<OnePasswordPane />);
    await waitFor(() => expect(screen.getByText(/can’t tell which one to use/)).toBeTruthy());
    expect(screen.queryByLabelText("Vault")).toBeNull();
    expect(loadEnvBackupRows).not.toHaveBeenCalled();
    expect(opVaults).not.toHaveBeenCalled();
  });

  it("lists each account by its user ID, so two accounts sharing an email are tellable apart", async () => {
    vi.mocked(opPreflight).mockResolvedValue(AMBIGUOUS());
    render(<OnePasswordPane />);
    await screen.findByLabelText("Account");
    // Same url, same email — an email-keyed picker would render these two identically.
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("my.1password.com — same@person.example (UUID-ONE)");
    expect(options).toContain("my.1password.com — same@person.example (UUID-TWO)");
  });

  it("persists the chosen account by user_uuid and RE-PROBES, so the pane leaves the stuck state", async () => {
    vi.mocked(opPreflight).mockResolvedValue(AMBIGUOUS());
    vi.mocked(refreshOpPreflight).mockResolvedValue(status("ready", null, [TWINS[1]!]));
    render(<OnePasswordPane />);
    const select = await screen.findByLabelText("Account");
    await screen.findByRole("option", { name: /UUID-TWO/ });

    fireEvent.change(select, { target: { value: "UUID-TWO" } });
    expect(setOnePasswordAccount).toHaveBeenCalledWith("UUID-TWO");
    // Re-probing is what turns the choice into a working pane — without it the user picks an
    // account and the notice just sits there. The vault picker appearing is the proof.
    await waitFor(() => expect(refreshOpPreflight).toHaveBeenCalled());
    expect(await screen.findByLabelText("Vault")).toBeTruthy();
  });

  it("writes the account BEFORE re-probing — the backend reads it while building each op call", async () => {
    // Ordering, not just occurrence: a re-probe fired before the config write lands re-reads the
    // OLD account and reports the same ambiguity, leaving the user clicking a picker that appears
    // to do nothing.
    const order: string[] = [];
    // The write RESOLVES LATE, like the real IPC round trip it stands for. A mock that records
    // synchronously would log "write" at call time and pass even when the probe was fired
    // alongside it — which is exactly the race being pinned, so the delay is the test.
    vi.mocked(setOnePasswordAccount).mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push("write");
            resolve();
          }, 5),
        ),
    );
    vi.mocked(refreshOpPreflight).mockImplementation(async () => {
      order.push("probe");
      return status("ready", null, [TWINS[1]!]);
    });
    vi.mocked(opPreflight).mockResolvedValue(AMBIGUOUS());
    render(<OnePasswordPane />);
    const select = await screen.findByLabelText("Account");
    await screen.findByRole("option", { name: /UUID-TWO/ });

    fireEvent.change(select, { target: { value: "UUID-TWO" } });
    await waitFor(() => expect(order).toEqual(["write", "probe"]));
  });

  it("still offers the picker when the CHOSEN account was signed out and one remains", async () => {
    // `account-ambiguous` is reachable with a SINGLE signed-in account: a chosen account that has
    // since been signed out leaves a stale id going out as `--account` on every call. Gating the
    // picker on "more than one account" left that case showing a notice telling the user to choose
    // with no control to choose with — a dead end escapable only by hand-editing config.toml.
    useSettingsStore.setState({ onepasswordAccountId: "UUID-GONE" });
    vi.mocked(opPreflight).mockResolvedValue(
      status(
        "account-ambiguous",
        "The 1Password account Sparkle is set to use isn’t signed in any more.",
        [TWINS[0]!],
      ),
    );
    vi.mocked(refreshOpPreflight).mockResolvedValue(status("ready", null, [TWINS[0]!]));
    render(<OnePasswordPane />);

    const select = (await screen.findByLabelText("Account")) as HTMLSelectElement;
    // The stale id matches no option, so the control reads as "nothing chosen" rather than showing
    // an account that isn't there.
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "UUID-ONE" } });
    expect(setOnePasswordAccount).toHaveBeenCalledWith("UUID-ONE");
    await waitFor(() => expect(refreshOpPreflight).toHaveBeenCalled());
    expect(await screen.findByLabelText("Vault")).toBeTruthy();
  });

  it("shows no account picker when there is nothing to choose between", async () => {
    // One signed-in account needs no choice — `op` resolves it itself, and an unset account_id
    // means exactly that. A picker here would invent a decision the user doesn't have to make.
    vi.mocked(opPreflight).mockResolvedValue(status("ready", null, [TWINS[0]!]));
    render(<OnePasswordPane />);
    await screen.findByLabelText("Vault");
    expect(screen.queryByLabelText("Account")).toBeNull();
  });

  it("keeps the picker available after a choice, so a wrong pick is recoverable", async () => {
    useSettingsStore.setState({ onepasswordAccountId: "UUID-TWO" });
    vi.mocked(opPreflight).mockResolvedValue(status("ready", null, TWINS));
    render(<OnePasswordPane />);
    const select = (await screen.findByLabelText("Account")) as HTMLSelectElement;
    expect(select.value).toBe("UUID-TWO");
  });
});

describe("OnePasswordPane — the action never lies about what it will do", () => {
  it("enables 'Back up' only when there is something to upload", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups([file(".env.local", HASH_B)], [record("sparkle/.env.local", HASH_A)]),
    );
    render(<OnePasswordPane />);
    const btn = await enabledBackUpButton();

    fireEvent.click(btn);
    await waitFor(() => expect(backupRows).toHaveBeenCalled());
    // Exactly the drifted row is sent — not the whole table.
    expect(vi.mocked(backupRows).mock.calls[0]![1]).toHaveLength(1);
  });

  it("states the conflict count as what it actually counts", async () => {
    // The chip used to render `conflicts + 1` as "N different files share this name". `conflicts`
    // counts files DIFFERING FROM THE WINNER, so with two byte-identical losers that sentence
    // claimed three distinct files where two existed — a number the user is meant to act on. The
    // chip had no test at all, which is how the copy and the field drifted apart.
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups(
        [
          { ...file(".env.local", HASH_A), absPath: "/a/.env.local" },
          { ...file(".env.local", HASH_B), absPath: "/b/.env.local" },
          { ...file(".env.local", HASH_B), absPath: "/c/.env.local" },
        ],
        [],
      ),
    );
    render(<OnePasswordPane />);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalled());
    // Two losers, both differing from the winner — and the singular/plural has to follow the count.
    // The WHOLE sentence, not just the count clause: the point of the rewrite is the single
    // phrasing, and a regression to the doubled qualifier ("…under this name … under it") would
    // pass a count-only assertion.
    expect(
      (await screen.findByText(/2 other files/i)).textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("2 other files with this name differ from the one that will be backed up");
  });

  it("says it in the SINGULAR when exactly one other file differs", async () => {
    // Both branches of the count-dependent copy need pinning, or a swapped singular/plural pair
    // stays green — the sort of thing nobody re-reads once the plural case passes.
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups(
        [
          { ...file(".env.local", HASH_A), absPath: "/a/.env.local" },
          { ...file(".env.local", HASH_B), absPath: "/b/.env.local" },
        ],
        [],
      ),
    );
    render(<OnePasswordPane />);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalled());
    expect(
      (await screen.findByText(/1 other file/i)).textContent?.replace(/\s+/g, " ").trim(),
    ).toBe("1 other file with this name differs from the one that will be backed up");
  });

  it("disables it when every file is already in sync", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups([file(".env.local", HASH_A)], [record("sparkle/.env.local", HASH_A)]),
    );
    render(<OnePasswordPane />);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalled());
    const btn = (await screen.findByRole("button", { name: /back up/i })) as HTMLButtonElement;
    // It must NEVER become enabled here: an enabled button whose click uploads nothing is exactly
    // the "count that lies" regression.
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Back up 0");
  });

  it("reports a PARTIAL failure with its count and first error, not a generic message", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups([file(".env.local", HASH_B)], [record("sparkle/.env.local", HASH_A)]),
    );
    vi.mocked(backupRows).mockResolvedValue({
      uploaded: 0,
      failures: [{ title: "sparkle/.env.local", error: "1Password is locked" }],
    });
    render(<OnePasswordPane />);
    fireEvent.click(await enabledBackUpButton());
    await waitFor(() => expect(screen.getByText(/1 failed/i)).toBeTruthy());
    expect(screen.getByText(/1Password is locked/)).toBeTruthy();
  });

  it("surfaces a scan failure instead of rendering an empty, reassuring table", async () => {
    vi.mocked(loadEnvBackupRows).mockRejectedValue(new Error("op timed out"));
    render(<OnePasswordPane />);
    await waitFor(() => expect(screen.getByText(/op timed out/)).toBeTruthy());
  });
});

describe("OnePasswordPane — an out-of-contract row degrades, it does not crash", () => {
  it("renders the row and disables the action instead of taking the dialog down", async () => {
    // The only payload that can reach summarize's throw is a row with a status the engine doesn't
    // know. Guarding just the summarize call wasn't enough: the row render read STATUS_META[status]
    // and dereferenced `undefined` two lines later, crashing the same render.
    vi.mocked(loadEnvBackupRows).mockResolvedValue([
      {
        title: "sparkle/.env.weird",
        projectName: "sparkle",
        relPath: ".env.weird",
        file: null,
        record: null,
        status: "from-the-future",
      },
    ] as never);
    render(<OnePasswordPane />);
    // The dialog survives, the row is still listed, and the button can't be clicked into a no-op.
    expect(await screen.findByText("sparkle/.env.weird")).toBeTruthy();
    const btn = (await screen.findByRole("button", { name: /back up/i })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("OnePasswordPane — overlapping work", () => {
  it("keeps the NEWER scan's rows when an older one finishes last", async () => {
    const older = deferredRows();
    const newer = deferredRows();
    vi.mocked(loadEnvBackupRows).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    render(<OnePasswordPane />);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalledTimes(1));
    // A second scan starts (a project root changed) before the first has landed.
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "sparkle", rootPath: "/repo", agents: [] },
        { id: "p2", name: "other", rootPath: "/other", agents: [] },
      ],
    } as never);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalledTimes(2));

    newer.resolve(joinBackups([file(".env.newer", HASH_A)], []));
    await screen.findByText("sparkle/.env.newer");
    // …and now the STALE scan lands. Its rows must not replace the newer ones.
    older.resolve(joinBackups([file(".env.older", HASH_A)], []));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("sparkle/.env.older")).toBeNull();
    expect(screen.getByText("sparkle/.env.newer")).toBeTruthy();
  });

  it("keeps 'Back up' disabled while an upload runs, even if a re-scan finishes under it", async () => {
    // One shared busy slot meant a scan landing mid-upload re-enabled the button; a second click
    // then uploaded the same files again from rows that predated the first run.
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups([file(".env.local", HASH_B)], [record("sparkle/.env.local", HASH_A)]),
    );
    const upload = deferredResult();
    vi.mocked(backupRows).mockReturnValue(upload.promise);

    render(<OnePasswordPane />);
    const btn = await enabledBackUpButton();
    fireEvent.click(btn);
    await waitFor(() => expect(backupRows).toHaveBeenCalledTimes(1));

    // A project rename kicks an automatic re-scan while the upload is still in flight.
    useProjectStore.setState({
      projects: [{ id: "p1", name: "sparkle-renamed", rootPath: "/repo", agents: [] }],
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.disabled).toBe(true);
    expect(backupRows).toHaveBeenCalledTimes(1);

    upload.resolve({ uploaded: 1, failures: [] });
  });
});

describe("OnePasswordPane — re-scan cost", () => {
  it("does not re-scan when unrelated project-store state changes", async () => {
    // `projects` is a fresh array on every project-store mutation (an agent status write, a prompt),
    // and each re-scan is an `op` subprocess that can raise a Touch ID prompt. Only the scan ROOTS
    // may trigger one.
    render(<OnePasswordPane />);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalledTimes(1));

    useProjectStore.setState({
      projects: [{ id: "p1", name: "sparkle", rootPath: "/repo", agents: [{ id: "a1" }] }],
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(loadEnvBackupRows).toHaveBeenCalledTimes(1);
  });

  it("DOES re-scan when a project root actually changes", async () => {
    render(<OnePasswordPane />);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalledTimes(1));

    useProjectStore.setState({
      projects: [
        { id: "p1", name: "sparkle", rootPath: "/repo", agents: [] },
        { id: "p2", name: "other", rootPath: "/other", agents: [] },
      ],
    } as never);
    await waitFor(() => expect(loadEnvBackupRows).toHaveBeenCalledTimes(2));
  });
});

// ── Restore all — the DOWN direction (bead sparkle-y5xc9) ───────────────────────────────────
//
// Its absence is what made a portability feature work in one direction: a second machine showed a
// wall of "Only in vault" rows and a primary button reading "Back up 0".

/** The "Restore N" button, once the in-flight scan has cleared `busy`. */
async function enabledRestoreButton(): Promise<HTMLButtonElement> {
  const btn = (await screen.findByRole("button", { name: /restore/i })) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  return btn;
}

describe("Restore all", () => {
  /** Two files that exist only in the vault — a fresh machine. */
  const vaultOnlyRows = () =>
    joinBackups([], [record("sparkle/.env.local"), record("sparkle/apps/web/.env.local")], {
      roots: [{ projectId: "p1", projectName: "sparkle", rootPath: "/repo" }],
    });

  it("offers a Restore button counting the rows that exist only in the vault", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(vaultOnlyRows());
    render(<OnePasswordPane />);
    const btn = await enabledRestoreButton();
    expect(btn.textContent).toContain("Restore 2");
  });

  it("is DISABLED when nothing is vault-only — a click that does nothing reads as broken", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups([file(".env.local")], [record("sparkle/.env.local")]),
    );
    render(<OnePasswordPane />);
    const btn = (await screen.findByRole("button", { name: /restore/i })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
  });

  it("restores every vault-only row and reports what landed", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(vaultOnlyRows());
    vi.mocked(restoreRows).mockResolvedValue({
      restored: ["sparkle/.env.local", "sparkle/apps/web/.env.local"],
      skipped: [],
      failures: [],
    });
    render(<OnePasswordPane />);
    fireEvent.click(await enabledRestoreButton());
    await waitFor(() => expect(restoreRows).toHaveBeenCalledTimes(1));
    // The SUCCESS is reported, not only failures: "2 restored" is what tells the user their new
    // machine is actually set up. An error-only banner could never say it.
    expect(await screen.findByText(/2 restored/)).toBeTruthy();
  });

  it("names the failures rather than reporting a clean run", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(vaultOnlyRows());
    vi.mocked(restoreRows).mockResolvedValue({
      restored: ["sparkle/.env.local"],
      skipped: [],
      failures: [{ title: "sparkle/apps/web/.env.local", error: "item not found" }],
    });
    render(<OnePasswordPane />);
    fireEvent.click(await enabledRestoreButton());
    // A partially restored set of .env files that reports success is worse than none.
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("item not found"),
    );
  });

  it("hands the pane's project roots to the restore, so destinations resolve", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(vaultOnlyRows());
    render(<OnePasswordPane />);
    fireEvent.click(await enabledRestoreButton());
    await waitFor(() => expect(restoreRows).toHaveBeenCalledTimes(1));
    const roots = vi.mocked(restoreRows).mock.calls[0]?.[1];
    // Without a root the planner reports every row as unknown-project and restores nothing.
    expect(roots).toEqual([{ projectId: "p1", projectName: "sparkle", rootPath: "/repo" }]);
  });

  it("cannot run while a backup is in flight, and vice versa", async () => {
    // Needs BOTH directions live: a drifted file to back up and a vault-only file to restore.
    vi.mocked(loadEnvBackupRows).mockResolvedValue(
      joinBackups([file(".env.local", HASH_B)], [record("sparkle/.env.local", HASH_A), record("sparkle/gone/.env.local")], {
        roots: [{ projectId: "p1", projectName: "sparkle", rootPath: "/repo" }],
      }),
    );
    const held = deferredResult();
    vi.mocked(backupRows).mockReturnValue(held.promise as never);
    render(<OnePasswordPane />);
    // Both bulk actions share one busy slot; two concurrent runs would race the same vault.
    const backUp = await screen.findByRole("button", { name: /back up/i });
    await waitFor(() => expect((backUp as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(backUp);
    const restore = (await screen.findByRole("button", { name: /restor/i })) as HTMLButtonElement;
    await waitFor(() => expect(restore.disabled).toBe(true));
    held.resolve({ uploaded: 0, failures: [] });
  });

  it("says up front that 1Password may ask once, and that it is not once per file", async () => {
    vi.mocked(loadEnvBackupRows).mockResolvedValue(vaultOnlyRows());
    render(<OnePasswordPane />);
    expect(await screen.findByText(/not once per file/i)).toBeTruthy();
  });
});

describe("describeRestore", () => {
  it("reports all three outcomes, and says WHY a worktree row was skipped", () => {
    const text = describeRestore({
      restored: ["a"],
      skipped: [{ title: "b", reason: "worktree-missing" }],
      failures: [{ title: "c", error: "boom" }],
    });
    expect(text).toContain("1 restored");
    expect(text).toContain("1 failed");
    // "1 skipped" with no reason reads as a malfunction; the reason is what makes it a decision.
    expect(text).toMatch(/worktrees this machine hasn/i);
  });

  it("still names the counts when nothing failed", () => {
    expect(describeRestore({ restored: ["a", "b"], skipped: [], failures: [] })).toBe("2 restored.");
  });
});
