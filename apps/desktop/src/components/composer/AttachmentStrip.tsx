// The ONE way an attachment is drawn once it is attached — in the DRAFT you are composing and in
// the transcript after you send it.
//
// It used to be only the second of those (as `MessageAttachments`, PRD §8). The concierge compose
// box drew its own parallel strip: a 16×16 image squeezed into a filename chip, `cursor: default`,
// no click target and no lightbox. So the same screenshot was a thumbnail you could open in history
// and a favicon-sized smudge in the draft — two renderers for one concept, which is exactly how
// they drifted. There is now one, and the draft is a caller of it.
//
// It lives HERE, beside the lightbox it opens, rather than in components/Concierge: that directory's
// contract is "purely presentational — nothing reads a store, fetches data, or writes to a PTY", and
// ImageLightbox's copy/download actions go through Tauri. Keeping the Tauri-touching piece in the
// composer directory (which already owns it) is what lets both surfaces reuse the ONE lightbox
// instead of growing a second one.
import { useState } from "react";
// Feather, via react-icons — this repo bans emoji-as-icons.
import { FiFile, FiX } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { ImageLightbox } from "./ImageLightbox";
import { isImagePath, type Attachment } from "./attachments";
import { FONT_UI, PILL } from "../../theme/scale";

/** The sent-message strip's testid. Kept as the DEFAULT so the transcript's existing suite and any
 *  selector pointing at it are unaffected by the draft becoming a second caller. */
export const MESSAGE_ATTACHMENTS_TESTID = "concierge-message-attachments";

const THUMB_H = 72;

/** Can this attachment be DRAWN, as opposed to named?
 *
 *  Two conditions, and both are load-bearing. `isImagePath` is the shared predicate the loader used
 *  to set `kind` in the first place (attachments.ts) — reused rather than re-sniffing extensions
 *  here, so HEIC stays a file in both places instead of becoming a broken <img> in one of them. And
 *  `dataUrl` must actually be present: a message restored from localStorage has had its base64
 *  stripped, and an <img> with no src is a broken-image glyph where a chip belongs. */
function drawable(att: Attachment): att is Attachment & { dataUrl: string } {
  return !!att.dataUrl && (att.kind === "image" || isImagePath(att.path));
}

/** UPPERCASE extension for a chip's type label ("PDF"), or "" when the name has none. */
function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
}

/** A strip of attachments. Every item opens the full-size lightbox — images show the picture,
 *  everything else shows its name with a download. Renders nothing at all for an empty list, so a
 *  caller can hand it one unconditionally.
 *
 *  `onRemove` is what separates the two surfaces, and it is the ONLY thing that does. Passed (the
 *  draft), each item grows an × that takes it back out before send; omitted (the transcript), the
 *  strip is the read-only afterlife of what was already sent and there is nothing to take back. */
export function AttachmentStrip({
  attachments,
  onRemove,
  testId = MESSAGE_ATTACHMENTS_TESTID,
}: {
  attachments: Attachment[];
  onRemove?: (id: string) => void;
  testId?: string;
}) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  if (attachments.length === 0) return null;

  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        flexWrap: "wrap",
        // The × hangs 6px outside each item's top-right corner. Without the row gap and the top
        // padding it is clipped by the composer's own overflow and lands under the row above.
        gap: onRemove ? 10 : 6,
        paddingTop: onRemove ? 6 : 0,
        marginBottom: onRemove ? 8 : 6,
        lineHeight: 0,
      }}
    >
      {attachments.map((att) => {
        const shown = drawable(att);
        const ext = extensionLabel(att.name);
        return (
          // The remove control is a SIBLING of the preview button, never a child: a <button> inside
          // a <button> is invalid HTML, and browsers reparent it — which drops the × out of the
          // strip entirely rather than merely styling it oddly.
          <div key={att.id} style={{ position: "relative", lineHeight: 0 }}>
            <button
              type="button"
              onClick={() => setLightbox(att)}
              // The name is the accessible handle for both shapes: an image's <img alt> would name
              // the button anyway, but a chip's would come out as "notes.pdf PDF" — so it is stated.
              aria-label={`View ${att.name}`}
              // An image with no preview is the designed steady state after a restart (the base64 is
              // not persisted) and after the live-retention cap strips an older bubble — so the chip
              // says so rather than looking like a thumbnail that failed to load.
              title={shown || att.kind !== "image" ? att.name : `${att.name} — no preview available`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: shown ? 0 : "5px 8px",
                maxWidth: 160,
                borderRadius: 6,
                border: `1px solid color-mix(in srgb, ${C.muted} 30%, transparent)`,
                background: shown ? "transparent" : CHAT_USER_BUBBLE,
                cursor: "pointer",
                overflow: "hidden",
                font: "inherit",
              }}
            >
              {shown ? (
                <img
                  src={att.dataUrl}
                  alt={att.name}
                  // An image is natively `-webkit-user-drag: element`, so a press that lands on this
                  // thumbnail starts a NATIVE IMAGE DRAG instead of a text selection — and a sent
                  // bubble sits in the middle of the transcript, where a reader drags across
                  // messages to copy them. Same reasoning as helper/SparkleMark; the fix was never
                  // applied to the thumbnails.
                  draggable={false}
                  style={{
                    height: THUMB_H,
                    maxWidth: 158,
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              ) : (
                <>
                  <FiFile
                    size={13}
                    color={C.conciergeMuted}
                    aria-hidden
                    style={{ flex: "0 0 auto" }}
                  />
                  <span
                    style={{
                      fontFamily: FONT_UI,
                      fontSize: 12,
                      fontWeight: FONT_WEIGHT.semibold,
                      lineHeight: 1.3,
                      color: C.cream,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {att.name}
                  </span>
                  {ext && (
                    <span
                      style={{
                        fontFamily: FONT_UI,
                        fontSize: 10,
                        lineHeight: 1.3,
                        color: C.conciergeMuted,
                        flex: "0 0 auto",
                      }}
                    >
                      {ext}
                    </span>
                  )}
                </>
              )}
            </button>

            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(att.id)}
                aria-label={`Remove ${att.name}`}
                title="Remove"
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  // PILL, not a literal 9: on this square box that IS a circle, and the type/radius
                  // ratchet (theme/scale.test.ts) counts any off-scale borderRadius — 9 tripped it.
                  borderRadius: PILL,
                  background: C.sienna,
                  color: ON_BRAND_FILL,
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <FiX size={11} aria-hidden />
              </button>
            )}
          </div>
        );
      })}
      {lightbox && <ImageLightbox att={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
