// Frontend wrapper over the concierge-guidelines commands (src-tauri/src/concierge_guidelines.rs).
// The markdown file is the single source of truth; this module is the only place the UI talks to
// it, exactly as services/config.ts is for config.toml.
//
// WHAT THE FILE IS FOR. The founder's ask: "a durable, growing place for rules about how the
// concierge communicates, so preferences accumulate instead of being re-explained." App-owned
// rather than model memory, because the user can read and edit this, it survives a harness change
// or a session reset, and it is versionable and diffable. Rust reads it on EVERY turn and appends
// it to the concierge's system prompt — nothing on this side has to remember to send it, and
// nothing here can forget to.
//
// THE ATTRIBUTION ARGUMENT IS NOT DECORATION. The founder chose auto-append-then-announce over an
// approval gate, so the concierge writes rules into this file without being asked twice. The only
// thing that makes an unwanted rule findable afterwards is the line recording who added it and
// when — which makes the Settings editor a REQUIREMENT of that choice, not a nice-to-have. Never
// call {@link appendConciergeGuideline} with a vague attribution.
import { invoke } from "@tauri-apps/api/core";

/** The whole file as text — the seed template when it does not exist yet, so an editor always opens
 *  with something sensible rather than a blank box. (Same contract `readConfigText` has.) */
export function readConciergeGuidelines(): Promise<string> {
  return invoke<string>("read_concierge_guidelines");
}

/** Overwrite the whole file — the editor's Save.
 *
 *  REJECTS text over the Rust-side cap, and the rejection is the point: this text becomes part of a
 *  process argument on every single concierge turn, so an unbounded file is an unbounded command
 *  line. A rejected save leaves the file and the live behaviour untouched; surface the error rather
 *  than swallowing it. */
export function writeConciergeGuidelines(text: string): Promise<void> {
  return invoke<void>("write_concierge_guidelines", { text });
}

/**
 * Append ONE attributed rule, creating the file from the seed first if it is absent. Resolves to
 * the file's new full text, so a caller can show the result without a second read.
 *
 * `attribution` says where the rule came from — it is written into the file beside the rule, with
 * the date. See the module header for why that is load-bearing.
 */
export function appendConciergeGuideline(rule: string, attribution: string): Promise<string> {
  return invoke<string>("append_concierge_guideline", { rule, attribution });
}

/** Absolute path to the file, for "Reveal in Finder". Reported whether or not it exists yet — the
 *  caller may be about to create it. */
export function conciergeGuidelinesPath(): Promise<string> {
  return invoke<string>("concierge_guidelines_path");
}
