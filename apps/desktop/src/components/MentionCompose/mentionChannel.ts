// THE TRANSPORT the compose panel talks to — the backend seam, made injectable.
//
// The pending state the founder must see lives in the GAP between two async facts, so the channel
// exposes them as two calls rather than one:
//
//   1. send()       — DELIVER his words to the agent's backend inbox. Resolves with an ack the
//                     moment the message is durably queued. This is fast.
//   2. awaitReply()  — the agent's answer, which arrives LATER (it has to run a turn). This is the
//                     slow half, and "pending" is exactly the window while it is unresolved.
//
// Injectable for two reasons the AGENTS.md "defaulted seam" rule (bead sparkle-lgbwf) makes concrete:
// the panel can be driven in jsdom with no Tauri host behind it, AND — because deliver and reply are
// separate promises — a test can hold the reply pending to assert the loading state, then resolve it
// to assert the arrived state. A single combined promise could not distinguish the two.
//
// ══ BACKEND DEPENDENCY — coded to the DOCUMENTED shape, flagged here (bead sparkle-hdlhox) ═══════════
// The Rust side (branch `sparkle/mention-channel-backend`, reusing `inbox.rs`) owns the commands.
// This file codes to the documented signature `mention_send(target_handle, thread_ref, body, from)`.
// Tauri lowercases a Rust `#[tauri::command]`'s snake_case params to camelCase over the wire — every
// other invoke in this app relies on that (`inbox_send` is called as `{ agentId, text, from }`, not
// `{ agent_id, ... }`) — so the args below are camelCase. If the backend lands a different name or
// shape, THIS is the one file to change; the panel and the parser never touch Tauri.
import { invoke } from "@tauri-apps/api/core";
import type { MentionHandle } from "./mentionHandles";

/** What `send` hands the backend. */
export interface MentionSendInput {
  /** Which reserved agent to deliver to. */
  target: MentionHandle;
  /** The founder's message, with the leading `@handle` already stripped. */
  body: string;
  /** The conversation this belongs to, so the agent's reply threads back to it. */
  threadRef: string;
  /** Who is pinging — for attribution on the far end. */
  from: string;
}

/** The backend's delivery ack — the id the reply will come back under. */
export interface MentionAck {
  messageId: string;
}

/** A pinged agent's answer. */
export interface MentionReply {
  body: string;
}

/**
 * The two-call transport. The panel depends on this INTERFACE, never on `invoke` directly, so the
 * production call site (`createMentionChannel`) and the test double are the same shape.
 */
export interface MentionChannel {
  send(input: MentionSendInput): Promise<MentionAck>;
  awaitReply(messageId: string): Promise<MentionReply>;
}

/**
 * The production channel — the ONE place this feature calls Tauri.
 *
 * Kept as a factory (not a module-level const) so a suite that mocks `@tauri-apps/api/core` gets the
 * mocked `invoke` when it constructs one, and so there is no import-time Tauri touch.
 */
export function createMentionChannel(): MentionChannel {
  return {
    async send({ target, body, threadRef, from }): Promise<MentionAck> {
      // `mention_send(target_handle, thread_ref, body, from) -> message_id`. camelCase args per the
      // header note. Returns the id the reply is keyed to.
      const messageId = await invoke<string>("mention_send", {
        targetHandle: target,
        threadRef,
        body,
        from,
      });
      return { messageId };
    },
    async awaitReply(messageId): Promise<MentionReply> {
      // `mention_reply(message_id) -> body`. The backend blocks until the agent's turn completes (or
      // posts the reply as a bead comment it reads back), so this is the promise that stays pending
      // while "…is thinking" shows. If the backend instead surfaces replies by polling an inbox, this
      // is where that poll lives — the panel is unaffected either way.
      const body = await invoke<string>("mention_reply", { messageId });
      return { body };
    },
  };
}
