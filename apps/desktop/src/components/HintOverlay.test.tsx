// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HintOverlay } from "./HintOverlay";
import { AGENT_OVERFLOW_POOL, PAIR_PREFIX } from "../keyboardHints/hintTargets";
import { configure } from "@testing-library/dom";

// This suite drove PR #633's coverage-only flake: RTL waitFor on REAL timers, whose 1000ms
// default is tripped by v8 instrumentation load on a 2-vCPU CI runner. The coverage gate is
// blocking, so raise the async deadline for THIS file only — it uses no fake timers, so there is
// no virtual-clock coupling (). testTimeout (vite.config) sits above this at 15s.
configure({ asyncUtilTimeout: 5000 });

// jsdom gives every element a 0×0 rect and a null offsetParent, which our visibility filter would
// reject. Stub both so tagged controls count as on-screen during the test.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 10, top: 10, left: 10, right: 50, bottom: 30, width: 40, height: 20,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // restoreAllMocks doesn't undo defineProperty; delete the stubbed accessor.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent;
});

// A clean Control tap = Control keydown then keyup with nothing in between (the default trigger).
function controlTap() {
  fireEvent.keyDown(window, { key: "Control" });
  fireEvent.keyUp(window, { key: "Control" });
}

describe("HintOverlay", () => {
  it("shows no chiclets until a clean Control tap", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    expect(screen.queryByText("t")).toBeNull();
    controlTap();
    expect(screen.getByText("t")).toBeTruthy();
  });

  it("numbers agent rows by order and fires the target's click on its label key", async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <>
        <div data-hint="agent" onClick={onFirst}>Agent one</div>
        <div data-hint="agent" onClick={onSecond}>Agent two</div>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();

    fireEvent.keyDown(window, { key: "2" });
    await waitFor(() => expect(onSecond).toHaveBeenCalledTimes(1));
    expect(onFirst).not.toHaveBeenCalled();
    // Overlay dismisses after activation.
    await waitFor(() => expect(screen.queryByText("2")).toBeNull());
  });

  it("letters project tabs and hands the agent overflow the NEXT letters, not the same ones", async () => {
    const onTabA = vi.fn();
    const onTabB = vi.fn();
    render(
      <>
        <div data-hint="project-tab" onClick={onTabA}>amforge</div>
        <div data-hint="project-tab" onClick={onTabB}>sparkle-desktop</div>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} data-hint="agent" onClick={() => {}}>{`Agent ${i + 1}`}</div>
        ))}
        <HintOverlay />
      </>,
    );
    controlTap();
    // Two tabs take the first two pool letters; the 10th agent — the first to spill past 1..9 —
    // resumes at the THIRD, so no key is claimed twice and every badge is reachable.
    expect(screen.getByText(AGENT_OVERFLOW_POOL[0]!)).toBeTruthy();
    expect(screen.getByText(AGENT_OVERFLOW_POOL[1]!)).toBeTruthy();
    expect(screen.getByText(AGENT_OVERFLOW_POOL[2]!)).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();

    fireEvent.keyDown(window, { key: AGENT_OVERFLOW_POOL[1]! });
    await waitFor(() => expect(onTabB).toHaveBeenCalledTimes(1));
    expect(onTabA).not.toHaveBeenCalled();
  });

  it("a second Control tap dismisses without activating anything", () => {
    const onClick = vi.fn();
    render(
      <>
        <button data-hint="build" onClick={onClick}>Build</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("b")).toBeTruthy();
    controlTap();
    expect(screen.queryByText("b")).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("badges only the Recent-dropdown rows (a,b,c) and suppresses chrome while it's open", async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <>
        <button data-hint="recent" onClick={() => {}}>Recent</button>
        <div data-hint="recent-item" onClick={onFirst}>amforge</div>
        <div data-hint="recent-item" onClick={onSecond}>sparkle-desktop</div>
        <HintOverlay />
      </>,
    );
    controlTap();
    // The chrome "r" mnemonic is suppressed while the dropdown rows are present.
    expect(screen.queryByText("r")).toBeNull();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();

    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() => expect(onSecond).toHaveBeenCalledTimes(1));
    expect(onFirst).not.toHaveBeenCalled();
  });

  // A harness whose "recent" trigger opens the dropdown on click, exactly like the real top bar:
  // the rows only exist once the button has been activated.
  function RecentDropdownHarness({
    onFirst = () => {},
    onSecond = () => {},
  }: {
    onFirst?: () => void;
    onSecond?: () => void;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button data-hint="recent" onClick={() => setOpen(true)}>Recent</button>
        {open && (
          <>
            <div data-hint="recent-item" onClick={onFirst}>amforge</div>
            <div data-hint="recent-item" onClick={onSecond}>sparkle-desktop</div>
          </>
        )}
        <HintOverlay />
      </>
    );
  }

  it("opening Recent via the 'r' hint keeps hint mode active and shows the row a–z badges", async () => {
    render(<RecentDropdownHarness />);
    controlTap();
    // Dropdown still closed: only the chrome "r" mnemonic exists, no row badges yet.
    expect(screen.getByText("r")).toBeTruthy();
    expect(screen.queryByText("a")).toBeNull();

    fireEvent.keyDown(window, { key: "r" });
    // The overlay must NOT close: once the dropdown rows mount, a re-collect swaps in the a–z row
    // badges so the user can chain straight into picking a project.
    await waitFor(() => expect(screen.getByText("a")).toBeTruthy());
    expect(screen.getByText("b")).toBeTruthy();
    // In dropdown mode the chrome "r" badge is suppressed — proof hint mode re-collected, not that
    // it merely stayed on the pre-open placement.
    expect(screen.queryByText("r")).toBeNull();
  });

  it("opening Recent via 'r' when there are NO recent projects closes instead of stranding the overlay", async () => {
    // The trigger opens, but the dropdown has no rows to badge. Staying open would leave the user on
    // a "stuck" chrome overlay still showing the r badge with nothing to pick — so it must close.
    function EmptyRecentHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-hint="recent" onClick={() => setOpen(true)}>Recent</button>
          {open && <div data-testid="empty-dropdown" />}
          <HintOverlay />
        </>
      );
    }
    render(<EmptyRecentHarness />);
    controlTap();
    expect(screen.getByText("r")).toBeTruthy();

    fireEvent.keyDown(window, { key: "r" });
    // After the deferred re-collect finds no recent-item rows, the overlay dismisses.
    await waitFor(() => expect(screen.queryByText("r")).toBeNull());
  });

  it("with the Recent dropdown open, an a–z letter selects that project and closes", async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(<RecentDropdownHarness onFirst={onFirst} onSecond={onSecond} />);
    controlTap();
    fireEvent.keyDown(window, { key: "r" }); // open the dropdown, staying in hint mode
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    fireEvent.keyDown(window, { key: "b" }); // a recent-item row: close()+click branch
    await waitFor(() => expect(onSecond).toHaveBeenCalledTimes(1));
    expect(onFirst).not.toHaveBeenCalled();
    // Selecting a project dismisses the overlay (rows are recent-item, not the recent trigger).
    await waitFor(() => expect(screen.queryByText("b")).toBeNull());
  });

  it("binds the key listener ONCE and never rebinds it as the badges change", async () => {
    // THE REGRESSION GUARD for the dropped keystroke (and the CI flake it surfaced as).
    //
    // The listener used to be bound from an effect that depended on `chiclets`, so every re-collect
    // tore it down and bound a new one. React runs passive effects after paint, which opens a real
    // window between "the new badges are on screen" and "the listener that knows about them is
    // live". A key pressed in that window resolves against the STALE array, finds no match, and is
    // swallowed by the printable-key guard — silently, because an unmatched label is a deliberate
    // no-op. That window is exactly where this feature invites you to type: opening Recent with "r"
    // keeps hint mode active precisely so you can pick a project in the same breath.
    //
    // Reading the live set through a ref removes the window. Asserting on the BINDING (rather than
    // trying to lose a race on purpose) is what makes this deterministic — a timing test would be
    // as flaky as the bug.
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const keydownBinds = () => add.mock.calls.filter(([t]) => t === "keydown").length;
    const keydownUnbinds = () => remove.mock.calls.filter(([t]) => t === "keydown").length;

    render(<RecentDropdownHarness onFirst={vi.fn()} onSecond={vi.fn()} />);
    controlTap();
    const boundOnOpen = keydownBinds();
    expect(boundOnOpen).toBeGreaterThan(0);

    // Open the dropdown: the chiclet set is replaced wholesale with the recent-item rows.
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());

    // The badges changed, so the OLD code would have unbound and rebound here. The listener must
    // survive untouched instead.
    expect(keydownBinds()).toBe(boundOnOpen);
    expect(keydownUnbinds()).toBe(0);

    add.mockRestore();
    remove.mockRestore();
  });

  it("a non-recent chrome control still closes the overlay and clicks the element", async () => {
    const onClick = vi.fn();
    render(
      <>
        <button data-hint="open" onClick={onClick}>Open</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("o")).toBeTruthy();
    fireEvent.keyDown(window, { key: "o" });
    await waitFor(() => expect(onClick).toHaveBeenCalledTimes(1));
    // Overlay dismisses immediately for every control except the Recent trigger.
    expect(screen.queryByText("o")).toBeNull();
  });

  it("skips a control hidden by `visibility`, so a covered duplicate can't win the mnemonic", async () => {
    // `offsetParent === null` catches `display: none` and NOTHING else — a `visibility: hidden`
    // element keeps its layout box, so it has an offsetParent and a plausible rect. That is the
    // repo's own way of saying "covered" (paneVisibilityStyle; the Build column under a pair's Plan
    // board), and the key handler takes the FIRST match in DOM order — so the hidden copy of a
    // duplicated control both drew a chiclet over an opaque surface and STOLE its key.
    const onHidden = vi.fn();
    const onShown = vi.fn();
    render(
      <>
        <div style={{ visibility: "hidden" }}>
          <button data-hint="build" onClick={onHidden}>covered Build</button>
        </div>
        <button data-hint="build" onClick={onShown}>the Build you can see</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    // ONE chiclet, not two — and pressing its key reaches the visible control.
    expect(screen.getAllByText("b")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() => expect(onShown).toHaveBeenCalledTimes(1));
    expect(onHidden).not.toHaveBeenCalled();
  });

  it("skips a control inside an inert subtree even when it re-declares itself visible", async () => {
    // The case `visibility` alone gets wrong, and the reason the covered column carries BOTH. It is
    // an INHERITED property, so a descendant can take it back — the status-filter Reset link does
    // exactly that whenever a filter is on. `inert` is not overridable from inside, so honouring it
    // here is what actually keeps a covered duplicate out of the overlay.
    const onCovered = vi.fn();
    const onShown = vi.fn();
    render(
      <>
        <div inert style={{ visibility: "hidden" }}>
          <button data-hint="build" style={{ visibility: "visible" }} onClick={onCovered}>
            covered but self-declared visible
          </button>
        </div>
        <button data-hint="build" onClick={onShown}>the Build you can see</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getAllByText("b")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() => expect(onShown).toHaveBeenCalledTimes(1));
    expect(onCovered).not.toHaveBeenCalled();
  });

  it("skips rows scrolled out of a clipping ancestor instead of badging them off-popover", () => {
    // The Recent dropdown is maxHeight + overflowY:auto. getBoundingClientRect reports UNCLIPPED
    // layout, so an overflowing row still claims a plausible rect — the bug that drew badges below
    // the popover over unrelated page content.
    const rects: Record<string, Partial<DOMRect>> = {
      list: { top: 100, bottom: 200, left: 0, right: 300, width: 300, height: 100 },
      visible: { top: 110, bottom: 140, left: 10, right: 290, width: 280, height: 30 },
      clipped: { top: 260, bottom: 290, left: 10, right: 290, width: 280, height: 30 },
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const r = rects[this.dataset.testrect ?? ""] ?? { top: 10, bottom: 30, left: 10, right: 50, width: 40, height: 20 };
      return { ...r, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    });

    render(
      <>
        <div data-testrect="list" style={{ overflowY: "auto" }}>
          <div data-testrect="visible" data-hint="recent-item" onClick={() => {}}>in view</div>
          <div data-testrect="clipped" data-hint="recent-item" onClick={() => {}}>scrolled out</div>
        </div>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("a")).toBeTruthy(); // the row actually on screen
    expect(screen.queryByText("b")).toBeNull(); // the clipped row gets no badge
  });

  it("still clips against a container that is BOTH position:fixed and a scroller", () => {
    // A fixed element escapes its ANCESTORS' clipping, but it still clips its own overflowing
    // children. Checking position:fixed before the clip box would wrongly badge the scrolled-out row.
    const rects: Record<string, Partial<DOMRect>> = {
      list: { top: 100, bottom: 200, left: 0, right: 300, width: 300, height: 100 },
      visible: { top: 110, bottom: 140, left: 10, right: 290, width: 280, height: 30 },
      clipped: { top: 260, bottom: 290, left: 10, right: 290, width: 280, height: 30 },
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const r = rects[this.dataset.testrect ?? ""] ?? { top: 10, bottom: 30, left: 10, right: 50, width: 40, height: 20 };
      return { ...r, x: r.left, y: r.top, toJSON: () => ({}) } as DOMRect;
    });

    render(
      <>
        <div data-testrect="list" style={{ position: "fixed", overflowY: "scroll" }}>
          <div data-testrect="visible" data-hint="recent-item" onClick={() => {}}>in view</div>
          <div data-testrect="clipped" data-hint="recent-item" onClick={() => {}}>scrolled out</div>
        </div>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.queryByText("b")).toBeNull();
  });

  it("badges Switch buttons after the rows and raises that window without opening here", async () => {
    const onOpenHere = vi.fn();
    const onSwitch = vi.fn();
    render(
      <>
        <div data-hint="recent-item" onClick={onOpenHere}>
          amforge
          <button
            data-hint="recent-switch"
            onClick={(e) => {
              e.stopPropagation();
              onSwitch();
            }}
          >
            Switch
          </button>
        </div>
        <div data-hint="recent-item" onClick={() => {}}>sparkle-desktop</div>
        <HintOverlay />
      </>,
    );
    controlTap();
    // Two rows take a and b; the switch continues the same stream at c.
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();

    fireEvent.keyDown(window, { key: "c" });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    // stopPropagation keeps the row's open-here handler from firing too.
    expect(onOpenHere).not.toHaveBeenCalled();
  });

  it("Escape dismisses the overlay", () => {
    render(
      <>
        <button data-hint="changelog" onClick={() => {}}>Changelog</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("c")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("c")).toBeNull();
  });

  it("does not spuriously open when focus is lost mid-tap (Ctrl held, then app switch)", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    // Control pressed, then the app loses focus before we ever see a chord (the OS swallows the
    // switch key), then focus returns and Control is released. The blur must have cleared the
    // latent tap candidate so the release doesn't fire a spurious tap.
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.blur(window);
    fireEvent.keyUp(window, { key: "Control" });
    expect(screen.queryByText("t")).toBeNull();
  });

  it("an unassigned key is a no-op and keeps the overlay open", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    // "q" is a pool letter, so nothing on screen claims it while only "t" is tagged. ("z" would be
    // the pair prefix, which is a different no-op — see the pair-layer suite.)
    fireEvent.keyDown(window, { key: "q" });
    expect(screen.getByText("t")).toBeTruthy(); // still open
  });

  it("the pair prefix alone does nothing when there is no pair label on screen", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: PAIR_PREFIX });
    // Still the ordinary layer: had it opened an EMPTY pair layer, "t" would have vanished and the
    // key would read as having killed the overlay.
    expect(screen.getByText("t")).toBeTruthy();
  });
});

// Enough project tabs to run the shared pool past its single characters and into the pairs. The
// LAST one is the first pair label, "za".
function tabsPastThePool(onLast: () => void) {
  return Array.from({ length: AGENT_OVERFLOW_POOL.length + 1 }, (_, i) => (
    <div
      key={i}
      data-hint="project-tab"
      onClick={i === AGENT_OVERFLOW_POOL.length ? onLast : () => {}}
    >
      {`Project ${i}`}
    </div>
  ));
}

describe("HintOverlay — the pair layer", () => {
  it("labels targets past the single characters za.. instead of dropping their badge", () => {
    render(
      <>
        {tabsPastThePool(() => {})}
        <HintOverlay />
      </>,
    );
    controlTap();
    // Before the Z rule this tab had NO badge at all and was unreachable by keyboard.
    expect(screen.getByText(`${PAIR_PREFIX}a`)).toBeTruthy();
    expect(screen.getByText(AGENT_OVERFLOW_POOL[0]!)).toBeTruthy();
  });

  it("the prefix key hides the single-character badges and shows only the second characters", () => {
    render(
      <>
        {tabsPastThePool(() => {})}
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: PAIR_PREFIX });
    // Only the pairs survive, each shown WITHOUT the prefix it has already spent.
    expect(screen.queryByText(AGENT_OVERFLOW_POOL[0]!)).toBeNull();
    expect(screen.queryByText(`${PAIR_PREFIX}a`)).toBeNull();
    expect(screen.getByText("a")).toBeTruthy();
  });

  it("the second character activates the pair's target", async () => {
    const onLast = vi.fn();
    render(
      <>
        {tabsPastThePool(onLast)}
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: PAIR_PREFIX });
    fireEvent.keyDown(window, { key: "a" });
    await waitFor(() => expect(onLast).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("a")).toBeNull());
  });

  it("an unmatched second character stays IN the layer rather than falling back out of it", () => {
    render(
      <>
        {tabsPastThePool(() => {})}
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: PAIR_PREFIX });
    fireEvent.keyDown(window, { key: "q" }); // no "zq" on screen
    expect(screen.getByText("a")).toBeTruthy(); // still the pair layer
    expect(screen.queryByText(AGENT_OVERFLOW_POOL[0]!)).toBeNull();
  });

  // The founder's ask: Escape unwinds a layer at a time. It cannot be done by intercepting the key
  // in this component — useHintMode's window listener is registered first and would already have
  // closed — so the hook delegates the decision here. This is that contract.
  it("Escape backs out to the ordinary layer first, and only then dismisses", () => {
    render(
      <>
        {tabsPastThePool(() => {})}
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: PAIR_PREFIX });
    expect(screen.getByText("a")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText(AGENT_OVERFLOW_POOL[0]!)).toBeTruthy(); // back, still open
    expect(screen.getByText(`${PAIR_PREFIX}a`)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(AGENT_OVERFLOW_POOL[0]!)).toBeNull(); // now dismissed
  });

  it("reopening starts at the ordinary layer, never inside a stale pair layer", () => {
    render(
      <>
        {tabsPastThePool(() => {})}
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: PAIR_PREFIX });
    controlTap(); // close from INSIDE the pair layer
    controlTap(); // and reopen
    expect(screen.getByText(AGENT_OVERFLOW_POOL[0]!)).toBeTruthy();
  });
});

describe("HintOverlay — activation shapes", () => {
  it("FOCUSES a text field instead of clicking it, caret at the end", async () => {
    const onClick = vi.fn();
    render(
      <>
        <textarea data-hint="prompt" defaultValue="half a draft" onClick={onClick} />
        <HintOverlay />
      </>,
    );
    const box = document.querySelector("textarea")!;
    controlTap();
    expect(screen.getByText("/")).toBeTruthy();

    fireEvent.keyDown(window, { key: "/" });
    // click() on a textarea does not move the caret into it, so the hint would appear inert.
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(onClick).not.toHaveBeenCalled();
    expect(box.selectionStart).toBe("half a draft".length);
  });

  it("anchors a badge to the TOP edge when the target asks for it", () => {
    // A tall target — a ten-line compose box — is the case centring reads wrong on.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 10, y: 10, top: 10, left: 10, right: 50, bottom: 210, width: 40, height: 200,
      toJSON: () => ({}),
    } as DOMRect);
    render(
      <>
        <textarea data-hint="prompt" data-hint-anchor="top" />
        <button data-hint="build" onClick={() => {}}>Build</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    const topAnchored = screen.getByText("/").style.top;
    const centred = screen.getByText("b").style.top;
    expect(topAnchored).toBe("12px"); // hugging the top edge
    expect(parseFloat(centred)).toBeGreaterThan(90); // halfway down the same 200px box
  });
});

describe("HintOverlay — the paperclip chain", () => {
  // A stand-in for AttachControl: one resting trigger whose click expands the two real actions.
  function Paperclip({ onScreenshot }: { onScreenshot: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button data-hint="attach" onClick={() => setOpen(true)}>Attach</button>
        {open ? (
          <>
            <button data-hint="attach-screenshot" onClick={onScreenshot}>Screenshot</button>
            <button data-hint="attach-upload" onClick={() => {}}>Upload</button>
          </>
        ) : null}
      </div>
    );
  }

  it("k expands the group and chains into its two actions", async () => {
    const onScreenshot = vi.fn();
    render(
      <>
        <Paperclip onScreenshot={onScreenshot} />
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("k")).toBeTruthy();

    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("s")).toBeTruthy());
    expect(screen.getByText("u")).toBeTruthy();
    // Scoped: the trigger's own badge is gone, so the layer reads as "pick one of these two".
    expect(screen.queryByText("k")).toBeNull();

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(onScreenshot).toHaveBeenCalledTimes(1));
  });

  // THE REASON THE CHAIN IS SCOPED. "s" is also the agent-pane composer's screenshot mnemonic, and
  // both surfaces are on screen together — unscoped, one of the two "s" badges would be dead.
  it("suppresses every other badge while the chain is open, and restores them on Escape", async () => {
    const onComposerShot = vi.fn();
    render(
      <>
        <Paperclip onScreenshot={() => {}} />
        <button data-hint="screenshot" onClick={onComposerShot}>Composer screenshot</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getAllByText("s")).toHaveLength(1); // only the composer's, while collapsed

    fireEvent.keyDown(window, { key: "k" });
    // Gate on "u", which exists ONLY inside the chain. Waiting on "s" proves nothing here: there is
    // exactly one of those in both layers, so the wait resolves before the chain has opened and the
    // next keystroke lands on the composer's button instead.
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    expect(screen.getAllByText("s")).toHaveLength(1); // the chain's, and only the chain's
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(screen.queryByText("u")).toBeNull());
    expect(onComposerShot).not.toHaveBeenCalled();
  });

  // The group ALSO expands on hover, so its actions can be in the DOM with no chain open. If they
  // were labelled there, two live "s" badges would collide and one would be unreachable.
  it("never badges the actions outside the chain, even when the group is already expanded", () => {
    render(
      <>
        <button data-hint="attach-screenshot" onClick={() => {}}>Screenshot</button>
        <button data-hint="attach-upload" onClick={() => {}}>Upload</button>
        <button data-hint="screenshot" onClick={() => {}}>Composer screenshot</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getAllByText("s")).toHaveLength(1);
    expect(screen.queryByText("u")).toBeNull();
  });

  // THE FAILURE BRANCH. If the group never expands there is nothing to badge, so the overlay closes
  // rather than stranding the user on an empty layer — but the trigger has already been focused and
  // clicked by then, so closing must ALSO hand focus back out or the disclosure it just latched is
  // left open with no overlay at all to explain it.
  it("hands focus back out when the group fails to expand", async () => {
    render(
      <>
        <button data-hint="attach" onClick={() => {}}>Attach that never opens</button>
        <button data-hint="build" onClick={() => {}}>Build</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.queryByText("b")).toBeNull()); // overlay closed
    expect(document.activeElement).not.toBe(screen.getByText("Attach that never opens"));
  });

  // A DISMISSAL INSIDE THE TWO-FRAME WINDOW MUST WIN. The chain commits its layer from a double
  // rAF, so an overlay dismissed while that is in flight would otherwise have the layer re-set
  // underneath it — and the next time it opened it would collect against a chain whose group is
  // long collapsed, yielding an ACTIVE overlay with no badges at all, whose first Escape gets
  // swallowed unwinding the phantom layer instead of dismissing.
  it("a dismissal mid-flight is not undone by the chain's deferred commit", async () => {
    render(
      <>
        <Paperclip onScreenshot={() => {}} />
        <button data-hint="build" onClick={() => {}}>Build</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    controlTap(); // dismiss before the rAFs resolve
    // Let the in-flight callback run.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));

    controlTap(); // reopen
    // The ordinary layer, not a phantom chain that would show nothing.
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("k")).toBeTruthy();
  });

  it("Escape leaves the chain and brings the rest of the badges back", async () => {
    render(
      <>
        <Paperclip onScreenshot={() => {}} />
        <button data-hint="build" onClick={() => {}}>Build</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(screen.getByText("u")).toBeTruthy());
    expect(screen.queryByText("b")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("b")).toBeTruthy(); // ordinary layer, still open
    expect(screen.queryByText("u")).toBeNull();
  });
});
