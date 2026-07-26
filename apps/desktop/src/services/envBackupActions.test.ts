// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./onepassword", () => ({
  envScan: vi.fn(),
  opListBackups: vi.fn(),
  opBackup: vi.fn(),
}));

import { envScan, opListBackups, opBackup } from "./onepassword";
import { loadEnvBackupRows, backupRows, toScanRoots } from "./envBackupActions";
import type { EnvBackupRow } from "../engine/envBackup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const mockScan = vi.mocked(envScan);
const mockList = vi.mocked(opListBackups);
const mockBackup = vi.mocked(opBackup);

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
