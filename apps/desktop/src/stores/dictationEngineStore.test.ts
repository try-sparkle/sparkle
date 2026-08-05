import { beforeEach, describe, expect, it } from "vitest";
import {
  shouldWarnLocalEngine,
  useDictationEngineStore,
  type DictationEngineState,
} from "./dictationEngineStore";

const read = (): DictationEngineState => useDictationEngineStore.getState();

beforeEach(() => {
  useDictationEngineStore.setState({ fallbackReason: null, dismissed: false });
});

describe("dictationEngineStore", () => {
  it("stays silent at rest — no stream is open, and nothing is wrong", () => {
    // The resting state is NOT "cloud is live": at rest no relay stream exists at all. A banner
    // keyed on "is cloud streaming right now" would be lit permanently while nothing was broken.
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("warns once a cloud attempt has been refused", () => {
    read().noteCloudUnavailable("unavailable");
    expect(read().fallbackReason).toBe("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("retires the warning when a cloud stream comes back", () => {
    read().noteCloudUnavailable("unavailable");
    read().noteCloudLive();
    expect(read().fallbackReason).toBeNull();
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("stays hidden for the rest of an episode once dismissed", () => {
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    expect(shouldWarnLocalEngine(read())).toBe(false);
    // Re-reporting the SAME reason must not nag — every subsequent refusal in one outage would
    // otherwise re-open a banner the user deliberately waved away.
    read().noteCloudUnavailable("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(false);
  });

  it("re-arms a dismissal for a DIFFERENT reason", () => {
    // Out-of-credits is the one reason the user can act on, so it has to be able to speak even
    // after a plain outage was dismissed. This is the assertion that fails if `dismissed` is
    // carried over unconditionally.
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    read().noteCloudUnavailable("exhausted");
    expect(read().fallbackReason).toBe("exhausted");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });

  it("re-arms after a recovery, so a later distinct outage is not silenced by one dismissal", () => {
    read().noteCloudUnavailable("unavailable");
    read().dismiss();
    read().noteCloudLive();
    read().noteCloudUnavailable("unavailable");
    expect(shouldWarnLocalEngine(read())).toBe(true);
  });
});
