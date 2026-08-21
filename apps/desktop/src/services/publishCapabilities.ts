import { invoke } from "@tauri-apps/api/core";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The publish destination's CAPABILITY PROBE, webview side (bead `sparkle-131ms.5`).
//
// The Rust half is `apps/desktop/src-tauri/src/publish_capabilities.rs`. The three command names
// and the shapes below are a FROZEN CONTRACT between units built in parallel — widen them in a
// follow-up, don't redefine them mid-build.
//
// EVERY FIELD HERE IS REQUIRED, and that is the whole point rather than an oversight.
//
// A Rust `Option` crosses the wire as `null`, NEVER as an absent key: serde's derive emits the key
// with a null value unless the field carries `skip_serializing_if`. TypeScript's `field?: T` means
// `T | undefined`, which does not include `null` — so a parser written against optional fields
// describes a shape the Rust side cannot produce, and a fixture written to match it (key omitted)
// tests a case that never occurs. That mismatch fails SILENTLY: an all-or-nothing parser rejects
// the payload and falls back to its "we did not look" default, so the feature is inert forever with
// nothing logged (see AGENTS.md, "A Rust `Option` crosses the wire as `null`").
//
// The fix taken here is structural rather than defensive: the Rust structs have no `Option` at all.
// An absent description is `""`, an absent schema is `null`, an empty list is `[]`. There is no
// absent case to model on this side, so there is nothing to get wrong.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The affordance keys a destination can earn — a CLOSED set, mirroring `AFFORDANCES` in
 * `publish_capabilities.rs`. The Rust side pins this same list in a test; a key added on one side
 * without the other is drift neither compiler can see.
 *
 * - `project-picker` — requires `list_projects`
 * - `image-attach` — requires `upload_image`
 * - `video-attach` — requires BOTH `create_video_upload_token` and `attach_video`
 * - `take-down` — requires `unpublish_content`
 */
export type PublishAffordance =
  | "project-picker"
  | "image-attach"
  | "video-attach"
  | "take-down";

/** Every affordance key, for a UI that wants to iterate the closed set rather than hand-list it. */
export const PUBLISH_AFFORDANCES: readonly PublishAffordance[] = [
  "project-picker",
  "image-attach",
  "video-attach",
  "take-down",
] as const;

/** What a destination can do. Mirrors Rust's `DestinationCapabilities` field for field. */
export interface DestinationCapabilities {
  /**
   * True only when nothing required is missing AND no required tool's argument shape is wrong.
   * Carried as its own field so the UI never re-derives the conjunction and gets it half-right.
   */
  valid: boolean;
  /** Required tools the destination does not expose. Empty when `valid`. */
  missingRequired: string[];
  /** Optional tools it does expose. */
  presentOptional: string[];
  /** Optional tools it does not. Not an error — each one hides an affordance. */
  missingOptional: string[];
  /** One human-readable message per problem, each naming the tool and the missing property. */
  argShapeProblems: string[];
  /** The affordance keys the UI may show. Empty when `valid` is false. */
  affordances: PublishAffordance[];
}

/** One tool as the destination declared it. `inputSchema` is `null` when it declared none. */
export interface ToolDescriptorDto {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Probe a destination: call its `tools/list` and diff the answer against Sparkle's contract.
 *
 * Read-only and side-effect free, so it is safe to run whenever the configure pane opens. Rejects
 * with the destination's own message when the endpoint, the URL or the credential is wrong — the
 * bearer is scrubbed host-side and never reaches this function.
 *
 * Pass `""` to probe whichever destination is active.
 */
export function probeDestination(destinationId: string): Promise<DestinationCapabilities> {
  return invoke<DestinationCapabilities>("destination_probe", { destinationId });
}

/** The destination's tool list, verbatim, for a configure pane that wants to show the detail. */
export function listDestinationTools(destinationId: string): Promise<ToolDescriptorDto[]> {
  return invoke<ToolDescriptorDto[]>("destination_list_tools", { destinationId });
}

/**
 * Call one of the destination's tools. The gate on WHICH tools may be called is the concierge
 * policy layer, not this wrapper — this is the transport.
 */
export function callDestinationTool(
  destinationId: string,
  tool: string,
  args: unknown,
): Promise<string> {
  return invoke<string>("destination_call_tool", { destinationId, tool, args });
}

/** Whether a probed destination offers a given affordance. */
export function hasAffordance(
  caps: DestinationCapabilities,
  affordance: PublishAffordance,
): boolean {
  return caps.affordances.includes(affordance);
}
