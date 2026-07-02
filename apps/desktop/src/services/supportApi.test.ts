import { describe, it, expect, vi } from "vitest";

// supportApi imports @tauri-apps/api/core at module load; mock it so the pure helpers can be
// imported without a Tauri runtime (the command wrappers aren't exercised here).
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { deriveSubject, buildTicketPayload, type ChatMsg, type SupportMeta } from "./supportApi";

const META: SupportMeta = { appVersion: "0.10.0", os: "macos", arch: "aarch64" };

describe("deriveSubject", () => {
  it("uses the first line, trimmed", () => {
    expect(deriveSubject("  My agent won't start  \nmore detail")).toBe("My agent won't start");
  });

  it("truncates long first messages to 80 chars with an ellipsis", () => {
    const long = "a".repeat(200);
    const subject = deriveSubject(long);
    expect(subject.length).toBe(80);
    expect(subject.endsWith("…")).toBe(true);
  });

  it("falls back to a friendly default when empty", () => {
    expect(deriveSubject("   ")).toBe("Sparkle desktop support request");
  });

  it("does not split a surrogate pair at the truncation boundary", () => {
    // 79 ASCII chars then an emoji (a surrogate pair): a UTF-16 slice(0,79) would split the emoji.
    const subject = deriveSubject("a".repeat(79) + "😀 and more text here to force truncation");
    // The tail before the ellipsis must be whole code points — no lone surrogate.
    expect(subject.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDFFF]/.test(subject)).toBe(false);
  });
});

describe("buildTicketPayload", () => {
  const transcript: ChatMsg[] = [
    { role: "user", content: "My phone won't pair" },
    { role: "assistant", content: "Try re-scanning the code." },
    { role: "user", content: "still stuck" },
  ];

  it("derives subject + message from the FIRST user turn", () => {
    const p = buildTicketPayload({ email: "me@example.com", transcript, logs: "L", meta: META });
    expect(p.subject).toBe("My phone won't pair");
    expect(p.message).toBe("My phone won't pair");
  });

  it("persists the whole transcript as {role, body} and carries metadata/logs", () => {
    const p = buildTicketPayload({ email: "  me@example.com ", transcript, logs: "LOGS", meta: META });
    expect(p.email).toBe("me@example.com"); // trimmed
    expect(p.logs).toBe("LOGS");
    expect(p.appVersion).toBe("0.10.0");
    expect(p.os).toBe("macos");
    expect(p.metadata).toEqual({ arch: "aarch64" });
    expect(p.assistantTranscript).toEqual([
      { role: "user", body: "My phone won't pair" },
      { role: "assistant", body: "Try re-scanning the code." },
      { role: "user", body: "still stuck" },
    ]);
  });

  it("degrades gracefully when the user opened a ticket without chatting", () => {
    const p = buildTicketPayload({ email: "me@example.com", transcript: [], logs: "", meta: META });
    expect(p.subject).toBe("Sparkle desktop support request");
    expect(p.message).toBe("(Opened a support ticket from the Sparkle desktop app.)");
    expect(p.assistantTranscript).toEqual([]);
  });
});
