import { describe, it, expect, beforeEach } from "vitest";
import {
  requestRetirementConfirm,
  subscribeRetirementConfirmRequests,
  __resetRetirementConfirmRequestsForTest,
} from "./retirementConfirmRequest";

beforeEach(() => __resetRetirementConfirmRequestsForTest());

describe("a refused machine close can reach the human", () => {
  it("delivers the agent id to a subscriber and reports that it opened", () => {
    const seen: string[] = [];
    subscribeRetirementConfirmRequests((id) => {
      seen.push(id);
      return true;
    });

    expect(requestRetirementConfirm("a1")).toBe(true);
    expect(seen).toEqual(["a1"]);
  });

  it("reports FALSE when nothing is listening — 'nobody heard' is not consent", () => {
    // The load-bearing case. `closeBuildAgent` refuses, this returns false, and the caller must say
    // so rather than fall through to closing the agent anyway. If this ever answered `true` on an
    // empty listener set, every refusal in a satellite window would silently claim the founder was
    // asked.
    expect(requestRetirementConfirm("a1")).toBe(false);
  });

  it("reports FALSE when the only listener DECLINES the agent", () => {
    // Two sidebars are mounted, one per column, each holding a different project. The one that does
    // not have this agent must decline, and a decline is not an open.
    subscribeRetirementConfirmRequests(() => false);
    expect(requestRetirementConfirm("a1")).toBe(false);
  });

  it("asks EVERY listener even after one accepts, and ORs the answers", () => {
    // Not a short-circuit: both windows can hold the project, and skipping the second would leave
    // it showing a row the first is already asking about.
    const asked: string[] = [];
    subscribeRetirementConfirmRequests(() => {
      asked.push("first");
      return true;
    });
    subscribeRetirementConfirmRequests(() => {
      asked.push("second");
      return false;
    });

    expect(requestRetirementConfirm("a1")).toBe(true);
    expect(asked).toEqual(["first", "second"]);
  });

  it("survives a THROWING listener without counting it as an open", () => {
    const asked: string[] = [];
    subscribeRetirementConfirmRequests(() => {
      throw new Error("unmounted mid-request");
    });
    subscribeRetirementConfirmRequests(() => {
      asked.push("second");
      return false;
    });

    // The throw must not stop the rest, and must not be read as "the dialog opened" — a crashed
    // listener is the one case where we know for certain the human saw nothing.
    expect(requestRetirementConfirm("a1")).toBe(false);
    expect(asked).toEqual(["second"]);
  });

  it("stops delivering after unsubscribe", () => {
    let calls = 0;
    const off = subscribeRetirementConfirmRequests(() => {
      calls += 1;
      return true;
    });

    requestRetirementConfirm("a1");
    off();
    expect(requestRetirementConfirm("a1")).toBe(false);
    expect(calls).toBe(1);
  });
});
