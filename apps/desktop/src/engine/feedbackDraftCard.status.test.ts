// A drafted-feedback card is not a question for a person (bead sparkle-eou3y0.5).
//
// The card's footer is shaped like a picker's, so the status engine used to settle the row on
// `waiting`, the red "Needs you" band. These tests drive the REAL StatusEngine with the card on its
// viewport and assert the band it emits. Each one is paired with a screen that IS a question, so a
// change that simply stops painting red cannot pass.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import { feedbackDraftCardIsOnlyAsk, screenAwaitsHuman } from "./feedbackDraftCard";
import { screenAwaitsInput } from "./screenClassifier";
import {
  FEEDBACK_DRAFT_CARD_QUOTED_SCREEN,
  FEEDBACK_DRAFT_CARD_SCREEN,
  FEEDBACK_DRAFT_CARD_SLASH_SCREEN,
} from "./incidentScreens.fixture";
import { isRedStatus } from "../services/windowStatus";
import { log } from "../logger";
import type { AgentTabStatus } from "../types";

// The card with a real yes/no question drawn under it. The card is still live (one row below its
// footer), so only the "remove the card and ask again" step can tell that something else is asking.
const CARD_WITH_SHELL_QUESTION = FEEDBACK_DRAFT_CARD_SCREEN.replace(
  "  1 to review · 2 to send · 0 to dismiss",
  "  1 to review · 2 to send · 0 to dismiss\n  Overwrite existing file? (y/n)",
);

const PERMISSION_SCREEN = [
  "│ Do you want to make this edit to foo.ts?           │",
  "│ ❯ 1. Yes                                           │",
  "│   2. No, and tell Claude what to do differently    │",
].join("\n");

let logInfo: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logInfo = vi.spyOn(log, "info").mockImplementation(() => {});
});
afterEach(() => logInfo.mockRestore());

describe("feedbackDraftCardIsOnlyAsk", () => {
  it("is true for a live card in either footer spelling", () => {
    expect(feedbackDraftCardIsOnlyAsk(FEEDBACK_DRAFT_CARD_SCREEN)).toBe(true);
    expect(feedbackDraftCardIsOnlyAsk(FEEDBACK_DRAFT_CARD_SLASH_SCREEN)).toBe(true);
  });

  it("is false for a card that output has scrolled past", () => {
    expect(feedbackDraftCardIsOnlyAsk(FEEDBACK_DRAFT_CARD_QUOTED_SCREEN)).toBe(false);
  });

  it("is false when a real question is on screen beside the card", () => {
    expect(feedbackDraftCardIsOnlyAsk(CARD_WITH_SHELL_QUESTION)).toBe(false);
    expect(screenAwaitsHuman(CARD_WITH_SHELL_QUESTION)).toBe(true);
  });

  it("is false for an ordinary picker and for an empty screen", () => {
    expect(feedbackDraftCardIsOnlyAsk(PERMISSION_SCREEN)).toBe(false);
    expect(feedbackDraftCardIsOnlyAsk("")).toBe(false);
  });

  it("leaves the WRITE guard's answer alone: the card still blocks typed text", () => {
    // Its options are single keystrokes, so free text could press `2 send`.
    expect(screenAwaitsInput(FEEDBACK_DRAFT_CARD_SCREEN)).toBe(true);
    expect(screenAwaitsHuman(FEEDBACK_DRAFT_CARD_SCREEN)).toBe(false);
  });
});

function makeEngine(getScreen: () => string) {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({ agentId: "card", onStatus: (s) => statuses.push(s), getScreen });
  return { engine, last: () => statuses[statuses.length - 1] };
}

describe("StatusEngine — a drafted-feedback card is not Needs-you", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("settles a turn that ends on the card to idle, not waiting", () => {
    const { engine, last } = makeEngine(() => FEEDBACK_DRAFT_CARD_SCREEN);
    engine.ingest("Not blocked — goal met, PR on main. Drafted feedback.\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("idle");
    expect(isRedStatus(last()!)).toBe(false);
  });

  it("PAIRED: the same turn ending on a permission dialog still settles red", () => {
    const { engine, last } = makeEngine(() => PERMISSION_SCREEN);
    engine.ingest("About to edit foo.ts.\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("waiting");
  });

  it("PAIRED: a card with a real question beside it still settles red", () => {
    const { engine, last } = makeEngine(() => CARD_WITH_SHELL_QUESTION);
    engine.ingest("Drafted feedback, then asked.\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("waiting");
  });

  it("a card footer STREAMED with the card already painted never paints red", () => {
    const { engine, last } = makeEngine(() => FEEDBACK_DRAFT_CARD_SCREEN);
    engine.ingest("  Bug report drafted: Status-check nudges keep firing\n");
    engine.ingest("  1 to review · 2 to send · 0 to dismiss\n");
    expect(last()).not.toBe("waiting");
    vi.advanceTimersByTime(30_000);
    expect(last()).toBe("idle");
  });

  it("a card footer streamed BEFORE the card painted is lowered by the late re-read", () => {
    let screen = "";
    const { engine, last } = makeEngine(() => screen);
    engine.ingest("  1 to review · 2 to send · 0 to dismiss\n");
    expect(last()).toBe("waiting");
    screen = FEEDBACK_DRAFT_CARD_SCREEN;
    vi.advanceTimersByTime(30_000);
    expect(last()).toBe("idle");
  });

  it("PAIRED: a picker footer streamed before an ordinary dialog painted stays red", () => {
    let screen = "";
    const { engine, last } = makeEngine(() => screen);
    engine.ingest("  1 to review · 2 to send · 0 to dismiss\n");
    expect(last()).toBe("waiting");
    screen = PERMISSION_SCREEN;
    vi.advanceTimersByTime(30_000);
    expect(last()).toBe("waiting");
  });
});
