// STEERING FILES — the project's architecture map and standards, pushed into every agent.
//
// Thin wrapper over the Rust `steering_*` commands (`src-tauri/src/steering.rs`). The shapes here
// mirror the Rust structs (serde camelCase). No logic beyond the wire lives in this file; the
// resolution order, the fail-closed rule and the size cap are all Rust's, so the editor and the
// spawn path cannot disagree with the thing that actually seeds the worktrees.
//
// ── A RUST `Option<T>` ARRIVES AS `null`, NOT AS AN ABSENT KEY ─────────────────────────────────
// serde emits the key with a null value for `None`. `field?: T` in TypeScript means `T | undefined`
// and EXCLUDES null, so it describes a shape the wire cannot produce. Every optional below is
// therefore written `T | null` and treated as "absent" when null.
import { invoke } from "@tauri-apps/api/core";

/** Which layer supplied a file. Serialized snake_case by serde; there are no multi-word names. */
export type SteeringLayer = "global" | "project" | "local";

/** One steering document, resolved across the layers. */
export interface SteeringFile {
  /** The bare filename, e.g. `architecture.md`. */
  name: string;
  /** The layer that supplied `content`. Null when the file is absent everywhere, and ALSO when the
   *  search stopped on `error` — an unreadable layer supplies nothing. */
  layer: SteeringLayer | null;
  /** Absolute path of the file that supplied `content`, or of the one that could not be read. */
  path: string | null;
  content: string | null;
  /** FAIL-CLOSED marker: a layer that exists and could not be read. Never treat this as "absent" —
   *  the whole point of the flag is that the two are different. */
  error: string | null;
}

export interface SteeringStatus {
  /** `[steering].enabled`. */
  enabled: boolean;
  files: SteeringFile[];
  globalDir: string;
  projectDir: string;
  localDir: string;
}

export interface SteeringSeedReport {
  created: string[];
  skippedExisting: string[];
  skippedEmpty: string[];
  errors: string[];
}

/** Human-facing name for a layer — matches `SteeringLayer::label` in Rust. */
export function layerLabel(layer: SteeringLayer | null): string {
  switch (layer) {
    case "global":
      return "global";
    case "project":
      return "project";
    case "local":
      return "local override";
    default:
      return "not set";
  }
}

/** Every configured steering file, which layer supplied it, and where the layers live. */
export function fetchSteeringStatus(root: string): Promise<SteeringStatus> {
  return invoke<SteeringStatus>("steering_status", { root });
}

/** One configured file's resolved content. Rejects for a name outside the configured set. */
export function readSteeringFile(root: string, name: string): Promise<SteeringFile> {
  return invoke<SteeringFile>("steering_read", { root, name });
}

/**
 * Write one steering file into the `project` or `local` layer, resolving to its absolute path.
 *
 * The `global` layer is deliberately not writable from here: it is a machine-wide fallback, and one
 * project's editor changing it would change every other project's default.
 */
export function writeSteeringFile(
  root: string,
  name: string,
  content: string,
  layer: Exclude<SteeringLayer, "global">,
): Promise<string> {
  return invoke<string>("steering_write", { root, name, content, layer });
}

/** Write the shipped templates for any configured file that exists in no layer yet. */
export function seedSteeringTemplates(root: string): Promise<SteeringSeedReport> {
  return invoke<SteeringSeedReport>("steering_seed_templates", { root });
}

/**
 * The HARD-CONSTRAINT text an agent spawned in this project should be born with.
 *
 * Empty string when steering is off, when `inject_at_preflight` is off, or when there is nothing to
 * say — so a caller can concatenate unconditionally. Rust applies `max_inject_bytes` and announces
 * any truncation inside the returned text.
 */
export function fetchSteeringPreflightBlock(root: string): Promise<string> {
  return invoke<string>("steering_preflight_block", { root });
}
