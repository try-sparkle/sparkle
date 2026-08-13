// `builderIndexReportFailing` — the rule the Tools row's "Not publishing" badge is derived from.
//
// Tested DIRECTLY as well as through the pane, and the direct half is not redundant: ToolsPane
// wraps the call in a `.catch` that turns any throw into "no badge", so a missing null-guard here
// is invisible from that side — the row renders the same nothing either way. A mutation check
// against the component test confirmed it (the `!status.lastStatus` line could be deleted with the
// pane's suite still green); against this file it goes red.
import { describe, expect, it } from "vitest";

import {
  BUILDER_INDEX_STALE_AFTER_SECS,
  builderIndexReportFailing,
  type BuilderIndexStatus,
} from "./builderIndex";

/** Epoch SECONDS, matching `lastReportAt`'s unit — not milliseconds. */
const NOW = 1_800_000_000;
const HOUR = 60 * 60;

/** A healthy, live reporter, with per-test overrides on top.
 *
 *  `blockedBy: null` rather than an absent key: it backs a Rust `Option<String>` carrying no
 *  `skip_serializing_if`, so serde always emits it. A fixture that omitted the field would be
 *  asserting against a shape the command cannot produce. */
function status(over: Partial<BuilderIndexStatus> = {}): BuilderIndexStatus {
  return {
    enabled: true,
    username: "someone",
    hasApiKey: true,
    consented: true,
    // Deliberately NOT a 32-hex string: no assertion here reads this value, and a realistic
    // client id trips gitleaks' entropy rule on the `clientId` key name. Keep it word-shaped.
    clientId: "client-id-for-tests",
    reportDays: 7,
    lastReportAt: NOW - HOUR,
    lastStatus: "Reported 21 row(s) across 7 day(s).",
    blockedBy: null,
    serverUrl: "https://tokenmaxxing.odio.dev",
    ...over,
  };
}

describe("builderIndexReportFailing", () => {
  it("is false for a reporter whose last cycle landed", () => {
    expect(builderIndexReportFailing(status(), NOW)).toBe(false);
  });

  it("is true on the recorded failure message, on the first failed cycle", () => {
    // The fast path: verbatim what `record_outcome` is handed on both failure branches in
    // builder_index.rs. `lastReportAt` is still FRESH here — the previous cycle did land — so this
    // case is caught by the message alone and by nothing else.
    expect(
      builderIndexReportFailing(
        status({ lastStatus: "Last report failed — server returned 500." }),
        NOW,
      ),
    ).toBe(true);
  });

  it("is true for a live reporter whose last SUCCESS is far older than the cadence", () => {
    // The signal that survives a reword of that message: `last_report_at` advances only on the
    // success branch, so under a 2h cadence a success this old means cycles are being discarded.
    expect(
      builderIndexReportFailing(
        status({ lastReportAt: NOW - BUILDER_INDEX_STALE_AFTER_SECS - HOUR }),
        NOW,
      ),
    ).toBe(true);
  });

  it("is false while the last success is still inside the staleness window", () => {
    // The other side of that boundary. Without this, a rule that simply always fired would look
    // just as correct as the real one.
    expect(
      builderIndexReportFailing(
        status({ lastReportAt: NOW - BUILDER_INDEX_STALE_AFTER_SECS + HOUR }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is true when a cycle has run but no report has EVER landed", () => {
    expect(
      builderIndexReportFailing(
        status({ lastReportAt: null, lastStatus: "Last report failed — network error: dns error." }),
        NOW,
      ),
    ).toBe(true);
  });

  it("is false before any cycle has recorded an outcome", () => {
    // A freshly-consented install, inside the reporter's five-minute startup delay. Nothing has
    // failed. Reaching the message rules below with a null message is also how this throws rather
    // than answering — see the file header for why only a direct test can see that.
    expect(builderIndexReportFailing(status({ lastStatus: null, lastReportAt: null }), NOW)).toBe(
      false,
    );
  });

  it("is false whenever `blockedBy` says no report would go out at all", () => {
    // THE STATE THIS MUST NEVER CALL A FAILURE. Off / unconsented / unconfigured is the normal
    // condition of a default install, and it wins over BOTH failure rules — including a stale
    // timestamp and a failure message left behind from before the tool was switched off, which is
    // exactly the residue a user who turns it off is left holding.
    for (const blockedBy of [
      "Builder Index is off",
      "waiting for consent",
      "no tokenmaxxing username set",
      "no API key set",
      "the stored API key is unusable — re-enter it",
    ]) {
      expect(
        builderIndexReportFailing(
          status({
            blockedBy,
            lastReportAt: null,
            lastStatus: "Last report failed — network error: dns error.",
          }),
          NOW,
        ),
      ).toBe(false);
    }
  });
});
