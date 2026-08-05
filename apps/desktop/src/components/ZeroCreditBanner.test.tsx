// @vitest-environment jsdom
//
// The "$0 balance" banner: the honest, app-level counterpart to the per-feature credit gate. When
// the balance hits zero every AI enhancement goes dark (aiGate.hasAiCredits), and until now the
// only tells were feature-local (the mic notice, a silent no-op). These cover the render branches
// the pure rule in services/zeroCreditBanner.test.ts can't reach: the copy, the Refill deep-link,
// the ✕, and the zero-CROSSING reset that re-arms a dismissed banner after a refill is spent.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The zero-crossing / identity re-arm lives in authStore.refresh, which reads the keychain + /me
// through sparkleApi. Stub both so the real refresh path (not a bare setState) can be exercised.
const fetchMeMock = vi.fn();
vi.mock("../services/sparkleApi", () => ({
  hasToken: () => Promise.resolve(true),
  fetchMe: () => fetchMeMock(),
}));
/** Make the next authStore.refresh() resolve to this `me`. */
function seedFetchedMe(next: Me | null) {
  fetchMeMock.mockResolvedValue(next);
}

import { ZeroCreditBanner, ZERO_CREDIT_BAR_TESTID } from "./ZeroCreditBanner";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import type { Me } from "../services/entitlement";

const me = (over: Partial<Me> = {}): Me => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents: 0,
  tokenVersion: 1,
  ...over,
});

const COPY = "Your Sparkle credit balance is $0. AI Enhanced features will no longer work";

beforeEach(() => {
  fetchMeMock.mockReset();
  useAuthStore.setState({ me: me() });
  useUiStore.setState({
    settingsRequest: null,
    zeroCreditBannerDismissed: false,
    zeroCreditBannerDismissedFor: null,
  });
});
afterEach(cleanup);

describe("ZeroCreditBanner", () => {
  it("renders the founder's copy verbatim when an entitled user is at zero", () => {
    const { container } = render(<ZeroCreditBanner />);
    // Asserted on the rendered text as a whole: the sentence is one string to the reader even
    // though Refill and ✕ are sibling nodes inside the bar.
    expect(container.textContent).toContain(COPY);
  });

  it("renders nothing while the user still has credits", () => {
    useAuthStore.setState({ me: me({ balanceCents: 250 }) });
    const { container } = render(<ZeroCreditBanner />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when signed out / on the anonymous trial", () => {
    useAuthStore.setState({ me: null });
    const { container } = render(<ZeroCreditBanner />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a signed-in-but-unpaid user (the paywall owns that pitch)", () => {
    useAuthStore.setState({ me: me({ entitled: false }) });
    const { container } = render(<ZeroCreditBanner />);
    expect(container.textContent).toBe("");
  });

  it("offers Refill, which deep-opens the ⋯ settings dialog on the Credits pane", () => {
    render(<ZeroCreditBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Refill" }));
    expect(useUiStore.getState().settingsRequest).toBe("credits");
  });

  it("names the ✕ with aria-label, not just the tooltip", () => {
    // getByRole(name:) resolves identically whether the name comes from aria-label or `title`, which
    // is exactly why this attribute could flip twice on this branch with the suite staying green.
    // `title` is accname's last resort — absent on touch, invisible to keyboard users — so a button
    // whose only child is aria-hidden must not depend on it. (roborev 53047)
    render(<ZeroCreditBanner />);
    expect(screen.getByRole("button", { name: "Dismiss" }).getAttribute("aria-label")).toBe(
      "Dismiss",
    );
  });

  it("dismisses on ✕, recording WHOSE dismissal it is", () => {
    const { container } = render(<ZeroCreditBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(true);
    // The owner is what lets a different account signing in at $0 get its own warning while a
    // transient `me` blip does not resurrect this one's.
    expect(useUiStore.getState().zeroCreditBannerDismissedFor).toBe("u1");
    expect(container.textContent).toBe("");
  });

  it("does NOT persist the dismissal — a relaunch starts the flag clean", () => {
    render(<ZeroCreditBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // Positive control FIRST: without it this assertion also passes when the persist middleware
    // wrote nothing at all, which would make it vacuously green forever. Restored below — the theme
    // is a shared persisted key, so leaving it flipped leaks into every later test in the file.
    const themeBefore = useUiStore.getState().themePref;
    try {
      useUiStore.getState().setThemePref("dark");
      const persisted = JSON.parse(localStorage.getItem("sparkle-ui") ?? '{"state":{}}');
      expect(persisted.state?.themePref).toBe("dark");
      expect(persisted.state?.zeroCreditBannerDismissed).toBeUndefined();
    } finally {
      useUiStore.getState().setThemePref(themeBefore);
    }
  });

  it("re-arms on the next ZERO-CROSSING: dismiss → refill → spend back to zero shows it again", async () => {
    const { container, rerender } = render(<ZeroCreditBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container.textContent).toBe("");

    // They refill. The re-arm is driven by authStore (where the balance changes), NOT by this
    // component — so it is exercised here through the real refresh path, not a bare setState.
    seedFetchedMe(me({ balanceCents: 1000 }));
    await act(async () => {
      await useAuthStore.getState().refresh();
    });
    rerender(<ZeroCreditBanner />);
    expect(container.textContent).toBe("");
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);

    // They spend it back down. This is a NEW zero, so it must warn again.
    seedFetchedMe(me({ balanceCents: 0 }));
    await act(async () => {
      await useAuthStore.getState().refresh();
    });
    rerender(<ZeroCreditBanner />);
    expect(container.textContent).toContain(COPY);
  });

  it("re-arms even when NO banner is mounted — the rule belongs to the balance, not the view", async () => {
    // The regression this guards: with the reset as a render effect, a refill observed while the
    // banner was unmounted (a paywall/gate render, a future conditional surface) latched the
    // dismissal for the rest of the session and silently swallowed the next $0 episode.
    useUiStore.setState({ zeroCreditBannerDismissed: true, zeroCreditBannerDismissedFor: "u1" });
    seedFetchedMe(me({ balanceCents: 500 }));
    await act(async () => {
      await useAuthStore.getState().refresh();
    });
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
  });

  it("end-to-end: dismissing via the ✕ still lets the NEXT user see their own warning", async () => {
    // The other identity test seeds `zeroCreditBannerDismissedFor` by hand, so it stays green even
    // if the ✕ stops threading the owner id — which is exactly the wiring that was broken. This one
    // dismisses through the button, so the whole chain has to hold. (roborev 51700/51712)
    render(<ZeroCreditBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // Positive control: `false` is also the starting value, so without this the test would stay
    // green if the ✕ stopped latching a dismissal at all. (roborev 52980)
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(true);
    expect(useUiStore.getState().zeroCreditBannerDismissedFor).toBe("u1");
    seedFetchedMe(me({ clerkUserId: "u2", balanceCents: 0 }));
    await act(async () => {
      await useAuthStore.getState().refresh();
    });
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
  });

  it("does not carry one user's dismissal to the NEXT user signed in at $0", async () => {
    // Dismiss at $0, sign out, sign in as a DIFFERENT entitled account also at $0. Without an
    // identity-change reset the new user would never see the warning.
    useUiStore.setState({ zeroCreditBannerDismissed: true, zeroCreditBannerDismissedFor: "u1" });
    seedFetchedMe(me({ clerkUserId: "u2", balanceCents: 0 }));
    await act(async () => {
      await useAuthStore.getState().refresh();
    });
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
    const { container } = render(<ZeroCreditBanner />);
    expect(container.textContent).toContain(COPY);
  });

  it("a transient /me failure does NOT resurrect a dismissal — the balance never changed", async () => {
    // The regression (roborev 48271): treating `me` → null as an identity change meant a blip of bad
    // network re-showed a banner the user had explicitly dismissed. Here fetchMe() fails with no
    // valid entitlement cache, so `me` nulls — and the dismissal must survive it.
    useAuthStore.setState({ me: me(), cachedAt: null });
    useUiStore.setState({ zeroCreditBannerDismissed: true, zeroCreditBannerDismissedFor: "u1" });
    seedFetchedMe(null);
    await act(async () => {
      await useAuthStore.getState().refresh();
    });
    expect(useAuthStore.getState().me).toBeNull(); // positive control: the null path really ran
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(true);
  });

  it("clears the dismissal on an explicit sign-out", () => {
    useUiStore.setState({ zeroCreditBannerDismissed: true });
    useAuthStore.getState().reset();
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
  });

  it("the in-pane variant keeps the same sentence but drops the redundant Refill link", () => {
    // Rendered at the top of Settings → Credits, where a Refill affordance and the balance are
    // already on screen — repeating them would be noise, but the warning itself must still read
    // identically so the two surfaces can never drift apart.
    const { container } = render(<ZeroCreditBanner inline />);
    expect(container.textContent).toContain(COPY);
    expect(screen.queryByRole("button", { name: "Refill" })).toBeNull();
  });

  it("the in-pane variant ignores a dismissal — you are LOOKING at your credits", () => {
    useUiStore.setState({ zeroCreditBannerDismissed: true });
    const { container } = render(<ZeroCreditBanner inline />);
    expect(container.textContent).toContain(COPY);
  });

  it("the in-pane variant still respects the balance/entitlement gates", () => {
    useAuthStore.setState({ me: me({ balanceCents: 250 }) });
    const { container } = render(<ZeroCreditBanner inline />);
    expect(container.textContent).toBe("");
  });
});

/**
 * ── THE NARROW-WINDOW GUARD (bead sparkle-kk9dg.2) ─────────────────────────────────────────────
 *
 * jsdom has NO LAYOUT ENGINE, so nothing here can observe wrapping, overflow or clipping — a test
 * claiming to see the banner clipped would measure nothing at all (docs/jsdom-test-caveats.md).
 * These assert the STYLE SHAPE only. The pixels are proven separately, in real Chrome, by
 * BannerStack.layout.test.ts; this block is the cheap always-runs guard that the two properties
 * that shape survive are still on the element.
 */
describe("the bar's layout shape at a narrow window", () => {
  it("top-anchors its content rather than centring it", () => {
    render(<ZeroCreditBanner />);
    const bar = screen.getByTestId(ZERO_CREDIT_BAR_TESTID);
    // `center` is the ONE value that can place the sentence's first line ABOVE this box's top
    // edge, where an ancestor with hidden overflow eats it — i.e. "the subject is cut off above
    // the viewport", with the reader unable to tell what the banner is even about.
    expect(bar.style.alignItems).toBe("flex-start");
  });

  it("never caps its own height — wrapping to more lines is the whole remedy", () => {
    render(<ZeroCreditBanner />);
    const bar = screen.getByTestId(ZERO_CREDIT_BAR_TESTID);
    // A taller banner is fine; a clipped one is not. Anything that fixes the height here would
    // reintroduce "a box shorter than its content" with the centring gone but the damage back.
    expect(bar.style.height).toBe("");
    expect(bar.style.maxHeight).toBe("");
    // ...and the shell (a flex column) must not be able to squash it either.
    expect(bar.style.flexShrink).toBe("0");
  });

  it("lets the sentence wrap instead of spilling off both edges", () => {
    render(<ZeroCreditBanner />);
    const sentence = screen.getByRole("status");
    // A flex item's default `min-width: auto` floor is min-content, which makes a long sentence
    // OVERFLOW a narrow bar rather than wrap — and under `justify-content: center` it overflows
    // equally at both ends, leaving exactly the middle. That is the founder's fragment.
    expect(sentence.style.minWidth).toBe("0");
    expect(sentence.style.overflowWrap).toBe("break-word");
  });

  it("lets the LINE break too — this bar carries an item that cannot shrink", () => {
    useAuthStore.setState({ me: me() });
    render(<ZeroCreditBanner />);
    const bar = screen.getByTestId(ZERO_CREDIT_BAR_TESTID);
    // ONLY THIS BAR OF THE THREE NEEDS THIS, and it is the one behavioural property the
    // real-Chrome suite proves that CI cannot run (it stands down without a Chromium — see
    // BannerStack.layout.test.ts). `min-width: 0` frees the SENTENCE to wrap, but `RefillLink` is
    // an in-flow flex item that cannot shrink, so once the line's unshrinkable content exceeds the
    // bar, `justify-content: center` pushes it off BOTH ends. Measured at 100px: 15.3px left of
    // the bar's own padding edge, with everything else already fixed. (roborev 58706/58707)
    expect(bar.style.flexWrap).toBe("wrap");
  });
});
