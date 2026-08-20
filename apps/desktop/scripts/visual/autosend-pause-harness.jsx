// The page `autosend-pause-probe.mjs` measures: TYPING HALTS THE AUTO-SEND COUNTDOWN.
//
// THE FOUNDER'S REPORT (bead sparkle-wfwypy): *"when I start by talking, and then I start typing in
// the compose window, it's not pausing the auto send. So if I start to type there's something
// already in the compose window from me, having spoken It should pause the auto send and then
// reevaluate it."*
//
// He asked to see it, not to be told about it. The jsdom suites prove the reducer, the predicate and
// the DOM wire, but none of them can show the thing he actually watches — the tray's fill draining,
// and then STOPPING under his hands. That is a painted pixel on a real clock, so it needs a browser.
//
// REAL COMPONENTS, REAL HOOK, REAL CLOCK: `useAutoSend`, `SendModeTray` and `ComposeBox` are the
// shipped ones, wired the way ConciergeHost wires them. The only thing standing in for the engine is
// `noteSpeechEnd()` on the real dictation store — the same call `useDictation`'s
// `dictation://speech-end` listener makes.
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// sit outside `pnpm typecheck` and look covered when it is not.
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { ComposeBox } from "../../src/components/Concierge/ComposeBox";
import { useAutoSend } from "../../src/voice/useAutoSend";
import {
  NO_COMPOSE_INTERACTION,
  noteComposeInteraction,
} from "../../src/voice/composeInteraction";
import { useDictationStore } from "../../src/stores/dictationStore";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/** Short, unpunctuated, no dangling tail — the founder's usual shape. Scores `normal`. */
const DICTATED = "ship the release notes today";

function Harness() {
  // The box owns its own text (it is uncontrolled), so the harness mirrors it out via
  // `onComposedText` and pushes text IN through `registerInsert` — the same seam
  // `useConciergeDictation` uses to drop a committed segment in. Typing it in would be a different
  // gesture entirely: it would mark the draft hand-edited before the demo starts.
  const [text, setText] = useState("");
  const insertRef = useRef(null);
  const [interaction, setInteraction] = useState(NO_COMPOSE_INTERACTION);
  const [sent, setSent] = useState(0);

  const onComposeInteraction = useCallback(
    (kind) => setInteraction((prev) => noteComposeInteraction(prev, kind)),
    [],
  );

  const rail = useAutoSend({
    armed: true,
    autoSend: true,
    micLive: true,
    composedText: text,
    composingMention: false,
    attachPickerOpen: false,
    draftGrewSeq: 0,
    composeInteraction: interaction,
    interim: "",
    targetName: "Concierge",
    onFire: () => {
      setSent((n) => n + 1);
      setText("");
      return true;
    },
    onAnnounce: () => {},
  });

  // What the probe reads. `remainingFraction` is the fill's own number, so a frozen bar and a frozen
  // reading cannot disagree — they are the same value.
  window.__rail = { phase: rail.phase, fraction: rail.remainingFraction, sent };
  // Stand-ins for the two things the engine does: drop the committed words in, then say the
  // speaker stopped. Everything downstream of here is the shipped path.
  window.__dictate = (t = DICTATED) => insertRef.current?.(t);
  window.__speechEnd = () => useDictationStore.getState().noteSpeechEnd();

  return (
    <div style={{ width: 520, padding: 16, display: "grid", gap: 10 }}>
      <div data-testid="probe-readout" style={{ font: "12px ui-monospace", color: "#9fb3d9" }}>
        phase={rail.phase} fraction={rail.remainingFraction.toFixed(3)} sent={sent}
      </div>
      <ComposeBox
        onSend={() => {}}
        onAttach={() => {}}
        onComposedText={setText}
        registerInsert={(fn) => {
          insertRef.current = fn;
        }}
        onComposeInteraction={onComposeInteraction}
        // THE TRAY LIVES INSIDE THE BOX, exactly as ConciergeHost wires it — one `model` object,
        // not five flat props. Rendering a second SendModeTray beside it (the first draft here)
        // photographs the WRONG tray: the box's own is the one the founder looks at, and it sits
        // above whatever you add underneath.
        sendMode="speak"
        autoSend={{
          phase: rail.phase,
          targetName: rail.targetName,
          tier: rail.tier,
          remainingFraction: rail.remainingFraction,
          firedSeq: rail.firedSeq,
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
