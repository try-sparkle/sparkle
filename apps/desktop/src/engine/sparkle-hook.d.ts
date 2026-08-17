// Type surface for the shipped emitter script (a plain .mjs with no companion .d.ts).
// The pure helpers are imported by tests; the runtime entrypoint has no exports.
//
// These are DECLARED rather than suppressed at the import site with `@ts-expect-error`. That
// directive only covers the line after it, so it silenced a single-line import and stopped
// covering anything the moment the import wrapped onto several lines — which reported every named
// member as missing AND the directive itself as unused. Declaring the surface also gives the tests
// real types: without them `draftDelivery` returned `any`, so every `.split(…).filter((l) => …)`
// downstream tripped `noImplicitAny` on its own callback parameter.
declare module "*/sparkle-hook.mjs" {
  /** One queued inbox record, as `pendingMessages` yields it. */
  export interface InboxMessage {
    id: string;
    text: string;
    ts?: number;
    from?: string;
    severity?: string;
    [key: string]: unknown;
  }

  /** Derives the inbox/ack/claim paths from the hook's own log path. */
  export function inboxPaths(logPath: string): {
    agentId: string;
    messages: string;
    acks: string;
    claims: string;
  };

  /** Parses a JSONL inbox, dropping malformed, expired, and already-claimed records. */
  export function pendingMessages(
    raw: string,
    now: number,
    isClaimed: (id: string) => boolean,
  ): InboxMessage[];

  /** True when `text` needs no rewrite to be safe to inject. */
  export function isDeliverySafe(text: string): boolean;

  /** Strips bidi/zero-width characters and enforces the continuation indent. */
  export function sanitizeText(text: string): string;

  /** Sanitizes on the way out if it was not sanitized on the way in. */
  export function ensureDeliverySafe(m: InboxMessage): InboxMessage;

  /** May THIS `claude` process drain `agentId`'s inbox? True only when the spawn-time
   *  `SPARKLE_INBOX_AGENT` env var is present and strictly equals `agentId`. */
  export function mayDrain(
    env: Record<string, string | undefined> | undefined,
    agentId: string,
  ): boolean;

  /** The text injected back into the agent at its turn boundary. */
  export function draftDelivery(
    messages: InboxMessage[],
    acksPath: string,
    now: number,
  ): string;

  export function normalize(
    payload: unknown,
    ts: number,
  ): {
    ts: number;
    event: string;
    tool?: string;
    message?: string;
    session_id?: string;
    prompt?: string;
    transcript_path?: string;
    /** SessionStart's `startup|resume|clear|compact` — see HookEvent.source. */
    source?: string;
  };
}
