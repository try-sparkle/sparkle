// @vitest-environment jsdom
//
// TicketIntakePanel — what the reader actually SEES, and the three things it must never say:
//   • that an ambiguous reference belongs to a tracker (nobody would learn a guess had been made);
//   • that a ticket had two screenshots when it had three and one download died;
//   • that intake is unavailable when nothing has been asked yet.
//
// Every assertion here is on RENDERED OUTPUT, not on a prop or a store field, and the service layer
// is mocked so the panel is driven purely by seeding `ticketIntakeStore` — the split the component
// header describes.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const parseMock = vi.fn();
const fetchMock = vi.fn();
const statusMock = vi.fn();
const imageMock = vi.fn();
vi.mock("../services/ticketIntake", () => ({
  parseTicketRefs: (...a: unknown[]) => parseMock(...a),
  fetchTickets: (...a: unknown[]) => fetchMock(...a),
  fetchTicketIntakeStatus: (...a: unknown[]) => statusMock(...a),
  loadTicketImage: (...a: unknown[]) => imageMock(...a),
}));

/** A one-pixel PNG as the backend hands it over: bytes, base64, in a `data:` URL. */
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg==";

import {
  TicketIntakePanel,
  TICKET_INTAKE_CARD_TESTID,
  TICKET_INTAKE_FAILURE_TESTID,
  TICKET_INTAKE_IMAGE_TESTID,
} from "./TicketIntakePanel";
import {
  useTicketIntakeStore,
  entryFor,
  type IntakedTicket,
  type TicketIntakeStatus,
  type TicketRef,
} from "../stores/ticketIntakeStore";

const ROOT = "/repo";

/** `toHaveTextContent` needs jest-dom, which this suite does not install — read the DOM directly. */
function text(el: Element | null | undefined): string {
  return el?.textContent ?? "";
}

/** Same reason as `text`: with no jest-dom there is no disabled matcher, so read the property. */
function disabled(el: Element | null | undefined): boolean {
  return (el as HTMLButtonElement | null)?.disabled === true;
}

const RESOLVED: TicketRef = {
  raw: "ENG-1234",
  provider: "linear",
  candidates: [],
  ambiguous: false,
  key: "ENG-1234",
  url: null,
  branch: "eng-1234",
  commitPrefix: "ENG-1234:",
  prTitle: "ENG-1234:",
  note: null,
};

const AMBIGUOUS: TicketRef = {
  raw: "ABC-9",
  provider: null,
  candidates: ["linear", "jira"],
  ambiguous: true,
  key: "ABC-9",
  url: null,
  branch: "abc-9",
  commitPrefix: "ABC-9:",
  prTitle: "ABC-9:",
  note: "ABC-9 is a valid key in more than one tracker and no default_provider is set — pick one",
};

const TICKET: IntakedTicket = {
  provider: "linear",
  key: "ENG-1234",
  title: "Fix the login crash",
  body: "It crashes.",
  comments: [],
  images: [
    { sourceUrl: "https://u/a.png", localPath: "/att/a.png", ok: true, error: null, bytes: 2048, mime: "image/png" },
    { sourceUrl: "https://u/b.png", localPath: "/att/b.png", ok: true, error: null, bytes: 4096, mime: "image/png" },
    { sourceUrl: "https://u/c.png", localPath: null, ok: false, error: "403 expired", bytes: 0, mime: "" },
  ],
  branch: "eng-1234-fix-the-login-crash",
  commitPrefix: "ENG-1234:",
  prTitle: "ENG-1234: Fix the login crash",
  url: null,
};

const ON: TicketIntakeStatus = {
  enabled: true,
  defaultProvider: null,
  providers: [
    { provider: "linear", enabled: true, configured: true, note: "credential configured" },
    { provider: "jira", enabled: true, configured: false, note: "set [ticket_intake.jira].base_url" },
    { provider: "github", enabled: true, configured: true, note: "uses the `gh` CLI" },
    { provider: "beads", enabled: true, configured: true, note: "reads the local beads store" },
  ],
  imageDir: ".sparkle/ticket-attachments",
};

function seed(over: Partial<ReturnType<typeof entryFor>>) {
  useTicketIntakeStore.getState().patch(ROOT, over);
}

beforeEach(() => {
  parseMock.mockReset();
  fetchMock.mockReset().mockResolvedValue({ tickets: [], failures: [] });
  statusMock.mockReset().mockResolvedValue(ON);
  imageMock.mockReset().mockResolvedValue(PNG_DATA_URL);
  useTicketIntakeStore.setState({ byProject: {} });
});

afterEach(cleanup);

describe("the parse half", () => {
  it("says so when there is nothing to read, rather than showing an empty list", () => {
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(text(screen.getByTestId("ticket-intake-empty"))).toContain("No ticket references");
  });

  it("shows the derived branch, commit prefix and PR title for a reference alone", () => {
    seed({ refs: [RESOLVED], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    // These three strings are the point of the parse half — they are what a person otherwise
    // re-types into `git switch -c` by hand.
    expect(text(screen.getByTestId("ticket-intake-branch"))).toBe("eng-1234");
    expect(text(screen.getByTestId("ticket-intake-commit-prefix"))).toBe("ENG-1234:");
    expect(text(screen.getByTestId("ticket-intake-pr-title"))).toBe("ENG-1234:");
  });

  it("reads the paste box on Read references", () => {
    render(<TicketIntakePanel projectRoot={ROOT} />);
    fireEvent.change(screen.getByTestId("ticket-intake-paste"), {
      target: { value: "ENG-1234" },
    });
    fireEvent.click(screen.getByLabelText("Read references"));
    expect(parseMock).toHaveBeenCalledWith(ROOT, "ENG-1234");
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).text).toBe("ENG-1234");
  });

  it("will not fetch with nothing parsed", () => {
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(disabled(screen.getByLabelText("Fetch tickets"))).toBe(true);
  });
});

describe("ambiguity", () => {
  it("ASKS which tracker rather than naming one", () => {
    seed({ refs: [AMBIGUOUS], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    const card = screen.getByTestId(TICKET_INTAKE_CARD_TESTID);
    expect(card.getAttribute("data-ambiguous")).toBe("true");
    expect(text(screen.getByTestId("ticket-intake-provider"))).toBe("Linear or Jira — pick one");
    // And the backend's own note is shown, because it is the sentence that says how to fix it.
    expect(text(card)).toContain("no default_provider is set");
  });

  it("names the tracker when the reference resolved, and paints the card as resolved", () => {
    seed({ refs: [RESOLVED], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(screen.getByTestId(TICKET_INTAKE_CARD_TESTID).getAttribute("data-ambiguous")).toBe(
      "false",
    );
    expect(text(screen.getByTestId("ticket-intake-provider"))).toBe("Linear");
  });

  it("says why a reference cannot be fetched, before anyone presses a disabled button", () => {
    seed({ refs: [AMBIGUOUS], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(text(screen.getByTestId("ticket-intake-readiness"))).toContain("pick a tracker");
  });
});

describe("the fetched ticket", () => {
  it("shows the title and the title-derived branch, replacing the parse-only ones", () => {
    seed({ refs: [RESOLVED], tickets: [TICKET], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(text(screen.getByTestId("ticket-intake-title"))).toBe("Fix the login crash");
    expect(text(screen.getByTestId("ticket-intake-branch"))).toBe("eng-1234-fix-the-login-crash");
    expect(text(screen.getByTestId("ticket-intake-pr-title"))).toBe(
      "ENG-1234: Fix the login crash",
    );
  });

  it("COUNTS the screenshot that did not arrive, and gives it a tile of its own", () => {
    seed({ refs: [RESOLVED], tickets: [TICKET], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    // A Linear attachment link dies in ~5 minutes, so this is the expected failure. Two thumbnails
    // and no third tile would report the loss as an absence nobody could notice.
    expect(text(screen.getByTestId("ticket-intake-image-summary"))).toContain(
      "3 images, 1 could not be fetched",
    );
    const tiles = screen.getAllByTestId(TICKET_INTAKE_IMAGE_TESTID);
    expect(tiles).toHaveLength(3);
    const dead = tiles.filter((t) => t.getAttribute("data-ok") === "false");
    expect(dead).toHaveLength(1);
    // The REASON, not just a broken tile: an expired link and a 404 are different problems.
    expect(text(dead[0])).toContain("403 expired");
  });

  it("renders each arrived image as a `data:` URL, NEVER a file:// path", async () => {
    // The webview's CSP is `img-src 'self' data:` with no asset protocol, so a file:// src paints
    // a broken glyph — on the images that SUCCEEDED, where this panel deliberately shows no
    // failure reason. A good download would be indistinguishable from a dead one.
    seed({ refs: [RESOLVED], tickets: [TICKET], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    for (const img of screen.getAllByRole("img")) {
      const src = img.getAttribute("src") ?? "";
      expect(src.startsWith("data:image/")).toBe(true);
      expect(src.startsWith("file:")).toBe(false);
    }
    expect(imageMock).toHaveBeenCalledWith(ROOT, "/att/a.png");
    expect(imageMock).toHaveBeenCalledWith(ROOT, "/att/b.png");
  });

  it("shows a REASON when an arrived image cannot be read back, not a broken glyph", async () => {
    imageMock.mockRejectedValue(new Error("attachment vanished"));
    seed({ refs: [RESOLVED], tickets: [TICKET], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    await waitFor(() =>
      expect(text(screen.getAllByTestId(TICKET_INTAKE_IMAGE_TESTID)[0])).toContain(
        "attachment vanished",
      ),
    );
    // No <img> at all is the correct outcome here — an <img> with no usable src is the defect.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("never asks the backend to read back an image whose DOWNLOAD failed", async () => {
    seed({ refs: [RESOLVED], tickets: [TICKET], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    await waitFor(() => expect(imageMock).toHaveBeenCalledTimes(2));
    expect(imageMock).not.toHaveBeenCalledWith(ROOT, null);
  });

  it("never paints a NON-image attachment as an <img>", async () => {
    // A ticket can attach a log or a PDF. An <img> pointed at one is a broken glyph on a row
    // marked ok, with a byte count and no reason — the failure the data: URL work exists to close.
    //
    // DELIBERATELY A SHAPE THE WIRE NO LONGER PRODUCES: Rust sniffs the bytes and returns a
    // non-image as `ok: false`. This is the panel's OWN lock on the same door, and the only way to
    // exercise it is to hand it the shape Rust refuses to send.
    seed({
      refs: [RESOLVED],
      tickets: [
        {
          ...TICKET,
          images: [
            {
              sourceUrl: "https://u/log.txt",
              localPath: "/att/log.txt",
              ok: true,
              error: null,
              bytes: 90,
              mime: "text/plain",
            },
          ],
        },
      ],
      status: ON,
    });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(text(screen.getByTestId(TICKET_INTAKE_IMAGE_TESTID))).toContain("not an image");
    expect(imageMock).not.toHaveBeenCalled();
  });

  it("lists a per-reference failure separately from a command failure", () => {
    seed({
      refs: [RESOLVED, AMBIGUOUS],
      failures: [{ raw: "ABC-9", key: "ABC-9", provider: null, error: "pick a tracker" }],
      status: ON,
    });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    const row = screen.getByTestId(TICKET_INTAKE_FAILURE_TESTID);
    expect(text(row)).toContain("ABC-9");
    expect(text(row)).toContain("pick a tracker");
    // A per-ticket failure is not "we could not reach the backend".
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a command failure as an alert, in different words", () => {
    seed({ refs: [RESOLVED], error: "bridge is down", status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(text(screen.getByRole("alert"))).toContain("Couldn't reach ticket intake");
  });
});

describe("the off state", () => {
  it("explains that references are still parsed, rather than hiding the panel", () => {
    seed({ refs: [RESOLVED], status: { ...ON, enabled: false } });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    const note = text(screen.getByTestId("ticket-intake-disabled"));
    expect(note).toContain("references are parsed");
    expect(note).toContain("[ticket_intake].enabled = true");
    // The derived strings are still there — the half that needs no credential still works.
    expect(text(screen.getByTestId("ticket-intake-branch"))).toBe("eng-1234");
  });

  it("does NOT claim intake is off before a status has been read", () => {
    seed({ refs: [RESOLVED] });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    // "We have not looked" and "it is switched off" are different facts; conflating them tells a
    // user to edit a config file that is already correct.
    expect(screen.queryByTestId("ticket-intake-disabled")).toBeNull();
  });

  it("reads the status once on mount", () => {
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledWith(ROOT);
  });
});

describe("the fan-out button", () => {
  it("records the dispatch intent in the store, once per ticket", () => {
    seed({ refs: [RESOLVED], tickets: [TICKET], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    const btn = screen.getByLabelText("Send ENG-1234 to an agent");
    fireEvent.click(btn);
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).dispatchRequests).toEqual(["ENG-1234"]);
    // Idempotent, and the button says so rather than staying live for a second press.
    expect(disabled(screen.getByLabelText("Send ENG-1234 to an agent"))).toBe(true);
  });

  it("is unavailable until the ticket has actually been fetched", () => {
    seed({ refs: [RESOLVED], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    expect(disabled(screen.getByLabelText("Send ENG-1234 to an agent"))).toBe(true);
  });
});

describe("fetching", () => {
  it("sends the paste box text and disables the button while in flight", () => {
    seed({ refs: [RESOLVED], status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    fireEvent.change(screen.getByTestId("ticket-intake-paste"), {
      target: { value: "ENG-1234" },
    });
    fireEvent.click(screen.getByLabelText("Fetch tickets"));
    expect(fetchMock).toHaveBeenCalledWith(ROOT, "ENG-1234");
  });

  it("shows the in-flight label from the store, not from a local flag", () => {
    seed({ refs: [RESOLVED], fetching: true, status: ON });
    render(<TicketIntakePanel projectRoot={ROOT} />);
    const btn = screen.getByLabelText("Fetch tickets");
    expect(disabled(btn)).toBe(true);
    expect(text(btn)).toContain("Fetching…");
  });
});
