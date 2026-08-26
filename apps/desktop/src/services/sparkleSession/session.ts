// Wiring: wake-word detector + genie router -> the overlay controller. Bead sparkle-uz87.7.
//
// This is the ONLY file in the epic that knows all three pieces exist. It holds no rules of its
// own — `machine.ts` decides what happens and this decides who to tell — so that the interesting
// question ("does the swarm paint the right thing in the right order") stays answerable without a
// canvas, and this layer only has to be right about plumbing.
//
// EVERY DEPENDENCY IS INJECTABLE, AND THE REAL ONES ARE STILL SUPPLIED HERE. That combination is
// deliberate: in this repo a seam that every test injects leaves the line supplying the real value
// covered by nothing, so deleting it keeps the suite green while the feature is dead in the app
// (`sparkle-lgbwf`, seen 4x). `defaultSessionDeps()` below is the real wiring, and it has its own
// test that does NOT inject.
import {
  createWakeWordDetector,
  type WakeWordDetector,
  type WakeWordEvent,
} from "../../voice/wakeWord";
import { routeGenieIntent, type GenieResponse } from "../genie";
import type { SparkleOverlayController } from "../../components/SparkleOverlay";
import {
  INITIAL_SNAPSHOT,
  transition,
  type ControllerIntent,
  type SessionEvent,
  type SessionSnapshot,
} from "./machine";

/** What the session needs from the outside world. All of it is replaceable in a test. */
export interface SparkleSessionDeps {
  controller: SparkleOverlayController;
  /** Built lazily so the session owns the detector's lifetime (and can dispose it). */
  createDetector: (onDetect: (e: WakeWordEvent) => void) => WakeWordDetector;
  route: (transcript: string, at: number) => Promise<GenieResponse>;
  now: () => number;
  /** Surfaced so a caller can act on `response.action`; the overlay itself never does. */
  onAction?: (response: GenieResponse) => void;
}

export interface SparkleSession {
  /** Feed a transcript chunk from the existing dictation path. */
  feed(chunk: string): void;
  /** Close the current utterance and ask the genie. */
  endOfSpeech(transcript?: string): void;
  mute(): void;
  unmute(): void;
  dismiss(): void;
  getState(): SessionSnapshot;
  dispose(): void;
}

/** The REAL wiring. Not injected anywhere, so `session.realDeps.test.ts` covers this line. */
export function defaultSessionDeps(
  controller: SparkleOverlayController,
  onAction?: (response: GenieResponse) => void,
): SparkleSessionDeps {
  return {
    controller,
    createDetector: (onDetect) => createWakeWordDetector({ onDetect }),
    route: (transcript, at) => routeGenieIntent({ transcript, at }),
    now: () => Date.now(),
    onAction,
  };
}

export function createSparkleSession(deps: SparkleSessionDeps): SparkleSession {
  let snap: SessionSnapshot = INITIAL_SNAPSHOT;
  let disposed = false;

  function apply(intents: ControllerIntent[]): void {
    for (const intent of intents) {
      switch (intent.kind) {
        case "setState":
          deps.controller.setState(intent.anchor, intent.mode);
          break;
        case "hear":
          void deps.controller.hear(intent.text);
          break;
        case "reply":
          void deps.controller.reply(intent.text);
          break;
        case "dismiss":
          deps.controller.dismiss();
          break;
        default: {
          const _exhaustive: never = intent;
          void _exhaustive;
        }
      }
    }
  }

  function send(ev: SessionEvent): void {
    if (disposed) return;
    const result = transition(snap, ev);
    snap = result.next;
    apply(result.intents);
  }

  const detector = deps.createDetector((e) => {
    send({ kind: "wake", residual: e.residual, at: e.at });
  });

  return {
    feed(chunk) {
      if (disposed) return;
      // The detector sees EVERY chunk — that is what makes the wake word continuous. Only once
      // awake does the same chunk also become visible transcript.
      detector.feed(chunk);
      if (snap.state === "listening") send({ kind: "transcript", text: chunk });
    },

    endOfSpeech(transcript) {
      if (disposed) return;
      const text = (transcript ?? snap.heard).trim();
      const before = snap;
      send({ kind: "endOfSpeech", transcript: text });
      // Only ask the genie if that event actually moved us into processing; an endOfSpeech while
      // idle is a no-op, and issuing a request for it would answer a question nobody asked.
      if (before.state === "listening" && snap.state === "processing") {
        const generation = snap.generation;
        deps
          .route(text, deps.now())
          .then((response) => {
            send({ kind: "responseReady", replyText: response.replyText, generation });
            // The action is surfaced only if the response was not stale — a dismissed
            // conversation must not still perform its side effect.
            if (!disposed && snap.generation === generation) deps.onAction?.(response);
          })
          .catch(() => {
            send({ kind: "error" });
          });
      }
    },

    mute() {
      detector.setEnabled(false);
      send({ kind: "muted", muted: true });
    },

    unmute() {
      detector.setEnabled(true);
      detector.reset();
      send({ kind: "muted", muted: false });
    },

    dismiss() {
      send({ kind: "dismiss" });
    },

    getState() {
      return snap;
    },

    dispose() {
      disposed = true;
      detector.setEnabled(false);
    },
  };
}
