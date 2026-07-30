// @vitest-environment jsdom
//
// WHO OWNS A KEYPRESS when the caret is in a terminal. Two facts, and they pull in opposite
// directions, which is why they share a file:
//
//   1. ESCAPE BELONGS TO THE PROCESS. The handler must let it through, because that is how you leave
//      insert mode in vim, dismiss `less`, and interrupt Claude Code. `engine/cable`'s predicates are
//      what stop it ALSO unbinding the cable; this file pins the other half — that the byte still
//      reaches the PTY at all.
//
//   2. THE UNMOUNT CHORD DOES NOT. It is handled by the `window` listener in `Workspace`, which runs
//      on the BUBBLE — after xterm has already decided what to send — so that listener's
//      `preventDefault` cannot un-send a sequence. `evaluateKeyboardEvent` folds `metaKey` into its
//      modifier bitmask, so a ⌘⇧-letter combo is not self-evidently inert, and a stray byte in a live
//      agent's stdin cannot be taken back. The handler returns false so xterm never processes it.
//
// Plus the marker the whole Escape fix rests on: the REAL component must render
// `data-terminal-surface`. Everything else asserting terminal-focus behavior does so against either
// synthetic DOM (voice/dictationFocus.test.ts) or a stubbed pane (Workspace.cockpit.test.tsx), so
// without this case the attribute could be deleted from the real component and both would still pass.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

// The captured custom key handler, and every byte the transport was asked to write. Hoisted so the
// vi.mock factories can close over them.
const { keyHandler, dataHandler, writes } = vi.hoisted(() => ({
  keyHandler: { fn: null as null | ((e: KeyboardEvent) => boolean) },
  // xterm's `onData` callback. Captured for the same reason the key handler is: it is the app's only
  // signal that a USER typed in this terminal, and the wiring is otherwise unassertable.
  dataHandler: { fn: null as null | ((d: string) => void) },
  writes: [] as string[],
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    // Readable, not just shaped: `snapshotScreen` walks `length`/`getLine`, and a throwing provider
    // is swallowed as `null` by `getAgentViewport` — which would make "the viewport is registered"
    // unfalsifiable, passing identically whether the registration exists or not.
    buffer = {
      active: {
        type: "normal",
        length: 1,
        getLine: (_i: number) => ({ translateToString: (_t?: boolean) => "$ " }),
      },
    };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    constructor(_opts: Record<string, unknown>) {}
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
      parent.appendChild(el);
      this.element = el;
    }
    onData(fn: (d: string) => void): void {
      dataHandler.fn = fn;
    }
    // THE SEAM. Capturing the handler is what makes "xterm will not process this key" an assertion
    // instead of a comment — the handler's return value IS xterm's go/no-go.
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
      keyHandler.fn = fn;
    }
    attachCustomWheelEventHandler(): void {}
    registerMarker(): null {
      return null;
    }
    refresh(): void {}
    focus(): void {}
    scrollToLine(): void {}
    scrollLines(): void {}
    getSelection(): string {
      return "";
    }
    write(): void {}
    dispose(): void {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(_h: unknown) {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));

vi.mock("../services/agentTransport", () => ({
  getTransport: () => ({
    spawn: vi.fn(() => Promise.resolve()),
    write: vi.fn((d: string) => void writes.push(d)),
    resize: vi.fn(),
    detach: vi.fn(() => Promise.resolve()),
    onOutput: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    setPaused: vi.fn(),
    ack: vi.fn(),
  }),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../clipboard", () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../engine/statusEngine", () => ({
  StatusEngine: class {
    constructor(_opts: unknown) {}
    ingest(): void {}
    exit(): void {}
    dispose(): void {}
  },
}));
vi.mock("../theme/theme", () => ({ useResolvedTheme: () => "dark" }));

import { Terminal } from "./Terminal";
import { TERMINAL_AGENT_ATTR, TERMINAL_SURFACE_ATTR } from "../voice/dictationFocus";
import { getAgentViewport } from "../services/terminalViewport";
import { SHORTCUT_DEFAULTS } from "../stores/keybindingsStore";
import { resetCable, useCableStore } from "../stores/cableStore";
import { resetTerminalFocusIntent } from "../services/terminalFocusIntent";
import { clearTerminalEscapeToll } from "../services/terminalEscapeRelease";

const baseProps = {
  agentId: "agent-1",
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  active: true,
  onStatus: () => {},
};

/** A real KeyboardEvent, so the handler sees the same shape the browser hands xterm. */
const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { ...init, bubbles: true });

beforeEach(() => {
  keyHandler.fn = null;
  dataHandler.fn = null;
  writes.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the terminal surface marker", () => {
  // Asserted on the REAL component. The classifier and the cable predicates are both tested against
  // DOM that a test built, so this is the only place that proves the app actually emits the attribute
  // they match on — delete it from Terminal.tsx and only this case fails.
  it("is rendered on the element xterm mounts into", async () => {
    const { container } = render(<Terminal {...baseProps} />);
    await waitFor(() => expect(keyHandler.fn).not.toBeNull());
    const surface = container.querySelector(`[${TERMINAL_SURFACE_ATTR}]`);
    expect(surface).not.toBeNull();
    // …and xterm's own element lives INSIDE it, which is what makes `closest()` from the caret
    // resolve. A marker on a sibling would satisfy a mere presence check and classify nothing.
    expect(surface!.querySelector("div")).not.toBeNull();
  });

  // The pane root also hosts the failure/loading overlays. Focusing a "Start again" button is not
  // typing at a live PTY, so the marker must NOT sit high enough to include it.
  it("is not on the pane root, so overlay chrome is not mistaken for a PTY", async () => {
    const { container } = render(<Terminal {...baseProps} />);
    await waitFor(() => expect(keyHandler.fn).not.toBeNull());
    expect((container.firstElementChild as HTMLElement).hasAttribute(TERMINAL_SURFACE_ATTR)).toBe(
      false,
    );
  });

  // ══ THE TERMINAL→REGISTRY EDGE (roborev 56022) ═════════════════════════════════════════════
  // The dictation tests hand-register a viewport provider and hand-build the DOM, so they prove the
  // SINK reads the registry — not that the real component ever fills it. Both wires below could be
  // deleted from Terminal.tsx with every other test still green, while at runtime every dictated
  // phrase refuses `no-terminal` / `no-viewport` with no symptom but "it doesn't work".
  it("carries the agent id on the same element as the surface marker", async () => {
    const { container } = render(<Terminal {...baseProps} />);
    await waitFor(() => expect(keyHandler.fn).not.toBeNull());
    const surface = container.querySelector(`[${TERMINAL_SURFACE_ATTR}]`);
    // The SAME element, deliberately: `focusedTerminalAgentId` does one `closest` from the caret,
    // so an id parked on a different node resolves null for every real focus.
    expect(surface!.getAttribute(TERMINAL_AGENT_ATTR)).toBe(baseProps.agentId);
  });

  it("registers a readable viewport while mounted, and unregisters it on unmount", async () => {
    const { unmount } = render(<Terminal {...baseProps} />);
    await waitFor(() => expect(keyHandler.fn).not.toBeNull());
    const view = getAgentViewport(baseProps.agentId);
    expect(view).not.toBeNull();
    expect(view!.alternateBuffer).toBe(false);
    expect(view!.text).toContain("$");
    // Unregistering matters as much as registering: a stale provider closed over a DISPOSED
    // terminal is how a write gate starts reading a screen that no longer exists.
    unmount();
    expect(getAgentViewport(baseProps.agentId)).toBeNull();
  });
});

describe("who owns the keypress", () => {
  async function handler() {
    render(<Terminal {...baseProps} />);
    await waitFor(() => expect(keyHandler.fn).not.toBeNull());
    return keyHandler.fn!;
  }

  // ESCAPE MUST GET THROUGH. `true` is xterm's go-ahead, which is how the byte reaches the process.
  // If this ever returns false, vim stops leaving insert mode and Claude Code stops interrupting —
  // and the cable fix would be masking it rather than the predicates doing their job.
  it("lets Escape through to the process", async () => {
    const h = await handler();
    expect(h(key({ key: "Escape" }))).toBe(true);
  });

  // THE CHORD IS SWALLOWED. `false` means xterm never evaluates it, so no sequence is emitted —
  // `Workspace`'s window listener still sees the DOM event and does the unmounting.
  it("swallows the unmount chord so no stray sequence reaches the PTY", async () => {
    const h = await handler();
    const b = SHORTCUT_DEFAULTS.unmountCable;
    expect(b.kind).toBe("chord");
    expect(
      h(
        key({
          key: b.kind === "chord" ? b.key : "u",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);
    // Nothing was written on the way past, either.
    expect(writes).toEqual([]);
  });

  // …AND THE SWALLOW IS NARROW. The same letter without the modifiers is ordinary typing and must
  // still reach the process; otherwise "u" would be unusable in every terminal in the app.
  it("still passes the same key through without the modifiers", async () => {
    const h = await handler();
    expect(h(key({ key: "u" }))).toBe(true);
    expect(h(key({ key: "u", metaKey: true }))).toBe(true);
    expect(h(key({ key: "u", shiftKey: true }))).toBe(true);
  });

  it("passes ordinary typing through", async () => {
    const h = await handler();
    for (const k of ["a", "Enter", "Tab", "ArrowUp", "Backspace"]) {
      expect(h(key({ key: k }))).toBe(true);
    }
  });
});

// ══ THE REACHABILITY BUG, AND THE PROOF IT IS FIXED (roborev 55722) ═════════════════════════════
//
// The first version of the in-terminal Escape gesture lived in `Workspace`'s `window` keydown listener.
// It could never fire, because xterm calls `cancel(ev, true)` for Escape — `preventDefault()` AND
// `stopPropagation()` — so the event dies at the helper textarea. Verified in the shipped bundle:
//
//     case 27: o.key = ESC, …, o.cancel = !0
//     i.cancel && this.cancel(e, !0)
//     cancel(e,t){ if(this.options.cancelEvents||t) return e.preventDefault(), e.stopPropagation(), !1 }
//
// The old tests were blind to it: they fired `keyDown(window, …)` directly, and the stub textarea had no
// xterm handler to cancel anything. So the first case below reproduces the REAL propagation behavior and
// asserts that a window listener does NOT see the press — that is the fact that forced this logic into
// `Terminal.tsx` — and the second asserts the cable reacts anyway, through the handler that does see it.
describe("Escape reaches the cable even though it never reaches `window`", () => {
  async function handler() {
    render(<Terminal {...baseProps} />);
    await waitFor(() => expect(keyHandler.fn).not.toBeNull());
    return keyHandler.fn!;
  }

  it("is swallowed before a window listener can see it, the way real xterm swallows it", async () => {
    render(<Terminal {...baseProps} />);
    await waitFor(() => expect(keyHandler.fn).not.toBeNull());

    const seenAtWindow: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => seenAtWindow.push(e.key);
    window.addEventListener("keydown", onWindowKey);

    // The sink stands in for `.xterm-helper-textarea`, with xterm's own behavior modelled on it: run
    // the custom handler first, then — for a key xterm claims — cancel exactly as `cancel(ev, true)`
    // does. This is the mechanism the old tests skipped.
    const sink = document.createElement("textarea");
    sink.className = "xterm-helper-textarea";
    document.body.appendChild(sink);
    sink.addEventListener("keydown", (e) => {
      if (keyHandler.fn!(e as KeyboardEvent) === false) return; // handler claimed it
      e.preventDefault();
      e.stopPropagation(); // ← xterm's cancel(ev, true) for Escape
    });

    sink.dispatchEvent(key({ key: "Escape" }));
    window.removeEventListener("keydown", onWindowKey);
    sink.remove();

    // THE POINT: nothing at `window` ever saw it. A `Workspace`-level implementation of this gesture
    // is unreachable, which is why the decision lives in the handler above.
    expect(seenAtWindow).toEqual([]);
  });

  it("still releases the cable, because the decision runs in the handler that DOES see it", async () => {
    resetCable();
    resetTerminalFocusIntent();
    clearTerminalEscapeToll();
    useCableStore.getState().patch("right");

    const h = await handler();
    // A parked caret (the resting state): one press releases, per the founder-confirmed ladder.
    h(key({ key: "Escape" }));
    expect(useCableStore.getState().wired).toBe("off");
  });

  // ══ THE WIRING FROM `onData` TO PROVENANCE, WHICH A DIRECT UNIT TEST CANNOT SEE ═════════════════
  // Found by mutation: deleting `noteTerminalInteraction()` from the component's `onData` handler left
  // the entire suite green, because the service tests call that function directly. Same vacuous shape as
  // the bug this whole branch has been correcting — a test that exercises a mechanism without proving
  // anything invokes it. So this drives the callback xterm would actually call.
  it("upgrades provenance when the user types, so Escape then takes two presses", async () => {
    resetCable();
    resetTerminalFocusIntent();
    clearTerminalEscapeToll();
    useCableStore.getState().patch("right");

    const h = await handler();
    expect(dataHandler.fn).not.toBeNull();
    // The user types a character. xterm reports it through `onData` — user input only, never
    // programmatic output — which is the app's sole evidence that they are working in THIS terminal.
    dataHandler.fn!("x");

    // Now the gesture is two presses: the first is the running program's, the second releases.
    h(key({ key: "Escape" }));
    expect(useCableStore.getState().wired).toBe("right");
    h(key({ key: "Escape" }));
    expect(useCableStore.getState().wired).toBe("off");
  });

  // …and WITHOUT that interaction the parked-caret ladder holds: one press releases. Together these two
  // pin the branch, so neither the upgrade nor its absence can be deleted unnoticed.
  it("leaves the one-press ladder alone when the user has NOT typed", async () => {
    resetCable();
    resetTerminalFocusIntent();
    clearTerminalEscapeToll();
    useCableStore.getState().patch("right");

    const h = await handler();
    h(key({ key: "Escape" }));
    expect(useCableStore.getState().wired).toBe("off");
  });

  // ══ ONE PHYSICAL PRESS IS ONE PRESS (roborev 55769) ═════════════════════════════════════════════
  // `attachCustomKeyEventHandler` is called for KEYUP and KEYPRESS as well as keydown — xterm's `_keyUp`
  // and `_keyPress` both run it, and `keyup` is bound on the textarea in `_bindKeys`. Without a type
  // guard, the keydown paid the toll and the keyup of the SAME press found it paid and released the
  // cable, collapsing "Escape twice" into one press in a terminal the user was working in. The old
  // tests could not see it: they only ever delivered keydown.
  it("does not let the keyup of the same press spend the toll", async () => {
    resetCable();
    resetTerminalFocusIntent();
    clearTerminalEscapeToll();
    useCableStore.getState().patch("right");

    const h = await handler();
    expect(dataHandler.fn).not.toBeNull();
    dataHandler.fn!("x"); // the user is working here, so the toll applies

    h(key({ key: "Escape" })); // keydown — pays the toll
    h(new KeyboardEvent("keyup", { key: "Escape", bubbles: true })); // must be ignored
    expect(useCableStore.getState().wired).toBe("right");

    // …and the real second press still releases, so the guard did not simply break the gesture.
    h(key({ key: "Escape" }));
    expect(useCableStore.getState().wired).toBe("off");
  });

  // AN AUTOREPEAT IS NOT A SECOND PRESS. macOS delivers keydown #2 after ~120-500ms, far inside the
  // toll's 5s window, so HOLDING Escape would pay and then release without the user pressing twice.
  // `Workspace` has carried this guard since roborev 55491; it was left behind when the decision moved.
  it("ignores an autorepeat keydown", async () => {
    resetCable();
    resetTerminalFocusIntent();
    clearTerminalEscapeToll();
    useCableStore.getState().patch("right");

    const h = await handler();
    dataHandler.fn!("x");
    h(key({ key: "Escape" }));
    h(key({ key: "Escape", repeat: true }));
    expect(useCableStore.getState().wired).toBe("right");
  });

  // THE SAME PREDICATE AS THE WINDOW PATH. A focused terminal means a surface's own window-level Escape
  // handler never fires (xterm cancels propagation), so without this an Escape aimed at an open menu
  // silently dropped the cable while leaving the menu up.
  it("declines while a dismissible surface is open", async () => {
    resetCable();
    resetTerminalFocusIntent();
    clearTerminalEscapeToll();
    useCableStore.getState().patch("right");

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);

    const h = await handler();
    h(key({ key: "Escape" }));
    expect(useCableStore.getState().wired).toBe("right");

    menu.remove();
    // With it closed, the same press releases — so this declined for the menu, not for some other reason.
    h(key({ key: "Escape" }));
    expect(useCableStore.getState().wired).toBe("off");
  });

  it("lets the byte through on the very press that releases", async () => {
    resetCable();
    resetTerminalFocusIntent();
    clearTerminalEscapeToll();
    useCableStore.getState().patch("right");

    const h = await handler();
    // `true` is xterm's go-ahead. The cable moved AND the process gets its ESC — never one instead of
    // the other, which is what makes the Escape-Escape collision affordable rather than a stolen key.
    expect(h(key({ key: "Escape" }))).toBe(true);
    expect(useCableStore.getState().wired).toBe("off");
  });
});
