// @vitest-environment jsdom
//
// What is left of services/windowStatus after CM-U7 part 2 + roborev 46485-M: the red-COLOR
// predicate (still read by the concierge feed's banding and the alert tiers) and the one-shot
// cleanup of the storage the deleted cross-window channel left behind. The publish/subscribe/
// snapshot API — and the Tauri-emit fixtures these tests used to need — went with the channel,
// which had a writer and no reader.
import { beforeEach, describe, expect, it } from "vitest";
import {
  isRedStatus,
  resetWindowStatus,
  WINDOW_STATUS_KEY,
  WINDOW_STATUS_KEY_PREFIX,
} from "./windowStatus";
import type { AgentTabStatus } from "../types";

beforeEach(() => localStorage.clear());

describe("isRedStatus", () => {
  it("includes the red-color statuses and excludes the rest", () => {
    const red: AgentTabStatus[] = ["waiting", "approval", "errored", "blocked"];
    // `unmerged` is NOT red — it's a landing state, not an alarm (see packages/ui/tokens.ts and
    // engine/redTaxonomySeparation.test.ts). It sorts above the calm tier but never paints red.
    const notRed: AgentTabStatus[] = ["working", "idle", "done", "stopped", "unmerged"];
    for (const s of red) expect(isRedStatus(s)).toBe(true);
    for (const s of notRed) expect(isRedStatus(s)).toBe(false);
  });

  it("is false for a missing status (an agent with no runtime entry isn't red)", () => {
    expect(isRedStatus(undefined)).toBe(false);
  });
});

describe("resetWindowStatus — clears what the deleted channel left behind", () => {
  it("removes the legacy shared blob AND every per-window key, leaving other keys alone", () => {
    localStorage.setItem(WINDOW_STATUS_KEY, '{"win-a":{}}');
    localStorage.setItem(`${WINDOW_STATUS_KEY_PREFIX}main`, '{"redAgents":[]}');
    localStorage.setItem(`${WINDOW_STATUS_KEY_PREFIX}win-b`, '{"redAgents":[]}');
    localStorage.setItem("sparkle-ui", '{"state":{}}'); // an unrelated key must survive

    resetWindowStatus();

    expect(localStorage.getItem(WINDOW_STATUS_KEY)).toBeNull();
    expect(localStorage.getItem(`${WINDOW_STATUS_KEY_PREFIX}main`)).toBeNull();
    expect(localStorage.getItem(`${WINDOW_STATUS_KEY_PREFIX}win-b`)).toBeNull();
    expect(localStorage.getItem("sparkle-ui")).toBe('{"state":{}}');
  });

  it("is idempotent — a second boot with nothing to clear is a no-op", () => {
    resetWindowStatus();
    expect(() => resetWindowStatus()).not.toThrow();
    expect(localStorage.length).toBe(0);
  });
});
