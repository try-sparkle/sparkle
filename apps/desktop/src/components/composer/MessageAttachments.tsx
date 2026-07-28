// What a SENT message's attachments look like in the transcript (PRD §8).
//
// The composer's own row (AttachmentRow/AttachmentTile) is about STAGING: it removes, multi-selects,
// and is cleared on send. This is the read-only afterlife of that row — a strip drawn inside the
// user's chat bubble from the snapshot the message carries, so scrolling back shows the screenshot
// that was sent rather than the words "1 image".
//
// It lives HERE, beside the lightbox it opens, rather than in components/Concierge: that directory's
// contract is "purely presentational — nothing reads a store, fetches data, or writes to a PTY", and
// ImageLightbox's copy/download actions go through Tauri. Keeping the Tauri-touching piece in the
// composer directory (which already owns it) is what lets the thread reuse the ONE lightbox instead
// of growing a second one.
import { useState } from "react";
// Feather, via react-icons — this repo bans emoji-as-icons.
import { FiFile } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../../theme/colors";
import { ImageLightbox } from "./ImageLightbox";
import { isImagePath, type Attachment } from "./attachments";

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

/** The attachment strip inside a sent user bubble. Every item opens the full-size lightbox —
 *  images show the picture, everything else shows its name with a download. Renders nothing at all
 *  for a message that carried no files, so the caller can hand it an empty list unconditionally. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  if (attachments.length === 0) return null;

  return (
    <div
      data-testid={MESSAGE_ATTACHMENTS_TESTID}
      style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6, lineHeight: 0 }}
    >
      {attachments.map((att) => {
        const shown = drawable(att);
        const ext = extensionLabel(att.name);
        return (
          <button
            key={att.id}
            type="button"
            onClick={() => setLightbox(att)}
            // The name is the accessible handle for both shapes: an image's <img alt> would name the
            // button anyway, but a chip's would come out as "notes.pdf PDF" — so it is stated.
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
              borderRadius: 8,
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
                style={{
                  height: THUMB_H,
                  maxWidth: 158,
                  objectFit: "cover",
                  display: "block",
                }}
              />
            ) : (
              <>
                <FiFile size={13} color={C.conciergeMuted} aria-hidden style={{ flex: "0 0 auto" }} />
                <span
                  style={{
                    fontFamily: '"IBM Plex Sans", sans-serif',
                    fontSize: 11.5,
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
                      fontFamily: '"IBM Plex Sans", sans-serif',
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
        );
      })}
      {lightbox && <ImageLightbox att={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
