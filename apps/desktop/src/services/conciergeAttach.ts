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
// PICKER CHOICE. `image`/`files` go through `@tauri-apps/plugin-dialog`'s `open()` — the FILE
// dialog, which is what attachmentsApi.ts already uses. Only the DIRECTORY dialog was moved off the
// plugin (services/dialog.ts: AppKit returned nil from +[NSOpenPanel openPanel] and the plugin's
// binding panicked); the file case never had that crash, so it stays on the plugin rather than
// growing a second Rust command.
//
// NEVER THROWS. A cancelled picker, a refused dialog, or a file that can't be read all resolve to
// "nothing was attached" — a failed attach must not take down a compose box the user is mid-thought
// in. Failures are logged.
import { open } from "@tauri-apps/plugin-dialog";
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

/** Normalize the dialog plugin's return (string | string[] | null) to a path list. */
function toPaths(picked: string | string[] | null): string[] {
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
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
    const picked = await open(
      kind === "image"
        ? {
            multiple: true,
            title: "Attach images",
            filters: [{ name: "Images", extensions: [...IMAGE_EXTENSIONS] }],
          }
        : { multiple: true, title: "Attach files" },
    );
    return await loadAttachmentPaths(toPaths(picked as string | string[] | null));
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
