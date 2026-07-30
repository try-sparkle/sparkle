// @vitest-environment jsdom
//
// A long paste collapses into a pill in the CONCIERGE compose box — and, the whole point, the full
// text is still what gets sent.
//
// THE ASSERTION THAT MATTERS IS BYTE IDENTITY OF WHAT `onSend` RECEIVED. The pill's face carries a
// 60-char preview (`pillPreview`), so a box that transmitted its label instead of its text would
// look completely correct on screen and in every render-level test: a pill is there, the textarea is
// clean, Send is enabled, a message appears in the thread. The only thing that catches it is reading
// the string the host was handed and comparing it to the original clipboard payload — which is why
// every send row below does exactly that, and additionally asserts the label is NOT what arrived.
//
// The threshold, the expand rule and the expansion itself are pure and tested as data
// (composer/attachments.test.ts). What is pinned HERE is this box's wiring: the paste handler, the
// send gate, the clear, and the restore after a failed send.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeBox } from "./ComposeBox";
import { PILL_MIN_LINES, pillPreview } from "../composer/attachments";
import { COMPOSE_MENTION_PILL_TESTID } from "./MentionMirror";
import type { MentionAgent } from "./mentions";

afterEach(() => cleanup());

/** A paste that must collapse, with content worth checking byte-for-byte.
 *
 *  IT BEGINS WITH INDENTATION AND ENDS WITH A NEWLINE, deliberately — a pasted diff's leading
 *  whitespace is content, and a fixture whose first and last characters are ordinary letters would
 *  make every byte-identity assertion below survive a `trim()` on the way out (roborev 55730). The
 *  edges are the only part of a string a trim can reach, so they are where the fixture has to bite.
 *  Blank interior line and a tab too, since a pill's face flattens whitespace and the payload
 *  must not. */
const LONG = `${[
  "    diff --git a/src/app.ts b/src/app.ts",
  "  -  const a = 1;",
  "  +  const a = 2;   ",
  "",
  "\tif (a) return;",
  "// end of hunk",
].join("\n")}\n`;
/** Seven, because a trailing newline opens an empty final line — the same count a textarea shows. */
const LONG_LINES = 7;

/** A DIFFERENT long paste, for the rows where two pills coexist — distinguishable from LONG by its
 *  line count, so an assertion can tell which pill is which and in what order. */
const SECOND = [
  "Traceback (most recent call last):",
  '  File "app.py", line 12, in <module>',
  "    main()",
  '  File "app.py", line 8, in main',
  "    load(cfg)",
  "RuntimeError: no config",
  "  (repeated 3x)",
  "  — end —",
].join("\n");
const SECOND_LINES = 8;

/** Under the threshold on BOTH axes (lines and chars), so it must fall through to the native path. */
const SHORT = "just a couple\nof lines";

/** One addressable agent, for the row that pins a mention INSIDE a pill being ignored. */
const DOCS: MentionAgent = {
  id: "a1",
  name: "Docs",
  projectId: "p1",
  projectName: "web",
  band: "running",
  canAcceptInput: true,
};

function setup(
  over: {
    onSend?: (text: string, mentions?: unknown) => void | Promise<boolean>;
    mentionAgents?: MentionAgent[];
    /** Stable by construction (a ref-held identity would churn the box's effect otherwise). */
    /** Mirrors ComposeBox's prop, options included — ConciergeHost.restoreDraft passes
     *  `{ verbatim: true }`, and a fake host that omitted it would model the DICTATION path
     *  (which trims) while claiming to model a draft restore. */
    registerInsert?: (
      append: ((text: string, opts?: { verbatim?: boolean }) => void) | null,
    ) => void;
  } = {},
) {
  const onSend = vi.fn(over.onSend);
  const onTextEdit = vi.fn();
  render(
    <ComposeBox
      onSend={onSend}
      onAttach={vi.fn()}
      onTextEdit={onTextEdit}
      mentionAgents={over.mentionAgents}
      registerInsert={over.registerInsert}
    />,
  );
  return { onSend, onTextEdit };
}

const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;
const send = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
const pills = () => screen.queryAllByTestId("composer-text-pill");

/** Paste `text` into the textarea the way the browser does: fire the paste, and — since jsdom does
 *  NOT run the default action — perform the native insert ourselves only when the handler declined
 *  to prevent it. That way this helper models both branches instead of assuming one, and it reports
 *  whether the box intercepted the paste. */
function paste(text: string): { prevented: boolean } {
  const ta = box();
  const e = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { getData: (t: string) => string };
  };
  e.clipboardData = { getData: (t: string) => (t === "text/plain" ? text : "") };
  act(() => {
    ta.dispatchEvent(e);
  });
  if (!e.defaultPrevented) {
    // The native insert React's onChange would have seen.
    fireEvent.change(ta, { target: { value: ta.value + text } });
  }
  return { prevented: e.defaultPrevented };
}

describe("ComposeBox — a long paste collapses into a pill", () => {
  // If PILL_MIN_LINES is ever raised past the fixture, LONG stops collapsing and every row below
  // would quietly stop testing the feature while staying green — the fixture would be pasted as
  // ordinary text and "no pill" would be correct. Fail loudly there instead.
  it("uses a fixture that is actually over the collapse threshold", () => {
    expect(LONG_LINES).toBeGreaterThanOrEqual(PILL_MIN_LINES);
  });

  it("keeps the paste OUT of the textarea and shows it as a pill", () => {
    setup();
    const { prevented } = paste(LONG);
    expect(prevented).toBe(true);
    expect(box().value).toBe("");
    const row = screen.getByTestId("concierge-text-pills");
    expect(row).toBeTruthy();
    expect(pills()).toHaveLength(1);
    // The pill stands for THIS block, not merely "a pill rendered" — the line count rides on the
    // element for exactly this reason.
    expect(pills()[0]?.getAttribute("data-line-count")).toBe(String(LONG_LINES));
  });

  it("leaves a short paste to the browser — no preventDefault, no pill", () => {
    setup();
    const { prevented } = paste(SHORT);
    expect(prevented).toBe(false);
    expect(screen.queryByTestId("concierge-text-pills")).toBeNull();
    expect(pills()).toHaveLength(0);
    // And it landed in the box as ordinary text.
    expect(box().value).toBe(SHORT);
  });
});

// ── THE POINT OF THE WHOLE FEATURE ────────────────────────────────────────────────────────────
describe("ComposeBox — a collapsed paste SENDS its full text", () => {
  it("hands onSend the pasted bytes, not the pill's label", () => {
    const { onSend } = setup();
    paste(LONG);
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledTimes(1);
    const sent = onSend.mock.calls[0]?.[0];
    expect(sent).toBe(LONG);
    // Said explicitly, because this is the substitution that would otherwise pass every other
    // assertion in this file.
    expect(sent).not.toBe(pillPreview(LONG));
    expect(sent).not.toContain("…");
    // …and the box is empty afterwards: no leftover pill to send twice.
    expect(pills()).toHaveLength(0);
    expect(box().value).toBe("");
  });

  it("sends a pill plus typed text as the block followed by what was typed", () => {
    const { onSend } = setup();
    paste(LONG);
    fireEvent.change(box(), { target: { value: "please review this" } });
    fireEvent.keyDown(box(), { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith(`${LONG}\n\nplease review this`);
  });

  it("is byte-identical again after a round trip through 'Show as regular text'", () => {
    const { onSend } = setup();
    paste(LONG);
    // Open the modal and expand the block back into the textarea.
    fireEvent.click(pills()[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));
    expect(pills()).toHaveLength(0);
    // Expanded into an EMPTY box, so the textarea now holds the paste verbatim.
    expect(box().value).toBe(LONG);

    // Re-collapse it (paste it again into a box the user has cleared) and send.
    fireEvent.change(box(), { target: { value: "" } });
    paste(LONG);
    expect(box().value).toBe("");
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith(LONG);
  });

  // ── THE OUTER WHITESPACE ROWS ────────────────────────────────────────────────────────────────
  // `LONG` above has indentation and trailing spaces on INTERIOR lines but none at its two ends, so
  // `LONG.trim() === LONG` and every row using it passes whether or not the trim is suppressed. The
  // corruption roborev 55720/55728 found lives exactly at the ends, so it needs its own fixture:
  // an indented FIRST line and a trailing newline.
  const EDGES = [
    "    const x = 1;",
    "    const y = 2;",
    "",
    "\tif (x) return y;",
    "    line five",
    "    line six",
  ].join("\n") + "\n";

  it("keeps the paste's OUTER whitespace through expand → send", () => {
    const { onSend } = setup();
    paste(EDGES);
    fireEvent.click(pills()[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));
    expect(box().value).toBe(EDGES);
    fireEvent.click(send());
    // The four-space indent on line one and the trailing newline both survived. Without the
    // verbatim latch this arrives as "const x = 1;…line six".
    expect(onSend).toHaveBeenCalledWith(EDGES);
  });

  it("keeps it through expand → EDIT → send, which is why anyone expands", () => {
    // Editing is the whole reason to take "Show as regular text", so the exemption cannot be keyed
    // to the expansion's exact string (roborev 55728).
    const { onSend } = setup();
    paste(EDGES);
    fireEvent.click(pills()[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));
    fireEvent.change(box(), { target: { value: `${EDGES}make this async` } });
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith(`${EDGES}make this async`);
  });

  it("releases the exemption once the box is emptied by hand", () => {
    // The latch is not permanent — otherwise it would leak into every later message in the session.
    const { onSend } = setup();
    paste(EDGES);
    fireEvent.click(pills()[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.change(box(), { target: { value: "  a fresh message  " } });
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith("a fresh message");
  });

  it("can send a box holding ONLY a pill", () => {
    const { onSend } = setup();
    expect(send().disabled).toBe(true);
    paste(LONG);
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith(LONG);
  });

  it("restores the typed text AND the pill when the send resolves false", async () => {
    const { onSend } = setup({ onSend: () => Promise.resolve(false) });
    paste(LONG);
    fireEvent.change(box(), { target: { value: "have a look" } });
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith(`${LONG}\n\nhave a look`);
    // Cleared optimistically…
    expect(pills()).toHaveLength(0);
    // …and both halves come back, in the shape the user had them: typed words in the textarea,
    // paste back in its pill (never flooded into the box).
    await act(async () => {});
    expect(box().value).toBe("have a look");
    expect(pills()).toHaveLength(1);
    expect(pills()[0]?.getAttribute("data-line-count")).toBe(String(LONG_LINES));
    // And the restored draft still sends the full bytes.
    fireEvent.click(send());
    expect(onSend).toHaveBeenLastCalledWith(`${LONG}\n\nhave a look`);
  });

  // THE HOST HAS ITS OWN RESTORE, and the two must not both fire (roborev 55730).
  // ConciergeHost.restoreDraft appends the message back through `registerInsert` on paths this
  // box's promise cannot see — a cancelled countdown, an agent that has since died — and it is
  // handed the composed body, paste included. If this box then re-added the pill on top, the paste
  // would sit in the draft twice and the next Send would transmit it twice.
  it("does not re-add the pill when the host has already put the draft back", async () => {
    // The host's own restore arrives on its own tick, through the insert fn — this box cannot see
    // it happen, only that something is in the textarea by the time the failure is reported.
    let append: ((text: string, opts?: { verbatim?: boolean }) => void) | null = null;
    const registerInsert = (fn: ((text: string) => void) | null) => {
      append = fn;
    };
    let settle: (ok: boolean) => void = () => {};
    const { onSend } = setup({
      registerInsert,
      onSend: () => new Promise<boolean>((res) => (settle = res)),
    });
    paste(LONG);
    fireEvent.click(send());
    const composed = onSend.mock.calls[0]?.[0] as string;
    expect(composed).toBe(LONG);
    // 1. The host puts the draft back — the composed body, paste included (it has no pills to
    //    restore, only a string).
    act(() => append?.(composed, { verbatim: true }));
    expect(box().value).toContain("// end of hunk");
    // 2. THEN the send reports it failed.
    await act(async () => settle(false));

    // No second copy: the pill is not re-added on top of a textarea that already holds the paste.
    expect(pills()).toHaveLength(0);
    // Proof it is not doubled — sending again transmits the body ONCE.
    onSend.mockClear();
    fireEvent.click(send());
    const resent = onSend.mock.calls[0]?.[0] as string;
    expect(resent.split("// end of hunk")).toHaveLength(2);
  });

  it("does not double the TYPED half when the host has already put the draft back", async () => {
    // The sibling of the row above, and the half that was still doubling (roborev 55776): the host
    // is handed the composed BODY, which ENDS with the typed words — so prepending the typed half
    // unconditionally put the user's sentence in the draft twice and sent it twice.
    let append: ((text: string, opts?: { verbatim?: boolean }) => void) | null = null;
    let settle: (ok: boolean) => void = () => {};
    const { onSend } = setup({
      registerInsert: (fn) => {
        append = fn;
      },
      onSend: () => new Promise<boolean>((res) => (settle = res)),
    });
    paste(LONG);
    fireEvent.change(box(), { target: { value: "have a look" } });
    fireEvent.click(send());
    const composed = onSend.mock.calls[0]?.[0] as string;
    act(() => append?.(composed, { verbatim: true }));
    await act(async () => settle(false));

    onSend.mockClear();
    fireEvent.click(send());
    const resent = onSend.mock.calls[0]?.[0] as string;
    // Exactly once, not twice.
    expect(resent.split("have a look")).toHaveLength(2);
    // …AND byte-intact. Counting occurrences alone hid a loss on this exact path (roborev 55793):
    // the host's insert used to run through `appendDictated`, which TRIMS, so the collapsed paste
    // came back dedented and short its trailing newline before any latch could protect it.
    expect(resent.startsWith("    diff --git")).toBe(true);
  });

  it("does not eat the typed half just because the new keystrokes CONTAIN it", async () => {
    // The typed guard cannot be a bare `includes` (roborev 55793). The block half's licence is that
    // its needle is a multi-line paste over the collapse threshold — "text the user typed in a few
    // seconds cannot contain it". A typed needle can be two characters, and then it false-positives
    // and silently deletes the user's words, which is the loss the whole merge design prevents.
    let settle: (ok: boolean) => void = () => {};
    const { onSend } = setup({ onSend: () => new Promise<boolean>((res) => (settle = res)) });
    paste(LONG);
    fireEvent.change(box(), { target: { value: "hi" } });
    fireEvent.click(send());
    // A new thought that happens to contain "hi" — no host restore involved at all.
    fireEvent.change(box(), { target: { value: "this is urgent" } });
    await act(async () => settle(false));

    onSend.mockClear();
    fireEvent.click(send());
    const resent = onSend.mock.calls[0]?.[0] as string;
    // ASSERT THE MERGED SHAPE, not `toContain("hi")` — "this is urgent" itself contains "hi", so a
    // containment check passes even when the typed half was dropped. (It did: this row was vacuous
    // until the bare-`includes` mutation was run against it.) The restored half is prepended as its
    // own blank-line-separated segment, so that adjacency is what distinguishes kept from lost.
    expect(resent).toContain("hi\n\nthis is urgent");
  });

  it("keeps the paste's edges across a failed send MERGED with new keystrokes", async () => {
    // roborev 55776's second finding: restricting the latch re-arm to an empty box re-opened the
    // dedent on precisely the merge path the previous commit added. The restore PREPENDS, so the
    // string still begins with the paste's own bytes — the latch has to come back on either way.
    let settle: (ok: boolean) => void = () => {};
    const { onSend } = setup({ onSend: () => new Promise<boolean>((res) => (settle = res)) });
    paste(EDGES);
    fireEvent.click(pills()[0] as HTMLElement);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));
    expect(box().value).toBe(EDGES);
    fireEvent.click(send());
    // The user types while the send is still in flight, so the restore MERGES rather than replaces.
    fireEvent.change(box(), { target: { value: "wait" } });
    await act(async () => settle(false));

    onSend.mockClear();
    fireEvent.click(send());
    const resent = onSend.mock.calls[0]?.[0] as string;
    // Line one's four-space indent survived the retry.
    expect(resent.startsWith("    const x = 1;")).toBe(true);
    expect(resent).toContain("wait");
  });

  // THE OTHER HALF OF THAT GATE (roborev 55748). "Is the box empty" is the wrong question: a
  // keystroke while the send was in flight would then destroy the whole collapsed paste, which is
  // far worse than the duplication the gate exists to prevent. Typed text cannot contain the paste;
  // a restored body must.
  it("gives the pill back even when the user typed while the send was in flight", async () => {
    let settle: (ok: boolean) => void = () => {};
    const { onSend } = setup({ onSend: () => new Promise<boolean>((res) => (settle = res)) });
    paste(LONG);
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith(LONG);
    // The user starts a new thought before the failure comes back.
    fireEvent.change(box(), { target: { value: "wait, also" } });
    await act(async () => settle(false));

    // The paste is NOT lost, and the new keystrokes are not clobbered.
    expect(pills()).toHaveLength(1);
    expect(pills()[0]?.getAttribute("data-line-count")).toBe(String(LONG_LINES));
    expect(box().value).toBe("wait, also");
    // And the recovered draft sends the full bytes.
    fireEvent.click(send());
    expect(onSend).toHaveBeenLastCalledWith(`${LONG}\n\nwait, also`);
  });

  // …and the same loss arriving through the PASTE handler (roborev 55758). `onPaste` has no notion
  // of a send being in flight, so a second paste during the window must not cost the user the first.
  it("keeps BOTH pastes when a second one lands while the send is in flight", async () => {
    let settle: (ok: boolean) => void = () => {};
    const { onSend } = setup({ onSend: () => new Promise<boolean>((res) => (settle = res)) });
    paste(LONG);
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledWith(LONG);
    // A stack trace arrives while the host is still deciding.
    paste(SECOND);
    expect(pills()).toHaveLength(1);
    await act(async () => settle(false));

    // Both pills, in paste order — the restored one first.
    expect(pills()).toHaveLength(2);
    expect(pills().map((p) => p.getAttribute("data-line-count"))).toEqual([
      String(LONG_LINES),
      String(SECOND_LINES),
    ]);
    // …and the next send carries both bodies, each verbatim.
    fireEvent.click(send());
    expect(onSend).toHaveBeenLastCalledWith(`${LONG}\n\n${SECOND}`);
  });
});

// ── A PILL'S CONTENTS ARE CONTENT, NEVER AN ENVELOPE ──────────────────────────────────────────
// Mentions are resolved from the VISIBLE textarea, not from the composed body (roborev 55730).
// Scanning the body would let a pasted log aim the message: the host routes `mentions[0]` straight
// at that agent's terminal, and it renders the wire text through `mentionFreeText`, which DELETES
// the addressing span — so a mention found inside a pill would have the paste itself rewritten on
// the way out, breaking the one guarantee the pill exists to keep.
describe("ComposeBox — a mention inside a collapsed paste is not an address", () => {
  const PASTE_WITH_MENTION = `${LONG}@Docs said the schema changed\nand then it broke\n`;

  it("sends the paste unmodified and reports NO mention", () => {
    const { onSend } = setup({ mentionAgents: [DOCS] });
    paste(PASTE_WITH_MENTION);
    expect(pills()).toHaveLength(1);
    fireEvent.click(send());
    // One argument: an unaddressed send, indistinguishable from what this box has always sent.
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]).toHaveLength(1);
    expect(onSend.mock.calls[0]?.[0]).toBe(PASTE_WITH_MENTION);
  });

  it("still resolves a mention the user TYPED, alongside a pill", () => {
    const { onSend } = setup({ mentionAgents: [DOCS] });
    paste(LONG);
    fireEvent.change(box(), { target: { value: "@Docs " } });
    fireEvent.click(send());
    // Addressed — and the body still leads with the verbatim paste.
    expect(onSend).toHaveBeenCalledWith(`${LONG}\n\n@Docs`, [{ agentId: "a1", name: "Docs" }]);
  });
});

// ── THE VERBATIM RESTORE OUTRANKS THE SPOKEN-ADDRESS RULE ──────────────────────────────────────
// `append` serves two callers through one function: DICTATION (a spoken segment, which
// `appendDictated` trims because Deepgram pads its segments) and ConciergeHost.restoreDraft (an
// already-composed body coming back after a failed send, flagged `{ verbatim: true }`). The whole
// safety argument for that merge is ORDERING — the verbatim early return sits ABOVE the
// spoken-address block — and until this row nothing pinned it.
//
// It is not a hypothetical collision. `dictatedSparkleAddress` fires when `current.trim() === ""`,
// which is EXACTLY the state of the box on a restore (`submit` clears it before the promise
// settles), and it resolves to the built-in SPARKLE_MENTION_AGENT, so no roster entry is required
// to reach it. If the two blocks are ever reordered — or a third insert path is added above the
// guard — a failed send of "Sparkle, ship this diff: …" comes back as "@Sparkle ship this diff: …":
// the vocative deleted, the body run through the trimming path (re-opening roborev 55793's dedent
// of a pasted diff), and `mentionsIn` then aiming the retry at a mention the user never wrote.
describe("ComposeBox — a restored draft opening with 'Sparkle,' is TEXT, not an address", () => {
  /** The shape that collides: a spoken-address lead-in on a body whose remainder is a collapsed
   *  paste, so both the rewrite and the trim would be visible in one assertion. */
  const SPOKEN_LEAD = `Sparkle, ship this diff:\n${LONG}`;

  it("restores it byte-for-byte, paints no mention pill, and re-sends it unaddressed", () => {
    let append: ((text: string, opts?: { verbatim?: boolean }) => void) | null = null;
    // A roster IS present — the reordered code would resolve against it (or fall back to the
    // built-in), so an empty roster would make this row pass for the wrong reason.
    const { onSend } = setup({
      mentionAgents: [DOCS],
      registerInsert: (fn) => {
        append = fn;
      },
    });

    act(() => append?.(SPOKEN_LEAD, { verbatim: true }));

    // 1. Byte-identical. `toBe` on the WHOLE string, not a startsWith: the reorder's damage is at
    //    both ends — "Sparkle," deleted at the head, LONG's trailing newline trimmed at the tail.
    expect(box().value).toBe(SPOKEN_LEAD);
    // 2. Nothing was turned into an artifact. The word is prose here.
    expect(screen.queryAllByTestId(COMPOSE_MENTION_PILL_TESTID)).toHaveLength(0);

    // 3. And the retry goes out UNADDRESSED — one argument, the way an unaddressed send always
    //    looks. This is the half that would silently misroute: the host aims `mentions[0]` at that
    //    agent's terminal and renders the wire text through `mentionFreeText`.
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]).toHaveLength(1);
    expect(onSend.mock.calls[0]?.[0]).toBe(SPOKEN_LEAD);
  });
});
