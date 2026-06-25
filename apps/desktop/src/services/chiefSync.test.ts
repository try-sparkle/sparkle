import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ensureChiefProject = vi.fn();
const uploadAsset = vi.fn();
vi.mock("./chief", () => ({
  ensureChiefProject: (...a: unknown[]) => ensureChiefProject(...a),
  uploadAsset: (...a: unknown[]) => uploadAsset(...a),
}));

import { syncAgentMarkdown, MARKDOWN_DIRS } from "./chiefSync";

const base = {
  pat: "pat_test",
  projectId: "p1",
  projectName: "Sparkle-Desktop",
  agentId: "a1",
  chiefProjectId: "project_known",
  sinceSha: "abc",
};

describe("syncAgentMarkdown", () => {
  beforeEach(() => {
    invoke.mockReset();
    ensureChiefProject.mockReset();
    uploadAsset.mockReset();
  });

  it("uploads each changed markdown file named with the commit short-sha, returns the new marker", async () => {
    invoke.mockResolvedValue({
      headSha: "deadbeef1234567",
      files: [
        { path: "PRD/main.md", content: "# v2" },
        { path: "docs/superpowers/specs/x.md", content: "# spec" },
      ],
    });
    ensureChiefProject.mockResolvedValue("project_known");
    uploadAsset.mockResolvedValue({ assetId: "asset_1", alreadyExists: false });

    const res = await syncAgentMarkdown(base);

    // Asked Rust for markdown since the stored marker, scoped to the two dirs.
    expect(invoke).toHaveBeenCalledWith("markdown_changed_since", {
      projectId: "p1",
      agentId: "a1",
      sinceSha: "abc",
      dirs: MARKDOWN_DIRS,
    });
    // One asset per file, named "<path> @ <shortSha>".
    expect(uploadAsset).toHaveBeenCalledTimes(2);
    expect(uploadAsset).toHaveBeenCalledWith(
      "pat_test",
      "project_known",
      "PRD/main.md @ deadbee",
      "# v2",
    );
    expect(res).toEqual({
      headSha: "deadbeef1234567",
      uploaded: ["PRD/main.md @ deadbee", "docs/superpowers/specs/x.md @ deadbee"],
      chiefProjectId: "project_known",
    });
  });

  it("advances the marker without creating a Chief project when nothing changed", async () => {
    invoke.mockResolvedValue({ headSha: "newhead", files: [] });

    const res = await syncAgentMarkdown(base);

    expect(ensureChiefProject).not.toHaveBeenCalled();
    expect(uploadAsset).not.toHaveBeenCalled();
    expect(res).toEqual({ headSha: "newhead", uploaded: [], chiefProjectId: "project_known" });
  });

  it("creates the Chief project on first synced markdown when none is linked yet", async () => {
    invoke.mockResolvedValue({ headSha: "h", files: [{ path: "PRD/main.md", content: "x" }] });
    ensureChiefProject.mockResolvedValue("project_created");
    uploadAsset.mockResolvedValue({ assetId: "a", alreadyExists: false });

    const res = await syncAgentMarkdown({ ...base, chiefProjectId: undefined });

    expect(ensureChiefProject).toHaveBeenCalledWith("pat_test", "Sparkle-Desktop", undefined);
    expect(uploadAsset).toHaveBeenCalledWith("pat_test", "project_created", "PRD/main.md @ h", "x");
    expect(res?.chiefProjectId).toBe("project_created");
  });

  it("no-ops (returns null) without a PAT — never touches git or the network", async () => {
    const res = await syncAgentMarkdown({ ...base, pat: "" });
    expect(res).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
