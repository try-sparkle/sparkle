// @vitest-environment jsdom
//
// THE REGISTRATION PATH ITSELF — the seam every other drag-drop test in this repo mocks away.
//
// Composer.dropTarget.test.tsx passes 11/11 against an app in which dropping a file does nothing,
// because it replaces `@tauri-apps/api/webview` with a stub that hands the app one fabricated
// handler, then feeds that handler hand-authored payloads. Under that mock the app cannot fail:
// the event names are never used, the four-listener registration never happens, and the payload is
// whatever the test wrote. It asserts our branching against a seam the test itself built.
//
// This file mocks ONE LAYER LOWER — `window.__TAURI_INTERNALS__` (src/test/tauriEventBackend) —
// and lets the REAL `@tauri-apps/api` run on top: real `getCurrentWebview()`, real `listen()`, real
// event names, real payload construction. So these assertions are about the actual wiring.
//
// SCOPE, stated because it is easy to overclaim: this covers the Tauri JS API down through our
// handlers. It does NOT and cannot prove that macOS delivers the drop — whether WebKit calls
// `performDragOperation:` is below the IPC boundary, invisible to jsdom, and remains the open
// question in the live investigation.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeCore = vi.hoisted(() => vi.fn());
// `resolveDropPaths`' recovery call goes through the core `invoke` wrapper; the drag-drop
// registration below deliberately does NOT — it runs through the real API onto the backend.
vi.mock("@tauri-apps/api/core", async (orig) => {
  const actual = await orig<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: invokeCore };
});
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/conciergeAttach", () => ({
  loadAttachmentPaths: vi.fn((paths: string[]) =>
    Promise.resolve({
      attachments: paths.map((p) => ({ id: `att-${p}`, kind: "file", path: p, name: p })),
      failed: [],
    }),
  ),
  pickAttachments: vi.fn(),
}));

import {
  installTauriEventBackend,
  DRAG_ENTER,
  DRAG_OVER,
  DRAG_DROP,
  DRAG_LEAVE,
  type TauriEventBackend,
} from "../test/tauriEventBackend";
import { useConciergeAttachments } from "./useConciergeAttachments";
import { loadAttachmentPaths } from "../services/conciergeAttach";
import { CONCIERGE_COLUMN_DND_TARGET } from "../services/dndTargets";

const column = document.createElement("div");
column.setAttribute("data-dnd-target", CONCIERGE_COLUMN_DND_TARGET);
document.elementFromPoint = vi.fn(() => column);

const overConcierge = { x: 120, y: 400 };
let backend: TauriEventBackend;

beforeEach(() => {
  backend = installTauriEventBackend("main");
  invokeCore.mockReset();
  invokeCore.mockResolvedValue([]);
  vi.mocked(loadAttachmentPaths).mockClear();
});
afterEach(async () => {
  cleanup();
  // Let the unmount's async unlisten chain settle against the LIVE backend before retiring it, so
  // the teardown assertions above are exercising a real deregistration rather than a torn-down stub.
  await Promise.resolve();
  backend.teardown();
});

/** Mount and wait for the four `listen()` round-trips to settle. */
async function mounted() {
  const view = renderHook(() => useConciergeAttachments());
  await waitFor(() => expect(backend.eventNames()).toContain(DRAG_DROP));
  return view;
}

describe("concierge drop — the real Tauri registration path", () => {
  // THE ASSERTION THE MOCKED SUITE CANNOT MAKE. `onDragDropEvent` registers four independent
  // listeners; the drop one going missing (an API change, a partial registration, a rejected
  // listen) is invisible to a test that fabricates the handler. Naming the literal wire strings is
  // the point — our own constants would tautologically agree with themselves.
  it("registers all four drag phases under Tauri's real event names", async () => {
    await mounted();
    expect(backend.eventNames().sort()).toEqual(
      [DRAG_ENTER, DRAG_OVER, DRAG_DROP, DRAG_LEAVE].sort(),
    );
  });

  it("scopes the listeners to THIS webview, not to every target", async () => {
    await mounted();
    // A global listen would make a drop on another window attach files here.
    for (const r of backend.registered) {
      expect(r.target).toEqual({ kind: "Webview", label: "main" });
    }
  });

  // END TO END THROUGH THE REAL API: a wire-shaped `tauri://drag-drop` payload — the exact shape
  // Rust emits, `{paths, position}` — must reach the app and attach the file. The real
  // `onDragDropEvent` is what turns this into `{type: "drop", paths, position}`; nothing in the
  // test does that mapping.
  it("attaches a file from a wire-shaped drag-drop event", async () => {
    const { result } = await mounted();

    act(() => {
      backend.emit(DRAG_DROP, {
        paths: ["/Users/x/photo.png"],
        position: { x: overConcierge.x, y: overConcierge.y },
      });
    });

    await waitFor(() => expect(loadAttachmentPaths).toHaveBeenCalledWith(["/Users/x/photo.png"]));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
  });

  it("lights the affordance from a wire-shaped drag-over, and clears it on leave", async () => {
    const { result } = await mounted();

    act(() => {
      backend.emit(DRAG_OVER, { position: overConcierge });
    });
    expect(result.current.dropActive).toBe(true);

    act(() => {
      backend.emit(DRAG_LEAVE, null);
    });
    expect(result.current.dropActive).toBe(false);
  });

  // THE FOUNDER'S EXACT SYMPTOM, expressed against the real wiring: over paints, drop does nothing.
  // If a future change breaks drop delivery while leaving over intact — the shape of the live bug —
  // this fails, where the mocked suite would stay green.
  it("a drag-over followed by a drop ATTACHES; over alone must never be enough", async () => {
    const { result } = await mounted();

    act(() => {
      backend.emit(DRAG_OVER, { position: overConcierge });
    });
    expect(result.current.dropActive).toBe(true);
    expect(loadAttachmentPaths).not.toHaveBeenCalled(); // hovering is not dropping

    act(() => {
      backend.emit(DRAG_DROP, { paths: ["/Users/x/a.png"], position: overConcierge });
    });
    await waitFor(() => expect(loadAttachmentPaths).toHaveBeenCalledWith(["/Users/x/a.png"]));
    // …and the affordance must come back down, or the box stays lit after a completed drop.
    await waitFor(() => expect(result.current.dropActive).toBe(false));
  });

  // LISTENER CHURN — a candidate mechanism for the live bug, and one that IS testable here.
  //
  // Registration is four async IPC round-trips, and teardown is async too (`safeUnlisten` must
  // await the `listen()` promise before it can unlisten). So every re-run of this effect opens a
  // window in which the drop listener is NOT registered. A drop landing in that window is emitted
  // by Rust, reaches no listener, and produces exactly the founder's symptom: total silence.
  //
  // That is survivable if the effect runs once. It is fatal under the re-render storms this app
  // logs (`jank stall … rendered: Workspace×27`): an effect whose deps churn per render would leave
  // the drop listener absent for most of the duty cycle. The dependency chain is supposed to be
  // stable — `attachPaths` → `settle` → `add` → `apply`, all `useCallback`s bottoming out at `[]` —
  // and this is what holds that chain to it. A single unmemoised link upstream re-registers on
  // every render and nothing else in the suite would notice.
  it("registers ONCE and does not churn across re-renders", async () => {
    const view = await mounted();
    const afterMount = backend.registered.length;
    expect(afterMount).toBe(4); // enter, over, drop, leave — exactly one set

    for (let i = 0; i < 25; i++) view.rerender();
    await Promise.resolve();

    // CUMULATIVE, not live. This assertion was written first as `registered.length === 4` and it
    // was VACUOUS: a churning effect unregisters as well as registers, so the live count settles
    // back to 4 and the check passed against a deliberately-broken dependency array. Only the
    // never-decremented total tells "registered once" apart from "registered twenty-six times".
    expect(backend.listenCount(DRAG_DROP)).toBe(1);
    expect(backend.registered.length).toBe(afterMount);
  });

  it("tears every listener down on unmount, so a stale hook cannot claim a later drop", async () => {
    const view = await mounted();
    view.unmount();
    await waitFor(() => expect(backend.eventNames()).not.toContain(DRAG_DROP));
    expect(backend.registered).toHaveLength(0);
  });
});
