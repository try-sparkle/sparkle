// Pure model + helpers for the composer's attachment row: image/file tiles and
// collapsed text-paste pills. Kept free of React and Tauri so it's unit-testable
// (see attachments.test.ts). The UI (AttachmentRow, tiles, modals) and the IPC
// wrappers (attachmentsApi.ts) build on these.
import { shellQuotePath } from "../../services/shellQuote";

/** A file riding along with the next message — a screenshot, a dropped image, or any
 *  other dropped file. Its `path` is prefixed to the CLI payload so the agent reads it
 *  from disk (same trick screenshots have always used). Images also carry a `dataUrl`
 *  for the thumbnail / lightbox / clipboard source. */
export interface Attachment {
  id: string;
  kind: "image" | "file";
  /** Absolute filesystem path. */
  path: string;
  /** Basename, shown on file tiles and in the lightbox title. */
  name: string;
  /** `data:<mime>;base64,…` — present for images only. */
  dataUrl?: string;
}

/** A large pasted block, collapsed into a clickable pill instead of flooding the
 *  textarea. On send its full `text` is expanded inline into the payload. */
export interface TextBlock {
  id: string;
  text: string;
  lineCount: number;
}

/** "More than five lines" → a paste of six or more lines becomes a pill. */
export const PILL_MIN_LINES = 6;
/** …and a very large single-/few-line paste pills too, so an enormous one-liner (a
 *  base64 blob, a minified line) doesn't flood the textarea. */
export const PILL_MIN_CHARS = 2000;

// HEIC is intentionally excluded: Chromium WebViews can't render it in an <img>/data
// URL, so a HEIC drop falls through to a (downloadable) file tile rather than showing a
// broken preview.
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** Line count by newline boundaries. Empty string is zero lines; a trailing newline
 *  counts the empty final line (so "a\nb\n" is 3), matching a textarea's own row count. */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

export function shouldPasteAsPill(text: string): boolean {
  return countLines(text) >= PILL_MIN_LINES || text.length >= PILL_MIN_CHARS;
}

/** True when the path's extension is a known raster image type (case-insensitive).
 *  Mirrors the Rust `is_image_path` in attachments.rs — keep the two extension sets
 *  in sync. */
export function isImagePath(path: string): boolean {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false; // no extension, or a dotfile with no real ext
  return IMAGE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** Final path segment, tolerating a trailing slash. Pure string work (no fs). */
export function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

interface ComposeInput {
  attachments: Attachment[];
  textBlocks: TextBlock[];
  typed: string;
}

/** What the CLI receives: attachment paths (space-joined, read from disk by the agent)
 *  prefixed to the message body. The body is each pill's full text (in order) plus the
 *  typed text, separated by blank lines. Pills are a pure visual compaction — nothing is
 *  truncated. Sent via bracketed paste, so embedded newlines arrive atomically.
 *
 *  Paths are SHELL-quoted, not merely made-one-token. This payload does not always reach an
 *  agent CLI that reads a path without evaluating it: a `kind: "shell"` tab is a valid compose-box
 *  target (engine/shellResolve.decidePromptTarget refuses only cloud agents), so the line can land
 *  at a live bash/zsh prompt — and `submitPrompt` appends its own carriage return, so it RUNS with
 *  no user Enter. See services/shellQuote for the rule and what the old double-quoting let through
 *  (roborev 54375). */
export function buildSendPayload({ attachments, textBlocks, typed }: ComposeInput): string {
  const paths = attachments.map((a) => shellQuotePath(a.path));
  const body = [...textBlocks.map((b) => b.text), typed.trim()].filter(Boolean).join("\n\n");
  return [...paths, body].filter(Boolean).join(" ");
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What the transcript shows: the typed text plus compact counts of what's attached —
 *  never the raw temp-file paths (an ugly user-visible leak) and never a wall of pasted
 *  text. The agent's terminal still receives the full payload. */
export function buildDisplay({ attachments, textBlocks, typed }: ComposeInput): string {
  const images = attachments.filter((a) => a.kind === "image").length;
  const files = attachments.filter((a) => a.kind === "file").length;
  return [
    typed.trim(),
    textBlocks.length ? `📄 ${plural(textBlocks.length, "text block")}` : "",
    images ? `📷 ${plural(images, "image")}` : "",
    files ? `📎 ${plural(files, "file")}` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

/** The contiguous id range between `anchorId` and `targetId` (inclusive), in display
 *  order — for Shift-click range selection. Falls back to just the target when the
 *  anchor is unknown (e.g. the anchored tile was removed). */
export function rangeSelect(orderedIds: string[], anchorId: string, targetId: string): string[] {
  const i = orderedIds.indexOf(anchorId);
  const j = orderedIds.indexOf(targetId);
  if (i === -1 || j === -1) return [targetId];
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return orderedIds.slice(lo, hi + 1);
}
