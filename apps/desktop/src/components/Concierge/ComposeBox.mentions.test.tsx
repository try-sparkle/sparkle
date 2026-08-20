// @vitest-environment jsdom
//
// The compose box's half of @-mention routing: typing "@" opens the picker, typing narrows it,
// arrows move, Enter inserts the pill, Escape closes, Backspace at the pill's edge takes the whole
// token, and a submit reports the agents the text addresses.
//
// The rules themselves are data (mentions.test.ts) and the list is presentational
// (MentionPicker.test.tsx). What is pinned HERE is the wiring those two cannot see: the caret, the
// keyboard, and that none of it disturbs the box's hard-won layout behaviour.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import type { MentionAgent } from "./mentions";

afterEach(() => cleanup());

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return {
    projectId: "p1",
    projectName: "web",
    band: "running",
    canAcceptInput: true,
    ...over,
  };
}

const BLUEPRINT = agent({ id: "a1", name: "Blueprint UI/UX" });
const KRAKEN = agent({ id: "a2", name: "Kraken Auth" });

function setup(
  over: {
    onSend?: (text: string, mentions?: unknown) => void | Promise<boolean>;
    mentionAgents?: MentionAgent[];
    preferredAgentId?: string | null;
  } = {},
) {
  const onSend = vi.fn(over.onSend);
  const onAttach = vi.fn();
  const onTextEdit = vi.fn();
  render(
    <ComposeBox
      onSend={onSend}
      onAttach={onAttach}
      onTextEdit={onTextEdit}
      mentionAgents={over.mentionAgents ?? [BLUEPRINT, KRAKEN]}
      preferredAgentId={over.preferredAgentId}
    />,
  );
  return { onSend, onTextEdit };
}

// By LABEL, not by role: with the picker open the textarea correctly reports `role="combobox"`
// rather than `textbox` (the ARIA 1.2 pattern puts the role on the input itself), so a role query
// would find it only half the time. The accessible name is stable across both states.
const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const picker = () => screen.queryByTestId("concierge-mention-picker");
const options = () => screen.queryAllByTestId("concierge-mention-option");

/** Type into the box the way a user does — the value AND the caret, which is half of what decides
 *  whether a mention query is open.
 *
 *  The value goes in through `fireEvent`'s own `target`, never by assigning `node.value` first:
 *  React installs a tracker on that property, so a direct assignment updates the tracked value and
 *  the change event that follows is discarded as a no-op. The caret is then re-asserted on the node,
 *  because React's re-render writes `value` and resets the selection to the end. */
function type(value: string, caret = value.length) {
  const ta = box();
  fireEvent.change(ta, { target: { value, selectionStart: caret, selectionEnd: caret } });
  ta.selectionStart = caret;
  ta.selectionEnd = caret;
  fireEvent.select(ta);
}

/** The ids a bare "@" offers. The CONCIERGE is one of them — `mentionRoster` appends it, so
 *  `@Sparkle` is offered, pilled and resolved on exactly the same terms as a build agent (see that
 *  function's doc for why it belongs in the one roster rather than in a second composer-local one).
 *  Named here so the cases below can talk about the fleet without re-counting it each time. */
const SPARKLE = "sparkle-concierge";
const offeredIds = () => options().map((o) => o.getAttribute("data-agent-id"));

describe("ComposeBox — typing @ opens the picker", () => {
  it("shows the whole fleet on a bare @, plus the concierge", () => {
    setup();
    expect(picker()).toBeNull();
    type("@");
    expect(offeredIds()).toHaveLength(3);
    expect(offeredIds()).toEqual(expect.arrayContaining(["a1", "a2", SPARKLE]));
  });

  it("narrows as the query grows — the founder's '@Bl'", () => {
    setup();
    type("@Bl");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.getAttribute("data-agent-id")).toBe("a1");
  });

  it("opens mid-sentence, not only at the start", () => {
    setup();
    type("tell @Kra");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.getAttribute("data-agent-id")).toBe("a2");
  });

  it("closes itself when the query matches nothing, rather than parking an empty panel", () => {
    setup();
    type("@zzzz");
    expect(picker()).toBeNull();
  });

  it("does not open on an email address", () => {
    setup();
    type("write to me@Kraken");
    expect(picker()).toBeNull();
  });

  // This used to assert the picker did NOT open with an empty fleet. It opens now, with exactly one
  // row, and that is the behaviour rather than a slipped expectation: under a mount plain text goes to
  // the patched terminal and `@Sparkle` is how you reach the concierge, so the concierge has to be the
  // one thing that is always addressable — including on a fresh install with nothing built yet.
  it("offers the concierge alone when the box knows of no build agents", () => {
    setup({ mentionAgents: [] });
    type("@");
    expect(offeredIds()).toEqual([SPARKLE]);
  });

  it("puts the agent already in view at the top of the list", () => {
    setup({ preferredAgentId: "a2" });
    type("@");
    expect(options()[0]!.getAttribute("data-agent-id")).toBe("a2");
  });
});

describe("ComposeBox — keyboard", () => {
  it("arrows move the highlight, wrapping at both ends", () => {
    setup();
    type("@");
    // Read off the list rather than hardcoded, so this stays about the WRAP rather than about how
    // many rows a bare "@" happens to offer (the concierge is one of them — see offeredIds).
    const rows = options().length;
    const highlighted = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(highlighted()).toBe(0);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(highlighted()).toBe(1);
    // Down off the bottom comes back to the top…
    for (let i = 1; i < rows; i += 1) fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(highlighted()).toBe(0);
    // …and up off the top goes to the bottom.
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(highlighted()).toBe(rows - 1);
  });

  it("Enter inserts the highlighted agent as a pill and closes the list", () => {
    setup();
    type("@Bl");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("@Blueprint UI/UX ");
    expect(picker()).toBeNull();
  });

  it("Escape closes the list without touching the text", () => {
    setup();
    type("@Bl");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(picker()).toBeNull();
    expect(box().value).toBe("@Bl");
  });

  // Recorded by ANCHOR, not as a boolean: a dismissal that outlived its own "@" would suppress
  // every later mention in the message.
  it("a later @ gets its own picker after an Escape", () => {
    setup();
    type("@Bl");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(picker()).toBeNull();
    type("@Bl and @Kra");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.getAttribute("data-agent-id")).toBe("a2");
  });

  // Someone who has written a whole message and hits ⌘↩ with a half-typed "@Bl" on the end meant to
  // SEND. The picker never claims a modified Enter.
  it("⌘Enter still sends while the picker is open", () => {
    const { onSend } = setup();
    type("ship it @Bl");
    expect(picker()).not.toBeNull();
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toBe("ship it @Bl");
  });

  it("plain Enter still writes a newline when NO picker is open", () => {
    const { onSend } = setup();
    type("line one");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("ComposeBox — Backspace takes the whole pill", () => {
  it("removes the entire mention from the trailing space", () => {
    setup();
    type("@Blueprint UI/UX ");
    fireEvent.keyDown(box(), { key: "Backspace" });
    expect(box().value).toBe("");
  });

  it("leaves the rest of the message alone", () => {
    setup();
    type("tell @Kraken Auth to ship", 18);
    fireEvent.keyDown(box(), { key: "Backspace" });
    expect(box().value).toBe("tell to ship");
  });

  // Half a name is not a mention under the derive-from-text rule, so eating one character would
  // silently drop the aim while the box still LOOKS addressed.
  it("never leaves half a name behind", () => {
    setup();
    type("@Kraken Auth");
    fireEvent.keyDown(box(), { key: "Backspace" });
    expect(box().value).not.toBe("@Kraken Aut");
    expect(box().value).toBe("");
  });

  it("declines in ordinary text, so normal Backspace still works", () => {
    const { onTextEdit } = setup();
    type("plain words");
    onTextEdit.mockClear();
    fireEvent.keyDown(box(), { key: "Backspace" });
    // Not intercepted: the box reported no programmatic edit, leaving the textarea to do its own.
    expect(onTextEdit).not.toHaveBeenCalled();
  });

  // With a selection, Backspace means "delete what I highlighted". Widening that to a neighbouring
  // mention would destroy text the user never selected.
  it("declines when there is a selection", () => {
    const { onTextEdit } = setup();
    type("@Kraken Auth ");
    const ta = box();
    ta.selectionStart = 2;
    ta.selectionEnd = 6;
    onTextEdit.mockClear();
    fireEvent.keyDown(ta, { key: "Backspace" });
    expect(onTextEdit).not.toHaveBeenCalled();
  });
});

describe("ComposeBox — what a send reports", () => {
  it("reports the addressed agent alongside the text", () => {
    const { onSend } = setup();
    type("@Kraken Auth ship it");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("@Kraken Auth ship it", [
      { agentId: "a2", name: "Kraken Auth" },
    ]);
  });

  // `undefined`, not `[]` — the mentions ride onto the persisted thread message, and an empty array
  // per message is a distinction the thread never draws. Same call this box has always made for an
  // unaddressed send, so nothing downstream has to learn a new shape.
  it("reports NO second argument when the message addresses nobody", () => {
    const { onSend } = setup();
    type("just ship it");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("just ship it");
  });

  it("carries the mention through an Enter-picked pill", () => {
    const { onSend } = setup();
    type("@Kra");
    fireEvent.keyDown(box(), { key: "Enter" });
    type(`${box().value}move it 5px`);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend.mock.calls[0]![1]).toEqual([{ agentId: "a2", name: "Kraken Auth" }]);
  });

  it("clears the box and the picker state on send", () => {
    setup();
    type("@Bl");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(box().value).toBe("");
    expect(picker()).toBeNull();
  });
});

// roborev 54557. Picking the SECOND of two same-named rows used to insert a bare "@Docs", which
// re-resolved to the FIRST agent — a silent wrong-agent aim, drawn as the identical pill either way.
// The composer runs `mentionRoster` on whatever it is handed (roborev 54555: the ordering contract
// must not be a comment naming someone else), which both orders and disambiguates, so the address
// the user picks is the address that gets sent.
describe("ComposeBox — two agents with the same name", () => {
  const WEB = agent({ id: "d1", name: "Docs", projectName: "web" });
  const MOBILE = agent({ id: "d2", name: "Docs", projectName: "mobile" });

  it("offers them as two distinguishable addresses", () => {
    setup({ mentionAgents: [WEB, MOBILE] });
    type("@Docs");
    expect(options()).toHaveLength(2);
    const labels = options().map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("@Docs (web)"))).toBe(true);
    expect(labels.some((l) => l?.includes("@Docs (mobile)"))).toBe(true);
  });

  it("sends to the row that was actually picked, not to the first one", () => {
    const { onSend } = setup({ mentionAgents: [WEB, MOBILE] });
    type("@Docs");
    // Take the SECOND row — the case that used to aim at the first.
    const second = options()[1]!;
    const pickedId = second.getAttribute("data-agent-id")!;
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    type(`${box().value}ship it`);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend.mock.calls[0]![1]).toEqual([
      { agentId: pickedId, name: expect.stringContaining("Docs (") },
    ]);
  });

  // A bare "@Docs" does not name an agent when two answer to it, so it aims at nobody and the
  // message falls through to the auto-router — the recoverable direction.
  it("carries NO mention for a bare ambiguous name typed by hand", () => {
    const { onSend } = setup({ mentionAgents: [WEB, MOBILE] });
    type("@Docs ship it");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("@Docs ship it");
  });
});

describe("ComposeBox — the picker's assistive wiring", () => {
  it("names the open list from the textarea, and stops naming it when closed", () => {
    setup();
    expect(box().getAttribute("aria-expanded")).toBeNull();
    type("@Bl");
    expect(box().getAttribute("role")).toBe("combobox");
    expect(box().getAttribute("aria-expanded")).toBe("true");
    expect(box().getAttribute("aria-controls")).toBe(options()[0]!.parentElement!.id);
    // The highlighted row is announced by id, since focus never leaves the textarea.
    expect(box().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box().getAttribute("role")).toBeNull();
    expect(box().getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("ComposeBox — mentions do not disturb what this box already does", () => {
  // Dictation appends at the END; the caret has to follow, or the query reads a stale slice of a
  // string that has since grown and a picker pops open over words nobody typed an "@" into.
  it("a dictated segment does not open a picker", () => {
    let append: ((t: string) => void) | null = null;
    render(
      <ComposeBox
        onSend={vi.fn()}
        onAttach={vi.fn()}
        mentionAgents={[BLUEPRINT, KRAKEN]}
        registerInsert={(fn) => {
          append = fn;
        }}
      />,
    );
    const ta = screen.getAllByRole("textbox", { name: "Message" })[0] as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "@Bl", selectionStart: 3, selectionEnd: 3 } });
    fireEvent.keyDown(ta, { key: "Escape" });
    append!("and then some");
    expect(screen.queryAllByTestId("concierge-mention-picker")).toHaveLength(0);
  });

  // The picker hangs off the ROOT, outside the wrapper whose non-textarea children the height
  // engine measures as placeholder overlays. Inside it, an open list would drive the compose box to
  // the height of its own rows on every keystroke.
  it("does not render inside the textarea's overlay wrapper", () => {
    setup();
    type("@");
    const overlayWrapper = box().parentElement!;
    expect(overlayWrapper.contains(picker())).toBe(false);
  });
});

// ══ WHAT MAY BE CHOSEN, NOW THAT DELIVERABILITY AND CHOOSABILITY ARE DIFFERENT QUESTIONS ════════
//
// They were one question until beads joined the roster (bead sparkle-1cpomd). `chooseMention` read
// `!agent.canAcceptInput` and refused — which is right for a cloud agent (nothing can be sent to it,
// so writing an address for it would be a lie) and WRONG for a bead, which carries the same
// `canAcceptInput: false` honestly and is nonetheless entirely pickable: choosing it writes a
// REFERENCE, not an address.
//
// Both directions are pinned here, in one describe, because either alone is half the evidence. The
// bead-side row lives in ConciergeHost.beadMentions.test.tsx, where a real roster carries a real
// bead; this file owns the agent-side refusal, which had no test at all.
describe("ComposeBox — an agent that cannot take a message cannot be chosen", () => {
  const CLOUD = agent({ id: "c1", name: "Cloud Runner", canAcceptInput: false });

  it("refuses Enter on an undeliverable agent, leaving the query exactly as typed", () => {
    setup({ mentionAgents: [CLOUD] });
    type("@Cloud");
    // The row IS offered — "no such agent" and "that one is a cloud agent" are different answers,
    // and hiding it would collapse them (see mentions.orderMentionAgents).
    expect(offeredIds()).toContain("c1");
    fireEvent.keyDown(box(), { key: "Enter" });
    // Nothing was inserted: no completed literal, no trailing space, and the picker is still up.
    expect(box().value).toBe("@Cloud");
    expect(picker()).toBeTruthy();
  });

  it("refuses the MOUSE on it too, so the two paths cannot disagree", () => {
    setup({ mentionAgents: [CLOUD] });
    type("@Cloud");
    const row = options().find((o) => o.getAttribute("data-agent-id") === "c1");
    fireEvent.mouseDown(row!);
    expect(box().value).toBe("@Cloud");
  });

  // The PAIRED half — a deliverable agent in the same shape of test really does get inserted, so
  // the two rows above cannot be satisfied by a composer that stopped choosing anything at all.
  it("still chooses a deliverable agent, terminated by a space", () => {
    setup({ mentionAgents: [CLOUD, KRAKEN] });
    type("@Kraken");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("@Kraken Auth ");
  });
});
