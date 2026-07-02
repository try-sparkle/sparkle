import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ensureChiefProject = vi.fn();
const uploadAsset = vi.fn();
const deleteAsset = vi.fn();
const listAllAssets = vi.fn();
vi.mock("./chief", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chief")>()), // keep assetLooksStuck real
  ensureChiefProject: (...a: unknown[]) => ensureChiefProject(...a),
  uploadAsset: (...a: unknown[]) => uploadAsset(...a),
  deleteAsset: (...a: unknown[]) => deleteAsset(...a),
  listAllAssets: (...a: unknown[]) => listAllAssets(...a),
}));

import { syncProjectMarkdown, hashContent, MARKDOWN_DIRS } from "./chiefSync";

describe("syncProjectMarkdown — current-state, content-hash, delete-and-replace", () => {
  beforeEach(() => {
    invoke.mockReset();
    ensureChiefProject.mockReset();
    uploadAsset.mockReset();
    deleteAsset.mockReset();
    listAllAssets.mockReset();
    listAllAssets.mockResolvedValue([]); // healthy default: empty library
  });

  const pbase = {
    pat: "pat_test",
    sparkleProjectId: "p1",
    projectName: "Sparkle-Desktop",
    agentId: "a1",
    chiefProjectId: "project_known",
  };

  it("requests the full current tree (empty sinceSha) and names assets by path, no @sha", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "# v1" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    uploadAsset.mockResolvedValue({ assetId: "asset_1", alreadyExists: false });

    const res = await syncProjectMarkdown({ ...pbase, docState: {} });

    expect(invoke).toHaveBeenCalledWith("markdown_changed_since", {
      projectId: "p1",
      agentId: "a1",
      sinceSha: "",
      dirs: MARKDOWN_DIRS,
    });
    expect(uploadAsset).toHaveBeenCalledWith("pat_test", "project_known", "PRD/a.md", "# v1");
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(res).toEqual({
      chiefProjectId: "project_known",
      docState: { "PRD/a.md": { hash: hashContent("# v1"), assetId: "asset_1" } },
      uploaded: ["PRD/a.md"],
      deletedAssetIds: [],
    });
  });

  it("skips upload when the content hash is unchanged", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "same" }] });
    const res = await syncProjectMarkdown({
      ...pbase,
      docState: { "PRD/a.md": { hash: hashContent("same"), assetId: "asset_old" } },
    });
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(deleteAsset).not.toHaveBeenCalled();
    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("same"), assetId: "asset_old" } });
    expect(res?.uploaded).toEqual([]);
  });

  it("uploads new content then deletes the prior asset for the same path", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "# v2" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    uploadAsset.mockResolvedValue({ assetId: "asset_new", alreadyExists: false });

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: { "PRD/a.md": { hash: hashContent("# v1"), assetId: "asset_old" } },
    });

    expect(uploadAsset).toHaveBeenCalledWith("pat_test", "project_known", "PRD/a.md", "# v2");
    expect(deleteAsset).toHaveBeenCalledWith("pat_test", "project_known", "asset_old");
    expect(res?.deletedAssetIds).toEqual(["asset_old"]);
    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("# v2"), assetId: "asset_new" } });
  });

  it("deletes assets for docs that no longer exist in the tree", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "keep" }] });
    ensureChiefProject.mockResolvedValue("project_known");

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: {
        "PRD/a.md": { hash: hashContent("keep"), assetId: "asset_a" },
        "PRD/gone.md": { hash: "x", assetId: "asset_gone" },
      },
    });

    expect(deleteAsset).toHaveBeenCalledWith("pat_test", "project_known", "asset_gone");
    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("keep"), assetId: "asset_a" } });
    expect(res?.deletedAssetIds).toEqual(["asset_gone"]);
  });

  it("a 404 deleting a vanished doc's asset drops the ledger entry instead of wedging the sync", async () => {
    // The asset may already be gone server-side (another agent's sweep, or a prior run that
    // crashed after the DELETE landed but before docState persisted). Throwing here would
    // re-throw every run forever, since docState never advances past the dead entry.
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "keep" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    deleteAsset.mockRejectedValue(new Error("asset delete failed (404)"));

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: {
        "PRD/a.md": { hash: hashContent("keep"), assetId: "asset_a" },
        "PRD/gone.md": { hash: "x", assetId: "asset_gone" },
      },
    });

    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("keep"), assetId: "asset_a" } });
    expect(res?.deletedAssetIds).toEqual([]); // failed delete isn't reported as deleted
  });

  it("no-ops (returns null) without a PAT", async () => {
    const res = await syncProjectMarkdown({ ...pbase, pat: "", docState: {} });
    expect(res).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns empty ledger when there are no docs and none were tracked", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [] });
    const res = await syncProjectMarkdown({ ...pbase, docState: {} });
    expect(ensureChiefProject).not.toHaveBeenCalled();
    expect(res).toEqual({ chiefProjectId: "project_known", docState: {}, uploaded: [], deletedAssetIds: [] });
  });

  // --- library health: stuck 1-byte reservations (upload never landed) ---------------------

  const HOUR = 60 * 60 * 1000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("re-uploads a hash-matched path whose recorded asset is a stuck reservation", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "same" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    listAllAssets.mockResolvedValue([
      { asset_id: "asset_old", filename: "PRD/a.md", status: "ingesting", size_in_bytes: 1, created_at: iso(0) },
    ]);
    uploadAsset.mockResolvedValue({ assetId: "asset_new", alreadyExists: false });

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: { "PRD/a.md": { hash: hashContent("same"), assetId: "asset_old" } },
    });

    expect(uploadAsset).toHaveBeenCalledWith("pat_test", "project_known", "PRD/a.md", "same");
    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("same"), assetId: "asset_new" } });
    expect(res?.uploaded).toEqual(["PRD/a.md"]);
  });

  it("keeps the hash-skip when the recorded asset actually holds bytes", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "same" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    listAllAssets.mockResolvedValue([
      { asset_id: "asset_old", filename: "PRD/a.md", status: "ready", size_in_bytes: 512, created_at: iso(0) },
    ]);

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: { "PRD/a.md": { hash: hashContent("same"), assetId: "asset_old" } },
    });

    expect(uploadAsset).not.toHaveBeenCalled();
    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("same"), assetId: "asset_old" } });
  });

  it("falls back to hash-only skipping when the library listing fails", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "same" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    listAllAssets.mockRejectedValue(new Error("boom"));

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: { "PRD/a.md": { hash: hashContent("same"), assetId: "asset_old" } },
    });

    expect(uploadAsset).not.toHaveBeenCalled();
    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("same"), assetId: "asset_old" } });
  });

  it("sweeps stale unreferenced stuck reservations but leaves fresh ones (possible in-flight uploads)", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "keep" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    listAllAssets.mockResolvedValue([
      // junk left by an earlier failed run — old enough to sweep
      { asset_id: "asset_junk", filename: "PRD/old.md", status: "ingesting", size_in_bytes: 1, created_at: iso(2 * HOUR) },
      // fresh reservation — could be another agent mid-upload; leave it alone
      { asset_id: "asset_inflight", filename: "PRD/b.md", status: "ingesting", size_in_bytes: 1, created_at: iso(5 * 60 * 1000) },
      // healthy asset — never swept
      { asset_id: "asset_a", filename: "PRD/a.md", status: "ready", size_in_bytes: 99, created_at: iso(2 * HOUR) },
    ]);

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: { "PRD/a.md": { hash: hashContent("keep"), assetId: "asset_a" } },
    });

    expect(uploadAsset).not.toHaveBeenCalled();
    expect(deleteAsset).toHaveBeenCalledTimes(1);
    expect(deleteAsset).toHaveBeenCalledWith("pat_test", "project_known", "asset_junk");
    expect(res?.deletedAssetIds).toEqual(["asset_junk"]);
  });

  it("tolerates a failed delete of the superseded asset (upload recovery may have removed it already)", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "# v2" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    uploadAsset.mockResolvedValue({ assetId: "asset_new", alreadyExists: false });
    deleteAsset.mockRejectedValue(new Error("asset delete failed (404)"));

    const res = await syncProjectMarkdown({
      ...pbase,
      docState: { "PRD/a.md": { hash: hashContent("# v1"), assetId: "asset_old" } },
    });

    expect(res?.docState).toEqual({ "PRD/a.md": { hash: hashContent("# v2"), assetId: "asset_new" } });
    expect(res?.deletedAssetIds).toEqual([]); // failed delete isn't reported as deleted
  });

  it("a failing sweep delete does not fail the sync", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/a.md", content: "keep" }] });
    ensureChiefProject.mockResolvedValue("project_known");
    listAllAssets.mockResolvedValue([
      { asset_id: "asset_junk", filename: "PRD/old.md", status: "ingesting", size_in_bytes: 1, created_at: iso(2 * HOUR) },
    ]);
    deleteAsset.mockRejectedValue(new Error("404"));
    uploadAsset.mockResolvedValue({ assetId: "asset_a", alreadyExists: false });

    const res = await syncProjectMarkdown({ ...pbase, docState: {} });

    expect(res?.deletedAssetIds).toEqual([]);
    expect(res?.docState["PRD/a.md"]).toEqual({ hash: hashContent("keep"), assetId: "asset_a" });
  });
});
