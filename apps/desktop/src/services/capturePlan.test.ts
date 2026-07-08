import { describe, it, expect, vi } from "vitest";
import {
  captureAssetFilename,
  buildCaptureTranscript,
  screenshotBodyExtra,
  sendCaptureToPlan,
  type CapturePlanDeps,
} from "./capturePlan";
import type { SynthesizeResult } from "./prd";
import type { GenerateResult } from "./tasks";

describe("captureAssetFilename", () => {
  it("is filename-safe (no colons) and timestamped", () => {
    const d = new Date("2026-07-01T20:15:30.123Z");
    expect(captureAssetFilename(d)).toBe("2026-07-01T20-15-30-capture.png");
  });

  it("suffixes later shots so multi-shot payloads don't collide", () => {
    const d = new Date("2026-07-01T20:15:30Z");
    expect(captureAssetFilename(d, 0)).toBe("2026-07-01T20-15-30-capture.png");
    expect(captureAssetFilename(d, 1)).toBe("2026-07-01T20-15-30-capture-2.png");
  });
});

describe("buildCaptureTranscript", () => {
  it("frames narration as the user's turn and notes each screenshot path", () => {
    const t = buildCaptureTranscript("fix the header", ["PRD/assets/a.png"]);
    expect(t).toContain("User: fix the header");
    expect(t).toContain("PRD/assets/a.png");
  });

  it("supplies a placeholder when the narration is empty (image-only send)", () => {
    const t = buildCaptureTranscript("   ", ["PRD/assets/a.png"]);
    expect(t).toContain("(no narration");
    expect(t).toContain("PRD/assets/a.png");
  });
});

describe("screenshotBodyExtra", () => {
  it("emits one Screenshot: line per asset", () => {
    expect(screenshotBodyExtra(["PRD/assets/a.png", "PRD/assets/b.png"])).toBe(
      "Screenshot: PRD/assets/a.png\nScreenshot: PRD/assets/b.png",
    );
  });

  it("is empty for no attachments", () => {
    expect(screenshotBodyExtra([])).toBe("");
  });
});

describe("sendCaptureToPlan", () => {
  function makeDeps(over: Partial<CapturePlanDeps> = {}) {
    const copyCaptureAsset = vi
      .fn()
      .mockImplementation(async (_p: string, _src: string, filename: string) => `PRD/assets/${filename}`);
    const synthesize = vi.fn().mockResolvedValue({
      path: "PRD/2026-07-01-x.md",
      filename: "2026-07-01-x.md",
      title: "X",
      content: "# X",
    } satisfies SynthesizeResult);
    const generate = vi.fn().mockResolvedValue({
      epicIds: ["sparkle-ep"],
      epicId: "sparkle-ep",
      taskIds: ["sparkle-ep.1"],
      updatedPrdContent: "# X",
    } satisfies GenerateResult);
    const deps: CapturePlanDeps = {
      copyCaptureAsset,
      synthesize,
      generate,
      now: () => new Date("2026-07-01T20:15:30Z"),
      ...over,
    };
    return { deps, copyCaptureAsset, synthesize, generate };
  }

  const args = {
    pat: "pat-1",
    chiefProjectId: "chief-1",
    projectPath: "/repo",
    text: "make it blue",
    attachments: [{ path: "/tmp/shot.png", dataUrl: "data:," }],
  };

  it("copies the shot, synthesizes the PRD from it, decomposes, and returns the epic id", async () => {
    const { deps, copyCaptureAsset, synthesize, generate } = makeDeps();
    const res = await sendCaptureToPlan(deps, args);

    expect(copyCaptureAsset).toHaveBeenCalledWith("/repo", "/tmp/shot.png", "2026-07-01T20-15-30-capture.png");
    // Narration + the copied asset path flow into synthesis.
    const synthArg = synthesize.mock.calls[0]![0];
    expect(synthArg.transcript).toContain("make it blue");
    expect(synthArg.transcript).toContain("PRD/assets/2026-07-01T20-15-30-capture.png");
    // Decomposition carries the Screenshot back-link into the epic body.
    const genArg = generate.mock.calls[0]![0];
    expect(genArg.epicBodyExtra).toBe("Screenshot: PRD/assets/2026-07-01T20-15-30-capture.png");
    expect(genArg.prdRelPath).toBe("PRD/2026-07-01-x.md");
    expect(res).toEqual({ epicId: "sparkle-ep" });
  });

  it("creates no beads when the asset copy fails (atomic — spec §9)", async () => {
    const generate = vi.fn();
    const synthesize = vi.fn();
    const { deps } = makeDeps({
      copyCaptureAsset: vi.fn().mockRejectedValue(new Error("copy failed")),
      synthesize,
      generate,
    });
    await expect(sendCaptureToPlan(deps, args)).rejects.toThrow("copy failed");
    expect(synthesize).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("creates no beads when synthesis fails", async () => {
    const generate = vi.fn();
    const { deps } = makeDeps({
      synthesize: vi.fn().mockRejectedValue(new Error("synth down")),
      generate,
    });
    await expect(sendCaptureToPlan(deps, args)).rejects.toThrow("synth down");
    expect(generate).not.toHaveBeenCalled();
  });
});
