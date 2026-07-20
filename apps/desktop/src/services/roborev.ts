// Frontend wrappers over the Rust roborev commands (src-tauri). roborev is the per-commit AI
// code-review daemon we ship to end-users: enabling it installs the daemon + wires each project's
// git hooks so every commit a BUILD agent makes gets a quick review; disabling it tears both down.
//
// These are thin `invoke` shims (same pattern as services/config.ts). Every call swallows +logs its
// error rather than throwing: the callers (configActions.setRoborevEnabled) fire these as best-effort
// side effects after the optimistic store update + config write already happened, so a daemon/hook
// hiccup must never break the toggle or reject upward.
import { invoke } from "@tauri-apps/api/core";

/** Install + activate the roborev daemon (idempotent on the Rust side). Best-effort. */
export async function installRoborev(): Promise<void> {
  try {
    await invoke("install_roborev");
  } catch (e) {
    console.warn("roborev: install failed", e);
  }
}

/** Deactivate the roborev daemon (leaves it installed but dormant). Best-effort. */
export async function deactivateRoborev(): Promise<void> {
  try {
    await invoke("deactivate_roborev");
  } catch (e) {
    console.warn("roborev: deactivate failed", e);
  }
}

/** Verdict from the Rust auth self-test. Mirrors `setup::RoborevAuthVerdict`, which serializes with
 *  serde `tag = "kind", content = "detail"` — so unit variants are `{kind}` and Unknown carries the
 *  raw probe output in `detail`. */
export type RoborevAuthVerdict =
  | { kind: "Passed" }
  | { kind: "ClaudeMissing" }
  | { kind: "NotAuthenticated" }
  | { kind: "Unknown"; detail: string };

/** Probe whether roborev can actually authenticate claude in the daemon's own environment.
 *  Unlike the other calls here this one's RESULT matters (it gates the toggle), so callers must
 *  handle `undefined` — meaning the probe itself couldn't run, which is not a pass. */
export async function roborevAuthSelftest(): Promise<RoborevAuthVerdict | undefined> {
  try {
    return await invoke<RoborevAuthVerdict>("roborev_auth_selftest");
  } catch (e) {
    console.warn("roborev: auth self-test could not run", e);
    return undefined;
  }
}

/** Preflight check (auth / binary / environment) before relying on roborev. Best-effort; returns
 *  whatever the Rust command yields (shape owned by Rust — the UI doesn't type-check it). */
export async function roborevPreflight(): Promise<unknown> {
  try {
    return await invoke("roborev_preflight");
  } catch (e) {
    console.warn("roborev: preflight failed", e);
    return undefined;
  }
}

/** Wire roborev's git hooks into one repo (by root path). Best-effort — swept over every project
 *  when roborev is turned on. */
export async function installRepoHooks(path: string): Promise<void> {
  try {
    await invoke("install_repo_hooks_cmd", { path });
  } catch (e) {
    console.warn("roborev: install repo hooks failed", path, e);
  }
}

/** Remove roborev's git hooks from one repo (by root path). Best-effort — swept over every project
 *  when roborev is turned off. */
export async function removeRepoHooks(path: string): Promise<void> {
  try {
    await invoke("remove_repo_hooks_cmd", { path });
  } catch (e) {
    console.warn("roborev: remove repo hooks failed", path, e);
  }
}
