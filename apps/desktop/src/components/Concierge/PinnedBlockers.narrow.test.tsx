// @vitest-environment jsdom
//
// ── THE PINNED BLOCKED ROW AT A NARROW CONCIERGE WIDTH (bead sparkle-jaq7n) ─────────────────────
// The founder's own screenshot: at a narrow pane, the Approve button painted directly over the
// agent name — "@Sparkle Preview Agent Eyes" with "Approve" overlapping mid-string. His framing
// invited a designed answer rather than a literal one: *"Maybe we don't show that button at all
// when it's too narrow... why don't you figure it out?"*
//
// THE ORDER OF SACRIFICE THIS FILE PINS: as the column narrows, the row gives up the LEAST useful
// thing first — the "BLOCKED:" word (redundant with the dot), then the agent name (already
// ellipsizable via AgentPill's own truncation), and ONLY AS A LAST RESORT the Approve/Open button
// itself, with the row's own click wired to fire the identical action in that state.
//
// WHY THESE ARE DECLARATION/PURE-FUNCTION ASSERTIONS RATHER THAN MEASUREMENTS. **jsdom has no
// layout engine.** `getBoundingClientRect` returns zeros, `scrollWidth`/`clientWidth` are 0, and
// `text-overflow` never evaluates — so a jsdom test claiming to OBSERVE the overlap would be
// measuring nothing (docs/jsdom-test-caveats.md, this repo's #1 fleet-wide finding shape).
//
// jsdom ALSO never fires a ResizeObserver — it never lays out, so the observer that drives
// `columnWidth` in `PinnedBlockers` never runs, and a rendered instance here is permanently stuck
// reading `columnWidth` at its unmeasured (0 → "roomy") default. That is WHY the tier logic is
// exported as pure functions (`pinnedBlockerShowsLabel`, `pinnedBlockerShowsButton`,
// `pinnedBlockerRowActivation`) rather than only exercised through rendering — matching
// `ComposeBox.narrow.test.tsx`'s `toolbarShowsLabels`, the established shape in this codebase for
// exactly this constraint. The real-layout half — that nothing actually overlaps or overflows at
// any width the column can be dragged to — is measured in a real browser by
// `scripts/visual/blocked-row-narrow-probe.mjs`, which is the only place it can be measured at all.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PINNED_BLOCKER_ACTION_TESTID,
  PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX,
  PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX,
  PINNED_BLOCKER_LABEL_TESTID,
  PINNED_BLOCKER_TESTID,
  PINNED_BLOCKERS_TESTID,
  PinnedBlockers,
  pinnedBlockerRowActivation,
  pinnedBlockerShowsButton,
  pinnedBlockerShowsLabel,
} from "./PinnedBlockers";
import { AgentPillProvider } from "./AgentPill";
import type { ConciergeNudge } from "./types";
import type { RevealOutcome } from "../../services/agentReveal";

afterEach(() => cleanup());

/** "This length is declared, and it is zero." Not an exact `"0px"` comparison — React does not
 *  append a unit to a numeric zero, so `minWidth: 0` reaches the DOM as the string `"0"`. Matches
 *  `RecapCard.narrow.test.tsx`'s `isZeroLength`. */
const isZeroLength = (v: string) => v !== "" && Number.parseFloat(v) === 0;

const blocker = (
  id: string,
  name = `Agent ${id}`,
  // A DISTINCT action id PER ROW by default (roborev 64058) — a literal `"approve"` hard-coded
  // in the component would satisfy an assertion built on a fixture that also always says
  // "approve", so the id here is tied to the row's own id unless a test asks otherwise.
  actionId = `relay-approve-${id}`,
): ConciergeNudge => ({
  id,
  kind: "nudge",
  band: "needs_you",
  projectName: "sparkle",
  agentName: name,
  text: "",
  actions: actionId ? [{ id: actionId, label: "Approve", kind: "primary" }] : [],
});

/** The wrapper `renderPinned` mounts. Pulled out so a rerender-in-place test can hand the SAME
 *  provider identity back to `rerender`, updating one component instance rather than mounting a
 *  fresh one — which is the only way to reproduce a bug in code that runs once per MOUNT. */
function Wrapper({
  blockers,
  onNudgeClick,
  onNudgeAction,
}: {
  blockers: ConciergeNudge[];
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
}) {
  return (
    <AgentPillProvider
      value={{
        agents: blockers.map((b) => ({
          id: b.id,
          name: b.agentName,
          projectId: "p1",
          projectName: b.projectName,
          band: b.band,
          canAcceptInput: true,
        })),
        onOpenAgent: () => "revealed" as RevealOutcome,
      }}
    >
      <PinnedBlockers
        blockers={blockers}
        acknowledged={[]}
        onNudgeClick={onNudgeClick}
        onNudgeAction={onNudgeAction}
      />
    </AgentPillProvider>
  );
}

function renderPinned(blockers: ConciergeNudge[]) {
  const onNudgeClick = vi.fn();
  const onNudgeAction = vi.fn();
  const { rerender } = render(
    <Wrapper blockers={blockers} onNudgeClick={onNudgeClick} onNudgeAction={onNudgeAction} />,
  );
  /** Update the SAME component instance with a new blocker list — never a fresh `render()`,
   *  which would mount a new instance and could not reproduce a once-per-mount bug. */
  const rerenderWith = (next: ConciergeNudge[]) =>
    rerender(<Wrapper blockers={next} onNudgeClick={onNudgeClick} onNudgeAction={onNudgeAction} />);
  return { onNudgeClick, onNudgeAction, rerenderWith };
}

describe("pinnedBlockerShowsLabel — tier 2, the 'BLOCKED:' word", () => {
  it("takes the FULL form when nothing has been measured yet", () => {
    // Matches `toolbarShowsLabels(0)`: booting collapsed and widening a frame later is a visible
    // flicker, so an unmeasured column reads as roomy.
    expect(pinnedBlockerShowsLabel(0)).toBe(true);
  });

  it("shows the label at and above the threshold", () => {
    expect(pinnedBlockerShowsLabel(PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX)).toBe(true);
    expect(pinnedBlockerShowsLabel(900)).toBe(true);
  });

  it("drops the label below the threshold — the dot alone carries the state", () => {
    expect(pinnedBlockerShowsLabel(PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX - 1)).toBe(false);
    expect(pinnedBlockerShowsLabel(1)).toBe(false);
  });
});

describe("pinnedBlockerShowsButton — tier 4, the last resort", () => {
  it("takes the FULL form when nothing has been measured yet", () => {
    expect(pinnedBlockerShowsButton(0)).toBe(true);
  });

  it("shows the button at and above the threshold", () => {
    expect(pinnedBlockerShowsButton(PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX)).toBe(true);
    expect(pinnedBlockerShowsButton(900)).toBe(true);
  });

  it("hides the button only below the threshold, and the threshold is NARROWER than the label's", () => {
    // The sacrifice order itself: the button may not disappear before the label already has.
    expect(pinnedBlockerShowsButton(PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX - 1)).toBe(false);
    expect(PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX).toBeLessThan(
      PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX,
    );
  });

  it("reaches CONCIERGE_MIN_WIDTH (50) still hidden — the floor the resize engine actually enforces", () => {
    expect(pinnedBlockerShowsButton(50)).toBe(false);
  });
});

// ── THE ROW NEVER APPROVES. AT ANY WIDTH. (founder, 2026-08-20 — REVERSING HIS EARLIER RULE) ────
// These three cases asserted the opposite until 2026-08-20: with the button hidden, the row fired
// the approval, on the founder's own bar — "only if the entire row remains clickable and lands on
// the same approval". Asked again with the hazard named, he reversed it, and the assertions moved
// with the decision.
//
// THE HAZARD: below the button threshold the row carries NO visible affordance, and clicking a row
// is how a human INVESTIGATES it. That gesture fired a one-tap relay into a live terminal, approving
// a question the human had by definition not read — the pane was shut; opening it was the point of
// the click. A destructive action on an investigative gesture, at exactly the width where the human
// can see the least.
//
// WHY ALL FOUR COMBINATIONS, not just the one that changed: the property under test is now
// "activation does not depend on width OR on which action the blocker carries". A test that only
// pinned `(false, "approve")` would go green again the moment someone reintroduced a width branch
// that happened to spare that one input.
describe("pinnedBlockerRowActivation — the row opens the agent, and never approves", () => {
  it("opens the agent when the button is showing", () => {
    expect(pinnedBlockerRowActivation(true, "approve")).toEqual({ kind: "open" });
  });

  it("opens the agent when the button is HIDDEN — it must not fire the approval", () => {
    expect(pinnedBlockerRowActivation(false, "approve")).toEqual({ kind: "open" });
  });

  it("opens the agent when the button is hidden and there is no action at all", () => {
    expect(pinnedBlockerRowActivation(false, undefined)).toEqual({ kind: "open" });
  });

  it("opens the agent when the button is showing and there is no action at all", () => {
    expect(pinnedBlockerRowActivation(true, undefined)).toEqual({ kind: "open" });
  });

  // THE INVARIANT ITSELF, stated once rather than inferred from the four cases above: no input
  // this function accepts may ever produce an approval. A future width tier cannot reintroduce one
  // without turning this red.
  it("never returns an action for ANY combination of inputs", () => {
    for (const showButton of [true, false]) {
      for (const actionId of ["approve", "relay-approve-b", undefined]) {
        expect(pinnedBlockerRowActivation(showButton, actionId).kind).toBe("open");
      }
    }
  });
});

describe("PinnedBlockers renders every tier's structure — full width (unmeasured jsdom default)", () => {
  it("shows the label and the button when nothing has been measured (roomy default)", () => {
    renderPinned([blocker("a")]);
    expect(screen.getByTestId(PINNED_BLOCKER_LABEL_TESTID).textContent).toBe("BLOCKED:");
    expect(screen.getByTestId(PINNED_BLOCKER_ACTION_TESTID).textContent).toBe("Approve");
  });

  it("clicking the visible Approve button still fires the action directly, not the row's fallback", () => {
    const { onNudgeAction, onNudgeClick } = renderPinned([blocker("a")]);
    fireEvent.click(screen.getByTestId(PINNED_BLOCKER_ACTION_TESTID));
    expect(onNudgeAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "relay-approve-a",
    );
    // The button's own `stopPropagation` still holds — the row's click must not ALSO fire.
    expect(onNudgeClick).not.toHaveBeenCalled();
  });

  it("exposes the measured column width for a probe to wait on, defaulting to 0 (unmeasured)", () => {
    // Purely an introspection hook — see PinnedBlockers.tsx's `data-column-width` and
    // `scripts/visual/blocked-row-narrow-probe.mjs`'s ResizeObserver-race fix. Pinned here so a
    // future edit cannot quietly drop the attribute the probe depends on.
    renderPinned([blocker("a")]);
    expect(screen.getByTestId(PINNED_BLOCKERS_TESTID).dataset.columnWidth).toBe("0");
  });

  it("never renders the label without the row's aria-label still saying BLOCKED — accessibility does not depend on the visible word", () => {
    renderPinned([blocker("a", "Some Agent")]);
    expect(screen.getByTestId(PINNED_BLOCKER_TESTID).getAttribute("aria-label")).toBe(
      "BLOCKED: Some Agent in sparkle",
    );
  });
});

describe("PinnedBlockers — the structural declarations that make containment possible", () => {
  // These are the CSS properties `scripts/visual/blocked-row-narrow-probe.mjs` proved load-bearing
  // by running against the code without them: the overlap and the overhang it found both trace to
  // one of the three declarations below being absent.
  it("clips the row itself — the containment backstop below every tier", () => {
    // Without this, controls pushed by an auto margin (mute/dismiss) were measured painting tens
    // of px past the row's own box AND the column's right edge at CONCIERGE_MIN_WIDTH, invisible
    // to any check that only reads the row's own (correctly-contained) rect.
    renderPinned([blocker("a")]);
    expect(screen.getByTestId(PINNED_BLOCKER_TESTID).style.overflow).toBe("hidden");
  });

  it("lets the agent-pill fence SHRINK and CLIP — the founder's own screenshot", () => {
    // The root cause: the fence around AgentPill shrank correctly under flexbox but had no clip,
    // so an overflowing name painted straight past its own box and onto the Approve button beside
    // it. `overflow: hidden` is what turns a shrunk box into an actual clip instead of a box
    // content merely paints past.
    //
    // NO EXPLICIT `flex` — deliberately absent, not merely unwritten. An earlier draft wrote
    // `flex: "1 1 0%"` (roborev 63961): grow:1 made the fence consume all POSITIVE free space at
    // a roomy width, opening a gap between the name and "in {project}" that does not exist today.
    // A LATER draft then wrote `flex: "0 1 auto"` explicitly (roborev 64018) — which is a no-op,
    // since that IS the default every flex item already has, and writing it out read as "grow is
    // guarded here" when nothing distinguishes it from simply not setting `flex` at all. So the
    // absence itself is the assertion: `minWidth: 0` and `overflow: hidden` are the two
    // declarations doing real work, and this pins that no future edit reintroduces an explicit
    // (and therefore reviewable-as-if-load-bearing) `flex` on this box.
    renderPinned([blocker("a")]);
    const pillFence = screen
      .getByTestId(PINNED_BLOCKER_TESTID)
      .querySelector<HTMLElement>('[role="presentation"]')!;
    expect(isZeroLength(pillFence.style.minWidth)).toBe(true);
    expect(pillFence.style.flex).toBe("");
    expect(pillFence.style.overflow).toBe("hidden");
  });
});

// ── THE RESIZEOBSERVER MUST ATTACH ON THE ORDINARY idle → BLOCKED TRANSITION (roborev 64001) ────
//
// `PinnedBlockers` renders NOTHING at all when there is nothing live — the ordinary starting
// state of a concierge column. A `useEffect(..., [])` runs exactly once, on the FIRST mount, and
// that first mount is usually the empty one: `rootRef.current` is null (the ref'd div was never
// in the DOM), the effect gives up, and it never runs again for the lifetime of the component —
// so when a blocker actually appears moments later, the observer that is supposed to drive every
// tier in this file never attaches at all, and `columnWidth` stays frozen at its "unmeasured"
// (roomy) default forever. The whole feature above this comment would be inert in production
// while every test that renders the row WITH BLOCKERS ALREADY PRESENT stayed green, because none
// of them exercise the empty→populated transition a real session goes through.
//
// jsdom has no ResizeObserver at all, so this cannot observe the real measurement — but it CAN
// observe whether the code even ATTEMPTS to attach one, which is exactly where the bug lived: the
// old code never called `.observe()` a second time after the transition; the fix (a callback ref)
// calls it the moment the node actually mounts, whichever render that turns out to be.
describe("PinnedBlockers attaches its width observer on the idle → blocked transition", () => {
  /** A fake that records every `observe()`/`disconnect()` call AND keeps the callback the
   *  component registered, so a test can both assert WHEN attachment happens and drive a
   *  synthetic measurement through it — proving the mechanism this whole file is about actually
   *  moves `columnWidth`, not merely that `.observe()` was called (roborev 64032). */
  class RecordingResizeObserver {
    static instances: RecordingResizeObserver[] = [];
    observed: Element[] = [];
    disconnected = false;
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      RecordingResizeObserver.instances.push(this);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
  }

  /** The LIVE (never-disconnected) instances — the count that should never exceed one. */
  const live = () => RecordingResizeObserver.instances.filter((i) => !i.disconnected);

  /** Deliver a synthetic measurement through the exact callback the component registered — the
   *  only way to prove `columnWidth` actually updates, since jsdom never fires a real observer. */
  const deliver = (instance: RecordingResizeObserver, width: number) =>
    act(() => {
      instance.cb(
        [{ contentRect: { width } } as unknown as ResizeObserverEntry],
        instance as unknown as ResizeObserver,
      );
    });

  afterEach(() => {
    RecordingResizeObserver.instances = [];
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  });

  it("attaches on first mount when a blocker is ALREADY present", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    renderPinned([blocker("a")]);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.observed.length).toBeGreaterThan(0);
  });

  it("STILL attaches after mounting empty (renders null) and THEN receiving a blocker", () => {
    // This is the case the bug lived in. Reproduced with `rerender` on ONE component instance —
    // never a fresh `render()`, which would mount a new instance and could not exercise a
    // once-per-mount defect at all.
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { rerenderWith } = renderPinned([]);
    // Nothing rendered yet, so nothing could have attached — the starting condition the bug needs.
    expect(screen.queryByTestId(PINNED_BLOCKERS_TESTID)).toBeNull();
    expect(RecordingResizeObserver.instances).toHaveLength(0);

    rerenderWith([blocker("a")]);

    expect(screen.getByTestId(PINNED_BLOCKERS_TESTID)).toBeTruthy();
    expect(live()).toHaveLength(1);
    expect(live()[0]!.observed.length).toBeGreaterThan(0);
  });

  it("does NOT rebuild the observer on a re-render that leaves the DOM node untouched", () => {
    // The churn `useCallback([])` exists to prevent: an inline ref identity changes every render
    // and React tears down + rebuilds on EACH one, not only when the node itself changes. A
    // rerender with the SAME blocker list re-renders the row without remounting its div, so a
    // stable ref must leave the original instance as the only one that ever existed.
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { rerenderWith } = renderPinned([blocker("a")]);
    expect(RecordingResizeObserver.instances).toHaveLength(1);

    rerenderWith([blocker("a")]);

    expect(RecordingResizeObserver.instances).toHaveLength(1);
    expect(RecordingResizeObserver.instances[0]!.disconnected).toBe(false);
  });

  it("disconnects the old observer and reattaches across an open → empty → open cycle", () => {
    // A busy fleet clears and re-raises blockers repeatedly; each cycle must leave exactly one
    // LIVE observer, not an accumulating pile of disconnected ones still holding a stale callback.
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { rerenderWith } = renderPinned([blocker("a")]);
    const first = RecordingResizeObserver.instances[0]!;
    expect(first.disconnected).toBe(false);

    rerenderWith([]);
    expect(screen.queryByTestId(PINNED_BLOCKERS_TESTID)).toBeNull();
    // THE FACT THIS TEST'S NAME CLAIMS AND THE OLD VERSION NEVER CHECKED: the div unmounting must
    // have torn its observer down. Without this assertion, a component that never disconnects at
    // all satisfies every other line in this test just as well (roborev 64032).
    expect(first.disconnected).toBe(true);

    rerenderWith([blocker("a")]);
    // A second instance was created for the second mount of the div — the first stays disconnected
    // rather than being resurrected, and exactly one instance is live at the end.
    expect(RecordingResizeObserver.instances.length).toBeGreaterThanOrEqual(2);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.observed.length).toBeGreaterThan(0);
  });

  // ── THE MEASUREMENT ITSELF MUST REACH `columnWidth` AND FLIP A TIER (roborev 64032) ────────────
  // Every test above proves `.observe()` was called — none of them prove a DELIVERED measurement
  // does anything. Breaking `entries[0]?.contentRect.width`, the `w > 0` guard, or the
  // `setColumnWidth` call itself would leave every test above green; this is the one that would
  // catch it, by driving the exact callback the component registered and reading the OBSERVABLE
  // result: the exposed `data-column-width` attribute, and the label actually disappearing.
  it("a delivered measurement updates columnWidth and flips the label tier", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    renderPinned([blocker("a")]);
    const zone = screen.getByTestId(PINNED_BLOCKERS_TESTID);
    expect(zone.dataset.columnWidth).toBe("0");
    expect(screen.getByTestId(PINNED_BLOCKER_LABEL_TESTID)).toBeTruthy();

    deliver(live()[0]!, PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX - 1);

    expect(zone.dataset.columnWidth).toBe(String(PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX - 1));
    expect(screen.queryByTestId(PINNED_BLOCKER_LABEL_TESTID)).toBeNull();
  });

  // ── TIER 4's WIRING, EXERCISED THROUGH THE COMPONENT, NOT JUST THE PURE FUNCTION ────────────────
  // `pinnedBlockerRowActivation` has its own unit coverage above, but nothing proved the component
  // actually WIRES it — `showButton` reaching the row's `onClick`, and `b.actions[0]?.id` reaching
  // `pinnedBlockerRowActivation`'s second argument. Hard-coding `pinnedBlockerRowActivation(true,
  // …)`, or changing the row handler back to `onNudgeClick(b)` unconditionally, would leave the
  // ENTIRE rest of this suite green — every other test here runs at the unmeasured (roomy)
  // default and never reaches this branch — while a narrow column renders a blocker with no
  // Approve button AND a row whose click does nothing but navigate: a block the reader can see but
  // cannot act on, exactly what the sacrifice order's tier 4 exists to bar. Paired with the
  // roomy-width inverse so the assertion pins the BRANCH (which behavior fires when) rather than
  // just one state of it (roborev 64048).
  //
  // TWO BLOCKERS, CLICKING THE SECOND (roborev 64058). A single-row fixture whose only action id
  // is the literal `"approve"` cannot tell "the wiring reads THIS row's own action id" apart from
  // "the component always says approve" — a hard-coded `"approve"` in the component would satisfy
  // it too. `blocker()`'s default action id is now tied to the row's own id
  // (`relay-approve-<id>`), and clicking row "b" specifically is what proves the SECOND row's own
  // nudge/action reach the callback rather than the first row's (the exact mis-attribution class
  // fixed in the probe under roborev 64018).
  const rowByAgentId = (id: string) =>
    screen.getByTestId(PINNED_BLOCKERS_TESTID).querySelector<HTMLElement>(`[data-agent-id="${id}"]`)!;

  it("at a roomy delivered width, the button shows and the row's click opens ITS OWN agent", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { onNudgeClick, onNudgeAction } = renderPinned([blocker("a"), blocker("b")]);
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX);

    expect(screen.getAllByTestId(PINNED_BLOCKER_ACTION_TESTID)).toHaveLength(2);
    fireEvent.click(rowByAgentId("b"));
    expect(onNudgeClick).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    expect(onNudgeAction).not.toHaveBeenCalled();
  });

  it("at a delivered width below the button threshold, the button hides and the row's OWN click OPENS — never approves", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { onNudgeClick, onNudgeAction } = renderPinned([blocker("a"), blocker("b")]);
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX - 1);

    // THE MEASUREMENT IS LOAD-BEARING, and it is what makes this different from the pure-function
    // test above. jsdom never lays out, so every other case in this suite sits at the unmeasured
    // (roomy) default and never reaches the narrow branch at all. Delivering a real width through
    // the RecordingResizeObserver is the only way to prove the COMPONENT is wired to the reversed
    // rule rather than merely that the function returns "open" when asked directly.
    expect(screen.queryByTestId(PINNED_BLOCKER_ACTION_TESTID)).toBeNull();
    fireEvent.click(rowByAgentId("b"));
    // REVERSED 2026-08-20 (founder). This asserted the row fired `relay-approve-b`. It must now
    // open, and — the half that actually protects him — it must fire NO action at all: an
    // investigative click at a width where nothing is visible cannot press a button he never read.
    expect(onNudgeClick).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
    expect(onNudgeAction).not.toHaveBeenCalled();
  });

  // ── THE PILL IS A CARVE-OUT, NEVER A SECOND APPROVAL PATH (roborev 64058 → …→ 64112) ───────────
  // An earlier draft routed the LIVE pill's own click through `rowActivate`, which made its
  // `title`/tooltip ("Open {agent} in {project}") a lie at tier 4 (it would actually approve).
  // Later drafts tried giving the FENCE its own tier-4 fallback for content the pill's own click
  // doesn't cover (an unresolved agent's inert prose, a closed pill's disclosure toggle) — first
  // keyed on "was this a control" (roborev 64095), which still let a click on the disclosure's
  // explanatory PROSE fall through and approve (roborev 64108); then on "did the click reach the
  // fence with nothing in between" (`e.target === e.currentTarget`), which turned out to be dead
  // code — the fence has no padding and its one child always fills it, so no real click can ever
  // produce that condition (roborev 64112).
  //
  // THE SHIPPED RULE: the fence ONLY `stopPropagation()`s. Every form the pill can render keeps
  // just its own honest behavior (open, toggle, navigate, or nothing) and NEVER ALSO approves.
  // "The entire row remains clickable" is satisfied by the ROW's own area (its padding, the dot,
  // the "in {project}" text) and by Enter/Space on the row — never by clicking the pill itself.
  it("the LIVE pill button always opens the agent — even at tier 4, so its tooltip stays true", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { onNudgeClick, onNudgeAction } = renderPinned([blocker("a")]);
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX - 1);
    expect(screen.queryByTestId(PINNED_BLOCKER_ACTION_TESTID)).toBeNull(); // confirms tier 4

    const pill = rowByAgentId("a").querySelector<HTMLElement>('[data-testid="concierge-agent-pill"]')!;
    expect(pill.title).toBe("Open Agent a in sparkle");
    fireEvent.click(pill);

    expect(onNudgeClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
    expect(onNudgeAction).not.toHaveBeenCalled();
  });

  it("the LIVE pill button opens the agent at a roomy width too (unchanged)", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { onNudgeClick, onNudgeAction } = renderPinned([blocker("a")]);
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX);

    const pill = rowByAgentId("a").querySelector<HTMLElement>('[data-testid="concierge-agent-pill"]')!;
    fireEvent.click(pill);

    expect(onNudgeClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onNudgeClick).toHaveBeenCalledTimes(1);
    expect(onNudgeAction).not.toHaveBeenCalled();
  });

  // ── NO SEPARATE "FENCE'S OWN AREA" TEST (roborev 64112, removing one from an earlier draft) ────
  // The fence has no padding and holds exactly one flex child that always fills its content box,
  // so there is no real hit area a pointer event can land on that isn't already the pill —
  // `e.target` can never legitimately equal the fence itself. A test asserting otherwise could
  // only pass by SYNTHESIZING that impossible event (`fireEvent.click(fence)` sets `target`
  // directly, unconstrained by real hit-testing — docs/jsdom-test-caveats.md), which certifies a
  // path nothing in production can reach. The fence is a pure click sink now (see its `onClick`);
  // "the entire row remains clickable" is satisfied by the ROW's own padding, dot, and
  // "in {project}" text, all covered by the click-routing tests above and below.

  // ── THE ACTUAL SCENARIO ROBOREV 64079 NAMED: AN UNRESOLVED PILL AT TIER 4 ──────────────────────
  // `ConciergeColumn.tsx` records that this strip has already shipped once with its pills
  // resolving to a dead-end variant — an agent the roster no longer holds. `renderPinned`'s
  // default `Wrapper` builds its roster FROM the blocker list, so it is structurally incapable of
  // reproducing this at all; these need a bespoke roster that omits the blocked agent.
  //
  // TWO SHAPES, NOT ONE (roborev 64095). `ConciergeColumn.tsx` ALWAYS supplies `onSeeHistory`
  // (`ConciergeHost.seeAgentHistory` is never undefined), so the variant that actually SHIPS is
  // AgentPill's DISCLOSURE `<button>` — not the fully inert span an earlier draft tested, which
  // is unreachable from this component in production and was reading as coverage of a path
  // nothing exercises. The disclosure button, and the "See what it did" button it can reveal,
  // are BOTH real interactive controls that do not `stopPropagation()` — so a fence rule that
  // excluded only the live-pill button let both of these ALSO fire the row's approval on the same
  // click: toggling the explanation AND relaying an irreversible Approve, or navigating to history
  // AND relaying one.
  it("the disclosure toggle (the form that ACTUALLY SHIPS) only toggles — it does not ALSO approve", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const onNudgeClick = vi.fn();
    const onNudgeAction = vi.fn();
    const onSeeHistory = vi.fn();
    render(
      <AgentPillProvider
        value={{ agents: [], onOpenAgent: () => "gone" as RevealOutcome, onSeeHistory }}
      >
        <PinnedBlockers
          blockers={[blocker("a")]}
          acknowledged={[]}
          onNudgeClick={onNudgeClick}
          onNudgeAction={onNudgeAction}
        />
      </AgentPillProvider>,
    );
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX - 1);

    // Confirms the fixture reaches the branch this test is actually about — the DISCLOSURE
    // button, distinct from both the live pill and the fully inert (no-`onSeeHistory`) span.
    const toggle = screen.getByTestId("concierge-agent-pill-closed");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(onNudgeAction).not.toHaveBeenCalled();
    expect(onNudgeClick).not.toHaveBeenCalled();

    // Now reveal and click "See what it did" — a SECOND interactive control the fence has to
    // recognize, nested one level deeper.
    fireEvent.click(screen.getByTestId("concierge-agent-pill-notice-action"));
    expect(onSeeHistory).toHaveBeenCalledWith({ agentId: "a", name: "Agent a" });
    expect(onNudgeAction).not.toHaveBeenCalled();
    expect(onNudgeClick).not.toHaveBeenCalled();
  });

  // ── THE NOTICE'S OWN PROSE — CONTENT, NOT A CONTROL, STILL NEVER APPROVES (roborev 64108) ──────
  // The expanded disclosure's `LiveNotice` renders explanatory prose ("…is closed.") immediately
  // beside its action button — real content, just not an interactive one. An earlier draft
  // excluded only literal controls (`closest("button, a, …")`), which let a click on that PROSE
  // fall through and fire the approval — "I was reading an explanation" is exactly the kind of
  // unrelated click the row's approval must never fire on. THE SHIPPED RULE (roborev 64112): the
  // fence has no fallback at all any more — it only `stopPropagation()`s — so this now passes for
  // the simpler reason that NOTHING inside the fence, control or plain text, can ever reach the
  // row's approval, rather than because this specific content was excluded from a rule that
  // still let something else through.
  it("the notice's own explanatory TEXT (not the button) does not approve either", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const onNudgeClick = vi.fn();
    const onNudgeAction = vi.fn();
    const onSeeHistory = vi.fn();
    render(
      <AgentPillProvider
        value={{ agents: [], onOpenAgent: () => "gone" as RevealOutcome, onSeeHistory }}
      >
        <PinnedBlockers
          blockers={[blocker("a")]}
          acknowledged={[]}
          onNudgeClick={onNudgeClick}
          onNudgeAction={onNudgeAction}
        />
      </AgentPillProvider>,
    );
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX - 1);

    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed")); // expand the disclosure
    const notice = screen.getByTestId("concierge-agent-pill-notice");
    expect(notice.textContent).toContain("is closed");
    fireEvent.click(notice); // the PROSE span itself, not the nested action button

    expect(onNudgeAction).not.toHaveBeenCalled();
    expect(onNudgeClick).not.toHaveBeenCalled();
    expect(onSeeHistory).not.toHaveBeenCalled();
  });

  it("a fully inert pill (no onSeeHistory reaches it) does NOT approve on its own text either", () => {
    // NOT the shape that ships — `ConciergeColumn.tsx` always supplies `onSeeHistory` — but a
    // real one `AgentPill` can still render (any OTHER surface that mounts a pill with no history
    // route). Same rule as the notice prose above: the fence only `stopPropagation()`s, so this
    // content — like every other form the pill can take — never reaches the row's approval.
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const onNudgeClick = vi.fn();
    const onNudgeAction = vi.fn();
    render(
      <AgentPillProvider value={{ agents: [], onOpenAgent: () => "gone" as RevealOutcome }}>
        <PinnedBlockers
          blockers={[blocker("a")]}
          acknowledged={[]}
          onNudgeClick={onNudgeClick}
          onNudgeAction={onNudgeAction}
        />
      </AgentPillProvider>,
    );
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX - 1);

    const inert = screen.getByTestId("concierge-agent-pill-closed");
    expect(inert.tagName).toBe("SPAN"); // confirms this IS the fully inert form, not the toggle
    fireEvent.click(inert);

    expect(onNudgeAction).not.toHaveBeenCalled();
    expect(onNudgeClick).not.toHaveBeenCalled();
  });

  // ── THE ACCESSIBLE NAME MUST SAY WHAT Enter/Space NOW DOES (roborev 64058) ─────────────────────
  // "User-facing copy is code" — a fix that relocates a behavior owes every string describing the
  // OLD behavior an update. The row is `role="button"` with the same aria-label at every width
  // before this fix, so a screen-reader user got no cue that activating it now fires an
  // irreversible relay instead of merely opening the agent.
  it("the accessible name stays the plain form once the button is gone, and Enter OPENS rather than approving", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    const { onNudgeClick, onNudgeAction } = renderPinned([blocker("a")]);
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_BUTTON_MAX_COLUMN_PX - 1);

    const row = rowByAgentId("a");
    // REVERSED 2026-08-20 (founder). This asserted "— activate to Approve". The row no longer
    // approves at any width, so the warning is retired with the behaviour it warned about; leaving
    // it would narrate a relay that cannot happen.
    expect(row.getAttribute("aria-label")).toBe("BLOCKED: Agent a in sparkle");

    // KEYBOARD, NOT CLICK — the sibling case above covers the pointer. A screen-reader user
    // activating this row must be no more able to fire a blind approval than a sighted one.
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onNudgeClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(onNudgeAction).not.toHaveBeenCalled();
  });

  it("the accessible name stays the plain form at a roomy width", () => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = RecordingResizeObserver;
    renderPinned([blocker("a")]);
    deliver(live()[0]!, PINNED_BLOCKER_HIDE_LABEL_MAX_COLUMN_PX);
    expect(rowByAgentId("a").getAttribute("aria-label")).toBe("BLOCKED: Agent a in sparkle");
  });
});
