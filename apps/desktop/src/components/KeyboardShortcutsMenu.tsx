import { useEffect, useRef, type CSSProperties } from "react";
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

// Settings → Shortcuts pane. Lists the rebindable shortcuts; each row shows the current binding,
// a "Press a key…" capture button, and a reset. Capture feeds the pure captureReduce state machine
// (tap = lone modifier press+release; chord = modifiers+key), so a tap of Control and a press of ⌘J
// are both recordable through the same field.
const IDS: ShortcutId[] = ["toggleHints", "toggleComposer"];

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
        setBinding(listening, out.binding);
        setListening(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, [listening, setBinding, setListening]);

  // Now that the capture flag is GLOBAL, it must not outlive this pane. Closing Settings — or just
  // switching to another category — unmounts us with `capturingShortcut` still set, which would
  // leave every global chord standing down permanently, with no visible cause and no way back
  // short of a relaunch. Clearing on unmount is the whole guard.
  useEffect(() => () => setListening(null), [setListening]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {IDS.map((id) => {
        const isListening = listening === id;
        return (
          <div key={id}>
            <div style={subLabel}>{SHORTCUT_LABELS[id].title}</div>
            <div style={blurb}>{SHORTCUT_LABELS[id].blurb}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => setListening(isListening ? null : id)}
                style={{ ...captureBtn, ...(isListening ? listeningStyle : {}) }}
              >
                {isListening
                  ? `${SHORTCUT_LABELS[id].allowsTap ? "Tap a modifier or press a combo" : "Press a combo"}…  (Esc to cancel)`
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
