// A REAL Tauri IPC backend for tests — so a drag-drop test exercises the actual registration path
// instead of a hand-made stand-in for it.
//
// WHY THIS EXISTS. Every drag-drop test in this repo mocks `@tauri-apps/api/webview` wholesale:
//
//   vi.mock("@tauri-apps/api/webview", () => ({
//     getCurrentWebview: () => ({ onDragDropEvent: (h) => { captured.handler = h; … } }),
//   }));
//
// That replaces the very thing under test. `onDragDropEvent` is not a single subscription — it
// registers FOUR separate listeners (`tauri://drag-enter`, `-over`, `-drop`, `-leave`), each an
// independent `invoke('plugin:event|listen')`, and it builds the `{type, paths, position}` payload
// the app branches on. A mock that hands the app one fabricated handler and one hand-authored
// payload asserts nothing about any of it: the event NAMES could change, the drop listener could
// stop being registered, the payload shape could move, and all eleven existing assertions would
// still pass. That is precisely the state the suite was in while the feature was 100% broken for
// the founder — green, and blind to the seam that failed.
//
// So this mocks ONE layer lower: `window.__TAURI_INTERNALS__`, which is where the real API bottoms
// out (`core.js` → `window.__TAURI_INTERNALS__.invoke` / `.transformCallback`). Above it, the
// genuine `@tauri-apps/api` code runs — real `listen()`, real event names, real payload
// construction, real `Webview` target scoping. `emitDragDrop` below then delivers an event the way
// Rust does, by name.
//
// WHAT THIS CAN AND CANNOT PROVE. It covers everything from the Tauri JS API down to our handlers:
// registration, event naming, payload mapping, and our branching. It CANNOT reach the native side —
// whether macOS/WebKit delivers `performDragOperation:` at all is below the IPC boundary and no
// jsdom test can observe it. Tests using this must not claim otherwise.

/** One registered listener, keyed the way the Rust event plugin keys them. */
interface Registered {
  event: string;
  target: { kind: string; label?: string };
  callbackId: number;
  /** The id `plugin:event|listen` returned — what `unregisterListener` is later called with. */
  eventId: number;
}

export interface TauriEventBackend {
  /** Every `plugin:event|listen` the code under test performed, in order. */
  readonly registered: readonly Registered[];
  /** Event names currently listened to (deduped) — the assertion surface for "is drop wired?". */
  eventNames(): string[];
  /**
   * How many `listen()` calls have EVER been made for `event` — cumulative, never decremented.
   *
   * The live-registration count cannot detect churn: an effect that re-registers on every render
   * unregisters too, so the current count settles back to its steady-state value and a
   * `toBe(4)` assertion passes against a listener that is absent half the time. Only a cumulative
   * total distinguishes "registered once" from "registered forty times".
   */
  listenCount(event: string): number;
  /** Deliver an event by NAME, exactly as the Rust side emits it. Returns how many fired. */
  emit(event: string, payload: unknown): number;
  /** Remove the backend from `window`. */
  teardown(): void;
}

/**
 * Install a working `window.__TAURI_INTERNALS__`.
 *
 * `webviewLabel` becomes the current webview's label, which the real `Webview.listen` puts in the
 * listen target — so a test can prove the app scoped its listener to its own webview rather than
 * globally.
 */
export function installTauriEventBackend(webviewLabel = "main"): TauriEventBackend {
  const callbacks = new Map<number, (payload: unknown) => void>();
  const registered: Registered[] = [];
  /** Cumulative `listen()` calls per event name — see `listenCount`. Never decremented. */
  const listens = new Map<string, number>();
  let nextCallbackId = 1;
  let nextEventId = 1;

  const internals = {
    metadata: {
      currentWebview: { label: webviewLabel },
      currentWindow: { label: webviewLabel },
    },
    // The real one stores the callback on `window` under a generated id and returns that id; the
    // only contract that matters here is "id in, callback reachable by id".
    transformCallback(callback: (payload: unknown) => void, _once = false): number {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
      if (cmd === "plugin:event|listen") {
        const eventId = nextEventId++;
        const name = args.event as string;
        listens.set(name, (listens.get(name) ?? 0) + 1);
        registered.push({
          event: args.event as string,
          target: args.target as { kind: string; label?: string },
          callbackId: args.handler as number,
          eventId,
        });
        return eventId;
      }
      if (cmd === "plugin:event|unlisten") {
        // `unregisterListener` (the event plugin's own internals, installed below) has already
        // removed the entry by the time this runs — matching the real split. Idempotent by id, so
        // it stays correct whichever order a caller uses.
        const eventId = args.eventId as number;
        const idx = registered.findIndex((r) => r.eventId === eventId);
        if (idx !== -1) {
          callbacks.delete(registered[idx]!.callbackId);
          registered.splice(idx, 1);
        }
        return null;
      }
      // Anything else is out of scope for this backend; a test that needs it should mock that
      // module directly rather than growing a fake Rust here.
      return null;
    },
  };

  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = internals;

  // The event plugin keeps its OWN internals object, and `_unlisten` calls into it BEFORE it
  // invokes `plugin:event|unlisten` (event.js). Omitting it makes every teardown throw
  // `Cannot read properties of undefined (reading 'unregisterListener')` — which `safeUnlisten`
  // swallows as a teardown race, so the failure surfaces only as an unhandled rejection and the
  // listener silently never comes off. Faithfulness at the boundary matters: a backend that is
  // wrong here would let a leak-on-unmount bug pass.
  (
    window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }
  ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, eventId: number) {
      const idx = registered.findIndex((r) => r.event === event && r.eventId === eventId);
      if (idx !== -1) {
        callbacks.delete(registered[idx]!.callbackId);
        registered.splice(idx, 1);
      }
    },
  };

  return {
    registered,
    eventNames: () => [...new Set(registered.map((r) => r.event))],
    listenCount: (event) => listens.get(event) ?? 0,
    emit(event, payload) {
      const hits = registered.filter((r) => r.event === event);
      for (const r of hits) {
        // The Rust side delivers `{event, id, payload}`; the API's own wrapper reads `.payload`.
        callbacks.get(r.callbackId)?.({ event, id: r.callbackId, payload });
      }
      return hits.length;
    },
    teardown() {
      // RETIRED, NOT DELETED. Unlistening is asynchronous — `safeUnlisten` awaits the `listen()`
      // promise before it can call the unlisten fn — so teardown in an `afterEach` routinely runs
      // BEFORE the last unlisten resolves. Deleting these objects makes that late call throw
      // `Cannot read properties of undefined`, which `safeUnlisten` then swallows as a teardown
      // race; the test still passes and the noise shows up only as unhandled rejections.
      //
      // In a real webview these globals always exist, so retiring them to inert stubs is both the
      // faithful behaviour and the quiet one. State is cleared so nothing leaks between tests.
      (
        window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }
      ).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: internals.metadata,
        transformCallback: () => 0,
        invoke: async () => null,
      };
      callbacks.clear();
      registered.length = 0;
      listens.clear();
    },
  };
}

/** The event names Tauri emits for the four drag phases — the real strings, not our copies. */
export const DRAG_ENTER = "tauri://drag-enter";
export const DRAG_OVER = "tauri://drag-over";
export const DRAG_DROP = "tauri://drag-drop";
export const DRAG_LEAVE = "tauri://drag-leave";
