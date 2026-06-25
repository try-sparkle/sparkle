import { describe, it, expect } from "vitest";
import { advance } from "./wakeMachine";

describe("advance — passive", () => {
  it("ignores non-wake speech (no transition, no insert)", () => {
    expect(advance("passive", "what is the weather")).toEqual({
      phase: "passive", insert: null, transitioned: false,
    });
  });
  it("wakes and inserts the same-segment remainder", () => {
    expect(advance("passive", "hey sparkle add a login button")).toEqual({
      phase: "active", insert: "add a login button", transitioned: true,
    });
  });
  it("wakes with no remainder → no insert", () => {
    expect(advance("passive", "sparkle")).toEqual({
      phase: "active", insert: null, transitioned: true,
    });
  });
});

describe("advance — active", () => {
  it("inserts ordinary speech without transitioning", () => {
    expect(advance("active", "create a new file")).toEqual({
      phase: "active", insert: "create a new file", transitioned: false,
    });
  });
  it("stops and inserts the pre-stop remainder", () => {
    expect(advance("active", "and ship the change send it")).toEqual({
      phase: "passive", insert: "and ship the change", transitioned: true,
    });
  });
  it("stops with no remainder → no insert", () => {
    expect(advance("active", "send it")).toEqual({
      phase: "passive", insert: null, transitioned: true,
    });
  });
  it("empty segment → no insert (null, not empty string)", () => {
    expect(advance("active", "")).toEqual({
      phase: "active", insert: null, transitioned: false,
    });
  });
  it("whitespace-only segment → no insert (null, not empty string)", () => {
    expect(advance("active", "   ")).toEqual({
      phase: "active", insert: null, transitioned: false,
    });
  });
});

describe("advance — passive boundary", () => {
  it("empty segment in passive → stays passive, no insert", () => {
    expect(advance("passive", "")).toEqual({
      phase: "passive", insert: null, transitioned: false,
    });
  });
});
