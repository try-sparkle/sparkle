// @vitest-environment jsdom
//
// THE FONT IS THE ROUTING INDICATOR.
//
// The founder: *"When I'm talking to a terminal view in a mounted concierge, I want the font style to
// change, to be the same font style as it is in the terminal. When the concierge is mounted. And I'm
// interacting with that agent."* The point is that he can see where his words are going without
// reading a label — so the swap has to track the ROUTE, not merely the mount.
//
// ══ HOW THESE ROWS AVOID BEING VACUOUS ══════════════════════════════════════════════════════════
// The easy vacuous version asserts `fontFamily` equals the constant it was set from — true of any
// build that hardcodes it, including one where the terminal uses something else entirely. So:
//
//   • every row is a PAIR — the same box, mounted and not, or the same draft with and without the
//     address — and the assertion is that the two DIFFER in the expected direction;
//   • the "unmounted" side asserts the terminal face is ABSENT, which is what fails against a build
//     that applied it unconditionally;
//   • and one row reads the constant xterm itself is constructed with, so a change to the terminal's
//     face that forgot the composer is red here rather than merely visible.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { MENTION_MIRROR_TESTID } from "./MentionMirror";
import { TERM_BODY_BASE_SIZE, TERM_BODY_FONT } from "../terminalChrome";
import { SPARKLE_MENTION_NAME, type MentionAgent } from "./mentions";

afterEach(cleanup);

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return { projectId: "p1", projectName: "web", band: "running", canAcceptInput: true, ...over };
}
const BLUEPRINT = agent({ id: "a1", name: "Blueprint UI/UX" });
const KRAKEN = agent({ id: "a2", name: "Kraken Auth" });

function setup(mountedAgentId: string | null) {
  render(
    <ComposeBox
      onSend={vi.fn()}
      onAttach={vi.fn()}
      mentionAgents={[BLUEPRINT, KRAKEN]}
      mountedAgentId={mountedAgentId}
    />,
  );
  const ta = screen.getByLabelText("Message") as HTMLTextAreaElement;
  return {
    ta,
    type: (value: string) =>
      fireEvent.change(ta, {
        target: { value, selectionStart: value.length, selectionEnd: value.length },
      }),
  };
}

/** jsdom normalises the inline `font-family` string (quoting, spacing), so compare on the first
 *  family name rather than the whole stack — the question is WHICH FACE, not how it was serialised. */
const HEAD_FAMILY = TERM_BODY_FONT.split(",")[0]!.replace(/["']/g, "").trim();
const isTerminalFace = (el: HTMLElement) => el.style.fontFamily.includes(HEAD_FAMILY);

describe("ComposeBox — the draft is set in the terminal's face while it is bound for one", () => {
  // THE PAIR. Same empty box, mount on and off. A build that never applies the face fails the first
  // half; a build that applies it always fails the second.
  it("uses the terminal face when mounted, and the app face when not", () => {
    const mounted = setup("a1");
    expect(isTerminalFace(mounted.ta)).toBe(true);
    cleanup();

    const floating = setup(null);
    expect(isTerminalFace(floating.ta)).toBe(false);
    // …and specifically the app's own inherited face, which is what it was before this feature.
    expect(floating.ta.style.fontFamily).toBe("inherit");
  });

  // ══ THE ESCAPE HATCH IS VISIBLE BEFORE ENTER IS PRESSED ═════════════════════════════════════════
  // This is the row that justifies deriving the indicator from `classifyComposerRoute` rather than
  // from `mountedAgentId` alone. A cheaper indicator would stay in the terminal face here and tell
  // the founder his words were going to a PTY while they were on their way to the concierge.
  it("reverts to the app face when a leading @Sparkle takes the message back", () => {
    const { ta, type } = setup("a1");
    type("what is the status");
    expect(isTerminalFace(ta)).toBe(true);
    type(`@${SPARKLE_MENTION_NAME} what is the status`);
    expect(isTerminalFace(ta)).toBe(false);
  });

  // …and the other half of the same distinction: a Sparkle that is the SUBJECT of the sentence is
  // still a message for the terminal, so the face must not flip. A build that treated any @Sparkle as
  // a redirect passes the row above and fails this one.
  it("stays in the terminal face for a mid-sentence Sparkle", () => {
    const { ta, type } = setup("a1");
    type(`land this and then ask @${SPARKLE_MENTION_NAME} to review it`);
    expect(isTerminalFace(ta)).toBe(true);
  });

  // An address to ANOTHER agent is still terminal-bound, so the face stays — and unmounted, where an
  // address is the only thing that could aim at a terminal, it is what turns the face on.
  it("uses the terminal face for an addressed message with no mount at all", () => {
    const { ta, type } = setup(null);
    expect(isTerminalFace(ta)).toBe(false);
    type("@Kraken Auth ship the DMG");
    expect(isTerminalFace(ta)).toBe(true);
  });

  // A name that resolves to nobody never becomes a mention, so it aims nowhere and the face stays put.
  it("ignores a name that matches no agent", () => {
    const { ta, type } = setup(null);
    type("@Nobody At All ship it");
    expect(isTerminalFace(ta)).toBe(false);
  });
});

describe("ComposeBox — the face it borrows is the terminal's own", () => {
  // NOT a restatement of the constant: this is the coupling. `TERM_BODY_FONT` is the literal xterm is
  // constructed with (components/Terminal), so retuning the terminal's face and forgetting the
  // composer turns this red instead of merely looking wrong.
  it("takes the family and base size from the same constants xterm is built with", () => {
    const { ta } = setup("a1");
    expect(ta.style.fontFamily).toContain(HEAD_FAMILY);
    expect(ta.style.fontSize).toBe(`${TERM_BODY_BASE_SIZE}px`);
  });

  // ══ THE MIRROR MOVES WITH THE TEXT ══════════════════════════════════════════════════════════════
  // The mention mirror paints pill fills BEHIND the real glyphs. A font swap that reached the textarea
  // and not the mirror slides every fill off the word it belongs to — and it fails silently, because a
  // misaligned pill still renders. Both take one metrics object; this is what proves it.
  it("swaps the mention mirror to the same face, so the pills stay on their words", () => {
    const { type } = setup("a1");
    type("check what @Kraken Auth did");
    const mirror = screen.getByTestId(MENTION_MIRROR_TESTID) as HTMLElement;
    expect(isTerminalFace(mirror)).toBe(true);
    expect(mirror.style.fontSize).toBe(`${TERM_BODY_BASE_SIZE}px`);
  });

  it("keeps the mirror on the app face when the box is not aimed at a terminal", () => {
    const { type } = setup(null);
    type("check what @Kraken Auth did");
    const mirror = screen.getByTestId(MENTION_MIRROR_TESTID) as HTMLElement;
    expect(isTerminalFace(mirror)).toBe(false);
  });

  // "Closely enough that it reads as the same typeface" includes the weight: xterm's default is
  // `normal`, and this box sits inside the app's UI cascade, which is free to set something heavier.
  it("states the weight rather than inheriting whatever the column is set in", () => {
    const { ta } = setup("a1");
    expect(ta.style.fontWeight).toBe("400");
  });
});
