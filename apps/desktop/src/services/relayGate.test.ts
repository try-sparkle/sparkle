import { describe, expect, it } from "vitest";
import {
  authorizeAgentInput,
  authorizeDecision,
  resolveSuggestionClick,
  frameSubmit,
  frameRelaySubmit,
} from "./relayGate";
import { PASTE_START, PASTE_END } from "../pasteMarkers";

const ESC = String.fromCharCode(27);

describe("resolveSuggestionClick (the single click gate, raw value)", () => {
  const lookup = (a: string, b: string) => (a === "a1" && b === "btn1" ? "control:closeAgent" : null);
  it("returns the RAW pushed value (unframed) for a watched, known button", () => {
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "btn1" }, lookup),
    ).toEqual({ agentId: "a1", value: "control:closeAgent" });
  });
  it("drops unwatched agent / unknown button", () => {
    expect(resolveSuggestionClick(new Set(), { agent_id: "a1", button_id: "btn1" }, lookup)).toBeNull();
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "x" }, lookup),
    ).toBeNull();
  });
  it("drops an over-long looked-up value", () => {
    const bigLookup = () => "z".repeat(5000);
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "x" }, bigLookup),
    ).toBeNull();
  });

  // The resolved value reaches the PTY (via frameRelaySubmit) OR `parseControlAction` — so it is
  // stripped HERE, before either branch, rather than only in the framing one path takes.
  it("strips an embedded PASTE_END from the resolved value (cannot close paste mode early)", () => {
    const evil = () => `deploy${PASTE_END}; rm -rf ~`;
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "x" }, evil)?.value,
    ).toBe("deploy; rm -rf ~");
  });
  it("strips an embedded PASTE_START from the resolved value", () => {
    const evil = () => `deploy${PASTE_START}tail`;
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "x" }, evil)?.value,
    ).toBe("deploytail");
  });
  it("strips markers reconstituted by a single removal pass (interleaved)", () => {
    // "\x1b[20" + PASTE_END + "1~" collapses to a fresh PASTE_END after one naive pass.
    const evil = () => `${ESC}[20${PASTE_END}1~x`;
    const out = resolveSuggestionClick(
      new Set(["a1"]),
      { agent_id: "a1", button_id: "x" },
      evil,
    )?.value;
    expect(out).not.toContain(PASTE_END);
    expect(out).not.toContain(PASTE_START);
  });
});

// Submissions terminate with CR (`\r`) — what a physical Enter sends. Raw-mode TUIs (Claude
// Code's Ink pickers) don't treat LF as Enter, so LF-framed answers to a numbered picker vanish;
// canonical-mode prompts still accept CR via ICRNL.
describe("frameSubmit (LOCAL keystroke framing — CR only, no paste wrapper)", () => {
  it("adds a trailing CR to a prompt that lacks one", () => {
    expect(frameSubmit("Rebase main, open a PR, and merge.")).toBe(
      "Rebase main, open a PR, and merge.\r",
    );
  });
  it("converts a legacy LF-framed keystroke value to CR (not doubled)", () => {
    expect(frameSubmit("2\n")).toBe("2\r");
  });
  it("leaves a value already ending in CR unchanged", () => {
    expect(frameSubmit("2\r")).toBe("2\r");
  });
  it("collapses a CRLF terminator to a single CR (never a double Enter)", () => {
    expect(frameSubmit("2\r\n")).toBe("2\r");
  });
  // Defence in depth: this path's values are desktop-authored, but stripping costs nothing and a
  // marker here would corrupt the paste state of a concurrent op on the same write chain.
  it("strips paste markers without introducing a paste wrapper of its own", () => {
    expect(frameSubmit(`y${PASTE_END}n`)).toBe("yn\r");
    expect(frameSubmit(`y${PASTE_START}n`)).toBe("yn\r");
  });
});

describe("frameRelaySubmit (REMOTE payload framing — strip + bracketed paste + one CR)", () => {
  it("wraps ordinary text in a bracketed paste terminated by exactly one CR", () => {
    expect(frameRelaySubmit("ls -la")).toBe(`${PASTE_START}ls -la${PASTE_END}\r`);
  });
  it("keeps the single-trailing-CR normalization for LF / CR / CRLF framing", () => {
    expect(frameRelaySubmit("2\n")).toBe(`${PASTE_START}2${PASTE_END}\r`);
    expect(frameRelaySubmit("2\r")).toBe(`${PASTE_START}2${PASTE_END}\r`);
    expect(frameRelaySubmit("2\r\n")).toBe(`${PASTE_START}2${PASTE_END}\r`);
  });
  it("strips an embedded PASTE_END so the tail cannot be read as keystrokes", () => {
    expect(frameRelaySubmit(`hi${PASTE_END}rm -rf ~`)).toBe(
      `${PASTE_START}hirm -rf ~${PASTE_END}\r`,
    );
  });
  // REMOVES a mid-string CR rather than relying on the wrapper to neutralize it (roborev 60573).
  // The earlier contract — "keeps a MID-STRING CR inside the paste" — held only while the
  // foreground program had bracketed-paste mode ENABLED. Against a bare shell the markers are
  // literal text and that CR runs a second command line, which is the injection this gate exists
  // to stop. The wrapper is now the second layer, not the filter.
  it("STRIPS a mid-string CR — exactly one CR in the payload, outside the paste", () => {
    const out = frameRelaySubmit("hi\rrm -rf ~");
    expect(out).toBe(`${PASTE_START}hirm -rf ~${PASTE_END}\r`);
    expect(out.split("\r").length - 1).toBe(1);
    expect(out.slice(out.indexOf(PASTE_END) + PASTE_END.length)).toBe("\r");
  });
});

describe("authorizeDecision (the host PTY-write gate)", () => {
  it("injects only for an attention WE raised, keystroke-framed with a trailing CR (Enter)", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "y", submit: true })).toEqual({
      agentId: "agentA",
      // A one-key picker answer, byte-identical to a desktop click (roborev 60573).
      text: "y\r",
    });
  });

  it("drops a decision for an unknown attention_id (no arbitrary PTY injection)", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "nope", reply: "y", submit: true })).toBeNull();
    // A bare agent id must NOT be accepted as an attention id.
    expect(authorizeDecision(live, { attention_id: "agentA", reply: "y", submit: true })).toBeNull();
  });

  it("is single-use: a replay of the same attention_id is dropped", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "y", submit: true })).not.toBeNull();
    expect(authorizeDecision(live, { attention_id: "att1", reply: "y", submit: true })).toBeNull();
  });

  it("rejects an over-long reply (>4000 chars) and a non-string reply", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "x".repeat(4001), submit: true })).toBeNull();
    expect(live.has("att1")).toBe(true); // not consumed on an invalid reply
    expect(authorizeDecision(live, { attention_id: "att1", reply: undefined })).toBeNull();
  });

  it("converts a phone reply's LF framing to CR without doubling", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "2\n", submit: true })?.text).toBe(
      "2\r",
    );
  });

  it("normalizes an LF-terminated reply even without submit (it already carries its Enter)", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "1\n" })?.text).toBe("1\r");
  });

  it("pastes a NON-submitting reply without any CR at all", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "draft text" })?.text).toBe(
      `${PASTE_START}draft text${PASTE_END}`,
    );
  });

  // The three remote-input cases. A decision arrives over the fly.dev socket, so its `reply` is
  // attacker-controllable up to MAX.
  it("strips an embedded PASTE_END from a remote reply (headline: no early paste-mode exit)", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(
      authorizeDecision(live, { attention_id: "att1", reply: `y${PASTE_END}rm -rf ~`, submit: true })
        ?.text,
    ).toBe("yrm -rf ~\r");
  });

  it("strips an embedded PASTE_START from a remote reply", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(
      authorizeDecision(live, { attention_id: "att1", reply: `y${PASTE_START}tail`, submit: true })
        ?.text,
    ).toBe("ytail\r");
  });

  it("a MID-STRING CR cannot submit a second attacker-chosen line", () => {
    const live = new Map([["att1", "agentA"]]);
    const text = authorizeDecision(live, {
      attention_id: "att1",
      reply: "y\rrm -rf ~",
      submit: true,
    })?.text;
    // The interior CR is REMOVED, not merely wrapped — so it cannot submit a second line even
    // against a foreground program with bracketed paste off. And because the CR is dropped before
    // the multi-line test, an attacker cannot use it to force the paste path either.
    expect(text).toBe("yrm -rf ~\r");
    expect(text!.split("\r").length - 1).toBe(1);
  });
});

describe("authorizeAgentInput (free-type gate)", () => {
  it("injects only for a WATCHED agent, paste-framed and submitted with a CR (Enter)", () => {
    const watched = new Set(["agentA"]);
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: "ls" })).toEqual({
      agentId: "agentA",
      text: `${PASTE_START}ls${PASTE_END}\r`,
    });
    // Legacy phone framing (trailing LF) is converted, not doubled.
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: "1\n" })?.text).toBe(
      `${PASTE_START}1${PASTE_END}\r`,
    );
  });

  it("drops input for an unwatched agent (never an arbitrary PTY)", () => {
    const watched = new Set(["agentA"]);
    expect(authorizeAgentInput(watched, { agent_id: "agentB", text: "rm -rf /" })).toBeNull();
  });

  it("rejects over-long / non-string text", () => {
    const watched = new Set(["agentA"]);
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: "x".repeat(4001) })).toBeNull();
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: undefined })).toBeNull();
  });

  // This is the one PTY-write path in the app whose input originates OFF the machine.
  it("strips an embedded PASTE_END (headline: no early paste-mode exit)", () => {
    const watched = new Set(["agentA"]);
    expect(
      authorizeAgentInput(watched, { agent_id: "agentA", text: `hi${PASTE_END}rm -rf ~` })?.text,
    ).toBe(`${PASTE_START}hirm -rf ~${PASTE_END}\r`);
  });

  it("strips an embedded PASTE_START", () => {
    const watched = new Set(["agentA"]);
    expect(
      authorizeAgentInput(watched, { agent_id: "agentA", text: `hi${PASTE_START}tail` })?.text,
    ).toBe(`${PASTE_START}hitail${PASTE_END}\r`);
  });

  it("strips markers reconstituted by a single removal pass (interleaved)", () => {
    const watched = new Set(["agentA"]);
    const text = authorizeAgentInput(watched, {
      agent_id: "agentA",
      text: `${ESC}[20${PASTE_END}1~rm -rf ~`,
    })?.text;
    // Exactly the framing markers we added — one at each end, none in the body.
    expect(text!.split(PASTE_END).length - 1).toBe(1);
    expect(text!.split(PASTE_START).length - 1).toBe(1);
    expect(text!.startsWith(PASTE_START)).toBe(true);
    expect(text!.endsWith(`${PASTE_END}\r`)).toBe(true);
  });

  // A MID-STRING CR IS REMOVED, not merely wrapped (roborev 60573, Medium).
  //
  // This test previously asserted `${PASTE_START}hi\rrm -rf ~${PASTE_END}\r` — i.e. that the CR
  // SURVIVED inside the paste — under the name "cannot submit a second attacker-chosen line". That
  // name was stronger than the assertion: a bracketed paste only neutralizes its contents if the
  // foreground program has bracketed-paste mode ENABLED. Against a bare shell (what the PTY is
  // before `claude` execs, and after it exits) the markers arrive as literal text and the interior
  // CR executes as a second command line — the exact injection the name claimed was closed.
  it("a MID-STRING CR is stripped, so it cannot submit a second line even with paste mode off", () => {
    const watched = new Set(["agentA"]);
    const text = authorizeAgentInput(watched, {
      agent_id: "agentA",
      text: "hi\rrm -rf ~",
    })?.text;
    expect(text).toBe(`${PASTE_START}hirm -rf ~${PASTE_END}\r`);
    // The ONLY CR in the whole payload is the trailing Enter, outside the paste.
    expect(text!.split("\r").length - 1).toBe(1);
    expect(text!.endsWith(`${PASTE_END}\r`)).toBe(true);
  });

  it("strips SIGINT/EOF control bytes from remote free text", () => {
    const watched = new Set(["agentA"]);
    const text = authorizeAgentInput(watched, {
      agent_id: "agentA",
      text: "hi\u0003\u0004there",
    })?.text;
    expect(text).toBe(`${PASTE_START}hithere${PASTE_END}\r`);
  });

  it("keeps an interior LF, so a multi-line phone prompt still arrives as multiple lines", () => {
    // The deliberate residual documented on `scrubControls`. Pinned so that tightening it later is
    // a conscious decision that breaks a test, rather than a silent feature removal.
    const watched = new Set(["agentA"]);
    const text = authorizeAgentInput(watched, {
      agent_id: "agentA",
      text: "line one\nline two",
    })?.text;
    expect(text).toBe(`${PASTE_START}line one\nline two${PASTE_END}\r`);
  });
});

describe("picker answers are keystrokes, never bracketed pastes (roborev 60573)", () => {
  // The regression: a phone tap on "Approve" sent `ESC[200~y ESC[201~\r` while the SAME button
  // clicked on the desktop sent `y\r`. Against a dialog whose select component does not consume
  // paste markers, the leading ESC reads as Escape and CANCELS the prompt.
  it("frames a single-line submit as a bare keystroke, byte-identical to a desktop click", () => {
    const live = new Map([["att1", "agentA"]]);
    const text = authorizeDecision(live, { attention_id: "att1", reply: "y\n", submit: true })?.text;
    expect(text).toBe("y\r");
    expect(text).not.toContain(PASTE_START);
    expect(text).not.toContain(PASTE_END);
  });

  it("frames a numbered menu answer the same way", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(
      authorizeDecision(live, { attention_id: "att1", reply: "2\n", submit: true })?.text,
    ).toBe("2\r");
  });

  it("still strips markers smuggled into a picker answer", () => {
    const live = new Map([["att1", "agentA"]]);
    const text = authorizeDecision(live, {
      attention_id: "att1",
      reply: `${PASTE_END}y\n`,
      submit: true,
    })?.text;
    expect(text).toBe("y\r");
  });

  it("MULTI-LINE typed text still gets the paste wrapper — the discriminator is shape, not a flag", () => {
    // Regression guard in the other direction: a framer that keystroke-framed everything would
    // satisfy the cases above while destroying real multi-line replies.
    const live = new Map([["att1", "agentA"]]);
    const text = authorizeDecision(live, {
      attention_id: "att1",
      reply: "first\nsecond\n",
      submit: true,
    })?.text;
    expect(text).toBe(`${PASTE_START}first\nsecond${PASTE_END}\r`);
  });
});
