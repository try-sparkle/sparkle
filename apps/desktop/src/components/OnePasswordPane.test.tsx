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
}));

import { setOnePasswordVault } from "../services/configActions";
import { installOpCli, opPreflight, opVaults, refreshOpPreflight } from "../services/onepassword";
import { backupRows, loadEnvBackupRows } from "../services/envBackupActions";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { joinBackups, type EnvBackupRow } from "../engine/envBackup";
import { OnePasswordPane } from "./OnePasswordPane";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const status = (readiness: "ready" | "cli-missing" | "integration-off", error: string | null = null) => ({
  readiness,
  path: readiness === "cli-missing" ? null : "/opt/homebrew/bin/op",
  version: readiness === "cli-missing" ? null : "2.30.0",
  accountUrl: readiness === "ready" ? "my.1password.com" : null,
  error,
});
const READY = status("ready");

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
