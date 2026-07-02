// @vitest-environment jsdom
//
// The Credits settings pane (credits-menu spec §1–§2): state-aware on the entitlement store —
// signed-out/trial → $99 upsell; signed-in-unpaid → upsell + promo box; entitled → balance +
// the five 1:1 top-up packs. Pack buttons must send a pack ID (never an amount), and a failed
// browser launch must surface the checkout URL as a copy/paste fallback (never a dead button).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startTopupMock = vi.fn();
const lastCheckoutUrlMock = vi.fn();
const startCardSetupMock = vi.fn();
const fetchHistoryMock = vi.fn();
const fetchAutoTopupMock = vi.fn();
const saveAutoTopupMock = vi.fn();
vi.mock("../services/creditsMenuApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/creditsMenuApi")>()),
  startTopup: (...a: unknown[]) => startTopupMock(...a),
  lastCheckoutUrl: () => lastCheckoutUrlMock(),
  startCardSetup: (...a: unknown[]) => startCardSetupMock(...a),
  fetchHistory: (...a: unknown[]) => fetchHistoryMock(...a),
  fetchAutoTopup: (...a: unknown[]) => fetchAutoTopupMock(...a),
  saveAutoTopup: (...a: unknown[]) => saveAutoTopupMock(...a),
}));
const openPaywallMock = vi.fn();
vi.mock("../services/sparkleApi", () => ({
  openPaywall: () => openPaywallMock(),
  PAYWALL_URL: "https://sparkle.ai/paywall",
  redeemPromo: vi.fn(), // PromoRedeem imports it at module load
}));

import { CreditsPanel } from "./CreditsPanel";
import { useAuthStore } from "../stores/authStore";
import type { Me } from "../services/entitlement";

const entitledMe: Me = {
  clerkUserId: "user_1",
  entitled: true,
  balanceCents: 18250,
  tokenVersion: 1,
};

const defaultAutoTopup = {
  enabled: false,
  thresholdCents: 500,
  packId: "pack_25",
  hasSavedCard: true,
  lastFailure: null,
};

beforeEach(() => {
  useAuthStore.setState({
    me: null,
    tokenPresent: false,
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  fetchHistoryMock.mockResolvedValue({ entries: [] });
  fetchAutoTopupMock.mockResolvedValue(defaultAutoTopup);
  saveAutoTopupMock.mockResolvedValue(defaultAutoTopup);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CreditsPanel visibility states", () => {
  it("shows the $99 upsell (no pack buttons, no promo box) when signed out", () => {
    render(<CreditsPanel />);
    expect(screen.getByText(/Unlock Sparkle/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "$25" })).toBeNull();
    expect(screen.queryByLabelText("Promo code")).toBeNull();
  });

  it("shows loading (not the upsell) while the initial /me fetch is in flight", () => {
    useAuthStore.setState({ me: null, tokenPresent: false, loading: true });
    render(<CreditsPanel />);
    expect(screen.queryByText(/Unlock Sparkle/)).toBeNull();
  });

  it("shows a retryable reconnect state (never the upsell) when signed in but /me failed", () => {
    // fetchMe() nulls `me` on ANY auth/network failure; with a token present that's a transient
    // failure for an (often entitled) user — downgrading them to the $99 pitch would be wrong.
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ me: null, tokenPresent: true, loading: false, refresh });
    render(<CreditsPanel />);
    expect(screen.getByText(/Couldn't load your account/)).toBeTruthy();
    expect(screen.queryByText(/Unlock Sparkle/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry account" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the upsell plus the promo box when signed in but unpaid", () => {
    useAuthStore.setState({ me: { ...entitledMe, entitled: false }, tokenPresent: true });
    render(<CreditsPanel />);
    expect(screen.getByText(/Unlock Sparkle/)).toBeTruthy();
    expect(screen.getByLabelText("Promo code")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "$25" })).toBeNull();
  });

  it("shows the balance and the five pack buttons when entitled", () => {
    useAuthStore.setState({ me: entitledMe, tokenPresent: true });
    render(<CreditsPanel />);
    expect(screen.getByText("$182.50")).toBeTruthy();
    for (const label of ["$10", "$25", "$100", "$500", "$1,000"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });
});

describe("buying a pack", () => {
  beforeEach(() => {
    useAuthStore.setState({ me: entitledMe, tokenPresent: true });
  });

  it("starts checkout with the right pack id and shows the in-browser hint on success", async () => {
    startTopupMock.mockResolvedValue(true);
    render(<CreditsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "$25" }));
    await waitFor(() => expect(startTopupMock).toHaveBeenCalledWith("pack_25"));
    expect(await screen.findByText(/Complete the purchase in your browser/)).toBeTruthy();
  });

  it("falls back to the copy/paste URL when the browser launch fails", async () => {
    startTopupMock.mockResolvedValue(false);
    lastCheckoutUrlMock.mockReturnValue("https://checkout.stripe.com/c/pay_789");
    render(<CreditsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "$100" }));
    expect(await screen.findByText("https://checkout.stripe.com/c/pay_789")).toBeTruthy();
    expect(startTopupMock).toHaveBeenCalledWith("pack_100");
  });

  it("upsell button routes to the paywall and falls back on launch failure", async () => {
    useAuthStore.setState({ me: null, tokenPresent: false });
    openPaywallMock.mockResolvedValue(false);
    render(<CreditsPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Pay \$99/ }));
    expect(await screen.findByText("https://sparkle.ai/paywall")).toBeTruthy();
  });

  it("shows an inline error and re-enables the buttons when the server refuses the checkout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    startTopupMock.mockRejectedValue("bad_pack");
    render(<CreditsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "$25" }));
    expect(await screen.findByText("Couldn't start checkout — try again.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "$25" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("disables every pack button while a launch is in flight", async () => {
    let resolve!: (v: boolean) => void;
    startTopupMock.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    render(<CreditsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "$25" }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "$1,000" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    resolve(true);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "$1,000" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("ignores double-clicks on the $99 upsell button while a launch is pending", async () => {
    useAuthStore.setState({ me: null, tokenPresent: false });
    let resolve!: (v: boolean) => void;
    openPaywallMock.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    render(<CreditsPanel />);
    const btn = screen.getByRole("button", { name: /Pay \$99/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(openPaywallMock).toHaveBeenCalledTimes(1);
    resolve(true);
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });

  it("refreshes entitlement when the window regains focus while the pane is open", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ me: entitledMe, tokenPresent: true, refresh });
    render(<CreditsPanel />);
    refresh.mockClear();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("auto-refill block", () => {
  beforeEach(() => {
    useAuthStore.setState({ me: entitledMe, tokenPresent: true });
  });

  it("toggle round-trips through saveAutoTopup and renders the server response", async () => {
    saveAutoTopupMock.mockResolvedValue({ ...defaultAutoTopup, enabled: true });
    render(<CreditsPanel />);
    const toggle = await screen.findByLabelText("Auto-refill when low");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(saveAutoTopupMock).toHaveBeenCalledWith({
        enabled: true,
        thresholdCents: 500,
        packId: "pack_25",
      }),
    );
    // Server said enabled → the two selects appear, reflecting the server state.
    expect(await screen.findByLabelText("Refill threshold")).toBeTruthy();
    expect(screen.getByLabelText("Refill pack")).toBeTruthy();
    expect((screen.getByLabelText("Auto-refill when low") as HTMLInputElement).checked).toBe(true);
  });

  it("changing the threshold saves and re-renders from the server response", async () => {
    fetchAutoTopupMock.mockResolvedValue({ ...defaultAutoTopup, enabled: true });
    saveAutoTopupMock.mockResolvedValue({
      ...defaultAutoTopup,
      enabled: true,
      thresholdCents: 1000,
    });
    render(<CreditsPanel />);
    const select = await screen.findByLabelText("Refill threshold");
    fireEvent.change(select, { target: { value: "1000" } });
    await waitFor(() =>
      expect(saveAutoTopupMock).toHaveBeenCalledWith({
        enabled: true,
        thresholdCents: 1000,
        packId: "pack_25",
      }),
    );
  });

  it("switching to a smaller pack clamps the threshold so the save can't 400 (server runaway-charge guard)", async () => {
    // Threshold $25 with the $25 pack is legal; shrinking to the $10 pack must clamp to $10.
    fetchAutoTopupMock.mockResolvedValue({
      ...defaultAutoTopup,
      enabled: true,
      thresholdCents: 2500,
    });
    saveAutoTopupMock.mockResolvedValue({
      ...defaultAutoTopup,
      enabled: true,
      thresholdCents: 1000,
      packId: "pack_10",
    });
    render(<CreditsPanel />);
    const packSelect = await screen.findByLabelText("Refill pack");
    fireEvent.change(packSelect, { target: { value: "pack_10" } });
    await waitFor(() =>
      expect(saveAutoTopupMock).toHaveBeenCalledWith({
        enabled: true,
        thresholdCents: 1000, // clamped from 2500 to the pack's grant
        packId: "pack_10",
      }),
    );
    // And thresholds above the (now $10) pack are unpickable.
    const thresholdSelect = screen.getByLabelText("Refill threshold");
    const option = Array.from(thresholdSelect.querySelectorAll("option")).find(
      (o) => o.value === "2500",
    ) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("enabling without a saved card shows Save a card first and does not enable", async () => {
    fetchAutoTopupMock.mockResolvedValue({ ...defaultAutoTopup, hasSavedCard: false });
    render(<CreditsPanel />);
    const toggle = await screen.findByLabelText("Auto-refill when low");
    fireEvent.click(toggle);
    expect(await screen.findByText(/Save a card first/)).toBeTruthy();
    expect(saveAutoTopupMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Auto-refill when low") as HTMLInputElement).checked).toBe(
      false,
    );
    // The inline row's button launches the setup-mode checkout.
    startCardSetupMock.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Save card/ }));
    await waitFor(() => expect(startCardSetupMock).toHaveBeenCalled());
  });

  it("renders the failure warning when lastFailure is set", async () => {
    fetchAutoTopupMock.mockResolvedValue({ ...defaultAutoTopup, lastFailure: "card_declined" });
    render(<CreditsPanel />);
    expect(await screen.findByText(/Auto-refill failed \(card_declined\)/)).toBeTruthy();
  });

  it("keeps the toggle at server state and shows an alert when the save fails", async () => {
    saveAutoTopupMock.mockRejectedValue(new Error("network"));
    render(<CreditsPanel />);
    fireEvent.click(await screen.findByLabelText("Auto-refill when low"));
    expect(await screen.findByText(/Couldn't save auto-refill settings/)).toBeTruthy();
    expect((screen.getByLabelText("Auto-refill when low") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("falls back to the copy/paste URL when the card-setup launch fails", async () => {
    fetchAutoTopupMock.mockResolvedValue({ ...defaultAutoTopup, hasSavedCard: false });
    startCardSetupMock.mockResolvedValue(false);
    lastCheckoutUrlMock.mockReturnValue("https://checkout.stripe.com/c/setup_9");
    render(<CreditsPanel />);
    fireEvent.click(await screen.findByLabelText("Auto-refill when low"));
    fireEvent.click(await screen.findByRole("button", { name: /Save card/ }));
    expect(await screen.findByText("https://checkout.stripe.com/c/setup_9")).toBeTruthy();
  });

  it("shows a card-setup-specific error when the server refuses the setup checkout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchAutoTopupMock.mockResolvedValue({ ...defaultAutoTopup, hasSavedCard: false });
    startCardSetupMock.mockRejectedValue("boom");
    render(<CreditsPanel />);
    fireEvent.click(await screen.findByLabelText("Auto-refill when low"));
    fireEvent.click(await screen.findByRole("button", { name: /Save card/ }));
    expect(await screen.findByText("Couldn't start card setup — try again.")).toBeTruthy();
  });

  it("falls back to me.autoTopup when fetchAutoTopup fails", async () => {
    fetchAutoTopupMock.mockRejectedValue(new Error("network"));
    useAuthStore.setState({
      me: {
        ...entitledMe,
        autoTopup: {
          enabled: true,
          thresholdCents: 500,
          packId: "pack_25",
          hasSavedCard: true,
          lastFailure: null,
        },
      },
      tokenPresent: true,
    });
    render(<CreditsPanel />);
    // Enabled per the fallback → the selects render; no inline load error.
    expect(await screen.findByLabelText("Refill threshold")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load auto-refill settings/)).toBeNull();
  });

  it("re-reads the settings when the window regains focus (card saved in the browser)", async () => {
    fetchAutoTopupMock.mockResolvedValueOnce({ ...defaultAutoTopup, hasSavedCard: false });
    render(<CreditsPanel />);
    await screen.findByLabelText("Auto-refill when low");
    fetchAutoTopupMock.mockResolvedValue({ ...defaultAutoTopup, hasSavedCard: true });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fetchAutoTopupMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("shows an inline error + Retry when settings can't load, leaving the rest alive", async () => {
    fetchAutoTopupMock.mockRejectedValue(new Error("network"));
    render(<CreditsPanel />);
    expect(await screen.findByText(/Couldn't load auto-refill settings/)).toBeTruthy();
    expect(screen.getByText("$182.50")).toBeTruthy();
    fetchAutoTopupMock.mockResolvedValue(defaultAutoTopup);
    fireEvent.click(screen.getByRole("button", { name: "Retry auto-refill settings" }));
    expect(await screen.findByLabelText("Auto-refill when low")).toBeTruthy();
  });
});

describe("history block", () => {
  beforeEach(() => {
    useAuthStore.setState({ me: entitledMe, tokenPresent: true });
  });

  it("renders signed amounts and reason labels, unknown reasons verbatim", async () => {
    fetchHistoryMock.mockResolvedValue({
      entries: [
        { id: "1", createdAt: "2026-06-30T10:00:00Z", reason: "credit_topup", deltaCents: 2500 },
        { id: "2", createdAt: "2026-06-29T10:00:00Z", reason: "weird_reason", deltaCents: -125 },
      ],
    });
    render(<CreditsPanel />);
    expect(await screen.findByText("Top-up")).toBeTruthy();
    expect(screen.getByText("+$25.00")).toBeTruthy();
    expect(screen.getByText("weird_reason")).toBeTruthy();
    expect(screen.getByText("−$1.25")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("Load more appends the next page while nextCursor is present", async () => {
    fetchHistoryMock.mockResolvedValueOnce({
      entries: [
        { id: "1", createdAt: "2026-06-30T10:00:00Z", reason: "credit_topup", deltaCents: 2500 },
      ],
      nextCursor: "c1",
    });
    render(<CreditsPanel />);
    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fetchHistoryMock.mockResolvedValueOnce({
      entries: [
        { id: "2", createdAt: "2026-06-29T10:00:00Z", reason: "promo_grant", deltaCents: 500 },
      ],
    });
    fireEvent.click(loadMore);
    await waitFor(() => expect(fetchHistoryMock).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("Promo")).toBeTruthy();
    expect(screen.getByText("Top-up")).toBeTruthy(); // page 1 still there
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("shows the empty state when there is no activity", async () => {
    render(<CreditsPanel />);
    expect(await screen.findByText("No activity yet.")).toBeTruthy();
  });

  it("keeps loaded rows and shows error + Retry when Load more fails", async () => {
    fetchHistoryMock.mockResolvedValueOnce({
      entries: [
        { id: "1", createdAt: "2026-06-30T10:00:00Z", reason: "credit_topup", deltaCents: 2500 },
      ],
      nextCursor: "c1",
    });
    render(<CreditsPanel />);
    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fetchHistoryMock.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(loadMore);
    expect(await screen.findByText(/Couldn't load history/)).toBeTruthy();
    expect(screen.getByText("Top-up")).toBeTruthy(); // page 1 must NOT vanish
    fetchHistoryMock.mockResolvedValueOnce({
      entries: [
        { id: "2", createdAt: "2026-06-29T10:00:00Z", reason: "promo_grant", deltaCents: 500 },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("Promo")).toBeTruthy();
    expect(screen.getByText("Top-up")).toBeTruthy();
  });

  it("shows an inline error + Retry on fetch failure without killing the balance header", async () => {
    fetchHistoryMock.mockRejectedValueOnce(new Error("network"));
    render(<CreditsPanel />);
    expect(await screen.findByText(/Couldn't load history/)).toBeTruthy();
    expect(screen.getByText("$182.50")).toBeTruthy();
    fetchHistoryMock.mockResolvedValueOnce({
      entries: [
        { id: "1", createdAt: "2026-06-30T10:00:00Z", reason: "refund", deltaCents: 300 },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("Refund")).toBeTruthy();
  });
});
