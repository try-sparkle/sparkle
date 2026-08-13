import { describe, expect, it } from "vitest";
import {
  classifyTerminalRoute,
  normalizeForTerminal,
  screenBlocksWrite,
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
  // command sequence. This refusal is the one the bead insists must survive.
  it("refuses on the alternate screen buffer when a real full-screen app owns it", () => {
    const vim = ["~", "~", "~", '"notes.md" 12L, 340B', ":"].join("\n");
    expect(classifyTerminalRoute(input({ viewport: { text: vim, alternateBuffer: true } }))).toEqual(
      { kind: "refuse", reason: "alternate-screen" },
    );
  });

  // ══ …BUT NOT WHEN THE ALTERNATE BUFFER IS JUST CLAUDE CODE (bead sparkle-v7k3y) ═══════════════
  // THIS ROW USED TO ASSERT THE OPPOSITE, and asserting it is how the defect survived: the fixture
  // above it is described in this very file as "a finished Claude Code turn sitting at its idle
  // input box", and the test demanded that writing to it be REFUSED. That is the founder's bug,
  // written down as intent.
  //
  // Claude Code holds the alternate buffer for its ordinary idle and busy states. Refusing there
  // means refusing on the most common state in the app — the founder was bounced while his agent
  // read "Running 1 shell command · 1m 24s". Typing into that pane queues the message; so does this.
  //
  // The buffer flag has NOT stopped mattering. It is now weighed against `isClaudeCodeScreen`, which
  // needs two independent markers of Claude's own TUI — the row above is the other half of the pair,
  // and `engine/claudeCodeScreen.test.ts` holds the discrimination cases (vim, less, htop, lazygit,
  // and a pager displaying a document that quotes Claude's status bar).
  it("delivers into a Claude Code that merely holds the alternate buffer", () => {
    expect(
      classifyTerminalRoute(input({ viewport: { text: IDLE_SCREEN, alternateBuffer: true } })),
    ).toEqual({ kind: "deliver", text: "run the tests again" });
  });

  // AND THE PICKER GUARD STILL RUNS ON A RECOGNISED CLAUDE CODE. Recognising the TUI says the buffer
  // flag is not the hazard; it says nothing about what is drawn. A message submitted at a permission
  // dialog presses whatever button is highlighted, so this must refuse — one guard deeper than the
  // alternate-screen arm that used to catch it by accident.
  it("still refuses a Claude Code that is showing a permission dialog", () => {
    const dialog = [IDLE_SCREEN, "", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "Esc to cancel · Tab to amend · ctrl+e to explain"].join("\n");
    expect(
      classifyTerminalRoute(input({ viewport: { text: dialog, alternateBuffer: true } })),
    ).toEqual({ kind: "refuse", reason: "awaiting-input" });
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

// ── THE WRITE GATE'S ARMS ARE REGIONED INDIVIDUALLY, NOT ALL ONE WAY ─────────────────────────────
//
// Two rules pull in opposite directions, and applying either to all five SHELL_PROMPTS arms breaks
// the other. The pairs below pin BOTH, because a suite that only ever asserts `true` here cannot
// tell a working gate from one that refuses everything.
//
// (1) The gate must NOT inherit `screenAwaitsInput`'s bottom-anchoring (roborev 63126): that
//     predicate is bottom-anchored so prompt-shaped SCROLLBACK stops painting a sidebar row red,
//     where a false positive costs a wrong colour. Here a miss types a spoken sentence into a
//     password field, and `screenIsCredentialPrompt` cannot backstop it — it reads only 3 rows.
//
// (2) But `(y/n)`, `press enter to continue` and `overwrite?` are things a pane merely DISPLAYS
//     (roborev 63208). Scanning those whole-snapshot re-opens the over-block roborev 58540 / 58562
//     / 58575 removed three separate times, and `screenBlocksWrite` is also the gate at
//     `services/conciergeDispatch` for every Claude Code alternate-buffer screen — so it took out
//     the concierge relay, `send_to_agent_terminal` and the goal auto-resume with it.
describe("screenBlocksWrite — credential arms scan the whole grid", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `     step ${i} complete`);

  it("blocks a password prompt sitting far above the bottom", () => {
    const screen = ["$ sudo deploy", "Password:", ...filler(30)].join("\n");
    expect(screenBlocksWrite(screen)).toBe(true);
  });

  // ⚠️ THE ONE ROW THAT ISOLATES THE WHOLE-SNAPSHOT SHELL_PROMPTS SCAN, and it took a mutation run
  // to find a shape that does. Every other credential fixture here is caught by something else
  // first: `matchesBlockingPrompt` already tests `/\bpass(word|phrase)\b[^\n]*:\s*$/im` over the
  // whole snapshot, so ANY prompt ending in a colon blocks with this arm deleted, and
  // `screenAwaitsInput`'s arm 3 catches anything within 12 non-empty rows of the bottom.
  //
  // What is left is exactly this: ssh-keygen's parenthetical, which puts no colon at end of line,
  // scrolled past the live tail. Delete the scan and this row goes red — nothing else sees it.
  it("blocks an 'enter passphrase' with no trailing colon, far above the bottom", () => {
    const screen = [
      "$ ssh-keygen -t ed25519",
      "Enter passphrase for key 'id_ed25519' (leave empty for no passphrase)",
      ...filler(30),
    ].join("\n");
    expect(screenBlocksWrite(screen)).toBe(true);
  });
});

describe("screenBlocksWrite — display-ambiguous arms are bounded to the live tail", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `     step ${i} complete`);

  // The DELIVERING direction, which is the half the whole-snapshot scan could not express. Thirty
  // rows of output printed BELOW a `(y/n)` is proof it was already answered.
  it("delivers when a (y/n) has scrolled far above the bottom", () => {
    const screen = ["$ ./migrate.sh", "Drop the production table? (y/n)", ...filler(30)].join("\n");
    expect(screenBlocksWrite(screen)).toBe(false);
  });

  it("delivers when 'press enter to continue' has scrolled far above the bottom", () => {
    const screen = ["Press enter to continue…", ...filler(30)].join("\n");
    expect(screenBlocksWrite(screen)).toBe(false);
  });

  // The concrete repro from roborev 63208: a pane DISPLAYING this guard's own source, then getting
  // on with its work. The commit that introduced the whole-snapshot scan locked itself out of its
  // own agent this way — `git show` of this file, `AGENTS.md`, any `--help`.
  //
  // The filler is not padding. `screenAwaitsInput`'s arm 3 already scans the last LIVE_TAIL_LINES
  // (12) non-empty rows per line, so on a SHORT snapshot it blocks this fixture by itself and the
  // assertion would prove nothing about the arm under test — the short version of this fixture was
  // written first and passed for exactly that wrong reason. A real terminal is 40+ rows and the
  // read scrolls up; this is the shape that actually reaches the whole-snapshot scan.
  it("delivers on a tall pane that is merely displaying documentation containing (y/n)", () => {
    const screen = [
      "● Reading apps/desktop/src/voice/dictationTerminalRoute.ts",
      "  ⎿  // a `password:` / `(y/n)` / `press enter to continue` sitting above the bottom",
      "     //  of the snapshot stopped blocking, and `overwrite?` with it",
      ...filler(20),
      "● Updated three files and ran the suite — all green.",
      "",
      "╭────────────────────────────────────────────╮",
      "│ >                                          │",
      "╰────────────────────────────────────────────╯",
      "  ? for shortcuts",
    ].join("\n");
    expect(screenBlocksWrite(screen)).toBe(false);
  });

  // …and a LIVE one still blocks. ⚠️ These two do NOT cover `matchesShellPrompt` — measured, by
  // neutralizing its ambiguous branch and watching them stay green, which is what showed that branch
  // to be dead code. `screenAwaitsInput`'s arm 3 is what supplies this, over a strictly larger window
  // (12 non-empty rows, per line). They are here as the paired direction for the four above: a
  // suite that only asserts "delivers" cannot tell a working gate from one that blocks nothing.
  it("blocks a (y/n) sitting at the bottom under two lines of chatter", () => {
    const screen = [
      ...filler(30),
      "Drop the production table? (y/n)",
      "Waiting for response…",
      "Press Ctrl-C to abort.",
    ].join("\n");
    expect(screenBlocksWrite(screen)).toBe(true);
  });

  it("blocks a live 'press enter to continue' on the last row", () => {
    const screen = [...filler(30), "Press enter to continue…"].join("\n");
    expect(screenBlocksWrite(screen)).toBe(true);
  });
});
