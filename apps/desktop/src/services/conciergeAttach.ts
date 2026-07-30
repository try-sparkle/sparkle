// Attachments for the concierge compose box (parity row #21, bead sparkle-4562.3 / CM-U10).
//
// The compose box is the app's ONLY compose surface since CM-U7, so the file/image affordances the
// removed AgentPane composer had have to live here. This module is the seam between the compose
// box's three attach buttons (and a file drop on the box) and the attachment pipeline that already
// exists — components/composer/attachments* + screenshot.ts. Nothing is re-invented: an attachment
// is the SAME `Attachment` record the old composer built, loaded through the same `load_attachment`
// Rust command, and delivered by prefixing its absolute path to the prompt (`buildSendPayload`) so
// the agent reads the file from disk.
//
// PICKER CHOICE. `image`/`files` go through `services/dialog.ts`'s `pickFiles`, NOT
// `@tauri-apps/plugin-dialog`'s `open()`. They were on the plugin at first, on the theory that the
// nil-panel crash which moved the DIRECTORY dialog off it was directory-specific. It is not:
// `+[NSOpenPanel openPanel]` is one class method serving both, and the same panic pair (AppKit
// returns nil, the generated binding unwraps it, the plugin then unwraps the resulting RecvError)
// was observed from this file path too. Both modes now share one nil-checked Rust command.
//
// NEVER THROWS. A cancelled picker, a refused dialog, or a file that can't be read all resolve to
// "nothing was attached" — a failed attach must not take down a compose box the user is mid-thought
// in. Failures are logged.
import { pickFiles } from "./dialog";
import { pathKind, scrubPaths } from "./logSafePaths";
import { captureScreenRegion } from "../screenshot";
import {
  IMAGE_EXTENSIONS,
  basename,
  buildSendPayload,
  type Attachment,
} from "../components/composer/attachments";
import { loadAttachment, screenshotAttachment } from "../components/composer/attachmentsApi";
import type { ConciergeAttachKind } from "../components/Concierge/types";
import { log } from "../logger";

/** What a load attempt produced: the files that made it, and the ones that did not.
 *
 *  The failures are RETURNED rather than only logged because this used to swallow them entirely —
 *  a `.txt` the user dragged in was refused by the Rust containment check, discarded, and the only
 *  trace was a log line nobody reads (bead sparkle-zviq). The user watched the box light up and
 *  then had to notice an absence. A user-initiated action that fails has to say so. */
/** One file that did not attach, and WHY. The reason matters as much as the name: the app knew
 *  exactly why it refused ("outside allowed directories") and said nothing, which is what cost the
 *  user an hour. `reason` is path-scrubbed — the name is already stated, and the raw Rust message
 *  interpolates the absolute path into every failure. */
export interface AttachFailure {
  name: string;
  reason: string;
}

export interface AttachOutcome {
  /** The files that loaded, in the order they were given. */
  attachments: Attachment[];
  /** The ones that didn't, each with its reason. Empty on a fully successful load. */
  failed: AttachFailure[];
  /** Set when the operation failed as a WHOLE, before any file could be named (a picker that
   *  could not be presented). Distinct from `failed`, which names individual files. */
  error?: string;
}

/** Load dropped/picked paths into Attachment records. A file that can't be read is reported in
 *  `failed` rather than failing the whole batch — one unreadable path must not cost the user the
 *  other four they just picked, but it must not vanish either. */
export async function loadAttachmentPaths(paths: string[]): Promise<AttachOutcome> {
  const loaded = await Promise.all(
    paths.map((path) =>
      loadAttachment(path).catch((e: unknown) => {
        // Log the KIND and a path-stripped reason, never the path — this log ships with support
        // tickets (services/logSafePaths), and `load_attachment` interpolates the path we gave it
        // into every one of its failure messages.
        const raw = e instanceof Error ? e.message : String(e);
        const reason = scrubPaths(raw, path);
        log.error("composer", "concierge: load attachment failed", {
          kind: pathKind(path),
          reason,
        });
        return { failure: { name: basename(path), reason: humanReason(reason) } };
      }),
    ),
  );
  return {
    attachments: loaded.filter((a): a is Attachment => !("failure" in a)),
    failed: loaded.flatMap((a) => ("failure" in a ? [a.failure] : [])),
  };
}

/** Turn a Rust failure message into something worth reading in a compose box.
 *
 *  Unmapped reasons pass THROUGH rather than collapsing to "couldn't attach it": a raw message the
 *  user can search for beats a tidy one that says nothing, and this whole bug was the app knowing
 *  the reason and withholding it. */
function humanReason(scrubbed: string): string {
  const r = scrubbed.toLowerCase();
  // Should no longer reach a DRAGGED file (attachments.rs records OS-chosen paths), so if a user
  // ever sees this again it means the provenance registration did not fire — say so precisely.
  if (r.includes("outside allowed directories")) return "Sparkle isn't allowed to read that folder";
  if (r.includes("no such file")) return "the file no longer exists";
  if (r.includes("permission denied")) return "permission denied";
  return scrubbed;
}

/**
 * Run the picker for `kind` and resolve the attachments it produced — empty when the user
 * cancelled or the picker could not be opened. Never rejects.
 *
 * `screenshot` is the native macOS crosshair region capture the removed composer's camera button
 * used (src-tauri/src/screenshot.rs), not a clipboard read: it is a real capture affordance, so the
 * button keeps its literal promise.
 */
export async function pickAttachments(kind: ConciergeAttachKind): Promise<AttachOutcome> {
  try {
    if (kind === "screenshot") {
      // Blocks in Rust while the crosshair is up; Esc resolves null (a quiet no-op).
      const shot = await captureScreenRegion();
      return {
        attachments: shot ? [screenshotAttachment(shot.path, shot.dataUrl)] : [],
        failed: [],
      };
    }
    // `pickFiles` REPORTS a panel it could not present rather than throwing — it catches
    // everything internally and used to return a bare `[]`, which made an unopenable picker
    // indistinguishable from a cancel and left this path as silent as the drop used to be. The
    // reason has to come back through the return value; the catch below cannot see it.
    const picked =
      kind === "image"
        ? await pickFiles("Attach images", [...IMAGE_EXTENSIONS])
        : await pickFiles("Attach files");
    if (picked.error) return { attachments: [], failed: [], error: picked.error };
    return await loadAttachmentPaths(picked.paths);
  } catch (e) {
    log.error("composer", "concierge: attach picker failed", { kind, e });
    // A failure with no filenames to name reports itself without one — but it still reports the
    // reason it HAS. Naming the operation and then substituting a guessed cause is the same defect
    // as silence: the first draft of this said "Sparkle may not have screen-recording permission"
    // for every screenshot failure, which is a cause this code cannot observe. `screenshot.rs`
    // rejects only with `failed to launch screencapture: …` or `screencapture exited with …`; a
    // DENIED recording grant makes `screencapture` exit 0 without writing a file, which arrives as
    // `Ok(None)` and is treated as a quiet cancel above. So the guess was attached to the paths
    // least likely to be a permission problem while the real message was thrown away. The
    // permission is offered as a HINT after the actual reason, never in place of it.
    const reason = scrubPaths(e instanceof Error ? e.message : String(e));
    return {
      attachments: [],
      failed: [],
      error:
        kind === "screenshot"
          ? `Couldn't take the screenshot — ${reason}. If this keeps happening, check Sparkle's screen-recording permission.`
          : `The file picker could not be opened — ${reason}.`,
    };
  }
}

/** What the TARGET receives: the attachments' absolute paths (quoted, space-joined) prefixed to the
 *  typed text — the removed composer's exact payload shape, so an agent reads the files from disk.
 *  Identical on the brain path: the concierge's headless `claude -p` reads paths too. */
export function attachedPayload(text: string, attachments: Attachment[]): string {
  return buildSendPayload({ attachments, textBlocks: [], typed: text });
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * What the THREAD (and every prompt-history surface) shows: the typed text plus compact counts —
 * never the raw temp-file paths, which are a user-visible leak.
 *
 * NOT `buildDisplay`. That renders its counts with emoji as icons (`📷 1 image`), which was
 * tolerable inside the old composer's own tile row but is banned in the concierge surfaces —
 * icons come from react-icons/fi (see TerminalDropPill's header), emoji never stand in for them
 * (roborev 46911). `buildDisplay` keeps its glyphs for the Composer, which is the only caller left
 * and no longer renders in any pane (the Sparkle pane's composer was stripped when Improve Sparkle
 * became a mounted build agent); this is the concierge's own glyph-free rendering of the same counts.
 */
export function attachedDisplay(text: string, attachments: Attachment[]): string {
  const images = attachments.filter((a) => a.kind === "image").length;
  const files = attachments.filter((a) => a.kind !== "image").length;
  return [text.trim(), images ? plural(images, "image") : "", files ? plural(files, "file") : ""]
    .filter(Boolean)
    .join(" · ");
}
