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
 *  textarea. On send its full `text` is expanded inline into the payload.
 *
 *  `text` IS THE ORIGINAL, BYTE FOR BYTE. Nothing in this module trims, normalises or
 *  re-wraps it, and nothing may start to: collapsing is a display decision, and the one
 *  guarantee the whole feature rests on is that what leaves a compose surface is what the
 *  user pasted into it. See {@link composeBody} for where that is cashed in and
 *  attachments.test.ts's round-trip for the assertion that pins it. */
export interface TextBlock {
  id: string;
  text: string;
  lineCount: number;
}

/**
 * The BUBBLE-ONLY decomposition of a send: the pills that were staged, and the words typed around
 * them.
 *
 * WHAT IT IS NOT. It is not what gets sent. A compose surface still hands its host the WHOLE body
 * as the first argument — every block's full text spliced in by {@link composeBody} — and this
 * rides alongside it purely so the transcript can draw the pills again instead of the wall of text
 * they were collapsed to keep out of the box. The founder's ask, in his words: *"I want that same
 * functionality when I'M the one sending big blocks of text."*
 *
 * THE SPLIT IS PASSED, NEVER RE-DERIVED, and that is the whole reason this shape exists. A reader
 * would reasonably try to recover it from the composed body — `composeBody` joins with a blank
 * line, so a blank-line split looks like its inverse. IT IS NOT ONE: a pasted diff or a stack
 * trace contains blank lines of its own, so that split shreds one block into several segments,
 * each of which is then under the collapse threshold and none of which is the block that was
 * pasted. The compose box is the only place that knows where a block starts and ends, so it says.
 */
export interface CollapsedSend {
  /** The staged blocks, in paste order — the same records the compose box drew as pills. */
  blocks: TextBlock[];
  /** What was typed AROUND them. `""` on a send that is nothing but a paste. */
  typed: string;
}

/** "More than five lines" → a paste of six or more lines becomes a pill.
 *
 *  A NAMED CONSTANT because the founder picked the number loosely ("let's say five rows"),
 *  so it is a tuning knob rather than a fact — and a literal `6` sprinkled across a paste
 *  handler, a pill's copy and three tests is how a loose number becomes unchangeable. */
export const PILL_MIN_LINES = 6;
/** …and a very large single-/few-line paste pills too, so an enormous one-liner (a
 *  base64 blob, a minified line) doesn't flood the textarea. */
export const PILL_MIN_CHARS = 2000;
/** How much of the first line goes on a pill's face. See {@link pillPreview}. */
export const PILL_PREVIEW_CHARS = 60;

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

/**
 * The identifying line on a collapsed pill's face.
 *
 * A PILL MUST BE READABLE WITHOUT BEING OPENED. Two pills both reading "Pasted text · 41
 * lines" are worse than the three visible rows they replaced, because finding the one you
 * meant then costs a modal each — so the pill leads with the paste's own first words and
 * keeps the count as the subtitle, not the headline.
 *
 * Takes the first NON-BLANK line: a brief pasted out of a chat window or an editor very often
 * starts with a blank line or a heading rule, and a pill whose face is empty is the exact
 * failure this function exists to prevent. Interior whitespace is flattened because the face
 * is one row of UI, so a tab in the source would otherwise open a gap in the middle of it.
 */
export function pillPreview(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const flat = line.trim().replace(/\s+/g, " ");
  return flat.length > PILL_PREVIEW_CHARS ? `${flat.slice(0, PILL_PREVIEW_CHARS - 1)}…` : flat;
}

/** Capture a paste as a collapsed block — the ONE place a `TextBlock` is built, so every
 *  surface's pill carries the same verbatim text and the same line count. */
export function collapseText(id: string, text: string): TextBlock {
  return { id, text, lineCount: countLines(text) };
}

/**
 * "Show as regular text": put a collapsed block's full text back into a compose box.
 *
 * The ONE expand rule, shared by both compose surfaces. Appended on its own line when there
 * is already something in the box, and into an EMPTY box it is the block's text and nothing
 * else — which is the case the round-trip guarantee is stated over (expand → collapse → send
 * is byte-identical to the paste).
 */
export function expandTextBlock(current: string, block: TextBlock): string {
  if (!current) return block.text;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${block.text}`;
}

/**
 * The message body a compose surface sends: every collapsed block's FULL text, in order,
 * followed by whatever was typed around them. Blank-line separated.
 *
 * THIS IS WHERE COLLAPSING IS PROVEN LOSSLESS, and it is one function on purpose: it exists so
 * that a second compose surface cannot grow its own idea of what a pill expands to — and the
 * failure that would be silent is precisely a surface transmitting a pill's
 * LABEL instead of its text. A block's text is interpolated untouched (never trimmed: a
 * pasted diff's leading indentation is content), so a lone block in an empty box comes out
 * of here byte-identical to what was pasted in.
 *
 * ── `verbatimTyped`, AND WHY THE TRIM IS NOT UNCONDITIONAL ────────────────────────────────
 * `typed.trim()` is right for text a human typed: a stray trailing newline should not ride
 * into an agent's terminal. It is WRONG for text that got into the box by expanding a pill,
 * and that is not a hypothetical — it is the second half of the round trip the whole feature
 * promises. "Show as regular text" moves a block's bytes into the box, where they stop being
 * a block and become `typed`; trimming them there strips exactly what a block is careful to
 * preserve. A pasted diff indented four spaces, expanded and sent, arrived dedented and with
 * its trailing newline gone (roborev 55720) — a silent corruption of the user's own text, on
 * the one path the reversibility guarantee is about.
 *
 * So the caller says when the typed text HAS BEEN THROUGH A PILL EXPANSION. It may have been
 * freely edited since — editing is why anyone expands a pill — and it is still the paste's own
 * bytes at the front, which is the whole reason the leading trim must not run.
 *
 * IT IS A LATCH THE CALLER HOLDS, NOT A BYTE COMPARISON, and that distinction is the finding
 * this doc exists to stop someone re-deriving. The first version of the rule compared the box's
 * text to the exact string `expandTextBlock` returned, which reads as stronger and is broken:
 * the exemption evaporated on the first keystroke, so expand → type one character → send still
 * arrived dedented (roborev 55728). A fourth surface wired through this function must take the
 * latch, not the comparison.
 */
export function composeBody(
  textBlocks: TextBlock[],
  typed: string,
  { verbatimTyped = false }: { verbatimTyped?: boolean } = {},
): string {
  const body = verbatimTyped ? typed : typed.trim();
  return [...textBlocks.map((b) => b.text), body].filter(Boolean).join("\n\n");
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
  /** This text has been through a pill expansion (possibly edited since) and must not be trimmed —
   *  a latch the compose box holds, never a byte comparison. See {@link composeBody}. */
  verbatimTyped?: boolean;
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
export function buildSendPayload({
  attachments,
  textBlocks,
  typed,
  verbatimTyped,
}: ComposeInput): string {
  const paths = attachments.map((a) => shellQuotePath(a.path));
  // Through `composeBody`, not a second copy of its join — the concierge's compose box needs the
  // same body without the path prefix, and two expansion rules is how one surface ends up
  // transmitting a pill's label (see composeBody).
  const body = composeBody(textBlocks, typed, { verbatimTyped });
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
