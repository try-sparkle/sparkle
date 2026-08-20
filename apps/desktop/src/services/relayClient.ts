// Desktop side of the phone approvals remote (Path A: in-webview Socket.IO client).
//
// Connects to the orchestration relay as this user's Mac (role "host"), authenticated with
// the desktop bearer. When a local agent needs the user (approval/question), the app emits an
// `attention_needed`; the relay forwards it to the paired phone. When the phone answers, the
// relay sends a `decision` back here and we inject it into that agent's live PTY via
// writePtyChained (chained, not raw: a relayed keystroke carries its own CR and must not land
// inside another operation's paste→CR window — see pty.writePtyChained, roborev 54375).
//
// Contracts match the DEPLOYED relay (verified end-to-end): register{clerk_token,role},
// registered ack, attention_needed, decision, attention_resolved.
// socket.io-client (with its engine.io transport) is a heavy dep pulled in ONLY when a signed-in
// host actually opens the relay. Import the type eagerly (erased at build, zero runtime cost) but
// load the `io` runtime lazily inside startRelayHost so it never lands in the initial boot chunk —
// an unauthenticated first-run user never downloads or parses it.
import type { Socket } from "socket.io-client";
import type { RelaySocketLike } from "./agentTransport";
import type { RollupDot } from "../engine/workerRollup";
import { invoke } from "@tauri-apps/api/core";
import { onPtyOutput, writePtyChained } from "../pty";
import { getAgentScrollback } from "./terminalScrollback";
import { closeBuildAgent } from "./closeBuildAgent";
import { requestRetirementConfirm } from "./retirementConfirmRequest";
import { parseControlAction, CLOSE_AGENT_ACTION } from "./suggestions/controlButtons";
import { safeUnlisten } from "./safeUnlisten";
import {
  authorizeAgentInput,
  authorizeDecision,
  resolveSuggestionClick,
  frameRemoteSubmission,
  type FramedPtyText,
  type AgentInputPayload,
  type DecisionPayload,
  type SuggestionClickPayload,
} from "./relayGate";

const RELAY_URL =
  (import.meta.env?.VITE_ORCHESTRATION_URL as string | undefined) ??
  "http://localhost:3001";

export interface SuggestedReply {
  label: string;
  value: string;
}
export interface SuggestionButtonWire {
  id: string;
  label: string;
  value: string;
}
export interface Suggestions {
  agent_id: string;
  buttons: SuggestionButtonWire[];
}
export interface AttentionPayload {
  attention_id: string;
  agent_id: string;
  agent_name: string;
  project_name: string;
  kind: "approval" | "question";
  question: string;
  /** The exact Claude Code terminal text that triggered the attention (screen snapshot or recent
   *  scrollback tail), truncated. Rendered verbatim in monospace on the phone. Optional so older
   *  desktop builds that omit it still relay; no relay/backend schema change — just an extra field. */
  detail?: string;
  risk_class?: "caution" | "dangerous";
  suggested_replies: SuggestedReply[];
  created_at: string;
}
/** A recent user prompt for the tray breadcrumb: the promptHistory entry id (so a click can scroll
 *  the terminal to that exact turn) + a short, whitespace-collapsed slice of its text. */
export interface RecentPromptWire {
  id: string;
  text: string;
}
export interface RosterAgentPayload {
  id: string;
  name: string;
  kind: "build" | "worker" | "shell";
  status: string;
  status_color: string;
  status_label: string;
  /** The row's disc once the workers folded under it are taken into account — engine/workerRollup's
   *  `RollupDot` ("green" | "red" | "orange" | "gray"). DISTINCT from `status`, which stays the
   *  agent's own PTY state: an orchestrator idling while nine workers run is `status: "idle"` with
   *  `rollup_dot: "green"`. Childless and worker rows carry their own tier here.
   *
   *  `| null` to match the Rust `Option<String>` this mirrors, which has no `skip_serializing_if`
   *  and therefore emits an explicit `null` for a slice published by an older window
   *  (roborev 54742) — see the same note in services/rosterTypes.ts. */
  rollup_dot?: RollupDot | null;
  /** `engine/agentGoal`'s `GoalState`. DO NOT RE-ENUMERATE IT HERE — see the warning below.
   *
   *  Published for the RUST NUDGER, which has no other way to reach it: goals live in this store,
   *  and `nudge_ladder` needs to know a goal leaves it NOTHING TO ASK so it stops spending a full
   *  agent turn telling a finished agent to "resume your goal".
   *
   *  ⚠️ THIS COMMENT USED TO ENUMERATE THE UNION AND TO SAY "only the exact met reads as done".
   *  Both went stale and the second became FACTUALLY WRONG: `discharged` and `awaiting_close` are
   *  finished too, and the Rust side treats all three as quiet. Nothing executes a doc comment, so
   *  neither claim could red anything — which is how it survived two state additions.
   *
   *  The authority is `engine/agentGoal.ts::GoalState`; the classification is
   *  `nudger::goal_is_quiet`, pinned by `nudger::goal_state_vocabulary_matches_the_frontend`.
   *
   *  A missing field, an explicit null, or a state the reader does not recognise is treated as a
   *  LIVE goal and keeps the ladder running — the safe direction, since a false "finished" silences
   *  an agent that still needs help.
   *
   *  `| null` for the same reason as `rollup_dot` above: it mirrors a Rust `Option<String>` with no
   *  `skip_serializing_if`, so an older window emits an explicit `null`. */
  goal_state?: string | null;
  parent_id: string | null;
  workflow_stage?: string | null;
  last_activity_at?: number | null; // epoch ms of the user's last touch; drives the elapsed timer
  recent_prompts?: RecentPromptWire[]; // most recent (~4) user prompts, oldest→newest; tray breadcrumb
}
export interface RosterPayload {
  projects: Array<{ id: string; name: string; agents: RosterAgentPayload[] }>;
}

let socket: Socket | null = null;
let registered = false;

/** The live relay socket, or null when the host connection isn't up. Exposed so CloudTransport
 *  (services/agentTransport.ts) can attach to a cloud agent's server-served stream over the SAME
 *  socket this host already maintains — cloud sessions ride the existing relay, not a second one.
 *  Socket.IO's emit/on/off match RelaySocketLike structurally; the cast erases the heavy overloads.
 *  The type is shared (type-only import, no runtime cycle) so the two sites can't drift. */
export function getRelaySocket(): RelaySocketLike | null {
  return socket as unknown as RelaySocketLike | null;
}
let connecting = false;
let lastRoster: RosterPayload | null = null;
// Agents a phone is currently watching (drill-in) — we stream only these agents' PTY output.
const watched = new Set<string>();
// One PTY subscription PER watched agent, keyed by agent id. Output is emitted on a per-agent
// channel now (see pty.ts onPtyOutput), so a single global listener is no longer possible — and no
// longer desirable: this way an un-watched agent's chunks are never dispatched to the relay at all,
// instead of being delivered and immediately filtered out.
const ptyUnlistens = new Map<string, () => void>();
/** Per-agent subscribe generation. Bumped on every `watch` claim so an in-flight subscribe can tell
 *  whether the slot it is about to fill is still the one it claimed (see the `watch` handler). */
const ptyWatchGen = new Map<string, number>();

/** What an in-flight `onPtyOutput` subscribe should do once it resolves.
 *
 *  Extracted as a pure decision so the watch→unwatch→watch race is testable without a live socket:
 *  the bug it guards is a millisecond-wide interleaving that no integration test can reliably hit.
 *
 *  - `adopt` — still ours; store the unlisten in the slot.
 *  - `discard` — someone else owns the slot now; unlisten, and DO NOT touch the slot (clearing it
 *    would strand the listener the newer attempt is about to install).
 *  - `discard-and-clear` — still our generation but the subscription is dead (socket swapped, or
 *    the phone unwatched); unlisten and clear our own stale claim. */
export function subscriptionFate(args: {
  socketIsCurrent: boolean;
  myGen: number;
  currentGen: number | undefined;
  slotOccupied: boolean;
}): "adopt" | "discard" | "discard-and-clear" {
  const stillOurs = args.currentGen === args.myGen;
  if (!stillOurs) return "discard";
  if (!args.socketIsCurrent || !args.slotOccupied) return "discard-and-clear";
  return "adopt";
}
// attention_id -> agent_id for attentions we actually raised. A decision may ONLY drive one of
// these (validated by its attention_id, which is per-attention), so a relay/phone can't inject
// keystrokes into an arbitrary PTY, and resolving an OLD attention can't drop authorization for
// a newer one on the same agent (the bug a per-agent set had).
const liveAttentions = new Map<string, string>();
// agentId -> (buttonId -> value) for suggestion buttons we pushed to the phone. A suggestion_click
// is resolved back to its value here, so the phone can only trigger a button the desktop actually
// offered for an agent the phone is watching (never inject arbitrary text).
const suggestionsByAgent = new Map<string, Map<string, string>>();
/** Resolve a phone-clicked button id back to the value the desktop pushed. Exported for tests. */
export function lookupSuggestionValue(agentId: string, buttonId: string): string | null {
  return suggestionsByAgent.get(agentId)?.get(buttonId) ?? null;
}

/**
 * THE ONE PTY WRITE IN THIS FILE. Every remote path funnels through it, and it accepts only
 * {@link FramedPtyText} — a type a plain `string` cannot satisfy — so a handler added later cannot
 * hand a raw socket payload to a PTY without `tsc` rejecting it. That is the whole point: the
 * stripping and bracketed-paste framing in `relayGate` were a convention until this signature made
 * skipping them a compile error (see relayGate's `FramedPtyText`).
 *
 * Chained, not raw: a relayed payload carries its own CR and must not land inside another
 * operation's paste→CR window (pty.writePtyChained, roborev 54375). Fire-and-forget with a debug
 * log — nothing here is claiming delivery to the phone, and PTY teardown is an expected race.
 */
function writeFramedToPty(agentId: string, text: FramedPtyText, what: string): void {
  void writePtyChained(agentId, text).catch((e) =>
    console.debug(`relay ${what} writePty failed`, e),
  );
}

/** Start (idempotent) the relay host connection. No-op if not signed in. */
export async function startRelayHost(): Promise<void> {
  if (socket || connecting) return; // serialize across the async gap (StrictMode double-mount)
  connecting = true;
  const token = await invoke<string | null>("desktop_bearer_token").catch(() => null);
  if (!token) {
    connecting = false;
    return; // not signed in — nothing to relay
  }
  if (socket) {
    connecting = false;
    return; // a concurrent call won the race
  }

  // Lazy-load the socket.io client only now (signed in + connecting). `connecting` stays true
  // across this await, so the serialize-guard above still bails concurrent callers.
  let io: typeof import("socket.io-client").io;
  try {
    ({ io } = await import("socket.io-client"));
  } catch (e) {
    connecting = false; // failed to load the client — leave the host closed, don't wedge start
    console.warn("relay: failed to load socket.io-client", e);
    return;
  }

  try {
    socket = io(RELAY_URL, { transports: ["websocket"] });
  } finally {
    connecting = false; // never wedge the start path if io() throws synchronously
  }

  socket.on("connect", () => {
    registered = false;
    socket?.emit("register", { clerk_token: token, role: "host" });
  });
  socket.on("registered", () => {
    registered = true;
    // Re-send the latest roster so a (re)connected phone has the dashboard immediately.
    if (lastRoster) socket?.emit("roster", lastRoster);
  });
  socket.on("disconnect", () => {
    registered = false;
  });

  // The phone drilled into an agent — start streaming that agent's terminal, and immediately send
  // a snapshot of its existing history so the phone shows where the agent IS, not just new bytes.
  // Bind subscriptions to THIS socket instance so an unmount→remount can't strand an old listener.
  const mySocket = socket;
  socket.on("watch", (w: { agent_id?: string }) => {
    if (!w || typeof w.agent_id !== "string") return;
    const agentId = w.agent_id;
    watched.add(agentId);
    const history = getAgentScrollback(agentId);
    if (history && registered) socket?.emit("agent_output", { agent_id: agentId, chunk: history });
    // Start forwarding this agent's live PTY output. Guard against a duplicate `watch` for the same
    // agent stranding a second listener (which would double-emit every chunk to the phone).
    if (ptyUnlistens.has(agentId)) return;
    // Claim the slot before the await so a re-entrant watch can't race — and stamp the claim with a
    // generation, because occupancy ALONE is ambiguous. `onPtyOutput` awaits a real IPC round-trip,
    // and a watch→unwatch→watch cycle can complete inside that window: the second watch finds the
    // slot free, installs its own placeholder, and now the first attempt's `has(agentId)` is true
    // again — but for someone else's claim. It would then store its listener over the newer one,
    // leaving BOTH live with only the newer tracked, leaking the older and double-emitting every
    // chunk to the phone. The generation distinguishes "my placeholder" from "a newer placeholder".
    const gen = (ptyWatchGen.get(agentId) ?? 0) + 1;
    ptyWatchGen.set(agentId, gen);
    ptyUnlistens.set(agentId, () => {});
    void onPtyOutput(agentId, (e) => {
      if (!registered || !watched.has(agentId)) return;
      mySocket.emit("agent_output", { agent_id: agentId, chunk: e.chunk });
    }).then((un) => {
      // Adopt `un` only if this attempt still owns the slot. safeUnlisten swallows the Tauri
      // teardown race if the listeners map is already gone.
      const fate = subscriptionFate({
        socketIsCurrent: socket === mySocket,
        myGen: gen,
        currentGen: ptyWatchGen.get(agentId),
        slotOccupied: ptyUnlistens.has(agentId),
      });
      if (fate === "adopt") {
        ptyUnlistens.set(agentId, un);
      } else {
        if (fate === "discard-and-clear") ptyUnlistens.delete(agentId);
        void safeUnlisten(un);
      }
    });
  });
  socket.on("unwatch", (w: { agent_id?: string }) => {
    if (!w || typeof w.agent_id !== "string") return;
    watched.delete(w.agent_id);
    const un = ptyUnlistens.get(w.agent_id);
    ptyUnlistens.delete(w.agent_id);
    void safeUnlisten(un ?? null);
  });

  // The phone typed free text into a watched agent — authorize + inject (gate: relayGate).
  socket.on("agent_input", (i: AgentInputPayload) => {
    const w = authorizeAgentInput(watched, i);
    if (w) writeFramedToPty(w.agentId, w.text, "agent_input");
  });

  // The phone tapped a suggestion button — resolve it back to the exact value WE pushed for that
  // (watched) agent and inject it (gate: relayGate). The phone never sends raw text on this path.
  // Like the agent_input / decision phone paths, this intentionally bypasses the desktop trial
  // meter: phone input is direct PTY injection, not a composer "send" (the trial cap is a
  // desktop-composer concept). A trial-gated remote would be a separate, deliberate policy.
  socket.on("suggestion_click", (c: SuggestionClickPayload) => {
    // ONE gate for both paths (resolveSuggestionClick: watched agent + desktop-pushed button id).
    // A "control:" value is an app action (e.g. close the build agent), not a PTY write — branch on
    // the resolved raw value. The phone can only reach this for a watched agent where the desktop
    // actually offered the control button (i.e. a shipped agent), so it can't close an arbitrary one.
    const r = resolveSuggestionClick(watched, c, lookupSuggestionValue);
    if (!r) return;
    if (parseControlAction(r.value) === CLOSE_AGENT_ACTION) {
      // `false` — a tap on the PHONE cannot be the confirmation the retirement gate wants (bead
      // sparkle-0l9xk). Not because the person holding it is not the founder, but because the gate
      // is a confirm on WHAT THE AGENT REPORTED, and the retirement dialog — the thing that shows
      // him the retro before the row goes — exists only on the desktop. A remote yes to a question
      // that was never displayed is not consent.
      //
      // So the refusal raises the dialog on the DESKTOP and the phone tap stops there. He walks
      // over, reads it, and confirms; nothing is torn down in the meantime.
      void closeBuildAgent(r.agentId, false)
        .then((closed) => {
          if (closed.ok) return;
          // The desktop dialog is the only place this confirm can be shown, so if no surface holds
          // the agent the tap ends here. Logged rather than dropped (roborev 59153): a phone tap
          // that closes nothing, opens nothing and leaves no trace is indistinguishable from the
          // relay being down, and this is the one path with no channel back to the phone.
          if (!requestRetirementConfirm(r.agentId)) {
            console.debug(
              "relay suggestion_click: landed agent needs a human confirm, and no open column can show it",
              r.agentId,
            );
          }
        })
        .catch((e) => console.debug("relay suggestion_click closeAgent failed", e));
      return;
    }
    // Framed BY SHAPE (roborev 60573 High, then 60642). Most suggestion values are picker
    // keystrokes — `"y\n"`, `"n\n"`, `"2\n"` answering a live raw-mode Ink dialog — and wrapping one
    // in a bracketed paste is forbidden in three other places at once (conciergeDispatch's header
    // rules, frameCloudSubmit refusing while a picker is live,
    // dictationTerminalRoute.WRITE_BLOCKING_PROMPTS). But NOT all of them are: `pushSuggestions`
    // also stores `kind: "prompt"` free text, so unconditional keystroke framing deleted interior
    // newlines and mangled a multi-line prompt into one run-on line.
    //
    // The bug it caused: a phone tap on "Approve" sent `ESC[200~y ESC[201~\r` while the SAME button
    // clicked on the desktop sent `y\r`. Against a permission dialog whose select component does
    // not consume paste markers, that leading ESC reads as Escape and cancels the prompt. The
    // keystroke framer still strips markers and scrubs control bytes — it just does not paste-wrap,
    // so the phone and the desktop send identical bytes for the same button.
    writeFramedToPty(r.agentId, frameRemoteSubmission(r.value), "suggestion_click");
  });

  // The phone answered an attention — authorize + inject into that agent's PTY (gate: relayGate).
  socket.on("decision", (d: DecisionPayload) => {
    const w = authorizeDecision(liveAttentions, d);
    if (w) writeFramedToPty(w.agentId, w.text, "decision");
  });
}

/** Forward a "the agent needs you" event to the paired phone(s). Safe to call before connect. */
export function emitAttention(payload: AttentionPayload): void {
  // Authorize a future decision for THIS attention even if we can't emit right now (the phone
  // may still surface it via the relay's replay cache on reopen, then send a decision).
  liveAttentions.set(payload.attention_id, payload.agent_id);
  if (!socket || !registered) return;
  socket.emit("attention_needed", payload);
}

/** Tell the phone an attention was handled locally (so it clears). */
export function emitResolved(attentionId: string): void {
  liveAttentions.delete(attentionId); // per-attention: never affects a newer one on the same agent
  if (!socket || !registered) return;
  socket.emit("attention_resolved", { attention_id: attentionId });
}

/** Push the current agent roster (projects → agents → status) to the phone(s). */
export function pushRoster(roster: RosterPayload): void {
  lastRoster = roster;
  if (!socket || !registered) return;
  socket.emit("roster", roster);
}

/**
 * Push the current suggestion buttons for an agent to the phone(s), and remember the id→value map
 * so a later suggestion_click can be resolved + authorized. Safe to call before connect (the phone
 * just won't see it until the next push after connect).
 */
export function pushSuggestions(payload: Suggestions): void {
  // An empty set RETIRES the agent's buttons: drop the id→value map so a phone can no longer
  // resolve (and inject) a button the desktop has stopped showing, and tell the phone to clear its
  // row. Callers push an empty set whenever suggestions are locally cleared/hidden.
  if (payload.buttons.length === 0) {
    suggestionsByAgent.delete(payload.agent_id);
  } else {
    const map = new Map<string, string>();
    for (const b of payload.buttons) map.set(b.id, b.value);
    suggestionsByAgent.set(payload.agent_id, map);
  }
  if (!socket || !registered) return;
  socket.emit("suggestions", payload);
}

export function stopRelayHost(): void {
  socket?.close();
  socket = null;
  registered = false;
  connecting = false;
  liveAttentions.clear();
  suggestionsByAgent.clear();
  watched.clear();
  for (const un of ptyUnlistens.values()) void safeUnlisten(un);
  ptyUnlistens.clear();
  // Bump every generation rather than clearing: a subscribe still in flight will resolve AFTER this
  // teardown, and it must not find its own generation intact and re-populate the map we just
  // emptied. Clearing would reset the counter to 0 and let exactly that happen.
  for (const [id, g] of ptyWatchGen) ptyWatchGen.set(id, g + 1);
}
