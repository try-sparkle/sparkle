// Desktop side of the phone approvals remote (Path A: in-webview Socket.IO client).
//
// Connects to the orchestration relay as this user's Mac (role "host"), authenticated with
// the desktop bearer. When a local agent needs the user (approval/question), the app emits an
// `attention_needed`; the relay forwards it to the paired phone. When the phone answers, the
// relay sends a `decision` back here and we inject it into that agent's live PTY via writePty.
//
// Contracts match the DEPLOYED relay (verified end-to-end): register{clerk_token,role},
// registered ack, attention_needed, decision, attention_resolved.
import { io, type Socket } from "socket.io-client";
import { invoke } from "@tauri-apps/api/core";
import { onPtyOutput, writePty } from "../pty";
import {
  authorizeAgentInput,
  authorizeDecision,
  type AgentInputPayload,
  type DecisionPayload,
} from "./relayGate";

const RELAY_URL =
  (import.meta.env?.VITE_ORCHESTRATION_URL as string | undefined) ??
  "http://localhost:3001";

export interface SuggestedReply {
  label: string;
  value: string;
}
export interface AttentionPayload {
  attention_id: string;
  agent_id: string;
  agent_name: string;
  project_name: string;
  kind: "approval" | "question";
  question: string;
  risk_class?: "caution" | "dangerous";
  suggested_replies: SuggestedReply[];
  created_at: string;
}
export interface RosterAgentPayload {
  id: string;
  name: string;
  kind: "build" | "worker" | "think" | "shell";
  status: string;
  status_color: string;
  status_label: string;
  parent_id: string | null;
  workflow_stage?: string | null;
}
export interface RosterPayload {
  projects: Array<{ id: string; name: string; agents: RosterAgentPayload[] }>;
}

let socket: Socket | null = null;
let registered = false;
let connecting = false;
let lastRoster: RosterPayload | null = null;
// Agents a phone is currently watching (drill-in) — we stream only these agents' PTY output.
const watched = new Set<string>();
let ptyUnlisten: (() => void) | null = null;
// attention_id -> agent_id for attentions we actually raised. A decision may ONLY drive one of
// these (validated by its attention_id, which is per-attention), so a relay/phone can't inject
// keystrokes into an arbitrary PTY, and resolving an OLD attention can't drop authorization for
// a newer one on the same agent (the bug a per-agent set had).
const liveAttentions = new Map<string, string>();

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

  // The phone drilled into an agent — start/stop streaming that agent's terminal.
  socket.on("watch", (w: { agent_id?: string }) => {
    if (w && typeof w.agent_id === "string") watched.add(w.agent_id);
  });
  socket.on("unwatch", (w: { agent_id?: string }) => {
    if (w && typeof w.agent_id === "string") watched.delete(w.agent_id);
  });

  // Forward watched agents' live PTY output to the phone (one global subscription). Bind the
  // subscription to THIS socket instance so an unmount→remount can't strand the old listener.
  const mySocket = socket;
  void onPtyOutput((e) => {
    if (!registered || !watched.has(e.id)) return;
    mySocket.emit("agent_output", { agent_id: e.id, chunk: e.chunk });
  }).then((un) => {
    // If this run is no longer the active socket (teardown, or a remount installed a new one),
    // unlisten immediately so we don't leak a listener / double-emit.
    if (socket !== mySocket) un();
    else ptyUnlisten = un;
  });

  // The phone typed free text into a watched agent — authorize + inject (gate: relayGate).
  socket.on("agent_input", (i: AgentInputPayload) => {
    const w = authorizeAgentInput(watched, i);
    if (w) {
      void writePty(w.agentId, w.text).catch((e) =>
        console.debug("relay agent_input writePty failed", e),
      );
    }
  });

  // The phone answered an attention — authorize + inject into that agent's PTY (gate: relayGate).
  socket.on("decision", (d: DecisionPayload) => {
    const w = authorizeDecision(liveAttentions, d);
    if (w) {
      void writePty(w.agentId, w.text).catch((e) =>
        console.debug("relay decision writePty failed", e),
      );
    }
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

export function stopRelayHost(): void {
  socket?.close();
  socket = null;
  registered = false;
  connecting = false;
  liveAttentions.clear();
  watched.clear();
  ptyUnlisten?.();
  ptyUnlisten = null;
}
