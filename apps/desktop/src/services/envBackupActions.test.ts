// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./onepassword", () => ({
  envScan: vi.fn(),
  opListBackups: vi.fn(),
  opBackup: vi.fn(),
  opRestore: vi.fn(),
  envDirsExist: vi.fn(),
}));

import { envScan, opListBackups, opBackup, opRestore, envDirsExist } from "./onepassword";
import { loadEnvBackupRows, backupRows, restoreRows, toScanRoots } from "./envBackupActions";
import type { EnvBackupRow } from "../engine/envBackup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const mockScan = vi.mocked(envScan);
const mockList = vi.mocked(opListBackups);
const mockBackup = vi.mocked(opBackup);
const mockRestore = vi.mocked(opRestore);
const mockDirs = vi.mocked(envDirsExist);

const envFile = (projectName: string, relPath: string, sha256 = HASH_A) => ({
  projectId: `id-${projectName}`,
  projectName,
  relPath,
  absPath: `/Users/dev/${projectName}/${relPath}`,
  sizeBytes: 10,
  sha256,
  modifiedAt: "2026-07-24T12:00:00Z",
});

beforeEach(() => {
  mockScan.mockResolvedValue([]);
  mockList.mockResolvedValue([]);
  mockRestore.mockResolvedValue(undefined);
  // Every destination folder exists unless a test says otherwise.
  mockDirs.mockImplementation(async (paths: string[]) => paths.map(() => true));
  mockBackup.mockResolvedValue({
    itemId: "I1",
    title: "t",
    sha256: HASH_A,
    updatedAt: "2026-07-24T12:00:00Z",
  });
});
afterEach(() => vi.clearAllMocks());

describe("loadEnvBackupRows", () => {
  it("joins the scan against the vault and reports drift", async () => {
    mockScan.mockResolvedValue([envFile("sparkle", ".env.local", HASH_A)]);
    mockList.mockResolvedValue([
      { itemId: "I1", title: "sparkle/.env.local", sha256: HASH_B, updatedAt: "x" },
    ]);
    const rows = await loadEnvBackupRows("V1", [
      { projectId: "id-sparkle", projectName: "sparkle", rootPath: "/Users/dev/sparkle" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("drifted");
  });

  it("scans and lists concurrently rather than in sequence", async () => {
    // Both are needed before anything can be judged and neither depends on the other. Serializing
    // them would double the wait for no reason.
    let scanStarted = false;
    let listStartedBeforeScanResolved = false;
    mockScan.mockImplementation(async () => {
      scanStarted = true;
      await new Promise((r) => setTimeout(r, 10));
      return [];
    });
    mockList.mockImplementation(async () => {
      if (scanStarted) listStartedBeforeScanResolved = true;
      return [];
    });
    await loadEnvBackupRows("V1", []);
    expect(listStartedBeforeScanResolved).toBe(true);
  });
});

describe("backupRows", () => {
  const row = (over: Partial<EnvBackupRow> = {}): EnvBackupRow => ({
    title: "sparkle/.env.local",
    projectName: "sparkle",
    relPath: ".env.local",
    file: envFile("sparkle", ".env.local"),
    record: null,
    status: "not-backed-up",
    ...over,
  });

  it("creates without an itemId and edits in place with one", async () => {
    await backupRows("V1", [
      row(),
      row({
        title: "sparkle/apps/web/.env.local",
        relPath: "apps/web/.env.local",
        file: envFile("sparkle", "apps/web/.env.local"),
        record: { itemId: "EXISTING", title: "sparkle/apps/web/.env.local", sha256: HASH_B, updatedAt: "x" },
        status: "drifted",
      }),
    ]);

    expect(mockBackup).toHaveBeenNthCalledWith(1, expect.objectContaining({ itemId: undefined }));
    // Editing preserves 1Password's item history, which is the user's rollback path — a create
    // here would leave a duplicate item and orphan the old versions.
    expect(mockBackup).toHaveBeenNthCalledWith(2, expect.objectContaining({ itemId: "EXISTING" }));
  });

  it("derives the title through the engine, including nested paths", async () => {
    await backupRows("V1", [
      row({ relPath: "apps/web/.env.local", file: envFile("sparkle", "apps/web/.env.local") }),
    ]);
    expect(mockBackup).toHaveBeenCalledWith(
      expect.objectContaining({ title: "sparkle/apps/web/.env.local" }),
    );
  });

  it("keeps going after a failure and reports which files failed", async () => {
    // A run that stops at the first error leaves the user guessing what got through.
    mockBackup
      .mockRejectedValueOnce(new Error("vault locked"))
      .mockResolvedValueOnce({ itemId: "I2", title: "t", sha256: HASH_A, updatedAt: "x" });

    const res = await backupRows("V1", [
      row({ title: "sparkle/.env.local" }),
      row({ title: "other/.env.local", file: envFile("other", ".env.local") }),
    ]);

    expect(res.uploaded).toBe(1);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]?.title).toBe("sparkle/.env.local");
    expect(res.failures[0]?.error).toContain("vault locked");
  });

  it("uploads one at a time so Touch ID prompts can't stack", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockBackup.mockImplementation(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { itemId: "I", title: "t", sha256: HASH_A, updatedAt: "x" };
    });

    await backupRows("V1", [row(), row({ title: "b" }), row({ title: "c" })]);
    expect(maxInFlight).toBe(1);
  });

  it("skips a row with no local file instead of throwing", async () => {
    const res = await backupRows("V1", [row({ file: null, status: "missing-locally" })]);
    expect(mockBackup).not.toHaveBeenCalled();
    expect(res.uploaded).toBe(0);
  });

  it("reports progress across the whole run, including skipped rows", async () => {
    const seen: [number, number][] = [];
    await backupRows("V1", [row(), row({ title: "b" })], (d, t) => seen.push([d, t]));
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("toScanRoots", () => {
  it("projects project-store rows into the backend's scan input", () => {
    expect(toScanRoots([{ id: "p1", name: "sparkle", rootPath: "/Users/dev/sparkle" }])).toEqual([
      { projectId: "p1", projectName: "sparkle", rootPath: "/Users/dev/sparkle" },
    ]);
  });
});

// ── restoreRows — the DOWN direction (bead sparkle-y5xc9) ───────────────────────────────────

describe("restoreRows", () => {
  const ROOTS = [{ projectName: "sparkle", rootPath: "/Users/dev/sparkle" }];

  const vaultOnly = (relPath: string, itemId = `item-${relPath}`): EnvBackupRow => ({
    title: `sparkle/${relPath}`,
    projectName: "sparkle",
    relPath,
    file: null,
    record: { itemId, title: `sparkle/${relPath}`, sha256: HASH_A, updatedAt: "x" },
    status: "missing-locally",
  });

  it("restores every vault-only row into its project, one at a time", async () => {
    const res = await restoreRows([vaultOnly(".env.local"), vaultOnly("apps/web/.env.local")], ROOTS);
    expect(mockRestore).toHaveBeenCalledTimes(2);
    expect(mockRestore).toHaveBeenCalledWith({
      itemId: "item-.env.local",
      absPath: "/Users/dev/sparkle/.env.local",
      overwrite: false,
    });
    expect(res.restored).toEqual(["sparkle/.env.local", "sparkle/apps/web/.env.local"]);
    expect(res.failures).toEqual([]);
  });

  it("NEVER asks to overwrite — a bulk button must not clobber a file being edited", async () => {
    await restoreRows([vaultOnly(".env.local")], ROOTS);
    // If a file has appeared since the scan, the backend refuses and we report it as a failure.
    // Passing `overwrite: true` here would silently destroy the user's local edits instead.
    for (const call of mockRestore.mock.calls) expect(call[0]?.overwrite).toBe(false);
  });

  it("keeps going after a failure and names every file that did not land", async () => {
    mockRestore
      .mockRejectedValueOnce(new Error("item not found"))
      .mockResolvedValueOnce(undefined);
    const res = await restoreRows([vaultOnly("a.env"), vaultOnly("b.env")], ROOTS);
    expect(res.restored).toEqual(["sparkle/b.env"]);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]?.title).toBe("sparkle/a.env");
    expect(res.failures[0]?.error).toContain("item not found");
    // A partial restore that reports only its successes is the failure this whole pane exists to
    // prevent — .env files must never be silently half-present.
    expect(mockRestore).toHaveBeenCalledTimes(2);
  });

  it("reports skipped worktree rows instead of creating the slot directory", async () => {
    mockDirs.mockResolvedValue([false]);
    const res = await restoreRows([vaultOnly(".claude/worktrees/foo/.env.local")], ROOTS);
    expect(mockRestore).not.toHaveBeenCalled();
    expect(res.restored).toEqual([]);
    expect(res.skipped).toEqual([
      { title: "sparkle/.claude/worktrees/foo/.env.local", reason: "worktree-missing" },
    ]);
  });

  it("asks the filesystem ONCE for every destination folder, not once per file", async () => {
    await restoreRows(
      [vaultOnly("apps/web/.env.local"), vaultOnly("apps/web/.env.production")],
      ROOTS,
    );
    expect(mockDirs).toHaveBeenCalledTimes(1);
    expect(mockDirs).toHaveBeenCalledWith(["/Users/dev/sparkle/apps/web"]);
  });

  it("does no work at all when nothing is vault-only", async () => {
    const inSync: EnvBackupRow = {
      title: "sparkle/.env.local",
      projectName: "sparkle",
      relPath: ".env.local",
      file: envFile("sparkle", ".env.local"),
      record: { itemId: "I1", title: "sparkle/.env.local", sha256: HASH_A, updatedAt: "x" },
      status: "in-sync",
    };
    const res = await restoreRows([inSync], ROOTS);
    // Not even the folder probe: a restore with no candidates must not touch the disk.
    expect(mockDirs).not.toHaveBeenCalled();
    expect(mockRestore).not.toHaveBeenCalled();
    expect(res).toEqual({ restored: [], skipped: [], failures: [] });
  });

  it("reports progress as each file lands", async () => {
    const seen: [number, number][] = [];
    await restoreRows([vaultOnly("a.env"), vaultOnly("b.env")], ROOTS, (d, t) => seen.push([d, t]));
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
