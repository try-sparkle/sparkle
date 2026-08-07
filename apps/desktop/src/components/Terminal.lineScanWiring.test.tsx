// @vitest-environment jsdom
//
// DOES A MOUNTED TERMINAL ROUTE ITS KEYSTROKES THROUGH THE SHARED SCANNER? Every other guard on the
// raw-terminal input path drives `terminalSubmit` directly — the trial meter, the registry suite —
// so all of them stay green if `Terminal.tsx` stops calling `noteUserInput` and scans a private
// state instead. That wiring carries the free-trial debit (`onSubmitLine` → `recordTrialSend`) and
// the `drafts` flag the action pill and the compose-focus veto read, and nobody asserted the
// component end of it (roborev 59775). It mounts the REAL component against a stubbed xterm and
// drives the captured `onData` callback — the same function xterm hands the app for user keys.
//
// WHAT IT DELIBERATELY DOES *NOT* PIN: that `registerLineScan` ran. `noteUserInput` creates the
// state on a miss (fail-closed, so a lost registration can never silently stop metering), which
// means "registered" is no longer separately observable from out here — deleting the register call
// leaves every assertion below green. That is the intended consequence of the fail-closed lookup,
// not a hole: the invariant worth protecting is "user input is always scanned and published", and
// that is what these cases fail on. Verified by hand-mutation: bypassing `noteUserInput` reds the
// first case; removing the registration alone does not, and must not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";

const { dataHandler, writes } = vi.hoisted(() => ({
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
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";

const AGENT = "agent-1";
const baseProps = {
  agentId: AGENT,
  projectId: "proj-1",
  projectRootPath: "/repo",
  command: "claude",
  args: [] as string[],
  cwd: "/repo",
  active: true,
  onStatus: () => {},
};

beforeEach(() => {
  dataHandler.fn = null;
  writes.length = 0;
  useTerminalOverlayStore.setState({ drafts: {} });
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
  useTerminalOverlayStore.setState({ drafts: {} });
  vi.unstubAllGlobals();
});

/** Mount the real Terminal and wait for xterm's `onData` callback to be registered. */
async function mountTerminal(onSubmitLine?: () => void) {
  const view = render(<Terminal {...baseProps} onSubmitLine={onSubmitLine} />);
  await waitFor(() => expect(dataHandler.fn).not.toBeNull());
  return view;
}

describe("a mounted Terminal routes its onData through the shared line scanner", () => {
  it("publishes the pending-line flag as the user types", async () => {
    await mountTerminal();

    act(() => dataHandler.fn!("git comm"));

    // Only true if `registerLineScan` ran AND `onData` went through `noteUserInput`: the flag is
    // derived from the registered state, so a missing registration leaves this undefined.
    expect(useTerminalOverlayStore.getState().drafts[AGENT]).toBe(true);
  });

  it("reports the submit to onSubmitLine — the free-trial debit hangs off this call", async () => {
    const onSubmitLine = vi.fn();
    await mountTerminal(onSubmitLine);

    act(() => dataHandler.fn!("make me a website"));
    act(() => dataHandler.fn!("\r"));

    expect(onSubmitLine).toHaveBeenCalledTimes(1);
    // …and the line is empty again, so the pill comes back and the caret is fair game.
    expect(useTerminalOverlayStore.getState().drafts[AGENT]).toBeFalsy();
  });

  it("does NOT report a bare Enter (nothing was submitted, so nothing is debited)", async () => {
    const onSubmitLine = vi.fn();
    await mountTerminal(onSubmitLine);

    act(() => dataHandler.fn!("\r"));

    expect(onSubmitLine).not.toHaveBeenCalled();
  });
});
