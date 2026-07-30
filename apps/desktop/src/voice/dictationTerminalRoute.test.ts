import { describe, expect, it } from "vitest";
import {
  classifyTerminalRoute,
  normalizeForTerminal,
  type TerminalRouteInput,
} from "./dictationTerminalRoute";

// A finished Claude Code turn sitting at its idle input box. Deliberately built to be REALISTIC
// rather than minimal: it carries the chrome (`? for shortcuts`, the box borders) that a naive
// picker matcher would trip on, so "deliver" here is evidence the guards discriminate rather than
// evidence the fixture was too plain to fail.
const IDLE_SCREEN = [
  "● Updated three files and ran the suite — all green.",
  "",
  "╭────────────────────────────────────────────╮",
  "│ >                                          │",
  "╰────────────────────────────────────────────╯",
  "  ? for shortcuts",
].join("\n");

function input(over: Partial<TerminalRouteInput> = {}): TerminalRouteInput {
  return {
    text: "run the tests again",
    writable: true,
    viewport: { text: IDLE_SCREEN, alternateBuffer: false },
    ...over,
  };
}

describe("normalizeForTerminal", () => {
  // THE "TYPE, DO NOT SUBMIT" CONTRACT. Each of these bytes would end the input line on a CLI that
  // never enabled bracketed-paste mode, which is the case the framing cannot protect.
  it.each([
    ["carriage return", "deploy\rrm -rf /", "deploy rm -rf /"],
    ["newline", "deploy\nrm -rf /", "deploy rm -rf /"],
    ["CRLF", "deploy\r\nrm -rf /", "deploy rm -rf /"],
  ])("turns a %s into a space so the tail can never run as its own command", (_n, raw, want) => {
    const out = normalizeForTerminal(raw);
    expect(out).toBe(want);
    expect(out).not.toMatch(/[\r\n]/);
  });

  it("removes tab, which triggers shell completion (and completion hooks execute)", () => {
    expect(normalizeForTerminal("git\tcheckout")).toBe("git checkout");
  });

  it("removes a bare ESC, which would leave insert mode or start a sequence", () => {
    expect(normalizeForTerminal("say\x1bhello")).toBe("say hello");
  });

  it("collapses the runs it creates, so removal never leaves ragged spacing", () => {
    expect(normalizeForTerminal("  a\r\n\r\n  b  ")).toBe("a b");
  });

  it("reduces an all-control phrase to empty rather than to a blank keystroke", () => {
    expect(normalizeForTerminal("\r\n\t\x1b")).toBe("");
  });

  it("leaves ordinary speech untouched", () => {
    expect(normalizeForTerminal("add a test for the retry path")).toBe(
      "add a test for the retry path",
    );
  });
});

describe("classifyTerminalRoute", () => {
  it("delivers the NORMALIZED text at a clean prompt", () => {
    // The verdict carries the text to write, so the caller cannot re-introduce a raw `\r` by
    // reaching past this for the original phrase.
    expect(classifyTerminalRoute(input({ text: "one\rtwo" }))).toEqual({
      kind: "deliver",
      text: "one two",
    });
  });

  // ══ THE ALTERNATE SCREEN BUFFER ══════════════════════════════════════════════════════════════
  // The hazard the founder flagged: in `vim` normal mode a pasted phrase is not text, it is a
  // command sequence. Note the viewport TEXT here is otherwise perfectly innocent — only the buffer
  // type says anything is wrong, which is exactly why the guard cannot be a content heuristic.
  it("refuses on the alternate screen buffer even when the text looks like a calm prompt", () => {
    expect(
      classifyTerminalRoute(input({ viewport: { text: IDLE_SCREEN, alternateBuffer: true } })),
    ).toEqual({ kind: "refuse", reason: "alternate-screen" });
  });

  // ══ AWAITING INPUT ═══════════════════════════════════════════════════════════════════════════
  it.each([
    ["a live Ink picker", "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend"],
    ["a (y/n) confirmation", "Overwrite the existing branch? (y/n)"],
    ["a password prompt", "drodio@host's password:"],
    ["an ssh passphrase prompt", "Enter passphrase for key '/Users/x/.ssh/id_ed25519':"],
    // ══ THE FOUR THE STATUS CLASSIFIER MISSES (roborev 56022) ════════════════════════════════
    // Each was verified to be TYPED INTO before `screenBlocksWrite` existed. The first two echo
    // nothing, so the phrase would have been invisible as well as misrouted.
    ["a sudo password prompt", "$ sudo systemctl restart nginx\n[sudo] password for drodio:"],
    ["a git credential prompt", "Password for 'https://github.com':"],
    [
      "ssh host-key confirmation",
      "The authenticity of host 'x (1.2.3.4)' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?",
    ],
    ["a type-yes-to-confirm prompt", 'This will delete 12 branches.\nType "yes" to confirm:'],
    // ══ WRAPPED ACROSS ROWS (roborev 56047) ══════════════════════════════════════════════════
    // xterm puts a hard-wrapped continuation on its OWN buffer line, and these terminals sit in
    // user-resizable columns — so the pane width decides whether the word and its colon share a
    // row. Every fixture above is unwrapped, which is exactly why the suite could not see this.
    [
      "a 1Password prompt wrapped by a narrow pane",
      "Enter the password for daniel@example.com at\nmy.1password.com:",
    ],
    ["a sudo prompt wrapped by a narrow pane", "[sudo] password for\ndrodio:"],
    // ══ SECRET PROMPTS THAT ARE NOT SPELLED "PASSWORD" ═══════════════════════════════════════
    // Same hazard class — a field that echoes nothing. `gh auth login` is routine in this repo.
    ["a gh auth token prompt", "? Paste your authentication token:"],
    ["a 2FA verification code prompt", "Verification code:"],
    ["an OTP prompt", "Enter your OTP:"],
    ["a git username prompt", "Username for 'https://github.com':"],
  ])("refuses when the viewport shows %s", (_n, screen) => {
    expect(
      classifyTerminalRoute(input({ viewport: { text: screen, alternateBuffer: false } })),
    ).toEqual({ kind: "refuse", reason: "awaiting-input" });
  });

  // The tail check is deliberately broad, so pin the other direction too: an ordinary finished turn
  // whose last rows are prose and chrome must still DELIVER, or the feature never fires at all.
  it.each([
    ["a finished turn at the idle box", IDLE_SCREEN],
    ["prose that merely mentions a token", "I refreshed the API token in .env and re-ran the suite.\n$ "],
    ["a colon-ending line with no credential word", "Files changed:"],
  ])("still delivers over %s", (_n, screen) => {
    expect(
      classifyTerminalRoute(input({ viewport: { text: screen, alternateBuffer: false } })).kind,
    ).toBe("deliver");
  });

  // ══ FAIL CLOSED ══════════════════════════════════════════════════════════════════════════════
  it("refuses when the viewport cannot be read at all, rather than treating blindness as calm", () => {
    // `no-viewport`, NOT `deliver`: an unreadable terminal is the one state where a vim session and
    // an idle prompt are indistinguishable, so guessing writes into whichever it actually is.
    expect(classifyTerminalRoute(input({ viewport: null }))).toEqual({
      kind: "refuse",
      reason: "no-viewport",
    });
  });

  it("refuses a cloud/unknown agent, which has no local pty to write to", () => {
    expect(classifyTerminalRoute(input({ writable: false }))).toEqual({
      kind: "refuse",
      reason: "not-writable",
    });
  });

  it("refuses a phrase that held no speech, instead of typing a blank", () => {
    expect(classifyTerminalRoute(input({ text: "   \r\n  " }))).toEqual({
      kind: "refuse",
      reason: "empty",
    });
  });

  // Ordering is about the MESSAGE, not about safety — but a caller showing "the screen is busy" for
  // an agent that has no terminal at all would send the user looking at the wrong thing.
  it("reports the missing pty ahead of the unreadable screen when both are true", () => {
    expect(classifyTerminalRoute(input({ writable: false, viewport: null }))).toEqual({
      kind: "refuse",
      reason: "not-writable",
    });
  });
});
