// @vitest-environment jsdom
//
// Covers the PromoRedeem control's failure/recovery contract (roborev 7018/7019): the control must
// recover (re-enable) after the awaited work instead of being stuck on "…", and it must
// distinguish a rejected code from a post-redeem refresh failure. Also pins the Rust→JS
// "invalid_code" string contract from the JS side (a reword would flip these assertions red).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/sparkleApi", () => ({ redeemPromo: vi.fn() }));
import { redeemPromo } from "../services/sparkleApi";
import { PromoRedeem } from "./AuthGate";

const mockRedeem = vi.mocked(redeemPromo);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function typeCode(value: string) {
  fireEvent.change(screen.getByLabelText("Promo code"), { target: { value } });
}

describe("PromoRedeem", () => {
  it("refreshes entitlement on a successful redeem and re-enables the control", async () => {
    mockRedeem.mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("DRODIO");
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(mockRedeem).toHaveBeenCalledWith("DRODIO");
    // Not stuck on "…": the Redeem button comes back even if the gate doesn't unmount.
    await waitFor(() => expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy());
  });

  it("shows a friendly message for a rejected code and re-enables", async () => {
    mockRedeem.mockRejectedValue("invalid_code");
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<PromoRedeem refresh={refresh} />);
    typeCode("nope");
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));
    expect(await screen.findByText("That code didn't work.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy();
  });

  it("does NOT claim failure when the code was accepted but the refresh fails", async () => {
    mockRedeem.mockResolvedValue(undefined);
    const refresh = vi.fn().mockRejectedValue(new Error("network"));
    render(<PromoRedeem refresh={refresh} />);
    typeCode("DRODIO");
    fireEvent.click(screen.getByRole("button", { name: "Redeem" }));
    // Redeem succeeded; the message must point at refresh, not say the code failed.
    expect(await screen.findByText(/redeemed/i)).toBeTruthy();
    expect(screen.queryByText("Couldn't redeem — try again.")).toBeNull();
    expect(screen.getByRole("button", { name: "Redeem" })).toBeTruthy();
  });
});
