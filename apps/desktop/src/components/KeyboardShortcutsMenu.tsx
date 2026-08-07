import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FiRotateCcw } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_UI } from "../theme/scale";
import { SECTION_LABEL } from "./labelTreatment";
import {
  useKeybindingsStore,
  SHORTCUT_LABELS,
  type ShortcutId,
} from "../stores/keybindingsStore";
import {
  captureReduce,
  formatBinding,
  INITIAL_CAPTURE,
  type CaptureState,
} from "../keyboardHints/keybindings";
import { bindingConflict } from "../keyboardHints/reservedChords";

// Settings → Shortcuts pane. Lists the rebindable shortcuts; each row shows the current binding,
// a "Press a key…" capture button, and a reset. Capture feeds the pure captureReduce state machine
// (tap = lone modifier press+release; chord = modifiers+key), so a tap of Control and a press of ⌘J
// are both recordable through the same field.
// Hand-maintained so the ORDER is a design decision rather than object-key order. An id missing from
// here has no Settings row and cannot be rebound, so `keybindingsStore.test.ts` asserts this list
// covers every `ShortcutId`.
export const SHORTCUT_ROW_ORDER: ShortcutId[] = ["toggleHints", "toggleComposer", "unmountCable"];
const IDS = SHORTCUT_ROW_ORDER;

export function KeyboardShortcutsMenu() {
  const bindings = useKeybindingsStore((s) => s.bindings);
  const setBinding = useKeybindingsStore((s) => s.setBinding);
  const resetBinding = useKeybindingsStore((s) => s.resetBinding);
  // In the STORE, not local state: global chord handlers (⌘, and friends) live on `window` in the
  // capture phase and register at app mount, so they fire BEFORE this capture listener and its
  // `stopPropagation` cannot reach them. They stand down by reading this flag. See
  // keybindingsStore.capturingShortcut for the full reasoning.
  const listening = useKeybindingsStore((s) => s.capturingShortcut);
  const setListening = useKeybindingsStore((s) => s.setCapturingShortcut);
  const capture = useRef<CaptureState>(INITIAL_CAPTURE);
  // Why the last attempt was refused, shown in place of the prompt. Local, not in the store: no
  // global handler reads it, and it is meaningless once this pane is gone.
  //
  // KEYED BY ShortcutId, not a bare string. `capturingShortcut` is a public store action, so
  // `listening` can move without this component's button being clicked — and an unkeyed message
  // would then be attributed to whichever row happens to be listening, showing row A's "⌘K already
  // opens the command palette" on row B (roborev 55581). Keying it makes the mis-attribution
  // unrepresentable rather than something the clear-on-click path has to keep up with.
  const [rejected, setRejected] = useState<{ id: ShortcutId; reason: string } | null>(null);

  useEffect(() => {
    if (!listening) return;
    capture.current = INITIAL_CAPTURE;
    // Capture phase + preventDefault/stopPropagation, which stops the DEEPER tree — so a recorded
    // chord doesn't also type into a field or route to a component handler.
    //
    // It does NOT stop the window/capture cohort (⌘, ⌘K, the hint-mode tap machine): those sit on
    // the same node in the same phase and register at mount, so they run BEFORE this listener and
    // `stopPropagation` cannot reach backwards. `stopImmediatePropagation` would not help either —
    // it only stops listeners registered after ours. That is why they stand down by READING
    // `capturingShortcut` instead (see `isRebinding`); it is the only mechanism that works against
    // an earlier same-node listener. Escape cancels the capture.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown" && e.key === "Escape") {
        // Clear the refusal too: cancelling is the user withdrawing, so a leftover "⌘K already
        // opens…" must not survive to be shown against the next capture.
        setRejected(null);
        setListening(null);
        return;
      }
      const out = captureReduce(capture.current, {
        type: e.type as "keydown" | "keyup",
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      });
      capture.current = out.state;
      if (out.binding) {
        // Reject a tap gesture for a chord-only shortcut (e.g. the composer toggle, which is matched
        // on keydown and can't honor a tap) — keep listening so the user presses a real combo.
        if (out.binding.kind === "tap" && !SHORTCUT_LABELS[listening].allowsTap) {
          capture.current = INITIAL_CAPTURE;
          return;
        }
        // Reject a chord another handler already owns, the same way — keep listening and say why.
        // Now that global handlers stand down during a capture, a collision no longer announces
        // itself by firing, so accepting one here would persist a permanent double-fire the user
        // could only discover later and only undo via Reset (roborev 55540).
        const conflict = bindingConflict(out.binding, bindings, listening);
        if (conflict) {
          capture.current = INITIAL_CAPTURE;
          setRejected({ id: listening, reason: `${formatBinding(out.binding)} ${conflict}` });
          return;
        }
        setRejected(null);
        setBinding(listening, out.binding);
        setListening(null);
      }
    };
    // Losing the window ENDS the capture (bead sparkle-thm9o). `onKey` above preventDefaults
    // unconditionally, on keydown and keyup alike, so for as long as `listening` is set every key in
    // the app is dead. That is the intended cost of recording a chord and it is only survivable
    // because the gesture always ends — except ⌘Tab, where macOS never delivers the keyup, so the
    // combo sits in flight forever: the capture never completes, the flag never clears, and the
    // keyboard stays dead with no visible cause and no way back short of a relaunch. Blur is the only
    // end that gesture will get, exactly as it is the only end a push-to-talk hold gets
    // (voice/usePushToTalk).
    //
    // On `window` and NOT in the capture phase, both deliberate: `blur` does not bubble, so a
    // bubble-phase window listener hears the WINDOW losing focus and not a button inside this pane
    // losing it. Registering it with `capture: true` — or on `focusout`, which does bubble — would
    // make clicking anywhere in the app cancel a capture the user had just started, trading the latch
    // for a recorder nobody can use.
    const onBlur = () => {
      // Clear the refusal for the same reason Escape does: the gesture is being abandoned, so a
      // leftover "⌘K already opens…" must not survive to greet a user who has pressed nothing yet.
      setRejected(null);
      setListening(null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
    // `bindings` is a dep because the conflict check reads it. Re-registering on a change is
    // harmless: the only change that happens mid-capture is the successful setBinding above, which
    // clears `listening` in the same breath and tears the effect down anyway.
  }, [listening, setBinding, setListening, bindings]);

  // Now that the capture flag is GLOBAL, it must not outlive this pane. Closing Settings — or just
  // switching to another category — unmounts us with `capturingShortcut` still set, which would
  // leave every global chord standing down permanently, with no visible cause and no way back
  // short of a relaunch. Clearing on unmount is the whole guard.
  useEffect(() => () => setListening(null), [setListening]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {IDS.map((id) => {
        const isListening = listening === id;
        // Keyed, so a refusal recorded for another row can never surface on this one.
        const rejectedHere = isListening && rejected?.id === id ? rejected.reason : null;
        return (
          <div key={id}>
            <div style={subLabel}>{SHORTCUT_LABELS[id].title}</div>
            <div style={blurb}>{SHORTCUT_LABELS[id].blurb}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setRejected(null);
                  setListening(isListening ? null : id);
                }}
                style={{ ...captureBtn, ...(isListening ? listeningStyle : {}) }}
              >
                {isListening
                  ? // A refused chord replaces the prompt with the reason, so the rejection isn't
                    // silent — the pane otherwise just keeps waiting and looks broken.
                    (rejectedHere
                      ? `${rejectedHere} — try another`
                      : `${SHORTCUT_LABELS[id].allowsTap ? "Tap a modifier or press a combo" : "Press a combo"}…  (Esc to cancel)`)
                  : formatBinding(bindings[id])}
              </button>
              <button
                type="button"
                onClick={() => {
                  resetBinding(id);
                  if (isListening) setListening(null);
                }}
                title="Reset to default"
                aria-label={`Reset ${SHORTCUT_LABELS[id].title} to default`}
                style={resetBtn}
              >
                <FiRotateCcw size={12} aria-hidden />
              </button>
            </div>
          </div>
        );
      })}
      <p style={tip}>
        Tip: where allowed, tap a single modifier (e.g. Control); otherwise press a full combo (e.g.
        ⌘J). Combos need ⌘, ⌃, or ⌥ so a shortcut can't fire while you're typing.
      </p>
    </div>
  );
}

const subLabel: CSSProperties = { ...SECTION_LABEL, marginBottom: 4 };

const blurb: CSSProperties = { fontSize: 12, color: C.muted, marginBottom: 8, lineHeight: 1.4 };

const captureBtn: CSSProperties = {
  minWidth: 180,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: FONT_UI,
  textAlign: "center",
};

const listeningStyle: CSSProperties = {
  borderColor: C.accent,
  color: C.accent,
};

const resetBtn: CSSProperties = {
  background: "transparent",
  color: C.muted,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  width: 32,
  height: 32,
  cursor: "pointer",
  fontSize: 17,
  lineHeight: 1,
};

const tip: CSSProperties = { margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.5 };
