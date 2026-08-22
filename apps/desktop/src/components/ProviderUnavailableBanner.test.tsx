// @vitest-environment jsdom
//
// The "Sparkle's AI provider is down" banner — the counterpart to ZeroCreditBanner for the failure
// that is OURS. These cover the render branches plus the three things the copy must never do, which
// are the whole point of the component: offer a Refill (the user's balance is fine), blame their
// network, or render nothing at all while AI is dead.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderUnavailableBanner, PROVIDER_UNAVAILABLE_BAR_TESTID } from "./ProviderUnavailableBanner";
import { OUTAGE_MAX_AGE_MS, useAiProviderStore } from "../stores/aiProviderStore";
import { loadAccountState } from "../services/accountSelection";
import { useBlockedSubsystemsStore } from "../stores/blockedSubsystemsStore";
import { AI_ENHANCED_KEY } from "../engine/blockedSubsystems";

// The usage-limit branch reads the accounts' LIVE exhaustion flags through the shared seam. Mocked
// so a test can state what the accounts currently say without a Tauri backend.
vi.mock("../services/accountSelection", () => ({ loadAccountState: vi.fn() }));
const loadStateMock = vi.mocked(loadAccountState);
const MINE = "mine";

/** One settled read of account state, so a test can await exactly what the component awaited. */
function stateWith(exhaustedUntil: number | null) {
  return {
    accounts: [{ id: MINE, isDefault: true }],
    usage: [{ id: MINE, tokens5h: 0, tokens7d: 0, exhaustedUntil }],
    identities: [],
    failed: false,
  } as never;
}

beforeEach(() => {
  useAiProviderStore.setState({ outage: null });
  useBlockedSubsystemsStore.setState({ blocked: [] });
  loadStateMock.mockReset();
  loadStateMock.mockResolvedValue(stateWith(null));
});
afterEach(cleanup);

describe("ProviderUnavailableBanner", () => {
  it("renders nothing while the provider is healthy", () => {
    const { container } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("names the missing CLI and tells the user how to fix it", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Claude Code CLI");
    // The load-bearing half: the user must not read this as their own balance.
    // The copy used to say "ours to fix" and give the user nothing to do, because the cause was
    // Sparkle's own unfunded vendor account. Every remaining cause is theirs to act on, so the
    // sentence has to carry an action.
    expect(text).toContain("Install it");
    // The old copy reassured "your credits and network are fine", which was right when the cause
    // was Sparkle's own unfunded account. It is the wrong shape now — the cause IS the user's
    // setup — but the property underneath it survives and still matters: never send someone to the
    // credits screen for a problem a top-up cannot fix.
    expect(text).not.toMatch(/credit/i);
  });

  it("distinguishes a rejected key from an unfunded account", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_not_authenticated", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("sign in");
    expect(text).not.toContain("Install it");
  });

  it("offers NO refill affordance — taking the user's money would fix nothing", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent ?? "").not.toMatch(/refill|top up|upgrade|buy/i);
  });

  it("has no dismiss control — an outage the user cannot act on must not be re-hidden", () => {
    // ZeroCreditBanner has a ✕ because the user can act on it and may not want to now. Here a ✕
    // would restore exactly the silence that let a 12-hour outage go unnoticed.
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    expect(screen.queryByLabelText("Dismiss")).toBeNull();
  });

  it("renders the inline variant for Settings → Credits", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner inline />);
    expect(screen.getByRole("status").textContent ?? "").toContain("Claude Code CLI");
  });

  it("does not assert a STALE observation — a forgotten clear cannot strand a false banner", () => {
    // Second line of defence behind "every proxied wrapper reports success" (roborev 54761). The
    // banner has no dismiss control, so an un-cleared record would otherwise claim a broken provider
    // for the rest of the session while it is healthy.
    useAiProviderStore.setState({
      outage: { reason: "cli_missing", at: Date.now() - OUTAGE_MAX_AGE_MS - 1 },
    });
    const { container } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("disappears on its own once the provider recovers", () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    const { container, rerender } = render(<ProviderUnavailableBanner />);
    expect(container.innerHTML).not.toBe("");
    useAiProviderStore.setState({ outage: null });
    rerender(<ProviderUnavailableBanner />);
    expect(container.innerHTML).toBe("");
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
describe("what the banner asks the accounts seam for", () => {
  it("opts out of identities — it never reads them, and the leg is the expensive one", async () => {
    // sparkle-608gg: `accounts_identities` reads and JSON-parses every account's whole
    // `.claude.json`, and the seam's 5s cache TTL cannot absorb this 10s poll, so every tick paid
    // that parse in full for as long as a limit was showing. The banner uses only `usage` and
    // `accounts`, so it must ask for exactly those.
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    await act(async () => {
      await loadStateMock.mock.results[0]?.value;
    });
    expect(loadStateMock).toHaveBeenCalled();
    for (const [opts] of loadStateMock.mock.calls) {
      expect(opts).toMatchObject({ withIdentities: false });
    }
  });
});

describe("the bar's layout shape at a narrow window", () => {
  it("top-anchors its content rather than centring it", () => {
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const bar = screen.getByTestId(PROVIDER_UNAVAILABLE_BAR_TESTID);
    // `center` is the ONE value that can place the sentence's first line ABOVE this box's top
    // edge, where an ancestor with hidden overflow eats it — i.e. "the subject is cut off above
    // the viewport", with the reader unable to tell what the banner is even about.
    expect(bar.style.alignItems).toBe("flex-start");
  });

  it("never caps its own height — wrapping to more lines is the whole remedy", () => {
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const bar = screen.getByTestId(PROVIDER_UNAVAILABLE_BAR_TESTID);
    // A taller banner is fine; a clipped one is not. Anything that fixes the height here would
    // reintroduce "a box shorter than its content" with the centring gone but the damage back.
    expect(bar.style.height).toBe("");
    expect(bar.style.maxHeight).toBe("");
    // ...and the shell (a flex column) must not be able to squash it either.
    expect(bar.style.flexShrink).toBe("0");
  });

  it("lets the sentence wrap instead of spilling off both edges", () => {
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    const sentence = screen.getByRole("status");
    // A flex item's default `min-width: auto` floor is min-content, which makes a long sentence
    // OVERFLOW a narrow bar rather than wrap — and under `justify-content: center` it overflows
    // equally at both ends, leaving exactly the middle. That is the founder's fragment.
    expect(sentence.style.minWidth).toBe("0");
    expect(sentence.style.overflowWrap).toBe("break-word");
  });
});

// ── THE STALE-BANNER REGRESSION (bead drodio-website-229f.4) ──────────────────────────────────────
// The founder watched this banner assert "Sparkle's AI features are paused" while his whole fleet
// ran tool calls. The observation is latched and its only clear path is one of Sparkle's OWN AI
// calls later succeeding — which agent turns never are.
describe("the usage-limit banner reads live account state", () => {
  it("names when the limit resets, and says agents keep running", async () => {
    const until = Date.now() + 45 * 60_000;
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    loadStateMock.mockResolvedValue(stateWith(until));

    render(<ProviderUnavailableBanner />);
    await waitFor(() => {
      const text = screen.getByRole("status").textContent ?? "";
      // A real clock time, so the claim is checkable rather than the unfalsifiable "when it resets".
      expect(text).toMatch(/paused until \d/);
      // And it must stop implying the agent fleet is stopped, which caused the original confusion.
      expect(text).toContain("agents keep running");
    });
  });

  it("defers its full-width usage-limit bar to the red blocked bar (no duplicate about one fact), but returns when the block clears", async () => {
    // The red BlockedAgentsBanner and this amber usage-limit bar derive from the SAME default-account
    // bench. When AI-Enhanced is in the red bar, the amber duplicate must step aside. PAIRED: same
    // outage + bench, only the blocked list changes.
    const until = Date.now() + 45 * 60_000;
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    loadStateMock.mockResolvedValue(stateWith(until));
    useBlockedSubsystemsStore.setState({
      blocked: [{ key: AI_ENHANCED_KEY, label: "AI Enhancement Features" }],
    });

    const { rerender } = render(<ProviderUnavailableBanner />);
    await act(async () => {
      await Promise.all(loadStateMock.mock.results.map((r) => r.value));
    });
    expect(screen.queryByTestId(PROVIDER_UNAVAILABLE_BAR_TESTID)).toBeNull();

    // Clear the red block; the SAME usage-limit state now shows the amber bar again.
    act(() => useBlockedSubsystemsStore.setState({ blocked: [] }));
    rerender(<ProviderUnavailableBanner />);
    await waitFor(() => expect(screen.getByRole("status").textContent ?? "").toMatch(/paused until/));
  });

  it("still shows the INLINE usage-limit variant even while the red bar is up — it is context on its own pane, not a duplicate top bar", async () => {
    const until = Date.now() + 45 * 60_000;
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    loadStateMock.mockResolvedValue(stateWith(until));
    useBlockedSubsystemsStore.setState({
      blocked: [{ key: AI_ENHANCED_KEY, label: "AI Enhancement Features" }],
    });
    render(<ProviderUnavailableBanner inline />);
    await waitFor(() => expect(screen.getByRole("status").textContent ?? "").toMatch(/paused until/));
  });

  it("outlives the store's 10-minute expiry while the limit is verifiably still live", async () => {
    // OUTAGE_MAX_AGE_MS was the right bound on an UNVERIFIABLE claim. Reset instants are
    // minutes-to-hours out, so applying it to a verified limit would name a reset 45 minutes away
    // and vanish 10 minutes later — the "banner is lying" complaint, inverted.
    const until = Date.now() + 45 * 60_000;
    useAiProviderStore.setState({
      outage: { reason: "usage_limit", at: Date.now() - OUTAGE_MAX_AGE_MS - 1 },
    });
    loadStateMock.mockResolvedValue(stateWith(until));

    render(<ProviderUnavailableBanner />);
    await waitFor(() => expect(screen.getByRole("status").textContent ?? "").toMatch(/paused until/));
  });

  // ── NEVER SUPPRESS (knightwatch 5198911473#1 + #2) ──────────────────────────────────────────
  it("keeps the banner when the accounts show no bench, because that is not evidence of health", async () => {
    // A one-shot runs with --no-session-persistence and writes no transcript, so limit-sync can
    // never bench for its limit. Reading "no bench" as "not limited" would hide a real one.
    //
    // Awaits the recorded read INSIDE act before asserting, so this cannot pass on the initial
    // pre-read render — which is what made the earlier version of this test vacuous.
    useAiProviderStore.setState({ outage: { reason: "usage_limit", at: Date.now() } });
    loadStateMock.mockResolvedValue(stateWith(null));

    render(<ProviderUnavailableBanner />);
    await act(async () => {
      await Promise.all(loadStateMock.mock.results.map((r) => r.value));
    });
    expect(loadStateMock).toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("does not consult the accounts for a reason that has no account-level truth", async () => {
    useAiProviderStore.setState({ outage: { reason: "cli_missing", at: Date.now() } });
    render(<ProviderUnavailableBanner />);
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(loadStateMock).not.toHaveBeenCalled();
  });
});
