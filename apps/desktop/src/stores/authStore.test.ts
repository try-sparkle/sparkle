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
import { useUiStore } from "./uiStore";

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
    creditFloorCents: 0,
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

describe("authStore.refresh — clears the inferred credit floor", () => {
  // The floor is coarse on purpose: the 402 reports the BALANCE, not the hold that was
  // unaffordable, so one expensive call refused at a healthy balance gates every AI surface off —
  // including the cheap ones that balance covers — and no cheaper call is allowed out to prove it
  // wrong. An authoritative /me supersedes the inference, which bounds that to one refresh cycle.
  it("an affirmative /me drops the floor, reopening the gate for a healthy balance", async () => {
    useAuthStore.setState({ me: me({ balanceCents: 300 }), tokenPresent: true });
    useAuthStore.getState().noteCreditsRefused(300); // one pricey call refused at $3.00
    expect(useAuthStore.getState().creditFloorCents).toBe(300);

    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(me({ balanceCents: 300 }));
    await useAuthStore.getState().refresh();
    expect(useAuthStore.getState().creditFloorCents).toBe(0);
  });

  it("a signed-out refresh drops it too, so it can't follow the token out", async () => {
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useAuthStore.getState().noteCreditsRefused(2);
    mockHasToken.mockResolvedValue(false);
    await useAuthStore.getState().refresh();
    expect(useAuthStore.getState().creditFloorCents).toBe(0);
  });

  it("a FAILED /me keeps the floor — no authoritative balance arrived to supersede it", async () => {
    useAuthStore.setState({ me: me({ entitled: true }), cachedAt: Date.now(), tokenPresent: true });
    useAuthStore.getState().noteCreditsRefused(1);
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(null); // network failure / backend down
    await useAuthStore.getState().refresh();
    expect(useAuthStore.getState().creditFloorCents).toBe(1);
  });
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

  it("clears the credit floor so one account's exhausted balance can't gate the next signer-in", () => {
    useAuthStore.setState({ me: me(), tokenPresent: true });
    useAuthStore.getState().noteCreditsRefused(2);
    expect(useAuthStore.getState().creditFloorCents).toBe(2);
    useAuthStore.getState().reset();
    expect(useAuthStore.getState().creditFloorCents).toBe(0);
  });
});

describe("authStore.noteCreditsRefused — the server's 402 is authoritative", () => {
  it("records the refused level and adopts the balance the server reported", () => {
    useAuthStore.setState({ me: me({ balanceCents: 500 }), tokenPresent: true });
    useAuthStore.getState().noteCreditsRefused(3);
    const s = useAuthStore.getState();
    expect(s.creditFloorCents).toBe(3);
    expect(s.me?.balanceCents).toBe(3);
  });

  it("never conjures a `me` for a signed-out user", () => {
    useAuthStore.setState({ me: null, tokenPresent: false });
    useAuthStore.getState().noteCreditsRefused(7);
    expect(useAuthStore.getState().me).toBeNull();
    expect(useAuthStore.getState().creditFloorCents).toBe(7);
  });

  // Pins the store's CONTRACT, not a live path — no caller passes null today. Rationale and
  // dormancy live on the `noteCreditsRefused` doc in authStore.ts (sparkle-q5re).
  it("a refusal with no reported amount falls back to the held balance and leaves `me` alone", () => {
    useAuthStore.setState({ me: me({ balanceCents: 400 }), tokenPresent: true });
    useAuthStore.getState().noteCreditsRefused(null);
    const s = useAuthStore.getState();
    expect(s.creditFloorCents).toBe(400);
    expect(s.me?.balanceCents).toBe(400); // NOT zeroed
  });

  it("a refusal with no amount and no `me` leaves the floor at 0", () => {
    useAuthStore.setState({ me: null, tokenPresent: false });
    useAuthStore.getState().noteCreditsRefused(null);
    expect(useAuthStore.getState().creditFloorCents).toBe(0);
  });

  it("is not persisted — it describes the live balance, not a cached identity", () => {
    useAuthStore.setState({ me: me({ entitled: true }), cachedAt: Date.now(), tokenPresent: true });
    useAuthStore.getState().noteCreditsRefused(5);
    const raw = localStorage.getItem("sparkle-auth") ?? "";
    expect(raw).not.toContain("creditFloorCents");
  });
});

describe("authStore — the $0-banner re-arm seam", () => {
  // The rule itself is unit-tested in services/zeroCreditBanner.test.ts; these pin that the STORE
  // actually consults it on every path that writes `me`, which is the part a refactor drops.
  beforeEach(() => {
    useUiStore.setState({ zeroCreditBannerDismissed: true, zeroCreditBannerDismissedFor: "u1" });
  });
  // The ui store is a singleton: without this, a latched dismissal leaks into the describes below.
  afterEach(() => {
    useUiStore.setState({ zeroCreditBannerDismissed: false, zeroCreditBannerDismissedFor: null });
  });

  it("keeps the dismissal when the same user is still at $0 — otherwise it nags on every poll", async () => {
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(me({ balanceCents: 0 }));
    await useAuthStore.getState().refresh();
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(true);
  });

  it("clears it when credits arrive, so the NEXT zero warns again", async () => {
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(me({ balanceCents: 500 }));
    await useAuthStore.getState().refresh();
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
  });

  it("keeps it across a grace-window drop to null — that is a network blip, not a new user", async () => {
    useAuthStore.setState({ me: me({ balanceCents: 0 }), cachedAt: null });
    mockHasToken.mockResolvedValue(true);
    mockFetchMe.mockResolvedValue(null);
    await useAuthStore.getState().refresh();
    expect(useAuthStore.getState().me).toBeNull(); // positive control: the drop really happened
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(true);
  });

  it("clears it on noteCreditsRefused when the refusal reports a POSITIVE balance", () => {
    // A 402 can report a positive balance — the HOLD was unaffordable, the balance wasn't zero. That
    // raises `me.balanceCents` above zero, so a latched dismissal has to clear; leaving it would mean
    // the banner never fires when the balance genuinely reaches zero later. (roborev 53144)
    useAuthStore.setState({ me: me({ balanceCents: 0 }) });
    useAuthStore.getState().noteCreditsRefused(3);
    expect(useAuthStore.getState().me?.balanceCents).toBe(3); // positive control: `me` really moved
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
  });

  it("keeps it when the refusal leaves the balance at zero", () => {
    useAuthStore.setState({ me: me({ balanceCents: 0 }) });
    useAuthStore.getState().noteCreditsRefused(0);
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(true);
  });

  it("clears it on setMe — the seam the dictation balance frame writes through", () => {
    // A raw setState here would skip the rule and swallow the next $0 episode for the session.
    useAuthStore.getState().setMe(me({ balanceCents: 300 }));
    expect(useUiStore.getState().zeroCreditBannerDismissed).toBe(false);
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
