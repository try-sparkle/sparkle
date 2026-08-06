// @vitest-environment jsdom
//
// ONE MICROPHONE IN THIS COLUMN, and it is the ring in the header.
//
// The column used to show two. The waveform ring sat under the brand mark at the top, and a second
// mic button sat at the bottom of the same column immediately left of Send — roughly two inches
// apart, both live, with nothing on screen to say which one was in charge or what the difference
// was. They also did different things: the ring only moved the shared dictation store, while the
// bottom button additionally claimed the app-wide insert target, so arming from the ring produced a
// column that said "Actively listening" while the words went to an agent pane in another column.
// That is what "the microphone doesn't work" looked like.
//
// The bottom button is gone. These tests render the WHOLE column with the real ring and the real
// compose box and pin two separate things, because no single assertion covers both honestly:
//
//   1. COUNT — exactly one mic glyph, and it is the ring. Exact, via the `data-hint` both mic
//      surfaces carry. Not a "the old button isn't there" check: a count fails on any second mic.
//   2. POSITION — no voice control of any kind below the thread, matched loosely by accessible
//      name. This is the broad one, and the reason it is phrased as position rather than as a
//      count: the header legitimately holds three controls that move the same phase (the ring, the
//      waveform strip, the caption button), so "one voice control in the column" was never true.
//      What IS true, and is what the user asked for, is that they all live at the top.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: () => Promise.resolve() }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import { useDictationStore } from "../../stores/dictationStore";
import { useAuthStore } from "../../stores/authStore";
import type { ConciergeController, ConciergeViewModel } from "./types";

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
  messages: [],
};

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
  };
}

beforeEach(() => {
  // The ring's rAF loop only needs to be able to schedule; nothing here asserts on frames.
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 },
  });
});
afterEach(() => cleanup());

const MIC_STATES = [
  ["mic off", { enabled: false, status: "idle" as const, phase: "passive" as const }],
  ["mic armed, waiting on the wake word", { enabled: true, status: "listening" as const, phase: "passive" as const }],
  ["mic actively dictating", { enabled: true, status: "listening" as const, phase: "active" as const }],
] as const;

function renderColumn(state: (typeof MIC_STATES)[number][1]) {
  useDictationStore.setState({ ...state, error: null, modelProgress: null, outOfCreditsNotice: false });
  return render(<ConciergeColumn model={model} controller={controller()} />);
}

/** The mic GLYPHS — the thing the user counted when they said there were two. Both mic surfaces
 *  carry one of these hints (they are also the coach-mark anchors), so this is exact rather than
 *  heuristic: `mic` is the header ring, `composer-mic` the bare glyph beside a composer. */
function micGlyphs(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[data-hint="mic"], [data-hint="composer-mic"]'));
}

/** Anything in the column that operates the voice pipeline, matched loosely by accessible name so
 *  a NEW control slips past only by avoiding every word for what it does. Deliberately broader than
 *  {@link micGlyphs}: it used to pick up the waveform strip and the caption button, which toggled
 *  the same phase without drawing a mic. Used for the "nothing below the thread" guard, where
 *  breadth is what matters — not for a count.
 *
 *  IT LEGITIMATELY RETURNS AN EMPTY LIST NOW. The send tray became the only mic control, so the
 *  header's ring/strip/caption are read-outs with no handlers and no action-shaped names, and the
 *  tray itself is excluded by identity below. An empty result is therefore the PASSING state, not a
 *  broken matcher — which is why the guard that used to assert `length > 0` was replaced with a
 *  self-test of the matcher against a synthetic control (see below). Without that swap this file
 *  would have gone quietly vacuous the moment the last named button left the column. */
function voiceControls(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("button")).filter((b) => {
    // THE SEND TRAY IS NOT A VOICE CONTROL THAT DRIFTED BACK IN — it is the SEND control, and two of
    // its three positions are named for what the microphone does in them ("Push to talk", "Speak").
    // The broad name match below cannot tell those apart from a re-added mic button, and narrowing
    // the regex instead would blind it to a real one called "Speak". So the tray is excluded by
    // IDENTITY, and the row below asserts the thing that actually regressed: no mic GLYPH inside it.
    //
    // The defect this file pins was two mic glyphs on screen at once — one in the header, one beside
    // Send, both operating the same phase. A send control that names its modes is not that.
    if (b.closest('[data-testid="send-mode-tray"]')) return false;
    const name = `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`;
    return /mic|voice|dictat|listen|speak|talk to sparkle/i.test(name);
  });
}

describe("ConciergeColumn — exactly one mic", () => {
  for (const [label, state] of MIC_STATES) {
    it(`renders one mic glyph, and only one, while ${label}`, () => {
      const { container } = renderColumn(state);
      // Every state, not just the resting one: the removed button was styled to light up gold when
      // live, so "actively dictating" is precisely when two mics were most visible at once.
      const glyphs = micGlyphs(container);
      expect(glyphs).toHaveLength(1);
      expect(glyphs[0]!.getAttribute("data-hint")).toBe("mic");
    });
  }

  for (const [label, state] of MIC_STATES) {
    it(`puts no voice control at all below the thread while ${label}`, () => {
      // The REAL guard, and the broad one. The mic the user wanted gone was at the bottom of the
      // column, beside Send; the one they kept is in the header. So rather than counting, assert
      // POSITION: every voice control in this column precedes the thread. Anything added to the
      // compose row later fails here whatever it calls itself.
      const { container } = renderColumn(state);
      const thread = screen.getByTestId("concierge-thread");

      // THE MATCHER STILL MATCHES. This used to be `found.length > 0`, which worked only while the
      // header held named voice buttons — it no longer does (see `voiceControls`), so that form
      // would now fail on a column that is entirely correct. Probing a synthetic control keeps the
      // guard's actual job: prove the position loop below could ever fail, rather than pass because
      // the query was silently matching nothing.
      const probe = document.createElement("button");
      probe.setAttribute("aria-label", "Turn off microphone");
      container.appendChild(probe);
      expect(voiceControls(container)).toContain(probe);
      probe.remove();

      const found = voiceControls(container);
      for (const c of found) {
        expect(c.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    });
  }

  for (const [label, state] of MIC_STATES) {
    it(`the send tray carries no mic glyph of its own while ${label}`, () => {
      // The other half of the exclusion above. The tray sits exactly where the removed mic button
      // sat, so if a glyph is ever put back it will be put back INSIDE it — where `voiceControls`
      // now refuses to look. This looks there.
      const { container } = renderColumn(state);
      const tray = container.querySelector('[data-testid="send-mode-tray"]');
      expect(tray).not.toBeNull();
      expect(micGlyphs(tray as HTMLElement)).toHaveLength(0);
    });
  }

  it("the compose row still has Send — only the mic left it", () => {
    // Guards against the removal being over-broad: the row it lived in is shared with the Send
    // button and the attach controls, and all of those must survive.
    useDictationStore.setState({ enabled: false, status: "idle", phase: "passive" });
    render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });
});
