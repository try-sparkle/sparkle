// preview — the ONE module that talks to the Rust preview supervisor.
//
// Every `invoke` and the single `listen` live here, so the pane, the toggle and the hover-card
// action are all testable by seeding `previewStore` instead of stubbing the Tauri bridge. That is
// the same split `services/branchStatus` and `stores/runtimeStore` already use, and the reason is
// not tidiness: a component that invokes directly cannot be rendered in jsdom at all without a
// bridge mock, so the tests that would catch a layout or a security regression stop being written.
//
// THE COMMAND NAMES AND PAYLOAD SHAPES ARE A FROZEN CONTRACT, built against in parallel on the Rust
// side. Do not rename a field here to something that reads better; the two halves cannot see each
// other's tests, and a silent shape mismatch is exactly the failure mode bead `sparkle-16y6h`
// describes (see `PreviewStatus` in stores/previewStore for the `T | null` rule).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { safeUnlisten } from "./safeUnlisten";
import {
  usePreviewStore,
  type PreviewCapability,
  type PreviewState,
  type PreviewStatus,
} from "../stores/previewStore";

/** MUST match the Rust emitter's event name. */
export const PREVIEW_STATE_EVENT = "preview:state";

export interface PreviewCapabilityReply {
  previewable: boolean;
  // `T | null`, never `T | undefined` — serde emits None as an explicit null. See PreviewStatus.
  target: PreviewCapability["target"];
  declineReason: string | null;
}

export type PreviewStopOutcome = "stopped" | "already-stopped" | "not-found";

/**
 * Is this url one we are willing to point an iframe at?
 *
 * A DELIBERATE SECOND COPY of the Rust gate, and the duplication is the point rather than an
 * oversight to clean up later. The url crosses a process boundary to get here and this side is what
 * actually renders it, so "Rust already checked" is a claim about a different process's build. The
 * cost of being wrong is not symmetric either: Rust getting it wrong spawns a server we do not
 * frame; this getting it wrong FRAMES A REMOTE ORIGIN inside the app. (CSP `frame-src` is the third
 * and strongest layer — it refuses the navigation outright — but a refused frame renders as a blank
 * rectangle, and a blank rectangle reads to the user as "the feature is broken" rather than as a
 * gate doing its job. This one can say so.)
 *
 * Accepts ONLY plain `http:` on `localhost`, `127.0.0.1` or `[::1]`. Not https (nothing loopback
 * serves it here, and accepting it widens the surface for nothing), not `0.0.0.0`, not a LAN
 * address, and nothing that merely CONTAINS a loopback token.
 *
 * PEEL A BRACKETED IPv6 HOST BEFORE SPLITTING ON ':' (roborev 47899). `[::1]:5199` split on the
 * first colon yields a bare `[`, so the IPv6 loopback case becomes unreachable — the check does not
 * fail open, it fails *closed and silently*, and the only symptom is that IPv6 previews never
 * render. `URL.hostname` already does the peeling, which is why this parses rather than string-
 * matches; the explicit set below is what keeps `127.0.0.1.evil.com` and `evil.com/#127.0.0.1` out,
 * since both of those satisfy any substring test you would otherwise be tempted to write.
 */
export function isLoopbackPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  // `URL.hostname` strips the brackets from an IPv6 literal, so `[::1]` arrives as `::1`. Both
  // spellings are listed because a caller may hand us either, and neither can be reached by a
  // hostname that merely ends in one of them (`evil.127.0.0.1.com` is not equal to any of these).
  return (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]"
  );
}

/** Ask whether a worktree can be previewed at all, and record it. The answer gates the AFFORDANCES
 *  (§7 rule 5: absent, never greyed), so a project that has not answered yet simply offers
 *  nothing — which is the correct read of "we do not know". */
export async function refreshPreviewCapability(
  projectId: string,
  worktree: string,
): Promise<PreviewCapability | null> {
  try {
    const reply = await invoke<PreviewCapabilityReply>("preview_capability", { worktree });
    const cap: PreviewCapability = {
      previewable: !!reply?.previewable,
      target: reply?.target ?? null,
      declineReason: reply?.declineReason ?? null,
    };
    usePreviewStore.getState().setCapability(projectId, cap);
    return cap;
  } catch (e) {
    // FAIL CLOSED, AND SAY SO. An unreadable probe is not "previewable"; recording false here is
    // what keeps a broken bridge from offering a button that cannot work. It is re-askable — the
    // next selection re-runs it — so this is not a sticky verdict.
    console.debug("preview_capability failed", e);
    usePreviewStore.getState().setCapability(projectId, {
      previewable: false,
      target: null,
      declineReason: String(e),
    });
    return null;
  }
}

/** Exactly what `preview_open` returns — see `preview.rs`'s `PreviewOpened`.
 *
 *  NOT a `PreviewStatus`, and the difference was a live bug rather than a nicety. `PreviewOpened`
 *  carries no `agentId`, so folding the reply through `applyPreviewStatus` (which keys the store on
 *  `status.agentId`) wrote the entry under the literal string `"undefined"` — a phantom row no pane
 *  reads, while the agent that just started a preview got nothing. The optimistic write therefore
 *  never did the one thing it exists for, and the pane only populated when the `preview:state`
 *  event landed, i.e. after the round trip this was meant to pre-empt. */
export interface PreviewOpened {
  id: string;
  url: string;
  port: number;
  state: PreviewState;
}

/** The Rust refusal a caller must NOT paint as a failed start — `preview.rs`'s
 *  `PreviewManager::reserve_or_reattach`. Matched as a substring because the message carries a
 *  `preview:` prefix and crosses the IPC boundary as a bare string; the Rust text and this constant
 *  are pinned to each other by `preview.rs`'s reservation test and `AgentSidebar.openPreview.test`. */
export const PREVIEW_ALREADY_STARTING = "already starting";

/** Start a preview for an agent, or RE-ATTACH to the one already running for it.
 *
 *  Re-attach is the Rust side's behaviour (`open_blocking` looks for a live server for this agent
 *  before spawning), not a claim made here: without it a second call would start a second dev
 *  server — hundreds of MB of resident Node each — and orphan the first from every stop path.
 *  A `failed`/`crashed`/`stopped` server is deliberately NOT re-attached, so a second click retries
 *  rather than handing back the corpse.
 *
 *  A call made while a start for the same agent is STILL IN FLIGHT — the seconds before the new
 *  server exists to re-attach to — REJECTS with "a server for this agent is already starting"
 *  rather than spawning a rival. Callers that surface errors to the user (AgentSidebar writes the
 *  pane's `failed` state) should expect that string on a double click; it is a refusal, not a
 *  failed start, and the in-flight start goes on to populate the pane by event.
 *
 *  The same state arrives on the event channel, so the store write here is only about not waiting a
 *  round trip — synthesized from the args the caller already holds, because the reply does not name
 *  the agent. */
export async function openPreviewServer(args: {
  agentId: string;
  projectId: string;
  worktree: string;
  path?: string | null;
}): Promise<PreviewOpened | null> {
  const reply = await invoke<PreviewOpened>("preview_open", {
    agentId: args.agentId,
    projectId: args.projectId,
    worktree: args.worktree,
    path: args.path ?? null,
  });
  if (reply) {
    usePreviewStore.getState().setPreview(args.agentId, {
      id: reply.id,
      status: reply.state,
      url: reply.url,
      port: reply.port,
      error: null,
    });
  }
  return reply ?? null;
}

export async function stopPreview(id: string): Promise<PreviewStopOutcome | null> {
  const reply = await invoke<{ outcome: PreviewStopOutcome }>("preview_stop", { id });
  return reply?.outcome ?? null;
}

/** Stop whatever this agent has, without needing to know its server id — the teardown path, where
 *  the id may never have arrived. */
export async function stopPreviewForAgent(agentId: string): Promise<PreviewStopOutcome | null> {
  const reply = await invoke<{ outcome: PreviewStopOutcome }>("preview_stop_for_agent", {
    agentId,
  });
  usePreviewStore.getState().clearPreview(agentId);
  return reply?.outcome ?? null;
}

/** One agent's current status, or null when it has none. */
export async function fetchPreviewStatus(agentId: string): Promise<PreviewStatus | null> {
  const status = await invoke<PreviewStatus | null>("preview_status", { agentId });
  if (status) applyPreviewStatus(status);
  return status ?? null;
}

/** Every live preview — the reconciliation read, for a window that mounted after the servers did. */
export async function listPreviews(): Promise<PreviewStatus[]> {
  const list = (await invoke<PreviewStatus[]>("preview_list")) ?? [];
  for (const status of list) applyPreviewStatus(status);
  return list;
}

/** Fold one wire status into the store. Exported for the listener and for tests that want to drive
 *  the store the way Rust does, rather than hand-building an entry that already has the shape the
 *  parser is supposed to produce (which would test nothing). */
export function applyPreviewStatus(status: PreviewStatus): void {
  usePreviewStore.getState().setPreview(status.agentId, {
    id: status.id,
    status: status.state,
    // `?? null` on both, because the wire sends null and the local shape stores null. This is NOT
    // defensive noise: it is the one line where a missing key and an explicit null are made to mean
    // the same thing, which is the rule the whole `T | null` note in previewStore exists to state.
    url: status.url ?? null,
    port: status.port ?? null,
    error: status.error ?? null,
  });
}

/** Singleton guard, mirroring `aiServiceHealthListener`: StrictMode and HMR both double-mount, and
 *  two listeners would apply every event twice. Cleared on failure so a later mount can re-arm. */
let startPromise: Promise<() => void> | undefined;

/** SUBSCRIBE, NEVER POLL. Rust emits on every transition, and a dev server's interesting moments
 *  (bound a port, first compile finished, crashed) are exactly the ones a poll interval smears. */
export function startPreviewListener(): Promise<() => void> {
  startPromise ??= doStart().catch((e: unknown) => {
    startPromise = undefined;
    throw e;
  });
  return startPromise;
}

async function doStart(): Promise<() => void> {
  const unlisten = await listen<PreviewStatus>(PREVIEW_STATE_EVENT, (ev) => {
    const status = ev.payload;
    // A payload without an agentId cannot be filed anywhere; drop it rather than inventing a key.
    if (!status || typeof status.agentId !== "string") return;
    applyPreviewStatus(status);
  });
  return () => {
    // Through `safeUnlisten`, never bare — Tauri's real unlisten is async, so a bare call hands
    // back a rejected promise instead of throwing and the teardown race becomes an app-level
    // unhandled rejection (roborev 57507).
    void safeUnlisten(unlisten);
    startPromise = undefined;
  };
}
