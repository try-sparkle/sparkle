// @vitest-environment jsdom
//
// authStore's entitlement caching: cold-launch optimism + the "network failure keeps last-known,
// affirmative-unentitled downgrades" security property (task: stop locking paying customers out
// when offline). Rust/keychain is mocked away — only the store's decision logic is under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../services/entitlement";
import { ENTITLEMENT_GRACE_MS } from "../services/entitlement";

vi.mock("../services/sparkleApi", () => ({
  hasToken: vi.fn(),
  fetchMe: vi.fn(),
}));

import { hasToken, fetchMe } from "../services/sparkleApi";
import { useAuthStore } from "./authStore";

const mockHasToken = vi.mocked(hasToken);
const mockFetchMe = vi.mocked(fetchMe);

const me = (over: Partial<Me> = {}): Me => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents: 20000,
  tokenVersion: 1,
  ...over,
});

// Reset the singleton store + persisted localStorage between tests so state can't leak across them.
function resetStore() {
  localStorage.clear();
  useAuthStore.setState({
    me: null,
    tokenPresent: false,
    loading: true,
    cachedAt: null,
    paywallDismissed: false,
  });
}

beforeEach(() => {
  mockHasToken.mockReset();
  mockFetchMe.mockReset();
  resetStore();
});
afterEach(() => {
  resetStore();
});

describe("authStore.refresh — affirmative server responses", () => {
  it("entitled /me stamps the cache (cachedAt set) and renders entitled", async () => {
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(me({ entitled: true }));
    const before = Date.now();
    await useAuthStore.getState().refresh();
    const s = useAuthStore.getState();
    expect(s.me?.entitled).toBe(true);
    expect(s.tokenPresent).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.cachedAt).toBeGreaterThanOrEqual(before);
  });

  it("persists the entitled identity to localStorage so the NEXT launch can render optimistically", async () => {
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(me({ entitled: true, clerkUserId: "paid-user" }));
    await useAuthStore.getState().refresh();
    const raw = localStorage.getItem("sparkle-auth");
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!);
    expect(persisted.state.me.clerkUserId).toBe("paid-user");
    expect(typeof persisted.state.cachedAt).toBe("number");
  });

  it("affirmative UNENTITLED /me downgrades immediately and drops the cache stamp (security)", async () => {
    // Seed a previously-entitled cache, then the server affirmatively says this user is no longer
    // entitled → must downgrade to the paywall, NOT be masked by the grace window.
    useAuthStore.setState({ me: me({ entitled: true }), cachedAt: Date.now(), tokenPresent: true });
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(me({ entitled: false }));
    await useAuthStore.getState().refresh();
    const s = useAuthStore.getState();
    expect(s.me?.entitled).toBe(false);
    expect(s.cachedAt).toBeNull();
    // A non-entitled me is never persisted as last-known-good.
    const persisted = JSON.parse(localStorage.getItem("sparkle-auth")!);
    expect(persisted.state.me).toBeNull();
  });
});

describe("authStore.refresh — network failure keeps last-known (does NOT downgrade)", () => {
  it("null /me within the grace window preserves the cached entitlement", async () => {
    const cachedAt = Date.now() - 1000;
    useAuthStore.setState({ me: me({ entitled: true }), cachedAt, tokenPresent: true, loading: false });
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(null); // backend down / offline / ambiguous 401
    await useAuthStore.getState().refresh();
    const s = useAuthStore.getState();
    expect(s.me?.entitled).toBe(true); // NOT bounced to the paywall
    expect(s.cachedAt).toBe(cachedAt); // stamp untouched
    expect(s.loading).toBe(false);
  });

  it("null /me AFTER the grace window has lapsed re-gates (rotated/revoked token)", async () => {
    useAuthStore.setState({
      me: me({ entitled: true }),
      cachedAt: Date.now() - (ENTITLEMENT_GRACE_MS + 1000),
      tokenPresent: true,
    });
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(null);
    await useAuthStore.getState().refresh();
    const s = useAuthStore.getState();
    expect(s.me).toBeNull();
    expect(s.cachedAt).toBeNull();
  });

  it("no token clears the optimistic cache (a genuine sign-out / never-signed-in)", async () => {
    useAuthStore.setState({ me: me({ entitled: true }), cachedAt: Date.now(), tokenPresent: true });
    mockHasToken.mockResolvedValue(false);
    await useAuthStore.getState().refresh();
    const s = useAuthStore.getState();
    expect(s.me).toBeNull();
    expect(s.cachedAt).toBeNull();
    expect(mockFetchMe).not.toHaveBeenCalled(); // short-circuits before hitting /me
  });
});

describe("authStore.reset — explicit sign-out clears the cache", () => {
  it("wipes me + cachedAt so no optimistic entitlement survives", () => {
    useAuthStore.setState({ me: me({ entitled: true }), cachedAt: Date.now(), tokenPresent: true });
    useAuthStore.getState().reset();
    const s = useAuthStore.getState();
    expect(s.me).toBeNull();
    expect(s.cachedAt).toBeNull();
    expect(s.tokenPresent).toBe(false);
  });
});

describe("authStore hydration — optimistic cold launch", () => {
  // Seed localStorage with a persisted envelope, then rehydrate the live store (mirrors what
  // happens synchronously at module load on a real cold launch).
  function seedPersisted(state: { me: Me | null; cachedAt: number | null }) {
    localStorage.setItem("sparkle-auth", JSON.stringify({ state, version: 0 }));
    return useAuthStore.persist.rehydrate();
  }

  it("a fresh entitled cache renders optimistically: loading=false, entitled, token assumed present", async () => {
    await seedPersisted({ me: me({ entitled: true }), cachedAt: Date.now() - 5000 });
    const s = useAuthStore.getState();
    expect(s.loading).toBe(false); // no bare "Loading…" screen
    expect(s.me?.entitled).toBe(true);
    expect(s.tokenPresent).toBe(true);
  });

  it("an EXPIRED entitled cache is dropped on hydrate (no stale workspace flash beyond grace)", async () => {
    await seedPersisted({
      me: me({ entitled: true }),
      cachedAt: Date.now() - (ENTITLEMENT_GRACE_MS + 1000),
    });
    const s = useAuthStore.getState();
    expect(s.me).toBeNull();
    expect(s.cachedAt).toBeNull();
    expect(s.loading).toBe(true); // falls back to the normal (non-optimistic) load path
  });
});
