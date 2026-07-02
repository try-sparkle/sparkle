// Read/write per-project "Done" & "Delivered" stage definitions (Definable Done & Delivered).
// The Rust config bridge speaks snake_case (config.ts mirrors it exactly); this module is the
// camelCase-facing layer the rest of the app uses. `readStageDef` maps an EffectiveConfig section
// into a `StageDefinition`; `writeStageDef` maps back and invokes the `set_stage_definition`
// command (which insert-or-replaces the whole `[done]`/`[delivered]` table in the project's
// .sparkle/config.toml). Spec: docs/superpowers/specs/2026-07-02-definable-done-delivered-design.md
import { invoke } from "@tauri-apps/api/core";
import type { SparkleConfig, StageCriterion as ConfigStageCriterion } from "./config";

export type StageKey = "done" | "delivered";
export type CriterionKind = "auto" | "manual";
/** The closed set of signals Sparkle can observe automatically. `merged_to_main`/`pr_merged`/
 *  `pushed` are universal (Done-oriented); `in_release` is Delivered-oriented. */
export type AutoSignal =
  | "merged_to_main"
  | "pr_merged"
  | "pushed"
  | "in_release";
export type Confidence = "high" | "medium" | "low" | "none";
export type DeliveryMethod =
  | "release_tag"
  | "ci_deploy"
  | "merge_is_deploy"
  | "package_publish"
  | "unknown";

/** One criterion of a stage definition. `signal` is present iff `kind === "auto"`. */
export interface StageCriterion {
  text: string;
  kind: CriterionKind;
  signal?: AutoSignal;
}

/** A project's definition of a board stage. `description` + `criteria` are the generic shape; the
 *  remaining fields are Delivered-only (the detected production-ship signal + learn-then-automate
 *  flag). Undefined-as-a-whole is represented by `readStageDef` returning `undefined`. */
export interface StageDefinition {
  description?: string;
  criteria: StageCriterion[];
  // delivered-only:
  detectedMethod?: DeliveryMethod;
  confidence?: Confidence;
  confidenceNote?: string;
  learned?: boolean;
}

/** Map the snake_case config criteria (signal: string | null) to the camelCase shape
 *  (signal null → undefined). */
function mapCriteria(criteria: ConfigStageCriterion[]): StageCriterion[] {
  return criteria.map((c) => {
    const out: StageCriterion = { text: c.text, kind: c.kind as CriterionKind };
    if (c.signal != null) out.signal = c.signal as AutoSignal;
    return out;
  });
}

/** True when a definition carries any content (a description or at least one criterion). The empty
 *  definition (no description AND no criteria) reads as "undefined" — the initial per-project state. */
export function isDefined(d: StageDefinition | undefined): boolean {
  return !!d && (!!d.description || d.criteria.length > 0);
}

/** Read a stage's definition out of an effective `SparkleConfig`, mapping snake_case → camelCase
 *  (detected_method → detectedMethod, confidence_note → confidenceNote, signal null → undefined).
 *  Returns `undefined` when the section is empty (no description AND no criteria) — i.e. undefined
 *  for this project. */
export function readStageDef(cfg: SparkleConfig, key: StageKey): StageDefinition | undefined {
  const raw = key === "done" ? cfg.done : cfg.delivered;
  const description = raw.description ?? undefined;
  const criteria = mapCriteria(raw.criteria);
  if (!description && criteria.length === 0) return undefined;

  const def: StageDefinition = { description, criteria };
  if (key === "delivered") {
    const d = cfg.delivered;
    if (d.detected_method != null) def.detectedMethod = d.detected_method as DeliveryMethod;
    if (d.confidence != null) def.confidence = d.confidence as Confidence;
    if (d.confidence_note != null) def.confidenceNote = d.confidence_note;
    def.learned = d.learned;
  }
  return def;
}

/** The snake_case payload the `set_stage_definition` command expects (matches Rust
 *  PartialDone / PartialDelivered). `undefined` optionals are sent as `null` (→ None in serde). */
function toConfigShape(key: StageKey, def: StageDefinition): Record<string, unknown> {
  const criteria = def.criteria.map((c) => ({
    text: c.text,
    kind: c.kind,
    signal: c.signal ?? null,
  }));
  const out: Record<string, unknown> = {
    description: def.description ?? null,
    criteria,
  };
  if (key === "delivered") {
    out.detected_method = def.detectedMethod ?? null;
    out.confidence = def.confidence ?? null;
    out.confidence_note = def.confidenceNote ?? null;
    out.learned = def.learned ?? false;
  }
  return out;
}

/** Persist a stage definition to the project's `.sparkle/config.toml` (insert-or-replace the whole
 *  `[done]`/`[delivered]` section, comments preserved). Maps camelCase → snake_case and invokes the
 *  Rust `set_stage_definition` command. */
export async function writeStageDef(
  projectRoot: string,
  key: StageKey,
  def: StageDefinition,
): Promise<void> {
  await invoke("set_stage_definition", {
    projectRoot,
    key,
    definition: toConfigShape(key, def),
  });
}
