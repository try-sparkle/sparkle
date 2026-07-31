// The file paths a webview drop carries — including the ones Tauri hands us as an empty list.
//
// THE BUG THIS EXISTS FOR. "We can no longer drag photos or files into the Compose window. It
// doesn't work on any of the buttons." The compose box lit up under the drag, then swallowed the
// drop — on every drop surface, with NOTHING in the log.
//
// Two halves, and both had to be true for it to be invisible:
//
//   1. wry's macOS drag handler reads exactly one pasteboard type, the deprecated
//      `NSFilenamesPboardType` (see src-tauri/src/drag_paths.rs for the upstream source). Finder
//      still publishes it, so a Finder drag always worked; a source that publishes only the modern
//      `public.file-url` — Photos, a browser image, Slack, the macOS screenshot thumbnail — arrives
//      with `paths: []`.
//   2. Every one of the four drop listeners then guarded with a bare `if (paths.length === 0)
//      return;`. A SILENT return. And because the cursor genuinely was over a real target,
//      `reportDropWithNoTarget` self-suppresses as well (it only speaks for a position over NO
//      known target). So the app painted the affordance from the `enter`/`over` events — which do
//      not consult `paths` at all — and then discarded the file without a word.
//
// That is why the log for a whole session of failed drops is empty, and why this helper's SECOND
// job matters as much as its first: a drop that still yields nothing now WARNS. An unexplained
// silent discard on a path the founder uses constantly is the expensive failure, not the missing
// paths themselves.
//
// USED BY ALL FOUR LISTENERS (Composer, useConciergeAttachments, useNewBuildAgentDrop,
// useTerminalDrop) rather than copied into each. Same reasoning as FILE_DROP_TARGETS living in
// services/dndTargets: a private copy per listener is how three of them get fixed and the fourth
// silently keeps the bug.
import { invoke } from "@tauri-apps/api/core";
import { describePaths } from "./logSafePaths";
import { log } from "../logger";

/**
 * Resolve the paths for a drop, recovering them from the drag pasteboard when the event carried
 * none. Returns `[]` only when the drag really had no readable file — and says so in the log.
 *
 * `where` names the surface for the log line; it is a fixed string per call site, never user data.
 */
export async function resolveDropPaths(
  eventPaths: string[] | undefined,
  where: string,
): Promise<string[]> {
  const direct = eventPaths ?? [];
  // The overwhelmingly common case (any Finder drag) — no IPC, no await cost that matters.
  if (direct.length > 0) return direct;

  let recovered: string[] = [];
  try {
    recovered = (await invoke<string[]>("recover_drag_paths")) ?? [];
  } catch (e) {
    // Recovery is a BACKSTOP, so its own failure must not take the drop down with it: fall through
    // to the warning below, which is still strictly better than the silent return this replaced.
    log.error("composer", "drag path recovery failed", { where, reason: String(e) });
  }

  if (recovered.length > 0) {
    log.info(
      "composer",
      `recovered ${recovered.length} dropped path(s) the drag event omitted`,
      { where, ...describePaths(recovered) },
    );
    return recovered;
  }

  // Kinds and counts only everywhere else in this file's logging; here there is nothing to
  // describe, which is itself the point of the line.
  log.warn("composer", "a file was dropped but the drag carried no readable path", { where });
  return [];
}

/**
 * Run `handle` with the drop's paths — SYNCHRONOUSLY when the event carried them.
 *
 * This is what the four listeners call, and the synchronous fast path is the point. A drag that
 * already has paths (every Finder drag, i.e. the overwhelming majority) must reach `handle` in the
 * same tick it always did: the recovery is a backstop for a case that used to do nothing at all,
 * and it has no business adding a microtask — or a behavioural change of any kind — to the path
 * that was already working. Only the previously-silent empty case goes async, because only it has
 * to cross IPC to find out whether there was a file.
 *
 * `handle` is not called at all when nothing can be recovered; `resolveDropPaths` has already
 * warned by then, naming `where`.
 */
export function withDropPaths(
  eventPaths: string[] | undefined,
  where: string,
  handle: (paths: string[]) => void,
): void {
  const direct = eventPaths ?? [];
  if (direct.length > 0) {
    handle(direct);
    return;
  }
  void resolveDropPaths(direct, where).then((paths) => {
    if (paths.length > 0) handle(paths);
  });
}
