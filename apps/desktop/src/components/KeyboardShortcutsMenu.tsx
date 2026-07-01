import { useEffect, useRef, useState, type CSSProperties } from "react";
import { C } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
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
  const [listening, setListening] = useState<ShortcutId | null>(null);
  const capture = useRef<CaptureState>(INITIAL_CAPTURE);

  useEffect(() => {
    if (!listening) return;
    capture.current = INITIAL_CAPTURE;
    // Capture phase + swallow everything: while recording, no keystroke should reach the app
    // (so e.g. ⌘J doesn't also toggle the composer mid-capture). Escape cancels the capture.
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
  }, [listening, setBinding]);

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
                ↺
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

const subLabel: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: C.muted,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 4,
};

const blurb: CSSProperties = { fontSize: 12, color: C.muted, marginBottom: 8, lineHeight: 1.4 };

const captureBtn: CSSProperties = {
  minWidth: 180,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
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
  borderRadius: 8,
  width: 32,
  height: 32,
  cursor: "pointer",
  fontSize: 15,
  lineHeight: 1,
};

const tip: CSSProperties = { margin: 0, fontSize: 11, color: C.muted, lineHeight: 1.5 };
