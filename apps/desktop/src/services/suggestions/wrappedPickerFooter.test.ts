// sparkle-99o9a — A PICKER THE READER CAN SEE AND THE PARSER CANNOT.
//
// THE INCIDENT. Four times in one evening, across three agents, a menu was plainly rendered in the
// pane and `read_agent_terminal` returned its full text, while `read_picker_options` on the SAME
// agent returned `{options: [], present: false, fingerprint: ""}`. On one of them
// `send_to_agent_terminal` also refused `alternate-screen`, so the concierge had ZERO ways to
// answer and a human had to click into the pane.
//
// NOT A TIER GAP — that hypothesis was measured and refuted. Probing all four agents live,
// `read_agent_terminal` answered `source: "scrollback", freshness: "live"`: tier (a) HIT, the panes
// were mounted, and both ops were reading THE SAME STRING. The variable is WIDTH.
//
// Claude Code's footer — "Enter to select · Tab/Arrow keys to navigate · Esc to cancel" — is 59
// characters. In a narrow agent column it lands on two rows, and `PICKER_FOOTER` is anchored to ONE
// rendered line (`FOOTER_BAR` is `^…$` under `m`; `FOOTER_LEGACY`'s `.` cannot cross a newline). No
// footer means `parsePickerOptionsWithBounds` returns early and never looks at the option rows at
// all — so a five-option menu detects as nothing.
//
// TWO MECHANISMS PRODUCE THAT SPLIT, and the fix must survive both, which is why the fixtures below
// are captured rather than invented:
//
//   • THE TERMINAL wrapped it. Agent `37ae3c88…` was rendering into a 13-column grid: 37 of its 38
//     rows were exactly 13 characters and the breaks fall MID-WORD ("Enter to sele" / "ct · Tab/
//     Arro" / "w keys to nav"). Ink word-wraps and would never do that. Those rows carry
//     `IBufferLine.isWrapped`, and `serializeScrollback` drops that flag on the floor.
//   • INK wrapped it. At 35 columns the same footer breaks after "…keys to", exactly at the width
//     AND at a word boundary, so the two mechanisms are indistinguishable from that line alone. If
//     Ink emitted the newline itself there is no `isWrapped` to consult and rejoining the buffer
//     cannot help.
//
// So the parser must recognise a footer whose hint bar is split across adjacent lines, and the
// buffer readers must stop splitting logical lines in the first place. This suite pins both.
//
// WHAT WOULD MAKE THIS VACUOUS: a fixture that is not a real picker. The wide-pane control below
// exists for exactly that reason — it runs the SAME menu through the SAME detector with only the
// width changed, and it passes today. If the control ever goes red the fixture is wrong, not the
// detector.

import { describe, expect, it, vi } from "vitest";
import { detectClaudeCodePicker, detectTerminalPrompts, PICKER_FOOTER } from "./heuristics";
import { serializeScrollback, type ScrollbackBuffer } from "../terminalScrollback";
import { pickerFingerprint } from "../pickerFingerprint";

// `serializeScrollback` stays REAL — it is half of what is under test. Only the ambient lookup
// `pickerFingerprint` performs is redirected, so the fingerprint is computed over text this suite
// produced through the production reader.
vi.mock("../terminalScrollback", async (orig) => ({
  ...(await orig<typeof import("../terminalScrollback")>()),
  getAgentScrollback: vi.fn<(id: string) => string | null>(() => null),
}));
import { getAgentScrollback } from "../terminalScrollback";
const scrollbackMock = vi.mocked(getAgentScrollback);

/** The menu agent `5e9e64d9…` was showing, as LOGICAL lines — captured verbatim from the running
 *  app via `scripts/concierge-probe.mjs --op read_agent_terminal`, with the rendered wrapping
 *  undone so each width below can re-apply its own. */
const MENU_LOGICAL = [
  "  A --force-with-lease would rewrite a third party's branch history. Given you just pulled #45",
  "  to avoid clobbering someone else's reviewed branch, how do you want to handle this one?",
  "",
  "❯ 1. Push to our fork instead",
  "     Push the rebased branch to drodio/tkmx-client under the same name.",
  "  2. Force-push to erans' fork",
  "     Proceed as originally instructed. This rewrites 8 commits on Eran's branch.",
  "  3. Hold — just show me the diff",
  "     Push nothing. I report the resolution and leave the branch local.",
  "  4. Type something.",
  "──────────────────────────────────────────",
  "  5. Chat about this",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

/**
 * Hard-wrap logical lines the way a TERMINAL does: break at exactly `cols`, never at a word
 * boundary, and mark every continuation row as wrapped. Returns the rows a real xterm buffer would
 * hold, which is what `serializeScrollback` walks.
 */
function hardWrap(logical: readonly string[], cols: number): { text: string; wrapped: boolean }[] {
  const rows: { text: string; wrapped: boolean }[] = [];
  for (const line of logical) {
    if (line.length === 0) {
      rows.push({ text: "", wrapped: false });
      continue;
    }
    for (let i = 0; i < line.length; i += cols) {
      rows.push({ text: line.slice(i, i + cols), wrapped: i > 0 });
    }
  }
  return rows;
}

/**
 * An xterm-shaped buffer over those rows.
 *
 * `translateToString(trimRight)` models the real thing rather than a convenience: a row the
 * terminal wrapped is FULL, so there is nothing to trim, while a row that ends a logical line is
 * padded out with never-written cells that xterm's `getTrimmedLength` walks back over. Modelling
 * that is what makes the rejoin testable — a naive fake that always trims would hide the bug where
 * a rejoin eats the space between two words.
 */
function bufferOf(rows: readonly { text: string; wrapped: boolean }[]): ScrollbackBuffer {
  return {
    length: rows.length,
    getLine(index: number) {
      const row = rows[index];
      if (!row) return undefined;
      return {
        translateToString: (trimRight?: boolean) => (trimRight ? row.text.replace(/\s+$/, "") : row.text),
        isWrapped: row.wrapped,
      };
    },
  } as ScrollbackBuffer;
}

const WIDE = 120; // no line in the fixture wraps at this width
const NARROW = 35; // agent 5e9e64d9's grid on the night of the incident

describe("a picker footer that wrapped (sparkle-99o9a)", () => {
  // THE CONTROL, and the reason the red below means something. Same menu, same detector, only the
  // width changed. This passes today.
  it("is detected normally in a wide pane", () => {
    const text = serializeScrollback(bufferOf(hardWrap(MENU_LOGICAL, WIDE)));

    expect(PICKER_FOOTER.test(text)).toBe(true);
    expect(detectClaudeCodePicker(text)).toHaveLength(5);
  });

  // THE INCIDENT ITSELF: the menu IS in the scrollback — `read_agent_terminal` returned exactly
  // this — and the detector answers with nothing.
  it("is still detected when the terminal wrapped it (the 13-column and 35-column agents)", () => {
    const text = serializeScrollback(bufferOf(hardWrap(MENU_LOGICAL, NARROW)));

    // The half `read_agent_terminal` can see. Asserted first so a failure below reads as
    // "the menu is right there and the parser returned nothing", which is the founder's report.
    expect(text).toContain("Push to our fork instead");
    expect(text).toContain("Enter to select");
    expect(text).toContain("Esc to cancel");

    // The half `read_picker_options` could not.
    expect(detectClaudeCodePicker(text)).toHaveLength(5);
    expect(detectTerminalPrompts(text)).toHaveLength(5);
  });

  // THE OTHER MECHANISM. If Ink emitted the newline itself there is no `isWrapped` to consult, so
  // the parser has to cope with a footer split across two ordinary lines. This is the shape the
  // 35-column agent may actually have had — the two are indistinguishable from the rendered text,
  // so both are covered rather than guessed between.
  it("is still detected when the SPLIT IS A REAL NEWLINE, with no wrap flag to consult", () => {
    const text = [
      ...MENU_LOGICAL.slice(0, -1),
      "Enter to select · Tab/Arrow keys to",
      "navigate · Esc to cancel",
    ].join("\n");

    expect(detectClaudeCodePicker(text)).toHaveLength(5);
  });

  // Captured VERBATIM from agent 37ae3c88 at 13 columns, where the breaks fall mid-word and so
  // prove the terminal — not Ink — did the wrapping. Only the footer run is used; the rest of that
  // screen was mangled by the same width and is not what is under test here.
  it("recovers the footer from real 13-column rows, where the breaks fall mid-word", () => {
    const capturedRows = [
      "Enter to sele",
      "ct · Tab/Arro",
      "w keys to nav",
      "igate · Esc t",
      "o           c",
      "ancel",
    ].map((text, i) => ({ text, wrapped: i > 0 }));

    const text = serializeScrollback(bufferOf(capturedRows));

    expect(text.split("\n")[0]).toContain("Enter to select");
    expect(PICKER_FOOTER.test(text)).toBe(true);
  });

  // A rejoin that eats the boundary would corrupt every logical line it touches, so the seam is
  // asserted directly rather than inferred from the parse succeeding.
  it("rejoins without losing or inventing characters at the seam", () => {
    const rows = hardWrap(["Enter the password for someone@example.com:"], 20);
    expect(rows.length).toBeGreaterThan(1); // the fixture must actually wrap

    expect(serializeScrollback(bufferOf(rows))).toBe("Enter the password for someone@example.com:");
  });

  // WIDTH MUST NOT CHANGE A MENU'S IDENTITY — WHEN THE TERMINAL DID THE WRAPPING. `pickerFingerprint`
  // is what `select_picker_option` matches on, so if it moved when the founder dragged a column
  // narrower, a menu read at one width could not be answered at another, and the refusal's own
  // remedy ("re-read and try again") would loop.
  //
  // THE TITLE IS NARROW ON PURPOSE (roborev 61840). This holds only for the terminal-wrap
  // mechanism, and it holds because the rejoin makes the narrow text byte-identical to the wide
  // text — so the equality below is really an assertion about `serializeScrollback`, not about
  // `pickerFingerprint`'s own line-count slicing. The Ink mechanism is pinned separately, and the
  // invariant does NOT hold there; claiming it for "any pane width" would have been false.
  it("gives the same menu the same identity at any width, when the TERMINAL wrapped it", () => {
    const narrow = serializeScrollback(bufferOf(hardWrap(MENU_LOGICAL, NARROW)));
    const wide = serializeScrollback(bufferOf(hardWrap(MENU_LOGICAL, WIDE)));

    scrollbackMock.mockReturnValue(narrow);
    const atNarrow = pickerFingerprint("agent-1", detectClaudeCodePicker(narrow));
    scrollbackMock.mockReturnValue(wide);
    const atWide = pickerFingerprint("agent-1", detectClaudeCodePicker(wide));

    expect(atNarrow).not.toBe(""); // an unreadable question would make the comparison vacuous
    expect(atNarrow).toBe(atWide);
  });

  // ...and it is still an IDENTITY, not a constant: a different question must still differ.
  it("still separates a different question asked at the same width", () => {
    const other = MENU_LOGICAL.map((l) =>
      l.startsWith("  A --force-with-lease") ? "  Delete 8 commits from the release branch?" : l,
    );
    const a = serializeScrollback(bufferOf(hardWrap(MENU_LOGICAL, NARROW)));
    const b = serializeScrollback(bufferOf(hardWrap(other, NARROW)));

    scrollbackMock.mockReturnValue(a);
    const fpA = pickerFingerprint("agent-1", detectClaudeCodePicker(a));
    scrollbackMock.mockReturnValue(b);
    const fpB = pickerFingerprint("agent-1", detectClaudeCodePicker(b));

    expect(fpA).not.toBe(fpB);
  });

  // ── THE LIMIT, PINNED RATHER THAN CLAIMED AWAY (roborev 61840) ──────────────────────────────
  // When INK wraps, there is no `isWrapped` and nothing can reconstitute the logical lines, so the
  // question block really is a different set of lines at 35 columns than at 120. `questionBlock`
  // slices by RENDERED line (QUESTION_CONTEXT_LINES / QUESTION_BLOCK_MAX_LINES), so the hash moves.
  //
  // THE CONSEQUENCE IS SAFE BUT REAL: a fingerprint read before a resize is refused as `changed`
  // afterwards, rather than pressing an option against a screen it no longer describes. Refusing is
  // the correct side to fail on — but a reader who trusted the test above would expect the press to
  // go through, so the limit is asserted instead of documented and forgotten.
  it("cannot hold that invariant when INK wrapped it, and refuses rather than pretending", () => {
    const inkWrap = (text: string, cols: number) => {
      const out: string[] = [];
      let cur = "";
      for (const word of text.split(" ")) {
        if (cur && `${cur} ${word}`.length > cols) { out.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
      }
      if (cur) out.push(cur);
      return out;
    };
    const inkNarrow = MENU_LOGICAL.flatMap((l) => (l === "" ? [""] : inkWrap(l, NARROW))).join("\n");
    const wide = serializeScrollback(bufferOf(hardWrap(MENU_LOGICAL, WIDE)));

    // Both are still READ as the same five-option menu — the detector is not what breaks.
    expect(detectClaudeCodePicker(inkNarrow)).toHaveLength(5);
    expect(detectClaudeCodePicker(wide)).toHaveLength(5);

    scrollbackMock.mockReturnValue(inkNarrow);
    const atInkNarrow = pickerFingerprint("agent-1", detectClaudeCodePicker(inkNarrow));
    scrollbackMock.mockReturnValue(wide);
    const atWide = pickerFingerprint("agent-1", detectClaudeCodePicker(wide));

    expect(atInkNarrow).not.toBe(""); // both are readable...
    expect(atWide).not.toBe("");
    expect(atInkNarrow).not.toBe(atWide); // ...and they are not the same identity.
  });
});
