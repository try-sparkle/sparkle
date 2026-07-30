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
import { useSettingsStore } from "../../stores/settingsStore";
import { DEFAULT_WAKE_WORD, DEFAULT_STOP_WORD } from "../../voice/voiceDefaults";

function setup(over: { interim?: string } = {}) {
  return render(
    <ComposeBox onSend={vi.fn()} onAttach={vi.fn()} {...over} />,
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
    }),
  );
  act(() =>
    useSettingsStore.setState({ wakeWord: DEFAULT_WAKE_WORD, stopWord: DEFAULT_STOP_WORD }),
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
    setup();
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

// THE reason the overlay exists. A native placeholder cannot style a substring, so if these
// assertions can be satisfied by plain text the overlay is pointless.
describe("ComposeBox — the wake phrase is a styled substring", () => {
  it("renders the wake word bold and in brand blue inside muted copy", () => {
    act(() => useDictationStore.setState(mic.passive()));
    setup();
    expect(bodyText()).toContain("Mic paused. Say ");
    expect(bodyText()).toContain("to activate (or you can type here instead).");
    // The wake phrase is its OWN element, styled — not part of the surrounding sentence.
    const phrase = screen.getByText(DEFAULT_WAKE_WORD);
    expect(phrase.tagName).toBe("SPAN");
    expect(phrase.style.fontWeight).toBeTruthy();
    expect(phrase.style.color).toBeTruthy();
    // …and it is genuinely a SUBSTRING: the muted copy around it is not inside that span.
    expect(phrase.textContent).toBe(DEFAULT_WAKE_WORD);
    expect(overlay()?.textContent).toContain(`Mic paused. Say ${DEFAULT_WAKE_WORD} to activate`);
  });

  it("uses the CONFIGURED wake word, not the built-in default", () => {
    act(() => useSettingsStore.setState({ wakeWord: "Yo Computer" }));
    act(() => useDictationStore.setState(mic.passive()));
    setup();
    expect(screen.getByText("Yo Computer")).toBeTruthy();
    expect(bodyText()).not.toContain(DEFAULT_WAKE_WORD);
  });

  it("styles the STOP phrase the same way while actively dictating", () => {
    act(() => useDictationStore.setState(mic.active()));
    setup();
    expect(bodyText()).toContain("I'm listening, so just start talking.");
    const phrase = screen.getByText(DEFAULT_STOP_WORD);
    expect(phrase.style.fontWeight).toBeTruthy();
    expect(bodyText()).not.toContain(DEFAULT_WAKE_WORD);
  });

  it("says 'Listening paused' — never invites the wake word — when armed but not capturing", () => {
    act(() => useDictationStore.setState(mic.focusPaused()));
    setup();
    expect(bodyText()).toContain("Listening paused");
    expect(bodyText()).not.toContain(DEFAULT_WAKE_WORD);
    expect(bodyText()).not.toContain("I'm listening, so just start talking.");
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
    // Never the wake-word invitation over a model that isn't there yet.
    expect(bodyText()).not.toContain(DEFAULT_WAKE_WORD);
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
    expect(bodyText()).not.toContain(DEFAULT_WAKE_WORD);
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
