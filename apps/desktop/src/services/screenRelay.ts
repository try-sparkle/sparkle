// Reading an agent's screen from a window that does NOT host its pane (bead sparkle-eou3y0.3).
//
// ══ THE DEFECT ═══════════════════════════════════════════════════════════════════════════════════
// `getAgentScrollback` / `getAgentViewport` are WINDOW-LOCAL registries: they are filled by a
// mounted `components/Terminal` in the same webview. The PTY host is APP-global — `pty_write` from
// any webview reaches any agent id — so the concierge could always PRESS a key on an agent whose pane
// lives in a torn-off satellite window. What it could not do was SEE that agent's screen, so
// `read_picker_options` came back `blind: "pane-not-mounted"` and `select_picker_option` had nothing
// to match a fingerprint against. Measured in the field: four queued permission prompts in one
// sweep, all four unreachable for exactly this reason, so the "Needs you" queue grew faster than the
// concierge could drain it no matter how attentive it was.
//
// ══ THE REMEDY: ASK THE WINDOW THAT CAN SEE IT ═══════════════════════════════════════════════════
// Every window runs a RESPONDER (`startScreenRelayResponder`). A window that wants a screen it does
// not host broadcasts a request; the one window whose own mounted pane registered that agent answers
// with ONE snapshot — scrollback and viewport read in the same breath. The requester installs that
// snapshot as a short-lived provider in the two registries, runs the UNCHANGED read/select code
// against it, and removes it again. So:
//
//   • No recogniser, parser, fingerprint or refusal is re-implemented or relaxed here. The press
//     still goes through `selectPickerOption` → the authority-gated send → every dispatcher guard,
//     including the destructive-command refusal policy. This module only supplies EVIDENCE.
//   • Nothing answers → the registries stay empty → the existing code refuses honestly with
//     `pane-not-mounted`, exactly as before. Blind is still a refusal, never an empty screen.
//   • The wait is BOUNDED (`SCREEN_RELAY_TIMEOUT_MS`). A dead or slow window costs a few hundred ms
//     and an honest refusal, never a hang.
//
// ══ WHAT A SNAPSHOT IS, AND IS NOT ═══════════════════════════════════════════════════════════════
// It is a reading of the hosting window's live xterm taken at the moment of the request — the same
// bytes `getAgentScrollback` would have returned there. It is installed ONLY for the duration of one
// op, so it can never become a cached screen that some later write decides on. `select_picker_option`
// fetches its OWN snapshot rather than reusing the read's, so the fingerprint it compares against is
// a fresh reading and a menu that moved on between read and press still refuses as `changed`.
//
// A responder answers ONLY from a pane it really hosts, never from a snapshot this module installed
// (`installedHere`), so two windows can never bounce a stale reading back and forth between them.
import { emit as tauriEmit, listen as tauriListen } from "@tauri-apps/api/event";
import { getAgentScrollback, registerScrollback } from "./terminalScrollback";
import { getAgentViewport, registerViewport, type TerminalViewport } from "./terminalViewport";

export const SCREEN_RELAY_REQUEST_EVENT = "screen-relay:request";
export const SCREEN_RELAY_RESPONSE_EVENT = "screen-relay:response";

/** How long a requester waits for the hosting window to answer. Cross-webview event delivery is a
 *  few ms on an idle machine; this is the ceiling under load, kept well inside one concierge turn. */
export const SCREEN_RELAY_TIMEOUT_MS = 750;

/** One atomic reading of an agent's terminal, as the hosting window saw it. */
export interface ScreenSnapshot {
  scrollback: string;
  /** Null when the host had no viewport provider — the write guards then refuse, as they would locally. */
  viewport: TerminalViewport | null;
}

interface RequestPayload {
  requestId: string;
  agentId: string;
}

interface ResponsePayload extends RequestPayload {
  snapshot: ScreenSnapshot;
}

type Unlisten = () => void;

/** The event bus, injectable so a test can stand two "windows" up in one realm. */
export interface ScreenRelayBus {
  emit: (event: string, payload: unknown) => Promise<void>;
  listen: <T>(event: string, cb: (payload: T) => void) => Promise<Unlisten>;
}

const tauriBus: ScreenRelayBus = {
  emit: (event, payload) => tauriEmit(event, payload),
  listen: (event, cb) => tauriListen(event, (e) => cb(e.payload as never)),
};

/** Agents whose registry entry in THIS window is a relayed snapshot, not a mounted pane. */
const installedHere = new Map<string, number>();

/** What THIS window can see of an agent from a pane it really hosts, or null. */
export function localScreen(agentId: string): ScreenSnapshot | null {
  if (installedHere.has(agentId)) return null;
  const scrollback = getAgentScrollback(agentId);
  if (scrollback === null) return null;
  return { scrollback, viewport: getAgentViewport(agentId) };
}

/**
 * Answer other windows' screen requests for the panes this window hosts. Returns a stop fn.
 * `see` is injectable for tests that simulate a second window; production uses {@link localScreen}.
 */
export function startScreenRelayResponder(
  opts: { bus?: ScreenRelayBus; see?: (agentId: string) => ScreenSnapshot | null } = {},
): () => void {
  const bus = opts.bus ?? tauriBus;
  const see = opts.see ?? localScreen;
  let stopped = false;
  let off: Unlisten | null = null;
  // Deferred through a resolved promise so a bus that throws SYNCHRONOUSLY (no Tauri, a test's
  // partial mock) lands in the same .catch as one that rejects, rather than crashing the mount.
  void Promise.resolve()
    .then(() => bus.listen<RequestPayload>(SCREEN_RELAY_REQUEST_EVENT, (req) => {
      if (stopped || !req || typeof req.agentId !== "string") return;
      let snapshot: ScreenSnapshot | null = null;
      try {
        snapshot = see(req.agentId);
      } catch {
        snapshot = null; // a broken read is never reported as a screen
      }
      if (!snapshot) return; // not ours — the window that hosts it answers, or nobody does
      void bus
        .emit(SCREEN_RELAY_RESPONSE_EVENT, { ...req, snapshot } satisfies ResponsePayload)
        .catch(() => {});
    }))
    .then((u) => {
      if (stopped) u();
      else off = u;
    })
    .catch(() => {});
  return () => {
    stopped = true;
    off?.();
  };
}

let seq = 0;
const newRequestId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Ask the other windows for one snapshot of `agentId`'s screen. Null when nobody answered in time. */
export async function requestRemoteScreen(
  agentId: string,
  opts: { bus?: ScreenRelayBus; timeoutMs?: number } = {},
): Promise<ScreenSnapshot | null> {
  const bus = opts.bus ?? tauriBus;
  const timeoutMs = opts.timeoutMs ?? SCREEN_RELAY_TIMEOUT_MS;
  const requestId = newRequestId();
  let off: Unlisten | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ScreenSnapshot | null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      Promise.resolve()
        .then(() => bus.listen<ResponsePayload>(SCREEN_RELAY_RESPONSE_EVENT, (res) => {
          if (!res || res.requestId !== requestId || res.agentId !== agentId) return;
          const s = res.snapshot;
          if (!s || typeof s.scrollback !== "string") return;
          resolve({ scrollback: s.scrollback, viewport: s.viewport ?? null });
        }))
        .then((u) => {
          // The listen handle can arrive AFTER a timeout already settled this request; drop it on
          // the spot rather than leak a listener for the life of the webview.
          if (settled) {
            u();
            return;
          }
          off = u;
          // Subscribed BEFORE asking, so a fast answer cannot arrive ahead of the listener.
          return bus.emit(SCREEN_RELAY_REQUEST_EVENT, { requestId, agentId } satisfies RequestPayload);
        })
        .catch(() => resolve(null));
    });
  } finally {
    settled = true;
    clearTimeout(timer);
    (off as Unlisten | null)?.();
  }
}

/**
 * Run `fn` with `agentId`'s screen readable through the ordinary registries — from this window's own
 * pane when it has one, otherwise from a snapshot the hosting window relays. When nothing can see
 * the agent, `fn` runs against empty registries and refuses exactly as it always did.
 */
export async function withAgentScreen<T>(
  agentId: string,
  fn: () => T | Promise<T>,
  opts: { bus?: ScreenRelayBus; timeoutMs?: number } = {},
): Promise<T> {
  // A pane THIS window hosts is the live reading. A snapshot another op installed is NOT — each op
  // fetches its own, so a press never decides on the screen an earlier read saw. (Overlapping ops
  // can unregister each other's snapshot; the loser then reads blind and refuses — the safe side.)
  if (localScreen(agentId) !== null) return fn();
  const snapshot = await requestRemoteScreen(agentId, opts);
  // Re-check: a pane may have mounted HERE while we waited, and its live reading beats any relay.
  if (!snapshot || localScreen(agentId) !== null) return fn();
  const offScrollback = registerScrollback(agentId, () => snapshot.scrollback);
  const viewport = snapshot.viewport;
  const offViewport = viewport ? registerViewport(agentId, () => viewport) : () => {};
  installedHere.set(agentId, (installedHere.get(agentId) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    // Each unregister removes only ITS provider, so a pane that mounted mid-op keeps its own.
    offScrollback();
    offViewport();
    const n = (installedHere.get(agentId) ?? 1) - 1;
    if (n <= 0) installedHere.delete(agentId);
    else installedHere.set(agentId, n);
  }
}
