// @vitest-environment jsdom
//
// Covers the PromoRedeem control's failure/recovery contract (roborev 7018/7019): the control must
// recover (re-enable) after the awaited work instead of being stuck on "…", and it must
// distinguish a rejected code from a post-redeem refresh failure. Also pins the Rust→JS status-code
// string contracts from the JS side (a reword would flip these assertions red).
//
// The Redeem button now understands BOTH code systems: admin-issued coupons (/billing/coupon, the
// `/admin coupons` table) tried first, with the single-code PROMO_CODE override (/billing/promo) as
// the fallback for a code the coupon system doesn't recognize.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/sparkleApi", () => ({ redeemCoupon: vi.fn(), redeemPromo: vi.fn() }));
import { redeemCoupon, redeemPromo } from "../services/sparkleApi";
import { PromoRedeem } from "./AuthGate";

const mockCoupon = vi.mocked(redeemCoupon);
const mockPromo = vi.mocked(redeemPromo);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function typeCode(value: string) {
  fireEvent.change(screen.getByLabelText("Promo code"), { target: { value } });
}

function clickRedeem() {
  fireEvent.click(screen.getByRole("button", { name: "Redeem" }));
}

describe("PromoRedeem", () => {
  it("redeems an admin coupon (credit_grant), refreshes, and re-enables the control", async () => {
    mockCoupon.mockResolvedValue({ type: "credit_grant", grantedCents: 20000, balanceCents: 20000 });
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("LAUNCH20");
    clickRedeem();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(mockCoupon).toHaveBeenCalledWith("LAUNCH20");
    expect(mockPromo).not.toHaveBeenCalled(); // coupon succeeded → no fallback
    // Credits pane keeps this mounted → the grant is confirmed, not left silent.
    expect(await screen.findByText(/credits added/i)).toBeTruthy();
    // Not stuck on "…": the Redeem button comes back even if the gate doesn't unmount.
    await waitFor(() => expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy());
  });

  it("tells the user a discount coupon is applied at checkout and grants nothing here", async () => {
    mockCoupon.mockResolvedValue({ type: "discount", promotionCode: "SAVE10" });
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("SAVE10");
    clickRedeem();
    expect(await screen.findByText(/discount code/i)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(mockPromo).not.toHaveBeenCalled(); // a discount coupon must not fall back to the override
    expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy();
  });

  it("falls back to the PROMO_CODE override when the coupon system doesn't know the code", async () => {
    mockCoupon.mockRejectedValue("invalid_or_expired");
    mockPromo.mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("DRODIO");
    clickRedeem();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(mockPromo).toHaveBeenCalledWith("DRODIO");
    await waitFor(() => expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy());
  });

  it("falls back to the override on a transient coupon-endpoint error (not just invalid_or_expired)", async () => {
    // A momentary /billing/coupon network/5xx failure must not block an override-code holder — the
    // broadened fallback attempts redeemPromo for ANY non-already_redeemed coupon failure.
    mockCoupon.mockRejectedValue("coupon failed: HTTP 500: oops");
    mockPromo.mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("DRODIO");
    clickRedeem();
    await waitFor(() => expect(mockPromo).toHaveBeenCalledWith("DRODIO"));
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy());
  });

  it("shows a friendly message when neither the coupon nor the override accepts the code", async () => {
    mockCoupon.mockRejectedValue("invalid_or_expired");
    mockPromo.mockRejectedValue("invalid_code");
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("nope");
    clickRedeem();
    expect(await screen.findByText("That code didn't work.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy();
  });

  it("reports an already-redeemed coupon without falling back to the override", async () => {
    mockCoupon.mockRejectedValue("already_redeemed");
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("ONCE");
    clickRedeem();
    expect(await screen.findByText(/already redeemed/i)).toBeTruthy();
    expect(mockPromo).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy();
  });

  it("does NOT claim failure when the code was accepted but the refresh fails", async () => {
    mockCoupon.mockResolvedValue({ type: "credit_grant", grantedCents: 20000 });
    const refresh = vi.fn().mockRejectedValue(new Error("network"));
    render(<PromoRedeem refresh={refresh} />);
    typeCode("LAUNCH20");
    clickRedeem();
    // Redeem succeeded; the message must point at refresh, not say the code failed.
    expect(await screen.findByText(/redeemed/i)).toBeTruthy();
    expect(screen.queryByText("Couldn't redeem — try again.")).toBeNull();
    expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy();
  });
});
