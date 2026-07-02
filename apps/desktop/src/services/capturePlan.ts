// apps/desktop/src/services/capturePlan.ts
// Capture → Plan pipeline (spec §6): copy the screenshot into the repo's gitignored
// PRD/assets/ (the Rust copy_capture_asset command owns the copy + ignore rule — captures
// can contain secrets and must never enter git history), synthesize a PRD from the narration
// (the transcript notes the screenshot's repo-relative path), then decompose it into a beads
// epic + child tasks via the existing generateTasks — the epic body carries a
// `Screenshot: <path>` back-link so the board card can render a thumbnail.
//
// Composition only, deps injected (mirrors turnIntoPlan) so the whole pipeline unit-tests
// without a webview. Errors propagate: a failed copy/synthesis creates no beads, and the
// caller surfaces the failure (spec §9 — never silently drop a capture).
import { invoke } from "@tauri-apps/api/core";
import type { SynthesizeArgs, SynthesizeResult } from "./prd";
import type { GenerateArgs, GenerateResult } from "./tasks";
import type { CaptureAttachment } from "../capture/types";

/** Filename-safe timestamped asset name: `2026-07-01T20-15-30-capture.png` (a numeric
 *  suffix keeps multi-shot payloads distinct — spec §10 anticipates arrays). */
export function captureAssetFilename(d: Date, index = 0): string {
  const ts = d.toISOString().slice(0, 19).replace(/:/g, "-");
  return index === 0 ? `${ts}-capture.png` : `${ts}-capture-${index + 1}.png`;
}

/** The synthesis "interview": the narration as the user's turn, plus a note per screenshot
 *  so the PRD can reference the stable repo-relative path. Pure. */
export function buildCaptureTranscript(text: string, assetRelPaths: string[]): string {
  const narration = text.trim() || "(no narration — the screenshot itself is the request)";
  const lines = [`User: ${narration}`];
  for (const p of assetRelPaths) {
    lines.push(
      `(A screenshot of the user's screen is attached at ${p} — treat it as the visual context for this request and reference that path in the PRD where relevant.)`,
    );
  }
  return lines.join("\n\n");
}

/** The epic-body back-link line(s): `Screenshot: <repo-relative path>` per asset. Pure. */
export function screenshotBodyExtra(assetRelPaths: string[]): string {
  return assetRelPaths.map((p) => `Screenshot: ${p}`).join("\n");
}

export interface CapturePlanDeps {
  /** Wraps the Rust `copy_capture_asset` command; returns the repo-relative asset path. */
  copyCaptureAsset: (projectPath: string, src: string, filename: string) => Promise<string>;
  /** Typically `(a) => synthesizePrd(realDeps, a)`. */
  synthesize: (args: SynthesizeArgs) => Promise<SynthesizeResult>;
  /** Typically `(a) => generateTasks(realDeps, a)`. */
  generate: (args: GenerateArgs) => Promise<GenerateResult>;
  /** Clock seam for deterministic asset filenames in tests. */
  now?: () => Date;
}

export interface CapturePlanArgs {
  pat: string;
  chiefProjectId: string;
  projectPath: string;
  /** Narration transcript / typed text from the capture modal. */
  text: string;
  attachments: CaptureAttachment[];
}

/** Run the capture→Plan pipeline. Returns the created epic id. */
export async function sendCaptureToPlan(
  deps: CapturePlanDeps,
  args: CapturePlanArgs,
): Promise<{ epicId: string }> {
  const d = (deps.now ?? (() => new Date()))();
  const assetRelPaths: string[] = [];
  for (let i = 0; i < args.attachments.length; i++) {
    assetRelPaths.push(
      await deps.copyCaptureAsset(
        args.projectPath,
        args.attachments[i]!.path,
        captureAssetFilename(d, i),
      ),
    );
  }

  const prd = await deps.synthesize({
    pat: args.pat,
    chiefProjectId: args.chiefProjectId,
    projectPath: args.projectPath,
    transcript: buildCaptureTranscript(args.text, assetRelPaths),
  });

  const gen = await deps.generate({
    projectPath: args.projectPath,
    prdFilename: prd.filename,
    prdContent: prd.content,
    prdRelPath: prd.path,
    epicBodyExtra: screenshotBodyExtra(assetRelPaths),
  });

  return { epicId: gen.epicId };
}

/** Thin wrapper over the Rust `copy_capture_asset` command (mkdir + copy + gitignore-ensure);
 *  pass as `CapturePlanDeps.copyCaptureAsset`. `filename` must be bare (no slashes). */
export function copyCaptureAsset(
  projectPath: string,
  src: string,
  filename: string,
): Promise<string> {
  return invoke<string>("copy_capture_asset", { projectPath, src, filename });
}
