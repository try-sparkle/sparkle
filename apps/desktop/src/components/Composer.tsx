import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FiAlertTriangle, FiDownloadCloud, FiChevronDown } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { submitPrompt, writePty, PtyGoneError } from "../pty";
import { SuggestionRow, SUGGESTION_PILL_ZONE } from "./composer/SuggestionRow";
import { suggestionRowVisible } from "./composer/suggestionVisibility";
import { useSuggestions } from "../services/suggestions/useSuggestions";
import { ApprovalNudge } from "./composer/ApprovalNudge";
import {
  useSyncProjectApprovals,
  effectiveApprovalRule,
} from "../services/suggestions/approvalsRuntime";
import { classifyApproval } from "../services/suggestions/approvalClassifier";
import {
  approvalCategoryLabel,
  type ApprovalCategory,
} from "../services/suggestions/approvalCategories";
import { aiFeatureNow } from "../services/aiGate";
import { deriveContextTags } from "../services/suggestions/contextTags";
import { getAgentScrollback } from "../services/terminalScrollback";
import { useSuggestionStore } from "../stores/suggestionStore";
import { closeBuildAgent } from "../services/closeBuildAgent";
import { parseControlAction, CLOSE_AGENT_ACTION } from "../services/suggestions/controlButtons";
import type { SuggestionButton } from "../services/suggestions/types";
import { trialSendAllowed, recordTrialSend } from "../services/trialMeter";
import { safeUnlisten } from "../services/safeUnlisten";
import { isOverDndTarget, NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
import { useHandoffStore } from "../stores/handoffStore";
import { useProjectStore } from "../stores/projectStore";
import { captureScreenRegion } from "../screenshot";
import { AttachmentRow } from "./composer/AttachmentRow";
import {
  buildSendPayload,
  buildDisplay,
  countLines,
  shouldPasteAsPill,
  type Attachment,
  type TextBlock,
} from "./composer/attachments";
import {
  loadAttachment,
  screenshotAttachment,
  nextId,
} from "./composer/attachmentsApi";
import {
  useUiStore,
  COMPOSER_MIN,
  COMPOSER_MIN_TEXTAREA,
  COMPOSER_SNAP,
  COMPOSER_DEFAULT,
  COMPOSER_BAR,
  COMPOSER_SNAP_THRESHOLD,
  COMPOSER_MINIMIZE_THRESHOLD,
  COMPOSER_RESTORE_THRESHOLD,
} from "../stores/uiStore";
import { usePromptHistoryStore, computeGhost, lowerHistory } from "../stores/promptHistoryStore";
import {
  resolveComposerDrag,
  resolveComposerFloor,
  resolveComposerRenderHeight,
  resolveComposerReset,
  shouldRestoreFromBar,
} from "./composerDrag";
import { isComposerToggleKey } from "./composerToggle";
import { useKeybindingsStore } from "../stores/keybindingsStore";
import { arrowOverflowDirection } from "./composerArrowOverflow";
import { useDictationStore } from "../stores/dictationStore";
import { useSettingsStore } from "../stores/settingsStore";
import { maybePauseOnSubmit } from "../services/dictationControls";
import {
  STOP_PHRASE,
  MIC_HOT_PREFIX,
  MIC_HOT_SUFFIX,
  WAKE_PREFIX,
  WAKE_SUFFIX,
  micHotPlaceholder,
  wakePlaceholder,
  preparingPlaceholder,
  PREPARING_PREFIX,
  PREPARING_SUFFIX,
  PAUSED_COMPOSER_PLACEHOLDER,
  modelPercent,
  voiceErrorNotice,
  MICROPHONE_SETTINGS_URL,
  type VoiceErrorNotice,
} from "../voice/dictationCopy";
import { deriveMicPresentation } from "../voice/micPresentation";
import { openUrl } from "@tauri-apps/plugin-opener";
import { log } from "../logger";
import { ComposerMic } from "./MicButton";
import { ComposerOutOfCreditsNotice } from "./OutOfCreditsNotice";

const maxComposerHeight = () => Math.max(COMPOSER_MIN, window.innerHeight - 140);

// Mic-hot ("audio is active") copy lives in voice/dictationCopy.ts so the Think composer reads
// the exact same wording (single source of truth). The overlay below paints the stop phrase as a
// styled span; the native-textarea fallback reuses micHotPlaceholder(stopWord) verbatim.

/** The stop phrase (default "Sparkle, stop", or the user's custom word) in solid brand blue
 *  (C.teal #2f6bff), matching the wake phrase. (The cyan→blue gradient fade was dropped per
 *  design feedback.) */
function StopPhrase({ phrase = STOP_PHRASE }: { phrase?: string }) {
  return <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.teal }}>{phrase}</span>;
}

/** The one-time voice-model download, shown in the composer's placeholder slot. Deliberately quiet
 *  (same muted placeholder voice as the wake-word copy it replaces) — this is a wait, not a
 *  problem. The download-cloud glyph matches the mic's own preparing glyph, so the two surfaces
 *  read as one state. `pct` is null when the backend reports no content-length. */
function ComposerPreparingNotice({ pct }: { pct: number | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <FiDownloadCloud size={14} className="sparkle-pulse" aria-hidden style={{ flexShrink: 0 }} />
      <span>
        {PREPARING_PREFIX}
        {pct !== null ? (
          <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.teal }}> ({pct}%)</span>
        ) : (
          "…"
        )}
        {PREPARING_SUFFIX}
      </span>
    </span>
  );
}

/** A dictation failure, rendered in the composer's placeholder slot — beside the mic the user
 *  actually clicked. Headline names what broke; detail names the remedy (or, for an unrecognized
 *  error, carries the raw backend string so the cause stays discoverable). Amber + an alert glyph
 *  make it legible without shouting; a heavier treatment (modal/banner) would be out of proportion
 *  for a mic that can simply be turned back on. Dismiss clears dictationStore.error, which also
 *  returns status to idle (see setError). */
/** Shared style for the inline actions in the voice-error notice — matches RefillLink's treatment
 *  in the out-of-credits notice (the sibling control in this same slot). `pointerEvents: auto` is
 *  required: the placeholder overlay these render inside is pointerEvents:none. */
const VOICE_ERROR_ACTION: React.CSSProperties = {
  pointerEvents: "auto",
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  font: "inherit",
  fontWeight: FONT_WEIGHT.bold,
  color: C.teal,
};

function ComposerVoiceError({ notice }: { notice: VoiceErrorNotice }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-start", gap: 6, color: C.amber }}>
      <FiAlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
      <span>
        <span style={{ fontWeight: FONT_WEIGHT.bold }}>{notice.headline}</span>{" "}
        <span style={{ color: C.muted }}>{notice.detail}</span>{" "}
        {/* The separating space belongs INSIDE this branch, with the button it separates: hanging
            it off the ternary would also emit it when the branch renders null, double-spacing the
            non-permission notices (roborev 37737). */}
        {notice.kind === "permission" ? (
          // Only `permission` earns this: it is the one bucket whose remedy lives in a specific
          // System Settings pane we can deep-link to, and macOS will never re-prompt, so telling
          // the user to "turn the mic back on" alone would loop them straight back here. Reading a
          // path out of a sentence and then hunting for it in System Settings is the step users
          // actually drop out on; one click removes it. (A NotDetermined user never sees this —
          // the backend prompts them instead. See mic_permission.rs's `decide`.)
          <>
            <button
              type="button"
              onClick={() => {
                void openUrl(MICROPHONE_SETTINGS_URL).catch((e) =>
                  // The pane failing to open must not also swallow the notice — the detail line
                  // still spells out the path, so the user keeps a way through.
                  console.warn("voice: open microphone settings failed", e),
                );
              }}
              style={VOICE_ERROR_ACTION}
            >
              Open System Settings
            </button>{" "}
          </>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss voice error"
          onClick={() => useDictationStore.getState().setError(null)}
          style={VOICE_ERROR_ACTION}
        >
          Dismiss
        </button>
      </span>
    </span>
  );
}

/** Simple camera glyph for the screen-capture button. Inherits color via currentColor. */
function CameraIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      <circle cx="12" cy="13" r="3.2" />
    </svg>
  );
}

/**
 * Imperative handle the parent uses to push text into the composer (e.g. "Send to Composer"
 * from the pinned-prompt history). `insertPrompt` is replace-only-if-empty: it sets the box to
 * `text` when empty, otherwise appends it on a new line — then un-minimizes and focuses.
 */
export interface ComposerApi {
  insertPrompt: (text: string) => void;
}

/**
 * The friendly prompt composer (spec §7). A real <textarea>, so Shift+arrow selection,
 * multi-line, and Cmd+A/C/V all work natively. ⏎ sends, ⇧⏎ inserts a newline. Send
 * injects into the PTY via bracketed paste, then (after a beat) a carriage return.
 *
 * The composer is a bottom overlay floating over the terminal. At rest it sits at the snap
 * height, covering Claude's terminal input line — so the user types here by default (that's
 * the gentle steer toward the box). The grab handle drags it taller for multi-line prompts,
 * or DOWN past the floor to MINIMIZE into a slim bar that exposes the terminal input for
 * answering Claude's menus directly. ⌘J toggles the two. Minimized state + height persist
 * globally (uiStore), so the choice sticks across every agent tab and across relaunch.
 * Because it overlays rather than shares the flex column, dragging never resizes the
 * terminal beneath it.
 */
export function Composer({
  agentId,
  active = true,
  disabled = false,
  preparing = false,
  inputRef,
  apiRef,
  onSubmitPrompt,
  onArrowOverflow,
  onEnterOverflow,
  hiddenBelow = 0,
  onRestartAgent,
}: {
  agentId: string;
  // Only the visible pane's composer reacts to native file drops (panes stay mounted).
  active?: boolean;
  disabled?: boolean;
  // The agent is still starting (worktree/PTY spinning up), so its PTY can't receive input YET —
  // but the composer is fully usable so the user can type/talk immediately instead of waiting. A
  // send while `preparing` is QUEUED and auto-delivered the moment the PTY is ready (see the flush
  // effect), rather than dropped. Distinct from `disabled` (a hard block that also stops typing).
  preparing?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  // Imperative bridge so the parent can push text into the box (e.g. "Send to Composer").
  apiRef?: RefObject<ComposerApi | null>;
  // `display` is the transcript string (typed text + 📄/📷/📎 count markers) — recorded for
  // prompt history. `namingBasis` is the user's typed text ONLY (no attachment markers): the
  // basis for auto-naming. Empty when the message is attachments-only, in which case the parent
  // must not auto-name (the emoji-count markers must never reach the naming model).
  onSubmitPrompt: (display: string, namingBasis: string) => void;
  // Called when a vertical arrow runs off the edge of the text: Down off the last line, Up off
  // the first. Lets the parent hand focus (and the keypress) to the terminal so the user can
  // drive Claude's menus without clicking. Omit to keep arrows purely native.
  onArrowOverflow?: (dir: "up" | "down") => void;
  // Called when Enter is pressed while the composer is EMPTY: there's nothing to send, so hand
  // focus + a carriage return to the terminal to confirm whatever's highlighted there (e.g. the
  // menu option the user just arrowed to). Omit to keep Enter purely a (no-op) send.
  onEnterOverflow?: () => void;
  // How many terminal rows this overlay is hiding that it ISN'T meant to cover (the input line it
  // deliberately sits over never counts). Drives the reveal chip on the grab handle so hidden
  // output is never silent. 0 = nothing to surface. See engine/composerOcclusion.ts.
  hiddenBelow?: number;
  // Called when a send lands on a PTY that has already exited: the agent needs respawning before
  // anything can be delivered. The prompt is re-queued here first, so the parent only has to
  // restart — the existing preparing→ready flush effect delivers it on the new PTY.
  onRestartAgent?: () => void;
}) {
  const [value, setValue] = useState("");
  // A prompt the user sent BEFORE the agent's PTY was ready (composed during `preparing`). Held
  // here and flushed by the effect below the moment `preparing` clears, so an eager first prompt is
  // never dropped. Null when nothing is queued. Multiple pre-ready sends merge (newest appended).
  const pendingSendRef = useRef<{
    typed: string;
    atts: Attachment[];
    blocks: TextBlock[];
    text: string;
  } | null>(null);
  // True while a native file (e.g. a log) is dragged over the window — drives the drop hint.
  const [dropActive, setDropActive] = useState(false);
  // Inline status for a send that did NOT land (dead agent being restarted, or an outright
  // failure). Non-null renders a live region above the box, so a dropped prompt is never silent.
  // Cleared by the next successful delivery.
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  // Mic hot ("audio is active") → the placeholder drops the wake-word prompt and invites the
  // user to just start talking, since Sparkle is already listening. Gate on the ACTUAL capture
  // state (status === "listening"), not the armed/mute intent (`enabled`): `enabled` stays true
  // while capture is focus-paused, so keying off it falsely claims "I'm listening" when nothing
  // is being captured. When armed but not actually listening we show the honest "Listening paused"
  // copy (deriveMicPresentation === "focusPaused"), the same state the sidebar caption shows.
  const audioActive = useDictationStore((s) => s.status === "listening");
  // Master mute: `enabled` false means the mic is OFF (ambient listening is opt-in). When the mic
  // is off the composer must make NO voice promise at all — no "Just say Hey Sparkle", no typing
  // hint that references speaking — so the placeholder goes fully blank. Distinct from `enabled`
  // true + idle status (armed but focus-paused), which shows the honest "Listening paused" copy.
  const micEnabled = useDictationStore((s) => s.enabled);
  // Capture being live is NOT the same as actively dictating. Split the mic-hot copy by PHASE so
  // the composer tells the truth: only the "active" phase (wake word heard) gets the "I'm
  // listening, say Sparkle, stop" copy; the "passive" phase (still waiting for "Hey Sparkle")
  // gets the wake-word copy that mirrors the sidebar. Bug fixed: previously ANY live capture
  // showed the active copy, so a passive (wake-word) session falsely read as "I'm listening".
  const phase = useDictationStore((s) => s.phase);
  // The one-time voice-model download (non-null ONLY while it's in flight — a warm install never
  // emits it). Without this the composer had no idea the download existed: `status` is set to
  // "listening" optimistically BEFORE start_dictation, which on a first run blocks for MINUTES, so
  // every one of those minutes rendered the passive wake-word copy and invited the user to say
  // "Hey Sparkle" at a model that wasn't on disk yet. `preparing` outranks BOTH live states below
  // for the same reason: no model means no dictation, whatever phase the user has selected.
  const modelProgress = useDictationStore((s) => s.modelProgress);
  // The raw backend failure. Previously written to the store and read by exactly one 10px caption
  // under the sidebar logo — a different region of the screen from the mic that was clicked — so a
  // composer-mic user never saw why voice died. voiceErrorNotice maps it to an honest headline +
  // remedy (and, for anything unrecognized, the raw string rather than a guess).
  const voiceError = useDictationStore((s) => s.error);
  const errorNotice = useMemo(() => voiceErrorNotice(voiceError), [voiceError]);
  // Shared out-of-credits notice: set when the user tries to arm the mic with an empty balance
  // (the arm is refused). When true it replaces the normal mic placeholder here and shows in the
  // top-left bar at the same time. Auto-clears after 5s (dictationStore).
  const outOfCreditsNotice = useDictationStore((s) => s.outOfCreditsNotice);
  // THE voice-state decision, shared with the sidebar mic (deriveMicPresentation). Both the styled
  // overlay AND the native placeholder below switch on this, and so does LogoWaveform's caption — so
  // the composer mic can never disagree with the top-left mic about which state we're in. Each
  // surface still supplies its own words; only the STATE is shared. `errorNotice != null` is this
  // surface's `hasError`; the (idle vs error) distinction in the raw status is irrelevant here since
  // a real error is already handled by hasError, so `audioActive` (status === "listening") suffices.
  const micPresentation = deriveMicPresentation({
    enabled: micEnabled,
    status: audioActive ? "listening" : "idle",
    phase,
    modelProgress,
    hasError: errorNotice !== null,
    outOfCreditsNotice,
  });
  // Configured wake/stop words so every dictation hint reflects a user's remap (default words
  // reproduce the original copy exactly).
  const wakeWord = useSettingsStore((s) => s.wakeWord);
  const stopWord = useSettingsStore((s) => s.stopWord);

  // Inline ghost-text autocomplete. `history` is the global list of past prompts; `caretAtEnd`
  // gates the suggestion so it only appears when the caret is at the very end of the text
  // (never while editing mid-line). The ghost is the suffix of the most recent past prompt
  // that starts with what's typed — accept the whole thing with → or Tab.
  const history = usePromptHistoryStore((s) => s.history);
  const recordPrompt = usePromptHistoryStore((s) => s.record);
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  // Escape dismisses the current ghost so a keyboard-only user can Tab out of the composer
  // without first accepting the suggestion (Tab otherwise accepts). Reset on the next edit so
  // typing more brings suggestions back.
  const [ghostDismissed, setGhostDismissed] = useState(false);
  // Live cloud-dictation preview (Deepgram interim results). While speech is streaming we show
  // the in-progress phrase as muted/italic text trailing the committed text — the real-time
  // word-by-word feel — and suppress the autocomplete ghost so the two don't fight for the slot.
  // The subscription itself is gated on this being the active, enabled pane — the SAME scope that
  // routes committed dictated text (registerInsert below) — so interim churn (several frames/sec)
  // never re-renders other mounted/hidden panes, and the preview never leaks into them.
  const interim = useDictationStore((s) => (active && !disabled ? s.interim : ""));
  const interimActive = !!interim;
  // Lowercase the whole history ONCE per history change (i.e. on send, not per keystroke) so the
  // per-keystroke ghost scan below never re-lowercases up to 500 entries. See lowerHistory().
  const historyLower = useMemo(() => lowerHistory(history), [history]);
  // The ghost scan is O(history) per keystroke, so memoize it: it only needs to re-run when the
  // typed value, the history, or one of the suppression gates changes. Short-circuit to no-ghost
  // while suppressed (caret not at end / dismissed / live dictation in the slot) so the scan never
  // runs while gated — the common case where a ghost isn't even visible.
  const ghost = useMemo(
    () =>
      caretAtEnd && !ghostDismissed && !interimActive ? computeGhost(value, history, historyLower) : "",
    [value, history, historyLower, caretAtEnd, ghostDismissed, interimActive],
  );
  // The interim phrase is the whole thing being spoken now; render it after the committed text.
  const interimSuffix = interimActive ? `${value && !value.endsWith(" ") ? " " : ""}${interim}` : "";
  // Backing mirror behind the textarea, used to paint the ghost suffix (see render).
  const ghostRef = useRef<HTMLDivElement | null>(null);

  // When this composer is the visible/active pane, make it the target for
  // wake-word dictation. Only the visible pane registers (one at a time), so
  // dictation never leaks into another agent's input.
  useEffect(() => {
    if (!active || disabled) return;
    const append = (text: string) => {
      // Insert the transcribed text at the user's caret, not the end. Resolve which caret to use:
      //  1. If the textarea is focused right now, use its live selection.
      //  2. Otherwise use the last caret the user placed while it WAS focused (lastCaretRef) — the
      //     common flow is to click into the box to position the caret, then talk, by which point
      //     the mic/voice UI has taken focus. The previous code required CURRENT focus and so fell
      //     back to end-append here, which is why dictation kept landing at the bottom.
      //  3. Only when no caret has ever been placed (never clicked in) do we append at the end, so
      //     we never silently prepend at offset 0.
      const ta = taRef.current;
      const focused = ta != null && document.activeElement === ta;
      const stored = lastCaretRef.current;
      const useCaret = focused || stored != null;
      const rawS = focused ? ta?.selectionStart ?? 0 : stored?.start ?? 0;
      const rawE = focused ? ta?.selectionEnd ?? 0 : stored?.end ?? 0;

      // Compute the new caret offset as a side effect of the functional updater (so the fallback
      // path splices into the freshest value, never a stale closure capture).
      let caret = 0;
      setValue((v) => {
        if (!useCaret) {
          const next = v ? `${v} ${text}` : text;
          caret = next.length;
          return next;
        }
        // A stored caret was measured against an earlier value — clamp it to the current length.
        const s = Math.min(rawS, v.length);
        const e = Math.min(rawE, v.length);
        const before = v.slice(0, s);
        const after = v.slice(e);
        // Keep the existing one-space separation, but applied at the caret rather than the end —
        // and only where it's actually needed, so we never produce a double space or a leading one.
        const lead = before.length > 0 && !before.endsWith(" ") ? " " : "";
        const trail = after.length > 0 && !after.startsWith(" ") ? " " : "";
        const inserted = `${lead}${text}${trail}`;
        // Drop the caret at the END of the just-inserted text (before any trailing space).
        caret = before.length + lead.length + text.length;
        return `${before}${inserted}${after}`;
      });
      // Do NOT force the composer open here. A composer the user minimized stays minimized during
      // dictation (their explicit choice); the transcribed text still lands in the box and is there
      // when they reopen it. (Reopening on every transcript is what made the toggle feel
      // mic-dependent — see the terminal gesture-reclaim design, 2026-07-10.)
      inputRef?.current?.focus();
      // Selection must be set after React commits the new value, or it snaps back. Mirror the
      // exact rAF pattern acceptGhost uses (and re-sync the ghost mirror's scrollTop, since moving
      // the caret can scroll the textarea programmatically without firing onScroll).
      requestAnimationFrame(() => {
        const t = taRef.current;
        if (t) {
          t.selectionStart = t.selectionEnd = caret;
          if (ghostRef.current) ghostRef.current.scrollTop = t.scrollTop;
        }
        // Advance the remembered caret to just past this insert, so a follow-on dictation chunk
        // continues forward (rather than re-inserting at the same spot and reversing the words)
        // even if focus never returns to the box.
        lastCaretRef.current = { start: caret, end: caret };
      });
    };
    useDictationStore.getState().registerInsert(append);
    return () => {
      // Only clear if we're still the registered target (avoid clobbering a newer pane).
      const store = useDictationStore.getState();
      if (store.insertTarget === append) store.registerInsert(null);
    };
  }, [active, disabled, inputRef]);

  // Files riding along with the next message — screenshots and dropped images/files.
  // On send their paths are prefixed to the text so the Claude Code CLI reads each from
  // disk. Rendered as selectable tiles in the AttachmentRow above the textarea.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Large pastes collapsed into clickable pills (rather than flooding the textarea).
  // Their full text is expanded inline into the payload on send.
  const [textBlocks, setTextBlocks] = useState<TextBlock[]>([]);
  // Suggested action buttons (heuristic direct-answers + Haiku-learned next-actions). The row is
  // only shown when the box is empty and the user isn't typing or dictating — see suggestionsVisible.
  const composerEmptyNow = !value.trim() && attachments.length === 0 && textBlocks.length === 0;
  const {
    buttons: suggestionButtons,
    dismiss: dismissSuggestion,
    clear: clearSuggestions,
    autoApproved,
  } = useSuggestions(agentId, composerEmptyNow);
  // The project that owns this agent — used to write "this project" auto-approve rules and to read
  // the effective rule. useSyncProjectApprovals keeps the per-project effective cache fresh.
  const approvalProjectRoot = useProjectStore(
    (s) => s.projects.find((p) => p.agents.some((a) => a.id === agentId))?.rootPath ?? null,
  );
  useSyncProjectApprovals(approvalProjectRoot);
  const openSettings = useUiStore((s) => s.openSettings);
  // The auto-approve nudge shown after the user clicks an approve answer on a classifiable, not-yet-
  // remembered permission prompt (spec §4). Null when no nudge is pending.
  const [approvalNudge, setApprovalNudge] = useState<ApprovalCategory | null>(null);
  const [capturing, setCapturing] = useState(false);
  const height = useUiStore((s) => s.composerHeight);
  const setComposerHeight = useUiStore((s) => s.setComposerHeight);
  const minimized = useUiStore((s) => s.composerMinimized);
  const setMinimized = useUiStore((s) => s.setComposerMinimized);
  const userSized = useUiStore((s) => s.composerUserSized);
  const setComposerUserSized = useUiStore((s) => s.setComposerUserSized);
  const dragRef = useRef<{ startY: number; startH: number; startMin: boolean } | null>(null);

  // Expose insertPrompt to the parent (used by the pinned-prompt "Send to Composer" action).
  // Replace-only-if-empty: drop the prompt straight in when the box is empty, otherwise append
  // it on a new line so an in-progress draft isn't clobbered. Then surface + focus the box.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      insertPrompt: (text: string) => {
        setValue((v) => (v.trim() ? `${v}${v.endsWith("\n") ? "" : "\n"}${text}` : text));
        setGhostDismissed(true); // the inserted text isn't a typed prefix — don't ghost off it
        setMinimized(false);
        requestAnimationFrame(() => inputRef?.current?.focus());
      },
    };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef, inputRef, setMinimized]);

  // Snap the composer back to its regular rest height and drop any manual sizing — used right
  // after a send and when a brand-new thread's composer mounts, so a long message (or a
  // previously dragged size leaking in via the shared store) never leaves the box stuck tall.
  // A fully minimized composer is the one exception: that's a deliberate "keep it tucked away"
  // choice, so resolveComposerReset returns null and we leave the slim bar exactly as it is.
  const resetComposerSize = useCallback(() => {
    const reset = resolveComposerReset({
      minimized: useUiStore.getState().composerMinimized,
      rest: COMPOSER_DEFAULT,
    });
    if (!reset) return;
    setComposerHeight(reset.height);
    setComposerUserSized(reset.userSized);
  }, [setComposerHeight, setComposerUserSized]);

  // On mount the composer belongs to a freshly started thread (panes stay mounted, so this fires
  // once per new thread, never on a tab switch). Start it at the rest height — unless minimized,
  // which we honor — via useLayoutEffect so a stale tall height never flashes before first paint.
  useLayoutEffect(() => {
    resetComposerSize();
  }, [resetComposerSize]);

  // The composer auto-grows upward to fit the typed message. `height` (the persisted,
  // drag-set height) is the floor; content can push the composer taller up to the cap.
  // We keep this in a separate value (not the persisted store) so a long one-off message
  // doesn't permanently resize the composer.
  const [autoHeight, setAutoHeight] = useState(height);
  const containerRef = useRef<HTMLDivElement>(null);
  // Always hold a local handle to the textarea for measuring, while still honoring the
  // optional inputRef the parent passes in (used for focus + insert()).
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const setTaRef = (el: HTMLTextAreaElement | null) => {
    taRef.current = el;
    if (inputRef) inputRef.current = el;
  };
  // The last caret position the user placed in the textarea WHILE it was focused. Kept so
  // wake-word dictation can insert at that spot even after focus has since left the box (the
  // common flow: click to place the caret, then talk — by which point the mic/voice UI may
  // hold focus). `null` = the user has never placed a caret, so dictation appends at the end.
  const lastCaretRef = useRef<{ start: number; end: number } | null>(null);

  // Measure the textarea's intrinsic content height and size the composer to fit it,
  // clamped to [drag-set floor, viewport cap]. Held in a ref so the resize listener
  // (registered once below) always calls the latest measurement closure.
  const recomputeHeightRef = useRef<() => void>(() => {});
  // Fast-path cache for the measurement below. The full measurement forces a synchronous layout
  // reflow (write height:auto → read scrollHeight → restore) on EVERY keystroke, whose cost
  // scales with draft length — the #1 composer typing-lag cause (bead sparkle-alrm.2). We cache
  // the last measured content height alongside the "chrome key" (every input that isn't the typed
  // text: attachments/textBlocks/minimized/floor/userSized/viewport). When only the text changed
  // (chrome key identical) and the box is already hugging its content, a single naked scrollHeight
  // read tells us whether the content height moved — if it didn't, the height can't change, so we
  // skip the un-stretch reflow entirely (typing within one line, the common case).
  const measureCacheRef = useRef<{
    chromeKey: string;
    contentH: number;
    textLen: number;
    newlines: number;
  } | null>(null);
  // Runs before paint (no flicker) on every change that affects the content or chrome.
  useLayoutEffect(() => {
    recomputeHeightRef.current = () => {
      const ta = taRef.current;
      const container = containerRef.current;
      if (!ta || !container) return;
      // FAST PATH: skip the reflow-inducing un-stretch measurement when nothing that could move
      // the height has changed. The chrome key captures every non-text input to the height math;
      // when it's identical to the last full measurement, only the typed text can have changed. In
      // that case the box is already hugging its content, so a single naked scrollHeight read is the
      // true content height (no un-stretch needed) — if it matches the cached height, the layout is
      // unchanged and there's nothing to do. This is the hot keystroke path (typing within a line).
      const chromeKey = `${attachments.length}|${textBlocks.length}|${minimized}|${height}|${userSized}|${window.innerHeight}`;
      const cached = measureCacheRef.current;
      // Text metrics for the shrink guard below. In the hugging (auto-grow) steady state the
      // textarea is flex-stretched (`flex:1`, wrapper `align-items:stretch`), so a naked
      // `ta.scrollHeight` is CLAMPED up to clientHeight: it rises when content grows (breaking the
      // equality → full measure) but stays at the old, taller value when the user DELETES lines, so
      // it cannot detect shrink. Only skip the reflow when the text can't have gotten shorter —
      // neither its length nor its line count decreased since the last full measurement. Deleting
      // text falls through to the full un-stretch measurement, which shrinks the box correctly.
      const textLen = ta.value.length;
      let newlines = 0;
      for (let i = 0; i < textLen; i++) if (ta.value.charCodeAt(i) === 10) newlines++;
      if (
        cached &&
        cached.chromeKey === chromeKey &&
        textLen >= cached.textLen &&
        newlines >= cached.newlines &&
        ta.scrollHeight === cached.contentH
      )
        return;
      // Overhead = everything that isn't the textarea (handle, padding, attachment thumbs,
      // status rows, the send/mic/camera buttons). We read it by DIFFERENCE (container minus
      // textarea), which is only valid when the container is sized to its content — but the
      // container is rendered at a FIXED `height: autoHeight`. So when a tall attachment row is
      // added it squeezes the (flex:1, minHeight:0) textarea inside that fixed box, and reading
      // container.offsetHeight here would report the stale pre-grow height instead of the chrome
      // the content now needs — the box then fails to grow and the thumbnail overlaps the input
      // (the reported drop-a-screenshot bug). Drop the fixed height for the measurement so the
      // container lays out to its natural content height, making the difference the true chrome.
      //
      // Read the natural content height free of the flex stretch too. The textarea is a child of a
      // `display:flex` wrapper whose direction is the default `row`, so the textarea's CROSS axis
      // (the one pinned by `align-items: stretch`) is VERTICAL and its MAIN axis is HORIZONTAL
      // (width). To collapse the height to content we opt out of the cross-axis stretch —
      // `align-self:flex-start` + `height:"auto"` — which lets scrollHeight report the real content
      // height instead of the stretched height, and lets the container (now height:auto) shrink-wrap.
      //
      // We must NOT touch `flex` here. `flex` sizes the MAIN (horizontal) axis: setting
      // `flex:"0 0 auto"` collapses the textarea's WIDTH to its intrinsic `cols`-based width (~20
      // chars), which re-wraps the draft into many more lines and INFLATES scrollHeight — so the box
      // grew to multiples of the real text, worst on dictation (long appended runs). An empty/1-row
      // draft hid this (one line measures the same at any width), so it only bit once text wrapped.
      // Leaving `flex:1` keeps the measured width equal to the rendered width, so wrapping matches.
      const prevContainerHeight = container.style.height;
      const prevHeight = ta.style.height;
      const prevAlignSelf = ta.style.alignSelf;
      container.style.height = "auto";
      ta.style.alignSelf = "flex-start";
      ta.style.height = "auto";
      // LOAD-BEARING ORDER: this scrollHeight read is the reflow trigger that flushes the three
      // style writes above, so the offsetHeight reads that follow see the shrink-wrapped layout
      // (not a stale one). Keep it first — moving a style write below this read would silently
      // reintroduce a stale-layout measurement.
      const contentH = ta.scrollHeight; // content + vertical padding (no border)
      // Cache the un-stretched content height against this chrome key so the fast path above can
      // skip the next keystroke's reflow when neither the content height nor the chrome moved. In
      // the hugging state (auto-grow, and userSized-shorter/at-cap where the box scrolls) a naked
      // scrollHeight equals this value; when the box is stretched taller than content (userSized
      // taller) it won't, so the fast path simply falls through to a full measurement — correct,
      // since in that mode the height is content-independent anyway.
      measureCacheRef.current = { chromeKey, contentH, textLen, newlines };
      const borderY = ta.offsetHeight - ta.clientHeight; // textarea border (client excludes it)
      // True chrome: with the container shrink-wrapped and the textarea at one row, everything
      // that isn't the textarea is the overhead — independent of any prior squeeze.
      const overhead = container.offsetHeight - ta.offsetHeight;
      ta.style.height = prevHeight;
      ta.style.alignSelf = prevAlignSelf;
      container.style.height = prevContainerHeight;
      const desired = overhead + contentH + borderY;
      // Attachment thumbnails eat a fixed row above the textarea; raise the height floor so they
      // can't squeeze the input to a sliver (overhead already includes the thumb row). Without
      // attachments this is just COMPOSER_MIN, so the drag-down behavior is unchanged.
      const min = resolveComposerFloor({
        baseMin: COMPOSER_MIN,
        overhead,
        minTextarea: COMPOSER_MIN_TEXTAREA,
        hasAttachments: attachments.length > 0,
      });
      // Once the user has hand-sized the composer, `height` IS the rendered height (the draft
      // scrolls past it) — so the handle can drag it shorter than its content. Until then the
      // composer auto-grows from the rest height to fit the draft. (Pure policy in composerDrag.)
      const next = resolveComposerRenderHeight({
        height,
        desired,
        userSized,
        min,
        cap: maxComposerHeight(),
      });
      setAutoHeight(next);
    };
    recomputeHeightRef.current();
    // `minimized` is a dep so autoHeight re-measures on restore: while minimized the textarea is
    // unmounted and the measurement early-returns (autoHeight freezes), so without this a
    // minimize→restore that changes nothing else would show the stale pre-minimize height.
    // `userSized` is a dep so toggling manual control re-resolves the height immediately.
  }, [value, height, attachments.length, textBlocks.length, minimized, userSized]);

  // The viewport cap depends on window height — re-measure on resize. Registered once.
  useEffect(() => {
    const onResize = () => recomputeHeightRef.current();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A persisted/oversized height could bury the terminal on a smaller window — re-clamp to
  // the viewport on mount AND whenever the window resizes (read latest height from the
  // store to avoid a stale closure).
  useEffect(() => {
    const clamp = () => {
      const max = maxComposerHeight();
      if (useUiStore.getState().composerHeight > max) setComposerHeight(max);
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [setComposerHeight]);

  // Once the PTY is live, pull focus into the composer so the user types here, not the
  // terminal underneath — unless it's minimized (then the terminal owns focus; see AgentPane).
  useEffect(() => {
    if (!disabled && !minimized) inputRef?.current?.focus();
  }, [disabled, inputRef, minimized]);

  // Load dropped/handed-off file paths into attachment tiles (images get a preview, others a
  // file chip), surface the box, and append them in order — loads resolve at different speeds,
  // so collect them before appending rather than racing. A failed load is logged and skipped.
  const attachPaths = useCallback(
    (paths: string[]) => {
      setMinimized(false); // surface the box so the new tiles are visible
      inputRef?.current?.focus();
      void Promise.all(
        paths.map((path) =>
          loadAttachment(path).catch((e) => {
            log.error("composer", "load dropped file failed", { path, e });
            return null;
          }),
        ),
      ).then((loaded) => {
        const ok = loaded.filter((a): a is Attachment => a !== null);
        if (ok.length) setAttachments((prev) => [...prev, ...ok]);
      });
    },
    [inputRef, setMinimized],
  );

  // Native file drag-and-drop: drag a file (image or otherwise) onto the active composer
  // and it becomes a tile above the textarea. The tile carries the file's absolute path,
  // prefixed to the message on send so the agent reads it straight from disk (same trick as
  // screenshot attachments). Tauri's webview drag-drop event carries real filesystem paths; a
  // plain HTML5 drop in a sandboxed webview does not. Only the visible pane listens (others
  // stay mounted). One carve-out: the "+ New Build Agent" button is its OWN drop target
  // (useNewBuildAgentDrop spawns a new agent and attaches the files there), so we hit-test
  // every position ourselves and stand down over the button — no dropped-on-the-button file
  // may land in THIS composer, and no listener-ordering assumption is needed.
  useEffect(() => {
    if (!active) return;
    const unlistenPromise = getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDropActive(!isOverDndTarget(p.position, NEW_BUILD_AGENT_DND_TARGET));
        } else if (p.type === "leave") {
          setDropActive(false);
        } else if (p.type === "drop") {
          setDropActive(false);
          if (isOverDndTarget(p.position, NEW_BUILD_AGENT_DND_TARGET)) return;
          const paths = p.paths ?? [];
          if (paths.length === 0) return;
          log.info("composer", `dropped ${paths.length} file(s) into chat`, paths);
          attachPaths(paths);
        }
      })
      .catch((e) => {
        // A failed listen has no unlisten fn to return; log and let cleanup no-op.
        log.error("composer", "drag-drop listen failed", e);
        return undefined;
      });
    return () => {
      setDropActive(false);
      // safeUnlisten awaits the listen() promise so a handler that resolves AFTER unmount is still
      // torn down (and the Tauri teardown race is swallowed).
      void safeUnlisten(unlistenPromise);
    };
  }, [active, attachPaths]);

  // Files dropped on the "+ New Build Agent" button were queued for this agent BEFORE this
  // composer existed (the drop spawned the agent — see useNewBuildAgentDrop). Drain our entry
  // once we're the active pane and attach the paths exactly like a direct drop. Draining is
  // idempotent (the entry empties), so re-running on activation is harmless.
  useEffect(() => {
    if (!active) return;
    const paths = usePendingAttachmentsStore.getState().drain(agentId);
    if (paths.length === 0) return;
    log.info("composer", `attaching ${paths.length} handed-off file(s)`, paths);
    attachPaths(paths);
  }, [active, agentId, attachPaths]);

  // A capture-modal "Build ❯" queued a draft (text + screenshots) for this project's build
  // agent (handoffStore.buildDraft — same handoff shape as pendingAttachmentsStore, but keyed
  // by project since the router may create the agent in the same tick). Consume it when this
  // composer is the active pane of a build agent in that project: attachment tiles + draft
  // text, then clear. NEVER auto-sent — the user reviews and hits Enter.
  const buildDraft = useHandoffStore((s) => s.buildDraft);
  useEffect(() => {
    if (!active || disabled || !buildDraft) return;
    // Re-read the draft from the store inside the effect (roborev 25174): the first consumer's
    // clearBuildDraft() below makes any replay of this effect (HMR / StrictMode double-mount)
    // a no-op, so the text/attachments can never be double-applied. The subscribed `buildDraft`
    // above serves only as the trigger.
    const draft = useHandoffStore.getState().buildDraft;
    if (!draft) return;
    const project = useProjectStore
      .getState()
      .projects.find((p) => p.agents.some((a) => a.id === agentId));
    if (!project || project.id !== draft.projectId) return;
    if (project.agents.find((a) => a.id === agentId)?.kind !== "build") return;
    useHandoffStore.getState().clearBuildDraft();
    if (draft.attachments.length > 0) {
      setAttachments((prev) => [
        ...prev,
        ...draft.attachments.map((a) => screenshotAttachment(a.path, a.dataUrl)),
      ]);
    }
    if (draft.text.trim()) {
      // Same replace-if-empty/append-on-new-line rule as insertPrompt, so an in-progress
      // draft is never clobbered.
      setValue((v) => (v.trim() ? `${v}${v.endsWith("\n") ? "" : "\n"}${draft.text}` : draft.text));
      setGhostDismissed(true);
    }
    setMinimized(false);
    requestAnimationFrame(() => inputRef?.current?.focus());
  }, [active, disabled, agentId, buildDraft, inputRef, setMinimized]);

  // Open the native macOS crosshair picker and stash the result as a thumbnail.
  // Esc (cancel) resolves null — a quiet no-op. While the picker is up the call
  // blocks in Rust; `capturing` flips the button to a spinner.
  const capture = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const shot = await captureScreenRegion();
      if (shot) {
        setAttachments((prev) => [...prev, screenshotAttachment(shot.path, shot.dataUrl)]);
      }
    } catch (err) {
      console.error("screen capture failed", err);
    } finally {
      setCapturing(false);
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  const removeTextBlock = (id: string) =>
    setTextBlocks((prev) => prev.filter((b) => b.id !== id));

  // A large paste collapses into a pill instead of flooding the textarea. The threshold is
  // "more than five lines" (see shouldPasteAsPill). Shorter pastes fall through to the
  // textarea's native insert. "Show as regular text" (from the pill modal) reverses this by
  // appending the block's raw text back into the box and dropping the pill.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!shouldPasteAsPill(text)) return; // native paste
    e.preventDefault();
    setTextBlocks((prev) => [
      ...prev,
      { id: nextId("blk"), text, lineCount: countLines(text) },
    ]);
  };

  const showBlockAsText = (block: TextBlock) => {
    setValue((v) => (v ? `${v}${v.endsWith("\n") ? "" : "\n"}${block.text}` : block.text));
    removeTextBlock(block.id);
    inputRef?.current?.focus();
  };

  // Single source of truth for "is there nothing to send?" — used by both send()'s own gate and
  // the Enter hand-off below, so the two definitions of "empty" can never drift apart.
  const isComposerEmpty = () =>
    !value.trim() && attachments.length === 0 && textBlocks.length === 0;

  // Park a prompt in the pending queue, merging with anything already queued (newest appended) so
  // nothing is lost when several sends stack up before the PTY is ready. Shared by the cold-start
  // path (`preparing`) and the dead-PTY restart path, so the two can never merge differently.
  const queuePendingSend = (next: {
    typed: string;
    atts: Attachment[];
    blocks: TextBlock[];
    text: string;
  }) => {
    const prev = pendingSendRef.current;
    pendingSendRef.current = prev
      ? {
          typed: `${prev.typed}\n${next.typed}`,
          atts: [...prev.atts, ...next.atts],
          blocks: [...prev.blocks, ...next.blocks],
          text: `${prev.text}\n${next.text}`.trim(),
        }
      : next;
  };

  // Put an undelivered draft back in the box. Prepended (not assigned) so anything the user has
  // typed since the failed send survives too.
  const restoreDraft = (typed: string, atts: Attachment[], blocks: TextBlock[]) => {
    setValue((cur) => (cur.trim() ? `${typed}\n${cur}` : typed));
    setAttachments((cur) => [...atts, ...cur]);
    setTextBlocks((cur) => [...blocks, ...cur]);
  };

  // Shared delivery for both typed sends and prompt-kind suggestion clicks, so the trial/delivery
  // bookkeeping (payload/display build → parent callback → PTY → ghost-history → trial meter) can
  // never drift between the two paths. `typed` is the raw (untrimmed) text; naming/history use the
  // trimmed form. Callers are responsible for the trial-cap gate + clearing the box.
  //
  // `allowRestart` is what stops the dead-PTY self-heal from looping. It is a property of THIS
  // call, not of the component: every fresh user action (typed send, prompt-suggestion click) may
  // restart the agent once, and the automatic flush retry that follows may not — so if the
  // respawned PTY is dead too, that retry gives up honestly instead of restarting again. Deciding
  // it per call rather than via a shared latch means there is no cross-call state to go stale or
  // to race between a user send and an in-flight retry.
  const deliverPrompt = async (
    typed: string,
    atts: Attachment[],
    blocks: TextBlock[],
    { allowRestart = true }: { allowRestart?: boolean } = {},
  ) => {
    const payload = buildSendPayload({ attachments: atts, textBlocks: blocks, typed });
    const display = buildDisplay({ attachments: atts, textBlocks: blocks, typed });
    const naming = typed.trim();
    // Deliver FIRST, and only record history once the prompt has actually landed. Recording up
    // front is what let a dead agent swallow prompts while the breadcrumb bar showed them as sent
    // — the user saw their prompt in the history and the agent never received it.
    try {
      await submitPrompt(agentId, payload);
    } catch (e) {
      if (e instanceof PtyGoneError && allowRestart) {
        // The agent's PTY has exited. Hold the prompt in the same queue used for a cold start and
        // ask the parent to respawn: the preparing→ready flush effect delivers it on the new PTY,
        // so "send to a stopped agent" just works instead of vanishing.
        //
        queuePendingSend({ typed, atts, blocks, text: naming });
        log.warn("composer", "send hit a dead PTY — restarting agent and re-queueing", {
          agentId,
          chars: naming.length,
        });
        setDeliveryNotice("That agent had stopped. Restarting it and sending your prompt…");
        onRestartAgent?.();
      } else if (e instanceof PtyGoneError) {
        // The restart didn't take (this is the retry). Stop, and hand the text back — the user is
        // told the truth instead of watching a queue nobody will drain.
        restoreDraft(typed, atts, blocks);
        log.error("composer", "send hit a dead PTY again after restart — giving up", { agentId });
        setDeliveryNotice("Couldn't reach that agent, even after restarting it. Your text is back in the box.");
      } else {
        // Unknown failure: hand the text back rather than swallowing it.
        restoreDraft(typed, atts, blocks);
        log.error("composer", "send failed — draft restored", {
          agentId,
          error: String((e as { message?: string })?.message ?? e),
        });
        setDeliveryNotice("Couldn't send that prompt — your text is back in the box.");
      }
      return;
    }
    setDeliveryNotice(null);
    // Remember the typed text (not the attachment-annotated display) so it can be offered as a
    // ghost-text suggestion next time — clicked prompts feed this exactly like typed ones.
    if (naming) recordPrompt(naming);
    // Pass the typed text as the naming basis, separate from the marker-decorated `display`.
    // Attachments-only sends carry an empty basis, so auto-naming is skipped.
    onSubmitPrompt(display, naming);
    // Consume a trial prompt only now that it's actually delivered (no-op for entitled users).
    void recordTrialSend();
    // "Pause listening on submit" (default): if actively dictating, drop back to passive wake-word
    // listening now that the prompt is sent. No-op under "Keep listening" or when not dictating.
    maybePauseOnSubmit();
  };

  const send = async () => {
    if (disabled) return; // hard-blocked (not merely starting) — nothing to do
    const typed = value;
    const text = value.trim();
    const atts = attachments;
    const blocks = textBlocks;
    if (isComposerEmpty()) return;
    // Free-trial cap (checked BEFORE delivery, consumed AFTER): block once the 100 are spent.
    // Entitled users always pass. When blocked, AuthGate's TrialChrome overlay is already
    // visible (it shows whenever promptsUsed ≥ limit), so this is defense-in-depth, not a
    // silent dead-end.
    if (!trialSendAllowed()) return;
    setValue("");
    setAttachments([]);
    setTextBlocks([]);
    // The draft is gone — snap the box back to its regular rest height so a long message doesn't
    // leave it sitting tall (clears any manual sizing too). Send is unreachable while minimized,
    // so this never fights the keep-minimized exception.
    resetComposerSize();
    // The agent is still starting: its PTY can't receive input yet. Queue this prompt (merging with
    // any already queued so nothing is lost) and let the flush effect deliver it the instant the PTY
    // is ready — so the user could compose immediately instead of waiting on the workspace spin-up.
    if (preparing) {
      queuePendingSend({ typed, atts, blocks, text });
      log.info("composer", "queue prompt (agent starting)", {
        agentId,
        chars: text.length,
        attachments: atts.length,
        textBlocks: blocks.length,
      });
      return;
    }
    log.info("composer", "send prompt", {
      agentId,
      chars: text.length,
      attachments: atts.length,
      textBlocks: blocks.length,
    });
    await deliverPrompt(typed, atts, blocks);
    // Learn from a real typed action so the suggestion history reflects what the user actually
    // does in this terminal state. Only log when suggestions were on offer (the agent is waiting
    // on the user) so ordinary mid-turn messages don't pollute the history.
    if (text && suggestionButtons.length > 0) {
      useSuggestionStore.getState().recordEvent({
        contextTags: deriveContextTags(getAgentScrollback(agentId) ?? ""),
        label: text.slice(0, 40),
        value: text,
        kind: "prompt",
      });
    }
  };

  // Flush a prompt that was queued while the agent was starting, the moment its PTY is ready
  // (`preparing` clears). Delivered exactly once — the ref is cleared before delivery, and the
  // effect only re-fires when `preparing` transitions. If the agent instead fails to start, the
  // composer unmounts and the queued prompt is intentionally discarded (don't feed a broken agent).
  useEffect(() => {
    if (preparing) return;
    const queued = pendingSendRef.current;
    if (!queued) return;
    pendingSendRef.current = null;
    log.info("composer", "flush queued prompt (agent ready)", {
      agentId,
      chars: queued.text.length,
      attachments: queued.atts.length,
      textBlocks: queued.blocks.length,
    });
    // allowRestart:false — this IS the post-restart retry. If the respawned PTY is dead too, give
    // up and hand the text back rather than restarting again (and again).
    void deliverPrompt(queued.typed, queued.atts, queued.blocks, { allowRestart: false });
    // deliverPrompt is a fresh closure each render but reads only its args + stable refs; re-running
    // this on its identity would risk a double-flush, so key it solely on the preparing transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparing]);

  // Send a suggestion button's action immediately (one click). Terminal-kind buttons inject raw
  // keystrokes straight into the PTY (y/n, numbered choices); prompt-kind buttons go through the
  // normal message path as if the user had typed and sent them; control-kind buttons run an app
  // action (e.g. close this build agent). Then learn from the action and clear the row.
  const onSuggestionClick = async (b: SuggestionButton) => {
    if (b.kind === "control") {
      // Control buttons touch nothing in the PTY and aren't a learnable "action", so they don't
      // record to history and aren't gated by `disabled` (PTY not spawned). Route by action id.
      const action = parseControlAction(b.value);
      if (action === CLOSE_AGENT_ACTION) await closeBuildAgent(agentId);
      clearSuggestions();
      return;
    }
    if (disabled) return;
    if (b.kind === "terminal") {
      // Terminal-kind buttons come ONLY from the local heuristic detector and carry a bare control
      // keystroke (y/n, a menu digit) — interactive terminal input, not a metered "send". So they
      // intentionally bypass the trial-cap gate, exactly like typing into the terminal directly.
      //
      // Auto-approve nudge (spec §4): if the clicked button was the plain "Yes" on a classifiable
      // permission prompt, the feature is on, and the category has no rule yet, offer to remember it.
      // Read BEFORE writePty moves the terminal on. v1 fires only on the pill click (typed answers
      // are a documented follow-up).
      const classification = classifyApproval(getAgentScrollback(agentId) ?? "");
      if (
        classification &&
        b.value === classification.approveOption &&
        aiFeatureNow("autoApprove") &&
        effectiveApprovalRule(approvalProjectRoot, classification.category) === undefined
      ) {
        setApprovalNudge(classification.category);
      }
      await writePty(agentId, b.value);
      // Record the answer as a "picker" prompt turn (additive to the PTY write, never a
      // replacement). It's not a metered send and stays out of every DISPLAY surface (composerPrompts
      // filters it), but it advances promptHistory.length — the promptCount the naming ladder reads
      // (agentNaming: deferred_first_turn on promptCount < 2). Without it a picker-driven build agent
      // sits at promptCount 1 forever and is never named. Store the human-readable LABEL, not the
      // bare "1\n" keystroke. No-op if the agent's project has been unloaded (project switch
      // mid-click) — appendPrompt maps over the matching project only, so a stale id changes nothing.
      const projectId = useProjectStore
        .getState()
        .projects.find((p) => p.agents.some((a) => a.id === agentId))?.id;
      if (projectId) useProjectStore.getState().appendPrompt(projectId, agentId, b.label, "picker");
    } else {
      if (!trialSendAllowed()) return;
      await deliverPrompt(b.value, [], []);
    }
    useSuggestionStore.getState().recordEvent({
      contextTags: deriveContextTags(getAgentScrollback(agentId) ?? ""),
      label: b.label,
      value: b.value,
      kind: b.kind,
    });
    clearSuggestions();
  };

  // Accept the ghost completion: replace the input with the full past prompt and drop the
  // caret at the end. Only reachable when a ghost is showing (which implies caret-at-end).
  const acceptGhost = () => {
    const full = value + ghost;
    setValue(full);
    setCaretAtEnd(true);
    // Selection must be set after React commits the new value, or it snaps back. Re-sync the
    // mirror's scroll too: moving the caret to the end can scroll the textarea programmatically
    // without firing onScroll, which would briefly misalign the painted text on long inputs.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.selectionStart = ta.selectionEnd = full.length;
        if (ghostRef.current) ghostRef.current.scrollTop = ta.scrollTop;
      }
    });
  };

  // Keep `caretAtEnd` in sync with the real caret so the ghost hides the moment the user
  // moves into the middle of the text (arrow-left, click, select) and returns when at the end.
  const syncCaret = () => {
    const ta = taRef.current;
    if (!ta) return;
    // syncCaret fires on keyUp/select/click/change — typing a character leaves the caret at the
    // end every time, so this would otherwise re-set caretAtEnd to the same value on every
    // keystroke. Only write when it actually flips (syncCaret is recreated each render, so
    // caretAtEnd is current) to avoid the redundant state-update churn.
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;
    if (atEnd !== caretAtEnd) setCaretAtEnd(atEnd);
    // Remember where the caret is while the box is focused, so dictation that arrives after focus
    // has moved away (mic/voice UI) still inserts at the user's last position rather than the end.
    if (document.activeElement === ta) {
      lastCaretRef.current = { start: ta.selectionStart, end: ta.selectionEnd };
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposerToggleKey(e, useKeybindingsStore.getState().bindings.toggleComposer)) {
      // ⌘J: tuck the composer away and hand focus to the terminal (AgentPane moves it).
      e.preventDefault();
      setMinimized(true);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Empty composer → there's nothing to send. Instead of a dead keypress, forward Enter to the
      // terminal so it confirms the highlighted choice in Claude's menu (mirrors onArrowOverflow:
      // arrows move the highlight, Enter picks it). Skip while an IME composition is committing.
      // Emptiness matches send()'s own gate via the shared isComposerEmpty() helper.
      if (isComposerEmpty() && onEnterOverflow && !e.nativeEvent.isComposing) {
        onEnterOverflow();
        return;
      }
      void send();
      return;
    }
    // → or Tab accepts the ghost when one is showing. At end-of-text → is otherwise a no-op,
    // and Tab is repurposed as accept (the user's choice) — Escape dismisses the ghost first
    // to free Tab for focus movement when needed. Shift+Tab is left alone so backward focus
    // traversal still works. Skip while an IME composition is active, so a →/Tab that commits
    // a CJK candidate isn't hijacked into accepting the ghost.
    if (
      ghost &&
      !e.nativeEvent.isComposing &&
      (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey))
    ) {
      e.preventDefault();
      acceptGhost();
      return;
    }
    // Escape dismisses the visible ghost (without clearing the input) so Tab can move focus.
    // Consume the event (stopPropagation) so dismissing the ghost doesn't also fire an
    // ancestor/global Escape handler in the same keystroke — Escape's effect stays predictable.
    if (ghost && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setGhostDismissed(true);
    }
    // A vertical arrow that runs off the edge of the text crosses into the terminal: Down off
    // the last line, Up off the first. Inside the text it stays native (move the caret a line),
    // so multi-line editing is unaffected — only the overflow press hands off. The edge logic
    // (modifiers, selection, IME, line position) lives in arrowOverflowDirection so it's unit-
    // tested; here we just act on its verdict.
    if (onArrowOverflow && taRef.current) {
      const ta = taRef.current;
      const dir = arrowOverflowDirection({
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
        ghostActive: ghost !== "",
        value: ta.value,
        selectionStart: ta.selectionStart,
        selectionEnd: ta.selectionEnd,
      });
      if (dir) {
        e.preventDefault();
        onArrowOverflow(dir);
        return;
      }
    }
  };

  // Pointer-capture keeps move/up events scoped to the handle element, so they're cleaned
  // up automatically if the component unmounts mid-drag (no leaked window listeners). The
  // handle is a SINGLE element rendered in both the open and minimized states (below), so
  // capture survives the minimize/restore transition — the drag stays smooth across it.
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Base the drag on the height actually on screen (which may be auto-expanded above the
    // stored floor), so the handle tracks the cursor from the first pixel instead of having
    // to close the auto-expand gap first.
    dragRef.current = { startY: e.clientY, startH: autoHeight, startMin: minimized };
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const r = resolveComposerDrag(
      { startHeight: d.startH, startMinimized: d.startMin, dy: d.startY - e.clientY, floor: height },
      {
        snap: COMPOSER_SNAP,
        min: COMPOSER_MIN,
        max: maxComposerHeight(),
        snapThreshold: COMPOSER_SNAP_THRESHOLD,
        minimizeThreshold: COMPOSER_MINIMIZE_THRESHOLD,
        restoreThreshold: COMPOSER_RESTORE_THRESHOLD,
      },
    );
    setComposerHeight(r.height);
    setMinimized(r.minimized);
    // A resize drag (not a minimize) hands manual control to the user, so the dragged height
    // becomes the composer's actual height — letting them size it DOWN past the content. Landing
    // back on the snap rest clears that, re-enabling auto-grow. Minimize drags don't touch the
    // flag, so a minimize→restore returns to whatever mode the composer was in.
    // The equality is exact because withSnap() (composerDrag.ts) returns precisely COMPOSER_SNAP
    // inside the magnet range. Guard the write so we only touch the persisted store when the
    // mode actually flips, not on every move frame of the drag.
    if (!r.minimized) {
      const nextSized = r.height !== COMPOSER_SNAP;
      if (nextSized !== userSized) setComposerUserSized(nextSized);
    }
  };
  const onHandleUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    // pointercancel is an aborted gesture, not a release — clean up but never restore on it.
    if (!d || e.type !== "pointerup") return;
    // From the minimized bar, a click or any upward release brings the composer back —
    // including the sub-threshold drag the snap math intentionally leaves minimized, so there's
    // no dead zone. Restore just flips the flag: the remembered open height is already in the
    // store (so a tall composer comes back tall). A downward tug stays minimized.
    if (
      shouldRestoreFromBar({
        startMinimized: d.startMin,
        dy: d.startY - e.clientY,
        stillMinimized: useUiStore.getState().composerMinimized,
      })
    ) {
      setMinimized(false);
    }
  };

  // The default placeholder is rendered as a styled overlay (so "Hey Sparkle" can be bold +
  // blue, which a native textarea placeholder can't do). Only show it in the clean empty state
  // where the textarea sits at the top of its column, so the overlay lines up with row one.
  // `!interimActive` is essential: a live cloud-dictation preview paints into the SAME top-left
  // slot (via the ghost mirror) while `value` is still empty, so without this gate the overlay
  // would render on top of the streaming words and the two would overlap into garbled text.
  const showRichPlaceholder =
    !value &&
    !interimActive &&
    !disabled &&
    !dropActive &&
    attachments.length === 0 &&
    textBlocks.length === 0;

  // The composer is one overlay in two states. Minimized → it collapses to the slim handle
  // bar, exposing the terminal input; otherwise the handle sits atop the full message box.
  // The handle (the drag target / pointer-capture owner) is the SAME element in both states,
  // so a drag that crosses the minimize/restore line never loses its capture.
  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: minimized ? COMPOSER_BAR : autoHeight,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        // Minimized → no chrome: the strip is transparent so only the little gradient pull tab
        // floats over the exposed terminal. Open → the solid message-box surface with its top rule.
        background: minimized ? "transparent" : C.forest,
        borderTop: minimized ? "none" : `1px solid ${C.barSurface}`,
      }}
    >
      {/* Auto-approve nudge / confirmation toast + the "Auto-approved · Manage" note. Floated as an
          absolute overlay ABOVE the composer (bottom:100%) so it never disturbs the height math. The
          nudge takes precedence (a fresh pill click); otherwise the subtle auto-answered note shows. */}
      {(approvalNudge || autoApproved) && (
        <div style={{ position: "absolute", left: 10, right: 10, bottom: "calc(100% + 6px)", zIndex: 6 }}>
          {approvalNudge ? (
            <ApprovalNudge
              category={approvalNudge}
              projectRoot={approvalProjectRoot}
              onDismiss={() => setApprovalNudge(null)}
              onOpenOptions={() => openSettings("approvals")}
            />
          ) : autoApproved ? (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 10px",
                fontSize: 12,
                color: C.muted,
                fontFamily: '"IBM Plex Sans", sans-serif',
              }}
            >
              <span>
                Auto-approved {approvalCategoryLabel(autoApproved)}
              </span>
              <button
                type="button"
                onClick={() => openSettings("approvals")}
                style={{
                  background: "transparent",
                  border: "none",
                  color: C.accentInk,
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: '"IBM Plex Sans", sans-serif',
                  textDecoration: "underline",
                  padding: 0,
                }}
              >
                Manage
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Persistent grab handle: open → thin pill (drag up taller, down to minimize); minimized
          → a little gradient pull tab (click or drag up to bring the message box back). ⌘J also toggles. */}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        title={
          minimized
            ? "Click or drag up to bring back the prompt box (⌘J)"
            : "Drag to resize · drag down to minimize (⌘J)"
        }
        style={{
          height: minimized ? COMPOSER_BAR : 10,
          flex: "0 0 auto",
          display: "flex",
          // Minimized: anchor the pull tab to the very bottom edge so its rounded top reads as a
          // tab rising out of the window. Open: center the thin grab pill in the handle strip.
          alignItems: minimized ? "flex-end" : "center",
          justifyContent: "center",
          gap: 6,
          cursor: "ns-resize",
          color: C.muted,
          fontFamily: '"IBM Plex Sans", sans-serif',
          fontSize: 12,
          userSelect: "none",
        }}
      >
        {minimized ? (
          // A little gradient pull tab carrying the Sparkle logo's shading (lighter teal → darker
          // blue) and an upward caret, inviting the user back into the modern voice-enabled box.
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 16px",
              // Rounded only on top: the flat bottom meets the window edge, so it reads as a tab.
              borderRadius: "9px 9px 0 0",
              background: `linear-gradient(180deg, ${C.accent} 0%, ${C.teal} 100%)`,
              color: ON_BRAND_FILL,
              fontWeight: FONT_WEIGHT.semibold,
              fontSize: 12,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              boxShadow: "0 -1px 6px rgba(0,0,0,0.28)",
            }}
          >
            <span style={{ fontSize: 10 }}>▴</span>
            <span>Use the modern prompt box with voice</span>
          </div>
        ) : hiddenBelow > 0 ? (
          // Reveal chip: the composer is covering terminal output that isn't the input line it's
          // meant to sit over. Without this, hidden output is completely silent — the user has no
          // way to know a menu or message is behind the box. Clicking tucks the composer away.
          // (An actionable prompt normally auto-minimizes before this shows; the chip is the
          // backstop for everything auto-yield deliberately stays its hand on.)
          <button
            type="button"
            // The handle owns a pointer-drag gesture; stop the press from starting a drag so a
            // click here reads as "reveal", not a 0px resize.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMinimized(true)}
            title="The prompt box is covering terminal output — click to tuck it away (⌘J)"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "1px 10px",
              borderRadius: 999,
              border: "none",
              background: C.accent,
              color: ON_BRAND_FILL,
              fontFamily: '"IBM Plex Sans", sans-serif',
              fontWeight: FONT_WEIGHT.semibold,
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: "nowrap",
              cursor: "pointer",
            }}
          >
            <FiChevronDown size={12} aria-hidden />
            <span>
              {hiddenBelow} {hiddenBelow === 1 ? "line" : "lines"} hidden below
            </span>
          </button>
        ) : (
          <div style={{ width: 36, height: 3, borderRadius: 2, background: C.muted, opacity: 0.6 }} />
        )}
      </div>

      {!minimized && (
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, padding: "0 10px 10px", alignItems: "stretch" }}>
        {/* Bare mic to the LEFT of the input box — same behavior as the top waveform ring, shown
            only while the mic is on (paused/active), top-aligned so it stays beside the first line
            when the box grows. Hidden entirely when the mic is off. */}
        <ComposerMic />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6, position: "relative" }}>
          {/* A send that didn't land says so here. Silence was the bug: the prompt used to go
              into the history bar and nowhere else. */}
          {deliveryNotice && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                // Amber + alert glyph, matching ComposerVoiceError — the sibling inline notice in
                // this same box, so the two read as one treatment.
                color: C.amber,
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 12,
                lineHeight: 1.3,
              }}
            >
              <FiAlertTriangle size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{deliveryNotice}</span>
            </div>
          )}
          <AttachmentRow
            textBlocks={textBlocks}
            attachments={attachments}
            onRemoveTextBlock={removeTextBlock}
            onRemoveAttachment={removeAttachment}
            onShowAsText={showBlockAsText}
          />
          {/* The textarea and a mirror layer share one positioning context. The mirror sits
              behind a transparent-background textarea and re-renders the exact same text, but
              transparent — so only the trailing ghost suffix (painted muted) shows through.
              Because both boxes use identical font, padding, border width, and wrapping, the
              ghost lines up perfectly with the real caret, even across wrapped lines. */}
          <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
            <div
              ref={ghostRef}
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 0,
                overflow: "hidden",
                pointerEvents: "none",
                boxSizing: "border-box",
                background: C.barSurface,
                // Transparent border of the same width keeps the content box aligned with the
                // textarea's (whose visible border is painted on top).
                border: dropActive ? "1.5px solid transparent" : "1px solid transparent",
                borderRadius: 8,
                padding: "8px 10px",
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 14,
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
                // Reserve the scrollbar gutter in both layers so the text content box width
                // matches even when the textarea overflows and shows a scrollbar — otherwise
                // lines would wrap at different points and the ghost would drift.
                scrollbarGutter: "stable",
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <span style={{ color: "transparent" }}>{value}</span>
              <span style={{ color: C.muted, fontStyle: interimActive ? "italic" : "normal" }}>
                {ghost || interimSuffix}
              </span>
            </div>
            <textarea
              ref={setTaRef}
              // One row is the auto-grow baseline: when measuring (height:auto + align-self above),
              // an empty/single-line draft collapses to one line, so `desired` lands at the snap
              // rest height (COMPOSER_SNAP) rather than the textarea's 2-row default — that's what
              // lets a fresh or just-sent composer sit at its compact default. Flex drives the real
              // height the rest of the time, so `rows` only sets this measurement floor.
              rows={1}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setGhostDismissed(false); // a fresh edit re-enables suggestions
                syncCaret();
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onKeyUp={syncCaret}
              onSelect={syncCaret}
              onClick={syncCaret}
              onScroll={(e) => {
                if (ghostRef.current) ghostRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              disabled={disabled}
              placeholder={
                outOfCreditsNotice
                  ? "" // the styled overlay below renders the out-of-credits notice
                  : dropActive
                  ? "Drop the file here to attach it…"
                  : disabled
                  ? "Starting your agent…"
                  : interimActive
                  ? "" // the live dictation preview occupies the slot — no placeholder
                  : showRichPlaceholder
                  ? "" // the styled overlay below renders this state's placeholder
                  : // Everything from here down is the showRichPlaceholder === FALSE fallback (e.g.
                  // an attachment is staged). In the common empty-composer case the overlay and the
                  // role="status" error block below own these two states — which is also the a11y
                  // contract: the error must be announced ONCE, so it must not be both a native
                  // placeholder and a live region at the same time. Keep these branches after the
                  // showRichPlaceholder one.
                  // Voice-state fallback: the SAME micPresentation the styled overlay and the
                  // sidebar caption use, so this native placeholder can't drift from either.
                  micPresentation === "error" && errorNotice
                  ? `${errorNotice.headline} ${errorNotice.detail}`
                  : micPresentation === "preparing"
                  ? preparingPlaceholder(modelPercent(modelProgress))
                  : micPresentation === "activeListening"
                  ? micHotPlaceholder(stopWord)
                  : micPresentation === "passiveWaiting"
                  ? wakePlaceholder(wakeWord)
                  : micPresentation === "focusPaused"
                  ? PAUSED_COMPOSER_PLACEHOLDER // armed but not capturing — honest, mirrors the sidebar
                  : "" // mic off (master mute) — no voice prompt at all
              }
              spellCheck={false}
              style={{
                position: "relative",
                zIndex: 1,
                flex: 1,
                minHeight: 0,
                resize: "none",
                // When the user has hand-sized the box SHORTER than its content (userSized drag —
                // ), the textarea is pinned by flex to a height below its scrollHeight, so
                // the draft must SCROLL inside the smaller box rather than overflow it. Set overflow-y
                // explicitly so this never depends on the UA's default textarea overflow behavior.
                overflowY: "auto",
                boxSizing: "border-box",
                // Transparent so the mirror's ghost suffix shows through behind the real text.
                background: "transparent",
                color: C.cream,
                // Highlight the drop target while a file is dragged over the window.
                border: dropActive ? `1.5px dashed ${C.teal}` : `1px solid ${CHAT_USER_BUBBLE}`,
                borderRadius: 8,
                padding: "8px 10px",
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 14,
                lineHeight: 1.4,
                // Match the mirror's long-token wrapping so a pasted URL/path breaks at the
                // same point in both layers and the ghost stays aligned with the caret.
                overflowWrap: "break-word",
                // Keep the scrollbar gutter reserved (mirror does the same) so the text width
                // is identical with or without a vertical scrollbar — no wrap drift.
                scrollbarGutter: "stable",
                outline: "none",
                opacity: disabled ? 0.6 : 1,
              }}
            />
            {/* The single recommended action is an absolute overlay pinned to the textarea's
                trailing-right edge (vertically centered), NOT a width-eating sibling — so the
                composer keeps its full width. It only shows on an empty composer, so it never
                overlaps typed text; the empty input's caret/placeholder sit at the left. It stays
                visible while the mic is hot but nothing's been said (composerEmptyNow && listening),
                hiding only on interim speech or typed content. */}
            <SuggestionRow
              buttons={suggestionButtons}
              visible={suggestionRowVisible(composerEmptyNow, interimActive)}
              onClick={(b) => void onSuggestionClick(b)}
              onDismiss={dismissSuggestion}
            />
          </div>
          {showRichPlaceholder && errorNotice && (
            // Voice died — say so HERE, beside the mic the user actually clicked. (It used to be
            // reported ONLY under the sidebar logo, in the smallest type in the app, as a single
            // hardcoded "check Privacy → Microphone" sentence that was wrong for most failures.)
            //
            // Deliberately a SIBLING of the placeholder overlay below rather than a branch inside
            // it: that overlay is aria-hidden (the native placeholder is what gets announced), and
            // aria-hidden hides its whole subtree with no way for a descendant to opt back in — so
            // a Dismiss button living in there would be invisible to a screen reader. This block is
            // role="status" instead, so the failure is both seen AND announced. It occupies the same
            // slot on the same terms (empty, enabled composer), so the two can never both paint.
            <div
              role="status"
              style={{
                position: "absolute",
                zIndex: 2,
                top: 9,
                left: 11,
                right: suggestionButtons.length > 0 ? SUGGESTION_PILL_ZONE : 11,
                // Click-through like the placeholder overlay it stands in for, so the textarea
                // underneath still focuses on click; Dismiss re-enables pointer events on itself.
                pointerEvents: "none",
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 14,
                lineHeight: 1.4,
              }}
            >
              <ComposerVoiceError notice={errorNotice} />
            </div>
          )}
          {showRichPlaceholder && (
            // Styled stand-in for the native placeholder so "Hey Sparkle" can be bold + blue.
            // Aligned to the textarea's first text line (1px border + 8px/10px padding) and
            // click-through so it never blocks focusing the textarea underneath.
            <div
              aria-hidden
              style={{
                position: "absolute",
                // Stack ABOVE the textarea (zIndex:1). The overlay itself is pointerEvents:none, so
                // clicks on the placeholder still pass THROUGH to the textarea beneath (focus works);
                // but the out-of-credits "Refill" link re-enables pointerEvents on itself, and it can
                // only receive that click if the overlay isn't buried under the textarea. Without this
                // the textarea swallowed the click and Refill looked clickable but did nothing.
                zIndex: 2,
                top: 9,
                left: 11,
                // Right-padding safety: when the single recommended pill overlays the trailing
                // right edge, reserve its full footprint (SUGGESTION_PILL_ZONE, derived from the
                // pill's own max width so the two can't drift) so a long placeholder hint wraps
                // early instead of sliding underneath the (translucent) pill. showRichPlaceholder
                // implies an empty composer, so the pill is present here exactly when there's a
                // suggestion button.
                right: suggestionButtons.length > 0 ? SUGGESTION_PILL_ZONE : 11,
                pointerEvents: "none",
                color: C.muted,
                fontFamily: '"IBM Plex Sans", sans-serif',
                fontSize: 14,
                lineHeight: 1.4,
              }}
            >
              {micPresentation === "outOfCredits" ? (
                // Out of credits: an arm attempt was refused. Replace the mic placeholder with the
                // credits notice (the "Refill" link re-enables pointer events on itself so it stays
                // clickable inside this pointerEvents:none overlay).
                <ComposerOutOfCreditsNotice />
              ) : micPresentation === "error" ? (
                // The voice error paints in this slot too, but it is rendered by its own SIBLING
                // block below rather than here — this overlay is aria-hidden, and its Dismiss
                // control has to stay reachable. Render nothing here so the two can't double up.
                null
              ) : micPresentation === "preparing" ? (
                // The one-time model download. Honest + quiet: it names the wait, shows progress
                // when the backend gives a total, and points at the box the user can still type in.
                <ComposerPreparingNotice pct={modelPercent(modelProgress)} />
              ) : micPresentation === "activeListening" ? (
                // The mic-hot copy intentionally subsumes the typing hint ("…or start typing
                // here instead"), so it stays put on focus rather than swapping to a muted hint.
                <>
                  {MIC_HOT_PREFIX}
                  <StopPhrase phrase={stopWord} />
                  {MIC_HOT_SUFFIX}
                </>
              ) : micPresentation === "passiveWaiting" ? (
                // Capturing but waiting for the wake word: tell the truth (not "I'm listening").
                // Mirrors the sidebar caption; the "(or you can type here instead)" tail subsumes
                // the typing hint, so like the mic-hot copy it stays put on focus.
                <>
                  {WAKE_PREFIX}
                  <span style={{ fontWeight: FONT_WEIGHT.bold, color: C.teal }}>{wakeWord}</span>
                  {WAKE_SUFFIX}
                </>
              ) : micPresentation === "focusPaused" ? (
                // Armed but NOT capturing (window unfocused/muted, or capture not started yet). The
                // mic can't hear anything, so — exactly like the sidebar's "Listening paused" caption
                // — say so instead of inviting the wake word. The copy already says "you can type
                // here", so it also subsumes the old focused-only typing hint.
                PAUSED_COMPOSER_PLACEHOLDER
              ) : null /* micPresentation === "off": master mute — no voice promise at all */}
            </div>
          )}
        </div>
        <button
          data-hint="screenshot"
          onClick={() => void capture()}
          disabled={disabled || capturing}
          title="Capture a region of your screen"
          style={{
            alignSelf: "flex-end",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 40,
            height: 40,
            background: "transparent",
            color: C.cream,
            border: `1.5px dashed ${C.muted}`,
            borderRadius: 8,
            cursor: disabled || capturing ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
            padding: 0,
          }}
        >
          {capturing ? "…" : <CameraIcon />}
        </button>
        <button
          onClick={() => void send()}
          disabled={disabled}
          style={{
            alignSelf: "flex-end",
            background: C.teal,
            color: ON_BRAND_FILL,
            border: "none",
            borderRadius: 8,
            padding: "9px 18px",
            fontWeight: FONT_WEIGHT.semibold,
            fontFamily: '"IBM Plex Sans", sans-serif',
            cursor: disabled ? "not-allowed" : "pointer",
            height: 40,
            opacity: disabled ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </div>
      )}
    </div>
  );
}
