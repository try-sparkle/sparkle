// The three-way rule behind the concierge's AI-enhancements locked state. The whole reason this is
// a pure function with its own test is that the THREE reasons must never collapse into one: each
// one's remedy is different, and offering the wrong remedy (a "buy the app" upsell to someone who
// already bought it) is worse than offering none.
import { describe, expect, it } from "vitest";

import { conciergeAiFlagOn, conciergeAiLockReason } from "./conciergeAiLock";

describe("conciergeAiLockReason", () => {
  it("is null — no lock — only when the flag, the entitlement, and credits are all present", () => {
    expect(conciergeAiLockReason({ flag: true, entitled: true, credits: true })).toBeNull();
  });

  it("reads a flag that is simply OFF as flag_off, whatever the user has bought", () => {
    // Settings, not a purchase: this user may own everything and have a full balance.
    expect(conciergeAiLockReason({ flag: false, entitled: true, credits: true })).toBe("flag_off");
    expect(conciergeAiLockReason({ flag: false, entitled: false, credits: false })).toBe("flag_off");
  });

  it("reads flag-on + not bought as not_entitled (the $99 buy-the-app upsell)", () => {
    expect(conciergeAiLockReason({ flag: true, entitled: false, credits: false })).toBe(
      "not_entitled",
    );
  });

  it("never says not_entitled for a user who HAS bought the app but ran out of credits", () => {
    // The distinction aiGate's header calls out: `locked` is entitlement-based precisely so an
    // entitled, zero-balance user is routed to the top-up flow, never to the paywall.
    expect(conciergeAiLockReason({ flag: true, entitled: true, credits: false })).toBe("no_credits");
  });

  it("still says not_entitled when an unbought user somehow reads as having credits", () => {
    // Ordering matters: entitlement is checked before credits, so a stale/odd balance on an
    // unbought account cannot route them to a top-up they can't use.
    expect(conciergeAiLockReason({ flag: true, entitled: false, credits: true })).toBe(
      "not_entitled",
    );
  });
});

describe("conciergeAiFlagOn", () => {
  it("is off only when the settings field is explicitly false", () => {
    expect(conciergeAiFlagOn({ aiConcierge: false })).toBe(false);
    expect(conciergeAiFlagOn({ aiConcierge: true })).toBe(true);
  });

  it("reads a MISSING field as ON, so a store that predates the flag can't dark the concierge", () => {
    // The field arrives with the concierge policy layer (settings `aiConcierge`, config
    // `[ai].concierge`). Until it exists the concierge is not flag-gated at all, so absent must
    // mean on — defaulting to off would silently lock the column for everyone.
    expect(conciergeAiFlagOn({})).toBe(true);
    expect(conciergeAiFlagOn({ aiConcierge: undefined })).toBe(true);
  });
});
