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
import { captureScreenRegion } from "../screenshot";
import {
  IMAGE_EXTENSIONS,
  buildSendPayload,
  type Attachment,
} from "../components/composer/attachments";
import { loadAttachment, screenshotAttachment } from "../components/composer/attachmentsApi";
import type { ConciergeAttachKind } from "../components/Concierge/types";
import { log } from "../logger";

/** Load dropped/picked paths into Attachment records. A file that can't be read is dropped (with a
 *  log line) rather than failing the whole batch — one unreadable path must not cost the user the
 *  other four they just picked. */
export async function loadAttachmentPaths(paths: string[]): Promise<Attachment[]> {
  const loaded = await Promise.all(
    paths.map((path) =>
      loadAttachment(path).catch((e) => {
        log.error("composer", "concierge: load attachment failed", { path, e });
        return null;
      }),
    ),
  );
  return loaded.filter((a): a is Attachment => a !== null);
}

/**
 * Run the picker for `kind` and resolve the attachments it produced — empty when the user
 * cancelled or the picker could not be opened. Never rejects.
 *
 * `screenshot` is the native macOS crosshair region capture the removed composer's camera button
 * used (src-tauri/src/screenshot.rs), not a clipboard read: it is a real capture affordance, so the
 * button keeps its literal promise.
 */
export async function pickAttachments(kind: ConciergeAttachKind): Promise<Attachment[]> {
  try {
    if (kind === "screenshot") {
      // Blocks in Rust while the crosshair is up; Esc resolves null (a quiet no-op).
      const shot = await captureScreenRegion();
      return shot ? [screenshotAttachment(shot.path, shot.dataUrl)] : [];
    }
    const picked =
      kind === "image"
        ? await pickFiles("Attach images", [...IMAGE_EXTENSIONS])
        : await pickFiles("Attach files");
    return await loadAttachmentPaths(picked);
  } catch (e) {
    log.error("composer", "concierge: attach picker failed", { kind, e });
    return [];
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
 * (roborev 46911). `buildDisplay` keeps its glyphs for the Sparkle-pane Composer, which still
 * uses it; this is the concierge's own glyph-free rendering of the same counts.
 */
export function attachedDisplay(text: string, attachments: Attachment[]): string {
  const images = attachments.filter((a) => a.kind === "image").length;
  const files = attachments.filter((a) => a.kind !== "image").length;
  return [text.trim(), images ? plural(images, "image") : "", files ? plural(files, "file") : ""]
    .filter(Boolean)
    .join(" · ");
}
