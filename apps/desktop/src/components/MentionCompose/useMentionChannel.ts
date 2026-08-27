// THE CONVERSATION STATE for the compose-window ping feature — one turn per message the founder sends.
//
// A turn is born PENDING the instant he presses Send (so his words appear immediately, and a loading
// state shows — never a false "no response" blank), moves to ARRIVED when the agent's reply resolves,
// or to ERROR if delivery/reply fails. That three-state life is the whole point: the accounts-modal
// flicker bug (a blank "empty" state shown while data was in flight) is what a single boolean would
// reproduce here, so PENDING is its own state and is never rendered as "nothing came back".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isResolved,
  isUnknownHandle,
  parseMention,
  type MentionTarget,
} from "./mentionHandles";
import { createMentionChannel, type MentionChannel } from "./mentionChannel";

/** Where a turn is in its life. */
export type TurnStatus = "pending" | "arrived" | "error";

export interface MentionTurn {
  /** Stable id for the list key and for the async resolve to find its own row. */
  id: string;
  /** Which agent was pinged — carried so the row can show WHICH one, independent of the input. */
  target: MentionTarget;
  /** Exactly what was sent (handle already stripped). */
  body: string;
  status: TurnStatus;
  /** The agent's answer, present once `status === "arrived"`. */
  reply?: string;
  /** A human-readable failure, present once `status === "error"`. */
  error?: string;
}

/** Why a send did not go out — surfaced inline so the box can hint rather than silently swallow. */
export type SendRejection = "empty" | "no-handle" | "unknown-handle";

export type SendOutcome =
  | { ok: true; turnId: string }
  | { ok: false; reason: SendRejection; token?: string };

export interface UseMentionChannelOptions {
  /** The transport. Defaults to the real Tauri channel; tests inject a double. */
  channel?: MentionChannel;
  /** The conversation id passed to the backend so replies thread back. */
  threadRef?: string;
  /** Who is pinging. */
  from?: string;
  /**
   * How long to wait for a reply before giving up and settling the turn to ERROR.
   *
   * The whole point of the three-state lifecycle is that the founder can tell a slow agent from a
   * dead one — but "pending forever" defeats it from the other side: a dropped connection or a
   * backend that never posts would leave "…is thinking…" on screen indefinitely. A bound converts
   * that into a legible "no reply after Nm" he can act on. Generous by default (agent turns take
   * minutes); `0` disables the bound (used by tests that resolve the reply themselves).
   */
  replyTimeoutMs?: number;
}

/** The default reply bound — 2 minutes. Long enough for a real agent turn, short enough that a dead
 *  channel does not hang the row forever. */
export const DEFAULT_REPLY_TIMEOUT_MS = 120_000;

/** A never-resolving reply that instead REJECTS after `ms`, so `Promise.race` settles the turn to a
 *  legible timeout. Returns a `cancel` so a reply that DOES arrive clears the pending timer rather
 *  than leaking it (and never fires a spurious late rejection). */
function replyDeadline(ms: number): { race: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const race = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`No reply after ${Math.round(ms / 1000)}s — try again.`)), ms);
  });
  return { race, cancel: () => timer !== undefined && clearTimeout(timer) };
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `mention-turn-${seq}`;
}

/**
 * Drive the ping channel: a list of turns plus a `send`.
 *
 * `send` is where the routing lives, and it is deliberately the ONLY place `parseMention`'s target
 * reaches the channel: `channel.send({ target: parsed.target.handle, ... })`. A test that sends
 * "@improve …" and asserts the channel saw `target: "improve"` is asserting THAT line; mutating the
 * parse to drop or mis-map the handle makes it fail, which is what proves the routing is real.
 */
export function useMentionChannel(opts?: UseMentionChannelOptions): {
  turns: readonly MentionTurn[];
  send: (text: string) => SendOutcome;
} {
  const { threadRef = "compose-window", from = "founder", replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS } =
    opts ?? {};
  // Construct the real channel once; a caller's injected channel always wins.
  const channel = useMemo(() => opts?.channel ?? createMentionChannel(), [opts?.channel]);
  const [turns, setTurns] = useState<readonly MentionTurn[]>([]);

  // The latest channel/threadRef/from, read at call time so `send`'s identity is stable and a resolve
  // that lands after a prop change still writes to the right row.
  const ref = useRef({ channel, threadRef, from, replyTimeoutMs });
  ref.current = { channel, threadRef, from, replyTimeoutMs };

  // Guard state writes after unmount — the send flow is a detached async task, so a reply that lands
  // after the panel is gone would otherwise setState on an unmounted component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const settle = useCallback((id: string, patch: Partial<MentionTurn>) => {
    if (!mountedRef.current) return;
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const send = useCallback(
    (text: string): SendOutcome => {
      const parsed = parseMention(text);
      if (parsed === null) return { ok: false, reason: "no-handle" };
      if (isUnknownHandle(parsed)) return { ok: false, reason: "unknown-handle", token: parsed.token };
      if (!isResolved(parsed) || parsed.body.length === 0) return { ok: false, reason: "empty" };

      const id = nextId();
      const target = parsed.target;
      const body = parsed.body;
      setTurns((ts) => [...ts, { id, target, body, status: "pending" }]);

      const { channel: ch, threadRef: thread, from: sender, replyTimeoutMs: timeout } = ref.current;
      // Fire-and-forget: the row is already on screen as pending, and the resolve writes back by id.
      void (async () => {
        try {
          const ack = await ch.send({ target: target.handle, body, threadRef: thread, from: sender });
          // Race the reply against a bound so a dead channel settles to a legible error instead of a
          // permanent "…is thinking…". `0` means no bound (a test drives the reply itself).
          const reply =
            timeout > 0
              ? await (async () => {
                  const deadline = replyDeadline(timeout);
                  try {
                    return await Promise.race([ch.awaitReply(ack.messageId), deadline.race]);
                  } finally {
                    deadline.cancel();
                  }
                })()
              : await ch.awaitReply(ack.messageId);
          settle(id, { status: "arrived", reply: reply.body });
        } catch (e) {
          settle(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
        }
      })();

      return { ok: true, turnId: id };
    },
    [settle],
  );

  return { turns, send };
}
