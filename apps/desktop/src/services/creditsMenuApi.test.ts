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
  checkoutGuidance,
  classifyCheckoutError,
  fetchAutoTopup,
  fetchHistory,
  historyLabel,
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

describe("historyLabel", () => {
  it("renders '<tag>: <description>' when the row carries a description", () => {
    expect(
      historyLabel({ reason: "anthropic_debit", description: "Renamed agent to 'Fix OAuth loop'" }),
    ).toBe("AI: Renamed agent to 'Fix OAuth loop'");
  });

  it("falls back to the static reason label when description is null/absent/blank", () => {
    expect(historyLabel({ reason: "anthropic_debit", description: null })).toBe("AI (Claude)");
    expect(historyLabel({ reason: "anthropic_debit" })).toBe("AI (Claude)");
    expect(historyLabel({ reason: "anthropic_debit", description: "   " })).toBe("AI (Claude)");
    expect(historyLabel({ reason: "credit_topup", description: null })).toBe("Top-up");
  });

  it("uses a compact tag per reason, falling back to the full reasonLabel for untagged reasons", () => {
    expect(historyLabel({ reason: "chief_debit", description: "Interview synthesis" })).toBe(
      "Chief: Interview synthesis",
    );
    expect(historyLabel({ reason: "deepgram_debit", description: "Transcribed a voice note" })).toBe(
      "Dictation: Transcribed a voice note",
    );
    // An unknown/untagged reason with a description uses reasonLabel(reason) (verbatim) as the tag.
    expect(historyLabel({ reason: "future_kind", description: "did a thing" })).toBe(
      "future_kind: did a thing",
    );
  });

  it("truncates a very long description with an ellipsis so the row stays one line", () => {
    const long = "x".repeat(300);
    const out = historyLabel({ reason: "anthropic_debit", description: long });
    expect(out.startsWith("AI: ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    // "AI: " (4) + 120 codepoints.
    expect([...out].length).toBeLessThanOrEqual(4 + 120);
  });

  it("truncates by codepoints so a surrogate pair (emoji) is never split", () => {
    const emoji = "😀".repeat(300); // each is a non-BMP surrogate pair
    const out = historyLabel({ reason: "anthropic_debit", description: emoji });
    // No lone surrogate / replacement char leaked into the output.
    expect(out).not.toContain("�");
    expect(/[\uD800-\uDFFF]/.test(out.replace(/😀/g, ""))).toBe(false);
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

describe("classifyCheckoutError (structured Rust error → recovery bucket)", () => {
  it("maps the prod 403 StripePermissionError to the our-side config bucket", () => {
    // The real prod failure: restricted key lacking customer_write → checkout returns 403.
    expect(
      classifyCheckoutError(JSON.stringify({ class: "server", status: 403, code: "stripe_permission" })),
    ).toBe("config");
  });

  it("treats 5xx and a URL-less 2xx (no status) as config too", () => {
    expect(classifyCheckoutError(JSON.stringify({ class: "server", status: 502 }))).toBe("config");
    expect(classifyCheckoutError(JSON.stringify({ class: "server", code: "missing_url" }))).toBe(
      "config",
    );
  });

  it("routes 401 and the not_signed_in class to sign-in", () => {
    expect(classifyCheckoutError(JSON.stringify({ class: "not_signed_in" }))).toBe("not_signed_in");
    expect(classifyCheckoutError(JSON.stringify({ class: "server", status: 401 }))).toBe(
      "not_signed_in",
    );
  });

  it("maps the offline class to offline", () => {
    expect(classifyCheckoutError(JSON.stringify({ class: "offline" }))).toBe("offline");
  });

  it("treats a benign 4xx (e.g. bad_pack) as a plain retry", () => {
    expect(
      classifyCheckoutError(JSON.stringify({ class: "server", status: 409, code: "bad_pack" })),
    ).toBe("generic");
  });

  it("degrades gracefully when the error is opaque (not our structured JSON)", () => {
    // A plain server code string (evolving server contract) or Error still classifies conservatively.
    expect(classifyCheckoutError("bad_pack")).toBe("generic");
    expect(classifyCheckoutError("not signed in")).toBe("not_signed_in");
    expect(classifyCheckoutError(new Error("network request timed out"))).toBe("offline");
    expect(classifyCheckoutError("StripePermissionError: forbidden")).toBe("config");
    expect(classifyCheckoutError(undefined)).toBe("generic");
  });
});

describe("checkoutGuidance (bucket → user-facing guidance)", () => {
  it("config guidance blames Sparkle, says retry won't help, and offers support (no raw Stripe text)", () => {
    const g = checkoutGuidance(JSON.stringify({ class: "server", status: 403, code: "stripe_permission" }));
    expect(g.cls).toBe("config");
    expect(g.showSupport).toBe(true);
    expect(g.needsSignIn).toBe(false);
    expect(g.message).toMatch(/Sparkle's side/);
    expect(g.message).toMatch(/won't help/i);
    // Never leak internal/Stripe details to the user.
    expect(g.message.toLowerCase()).not.toContain("stripe");
    expect(g.message).not.toContain("403");
  });

  it("offline guidance lets the user retry and never shows support", () => {
    const g = checkoutGuidance(JSON.stringify({ class: "offline" }));
    expect(g.cls).toBe("offline");
    expect(g.message).toMatch(/offline/i);
    expect(g.showSupport).toBe(false);
    expect(g.needsSignIn).toBe(false);
  });

  it("not-signed-in guidance offers a sign-in path", () => {
    const g = checkoutGuidance(JSON.stringify({ class: "not_signed_in" }));
    expect(g.needsSignIn).toBe(true);
    expect(g.showSupport).toBe(false);
  });

  it("generic guidance keeps the stable 'try again' copy", () => {
    expect(checkoutGuidance("bad_pack").message).toBe("Couldn't start checkout — try again.");
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
