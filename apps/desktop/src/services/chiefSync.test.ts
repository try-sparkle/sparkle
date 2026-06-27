import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ensureChiefProject = vi.fn();
const uploadAsset = vi.fn();
const deleteAsset = vi.fn();
vi.mock("./chief", () => ({
  ensureChiefProject: (...a: unknown[]) => ensureChiefProject(...a),
  uploadAsset: (...a: unknown[]) => uploadAsset(...a),
  deleteAsset: (...a: unknown[]) => deleteAsset(...a),
}));

import { syncProjectMarkdown, hashContent, MARKDOWN_DIRS } from "./chiefSync";

describe("syncProjectMarkdown — current-state, content-hash, delete-and-replace", () => {
  beforeEach(() => {
    invoke.mockReset();
    ensureChiefProject.mockReset();
    uploadAsset.mockReset();
    deleteAsset.mockReset();
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
});
