// @vitest-environment jsdom
// Tests for the OS keychain store of the user-entered Chief PAT (bead ), cut to
// keychain-forward only: write-on-save, keychain-first read, and a read-only legacy fallback. There
// is no migration/scrub/pending key, so there is no crash window or unusable-keychain loop.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import {
  getStoredChiefPat,
  storeChiefPat,
  clearStoredChiefPat,
  seedKeychainChiefPat,
  saveChiefPat,
  disconnectChiefPat,
} from "./chief";
import { useSettingsStore, effectiveChiefPat } from "../stores/settingsStore";

function keychainPat(): string {
  return useSettingsStore.getState().keychainChiefPat;
}

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
  useSettingsStore.setState({ chiefPat: "", keychainChiefPat: "" });
});

describe("chief PAT OS keychain store", () => {
  it("storeChiefPat and clearStoredChiefPat return true on success and false when the call throws", async () => {
    invoke.mockResolvedValue(undefined);
    expect(await storeChiefPat("pat_ok")).toBe(true);
    expect(await clearStoredChiefPat()).toBe(true);
    invoke.mockRejectedValue(new Error("keychain locked"));
    expect(await storeChiefPat("pat_x")).toBe(false);
    expect(await clearStoredChiefPat()).toBe(false);
  });

  it("getStoredChiefPat trims the keychain value and returns empty on error", async () => {
    invoke.mockResolvedValueOnce("  pat_secure  ");
    expect(await getStoredChiefPat()).toBe("pat_secure");
    invoke.mockRejectedValueOnce(new Error("locked"));
    expect(await getStoredChiefPat()).toBe("");
  });

  it("seedKeychainChiefPat reads keychain-first into the in-memory value", async () => {
    invoke.mockResolvedValueOnce("pat_secure");
    await seedKeychainChiefPat();
    expect(keychainPat()).toBe("pat_secure");
  });

  it("seedKeychainChiefPat sets an empty value when the keychain is empty (no stale value)", async () => {
    useSettingsStore.setState({ keychainChiefPat: "pat_stale" });
    invoke.mockResolvedValueOnce("");
    await seedKeychainChiefPat();
    expect(keychainPat()).toBe("");
  });

  it("saveChiefPat writes the keychain and reflects it in memory ONLY on a confirmed write", async () => {
    invoke.mockRejectedValueOnce(new Error("keychain locked"));
    expect(await saveChiefPat("pat_new")).toBe(false);
    expect(keychainPat()).toBe("");
    invoke.mockResolvedValueOnce(undefined);
    expect(await saveChiefPat("  pat_new  ")).toBe(true);
    expect(invoke).toHaveBeenCalledWith("chief_pat_secure_set", { pat: "  pat_new  " });
    expect(keychainPat()).toBe("pat_new");
  });

  it("disconnectChiefPat clears the in-memory value ONLY on a confirmed keychain delete", async () => {
    useSettingsStore.setState({ keychainChiefPat: "pat_x" });
    invoke.mockRejectedValueOnce(new Error("keychain locked"));
    expect(await disconnectChiefPat()).toBe(false);
    expect(keychainPat()).toBe("pat_x");
    invoke.mockResolvedValueOnce(undefined);
    expect(await disconnectChiefPat()).toBe(true);
    expect(keychainPat()).toBe("");
  });

  it("never touches or scrubs a legacy localStorage chiefPat (read-only fallback)", async () => {
    useSettingsStore.setState({ chiefPat: "pat_legacy" });
    invoke.mockResolvedValueOnce("");
    await seedKeychainChiefPat();
    expect(useSettingsStore.getState().chiefPat).toBe("pat_legacy");
  });

  it("saveChiefPat clears the superseded legacy chiefPat so the new PAT wins immediately", async () => {
    useSettingsStore.setState({ chiefPat: "pat_legacy" });
    invoke.mockResolvedValueOnce(undefined);
    expect(await saveChiefPat("pat_new")).toBe(true);
    const st = useSettingsStore.getState();
    expect(st.keychainChiefPat).toBe("pat_new");
    expect(st.chiefPat).toBe("");
    expect(effectiveChiefPat(st.keychainChiefPat, st.chiefPat)).toBe("pat_new");
  });

  it("disconnectChiefPat clears the legacy chiefPat so effectiveChiefPat is empty afterwards", async () => {
    useSettingsStore.setState({ chiefPat: "pat_legacy", keychainChiefPat: "pat_x" });
    invoke.mockResolvedValueOnce(undefined);
    expect(await disconnectChiefPat()).toBe(true);
    const st = useSettingsStore.getState();
    expect(st.keychainChiefPat).toBe("");
    expect(st.chiefPat).toBe("");
    expect(effectiveChiefPat(st.keychainChiefPat, st.chiefPat)).toBe("");
  });

  it("a FAILED disconnect leaves both the keychain and legacy values intact", async () => {
    useSettingsStore.setState({ chiefPat: "pat_legacy", keychainChiefPat: "pat_x" });
    invoke.mockRejectedValueOnce(new Error("keychain locked"));
    expect(await disconnectChiefPat()).toBe(false);
    const st = useSettingsStore.getState();
    expect(st.keychainChiefPat).toBe("pat_x");
    expect(st.chiefPat).toBe("pat_legacy");
  });

  it("a FAILED saveChiefPat preserves the legacy chiefPat", async () => {
    useSettingsStore.setState({ chiefPat: "pat_legacy" });
    invoke.mockRejectedValueOnce(new Error("keychain locked"));
    expect(await saveChiefPat("pat_new")).toBe(false);
    expect(useSettingsStore.getState().chiefPat).toBe("pat_legacy");
  });

  it("removes the disconnected chiefPat from the PERSISTED blob (persist round-trip)", async () => {
    useSettingsStore.setState({ chiefPat: "pat_legacy", keychainChiefPat: "pat_x" });
    invoke.mockResolvedValueOnce(undefined);
    await disconnectChiefPat();
    const blob = JSON.parse(localStorage.getItem("sparkle-settings") as string) as {
      state?: Record<string, unknown>;
    };
    expect(blob.state?.chiefPat).toBe("");
  });

  it("seedKeychainChiefPat retires the abandoned migration pending key", async () => {
    localStorage.setItem("sparkle-chief-pat-pending", "pat_leftover");
    invoke.mockResolvedValueOnce("");
    await seedKeychainChiefPat();
    expect(localStorage.getItem("sparkle-chief-pat-pending")).toBeNull();
  });

  it("persists chiefPat to localStorage so it remains the read-only fallback (regression guard)", () => {
    // The keychain-forward design depends on chiefPat actually surviving a persist round-trip; a
    // regression re-dropping it from partialize would silently sign out existing users. Assert the
    // persisted blob carries it (the inverse of the pre-cut scrub test).
    useSettingsStore.getState().setChiefPat("pat_x");
    const raw = localStorage.getItem("sparkle-settings");
    expect(raw).not.toBeNull();
    const blob = JSON.parse(raw as string) as { state?: Record<string, unknown> };
    expect(blob.state?.chiefPat).toBe("pat_x");
  });
});
