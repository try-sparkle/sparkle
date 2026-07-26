// The 1Password IPC boundary. These are contract tests: command NAMES and argument KEYS are the
// half of the TS↔Rust agreement that neither `tsc` nor the Rust suite can check, so a typo here
// fails only at runtime, in front of a user, with an opaque "command not found".
//
// The seeding test pins the one semantic rule this layer owns: the project name crossing the
// boundary must be the same segment `backupTitle` wrote into the vault item's title, because the
// backend matches items by that literal prefix. Asserting it against `backupTitle` rather than
// against a hardcoded "acme-web" is deliberate — it fails the moment the two sides diverge,
// whatever the normalization becomes.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { backupTitle } from "../engine/envBackup";
import {
  envScan,
  installOpCli,
  opBackup,
  opListBackups,
  opPreflight,
  opRestore,
  opSeedWorktree,
  opVaults,
  refreshOpPreflight,
} from "./onepassword";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
});

describe("onepassword IPC contract", () => {
  // The startup path: a typo in any of these three shows as an opaque "command not found" before
  // the user can do anything at all.
  it.each([
    ["op_preflight", () => opPreflight()],
    ["op_refresh", () => refreshOpPreflight()],
    ["op_install", () => installOpCli()],
  ])("probes through %s", async (command, call) => {
    invoke.mockResolvedValue({ readiness: "ready", path: null, version: null, accountUrl: null, error: null });
    await call();
    expect(invoke).toHaveBeenCalledWith(command);
  });

  it("lists vaults through op_vaults", async () => {
    await opVaults();
    expect(invoke).toHaveBeenCalledWith("op_vaults");
  });

  it("scans project roots through env_scan with a roots key", async () => {
    const roots = [{ projectId: "p", projectName: "sparkle", rootPath: "/repo" }];
    await envScan(roots);
    expect(invoke).toHaveBeenCalledWith("env_scan", { roots });
  });

  it("lists backups through op_list_backups with a vaultId key", async () => {
    await opListBackups("v1");
    expect(invoke).toHaveBeenCalledWith("op_list_backups", { vaultId: "v1" });
  });

  it("nests backup + restore payloads under `args`, as the Rust commands expect", async () => {
    invoke.mockResolvedValue({ itemId: "i", title: "t", sha256: "s", updatedAt: "u" });
    const backup = { vaultId: "v1", absPath: "/repo/.env", title: "sparkle/.env", sha256: "abc" };
    await opBackup(backup);
    expect(invoke).toHaveBeenCalledWith("op_backup", { args: backup });

    invoke.mockResolvedValue(undefined);
    const restore = { itemId: "i", absPath: "/repo/.env", overwrite: false };
    await opRestore(restore);
    expect(invoke).toHaveBeenCalledWith("op_restore", { args: restore });
  });

  it("forwards itemId when present and omits it when absent — create vs EDIT", async () => {
    // Not cosmetic: with an itemId the backend EDITS the item, adding a version to 1Password's
    // history (the user's rollback path). Without one it creates a second item under the same
    // title, silently duplicating the secret.
    invoke.mockResolvedValue({ itemId: "i", title: "t", sha256: "s", updatedAt: "u" });
    await opBackup({ vaultId: "v", absPath: "/repo/.env", title: "p/.env", sha256: "abc", itemId: "existing" });
    expect((invoke.mock.calls[0]![1] as { args: { itemId?: string } }).args.itemId).toBe("existing");

    invoke.mockClear();
    await opBackup({ vaultId: "v", absPath: "/repo/.env", title: "p/.env", sha256: "abc" });
    expect((invoke.mock.calls[0]![1] as { args: { itemId?: string } }).args.itemId).toBeUndefined();
  });
});

describe("opSeedWorktree — the name it sends must match the titles it has to find", () => {
  it("sends the project segment backupTitle wrote, not the raw store name", async () => {
    await opSeedWorktree("v1", "  acme/web  ", "/wt/agent-1");
    const sent = invoke.mock.calls[0]![1] as { projectName: string };
    // The property, not a hardcoded string: the prefix the backend matches on and the title the
    // backup was written under have to agree.
    expect(backupTitle("  acme/web  ", ".env.local")).toBe(`${sent.projectName}/.env.local`);
  });

  it("passes the vault and destination through unchanged", async () => {
    await opSeedWorktree("v1", "sparkle", "/wt/agent-1");
    expect(invoke).toHaveBeenCalledWith("op_seed_worktree", {
      vaultId: "v1",
      projectName: "sparkle",
      destRoot: "/wt/agent-1",
    });
  });

  it("is idempotent for an already-normalized name", async () => {
    await opSeedWorktree("v1", "acme-web", "/wt/agent-1");
    const sent = invoke.mock.calls[0]![1] as { projectName: string };
    expect(sent.projectName).toBe("acme-web");
  });
});
