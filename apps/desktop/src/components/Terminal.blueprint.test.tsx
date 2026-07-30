// @vitest-environment jsdom
//
// The terminal pane, ported to the Blueprint cockpit direction. Two things are guarded here and
// they pull in opposite directions, which is why they share a file:
//
//   1. THE PANE LOOKS LIKE THE DIRECTION — its surface is the spec's `term` plane, its text is the
//      terminal's OWN ink register (not the shell's `cream`/`muted`), and every rule it draws is
//      `termHairline` rather than the chrome hairline. Six releases shipped against this design
//      without matching it, so these are assertions, not comments.
//
//   2. GETTING THERE DOES NOT COST A PTY. `termInk`/`termMuted` have no CSS variable, so a theme
//      flip re-renders this component — and a Terminal UNMOUNT KILLS ITS PTY. The re-theme tests
//      below assert that flipping the resolved theme pushes a fresh xterm theme through the LIVE
//      terminal while the xterm constructor is called exactly once and the transport is never
//      detached. If a future edit keys, wraps or conditionally structures this component on the
//      theme, the constructor count moves and this fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// How many xterm cores have been constructed, and every theme object ever pushed onto the live one.
// Hoisted so the vi.mock factory can close over them.
const { constructed, themeWrites, detached, themeRef, spawnCtl } = vi.hoisted(() => ({
  constructed: { count: 0 },
  themeWrites: [] as Array<Record<string, unknown>>,
  detached: { count: 0 },
  themeRef: { value: "dark" as "light" | "dark" },
  // Flip to make the spawn chain reject, which is how the component reaches its "Couldn't start
  // the agent — Start again" affordance (resolveTerminalOverlay's `fail` branch).
  spawnCtl: { fail: false },
}));

vi.mock("@xterm/xterm", () => {
  class Terminal {
    // `options.theme` is what the component drives; record every assignment so the re-theme effect
    // is observable without standing up a real renderer.
    options: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
      set(target, prop, value) {
        if (prop === "theme") themeWrites.push(value as Record<string, unknown>);
        target[prop as string] = value;
        return true;
      },
    });
    buffer = { active: { type: "normal" } };
    modes = { applicationCursorKeysMode: false };
    cols = 80;
    rows = 24;
    element: HTMLElement | undefined;
    constructor(opts: Record<string, unknown>) {
      constructed.count += 1;
      // The constructor-time theme counts as a write: it is the same xtermTheme() call.
      if (opts.theme) themeWrites.push(opts.theme as Record<string, unknown>);
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

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(_handler: unknown) {}
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    clearTextureAtlas(): void {}
    dispose(): void {}
  },
}));

// The transport seam. `detach()` is the call that tears an agent's PTY down — counting it is how
// "no remount" becomes a statement about the PTY rather than about React internals.
vi.mock("../services/agentTransport", () => ({
  getTransport: () => ({
    spawn: vi.fn(() => (spawnCtl.fail ? Promise.reject(new Error("no claude")) : Promise.resolve())),
    write: vi.fn(),
    resize: vi.fn(),
    detach: vi.fn(() => {
      detached.count += 1;
      return Promise.resolve();
    }),
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
// Drive the resolved theme from a mutable ref so a test can flip it between renders — this is the
// `<html data-theme>` flip, from the component's point of view.
vi.mock("../theme/theme", () => ({ useResolvedTheme: () => themeRef.value }));

import { Terminal } from "./Terminal";
import { THEME_HEX, C } from "../theme/colors";
import { TERM_HAIRLINE, TERM_PLANE, TERM_TYPE, termInk, termMuted } from "./terminalChrome";

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
  constructed.count = 0;
  themeWrites.length = 0;
  detached.count = 0;
  themeRef.value = "dark";
  spawnCtl.fail = false;
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

/** The component's outermost element — the pane's surface. */
function paneRoot(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

/** The DEEPEST element whose text matches — an ancestor's textContent matches too, and picking the
 *  first one silently asserts against the wrong node's styles. */
function deepestWithText(container: HTMLElement, re: RegExp): HTMLElement {
  const hits = [...container.querySelectorAll<HTMLElement>("*")].filter((el) =>
    re.test(el.textContent ?? ""),
  );
  const el = hits.at(-1);
  if (!el) throw new Error(`no element matching ${re}`);
  return el;
}

/** jsdom serialises an inline `color` to `rgb(r, g, b)`, so compare on a normal form. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

describe("Terminal — the pane IS the spec's `term` plane", () => {
  it("paints its own surface in the term plane", () => {
    const { container } = render(<Terminal {...baseProps} />);
    expect(paneRoot(container).style.background).toBe(TERM_PLANE);
  });

  it("draws NO vertical rule on the build boundary — build and terminal are one thing", () => {
    // The direction is explicit ("NO divider inside a pair"), and the selected agent row bleeds
    // across this edge. A border here turns that opening into a dock.
    const root = paneRoot(render(<Terminal {...baseProps} />).container);
    for (const side of ["borderLeft", "borderRight", "border"] as const) {
      expect(root.style[side], `${side} must stay unset on the pane's surface`).toBe("");
    }
  });
});

describe("Terminal — chrome takes the terminal's ink register and the terminal's rule", () => {
  it("the loading affordance is the pane's SECONDARY ink, not a faded shell ink", () => {
    // `resuming` + no PTY output yet ⇒ the loading overlay. Its text is read directly on the term
    // plane, so `termMuted` is the register; `C.cream` is the SHELL's ink and would be wrong here.
    const { container } = render(<Terminal {...baseProps} resuming />);
    const hint = deepestWithText(container, /Resuming|Starting/i);
    expect(hint.style.color).toBe(rgb(termMuted("dark")));
    // `C.cream` is the SHELL's ink — a var(), so it would serialise verbatim and never equal this.
    expect(hint.style.color).not.toBe(C.cream);
    expect(hint.style.fontSize).toBe(`${TERM_TYPE.body}px`);
    // Secondary by TOKEN, not by opacity — a dimmed primary composites against nothing measured.
    expect(hint.style.opacity).toBe("");
  });

  it("the copy flash is a chip on this plane, so its edge is `termHairline`", () => {
    const { container } = render(<Terminal {...baseProps} />);
    const flash = deepestWithText(container, /Copied to clipboard/);
    expect(flash.style.border).toBe(`1px solid ${TERM_HAIRLINE}`);
    // NOT the chrome hairline, and not a chrome FILL pressed into service as an edge. Neither is
    // floored against the terminal plane (theme/chromeContrast.test.ts skips that pair on purpose).
    expect(flash.style.border).not.toContain(C.hairline);
    expect(flash.style.fontSize).toBe(`${TERM_TYPE.small}px`);
  });
});

describe("Terminal — xterm is themed from THEME_HEX and re-themes on a data-theme flip", () => {
  it("takes its background and foreground from THEME_HEX, not from literals", () => {
    render(<Terminal {...baseProps} />);
    expect(themeWrites.length).toBeGreaterThan(0);
    const theme = themeWrites.at(-1)!;
    expect(theme.background).toBe(THEME_HEX.dark.forest);
    expect(theme.foreground).toBe(THEME_HEX.dark.cream);
  });

  it("pushes a fresh theme into the LIVE terminal when the resolved theme flips", () => {
    const { rerender } = render(<Terminal {...baseProps} />);
    expect(themeWrites.at(-1)!.background).toBe(THEME_HEX.dark.forest);

    themeRef.value = "light";
    rerender(<Terminal {...baseProps} />);

    expect(themeWrites.at(-1)!.background).toBe(THEME_HEX.light.forest);
    expect(themeWrites.at(-1)!.foreground).toBe(THEME_HEX.light.cream);
  });

  // ── THE SAFETY CONSTRAINT ────────────────────────────────────────────────────────────────────
  it("re-themes WITHOUT remounting — one xterm core, and the PTY is never detached", () => {
    const { rerender } = render(<Terminal {...baseProps} />);
    expect(constructed.count).toBe(1);

    themeRef.value = "light";
    rerender(<Terminal {...baseProps} />);
    themeRef.value = "dark";
    rerender(<Terminal {...baseProps} />);

    // A remount would construct a second xterm and detach the first one's transport — i.e. kill
    // the agent's PTY and lose its session — while every visual assertion above still passed.
    expect(constructed.count, "a theme flip must not construct a second xterm").toBe(1);
    expect(detached.count, "a theme flip must not tear down the PTY").toBe(0);
  });

  it("survives a resize and a selection change the same way", () => {
    // The other two events the direction's port touches. Same contract: the pane may re-render, it
    // may not re-mount.
    const { rerender } = render(<Terminal {...baseProps} active={false} />);
    expect(constructed.count).toBe(1);
    rerender(<Terminal {...baseProps} active={true} />);
    rerender(<Terminal {...baseProps} active={false} />);
    expect(constructed.count).toBe(1);
    expect(detached.count).toBe(0);
  });
});

describe("Terminal — the failed-spawn affordance", () => {
  it("takes the terminal's PRIMARY ink and draws its button with the terminal's rule", async () => {
    // Reach the state the way it actually happens: the spawn chain rejects.
    spawnCtl.fail = true;
    const { container } = render(<Terminal {...baseProps} />);

    const button = await waitFor(() => screen.getByRole("button", { name: /Start again/ }));
    // The retry control's edge is a rule drawn ON the terminal plane.
    expect(button.style.border).toBe(`1px solid ${TERM_HAIRLINE}`);
    expect(button.style.borderRadius).toBe("4px"); // --r-in, near-square
    // Primary ink here — this is the pane telling you something, not a quiet hint.
    expect(button.style.color).toBe(rgb(termInk("dark")));
    // …and the message beside it is the SECONDARY tier of the same register.
    const message = deepestWithText(container, /Couldn't start|exited/i);
    expect(message.style.color).toBe(rgb(termMuted("dark")));
  });

  it("leaks no shell-register token into the pane's chrome", () => {
    // A blunt sweep over the rendered markup: `C.hairline` / `C.muted` are `var()` strings, so if
    // either is still painted anywhere on this plane it appears here verbatim.
    spawnCtl.fail = false;
    const { container } = render(<Terminal {...baseProps} resuming />);
    expect(container.innerHTML).not.toContain(C.hairline);
    expect(container.innerHTML).not.toContain(C.muted);
  });
});
