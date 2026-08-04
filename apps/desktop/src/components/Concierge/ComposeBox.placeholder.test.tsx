// @vitest-environment jsdom
//
// The RICH placeholder: the styled overlay that replaced `placeholder=""` in the concierge compose
// box. The user was shown the empty rendering and this one side by side and chose this one.
//
// Three things are pinned here, and each of them is a bug that has already been shipped once:
//   • the wake phrase renders as a STYLED SUBSTRING (bold + brand blue) inside otherwise muted
//     copy. That is the entire reason this is an overlay: a native `placeholder=` is one flat
//     string and cannot do it. If the overlay ever collapses back to plain text, the feature is
//     gone while every "does the copy appear" assertion still passes — so the style is asserted.
//   • the two FAILURE states (`error`, `outOfCredits`) render NO generic copy. Falling through to
//     the fallback there invites the user to speak at the exact moment the mic broke or was
//     refused for lack of credits, and this box is the app's ONLY composer, so that notice has no
//     other home.
//   • the overlay is CLICK-THROUGH but stacked ABOVE the textarea. Both halves matter: below it,
//     the "Refill" link looks clickable and does nothing; not click-through, focusing the box by
//     clicking its middle stops working.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposeBox,
  CONCIERGE_PLACEHOLDER,
  CONCIERGE_TEXTAREA_TEXT_WIDTH,
} from "./ComposeBox";
import { SUGGESTION_PILL_ZONE } from "../composer/SuggestionRow";
import { placeholderRightInset } from "../composer/RichPlaceholder";
import { useDictationStore } from "../../stores/dictationStore";
import {
  PTT_COMPOSER_PLACEHOLDER,
  SPEAK_COMPOSER_PLACEHOLDER,
} from "../../voice/dictationCopy";
import type { SendMode } from "../../voice/sendMode";

// `sendMode` defaults to "speak" here, NOT to the component's own "send" default. The live voice
// copy follows the TRAY, and on Send the box deliberately promises nothing (the mic, if on at all,
// is governed by another surface) — so a fixture left on the component default would render the
// fallback for every live-mic row and pass its negative assertions vacuously.
function setup(over: { interim?: string; sendMode?: SendMode } = {}) {
  return render(
    <ComposeBox onSend={vi.fn()} onAttach={vi.fn()} sendMode="speak" {...over} />,
  );
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const overlay = () => screen.queryByTestId("compose-placeholder");
const bodyText = () => document.body.textContent ?? "";

/** The mic states, driven the way the app drives them — through the store, since
 *  useVoicePlaceholder reads it directly so every mic surface derives ONE state per snapshot. */
const mic = {
  off: () => ({ enabled: false, status: "idle" as const, error: null, outOfCreditsNotice: false }),
  passive: () => ({ enabled: true, status: "listening" as const, phase: "passive" as const }),
  active: () => ({ enabled: true, status: "listening" as const, phase: "active" as const }),
  focusPaused: () => ({ enabled: true, status: "idle" as const }),
};

beforeEach(() => {
  act(() =>
    useDictationStore.setState({
      enabled: false,
      status: "idle",
      phase: "passive",
      error: null,
      modelProgress: null,
      outOfCreditsNotice: false,
      // Reset too, symmetrical with BoundDeviceCaption's fixture (roborev 57282). The pause is an
      // INPUT to `deriveMicPresentation` now, so the background-window row below leaves a window
      // pause set for every row DECLARED AFTER it — the store is module-level and vitest preserves
      // declaration order. Harmless only by accident today (every mic-arming row happens to sit
      // above it); the next `mic.active()` row appended to this file would render `focusPaused` and
      // fail for a reason unrelated to its subject, or pass a negative assertion vacuously.
      windowFocused: true,
      focusOwner: "other",
    }),
  );
});
afterEach(() => cleanup());

describe("ComposeBox — the rich placeholder replaced the empty one", () => {
  it("paints copy in the slot the native placeholder left empty", () => {
    setup();
    // The native attribute stays EMPTY — the two renderings must never both paint.
    expect(box().getAttribute("placeholder")).toBe("");
    expect(overlay()).toBeTruthy();
    expect(bodyText()).toContain(CONCIERGE_PLACEHOLDER);
  });

  // PR #631 removed the "(⌘↩ to send)" tail deliberately; the hint lives on the Send button. A
  // rich placeholder is exactly the kind of change that invites putting it back "since there's
  // room now".
  it("does NOT reintroduce a (⌘↩ to send) tail", () => {
    // `send` explicitly: in Push to talk the chiclet is the TALK key (⌘), not a send chord, so the
    // fixture default (`speak`) would make the title assertion below about a different question.
    setup({ sendMode: "send" });
    expect(bodyText()).not.toContain("⌘↩ to send");
    expect(bodyText()).not.toContain("to send)");
    // …and the hint is still where PR #631 put it.
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("title")).toContain("⌘↩");
  });

  it("names no destination, exactly as the empty box didn't", () => {
    setup();
    // The reference rendering for this slot read "Talk to Sparkle — …" / "Prompt <agent> — …",
    // which auto-routing made a promise the box can't keep before the user has typed anything.
    expect(bodyText()).not.toMatch(/talk to sparkle|prompt /i);
  });

  it("gives the slot back to the draft the moment the user types", () => {
    setup();
    expect(overlay()).toBeTruthy();
    fireEvent.change(box(), { target: { value: "a" } });
    expect(overlay()).toBeNull();
    fireEvent.change(box(), { target: { value: "" } });
    expect(overlay()).toBeTruthy();
  });
});

// THE LIVE COPY FOLLOWS THE TRAY, NOT THE PHASE. This is the founder's bug, at the composer: he was
// shown wake-word copy ("Mic paused. Say Hey Sparkle to activate") with the tray on PUSH TO TALK.
// The wake word is gone, so the failure to guard against now is the same shape one step over — a
// push-to-talk HOLD reaches `activeListening` exactly as Speak does, so copy keyed on the phase
// would tell someone holding the key to "pause when you're done" instead of to let go.
describe("ComposeBox — the live sentence names the MODE, not the phase", () => {
  it("Push to talk says 'Hold ⌘ to talk' in BOTH live phases — held and at rest", () => {
    for (const phase of ["passive", "active"] as const) {
      act(() => useDictationStore.setState(phase === "active" ? mic.active() : mic.passive()));
      setup({ sendMode: "ptt" });
      expect(bodyText()).toContain(PTT_COMPOSER_PLACEHOLDER);
      // The decisive half: it must NOT borrow Speak's sentence just because speech is routing.
      expect(bodyText()).not.toContain(SPEAK_COMPOSER_PLACEHOLDER);
      cleanup();
    }
  });

  it("Speak says its own sentence, and never push-to-talk's", () => {
    act(() => useDictationStore.setState(mic.active()));
    setup({ sendMode: "speak" });
    expect(bodyText()).toContain(SPEAK_COMPOSER_PLACEHOLDER);
    expect(bodyText()).not.toContain(PTT_COMPOSER_PLACEHOLDER);
  });

  it("no live sentence ever names a wake or stop word again", () => {
    for (const sendMode of ["ptt", "speak"] as const) {
      act(() => useDictationStore.setState(mic.active()));
      setup({ sendMode });
      expect(bodyText()).not.toMatch(/Hey Sparkle/i);
      expect(bodyText()).not.toMatch(/Sparkle,\s*(pause|stop)/i);
      cleanup();
    }
  });

  // The tray on Send means the mic — if on at all — belongs to another surface, so this box makes
  // no voice promise and yields the slot to its own "what I'm for" copy.
  it("Send promises nothing about voice, even with a live mic armed elsewhere", () => {
    act(() => useDictationStore.setState(mic.active()));
    setup({ sendMode: "send" });
    expect(bodyText()).not.toContain(SPEAK_COMPOSER_PLACEHOLDER);
    expect(bodyText()).not.toContain(PTT_COMPOSER_PLACEHOLDER);
    expect(bodyText()).toContain(CONCIERGE_PLACEHOLDER);
  });

  it("says 'Listening paused' — never a live sentence — when armed but not capturing", () => {
    act(() => useDictationStore.setState(mic.focusPaused()));
    setup();
    expect(bodyText()).toContain("Listening paused");
    expect(bodyText()).not.toContain(SPEAK_COMPOSER_PLACEHOLDER);
    expect(bodyText()).not.toContain(PTT_COMPOSER_PLACEHOLDER);
  });

  // THE TERMINAL PAUSE IS A TWO-LINE, CENTERED NOTICE (founder's copy), and every assertion below
  // fails against the sentence it replaced ("Listening paused — your cursor is in a terminal. Click
  // here to resume."), which was one left-aligned wrapped line with no bold.
  describe("paused because the caret is in a TERMINAL", () => {
    const inTerminal = () =>
      act(() =>
        useDictationStore.setState({
          enabled: true,
          status: "idle",
          windowFocused: true,
          focusOwner: "terminal",
        } as never),
      );

    it("renders the two lines, and drops the 'cursor is in a terminal' explanation", () => {
      inTerminal();
      setup();
      expect(screen.getByText("Listening paused")).toBeTruthy();
      expect(screen.getByText("Click to re-engage the Sparkle Concierge")).toBeTruthy();
      // The reason is GONE — the whole point of the rewrite, and the half a "contains 'Listening
      // paused'" assertion would happily pass without.
      expect(bodyText()).not.toContain("cursor is in a terminal");
      expect(bodyText()).not.toContain("Click here to resume");
    });

    it("bolds ONLY the first line, and centers the whole block", () => {
      inTerminal();
      setup();
      const headline = screen.getByText("Listening paused");
      const action = screen.getByText("Click to re-engage the Sparkle Concierge");
      expect(headline.style.fontWeight).toBeTruthy();
      // The second line stays normal weight — "bold" was asked for on the first line only.
      expect(action.style.fontWeight).toBe("");
      // BOTH lines centered, not just one: the centering lives on the block that wraps them, so it
      // is read off their shared parent rather than off either line.
      const block = headline.parentElement!;
      expect(block).toBe(action.parentElement);
      expect(block.style.textAlign).toBe("center");
      // Two separate lines, not one wrapped sentence — each must be its own block box.
      expect(headline.style.display).toBe("block");
      expect(action.style.display).toBe("block");
    });

    it("stays CLICK-THROUGH, so the gesture that resumes listening is untouched", () => {
      // This is copy + layout only. The notice is painted over the textarea with pointerEvents:none
      // and the click lands on the box beneath — giving the notice its own handler would MOVE the
      // target and break resuming, which is the one thing this change must not do.
      inTerminal();
      setup();
      expect(overlay()!.style.pointerEvents).toBe("none");
      expect(overlay()!.querySelector("button")).toBeNull();
      // Nothing inside re-enables pointer events either — the "Refill" link and the error's Dismiss
      // do exactly that, so an inherited `none` on the overlay is not on its own sufficient.
      for (const el of overlay()!.querySelectorAll<HTMLElement>("*")) {
        expect(el.style.pointerEvents).not.toBe("auto");
      }
      // NOT asserted here: that clicking the box focuses it and resumes. jsdom's fireEvent.click
      // does not move focus, so any such assertion would pass or fail on the harness rather than on
      // this code. That half is verified in a real browser instead (see the branch's progress doc).
    });

    it("shows the PAUSED copy in a background window, where `status` never drops", () => {
      // ── roborev 57277 ─────────────────────────────────────────────────────────────────────────
      // The row below writes `status: "idle"`, which already yielded `focusPaused` before
      // `pauseReason` became an input to `deriveMicPresentation` — so it was true of the old code
      // and proves nothing about the new wiring.
      //
      // This is the snapshot that needed it: the per-window blur leaves `status` at "listening", so
      // without the pause term the composer invited the user to speak ("Say <stop> to finish")
      // while the sidebar two panes over said listening was paused.
      act(() =>
        useDictationStore.setState({
          enabled: true,
          status: "listening", // NOT demoted by the blur path — the point of the case
          phase: "active",
          windowFocused: false,
          focusOwner: null,
        } as never),
      );
      setup();
      expect(bodyText()).toContain("Listening paused");
      // …and it must NOT be inviting speech at the same time.
      expect(bodyText()).not.toContain("to finish");
    });

    it("does NOT put the concierge wording on a pause with a different cause", () => {
      // A window pause is a different story with a different remedy (it auto-resumes), and this
      // surface must not speak for it. Guards the exact "one cause's wording for all" failure.
      act(() =>
        useDictationStore.setState({
          enabled: true,
          status: "idle",
          windowFocused: false,
          focusOwner: null,
        } as never),
      );
      setup();
      expect(bodyText()).toContain("Listening paused");
      expect(bodyText()).not.toContain("Click to re-engage the Sparkle Concierge");
    });
  });

  it("shows the one-time model download honestly while preparing", () => {
    act(() =>
      useDictationStore.setState({ enabled: true, modelProgress: { done: 241, total: 482 } }),
    );
    setup();
    expect(bodyText()).toContain("Setting up voice");
    expect(bodyText()).toContain("(50%)");
    // Never a live-capture sentence over a model that isn't there yet.
    expect(bodyText()).not.toContain(SPEAK_COMPOSER_PLACEHOLDER);
  });
});

// The switch is TOTAL. Both failure states used to share a `default:` arm with `off`, so both
// painted the generic "here's what I'm for" copy over a mic that had just failed.
describe("ComposeBox — the failure states take the slot over, never the fallback", () => {
  it("error: shows the real cause and remedy, and NOT the generic copy", () => {
    act(() =>
      useDictationStore.setState({ enabled: true, error: "no default input device available" }),
    );
    setup();
    expect(bodyText()).toContain("No microphone found.");
    expect(bodyText()).not.toContain(CONCIERGE_PLACEHOLDER);
    expect(bodyText()).not.toContain(SPEAK_COMPOSER_PLACEHOLDER);
    // The decorative overlay renders nothing in this state, so the two can't double up.
    expect(overlay()?.textContent).toBe("");
  });

  it("outOfCredits: shows the refill notice, and NOT the generic copy", () => {
    act(() => useDictationStore.setState({ outOfCreditsNotice: true }));
    setup();
    expect(bodyText()).toContain("You are out of credits.");
    expect(bodyText()).not.toContain(CONCIERGE_PLACEHOLDER);
    expect(overlay()?.textContent).toBe("");
  });

  // outOfCredits OUTRANKS off (it is set with the mic still disarmed), which is exactly the case
  // that would otherwise fall through to the fallback.
  it("outOfCredits wins over the master-mute fallback", () => {
    act(() => useDictationStore.setState({ enabled: false, outOfCreditsNotice: true }));
    setup();
    expect(bodyText()).not.toContain(CONCIERGE_PLACEHOLDER);
  });

  // Both failure notices carry a CONTROL, so neither may live inside the aria-hidden overlay —
  // aria-hidden hides a whole subtree with no way for a descendant to opt back in, which would
  // bury Dismiss / Refill from a screen reader entirely.
  it("announces each failure and keeps its control reachable", () => {
    act(() => useDictationStore.setState({ outOfCreditsNotice: true }));
    setup();
    const notice = screen.getByTestId("compose-out-of-credits");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-hidden")).toBeNull();
    // The link re-enables pointer events on itself inside the click-through overlay.
    const refill = screen.getByRole("button", { name: "Refill" });
    expect(refill.style.pointerEvents).toBe("auto");
  });

  it("announces a voice error and keeps Dismiss reachable", () => {
    act(() => useDictationStore.setState({ enabled: true, error: "no default input device" }));
    setup();
    const notice = screen.getByTestId("compose-voice-error");
    expect(notice.getAttribute("role")).toBe("status");
    expect(screen.getByRole("button", { name: "Dismiss voice error" }).style.pointerEvents).toBe(
      "auto",
    );
  });

  it("dismissing a DEAD-MIC notice must not claim the mic is listening again", () => {
    // The concierge twin of the Composer guard. This exact seam escaped twice — the audio-recovered
    // path was fixed while the Dismiss button was missed, and the button itself lives in TWO files —
    // so both surfaces are pinned. Dismiss means "I've read this", not "frames are flowing again";
    // only dictation://audio-recovered has that evidence. Claiming "listening" here would paint a
    // live mic over a still-dead one, which is the incident this notice exists to surface.
    act(() =>
      useDictationStore.setState({
        enabled: true,
        error: 'No audio from "MacBook Pro Microphone". Another app may be holding the microphone.',
        status: "error",
      }),
    );
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss voice error" }));
    expect(useDictationStore.getState().error).toBeNull();
    expect(useDictationStore.getState().status).not.toBe("listening");
    expect(useDictationStore.getState().status).toBe("idle");
  });
});

describe("ComposeBox — the overlay's stacking contract", () => {
  it("is decorative to a screen reader: aria-hidden, so the textarea's own name is what's announced", () => {
    setup();
    expect(overlay()?.getAttribute("aria-hidden")).toBe("true");
    // The box still reads as "Message" — the overlay adds no competing accessible text.
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });

  it("is click-through, so focusing the textarea underneath still works", () => {
    setup();
    expect(overlay()?.style.pointerEvents).toBe("none");
    box().focus();
    expect(document.activeElement).toBe(box());
  });

  // Not merely "it has a z-index": it must be ABOVE the textarea, or an interactive child that
  // re-enables pointer events (Refill) receives nothing because the textarea swallows the click.
  it("sits ABOVE the textarea in the stack, not under it", () => {
    setup();
    expect(Number(overlay()!.style.zIndex)).toBeGreaterThan(Number(box().style.zIndex));
  });

  // A fixed-height box needs a bottom edge: an absolute overlay is not clipped by the textarea the
  // way a native placeholder is, so without one, three lines of copy spill out over the thread.
  it("clips at the box's edge rather than spilling over its neighbours", () => {
    setup();
    expect(overlay()!.style.overflow).toBe("hidden");
    expect(overlay()!.style.bottom).toBeTruthy();
  });
});

// The LAYOUT HAZARD, measured rather than asserted in a comment. SuggestionRow's "overlay" layout
// pins a pill to the textarea's trailing-right edge and the placeholder occupies the same slot, so
// the build Composer reserves SUGGESTION_PILL_ZONE of right inset to make long copy wrap early.
// At the concierge column width that reservation cannot fit, which is WHY the column renders the
// row with layout="row" (a static strip in its own box) instead. If the column ever widens enough
// for an overlay pill to fit, this test goes red and the decision gets re-made deliberately.
describe("ComposeBox — the pill zone and this textarea are mutually exclusive", () => {
  it("the pill's footprint exceeds this textarea's whole text column", () => {
    expect(SUGGESTION_PILL_ZONE).toBeGreaterThan(CONCIERGE_TEXTAREA_TEXT_WIDTH);
  });

  it("so the concierge overlay reserves nothing — there is no pill painted over it", () => {
    setup();
    // The resting inset, not the pill zone: the row lives in its own box above this one.
    expect(overlay()!.style.right).toBe("13px");
  });

  it("placeholderRightInset still swaps in the pill's own footprint for a host that DOES overlay", () => {
    expect(placeholderRightInset(true, 13)).toBe(SUGGESTION_PILL_ZONE);
    expect(placeholderRightInset(false, 13)).toBe(13);
  });
});

describe("the fixture leaves no pause behind", () => {
  // ── roborev 57282 ─────────────────────────────────────────────────────────────────────────────
  // THE CANARY, declared LAST on purpose. The background-window row above writes
  // `windowFocused: false`, and with the pause now an INPUT to `deriveMicPresentation` that leaks
  // into every row declared after it — the store is module-level and vitest preserves declaration
  // order. This is the exact row the reviewer described as the one that would break: an armed,
  // actively-dictating mic, which renders `focusPaused` instead of `activeListening` under a leaked
  // pause, failing for a reason that has nothing to do with its subject.
  //
  // It asserts POSITIVELY (the live copy is present) rather than only its absence, because the
  // negative half is exactly what would pass vacuously under the leak.
  it("an actively-dictating mic still reads as live when declared after a paused row", () => {
    act(() => useDictationStore.setState(mic.active()));
    setup({ sendMode: "speak" });
    expect(bodyText()).toContain(SPEAK_COMPOSER_PLACEHOLDER);
    expect(bodyText()).not.toContain("Listening paused");
  });
});
