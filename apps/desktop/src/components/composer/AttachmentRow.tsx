import { useMemo, useState, type MouseEvent } from "react";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { TextPill } from "./TextPill";
import { TextPillModal } from "./TextPillModal";
import { AttachmentTile } from "./AttachmentTile";
import { ImageLightbox } from "./ImageLightbox";
import { DownloadIcon } from "./icons";
import { downloadAttachments } from "./attachmentsApi";
import { rangeSelect, type Attachment, type TextBlock } from "./attachments";
import { log } from "../../logger";

/** The row above the textarea: collapsed text pills + image/file tiles, with multi-select
 *  (checkbox and Cmd/Shift-click) and a bulk-download action. Owns its own selection and
 *  which modal is open; the composer owns the underlying data and the remove/expand actions. */
export function AttachmentRow({
  textBlocks,
  attachments,
  onRemoveTextBlock,
  onRemoveAttachment,
  onShowAsText,
}: {
  textBlocks: TextBlock[];
  attachments: Attachment[];
  onRemoveTextBlock: (id: string) => void;
  onRemoveAttachment: (id: string) => void;
  onShowAsText: (block: TextBlock) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [openBlock, setOpenBlock] = useState<TextBlock | null>(null);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const ids = useMemo(() => attachments.map((a) => a.id), [attachments]);

  // Drop selections/anchor that point at removed tiles so the count never lies.
  const liveSelected = useMemo(() => {
    const live = new Set<string>();
    for (const id of selected) if (ids.includes(id)) live.add(id);
    return live;
  }, [selected, ids]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };

  const onTileBody = (att: Attachment, e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      toggle(att.id);
    } else if (e.shiftKey) {
      // Range-select from the anchor; with no anchor yet (first interaction), select just
      // this tile and make it the anchor for the next Shift-click.
      setSelected(new Set(anchor ? rangeSelect(ids, anchor, att.id) : [att.id]));
      setAnchor(att.id);
    } else {
      setLightbox(att);
    }
  };

  const selectedAttachments = attachments.filter((a) => liveSelected.has(a.id));

  const bulkDownload = async () => {
    if (bulkBusy || selectedAttachments.length === 0) return;
    setBulkBusy(true);
    try {
      const ok = await downloadAttachments(selectedAttachments);
      if (ok) setSelected(new Set());
    } catch (e) {
      log.error("composer", "bulk download failed", e);
    } finally {
      setBulkBusy(false);
    }
  };

  if (textBlocks.length === 0 && attachments.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", flex: "0 0 auto" }}>
      {textBlocks.map((b) => (
        <TextPill
          key={b.id}
          block={b}
          onOpen={() => setOpenBlock(b)}
          onRemove={() => onRemoveTextBlock(b.id)}
        />
      ))}

      {attachments.map((a) => (
        <AttachmentTile
          key={a.id}
          att={a}
          selected={liveSelected.has(a.id)}
          anySelected={liveSelected.size > 0}
          onBodyClick={(e) => onTileBody(a, e)}
          onToggleSelect={(e) => {
            e.stopPropagation();
            toggle(a.id);
          }}
          onRemove={() => onRemoveAttachment(a.id)}
        />
      ))}

      {liveSelected.size > 0 && (
        <button
          onClick={() => void bulkDownload()}
          disabled={bulkBusy}
          title={`Download ${liveSelected.size} selected`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 30,
            padding: "0 12px",
            borderRadius: 15,
            background: C.teal,
            color: ON_BRAND_FILL,
            border: "none",
            cursor: bulkBusy ? "default" : "pointer",
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: 12,
            alignSelf: "center",
          }}
        >
          <DownloadIcon size={15} />
          {liveSelected.size}
        </button>
      )}

      {openBlock && (
        <TextPillModal
          block={openBlock}
          onClose={() => setOpenBlock(null)}
          onShowAsText={() => {
            onShowAsText(openBlock);
            setOpenBlock(null);
          }}
        />
      )}
      {lightbox && <ImageLightbox att={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
