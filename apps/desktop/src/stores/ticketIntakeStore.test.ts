// ticketIntakeStore — the projection the panel renders from, and the three derivations that carry
// the feature's honesty: which tracker a reference belongs to, how many images did NOT arrive, and
// why a fetch is unavailable.
//
// EVERY FIXTURE CARRIES `null`, NOT AN ABSENT KEY. serde emits `Option::None` as an explicit null,
// so a fixture built with the key omitted tests a payload the wire cannot produce (bead
// `sparkle-16y6h`) — and it is exactly the AMBIGUOUS reference, the case this feature exists for,
// whose `provider` is null.
import { beforeEach, describe, expect, it } from "vitest";
import {
  emptyEntry,
  entryFor,
  fetchReadiness,
  humanBytes,
  imageSummary,
  isRenderableImage,
  providerLabel,
  providerSentence,
  useTicketIntakeStore,
  type IntakedImage,
  type TicketIntakeStatus,
  type TicketRef,
} from "./ticketIntakeStore";

const ROOT = "/repo";

/** A resolved reference, exactly as `ticket_intake.rs` serializes one. */
const RESOLVED: TicketRef = {
  raw: "https://linear.app/acme/issue/ENG-1234/fix-login",
  provider: "linear",
  candidates: [],
  ambiguous: false,
  key: "ENG-1234",
  url: "https://linear.app/acme/issue/ENG-1234/fix-login",
  branch: "eng-1234",
  commitPrefix: "ENG-1234:",
  prTitle: "ENG-1234:",
  note: null,
};

/** An AMBIGUOUS reference — `provider: null` on the wire, with the candidates listed. */
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

const STATUS: TicketIntakeStatus = {
  enabled: true,
  defaultProvider: null,
  providers: [
    { provider: "linear", enabled: true, configured: true, note: "credential configured" },
    { provider: "jira", enabled: true, configured: false, note: "set [ticket_intake.jira].base_url" },
    { provider: "github", enabled: true, configured: true, note: "uses the `gh` CLI" },
    { provider: "beads", enabled: false, configured: true, note: "reads the local beads store" },
  ],
  imageDir: ".sparkle/ticket-attachments",
};

beforeEach(() => {
  useTicketIntakeStore.setState({ byProject: {} });
});

describe("the store", () => {
  it("hands back ONE frozen blank entry, so a selector miss cannot loop React", () => {
    const a = entryFor(useTicketIntakeStore.getState(), ROOT);
    const b = entryFor(useTicketIntakeStore.getState(), "/other");
    expect(a).toBe(b);
    expect(a).toBe(emptyEntry());
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("folds refs, a batch and a status into one project's entry", () => {
    const s = useTicketIntakeStore.getState();
    s.applyRefs(ROOT, [RESOLVED, AMBIGUOUS]);
    s.applyBatch(ROOT, {
      tickets: [
        {
          provider: "linear",
          key: "ENG-1234",
          title: "Fix login",
          body: "b",
          comments: [],
          images: [],
          branch: "eng-1234-fix-login",
          commitPrefix: "ENG-1234:",
          prTitle: "ENG-1234: Fix login",
          url: null,
        },
      ],
      failures: [{ raw: "ABC-9", key: "ABC-9", provider: null, error: "pick a tracker" }],
    });
    s.applyStatus(ROOT, STATUS);
    const e = entryFor(useTicketIntakeStore.getState(), ROOT);
    expect(e.refs).toHaveLength(2);
    expect(e.tickets[0]!.prTitle).toBe("ENG-1234: Fix login");
    expect(e.failures[0]!.key).toBe("ABC-9");
    expect(e.status?.enabled).toBe(true);
  });

  it("keeps one project's paste out of another's", () => {
    useTicketIntakeStore.getState().applyRefs(ROOT, [RESOLVED]);
    expect(entryFor(useTicketIntakeStore.getState(), "/other").refs).toHaveLength(0);
  });

  it("records a dispatch intent once per ticket, in click order", () => {
    const s = useTicketIntakeStore.getState();
    s.requestDispatch(ROOT, "ENG-1234");
    s.requestDispatch(ROOT, "ABC-9");
    s.requestDispatch(ROOT, "ENG-1234");
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).dispatchRequests).toEqual([
      "ENG-1234",
      "ABC-9",
    ]);
  });

  it("forgets a project", () => {
    useTicketIntakeStore.getState().applyRefs(ROOT, [RESOLVED]);
    useTicketIntakeStore.getState().forget(ROOT);
    expect(entryFor(useTicketIntakeStore.getState(), ROOT)).toBe(emptyEntry());
  });
});

describe("providerSentence", () => {
  it("names the tracker when the reference resolved", () => {
    expect(providerSentence(RESOLVED)).toBe("Linear");
  });

  it("ASKS rather than answers when the reference is ambiguous", () => {
    // The whole feature: a bare key is valid in both, so the UI must pose the question. A sentence
    // naming one tracker here would be a guess the user never learns was made.
    expect(providerSentence(AMBIGUOUS)).toBe("Linear or Jira — pick one");
  });

  it("survives a null provider with no candidates rather than rendering 'undefined'", () => {
    expect(providerSentence({ ...AMBIGUOUS, candidates: [] })).toBe("Unknown tracker");
    expect(providerLabel(null)).toBe("Unknown tracker");
  });
});

describe("imageSummary", () => {
  const ok = (u: string): IntakedImage => ({
    sourceUrl: u,
    localPath: `/att/${u}.png`,
    ok: true,
    error: null,
    bytes: 2048,
    mime: "image/png",
  });
  const dead = (u: string): IntakedImage => ({
    sourceUrl: u,
    localPath: null,
    ok: false,
    error: "403 expired",
    bytes: 0,
    mime: "",
  });

  it("COUNTS the ones that did not arrive", () => {
    // A Linear attachment link dies in ~5 minutes, so this is the expected failure, not an exotic
    // one. "2 images" would report the loss as an absence nobody could notice.
    expect(imageSummary([ok("a"), ok("b"), dead("c")])).toBe("3 images, 1 could not be fetched");
  });

  it("says nothing when there were none, and stays singular for one", () => {
    expect(imageSummary([])).toBe("");
    expect(imageSummary([ok("a")])).toBe("1 image");
  });

  it("reports a total loss as a total loss", () => {
    expect(imageSummary([dead("a"), dead("b")])).toBe("2 images, 2 could not be fetched");
  });
});

describe("isRenderableImage", () => {
  const base = {
    sourceUrl: "https://u/a",
    localPath: "/att/a",
    ok: true,
    error: null,
    bytes: 10,
    mime: "image/png",
  };

  it("is true only for an arrived file that IS an image", () => {
    expect(isRenderableImage(base)).toBe(true);
    // A ticket can attach a log or a PDF; an <img> pointed at one paints a broken glyph on a row
    // marked ok, with a byte count and no reason.
    expect(isRenderableImage({ ...base, mime: "text/plain" })).toBe(false);
    expect(isRenderableImage({ ...base, mime: "application/octet-stream" })).toBe(false);
    expect(isRenderableImage({ ...base, ok: false })).toBe(false);
    expect(isRenderableImage({ ...base, localPath: null })).toBe(false);
  });

  it("survives a payload with no mime at all rather than rendering one", () => {
    expect(isRenderableImage({ ...base, mime: undefined as unknown as string })).toBe(false);
  });
});

describe("fetchReadiness", () => {
  it("distinguishes 'we have not looked' from 'intake is off'", () => {
    // Collapsing these tells a user to edit a config file that is already correct.
    expect(fetchReadiness(null, "linear").reason).toContain("checking");
    expect(fetchReadiness({ ...STATUS, enabled: false }, "linear").reason).toContain(
      "ticket intake is off",
    );
  });

  it("refuses an ambiguous reference before it refuses a credential", () => {
    const r = fetchReadiness(STATUS, null);
    expect(r.ready).toBe(false);
    expect(r.reason).toContain("pick a tracker");
  });

  it("hands back the provider's own note when it is not configured", () => {
    const r = fetchReadiness(STATUS, "jira");
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("set [ticket_intake.jira].base_url");
  });

  it("names a switched-off provider rather than calling it unconfigured", () => {
    expect(fetchReadiness(STATUS, "beads").reason).toBe("beads is switched off");
  });

  it("is ready only when the provider is enabled AND configured", () => {
    expect(fetchReadiness(STATUS, "linear").ready).toBe(true);
    expect(fetchReadiness(STATUS, "github").ready).toBe(true);
  });
});

describe("humanBytes", () => {
  it("reads as bytes, KB and MB", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(humanBytes(0)).toBe("—");
  });
});
