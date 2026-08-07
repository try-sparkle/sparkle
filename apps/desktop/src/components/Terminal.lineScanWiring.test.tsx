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

/** Mount ANOTHER Terminal for the same agent and wait until xterm hands us ITS `onData` — the
 *  account-switch shape (`AgentPane` keys the terminal on the account while `agentId` stays put).
 *  The mock's `onData` is last-writer-wins, so a changed function identity is the signal that the
 *  new instance is the live one. */
async function remountTerminal(onSubmitLine?: () => void) {
  const previous = dataHandler.fn;
  const view = render(<Terminal {...baseProps} onSubmitLine={onSubmitLine} />);
  await waitFor(() => expect(dataHandler.fn).not.toBe(previous));
  return view;
}

describe("a mounted Terminal routes its onData through the shared line scanner", () => {
  it("publishes the pending-line flag as the user types", async () => {
    await mountTerminal();

    act(() => dataHandler.fn!("git comm"));

    // What this pins: the keystroke was SCANNED and the flag PUBLISHED, i.e. `onData` went through
    // `noteUserInput`. It does NOT pin that `registerLineScan` ran — the fail-closed lookup creates
    // the state on a miss, so this is `true` with the registration deleted. See the header; an
    // earlier version of this comment claimed the opposite and contradicted it (roborev 60086),
    // which is how a maintainer ends up believing a gap is covered when nothing covers it.
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

// ══ THE CALLER SIDE OF THE IDENTITY CONTRACT ═════════════════════════════════════════════════════
// `terminalSubmit.registry.test.ts` proves `unregisterLineScan` HONOURS the state it is given. That
// says nothing about whether this component still GIVES it one: dropping the second argument at the
// `unregisterLineScan(agentId, lineScan)` call site restores the exact defect roborev 59775 found —
// a remount's outgoing cleanup stripping the live instance's scanner — and left all fourteen tests
// green, under a code comment claiming the invariant was protected. Guard vacuity relocated one
// layer up (roborev 60097).
describe("a remount's stale teardown does not strip the LIVE terminal's scanner", () => {
  it("keeps the line the user is typing across an account-switch remount", async () => {
    const outgoing = vi.fn();
    const live = vi.fn();
    const first = await mountTerminal(outgoing);
    await remountTerminal(live); // React mounts the replacement BEFORE the old effect's cleanup

    // Typed into the LIVE instance, while both are mounted.
    act(() => dataHandler.fn!("make me a website"));
    // …and now the outgoing instance tears down, late, for the same agentId.
    act(() => first.unmount());

    // THE FLAG MUST SURVIVE THAT TEARDOWN TOO, and this assertion is why the case is here twice.
    // An earlier version of this file called the flag undiscriminating because it read `false` in
    // both worlds — but `false` here IS the bug: the live scanner is holding an unsubmitted line, so
    // the honest answer is `true`. The outgoing instance's `clearDraft(agentId)` was keyed on the
    // agent id alone, so it wiped the live instance's flag, and nothing republishes it until the
    // user's next keystroke — un-hiding the recommended-action pill and lifting the compose-focus
    // veto over a prompt they are mid-typing (roborev 60111).
    expect(useTerminalOverlayStore.getState().drafts[AGENT]).toBe(true);

    act(() => dataHandler.fn!("\r"));

    // …and the scanner kept the line: a stripped one is lazily recreated EMPTY, so the Enter would
    // submit nothing and this call would never come — a prompt the user typed and sent, going
    // unmetered and unreported.
    expect(live).toHaveBeenCalledTimes(1);
    expect(outgoing).not.toHaveBeenCalled();
  });

  it("clears the flag when the LINE BELONGED TO THE OUTGOING instance", async () => {
    // The mirror of the case above, and the one an ownership check gets wrong: the user typed into
    // the FIRST terminal, then the account switch mounted a replacement whose scanner starts EMPTY.
    // "Skip the clear because I no longer own the registration" strands `true` over that empty
    // prompt — the pill stays hidden and the compose-focus veto stays on until the user types again,
    // which is roborev 57372's "true forever" shape relocated to the remount (roborev 60124).
    const first = await mountTerminal();
    act(() => dataHandler.fn!("half a command"));
    expect(useTerminalOverlayStore.getState().drafts[AGENT]).toBe(true);

    await remountTerminal(); // the replacement registers an EMPTY scanner
    act(() => first.unmount());

    // The live prompt is empty — the outgoing instance's readline buffer died with its PTY.
    expect(useTerminalOverlayStore.getState().drafts[AGENT]).toBeFalsy();
  });

  it("STILL clears the flag when the ONLY terminal tears down", async () => {
    // The anti-over-fix, and it is load-bearing: leaving the flag alone on teardown would hide the
    // action pill for the life of the tab (roborev 57372). No ownership test is involved — this
    // teardown removed the only scanner, so the re-derivation finds none and lands on `false`.
    const view = await mountTerminal();
    act(() => dataHandler.fn!("half a command"));
    expect(useTerminalOverlayStore.getState().drafts[AGENT]).toBe(true);

    act(() => view.unmount());

    expect(useTerminalOverlayStore.getState().drafts[AGENT]).toBeFalsy();
  });
});
