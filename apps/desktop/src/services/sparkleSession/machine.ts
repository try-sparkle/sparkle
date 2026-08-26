// The Living Sparkle Overlay's session state machine — bead sparkle-uz87.7.
//
// WHY THIS IS A PURE FUNCTION AND NOT A HOOK. The thing worth testing here is an ORDER: idle ->
// listening -> processing -> responding -> idle, and which of those beats repaints the swarm. An
// order is only testable if the transition can be driven synchronously, one event at a time, with
// no React, no canvas and no clock of its own. So `transition` takes a state and an event and
// returns the next state plus the controller calls to make; `session.ts` is the only part that
// knows a controller exists.
//
// THE GENERATION COUNTER IS THE POINT OF THE `dismiss` CASE. A response is awaited, so it can
// arrive AFTER the user has dismissed the overlay or started a new utterance — the reply would
// then paint over a swarm that has gone home, or over somebody else's question. Each wake bumps
// `generation`; a `responseReady` carrying a stale generation is dropped. This repo has shipped
// the opposite bug (`sparkle-40va0`): two entry points raced from one gesture and the test merely
// picked reading order, so the losing interleaving was never exercised at all.

/** Where the conversation is. Distinct from the overlay's `Mode`, which is what the swarm PAINTS. */
export type SessionState = "idle" | "listening" | "processing" | "responding";

export type SessionEvent =
  /** The wake phrase fired. `residual` is anything said after it in the same breath. */
  | { kind: "wake"; residual: string; at: number }
  /** A (possibly partial) transcript chunk while listening. */
  | { kind: "transcript"; text: string }
  /** The utterance closed; the genie is now being asked. */
  | { kind: "endOfSpeech"; transcript: string }
  /** An answer came back. `generation` is the one the request was issued under. */
  | { kind: "responseReady"; replyText: string; generation: number }
  /** The reply finished painting. */
  | { kind: "responseDone" }
  /** The user dismissed the overlay, or clicked away. */
  | { kind: "dismiss" }
  /** Anything went wrong — the overlay must never be stranded mid-cycle. */
  | { kind: "error" }
  /** The privacy control was toggled. Muting mid-conversation ends it. */
  | { kind: "muted"; muted: boolean };

/** One thing to do to the overlay controller. The machine emits these; it never calls anything. */
export type ControllerIntent =
  | { kind: "setState"; anchor: "perch" | "center" | "card" | "row"; mode: "still" | "listening" | "processing" | "speaking" }
  | { kind: "hear"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "dismiss" };

export interface SessionSnapshot {
  state: SessionState;
  /** Bumped on every wake. A response from an older generation is stale and is dropped. */
  generation: number;
  /** While true the machine accepts nothing and emits nothing. */
  muted: boolean;
  /** The transcript accumulated for the current utterance. */
  heard: string;
}

export interface TransitionResult {
  next: SessionSnapshot;
  intents: ControllerIntent[];
}

export const INITIAL_SNAPSHOT: SessionSnapshot = {
  state: "idle",
  generation: 0,
  muted: false,
  heard: "",
};

function goHome(snap: SessionSnapshot, generation = snap.generation): TransitionResult {
  return {
    next: { ...snap, state: "idle", generation, heard: "" },
    intents: [{ kind: "dismiss" }, { kind: "setState", anchor: "perch", mode: "still" }],
  };
}

/**
 * Advance the session by one event.
 *
 * Every branch returns explicitly — there is no shared fall-through tail — because the failure
 * mode of a state machine is a beat that quietly does nothing, which looks identical to a beat
 * that was never reached.
 */
export function transition(snap: SessionSnapshot, ev: SessionEvent): TransitionResult {
  // Muting is the privacy control and outranks everything: it is answered before any other event
  // is even looked at, so there is no ordering in which a muted machine can still act.
  if (ev.kind === "muted") {
    if (ev.muted) {
      // Muting mid-conversation must also TEAR DOWN what is on screen — leaving the swarm out
      // front would show a listening overlay attached to a microphone that is now off.
      const home = goHome({ ...snap, muted: true });
      return snap.state === "idle"
        ? { next: { ...snap, muted: true }, intents: [] }
        : home;
    }
    return { next: { ...snap, muted: false }, intents: [] };
  }
  if (snap.muted) return { next: snap, intents: [] };

  switch (ev.kind) {
    case "wake": {
      // A wake during an existing conversation REPLACES it: the user asked something new, and the
      // in-flight answer to the old question must not paint over the new one. Bumping the
      // generation is what makes that stale response droppable.
      const generation = snap.generation + 1;
      const intents: ControllerIntent[] = [
        { kind: "setState", anchor: "perch", mode: "listening" },
      ];
      if (ev.residual.trim()) intents.push({ kind: "hear", text: ev.residual.trim() });
      return {
        next: { ...snap, state: "listening", generation, heard: ev.residual.trim() },
        intents,
      };
    }

    case "transcript": {
      if (snap.state !== "listening") return { next: snap, intents: [] };
      const text = ev.text.trim();
      if (!text || text === snap.heard) return { next: snap, intents: [] };
      return { next: { ...snap, heard: text }, intents: [{ kind: "hear", text }] };
    }

    case "endOfSpeech": {
      if (snap.state !== "listening") return { next: snap, intents: [] };
      return {
        next: { ...snap, state: "processing", heard: ev.transcript.trim() || snap.heard },
        intents: [{ kind: "setState", anchor: "center", mode: "processing" }],
      };
    }

    case "responseReady": {
      // THE LOSING INTERLEAVING. A dismissed or superseded conversation must not be repainted by
      // an answer that was already in flight.
      if (ev.generation !== snap.generation) return { next: snap, intents: [] };
      if (snap.state !== "processing") return { next: snap, intents: [] };
      return {
        next: { ...snap, state: "responding" },
        intents: [
          { kind: "setState", anchor: "center", mode: "speaking" },
          { kind: "reply", text: ev.replyText },
        ],
      };
    }

    case "responseDone": {
      if (snap.state !== "responding") return { next: snap, intents: [] };
      return goHome(snap);
    }

    case "dismiss": {
      if (snap.state === "idle") return { next: snap, intents: [] };
      // Bump the generation so anything still in flight for this conversation is stale on arrival.
      return goHome(snap, snap.generation + 1);
    }

    case "error": {
      // An error must land the overlay HOME, not leave it swirling forever on an await that
      // already failed. Same generation bump, for the same reason as dismiss.
      if (snap.state === "idle") return { next: snap, intents: [] };
      return goHome(snap, snap.generation + 1);
    }

    default: {
      const _exhaustive: never = ev;
      return { next: snap, intents: [] };
    }
  }
}
