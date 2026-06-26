import { describe, expect, it, vi } from "vitest";
import {
  AiDisabledError,
  OutOfCreditsError,
  withCredits,
  getRetentionEntitlement,
  purchaseRetention,
  type CreditDeps,
} from "./credits";

function deps(over: Partial<CreditDeps> = {}): CreditDeps {
  return {
    isAiEnabled: () => true,
    consume: vi.fn(
      async () => ({ ok: true, balanceAfterCents: 19990, ledgerId: "led_1" }) as const,
    ),
    refund: vi.fn(async () => {}),
    ...over,
  };
}

describe("withCredits", () => {
  it("short-circuits with AiDisabledError when AI is off — no debit, no run", async () => {
    const consume = vi.fn();
    const run = vi.fn();
    await expect(
      withCredits({ estimateCents: 10, reason: "anthropic_debit" }, run, deps({ isAiEnabled: () => false, consume })),
    ).rejects.toBeInstanceOf(AiDisabledError);
    expect(consume).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("debits before running and returns the action result", async () => {
    const order: string[] = [];
    const consume = vi.fn(async () => {
      order.push("consume");
      return { ok: true, balanceAfterCents: 19990, ledgerId: "led_1" } as const;
    });
    const run = vi.fn(async () => {
      order.push("run");
      return "result";
    });
    const out = await withCredits(
      { estimateCents: 10, reason: "anthropic_debit" },
      run,
      deps({ consume }),
    );
    expect(out).toBe("result");
    expect(order).toEqual(["consume", "run"]);
  });

  it("throws OutOfCreditsError (and never runs) when underfunded", async () => {
    const run = vi.fn();
    await expect(
      withCredits(
        { estimateCents: 99999, reason: "anthropic_debit" },
        run,
        deps({ consume: vi.fn(async () => ({ ok: false, balanceCents: 5 }) as const) }),
      ),
    ).rejects.toMatchObject({ name: "OutOfCreditsError", balanceCents: 5 });
    expect(run).not.toHaveBeenCalled();
  });

  it("refunds (best-effort) the debit's ledger id when the action throws, then rethrows", async () => {
    const refund = vi.fn(async () => {});
    const boom = new Error("model exploded");
    await expect(
      withCredits(
        { estimateCents: 10, reason: "chief_debit", idempotencyKey: "k1" },
        async () => {
          throw boom;
        },
        deps({
          consume: vi.fn(
            async () => ({ ok: true, balanceAfterCents: 9, ledgerId: "led_99" }) as const,
          ),
          refund,
        }),
      ),
    ).rejects.toBe(boom);
    expect(refund).toHaveBeenCalledWith("led_99");
  });

  it("does not mask the original error if the refund itself fails", async () => {
    const boom = new Error("model exploded");
    await expect(
      withCredits(
        { estimateCents: 10, reason: "chief_debit" },
        async () => {
          throw boom;
        },
        deps({
          refund: vi.fn(async () => {
            throw new Error("refund network error");
          }),
        }),
      ),
    ).rejects.toBe(boom);
  });

  it("does not refund when the action succeeds", async () => {
    const refund = vi.fn(async () => {});
    await withCredits({ estimateCents: 10, reason: "anthropic_debit" }, async () => "ok", deps({ refund }));
    expect(refund).not.toHaveBeenCalled();
  });

  it("passes idempotencyKey + meta through to consume", async () => {
    const consume = vi.fn(
      async () => ({ ok: true, balanceAfterCents: 1, ledgerId: "led_1" }) as const,
    );
    await withCredits(
      { estimateCents: 8, reason: "anthropic_debit", meta: { model: "x" }, idempotencyKey: "abc" },
      async () => 1,
      deps({ consume }),
    );
    expect(consume).toHaveBeenCalledWith(8, "anthropic_debit", { model: "x" }, "abc");
  });

  it("exposes the error classes", () => {
    expect(new OutOfCreditsError(0)).toBeInstanceOf(Error);
    expect(new AiDisabledError()).toBeInstanceOf(Error);
  });
});

describe("retention entitlement (stub)", () => {
  it("defaults to the free 24h tier", async () => {
    await expect(getRetentionEntitlement()).resolves.toBe("24h");
  });

  it("purchaseRetention is not implemented yet — rejects", async () => {
    await expect(purchaseRetention("7d")).rejects.toThrow("not implemented");
  });
});
