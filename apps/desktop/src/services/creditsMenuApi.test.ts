// Service layer for the Credits settings pane (spec §2–§4). Pins the JS↔Rust command contract
// (command names + camelCase arg keys), the launch-failure fallback (startTopup resolves false and
// lastCheckoutUrl() exposes the URL for the copy/paste LaunchFallback), and the ledger-reason
// label map including unknown-reason passthrough (forward compatibility with new server reasons).
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
const openUrlMock = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrlMock(...a) }));

import {
  PACKS,
  fetchAutoTopup,
  fetchHistory,
  lastCheckoutUrl,
  reasonLabel,
  saveAutoTopup,
  startCardSetup,
  startTopup,
} from "./creditsMenuApi";

beforeEach(() => {
  invokeMock.mockReset();
  openUrlMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("PACKS", () => {
  it("lists the five 1:1 packs ascending", () => {
    expect(PACKS).toEqual([
      { id: "pack_10", amountCents: 1000 },
      { id: "pack_25", amountCents: 2500 },
      { id: "pack_100", amountCents: 10000 },
      { id: "pack_500", amountCents: 50000 },
      { id: "pack_1000", amountCents: 100000 },
    ]);
  });
});

describe("reasonLabel", () => {
  it("maps every known ledger reason to its human label", () => {
    expect(reasonLabel("paywall_topup")).toBe("Signup grant");
    expect(reasonLabel("credit_topup")).toBe("Top-up");
    expect(reasonLabel("credit_topup_auto")).toBe("Auto refill");
    expect(reasonLabel("promo_grant")).toBe("Promo");
    expect(reasonLabel("coupon_grant")).toBe("Coupon");
    expect(reasonLabel("anthropic_debit")).toBe("AI (Claude)");
    expect(reasonLabel("chief_debit")).toBe("Chief");
    expect(reasonLabel("deepgram_debit")).toBe("Cloud dictation");
    expect(reasonLabel("refund")).toBe("Refund");
    expect(reasonLabel("stripe_clawback")).toBe("Refund clawback");
  });

  it("passes unknown reasons through verbatim (forward-compatible)", () => {
    expect(reasonLabel("future_debit_kind")).toBe("future_debit_kind");
  });
});

describe("startTopup / startCardSetup", () => {
  it("fetches the checkout URL for the pack and launches it (true on success)", async () => {
    invokeMock.mockResolvedValue("https://checkout.stripe.com/c/pay_123");
    openUrlMock.mockResolvedValue(undefined);
    await expect(startTopup("pack_25")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("desktop_topup_checkout", {
      kind: "topup",
      pack: "pack_25",
    });
    expect(openUrlMock).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay_123");
  });

  it("resolves false and exposes lastCheckoutUrl() when the browser launch fails", async () => {
    invokeMock.mockResolvedValue("https://checkout.stripe.com/c/pay_456");
    openUrlMock.mockRejectedValue(new Error("Not allowed to open url"));
    await expect(startTopup("pack_100")).resolves.toBe(false);
    expect(lastCheckoutUrl()).toBe("https://checkout.stripe.com/c/pay_456");
  });

  it("propagates a server refusal and leaves no stale fallback URL", async () => {
    invokeMock.mockRejectedValue("bad_pack");
    await expect(startTopup("pack_25")).rejects.toBe("bad_pack");
    expect(lastCheckoutUrl()).toBeNull();
  });

  it("clears the fallback URL once a later launch succeeds", async () => {
    invokeMock.mockResolvedValue("https://checkout.stripe.com/c/a");
    openUrlMock.mockRejectedValueOnce(new Error("blocked"));
    await expect(startTopup("pack_10")).resolves.toBe(false);
    expect(lastCheckoutUrl()).toBe("https://checkout.stripe.com/c/a");
    openUrlMock.mockResolvedValue(undefined);
    await expect(startTopup("pack_10")).resolves.toBe(true);
    expect(lastCheckoutUrl()).toBeNull();
  });

  it("startCardSetup uses kind card_setup with no pack", async () => {
    invokeMock.mockResolvedValue("https://checkout.stripe.com/c/setup_1");
    openUrlMock.mockResolvedValue(undefined);
    await expect(startCardSetup()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("desktop_topup_checkout", {
      kind: "card_setup",
      pack: null,
    });
  });
});

describe("fetchHistory / auto-topup settings", () => {
  it("fetchHistory forwards the cursor (or null on first page)", async () => {
    const page = { entries: [], nextCursor: undefined };
    invokeMock.mockResolvedValue(page);
    await expect(fetchHistory()).resolves.toBe(page);
    expect(invokeMock).toHaveBeenCalledWith("desktop_credit_history", { cursor: null, limit: null });
    await fetchHistory("abc123");
    expect(invokeMock).toHaveBeenCalledWith("desktop_credit_history", {
      cursor: "abc123",
      limit: null,
    });
  });

  it("fetchAutoTopup returns the AutoTopup JSON verbatim", async () => {
    const settings = {
      enabled: false,
      thresholdCents: 500,
      packId: "pack_25",
      hasSavedCard: false,
      lastFailure: null,
    };
    invokeMock.mockResolvedValue(settings);
    await expect(fetchAutoTopup()).resolves.toBe(settings);
    expect(invokeMock).toHaveBeenCalledWith("desktop_auto_topup_get");
  });

  it("saveAutoTopup sends the contract camelCase fields and returns the server response", async () => {
    const saved = {
      enabled: true,
      thresholdCents: 1000,
      packId: "pack_100",
      hasSavedCard: true,
      lastFailure: null,
    };
    invokeMock.mockResolvedValue(saved);
    await expect(
      saveAutoTopup({ enabled: true, thresholdCents: 1000, packId: "pack_100" }),
    ).resolves.toBe(saved);
    expect(invokeMock).toHaveBeenCalledWith("desktop_auto_topup_set", {
      enabled: true,
      thresholdCents: 1000,
      packId: "pack_100",
    });
  });
});
