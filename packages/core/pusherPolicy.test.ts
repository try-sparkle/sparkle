// THE PROPERTY: the config file can make a Pusher quieter, and cannot make one louder.
//
// This is the test that keeps the founder's on-by-default decision defensible. That decision rests
// on the message budget bounding the worst case; a budget a TOML edit could raise to 999 would be a
// bound in name only, and nothing would report that the safety argument had stopped holding.
import { describe, it, expect } from "vitest";
import {
  resolvePusherPolicy,
  PUSHERS_DISABLED,
  OBSERVE_INTERVAL_MS,
  MIN_OBSERVE_INTERVAL_MS,
} from "./pusherPolicy";
import { MESSAGES_PER_HOUR, INBOX_YIELD_PCT } from "./pusherGate";

describe("the shipped default", () => {
  // Founder decision 3, overriding the recommended fail-safe.
  it("is ENABLED when the section is present and says nothing", () => {
    expect(resolvePusherPolicy({})).toEqual({
      enabled: true,
      observeIntervalMs: OBSERVE_INTERVAL_MS,
      messagesPerHour: MESSAGES_PER_HOUR,
      inboxYieldPct: INBOX_YIELD_PCT,
    });
  });
});

describe("an absent or unreadable section", () => {
  // The OPPOSITE of the shipped default, deliberately: a missing section means a backend that
  // predates the feature, and such a backend cannot be running a Pusher. Defaulting it to enabled
  // would show the feature switched on underneath an older build.
  it.each([[undefined], [null], ["nonsense"], [42]])("resolves %s to DISABLED", (payload) => {
    expect(resolvePusherPolicy(payload as never)).toEqual(PUSHERS_DISABLED);
    expect(PUSHERS_DISABLED.enabled).toBe(false);
  });
});

describe("the kill switch", () => {
  it("disables on an explicit false", () => {
    expect(resolvePusherPolicy({ enabled: false }).enabled).toBe(false);
  });

  // `enabled` is the ONLY control over a feature that is on by default and attached at birth, so a
  // typo must not leave it running. TOML's own boolean is `false`, but a hand-edited file plausibly
  // carries any of these — every one an unmistakable intent to disable.
  it.each([[false], [0], ["false"], ["off"], ["no"], ["0"], ["  FALSE  "]])(
    "reads %p as off",
    (v) => {
      expect(resolvePusherPolicy({ enabled: v }).enabled).toBe(false);
    },
  );

  // The default may not be flipped: an absent or merely unrecognized value stays ENABLED.
  it.each([[undefined], ["yes"], ["maybe"], [1]])("keeps %p enabled", (v) => {
    expect(resolvePusherPolicy({ enabled: v }).enabled).toBe(true);
  });
});

describe("the message budget is a CEILING ONLY", () => {
  it("refuses to be raised above the code's own limit", () => {
    expect(resolvePusherPolicy({ messages_per_hour: 999 }).messagesPerHour).toBe(MESSAGES_PER_HOUR);
  });

  it("can be lowered", () => {
    expect(resolvePusherPolicy({ messages_per_hour: 1 }).messagesPerHour).toBe(1);
  });

  // A NON-NUMBER is absent, so the shipped default applies — there is no quiet reading of "lots".
  // 0 and negatives are NOT in this case: they are legal requests for silence and are covered in
  // "the warnings the Rust config shows must be TRUE" below. This test asserted they fell back to
  // the full rate, which was the bug (roborev 56226), not the contract.
  it("ignores an unreadable value rather than treating it as unlimited", () => {
    expect(resolvePusherPolicy({ messages_per_hour: "lots" }).messagesPerHour).toBe(MESSAGES_PER_HOUR);
    expect(resolvePusherPolicy({ messages_per_hour: null }).messagesPerHour).toBe(MESSAGES_PER_HOUR);
  });
});

describe("the inbox yield is a CEILING ONLY", () => {
  // Raising it would let a Pusher spend the last slots of a partner's inbox — the ones reserved so
  // the concierge can still reach that builder. The inbox refuses an `act` when full rather than
  // evicting anything (only the lower-ceilinged `fyi` class is a ring buffer, and an `fyi` may never
  // evict an `act`), and a Pusher message is `act`.
  it("refuses to be raised", () => {
    expect(resolvePusherPolicy({ inbox_yield_pct: 100 }).inboxYieldPct).toBe(INBOX_YIELD_PCT);
  });

  it("can be lowered to yield earlier", () => {
    expect(resolvePusherPolicy({ inbox_yield_pct: 50 }).inboxYieldPct).toBe(50);
  });

  // 0 is the QUIETEST setting the field can express ("always yield"). Routing it through a
  // positive-integer check rejected it and fell back to 80 — the loudest value permitted — so a
  // config edit meant to mute the Pusher amplified it instead.
  it("accepts 0, the quietest setting, rather than falling back to the loudest", () => {
    expect(resolvePusherPolicy({ inbox_yield_pct: 0 }).inboxYieldPct).toBe(0);
  });

  it("clamps a negative percentage toward silence, not toward the default", () => {
    expect(resolvePusherPolicy({ inbox_yield_pct: -5 }).inboxYieldPct).toBe(0);
  });
});

describe("the observation interval has a FLOOR", () => {
  // Not about spend — with no model call an observation costs no tokens. A few-second interval
  // would turn a background read into a busy loop across the whole fleet for no gain.
  it("refuses an interval below the floor", () => {
    expect(resolvePusherPolicy({ observe_interval_ms: 1000 }).observeIntervalMs).toBe(
      MIN_OBSERVE_INTERVAL_MS,
    );
  });

  it("accepts a longer interval, which only costs less", () => {
    expect(resolvePusherPolicy({ observe_interval_ms: 30 * 60_000 }).observeIntervalMs).toBe(
      30 * 60_000,
    );
  });
});


describe("the warnings the Rust config shows must be TRUE", () => {
  // User-facing copy is code. Rust's `validate` tells the user what each nonsense value will do;
  // if the resolver does something else, the app is lying on its own initiative (roborev 56226).

  // "…so a Pusher can never send anything" — it previously sent at the full shipped rate.
  it("messages_per_hour = 0 really does mean never", () => {
    expect(resolvePusherPolicy({ messages_per_hour: 0 }).messagesPerHour).toBe(0);
  });

  it("a negative message budget clamps to silence, not to the default", () => {
    expect(resolvePusherPolicy({ messages_per_hour: -3 }).messagesPerHour).toBe(0);
  });

  // "…so Sparkle will use 60000" — 0 previously resolved to the 300000 default instead.
  it("observe_interval_ms = 0 really does use the one-minute floor", () => {
    expect(resolvePusherPolicy({ observe_interval_ms: 0 }).observeIntervalMs).toBe(
      MIN_OBSERVE_INTERVAL_MS,
    );
  });

  it("a negative interval also lands on the floor", () => {
    expect(resolvePusherPolicy({ observe_interval_ms: -1 }).observeIntervalMs).toBe(
      MIN_OBSERVE_INTERVAL_MS,
    );
  });
});
