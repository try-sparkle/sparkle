// @vitest-environment jsdom
//
// The terminal is blank for the seconds between spawning the PTY and Claude's first byte of
// output — on a fresh start (Claude's banner load) and, more visibly, on `claude --resume`
// redrawing a large transcript. With the sidebar already showing a named, "working" agent, that
// blank reads as broken (the empty-cloud-code report). These tests pin the loading affordance:
// until the first PTY chunk arrives the pane shows "Resuming conversation…" (resume) or
// "Starting…" (fresh — generic so it's accurate for both Claude and raw shell agents); the first
// chunk clears it.
//
// xterm needs a real canvas/WebGL renderer, so the renderer + addons + PTY bridge are mocked to
// thin fakes; we're testing the component's loading wiring, not xterm itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// Capture the onPtyOutput subscriber so a test can push a chunk through it (hoisted so vi.mock
// can reference it).
const { outputCbRef, exitCbRef } = vi.hoisted(() => ({
  outputCbRef: { cb: null as null | ((e: { id: string; chunk: string }) => void) },
  exitCbRef: { cb: null as null | ((e: { id: string }) => void) },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    options: Record<string, unknown> = {};
    buffer = { active: { type: "normal" } };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    loadAddon(): void {}
    open(parent: HTMLElement): void {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { value: 720, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: 380, configurable: true });
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

vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {
  fit(): void {}
} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {
  constructor(_handler: unknown) {}
} }));
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
  onPtyOutput: vi.fn((cb: (e: { id: string; chunk: string }) => void) => {
    outputCbRef.cb = cb;
    return Promise.resolve(() => {});
  }),
  onPtyExit: vi.fn((cb: (e: { id: string }) => void) => {
    exitCbRef.cb = cb;
    return Promise.resolve(() => {});
  }),
  ignorePtyGone: vi.fn(),
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

beforeEach(() => {
  outputCbRef.cb = null;
  exitCbRef.cb = null;
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

// Flush the async IIFE that subscribes to onPtyOutput + spawns, so outputCbRef.cb is set.
async function flushMount(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Terminal loading state", () => {
  it("shows 'Resuming conversation…' before any output when resuming", async () => {
    render(<Terminal {...baseProps} resuming={true} />);
    await flushMount();
    expect(screen.getByText(/Resuming conversation/)).toBeTruthy();
  });

  it("shows 'Starting…' before any output on a fresh start", async () => {
    render(<Terminal {...baseProps} resuming={false} />);
    await flushMount();
    expect(screen.getByText(/^Starting…$/)).toBeTruthy();
  });

  it("clears the loading state once the first PTY chunk arrives", async () => {
    render(<Terminal {...baseProps} resuming={true} />);
    await flushMount();
    expect(screen.getByText(/Resuming conversation/)).toBeTruthy();

    await act(async () => {
      outputCbRef.cb?.({ id: "agent-1", chunk: "hello\r\n" });
    });

    expect(screen.queryByText(/Resuming conversation/)).toBeNull();
  });

  it("clears the loading state when the PTY exits even with no output (silent raw command)", async () => {
    render(<Terminal {...baseProps} resuming={false} />);
    await flushMount();
    expect(screen.getByText(/^Starting…$/)).toBeTruthy();

    await act(async () => {
      exitCbRef.cb?.({ id: "agent-1" });
    });

    expect(screen.queryByText(/^Starting…$/)).toBeNull();
  });

  it("ignores output addressed to a different agent (stays in loading state)", async () => {
    render(<Terminal {...baseProps} resuming={false} />);
    await flushMount();

    await act(async () => {
      outputCbRef.cb?.({ id: "some-other-agent", chunk: "noise" });
    });

    expect(screen.getByText(/^Starting…$/)).toBeTruthy();
  });
});
