// The one compose box in the app (the terminal has none — the concierge is where you talk).
// Attach row (Screenshot / Image / Files) above a mic + textarea + Send row; ⌘/Ctrl+Enter
// submits. Purely presentational: submit reports trimmed text via onSend and clears; the mic
// button only reports onMicToggle — micLive (the armed state) is a prop, owned upstream.
//
// ATTACHMENTS (parity row #21). The attach buttons report a KIND; the host runs the picker and owns
// the resulting list, which comes back as `attachments` and renders as removable chips. The box
// stays Tauri-free — it never opens a dialog, reads a file, or listens for a drop. It only marks
// itself `data-dnd-target` so the host's window-global drag listener can hit-test it, and paints
// `dropActive`. With something attached, an EMPTY message is still sendable (an image alone is a
// message), which is the one place attachments change the submit rule.
//
// SEND TARGET — NOT HERE ANY MORE. This box used to carry an explicit "→ Sparkle" / "→ <agent>"
// toggle, on the reasoning that inferring the target would either bury a prompt in a chat thread
// or fire an agent turn the user didn't ask for. That call was reversed on 2026-07-26: the box is
// EMPTY and the host ROUTES (services/conciergeRouter, PRD/sparkle/concierge-auto-routing.md §2).
// What makes the inference safe is not better guessing — it's that every send posts a visible
// receipt naming where it went, with a one-tap redirect (§3). If you are ever tempted to route
// silently, put the toggle back instead.
//
// The placeholder is deliberately empty (the founder's ask: "just an empty compose window"), so
// the ⌘↩ hint lives on the Send button's tooltip and its aria-keyshortcuts rather than being lost.
// The aria-labels are not visible text, so the box still reads as empty while staying usable with
// a screen reader.
//
// Dictation (bead sparkle-4562.2 / CM-U9) keeps that contract. The box knows nothing about the
// mic pipeline: it hands its append fn to the integration layer through registerInsert (mirroring
// dictationStore registerInsert, which is what the agent composer already does) and renders
// whatever live transcript arrives back as the interim prop. COMMITTED segments land in the
// textarea and are editable and sendable like typed text; the INTERIM preview stays outside the
// textarea, because Deepgram replaces it word-by-word and a send that captured it would ship a
// half-heard phrase that is about to be superseded.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { FiCamera, FiFile, FiImage, FiMic, FiPaperclip, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL_DARK } from "../../theme/colors";
import { CONCIERGE_COMPOSE_DND_TARGET } from "../../services/dndTargets";
import type { Attachment, ConciergeAttachKind } from "./types";
import { useUiStore } from "../../stores/uiStore";

const line = `color-mix(in srgb, ${C.muted} 25%, transparent)`;

const attachStyle: CSSProperties = {
  fontSize: 11,
  color: C.conciergeMuted,
  background: "transparent",
  border: `1px solid ${line}`,
  borderRadius: 8,
  padding: "5px 9px",
  cursor: "pointer",
  display: "inline-flex",
  gap: 5,
  alignItems: "center",
};

const ATTACHMENTS: { kind: ConciergeAttachKind; label: string; Icon: typeof FiCamera; title: string }[] = [
  { kind: "screenshot", label: "Screenshot", Icon: FiCamera, title: "Capture a screenshot" },
  { kind: "image", label: "Image", Icon: FiImage, title: "Upload an image" },
  { kind: "files", label: "Files", Icon: FiPaperclip, title: "Attach files from your desktop" },
];

/** Where a committed dictation segment goes in the box: appended, space-separated, never
 *  double-spaced. Pure so the commit rule is testable without a mic. */
export function appendDictated(current: string, segment: string): string {
  const chunk = segment.trim();
  if (!chunk) return current;
  if (!current) return chunk;
  return current.endsWith(" ") ? `${current}${chunk}` : `${current} ${chunk}`;
}

export function ComposeBox({
  onSend,
  onMicToggle,
  onAttach,
  onRemoveAttachment,
  attachments = [],
  dropActive = false,
  micLive = false,
  interim = "",
  registerInsert,
  onTextEdit,
}: {
  /** Reports the trimmed text (empty only when something is attached). May return a promise
   *  resolving FALSE when the send failed, in which case the box restores the draft (see submit). */
  onSend: (text: string) => void | Promise<boolean>;
  onMicToggle: () => void;
  onAttach: (kind: ConciergeAttachKind) => void;
  onRemoveAttachment?: (id: string) => void;
  /** Staged files, owned by the host — rendered as chips, cleared by the host on send. */
  attachments?: Attachment[];
  /** A native file drag is over this box (the host hit-tests the window-global event). */
  dropActive?: boolean;
  micLive?: boolean;
  /** Live, uncommitted transcript; rendered as a ghost line, never submitted. */
  interim?: string;
  /** Must be referentially STABLE (useCallback upstream) — the box re-registers whenever it
   *  changes, and an unstable identity would churn the app-wide dictation target every render. */
  registerInsert?: (append: ((text: string) => void) | null) => void;
  /** The user TYPED (or deleted) — reports the new value. Not fired for dictated segments or the
   *  clear-on-send, so the host can see the box being emptied by hand. */
  onTextEdit?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  // Focus-on-request seam: any component can call uiStore.requestComposeFocus() (e.g. the
  // drag-vision pill pointing at the one surface that takes input) and this box takes the caret.
  //
  // Only a request made SINCE THIS MOUNT counts (roborev 46485-M). The seq is monotonic for the
  // session, so `seq > 0` also fires on mount — meaning any remount of the concierge column after
  // a single earlier request (HMR, a key change, a future collapse/expand) would yank the caret
  // out of the terminal. In a terminal-first shell that is silent keystroke loss, so the baseline
  // is captured at mount and only a CHANGE past it focuses.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composeFocusSeq = useUiStore((s) => s.composeFocusSeq);
  const handledFocusSeq = useRef(composeFocusSeq);
  useEffect(() => {
    if (composeFocusSeq === handledFocusSeq.current) return;
    handledFocusSeq.current = composeFocusSeq;
    textareaRef.current?.focus();
  }, [composeFocusSeq]);
  useEffect(() => {
    if (!registerInsert) return;
    const append = (segment: string) => setText((prev) => appendDictated(prev, segment));
    registerInsert(append);
    return () => registerInsert(null);
  }, [registerInsert]);

  // Clear optimistically (the send almost always lands), but PUT THE DRAFT BACK if the host reports
  // a failure — the removed composer did exactly this, and having to retype a paragraph because an
  // agent's terminal had closed is the worst possible outcome of a failed send. Only restored when
  // the box is still empty, so it can never clobber something the user started typing meanwhile.
  // An attachment alone IS a message — the removed composer allowed attachments-only sends — so the
  // gate is "text or attachments", not "text".
  const canSend = text.trim().length > 0 || attachments.length > 0;
  const submit = () => {
    if (!canSend) return;
    const v = text.trim();
    const outcome = onSend(v);
    setText("");
    if (outcome && typeof outcome.then === "function") {
      void outcome.then((ok) => {
        if (!ok && v) setText((cur) => (cur === "" ? v : cur));
      });
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      // The hit-test handle for the host's window-global drag listener (services/dndTargets).
      data-dnd-target={CONCIERGE_COMPOSE_DND_TARGET}
      style={{
        flex: "none",
        borderTop: `1px solid ${line}`,
        padding: "10px 12px 12px",
        background: dropActive ? `color-mix(in srgb, ${C.teal} 10%, rgba(0,0,0,0.16))` : "rgba(0,0,0,0.16)",
        outline: dropActive ? `1.5px dashed ${C.teal}` : "none",
        outlineOffset: -2,
      }}
    >
      {attachments.length > 0 && (
        <div
          data-testid="concierge-attachment-chips"
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}
        >
          {attachments.map((a) => (
            <span
              key={a.id}
              title={a.name}
              style={{
                ...attachStyle,
                cursor: "default",
                maxWidth: 170,
                color: C.cream,
                background: `color-mix(in srgb, ${C.teal} 10%, transparent)`,
              }}
            >
              {a.dataUrl ? (
                <img
                  src={a.dataUrl}
                  alt=""
                  style={{ width: 16, height: 16, objectFit: "cover", borderRadius: 3 }}
                />
              ) : (
                <FiFile size={12} aria-hidden />
              )}
              <span
                style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
              >
                {a.name}
              </span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => onRemoveAttachment?.(a.id)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  border: "none",
                  background: "transparent",
                  color: C.conciergeMuted,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <FiX size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {ATTACHMENTS.map(({ kind, label, Icon, title }) => (
          <button
            key={kind}
            type="button"
            title={title}
            onClick={() => onAttach(kind)}
            style={attachStyle}
          >
            <Icon size={12} aria-hidden />
            {label}
          </button>
        ))}
      </div>
      {interim ? (
        <div
          data-testid="concierge-interim"
          // aria-live="off", deliberately (roborev 48171): Deepgram replaces this preview word by
          // word, so a polite region hands the screen reader a fresh announcement per partial and
          // the queue never drains — drowning out everything else. The text is decorative and
          // immediately superseded. What matters — the finished reply, and each send outcome — is
          // announced by the column's hidden role="status" node (ConciergeColumn), which is fed
          // FINISHED lines only. Not the thread: it renders the streaming transcript, so a live
          // region there re-announces the reply on every chunk (roborev 52648/53010/53088).
          aria-live="off"
          style={{
            fontSize: 12,
            fontStyle: "italic",
            color: C.muted,
            padding: "0 2px 6px",
          }}
        >
          {interim}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <button
          type="button"
          aria-label="Talk to Sparkle"
          aria-pressed={micLive}
          title="Talk to Sparkle"
          onClick={onMicToggle}
          style={{
            ...attachStyle,
            padding: "7px 8px",
            ...(micLive
              ? {
                  color: C.cream,
                  borderColor: C.amber,
                  background: `color-mix(in srgb, ${C.amber} 12%, transparent)`,
                }
              : null),
          }}
        >
          <FiMic size={15} aria-hidden />
        </button>
        <textarea
          ref={textareaRef}
          // "Message", not "Message Sparkle": the box no longer knows where a send will go — the
          // host routes it per message — so naming a destination here would be a claim it can't
          // keep. Not visible text, so the box still reads as empty to a sighted user.
          aria-label="Message"
          // EMPTY, on purpose (PRD/sparkle/concierge-auto-routing.md §1). This used to name the
          // destination ("Talk to Sparkle…" / "Prompt <agent>…"), which the target toggle made
          // true; with routing there is no destination to name before the user has written
          // anything. The ⌘↩ hint it never carried lives on the Send button below.
          placeholder=""
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Only the user's OWN edits report — dictation appends go through setText directly.
            // That is what lets the host tell "this box was emptied by hand" (which retires the
            // dictated-origin latch) from "a segment just landed in it".
            onTextEdit?.(e.target.value);
          }}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            resize: "none",
            height: 42,
            background: C.forest,
            border: `1px solid ${line}`,
            borderRadius: 12,
            color: C.cream,
            padding: "10px 12px",
            fontSize: 13,
            fontFamily: "inherit",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
          // Carries the shortcut the placeholder no longer spends its text on — without this the
          // keybinding would have no on-screen discoverability at all. A tooltip alone would hide
          // it from keyboard and touch users entirely, so it is also declared to assistive tech,
          // which announces it without anyone having to hover.
          title="Send (⌘↩)"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          style={{
            fontSize: 13,
            fontWeight: FONT_WEIGHT.bold,
            color: ON_BRAND_FILL_DARK,
            background: C.amber,
            border: "none",
            borderRadius: 12,
            padding: "10px 15px",
            cursor: canSend ? "pointer" : "default",
            opacity: canSend ? 1 : 0.45,
            height: 42,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
