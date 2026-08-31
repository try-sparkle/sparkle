// THE FLOOR-MEASUREMENT KEY MUST NOT CHURN ON A WIDTH IT CANNOT MOVE (bead sparkle-vkdca).
//
// `measureChrome` reads `offsetWidth` per unshrinkable child, and each read forces a SYNCHRONOUS
// relayout of a deeply nested flex strip. That reflow fires whenever `tabMetricsSig` (the key of the
// measurement `useLayoutEffect`) changes. This file pins the SIDE EFFECT of the fix: the key is
// INVARIANT to inputs that move no rendered width, so a poll that ticks a hidden count no longer
// forces a full-strip relayout — while it still CHANGES when a rendered width really can move, so
// the floor never goes stale.
//
// WHY A UNIT TEST, NOT A RENDER TEST: jsdom never lays out, so `offsetWidth` is 0 and the real
// reflow is unobservable here (docs/jsdom-test-caveats.md). The key is a PURE function of the props,
// so its invariance IS the observable side effect — assert it directly rather than trying to count
// relayouts jsdom will not perform.
import { describe, expect, it } from "vitest";
import { tabMetricsSig, type ProjectTabCounts, type ProjectTabStaleness } from "./ProjectTabs";

const P = { id: "p1", name: "Sparkle" };
const counts = (needs_you: number, questions = 0): ProjectTabCounts => ({
  needs_you,
  questions,
  running: 0,
  done: 0,
} as ProjectTabCounts);
const stale = (behind: number): ProjectTabStaleness => ({ behind, base: "origin/main" });

// The two arguments the fix is about: a tab that is NOT active shows its count badge, one that IS
// active hides it (`tabBadgeCount` returns null on the active tab).
const inactive = (
  c: ProjectTabCounts | undefined,
  s?: ProjectTabStaleness,
): string => tabMetricsSig(P, c, s, false, false, false);
const activeTab = (
  c: ProjectTabCounts | undefined,
  s?: ProjectTabStaleness,
): string => tabMetricsSig(P, c, s, true, false, false);

describe("tabMetricsSig — the floor-measurement key", () => {
  // ── THE FIX: the width-invariant cases that used to force a reflow ──────────────────────────────

  it("does NOT change when the ACTIVE tab's count ticks — its badge is not rendered", () => {
    // The active tab is the one you are working in, so its counts tick fastest. No count badge shows
    // there, so none of these ticks can move a width — the key must stay put. This is the assertion
    // that goes RED if the active-tab count is ever folded back into the key.
    expect(activeTab(counts(5))).toBe(activeTab(counts(6)));
    expect(activeTab(counts(5))).toBe(activeTab(counts(500)));
    expect(activeTab(counts(1))).toBe(activeTab(counts(0)));
  });

  it("does NOT change when the band flips at the SAME count — the band is colour, not width", () => {
    // needs_you and questions render the same dot size and gap; only the ink differs. A flip between
    // them at an equal count is a repaint, not a re-layout.
    expect(inactive(counts(3, 0))).toBe(inactive(counts(0, 3)));
  });

  // ── THE GUARD: the width-relevant cases that MUST still re-measure ──────────────────────────────

  it("DOES change when an inactive tab's count value changes — BandBadge is a proportional font", () => {
    // `{count}` renders with no tabular-nums, so "5" and "6" (and "11" vs "18") are genuinely
    // different widths. Dropping the count value from the key would clip the tab name; keep it.
    expect(inactive(counts(5))).not.toBe(inactive(counts(6)));
  });

  it("DOES change when the count badge appears or disappears", () => {
    expect(inactive(counts(0))).not.toBe(inactive(counts(2)));
    expect(inactive(counts(2))).not.toBe(inactive(undefined));
  });

  it("DOES change when a tab becomes active — its count badge is removed from the chrome", () => {
    expect(inactive(counts(4))).not.toBe(activeTab(counts(4)));
  });

  it("DOES change on rename (label natural width) and on staleness (a tabular-nums badge)", () => {
    expect(tabMetricsSig(P, counts(1), undefined, false, false, false)).not.toBe(
      tabMetricsSig({ id: "p1", name: "Sparkle-renamed" }, counts(1), undefined, false, false, false),
    );
    expect(inactive(counts(1))).not.toBe(inactive(counts(1), stale(1696)));
    expect(inactive(counts(1), stale(5))).not.toBe(inactive(counts(1), stale(50)));
  });

  it("reflects the tear-out and close-control flags", () => {
    expect(tabMetricsSig(P, counts(1), undefined, false, false, false)).not.toBe(
      tabMetricsSig(P, counts(1), undefined, false, true, false),
    );
    expect(tabMetricsSig(P, counts(1), undefined, false, false, false)).not.toBe(
      tabMetricsSig(P, counts(1), undefined, false, false, true),
    );
  });
});
