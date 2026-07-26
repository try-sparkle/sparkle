import { describe, it, expect, afterEach } from "vitest";
import { useSparklePrefsStore, SPARKLE_PREFS_PERSIST_KEY } from "./sparklePrefsStore";

// The store is a module-level singleton; reset state + storage after each test so nothing leaks
// into later blocks (same pattern as uiStore.test.ts).
afterEach(() => {
  localStorage.clear();
  useSparklePrefsStore.setState({ rules: {}, now: Date.now });
});

const store = () => useSparklePrefsStore.getState();

describe("sparklePrefsStore — shouldInterrupt defaults", () => {
  it("unknown topic defaults to allow (true)", () => {
    expect(store().shouldInterrupt("never-heard-of-it")).toBe(true);
  });

  it("an explicit allow rule also reads as true", () => {
    store().setInterruptPreference("review-waiting", "allow");
    expect(store().shouldInterrupt("review-waiting")).toBe(true);
  });
});

describe("sparklePrefsStore — mute rules", () => {
  it("a mute makes shouldInterrupt return false", () => {
    store().setInterruptPreference("review-waiting", "mute");
    expect(store().shouldInterrupt("review-waiting")).toBe(false);
    // Other topics stay on the allow default.
    expect(store().shouldInterrupt("ci-flakes")).toBe(true);
  });

  it("clearPreference restores the allow default", () => {
    store().setInterruptPreference("agent-abc", "mute");
    expect(store().shouldInterrupt("agent-abc")).toBe(false);
    store().clearPreference("agent-abc");
    expect(store().shouldInterrupt("agent-abc")).toBe(true);
  });

  it("clearPreference on an unknown topic is a no-op", () => {
    expect(() => store().clearPreference("nope")).not.toThrow();
  });

  it("latest decision wins — allow overwrites an earlier mute", () => {
    store().setInterruptPreference("topic", "mute");
    store().setInterruptPreference("topic", "allow");
    expect(store().shouldInterrupt("topic")).toBe(true);
  });
});

describe("sparklePrefsStore — expiry via the injected clock", () => {
  it("a ttlMs mute stays muted before expiry and reverts to allow after", () => {
    let clock = 1_000_000;
    store().setClock(() => clock);

    store().setInterruptPreference("review-waiting", "mute", { ttlMs: 60_000 });
    expect(store().shouldInterrupt("review-waiting")).toBe(false);

    clock += 59_999; // one ms shy of expiry — still muted
    expect(store().shouldInterrupt("review-waiting")).toBe(false);

    clock += 1; // exactly at expiry — reverts to allow
    expect(store().shouldInterrupt("review-waiting")).toBe(true);
  });

  it("an absolute expiresAt behaves the same and wins over ttlMs", () => {
    let clock = 5_000;
    store().setClock(() => clock);

    store().setInterruptPreference("topic", "mute", { ttlMs: 999_999, expiresAt: 6_000 });
    expect(store().shouldInterrupt("topic")).toBe(false);
    clock = 6_000;
    expect(store().shouldInterrupt("topic")).toBe(true);
  });

  it("a mute with no expiry never expires", () => {
    let clock = 0;
    store().setClock(() => clock);
    store().setInterruptPreference("topic", "mute");
    clock = Number.MAX_SAFE_INTEGER;
    expect(store().shouldInterrupt("topic")).toBe(false);
  });

  it("an explicit expiresAt: null wins over ttlMs — the rule never expires", () => {
    let clock = 1_000;
    store().setClock(() => clock);
    // expiresAt is passed and null, so it beats the ttlMs and yields a non-expiring rule.
    store().setInterruptPreference("topic", "mute", { ttlMs: 1_000, expiresAt: null });
    clock = Number.MAX_SAFE_INTEGER;
    expect(store().shouldInterrupt("topic")).toBe(false);
    expect(store().listPreferences()[0]!.expiresAt).toBeNull();
  });

  it("updatedAt is stamped from the injected clock", () => {
    store().setClock(() => 4_242);
    store().setInterruptPreference("topic", "mute");
    expect(store().listPreferences()[0]!.updatedAt).toBe(4_242);
  });

  it("listPreferences drops expired rules and sorts newest first", () => {
    let clock = 1_000;
    store().setClock(() => clock);

    store().setInterruptPreference("expires-soon", "mute", { ttlMs: 500 });
    clock = 1_100;
    store().setInterruptPreference("older", "mute");
    clock = 1_200;
    store().setInterruptPreference("newer", "mute");

    clock = 2_000; // "expires-soon" (expiry 1_500) is now expired
    expect(store().listPreferences().map((r) => r.topic)).toEqual(["newer", "older"]);
  });
});

describe("sparklePrefsStore — persistence", () => {
  it("writes forever-scoped rules to the persisted blob, keyed by topic", () => {
    store().setInterruptPreference("review-waiting", "mute");
    const raw = localStorage.getItem(SPARKLE_PREFS_PERSIST_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state.rules["review-waiting"].decision).toBe("mute");
  });

  it("never writes session-scoped rules to the blob (they die with the process)", () => {
    store().setInterruptPreference("session-only", "mute", { scope: "session" });
    store().setInterruptPreference("durable", "mute");
    const blob = JSON.parse(localStorage.getItem(SPARKLE_PREFS_PERSIST_KEY)!);
    expect(blob.state.rules).not.toHaveProperty("session-only");
    // Sanity: a genuinely-persisted rule from the same write did land in the blob.
    expect(blob.state.rules.durable.decision).toBe("mute");
    // In memory (this session) the session mute still applies.
    expect(store().shouldInterrupt("session-only")).toBe(false);
  });

  it("round-trips: rehydrating the persisted blob restores the same decisions", async () => {
    // Seed localStorage with a persisted envelope, then rehydrate the live store (mirrors what
    // a relaunch does — same idiom as authStore.test.ts).
    localStorage.setItem(
      SPARKLE_PREFS_PERSIST_KEY,
      JSON.stringify({
        state: {
          rules: {
            "review-waiting": {
              topic: "review-waiting",
              decision: "mute",
              scope: "forever",
              expiresAt: null,
              updatedAt: 123,
            },
          },
        },
        version: 0,
      }),
    );
    await useSparklePrefsStore.persist.rehydrate();

    expect(store().shouldInterrupt("review-waiting")).toBe(false);
    expect(store().shouldInterrupt("anything-else")).toBe(true);
    // The runtime clock survives rehydration (it's not in the blob, so merge keeps the default).
    expect(typeof store().now).toBe("function");
  });

  it("prunes expired forever-rules from the persisted blob so localStorage stays bounded", () => {
    let clock = 1_000;
    store().setClock(() => clock);
    store().setInterruptPreference("time-boxed", "mute", { ttlMs: 500 }); // expires at 1_500
    store().setInterruptPreference("durable", "mute"); // never expires

    // Before expiry both persist.
    let blob = JSON.parse(localStorage.getItem(SPARKLE_PREFS_PERSIST_KEY)!);
    expect(blob.state.rules).toHaveProperty("time-boxed");

    // After the ttl passes, the next write drops the expired rule from the blob.
    clock = 2_000;
    store().setInterruptPreference("another", "mute");
    blob = JSON.parse(localStorage.getItem(SPARKLE_PREFS_PERSIST_KEY)!);
    expect(blob.state.rules).not.toHaveProperty("time-boxed");
    expect(blob.state.rules).toHaveProperty("durable");
    expect(blob.state.rules).toHaveProperty("another");
  });

  it("an expired mute in the persisted blob rehydrates as allow (no cleanup pass needed)", async () => {
    localStorage.setItem(
      SPARKLE_PREFS_PERSIST_KEY,
      JSON.stringify({
        state: {
          rules: {
            stale: {
              topic: "stale",
              decision: "mute",
              scope: "forever",
              expiresAt: 1_000,
              updatedAt: 500,
            },
          },
        },
        version: 0,
      }),
    );
    await useSparklePrefsStore.persist.rehydrate();
    store().setClock(() => 2_000);
    expect(store().shouldInterrupt("stale")).toBe(true);
  });
});
