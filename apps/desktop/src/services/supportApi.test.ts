import { describe, it, expect, vi } from "vitest";

// supportApi imports @tauri-apps/api/core at module load; mock it so the pure helpers can be
// imported without a Tauri runtime (the command wrappers aren't exercised here).
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  deriveSubject,
  buildTicketPayload,
  bannerFromTickets,
  type ChatMsg,
  type SupportMeta,
  type TicketStatus,
} from "./supportApi";

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

describe("bannerFromTickets", () => {
  const ticket = (status: TicketStatus["status"], id: string = status): TicketStatus => ({
    id,
    token: `tok-${id}`,
    subject: `subject ${id}`,
    status,
  });

  it("returns null when there are no tickets", () => {
    expect(bannerFromTickets([])).toBeNull();
  });

  it("returns null when every ticket is resolved (no open tickets)", () => {
    expect(bannerFromTickets([ticket("resolved", "a"), ticket("resolved", "b")])).toBeNull();
  });

  it("shows Submitted with no alert for a single awaiting_support ticket", () => {
    const banner = bannerFromTickets([ticket("awaiting_support")]);
    expect(banner).not.toBeNull();
    expect(banner!.label).toBe("Submitted");
    expect(banner!.alert).toBe(false);
    expect(banner!.openTickets).toHaveLength(1);
  });

  it("shows Responded with an alert for a single awaiting_user ticket", () => {
    const banner = bannerFromTickets([ticket("awaiting_user")]);
    expect(banner!.label).toBe("Responded");
    expect(banner!.alert).toBe(true);
    expect(banner!.openTickets).toHaveLength(1);
  });

  it("treats an unknown/future terminal status as NOT open (allow-list, not deny-list)", () => {
    // A backend that later adds e.g. "closed" must not keep the banner pinned open. The status
    // union is cast here to simulate a value outside the three the client currently knows.
    const closed = { ...ticket("resolved", "z"), status: "closed" as TicketStatus["status"] };
    expect(bannerFromTickets([closed])).toBeNull();
  });

  it("escalates to Responded/alert when any open ticket is awaiting_user (mixed)", () => {
    const banner = bannerFromTickets([
      ticket("awaiting_support", "a"),
      ticket("awaiting_user", "b"),
      ticket("resolved", "c"),
    ]);
    expect(banner!.label).toBe("Responded");
    expect(banner!.alert).toBe(true);
    // Only the two OPEN tickets are carried; the resolved one drops off.
    expect(banner!.openTickets.map((t) => t.id)).toEqual(["a", "b"]);
  });
});
