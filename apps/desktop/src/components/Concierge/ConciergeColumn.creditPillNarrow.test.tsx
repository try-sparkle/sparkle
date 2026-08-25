// @vitest-environment jsdom
//
// THE CREDIT PILL GETS OFF THE MIC RING AT A NARROW COLUMN — bead sparkle-kk9dg.5.
//
// ══ WHAT THIS FILE CAN AND CANNOT SEE ══════════════════════════════════════════════════════════
//
// It cannot see the collision. jsdom has no layout engine, `getBoundingClientRect` returns zeros,
// no stylesheet is loaded and no `ResizeObserver` ever fires on its own — so a test here that
// claimed to observe the pill painted over the ring would be measuring nothing, which is this
// repo's #1 fleet-wide finding shape (docs/jsdom-test-caveats.md). The GEOMETRY proof is
// `scripts/visual/credit-pill-mic-probe.mjs`, which reads both boxes in real Chrome and records the
// before/after numbers in its own header.
//
// What it CAN see — and what nothing else can, cheaply — is the DECISION: given a painted strip
// width and a painted pill width, which placement does the column compute, and does the rendered
// element actually take that shape. That is a pure function plus one attribute plus one inline
// style, none of which need a layout engine.
//
// ══ WHY EVERY TEST HERE IS PAIRED ══════════════════════════════════════════════════════════════
//
// A single assertion that the pill reflows at 190px is satisfiable by a component that reflows
// ALWAYS — which would delete the overlay design bead sparkle-kk9dg.3 shipped and make the strip
// taller for every user at every width. So each rule is asserted at BOTH ends, holding the pill's
// width fixed and moving only the strip's: same pill, wide column → overlaid; same pill, narrow
// column → its own row. That pins the CAUSE rather than an absence.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// Stubbed for the same reason the header suite stubs them: the real ones drag a rAF audio loop and
// an entitlement fetch into assertions about layout. The badge stub still renders a real control,
// because "the credits entry point survives the reflow" is one of the things being asserted.
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => <div data-testid="logo-waveform" /> }));
vi.mock("../BalanceBadge", () => ({
  BalanceBadge: () => (
    <button type="button" data-hint="credits" aria-label="Open credits">
      $9972.67
    </button>
  ),
}));

import {
  ConciergeColumn,
  MIC_RING_CLEARANCE_PX,
  creditPillPlacement,
} from "./ConciergeColumn";
import { MIC_RING_DIAMETER } from "../waveGeometry";
import type { ConciergeController, ConciergeViewModel } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import { useAuthStore } from "../../stores/authStore";
import { useTrialStore } from "../../stores/trialStore";

/**
 * Fire the ResizeObserver callbacks that are actually WATCHING these elements, with the border-box
 * widths given — jsdom never will.
 *
 * TARGET-AWARE ON PURPOSE, the same reason `ComposeBox.pool.test.tsx` is: a stub whose `observe()`
 * is a no-op and which fires every callback regardless of what changed cannot detect a DROPPED
 * `observe(...)`. Delete the line that observes the pill and a target-blind stub keeps every test
 * here green, because the callback runs anyway — a test named for a wiring it cannot see violated.
 *
 * It also reports `borderBoxSize`, NOT `contentRect`, because that is the distinction the component
 * depends on: `contentRect` omits the strip's 32px of padding and the pill's 20px gutter, and a
 * placement computed from it is off by half a pill in the direction that lets the overlap back in.
 */
let observedTargets: Set<Element> = new Set();
let fireResize: (sizes: Map<Element, number>) => void = () => {};

beforeEach(() => {
  enableAiEnhancementsForTests();
  useAuthStore.setState({ tokenPresent: true, loading: false } as never);
  useTrialStore.setState({ loading: false, started: true } as never);
  const instances: { cb: (entries: unknown[]) => void; targets: Set<Element> }[] = [];
  observedTargets = new Set();
  fireResize = (sizes) =>
    act(() => {
      for (const i of instances) {
        const entries = [...sizes]
          .filter(([el]) => i.targets.has(el))
          .map(([el, inlineSize]) => ({
            target: el,
            borderBoxSize: [{ inlineSize, blockSize: 0 }],
            contentRect: { width: inlineSize, height: 0 },
          }));
        if (entries.length > 0) i.cb(entries);
      }
    });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private targets = new Set<Element>();
      constructor(cb: (entries: unknown[]) => void) {
        instances.push({ cb, targets: this.targets });
      }
      observe(el: Element) {
        this.targets.add(el);
        observedTargets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
        observedTargets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
  messages: [{ id: "m1", kind: "you", text: "hello" }],
};

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
  };
}

const strip = () => screen.getByTestId("concierge-voice-strip");
const pill = () => screen.getByTestId("concierge-credit-overlay");

/**
 * The pill's real border box under the founder's own balance, in px.
 *
 * `$9972.67` is the string in the parent bead's screenshot, not the dev fixture's `$200.00`, and the
 * difference is the whole reason the rule takes a measurement instead of a width threshold: a
 * wider balance collides at a WIDER column. 96 is that string in a 12px tabular-nums badge with
 * `3px 9px` of its own padding inside the overlay's `3px 10px` gutter.
 */
const PILL_W = 96;

/** Mount, then hand the component the two painted widths it would have measured in a browser. */
function mountAt(stripW: number, pillW: number = PILL_W) {
  render(<ConciergeColumn model={model} controller={controller()} />);
  fireResize(
    new Map<Element, number>([
      [strip(), stripW],
      [pill(), pillW],
    ]),
  );
}

describe("creditPillPlacement — the rule, in isolation", () => {
  it("keeps the pill overlaid while it clears the ring, and moves it off when it does not", () => {
    // THE BOUNDARY, DERIVED RATHER THAN TYPED. The ring is centred, so overlaying is allowed
    // exactly while `strip/2 + ring/2 + clearance + pill + inset <= strip`. Solving for the strip
    // gives the width below, and asserting one px either side of it is what makes this a test of
    // the rule rather than a restatement of an example.
    const inset = 6; // `16 - CREDIT_BACKDROP_GUTTER`, the pill's own right inset
    const boundary = 2 * (MIC_RING_DIAMETER / 2 + MIC_RING_CLEARANCE_PX + PILL_W + inset);
    expect(creditPillPlacement(boundary, PILL_W)).toBe("overlay");
    expect(creditPillPlacement(boundary - 1, PILL_W)).toBe("row");
  });

  it("moves the boundary with the BALANCE, which is what a width threshold could not do", () => {
    // The same column width, two balances. A rule keyed on the column alone cannot produce two
    // answers here — this is the assertion that would fail against `columnWidth < 200`.
    expect(creditPillPlacement(240, 60)).toBe("overlay");
    expect(creditPillPlacement(240, 96)).toBe("row");
  });

  it("takes the OVERLAID form while nothing has been measured", () => {
    // 0 is "not measured yet", not "zero pixels wide". Booting into the reflowed state and pulling
    // the pill back up a frame later is a visible jump in the strip's height on every mount.
    expect(creditPillPlacement(0, 0)).toBe("overlay");
    expect(creditPillPlacement(0, PILL_W)).toBe("overlay");
    expect(creditPillPlacement(190, 0)).toBe("overlay");
  });
});

describe("the rendered strip takes the shape the rule chose", () => {
  it("at a 190px column the pill leaves the ring's row — and at 360px it does not", () => {
    mountAt(190);
    expect(strip().dataset.creditPlacement).toBe("row");
    cleanup();

    mountAt(360);
    expect(strip().dataset.creditPlacement).toBe("overlay");
  });

  it("stops being absolutely positioned when it reflows, and is again when it does not", () => {
    // THE SIDE EFFECT, not the flag. `data-credit-placement` could be right while the style that
    // actually moves the box was never applied — this is the assertion that would fail if the
    // switch were wired to the attribute alone.
    mountAt(190);
    expect(pill().style.position).toBe("relative");
    expect(pill().style.marginLeft).toBe("auto");
    // The reflowed pill must not keep `right`: on a relative box that is a NUDGE, and it would
    // shove the pill 6px left of where the overlaid one sits — a visible sideways jump.
    expect(pill().style.right).toBe("");
    cleanup();

    mountAt(360);
    expect(pill().style.position).toBe("absolute");
    expect(pill().style.right).toBe("6px");
    expect(pill().style.marginLeft).toBe("");
  });

  it("keeps the 280px column bead sparkle-kk9dg.3 fixed on the OVERLAID path", () => {
    // The sibling bead's own reported width. Its fix widened this pill's backdrop so the bars stop
    // short of the balance, and that only exists while the pill is over the bars — so a fix for
    // `.5` that reflowed here would silently retire it.
    mountAt(280);
    expect(strip().dataset.creditPlacement).toBe("overlay");
    expect(pill().style.position).toBe("absolute");
  });

  it("never hides the credits control, at either end", () => {
    // `BalanceBadge` is the shell's only "Open credits" entry point. Hiding it below a width would
    // trade a collision for a lost capability — a worse defect than the one being fixed.
    mountAt(190);
    expect(screen.getByRole("button", { name: "Open credits" })).toBeTruthy();
    cleanup();

    mountAt(360);
    expect(screen.getByRole("button", { name: "Open credits" })).toBeTruthy();
  });

  it("observes BOTH boxes, because the rule needs both terms", () => {
    // Dropping either `observe` leaves that term pinned at 0, and 0 means "not measured" — which
    // takes the overlaid branch, i.e. the bug. Asserted on the wiring because a target-blind stub
    // cannot see it, and a browser is the only other witness.
    mountAt(190);
    expect(observedTargets.has(strip())).toBe(true);
    expect(observedTargets.has(pill())).toBe(true);
  });

  it("stays overlaid where ResizeObserver does not exist at all", () => {
    // The fail-safe. Some environments this renders in have no `ResizeObserver`; the unmeasured
    // state must be the one that is right at the widths the app opens at, not a permanently
    // reflowed strip.
    vi.unstubAllGlobals();
    expect((globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBeUndefined();
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(strip().dataset.creditPlacement).toBe("overlay");
    expect(pill().style.position).toBe("absolute");
  });
});
