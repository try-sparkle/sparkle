// @vitest-environment jsdom
//
// The compose box half of the voice pass: the full dictation lifecycle the box is responsible for
// — register a target, paint live partials, commit finished segments into the text, stop — plus
// the invariant that the un-committed preview can never be sent.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDictated, ComposeBox, COMPOSE_TEXT_PAD_BOTTOM } from "./ComposeBox";
import {
  CONCIERGE_INTERIM_TESTID,
  interimSuffix,
  MENTION_MIRROR_SKIP_ATTR,
  MENTION_MIRROR_TESTID,
} from "./MentionMirror";
import { useDictationStore } from "../../stores/dictationStore";
import {
  focusQuietly,
  resetProgrammaticFocusForTest,
} from "../../services/programmaticFocus";
import { useUiStore } from "../../stores/uiStore";
import { COMPOSE_MIN_H } from "../../engine/composeBoxHeight";

afterEach(() => {
  cleanup();
  resetProgrammaticFocusForTest(); // module state outlives a component tree
  // …as does a dragged compose height, which is PERSISTED. One test sets it; leaving it set would
  // hand every later test a box sized by that one.
  useUiStore.getState().setConciergeComposeH(null);
});

type Append = (text: string) => void;

function setup(over: { interim?: string } = {}) {
  const onSend = vi.fn();
  const onAttach = vi.fn();
  // A STABLE identity, as the box requires: an unstable one would re-register every render.
  const seen: (Append | null)[] = [];
  const registerInsert = (fn: Append | null) => {
    seen.push(fn);
  };
  const tree = (props: { interim?: string }) => (
    <ComposeBox
      onSend={onSend}
      onAttach={onAttach}
      registerInsert={registerInsert}
      {...props}
    />
  );
  const view = render(tree(over));
  // A committed segment arrives from a Tauri event, i.e. outside React, so drive it through act.
  const dictate = (segment: string) => {
    const append = seen.filter((f): f is Append => f !== null).at(-1);
    if (!append) throw new Error("no insert target registered");
    act(() => append(segment));
  };
  // The other half of that event: `dictation://partial` clears the store's interim BEFORE it
  // appends the committed text (useDictation.ts), so a test that only calls `dictate` has modelled
  // half of a settle. Both halves are needed to see the italic go away.
  const setInterim = (interim: string) => view.rerender(tree({ ...over, interim }));
  return { onSend, onAttach, seen, dictate, setInterim, view };
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const interimNode = () => screen.queryByTestId(CONCIERGE_INTERIM_TESTID);
/** The layer the interim is painted into: absolutely positioned behind the textarea, in the
 *  textarea's own metrics. Being INSIDE this is what "in the prompt bar" means structurally. */
const mirror = () => screen.getByTestId(MENTION_MIRROR_TESTID);
/** The textarea's positioning context — the wrapper ComposeBox's height effect walks. */
const slot = () => mirror().parentElement as HTMLElement;
/** EXACTLY the predicate ComposeBox's layout effect applies when it computes `placeholderH`, the
 *  FLOOR under auto-grow: every child of the slot that is not the textarea and has not opted out.
 *  Re-stated here rather than imported because the point is to pin the DOM shape that walk sees. */
const measuredOverlays = () =>
  Array.from(slot().children).filter(
    (el): el is HTMLElement =>
      el !== box() && el instanceof HTMLElement && !el.hasAttribute(MENTION_MIRROR_SKIP_ATTR),
  );
const italicsIn = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
    (el) => getComputedStyle(el).fontStyle === "italic",
  );

describe("appendDictated", () => {
  it("fills an empty box with the trimmed segment", () => {
    expect(appendDictated("", "  approve the deploy ")).toBe("approve the deploy");
  });

  it("space-separates a follow-on segment", () => {
    expect(appendDictated("approve the deploy", "then ship it")).toBe(
      "approve the deploy then ship it",
    );
  });

  it("never double-spaces after text the user left a trailing space on", () => {
    expect(appendDictated("approve ", "the deploy")).toBe("approve the deploy");
  });

  it("an empty segment leaves the box exactly as it was", () => {
    expect(appendDictated("approve", "   ")).toBe("approve");
  });
});

describe("ComposeBox — dictation lifecycle", () => {
  it("START: registers an insert target while mounted", () => {
    const { seen } = setup();
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe("function");
  });

  it("PARTIAL: the live transcript renders out of the textarea's VALUE and leaves the text alone", () => {
    setup({ interim: "approve the dep" });
    expect(interimNode()?.textContent).toBe("approve the dep");
    expect(box().value).toBe("");
  });

  it("PARTIAL: no interim means no preview at all", () => {
    setup();
    expect(interimNode()).toBeNull();
  });

  it("COMMIT: a finished segment lands in the textarea", () => {
    const { dictate } = setup();
    dictate("approve the deploy");
    expect(box().value).toBe("approve the deploy");
  });

  it("COMMIT: successive segments accumulate, space-separated", () => {
    const { dictate } = setup();
    dictate("approve the deploy");
    dictate("then tell me what broke");
    expect(box().value).toBe("approve the deploy then tell me what broke");
  });

  it("COMMIT: dictated text appends to what the user already typed", () => {
    const { dictate } = setup();
    fireEvent.change(box(), { target: { value: "hey" } });
    dictate("approve it");
    expect(box().value).toBe("hey approve it");
  });

  it("COMMIT: dictated text is editable and sendable exactly like typed text", () => {
    const { dictate, onSend } = setup();
    dictate("approve the deploy");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("approve the deploy");
    expect(box().value).toBe("");
  });

  it("the un-committed preview is NEVER submitted", () => {
    const { onSend } = setup({ interim: "half a phra" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("STOP: unmounting hands the target back (registers null)", () => {
    const { seen, view } = setup();
    view.unmount();
    expect(seen.at(-1)).toBeNull();
  });

  // The box's own mic button is gone — the column's single mic is the header ring, and the box is
  // now a pure dictation SINK: it registers a target and paints what arrives, with no control of
  // its own. Who is allowed to send it speech is decided in useConciergeDictation (see its tests);
  // that the column shows exactly one mic is pinned in ConciergeColumn.oneMic.test.tsx.
  it("without registerInsert the box behaves exactly as the text-only version did", () => {
    const onSend = vi.fn();
    render(<ComposeBox onSend={onSend} onAttach={vi.fn()} />);
    const only = screen.getAllByRole("textbox", { name: "Message" }).at(-1)!;
    fireEvent.change(only, { target: { value: "typed" } });
    fireEvent.keyDown(only, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("typed");
  });
});

// ── WHERE the live transcript is painted ────────────────────────────────────────────────────────
// The founder's bug, in his words: the dictated words were "still showing above the actual text".
// The preview had a strip of its own above the textarea, so one sentence was drawn on two lines and
// each phrase visibly JUMPED down into the box as it committed. What he asked for is one line in
// one place — provisional words italic IN the prompt bar, upright once they settle.
//
// Every assertion here is about PLACEMENT and STYLE, never about the string being present: the
// interim text was already in the document before this change (in the strip), so "the words appear
// somewhere" is exactly the vacuous test this repo keeps producing. Each of these fails against the
// strip.
describe("ComposeBox — the interim is painted IN the prompt bar", () => {
  it("renders inside the composer's own text layer, not in a strip above it", () => {
    setup({ interim: "approve the dep" });
    const node = interimNode();
    expect(node).not.toBeNull();

    // INSIDE the mirror — the layer that sits at inset 0 behind the textarea, in the textarea's
    // exact metrics. Any sibling strip, wherever it sat, fails this.
    expect(mirror().contains(node)).toBe(true);
    // …and the mirror shares the textarea's positioning context, which is what makes "behind the
    // textarea" true rather than "somewhere else in the box".
    expect(slot().contains(box())).toBe(true);
  });

  it("continues the draft on the same line — one space, and the phrase comes LAST", () => {
    setup({ interim: "the deploy" });
    fireEvent.change(box(), { target: { value: "approve" } });

    // One line, read straight off the layer that draws it: the committed words then the live ones.
    expect(mirror().textContent).toBe("approve the deploy");
    // The live half is the TAIL of that line, joined by exactly one space.
    expect(interimNode()?.textContent).toBe(" the deploy");
  });

  it("takes no leading space into an empty box — the first word starts at the margin", () => {
    // Where it lands while provisional must be where it lands once committed, or the settle moves
    // the text sideways. `appendDictated` trims, so the suffix rule has to as well.
    setup({ interim: "approve the dep" });
    expect(interimNode()?.textContent).toBe("approve the dep");
    expect(interimSuffix("", "approve the dep")).toBe(appendDictated("", "approve the dep"));
  });

  it("is ITALIC while provisional", () => {
    setup({ interim: "approve the dep" });
    expect(getComputedStyle(interimNode() as HTMLElement).fontStyle).toBe("italic");
  });

  it("SETTLES upright: the committed words are the textarea's own, and no italic is left", () => {
    const { dictate, setInterim } = setup({ interim: "approve the dep" });
    // Provisional: the only italic in the text layer is the live phrase.
    expect(italicsIn(mirror())).toEqual([interimNode()]);

    // A final segment does both of these, in this order (useDictation's `dictation://partial`).
    setInterim("");
    dictate("approve the deploy");

    expect(box().value).toBe("approve the deploy"); // drawn by the real textarea…
    expect(getComputedStyle(box()).fontStyle).not.toBe("italic"); // …upright…
    expect(interimNode()).toBeNull();
    expect(italicsIn(mirror())).toEqual([]); // …and the provisional copy is gone, not doubled
  });

  it("stands the invitation-to-speak copy down while words are streaming into that slot", () => {
    // Both paint over row one of an empty textarea, so without this they interleave into garbled
    // copy. Composer.tsx gates its own rich placeholder on `!interimActive` for the same reason.
    const { setInterim } = setup();
    expect(screen.queryByTestId("compose-placeholder")).not.toBeNull();

    setInterim("approve the dep");
    expect(screen.queryByTestId("compose-placeholder")).toBeNull();

    setInterim(""); // …and it comes back when the box is quiet and still empty
    expect(screen.queryByTestId("compose-placeholder")).not.toBeNull();
  });

  it("adds NOTHING to the placeholder floor — a partial must not buy a spare line", () => {
    // `placeholderH` is a FLOOR under auto-grow, taken as the tallest child of the slot that is not
    // the textarea and has not opted out — and `composePlaceholderFloorH` adds the textarea's chrome
    // (22px) to whatever it is handed. The mirror already carries that padding, so measuring it
    // THERE would grow the box by about a line per draft. It rides inside the opted-out layer.
    setup({ interim: "approve the deploy and then tell me exactly what broke overnight" });
    const skipped = slot().querySelector<HTMLElement>(`[${MENTION_MIRROR_SKIP_ATTR}]`);

    expect(skipped?.contains(interimNode())).toBe(true);
    for (const el of measuredOverlays()) expect(el.contains(interimNode())).toBe(false);
    expect(measuredOverlays()).not.toContain(interimNode());
  });

  it("but IS measured as content, so the provisional lines are never clipped", () => {
    // The other half, and the one that bit (roborev 57324, High): the textarea's scrollHeight comes
    // off its VALUE, which the interim is deliberately not in, so without measuring the mirror a
    // spoken sentence is worth zero pixels — and the layer painting it is inset 0 with
    // `overflow: hidden`, so everything past line one of what the user is SAYING would be invisible.
    //
    // jsdom has no layout engine (every scrollHeight is 0), so the two heights are stated outright
    // and the assertion is on the height the box actually renders at.
    const { setInterim } = setup();
    const ONE_LINE = 20;
    const FIVE_LINES = 96;
    Object.defineProperty(box(), "scrollHeight", { configurable: true, get: () => ONE_LINE });
    // Records the state the layer was in AT THE MOMENT it was measured. jsdom cannot evaluate the
    // `inset: 0` that stretches this layer to the box, so the only way to see the collapse-first
    // trick — without which scrollHeight can never report LESS than the box already is, and the
    // height ratchets up for the session — is to look at `bottom` from inside the read.
    let bottomWhenMeasured: string | null = null;
    Object.defineProperty(mirror(), "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        bottomWhenMeasured = this.style.bottom;
        return FIVE_LINES;
      },
    });

    setInterim("a phrase long enough to wrap several times over in a narrow column");

    expect(bottomWhenMeasured).toBe("auto");

    // +2 for the borders (composeRenderH), and NO chrome on top: this is a content measurement, so
    // it is compared with the textarea's own scrollHeight like for like.
    expect(box().style.height).toBe(`${FIVE_LINES + 2}px`);

    // …and it comes straight back down to the resting height, rather than ratcheting: the mirror is
    // collapsed before it is measured, exactly as the textarea and the placeholder overlays are.
    // (COMPOSE_MIN_H, not ONE_LINE + 2 — one line of text plus its chrome IS the resting height.)
    setInterim("");
    expect(box().style.height).toBe(`${COMPOSE_MIN_H}px`);
  });

  it("fits the spoken words even in a box the user DRAGGED short, then hands the height back", () => {
    // A dragged height is persisted and `composeRenderH` returns it outright, ignoring the content
    // measurement — so measuring the mirror as ordinary content fixed auto-grow and left anyone who
    // had ever dragged this box short clipped exactly as before, with no scrollbar and no caret to
    // reach the missing words (roborev 57333). Speech is the one content that cannot be scrolled to.
    const DRAGGED = COMPOSE_MIN_H + 20; // ~two lines, chosen by the user
    const TYPED = 20; // the textarea's own value, one line
    const MIRRORED = 96; // that same line PLUS the provisional phrase
    const SPOKEN = MIRRORED - TYPED; // …so this is what the words actually add
    const { setInterim } = setup();
    act(() => useUiStore.getState().setConciergeComposeH(DRAGGED));
    Object.defineProperty(box(), "scrollHeight", { configurable: true, get: () => TYPED });
    Object.defineProperty(mirror(), "scrollHeight", { configurable: true, get: () => MIRRORED });

    setInterim("a phrase long enough to wrap several times over in a narrow column");
    // Grown to exactly what the draft plus the phrase NEEDS — not `DRAGGED + SPOKEN`, which this
    // asserted while the lift was unconditional and which overshoots by however much slack the box
    // already had. Nor the mirror's TOTAL, which would be the typed draft overriding the user's own
    // height (roborev 57354). It is the smallest box that shows both.
    expect(box().style.height).toBe(`${TYPED + 2 + SPOKEN}px`);

    // …and the moment it settles the box is the user's again. The floor lasts as long as the words
    // are un-scrollable, not a moment longer.
    setInterim("");
    expect(box().style.height).toBe(`${DRAGGED}px`);
  });

  it("keeps the live phrase REACHABLE when the draft overflows a box dragged short", () => {
    // roborev 57397. Growing the box is enough only while the textarea does not overflow. When it
    // does, the mirror copies `ta.scrollTop`, whose maximum is the TEXTAREA's `contentH - clientH`
    // — but the mirror needs `mirrorH - clientH` to bring its tail into view, and mirrorH is always
    // contentH + speaking. So every pixel of extra height clamps ta.scrollTop down by the same
    // pixel: the window slides up over the draft and the live phrase stays below it, allocated room
    // it can never occupy. The pre-branch strip always showed those words, so that is a regression.
    //
    // The spacer is the fix: `speaking` extra pixels of BOTTOM PADDING on the textarea, so its
    // scroll range becomes the mirror's and the existing scrollTop copy lines the two up exactly.
    // Padding moves no glyph, so pill alignment (roborev 55574) is untouched.
    const DRAGGED = COMPOSE_MIN_H + 20;
    const TYPED = 150; // a draft TALLER than the box the user dragged — the unguarded case
    const MIRRORED = 190; // …plus two spoken lines
    const { setInterim } = setup();
    act(() => useUiStore.getState().setConciergeComposeH(DRAGGED));
    // PADDING-AWARE, deliberately, and the whole file used to stub a constant here. A real
    // `scrollHeight` COUNTS bottom padding, so a constant getter makes the measurement
    // padding-independent by construction — which is exactly the property the layout effect's reset
    // exists to create, so a constant stub cannot tell whether the reset is there. Modelling it
    // honestly is what makes the reset observable, and without the reset this test does not merely
    // fail: the effect writes state on every pass and React blows the update depth.
    Object.defineProperty(box(), "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        const pad = parseFloat(this.style.paddingBottom || `${COMPOSE_TEXT_PAD_BOTTOM}`);
        return TYPED + pad - COMPOSE_TEXT_PAD_BOTTOM;
      },
    });
    Object.defineProperty(mirror(), "scrollHeight", { configurable: true, get: () => MIRRORED });

    setInterim("two lines of speech on the end of a draft that already overflows");

    // The textarea carries exactly the spoken lines as extra bottom padding, so its scroll range and
    // the mirror's are the same and the tail is reachable rather than merely allocated.
    expect(box().style.paddingBottom).toBe(`${COMPOSE_TEXT_PAD_BOTTOM + (MIRRORED - TYPED)}px`);

    // …and it is given back the moment the phrase settles — the spacer is not a new resting state.
    setInterim("");
    expect(box().style.paddingBottom).toBe(`${COMPOSE_TEXT_PAD_BOTTOM}px`);
  });

  it("puts the mirror's scroll offset back after measuring it", () => {
    // Releasing `bottom` to collapse the layer leaves it with nothing to scroll, so the reflow that
    // `scrollHeight` forces clamps its scrollTop to 0 — and restoring `bottom` re-creates the
    // overflow without restoring the offset. The mirror's own scroll sync is a PASSIVE effect (after
    // paint), so in a long draft every partial would paint one frame with the pill fills snapped to
    // the top of the box while the textarea stayed put: the misalignment MIRRORED_PILL exists to
    // prevent, several times a second while someone speaks (roborev 57333).
    //
    // Asserting the offset AFTER the render would be vacuous: the mirror's sync effect writes
    // `ta.scrollTop` into it on every render anyway, so the value would be right either way. What
    // has to be true is the ORDER inside the one synchronous layout pass — restored immediately
    // after the measurement that clobbered it, not eventually.
    const { setInterim } = setup();
    const layer = mirror();
    const seq: string[] = [];
    let top = 40; // the draft is scrolled, past the ten-line cap
    Object.defineProperty(layer, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        seq.push(`set:${v}`);
        top = v;
      },
    });
    // jsdom does not lay out, so the browser's clamp is modelled: collapsing the layer leaves it
    // nothing to scroll, and the reflow this read forces zeroes the offset.
    Object.defineProperty(layer, "scrollHeight", {
      configurable: true,
      get: () => {
        seq.push("measure");
        top = 0;
        return 96;
      },
    });

    setInterim("still talking");

    expect(seq[seq.indexOf("measure") + 1]).toBe("set:40");
  });

  it("does not announce itself word by word (roborev 48171)", () => {
    // Deepgram replaces this preview per partial; a polite region would hand the screen reader one
    // announcement per word and the queue would never drain. Moving the node must not lose that.
    setup({ interim: "approve the dep" });
    expect(interimNode()?.getAttribute("aria-live")).toBe("off");
  });
});

// The SUFFIX — what gets appended to the draft, not the two joined — because that is what the span
// holds. The rule is stated as a total: draft + suffix is the line the user reads.
describe("interimSuffix", () => {
  it("carries the joining space, so draft + suffix reads as one sentence", () => {
    expect(interimSuffix("approve", "the deploy")).toBe(" the deploy");
    expect("approve" + interimSuffix("approve", "the deploy")).toBe("approve the deploy");
  });

  it("does not double a space the draft already ends with", () => {
    expect(interimSuffix("approve ", "the deploy")).toBe("the deploy");
    expect("approve " + interimSuffix("approve ", "the deploy")).toBe("approve the deploy");
  });

  it("adds nothing in front of the first spoken word", () => {
    expect(interimSuffix("", "approve")).toBe("approve");
  });

  it("is empty when nothing is being spoken", () => {
    expect(interimSuffix("approve", "")).toBe("");
  });
});

// The MIRROR of Composer's surface claim (Composer.dictation.test.tsx, "naming the voice surface").
// Without this side, the arbiter is one-way: once the user's cursor has been in an agent composer,
// only the header ring brings dictation back, so clicking into THIS box and speaking would send
// every segment to a composer in another column while the caret blinks here.
describe("ComposeBox — naming the voice surface", () => {
  const ta = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

  it("the USER focusing it aims dictation at the concierge", () => {
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    fireEvent.focus(ta());
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("TYPING in it aims dictation here too", () => {
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    fireEvent.keyDown(ta(), { key: "a" });
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("TAB-navigating in counts — no pointer or keystroke lands on the box itself", () => {
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => ta().focus());
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("CLICKING a box the app already focused still aims here", () => {
    // The mirror of the agent side's guard: a click on an ALREADY-FOCUSED textarea fires no focus
    // event, so a focus-only claim would leave the mic pointed at the other column while the caret
    // blinks in this one (roborev 54245).
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => focusQuietly(ta()));
    expect(useDictationStore.getState().voiceSurface).toBe("agent"); // the app's focus moved nothing

    fireEvent.pointerDown(ta()); // …and now the user clicks in

    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("requestComposeFocus aims dictation here — the caret the USER asked for", () => {
    // The seam behind the drop pill's "go to compose", a file drop, spawning an agent, and the
    // capture-window handoff. The focus itself is quiet, like every focus the app performs; what
    // makes dictation follow is that the effect NAMES the concierge outright, because reaching it
    // at all means a user gesture asked for this box (roborev 54259).
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => ta().blur());

    act(() => useUiStore.getState().requestComposeFocus());

    expect(document.activeElement).toBe(ta());
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("…and even when the caret is ALREADY here, so no focus event fires at all", () => {
    // The load-bearing half of naming the surface in the effect rather than inferring it from the
    // focus event: dropping files on the terminal, or clicking the drop pill's "go to compose",
    // while the caret is already in this box focuses nothing — .focus() on the focused element
    // dispatches no event (roborev 54265). Without the effect's own claim this silently does
    // nothing, and the words keep going to the other column.
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => ta().focus()); // the caret is already here
    useDictationStore.setState({ voiceSurface: "agent" }); // …and that focus already had its say
    let focusEvents = 0;
    ta().addEventListener("focus", () => { focusEvents += 1; });

    act(() => useUiStore.getState().requestComposeFocus());

    expect(focusEvents).toBe(0); // nothing to infer from
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("PROGRAMMATIC focus does not re-aim it", () => {
    // Symmetrical to the agent side: this box is focused by code too — after a send, and on a
    // handoff from the capture window — and neither is a statement about where speech should go.
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => focusQuietly(ta()));
    expect(useDictationStore.getState().voiceSurface).toBe("agent");
  });
});
