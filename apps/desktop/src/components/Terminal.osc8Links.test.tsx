// @vitest-environment jsdom
//
// Regression guard: clicking an OSC 8 hyperlink in terminal output must open the OS default
// browser, not silently do nothing.
//
// Two link paths exist and they are matched by DIFFERENT layers. WebLinksAddon matches bare URLs
// in the output; xterm CORE matches OSC 8 escape-sequence hyperlinks (the ones that make a word
// clickable) and routes them to `options.linkHandler`, never to the addon. We passed a handler to
// the addon but left linkHandler unset, so OSC 8 clicks fell to core's stock handler, which calls
// window.confirm() and then window.open(). In the Tauri webview confirm is shimmed onto
// `plugin:dialog|confirm` — a command our capability does not grant — so it rejected as an
// unhandled rejection, and window.open is blocked for external URLs. The click did nothing.
//
// These assert the WIRING: both paths reach openUrl and preventDefault the event. The renderer,
// addons and PTY are mocked to thin fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Captures what Terminal handed to each link path (hoisted so vi.mock can close over them).
const { optionsRef, addonHandlerRef } = vi.hoisted(() => ({
  optionsRef: { value: null as null | Record<string, unknown> },
  addonHandlerRef: { handler: null as null | ((e: MouseEvent, uri: string) => void) },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    buffer = { active: { type: "normal" } };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    constructor(opts: Record<string, unknown>) {
      optionsRef.value = opts;
    }
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
      // xterm's WebglAddon appends its own webgl2 canvas here. Terminal locates it to release the
      // GPU context and to watch for webglcontextlost, and REFUSES to keep a renderer whose canvas
      // it cannot find (an unwatchable renderer goes solid black on context loss). A mock without
      // this canvas is not a WebGL-rendered terminal, so it cannot exercise the WebGL paths below.
      const glCanvas = document.createElement("canvas");
      Object.defineProperty(glCanvas, "getContext", {
        value: (id: string) =>
          id === "webgl2" ? { getExtension: () => ({ loseContext: () => {} }) } : null,
        configurable: true,
      });
      el.appendChild(glCanvas);
      parent.appendChild(el);
      this.element = el;
    }
    onData(): void {}
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerMarker(): null {
      return null;
    }
    refresh(): void {}
    scrollLines(): void {}
    focus(): void {}
    scrollToLine(): void {}
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
    constructor(h: (e: MouseEvent, uri: string) => void) {
      addonHandlerRef.handler = h;
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));
vi.mock("../pty", () => ({
  spawnPty: vi.fn(() => Promise.resolve()),
  writePty: vi.fn(() => Promise.resolve()),
  killPty: vi.fn(() => Promise.resolve()),
  resizePty: vi.fn(() => Promise.resolve()),
  onPtyOutput: vi.fn(() => Promise.resolve(() => {})),
  onPtyExit: vi.fn(() => Promise.resolve(() => {})),
  ignorePtyGone: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../clipboard", () => ({ copyToClipboard: vi.fn(() => Promise.resolve(true)) }));
vi.mock("../engine/statusEngine", () => ({
  StatusEngine: class {
    constructor(_o: unknown) {}
    ingest(): void {}
    exit(): void {}
    dispose(): void {}
  },
}));
vi.mock("../theme/theme", () => ({ useResolvedTheme: () => "dark" }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "./Terminal";

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

function fakeClick(): MouseEvent {
  return { preventDefault: vi.fn() } as unknown as MouseEvent;
}

beforeEach(() => {
  optionsRef.value = null;
  addonHandlerRef.handler = null;
  vi.mocked(openUrl).mockClear();
  Object.defineProperty(document, "fonts", {
    value: { ready: Promise.resolve() },
    configurable: true,
  });
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
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("terminal link activation", () => {
  it("gives xterm core a linkHandler, so OSC 8 clicks never reach the stock confirm/window.open", () => {
    render(<Terminal {...baseProps} />);

    const handler = optionsRef.value?.linkHandler as
      | { activate?: (e: MouseEvent, uri: string) => void }
      | undefined;
    expect(handler?.activate).toBeTypeOf("function");

    const event = fakeClick();
    handler!.activate!(event, "https://example.com/docs");

    expect(event.preventDefault).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("keeps routing bare URLs (the WebLinksAddon path) through the opener too", () => {
    render(<Terminal {...baseProps} />);

    expect(addonHandlerRef.handler).toBeTypeOf("function");
    const event = fakeClick();
    addonHandlerRef.handler!(event, "https://example.com/raw");

    expect(event.preventDefault).toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://example.com/raw");
  });
});
