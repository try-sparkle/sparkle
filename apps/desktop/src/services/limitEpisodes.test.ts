// Pins the TS half of a rule that is implemented twice — here and in accounts.rs `limit_episodes`.
// The Rust half has `limit_episodes_collapses_a_burst_into_one_sample`; this half had nothing, in a
// function whose wrongness changes a diagnostic's CONCLUSION (how many episodes an account has, and
// therefore whether it can learn a ceiling) rather than its formatting.
import { describe, it, expect } from "vitest";
import { collapseEpisodes, limitEventTime, WINDOW_5H_MS } from "./limitEpisodes";

const T0 = Date.parse("2026-08-01T00:00:00Z");

describe("collapseEpisodes", () => {
  it("collapses a retry burst into ONE episode", () => {
    // A rate-limited agent records a limit line per retry. Counting them raw turned 26 real walls
    // into 3,512 lines on the machine this was written against.
    const burst = [T0, T0 + 1000, T0 + 60_000, T0 + 3 * 60 * 60 * 1000];
    expect(collapseEpisodes(burst)).toEqual([T0]);
  });

  it("counts a second wall beyond the window as its own episode", () => {
    const two = [T0, T0 + WINDOW_5H_MS + 1];
    expect(collapseEpisodes(two)).toEqual([T0, T0 + WINDOW_5H_MS + 1]);
  });

  it("treats events EXACTLY one window apart as the same episode (strictly greater, like Rust)", () => {
    // The boundary is where two implementations of one rule drift apart without anyone noticing.
    expect(collapseEpisodes([T0, T0 + WINDOW_5H_MS])).toEqual([T0]);
  });

  it("sorts before collapsing, since events are collected in directory order", () => {
    // Unsorted input previously produced a different episode count for the same data.
    const late = T0 + WINDOW_5H_MS + 1;
    expect(collapseEpisodes([late, T0])).toEqual([T0, late]);
  });

  it("is empty for no events", () => {
    expect(collapseEpisodes([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [T0 + 10, T0];
    collapseEpisodes(input);
    expect(input).toEqual([T0 + 10, T0]);
  });
});

describe("limitEventTime", () => {
  it("reads the timestamp off a real structured limit record", () => {
    const line = JSON.stringify({
      type: "assistant",
      error: "rate_limit",
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      timestamp: "2026-07-24T23:40:26.360Z",
    });
    expect(limitEventTime(line)).toBe(Date.parse("2026-07-24T23:40:26.360Z"));
  });

  it("IGNORES an agent merely writing about rate limits", () => {
    // This is not hypothetical: the Phase-1 regex over raw terminal output benched healthy accounts
    // for hours because an agent's own prose about rate limiting is textually identical to a limit.
    const prose = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-24T23:40:26.360Z",
      message: { content: [{ type: "text", text: 'we hit a "rate_limit" earlier today' }] },
    });
    expect(limitEventTime(prose)).toBeNull();
  });

  it("skips a line truncated by a crash rather than throwing", () => {
    expect(limitEventTime('{"error":"rate_limit","timest')).toBeNull();
  });

  it("rejects a limit record with no usable timestamp", () => {
    expect(limitEventTime(JSON.stringify({ error: "rate_limit" }))).toBeNull();
    expect(limitEventTime(JSON.stringify({ error: "rate_limit", timestamp: "not a date" }))).toBeNull();
    // A numeric timestamp is not the transcript's shape and must not be guessed at.
    expect(limitEventTime(JSON.stringify({ error: "rate_limit", timestamp: 1786000000 }))).toBeNull();
  });

  it("ignores an unrelated error that happens to mention the token", () => {
    expect(limitEventTime(JSON.stringify({ error: "other", note: '"rate_limit"' }))).toBeNull();
  });
});
