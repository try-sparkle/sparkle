// Frontend wrapper over the Rust backlog-drainer command (src-tauri/src/drainer.rs). The drainer is
// the bounded fleet that auto-drains the sparkle-self agent-feedback bead backlog via a launchd
// supervisor (scripts/backlog-drainer.sh). Enabling it keeps the LaunchAgent installed; disabling it
// uninstalls it, so nothing is scheduled and no worker is ever spawned.
//
// Thin `invoke` shim (same pattern as services/roborev.ts). Swallows + logs its error rather than
// throwing: the caller (configActions.setDrainerEnabled) fires it as a best-effort side effect after
// the optimistic store update + config write already happened, so a launchd hiccup must never break
// the toggle or reject upward. The kill-switch is still honoured on the next launch regardless.
import { invoke } from "@tauri-apps/api/core";

/** Apply the drainer kill-switch NOW so a Settings toggle takes effect without an app restart:
 *  `enabled` installs the LaunchAgent supervisor, `!enabled` uninstalls it. Idempotent on the Rust
 *  side; never clones. Returns the subcommand that ran (`--install`/`--uninstall`), or null when the
 *  app-owned sparkle-self clone isn't present yet (nothing to do). Best-effort. */
export async function ensureBacklogDrainer(enabled: boolean): Promise<string | null> {
  try {
    return (await invoke<string | null>("ensure_backlog_drainer", { enabled })) ?? null;
  } catch (e) {
    console.warn("drainer: ensure failed", e);
    return null;
  }
}
