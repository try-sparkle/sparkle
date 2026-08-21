// @vitest-environment jsdom
//
// "WRITE A POST" — the founder's ask on bead sparkle-131ms.10, 2026-08-20: *"the ability to post
// socially from Sparkle. So I had request to have the ability next to the screenshot button. To
// create a post that would post out socially."*
//
// THE SUBJECT IS THE LIVE BOX. `components/Composer` also has a screenshot button and would be the
// obvious place to read that ask literally — but nothing mounts it (`Composer.unreachable.test.ts`
// asserts that mechanically), so a button added there would be a feature no user can reach and a
// suite that looks like coverage. The screenshot button the founder presses is
// `AttachControl`'s, in this box.
//
// WHAT EACH CASE BELOW IS GUARDING AGAINST, since "a button exists" would satisfy none of them:
//   • PLACEMENT is the ask, so the assertion is the button's actual DOM RELATIONSHIP to the
//     screenshot button — same parent, adjacent — not "a button is somewhere on screen".
//   • The click's OUTPUT: the textarea's value changes. Not "a handler prop was passed".
//   • The click must NOT send. Publishing is gated behind the concierge approval card (bead
//     sparkle-131ms.6) and nothing here may pre-approve or bypass it, so `onSend` never firing is
//     as much the feature as the seeding is.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { COMPOSE_POST_HINT, COMPOSE_POST_LABEL, COMPOSE_POST_PROMPT } from "./composePost";
import { CHROME_HINTS } from "../../keyboardHints/hintTargets";

afterEach(() => cleanup());

function setup(over: { onSend?: ReturnType<typeof vi.fn>; onAttach?: ReturnType<typeof vi.fn> } = {}) {
  const onSend = over.onSend ?? vi.fn();
  const onAttach = over.onAttach ?? vi.fn();
  render(<ComposeBox onSend={onSend} onAttach={onAttach} />);
  return { onSend, onAttach };
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const postButton = () => screen.getByRole("button", { name: COMPOSE_POST_LABEL }) as HTMLButtonElement;
const shotButton = () => screen.getByRole("button", { name: "Screenshot" }) as HTMLButtonElement;

/** Type into the real textarea, so a draft exists the way a user's does. */
function type(value: string) {
  fireEvent.change(box(), { target: { value } });
}

describe("the post button sits in the screenshot button's own cluster", () => {
  it("shares ONE parent with the screenshot button — that adjacency IS the ask", () => {
    setup();
    // The relationship, not the mere existence. A button rendered anywhere else in the toolbar (or
    // in a cluster of its own beside it) passes "a button exists" and fails the founder's
    // sentence, which is specifically *next to the screenshot button*.
    expect(postButton().parentElement).toBe(shotButton().parentElement);
    expect(postButton().parentElement).toBe(screen.getByTestId("concierge-attach"));
  });

  it("is the LAST control in that cluster, so neither attach button moved under the founder's hand", () => {
    setup();
    const cluster = Array.from(
      screen.getByTestId("concierge-attach").querySelectorAll("button"),
    ) as HTMLButtonElement[];
    expect(cluster.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Screenshot",
      "Upload",
      COMPOSE_POST_LABEL,
    ]);
  });

  it("is built like the buttons beside it — same padding, same border, same wordless glyph", () => {
    setup();
    // Not decoration: a third visual idiom in this row would read as a different KIND of control.
    // Inline styles, so jsdom's missing layout engine is not in the way (cf. the narrow-row suite).
    expect(postButton().style.padding).toBe(shotButton().style.padding);
    expect(postButton().style.border).toBe(shotButton().style.border);
    expect(postButton().style.borderRadius).toBe(shotButton().style.borderRadius);
    expect(postButton().style.background).toBe(shotButton().style.background);
    // Wordless and named, exactly like its neighbours — the pointer tooltip and the accessible name
    // are the same string, so hover and focus are told the same thing.
    expect(postButton().textContent).toBe("");
    expect(postButton().getAttribute("title")).toBe(COMPOSE_POST_LABEL);
    expect(postButton().querySelector("svg")).toBeTruthy();
  });

  it("carries a leaf keyboard hint that is registered and collides with nothing", () => {
    setup();
    // HintOverlay finds targets by scanning for [data-hint] and labels them from CHROME_HINTS, so
    // an unregistered id renders a badge-less control the keyboard cannot reach.
    expect(postButton().getAttribute("data-hint")).toBe(COMPOSE_POST_HINT);
    expect(CHROME_HINTS[COMPOSE_POST_HINT]).toBe("w");
    const letters = Object.values(CHROME_HINTS);
    expect(new Set(letters).size).toBe(letters.length);
  });

  it("matches the screenshot button's disabled handling — which is to have none", () => {
    setup();
    // The paired assertion, and the honest one. This cluster's buttons take no `disabled` prop at
    // any width or state; asserting the new button is "never disabled" in isolation would pass for
    // a button wired to a state that does not exist. What is pinned is PARITY with its neighbour,
    // so the day Screenshot grows a disabled state this goes red and forces the same for this one.
    expect(postButton().disabled).toBe(shotButton().disabled);
    expect(postButton().hasAttribute("disabled")).toBe(shotButton().hasAttribute("disabled"));
  });
});

describe("clicking it seeds the compose prompt — and does nothing else", () => {
  it("puts the compose prompt in the box", () => {
    setup();
    expect(box().value).toBe("");
    fireEvent.click(postButton());
    // THE SIDE EFFECT: the textarea a user is looking at now holds the prompt.
    expect(box().value).toBe(COMPOSE_POST_PROMPT);
  });

  it("NEVER SENDS — the user still reads and edits before anything reaches the model", () => {
    const { onSend } = setup();
    fireEvent.click(postButton());
    expect(onSend).not.toHaveBeenCalled();
    // …and the seeded text is still sitting in the box, i.e. nothing consumed and cleared it. A
    // submit empties this box, so a non-empty value after the click is positive evidence that no
    // send path ran, not merely that this one spy went uncalled.
    expect(box().value).toBe(COMPOSE_POST_PROMPT);
  });

  it("touches no attach path either — it is not a fourth way to attach something", () => {
    const { onAttach } = setup();
    fireEvent.click(postButton());
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("PRESERVES a draft in progress — a mis-click beside Screenshot must not destroy typing", () => {
    setup();
    type("half a thought");
    fireEvent.click(postButton());
    expect(box().value).toBe(`half a thought\n${COMPOSE_POST_PROMPT}`);
  });

  it("still seeds on a second press, appending rather than silently doing nothing", () => {
    setup();
    fireEvent.click(postButton());
    fireEvent.click(postButton());
    expect(box().value).toBe(`${COMPOSE_POST_PROMPT}\n${COMPOSE_POST_PROMPT}`);
  });

  it("reports the click as an EDIT, so a running auto-send countdown pauses", () => {
    // The programmatic write fires no `onChange`, so without this report the host never learns the
    // box changed — and the countdown would send whatever was in it while the user is still
    // reading the prompt this button just put there.
    const onComposeInteraction = vi.fn();
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} onComposeInteraction={onComposeInteraction} />);
    expect(onComposeInteraction).not.toHaveBeenCalled(); // mounting is not a gesture
    fireEvent.click(postButton());
    expect(onComposeInteraction.mock.calls.map((c) => c[0])).toContain("edit");
  });

  it("reports the new text to the host, so its routing latches retire like they do for typing", () => {
    const onTextEdit = vi.fn();
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} onTextEdit={onTextEdit} />);
    fireEvent.click(postButton());
    expect(onTextEdit).toHaveBeenCalledWith(COMPOSE_POST_PROMPT);
  });
});

describe("the copy names no destination", () => {
  it("says what the button DOES, never where a post would land", () => {
    // "post out socially" is not yet pinned to a destination — the configured destination MCP today
    // (this epic) versus real networks (bead sparkle-131ms.9, an explicit v2). A label naming a
    // network Sparkle cannot reach would be a lie in the UI, and this repo treats copy as code.
    // Asserted over the CONSTANTS, which is what the button and its tooltip both render.
    for (const copy of [COMPOSE_POST_LABEL, COMPOSE_POST_PROMPT]) {
      expect(copy).not.toMatch(/\b(X|Twitter|LinkedIn|Threads|Bluesky|Mastodon|Facebook|Instagram)\b/i);
    }
    expect(COMPOSE_POST_LABEL).toBe("Write a post");
  });
});
