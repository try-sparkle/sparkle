import { useState } from "react";
import { C, FONT_WEIGHT } from "../../theme/colors";
import { ModalOverlay } from "./ModalOverlay";
import { CopyIcon, DownloadIcon } from "./icons";
import { copyImageToClipboard, downloadAttachment } from "./attachmentsApi";
import type { Attachment } from "./attachments";
import { log } from "../../logger";

/** Expanded view of a single attachment. Images render full-size with copy + download
 *  actions in the top-right; non-image files show their name with download only. */
export function ImageLightbox({ att, onClose }: { att: Attachment; onClose: () => void }) {
  // Transient confirmation label on the copy button ("Copied!"), reset by the next open.
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const onCopy = async () => {
    try {
      await copyImageToClipboard(att.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      log.error("composer", "copy image failed", e);
    }
  };

  const onDownload = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await downloadAttachment(att);
    } catch (e) {
      log.error("composer", "download attachment failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay onClose={onClose} maxWidth={900}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 12px",
          borderBottom: `1px solid ${C.deepForest}`,
          flex: "0 0 auto",
        }}
      >
        <span
          title={att.path}
          style={{
            color: C.cream,
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: 13,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {att.name}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
          {att.kind === "image" && (
            <button
              onClick={() => void onCopy()}
              title="Copy image to clipboard"
              style={iconBtn}
            >
              <CopyIcon />
              {copied && <span style={{ fontSize: 12 }}>Copied!</span>}
            </button>
          )}
          <button
            onClick={() => void onDownload()}
            disabled={busy}
            title="Download…"
            style={iconBtn}
          >
            <DownloadIcon />
          </button>
          <button onClick={onClose} title="Close" style={{ ...iconBtn, fontSize: 20 }}>
            ×
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          background: C.deepForest,
          flex: 1,
          minHeight: 0,
          overflow: "auto",
        }}
      >
        {att.kind === "image" && att.dataUrl ? (
          <img
            src={att.dataUrl}
            alt={att.name}
            style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", display: "block" }}
          />
        ) : (
          <span style={{ color: C.muted, fontFamily: '"IBM Plex Sans", sans-serif', fontSize: 14 }}>
            No preview available — use Download to save this file.
          </span>
        )}
      </div>
    </ModalOverlay>
  );
}

const iconBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: "none",
  color: C.cream,
  cursor: "pointer",
  padding: "6px 8px",
  borderRadius: 6,
  lineHeight: 1,
};
