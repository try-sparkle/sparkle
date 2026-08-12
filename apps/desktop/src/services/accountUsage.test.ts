import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri boundary the same way the rest of the desktop suite does.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (c: string, a: unknown) => invokeMock(c, a),
}));

import { getAccountUsageLive, type AccountUsageLive } from "./accountUsage";

describe("getAccountUsageLive", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes account_usage_live with the configDir arg and returns the typed result", async () => {
    // The NEUTRAL confirmed shape (camelCase, as the Rust command serializes it). Nullable windows
    // arrive as `null`, never absent — the contract this wrapper is typed against.
    const result: AccountUsageLive = {
      fiveHourPercent: 42.0,
      fiveHourResetsAt: "2026-08-12T04:09:59.793055+00:00",
      sevenDayPercent: 15.0,
      sevenDayResetsAt: "2026-08-17T10:59:59.793078+00:00",
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 42,
          severity: "warning",
          resetsAt: "2026-08-12T04:09:59.793055+00:00",
          isActive: true,
        },
      ],
    };
    invokeMock.mockResolvedValueOnce(result);

    const out = await getAccountUsageLive("/some/config/dir");

    // The Rust command name and the camelCase arg key the Tauri bridge maps to `config_dir`.
    expect(invokeMock).toHaveBeenCalledWith("account_usage_live", {
      configDir: "/some/config/dir",
    });
    expect(out.fiveHourPercent).toBe(42.0);
    expect(out.sevenDayPercent).toBe(15.0);
    expect(out.limits[0]?.isActive).toBe(true);
  });

  it("propagates a rejection so the caller can fall back to the local estimate", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no access token in stored credentials"));
    await expect(getAccountUsageLive("/some/config/dir")).rejects.toThrow(
      "no access token",
    );
  });
});
