// @vitest-environment jsdom
//
// `onMentionComposing` — the compose box's half of the countdown pause (bead sparkle-14dtu).
//
// THE FOUNDER'S REPORT: "when I'm in speak mode and I start to type the name of an agent with the at
// sign, I want the countdown timer to pause as I'm typing the name of the agent. Right now, it
// doesn't pause until I finish typing the name of the agent, and it often sends before I'm done."
//
// The reducer's pause is proven in voice/autoSendTimer.test.ts and the hook's wiring in
// voice/useAutoSend.test.ts. Neither of them can see the fact this file owns, and it is the one the
// report actually turns on: WHEN the box starts saying yes. The answer has to be the `@` keystroke
// itself — before a name exists, before anything resolves to an agent, and whether or not the picker
// is showing — because by the time a mention has RESOLVED the send has already gone.
//
// It is a separate file from ComposeBox.mentions.test.tsx on purpose: that one is about the picker,
// and the whole point here is that this signal is NOT the picker's `open` flag (Escape closes the
// list; the pause must survive it). Sitting them in one file invites the next reader to collapse the
// two back together.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import type { MentionAgent } from "./mentions";

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return { projectId: "p1", projectName: "web", band: "running", canAcceptInput: true, ...over };
}

const KRAKEN = agent({ id: "a2", name: "Kraken Auth" });

function setup() {
  const onMentionComposing = vi.fn();
  render(
    <ComposeBox
      onSend={vi.fn()}
      onAttach={vi.fn()}
      mentionAgents={[agent({ id: "a1", name: "Blueprint UI/UX" }), KRAKEN]}
      onMentionComposing={onMentionComposing}
    />,
  );
  return { onMentionComposing };
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

/** Type the way a user does — value AND caret, since the caret is half of what decides whether a
 *  mention is open. Lifted from ComposeBox.mentions.test.tsx; see that file for why the value goes
 *  in through `fireEvent`'s `target` rather than by assigning `node.value` first. */
function type(value: string, caret = value.length) {
  const ta = box();
  fireEvent.change(ta, { target: { value, selectionStart: caret, selectionEnd: caret } });
  ta.selectionStart = caret;
  ta.selectionEnd = caret;
  fireEvent.select(ta);
}

/** What the box last told the host. `undefined` when it has said nothing at all. */
function last(spy: ReturnType<typeof vi.fn>): boolean | undefined {
  return spy.mock.calls.at(-1)?.[0] as boolean | undefined;
}

describe("the pause starts at the @ ITSELF, not at a resolved name", () => {
  it("A BARE @ WITH NOTHING AFTER IT REPORTS true — the whole report, in one row", () => {
    // THE FAILING ROW before the fix: nothing reported this at all, so the countdown ran on
    // through the name. A signal keyed on a RESOLVED mention would still be false here — one
    // character in, with no name to resolve.
    const { onMentionComposing } = setup();
    expect(last(onMentionComposing)).toBe(false); // mounted idle, and it says so
    type("@");
    expect(last(onMentionComposing)).toBe(true);
  });

  it("stays true through every intermediate spelling of the name", () => {
    const { onMentionComposing } = setup();
    for (const q of ["@", "@K", "@Kr", "@Krak", "@Kraken", "@Kraken ", "@Kraken Aut"]) {
      type(q);
      expect(last(onMentionComposing), `mid-name at "${q}"`).toBe(true);
    }
  });

  it("stays true when the query matches NOTHING — that is what mid-name means", () => {
    // `@zzz` closes the picker (no rows to show). The user is still writing a name, so the
    // countdown must still be held: this is the case that proves the signal is not the picker's.
    const { onMentionComposing } = setup();
    type("@zzz");
    expect(screen.queryByTestId("concierge-mention-picker")).toBeNull();
    expect(last(onMentionComposing)).toBe(true);
  });

  it("stays true after ESCAPE dismisses the picker", () => {
    // Escape closes the LIST. It does not finish the address, and it does not put the words in the
    // box that the send would carry — so resuming there would send the half-typed name he is
    // looking at. Err toward staying paused.
    const { onMentionComposing } = setup();
    type("@Krak");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByTestId("concierge-mention-picker")).toBeNull();
    expect(last(onMentionComposing)).toBe(true);
  });
});

describe("…and every way back out of it, so the composer cannot wedge", () => {
  it("a COMPLETED mention releases it — name plus the space the pick leaves behind", () => {
    const { onMentionComposing } = setup();
    type("@Kraken Auth");
    expect(last(onMentionComposing)).toBe(true);
    type("@Kraken Auth ");
    expect(last(onMentionComposing)).toBe(false);
  });

  it("CHOOSING from the picker releases it — the one-gesture path", () => {
    // The founder's own flow ("if I press enter it shows me the agent as a pill"). `insertMention`
    // leaves `@Kraken Auth ` with the caret after the space, which is a finished address.
    const { onMentionComposing } = setup();
    type("@Krak");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("@Kraken Auth ");
    expect(last(onMentionComposing)).toBe(false);
  });

  it("DELETING the @ releases it — the case that would wedge the composer silently", () => {
    const { onMentionComposing } = setup();
    type("ship it @");
    expect(last(onMentionComposing)).toBe(true);
    type("ship it ");
    expect(last(onMentionComposing)).toBe(false);
  });

  it("MOVING THE CARET off the mention releases it", () => {
    // Same string, different caret: an `@` the user has walked away from is not one they are
    // writing. This is why the host cannot derive the signal from the text alone.
    const { onMentionComposing } = setup();
    type("@Krak done");
    expect(last(onMentionComposing)).toBe(true); // caret at the end, still inside the query
    type("@Krak done", 0); // caret back at the head, before the sigil
    expect(last(onMentionComposing)).toBe(false);
  });

  it("an @ the user never finishes releases at MAX_MENTION_QUERY, not never", () => {
    // The last resort, and the reason "paused forever" is not reachable: keep typing past the query
    // bound and `mentionQuery` gives up on the `@` entirely. No name, no space, no deletion — and
    // the countdown still comes back.
    const { onMentionComposing } = setup();
    type("@");
    expect(last(onMentionComposing)).toBe(true);
    type(`@${"x".repeat(60)}`);
    expect(last(onMentionComposing)).toBe(false);
  });

  it("an ordinary sentence with no @ never reports true at all — the control row", () => {
    const { onMentionComposing } = setup();
    type("deploy the staging branch");
    expect(onMentionComposing.mock.calls.every(([v]) => v === false)).toBe(true);
  });

  it("an email address does not pause the countdown", () => {
    // `foo@bar` is not a mention (the sigil must start a token), and a paste of one mid-draft must
    // not silently hold a send.
    const { onMentionComposing } = setup();
    type("mail me at drodio@example.com");
    expect(last(onMentionComposing)).toBe(false);
  });
});
