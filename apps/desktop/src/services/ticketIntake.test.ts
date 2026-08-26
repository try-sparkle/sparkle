// ticketIntake service — the fetch coalescer, the frozen invoke contract, and the two failure
// directions that must not be collapsed: a command that could not run, versus a fetch that ran and
// could not read some of the tickets.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  fetchTicketIntakeStatus,
  fetchTickets,
  loadTicketImage,
  parseTicketRefs,
} from "./ticketIntake";
import {
  entryFor,
  useTicketIntakeStore,
  type BatchResult,
  type TicketIntakeStatus,
  type TicketRef,
} from "../stores/ticketIntakeStore";

const ROOT = "/repo";

const REF: TicketRef = {
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

const BATCH: BatchResult = {
  tickets: [
    {
      provider: "linear",
      key: "ENG-1234",
      title: "Fix login",
      body: "body",
      comments: [],
      images: [
        { sourceUrl: "https://u/a.png", localPath: "/att/a.png", ok: true, error: null, bytes: 12, mime: "image/png" },
        { sourceUrl: "https://u/b.png", localPath: null, ok: false, error: "403", bytes: 0, mime: "" },
      ],
      branch: "eng-1234-fix-login",
      commitPrefix: "ENG-1234:",
      prTitle: "ENG-1234: Fix login",
      url: null,
    },
  ],
  failures: [{ raw: "ABC-9", key: "ABC-9", provider: null, error: "pick a tracker" }],
};

const STATUS: TicketIntakeStatus = {
  enabled: true,
  defaultProvider: "linear",
  providers: [
    { provider: "linear", enabled: true, configured: true, note: "credential configured" },
  ],
  imageDir: ".sparkle/ticket-attachments",
};

beforeEach(() => {
  invoke.mockReset();
  useTicketIntakeStore.setState({ byProject: {} });
});

describe("parseTicketRefs", () => {
  it("calls the frozen command with camelCase args and folds the refs in", async () => {
    invoke.mockResolvedValue([REF]);
    const refs = await parseTicketRefs(ROOT, "ENG-1234");
    expect(invoke).toHaveBeenCalledWith("ticket_intake_parse", {
      projectRoot: ROOT,
      text: "ENG-1234",
    });
    expect(refs).toEqual([REF]);
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).refs).toEqual([REF]);
  });

  it("treats text with no reference as an empty ANSWER, not a failure", async () => {
    invoke.mockResolvedValue([]);
    await parseTicketRefs(ROOT, "the login page is slow");
    const e = entryFor(useTicketIntakeStore.getState(), ROOT);
    expect(e.refs).toEqual([]);
    expect(e.error).toBeNull();
  });

  it("records a command failure without throwing at the caller", async () => {
    invoke.mockRejectedValue(new Error("bridge is down"));
    const refs = await parseTicketRefs(ROOT, "ENG-1234");
    expect(refs).toEqual([]);
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).error).toContain("bridge is down");
  });
});

describe("fetchTickets", () => {
  it("folds the per-reference outcomes in and clears the in-flight flag", async () => {
    invoke.mockResolvedValue(BATCH);
    const out = await fetchTickets(ROOT, "ENG-1234 ABC-9");
    expect(invoke).toHaveBeenCalledWith("ticket_intake_fetch", {
      projectRoot: ROOT,
      text: "ENG-1234 ABC-9",
    });
    expect(out.tickets).toHaveLength(1);
    const e = entryFor(useTicketIntakeStore.getState(), ROOT);
    expect(e.tickets[0]!.images).toHaveLength(2);
    expect(e.failures[0]!.key).toBe("ABC-9");
    expect(e.fetching).toBe(false);
  });

  it("COALESCES two overlapping fetches into one backend call", async () => {
    // Not tidiness: a fetch downloads every screenshot into one content-addressed directory, so a
    // second concurrent run duplicates the network and races on the same paths.
    let settle: (v: BatchResult) => void = () => {};
    invoke.mockImplementation(
      () =>
        new Promise<BatchResult>((res) => {
          settle = res;
        }),
    );
    const a = fetchTickets(ROOT, "ENG-1");
    const b = fetchTickets(ROOT, "ENG-1");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).fetching).toBe(true);
    settle(BATCH);
    // The LATE caller gets the winner's real outcome, not a silent skip — a skip would leave it
    // with nothing to render.
    await expect(a).resolves.toEqual(BATCH);
    await expect(b).resolves.toEqual(BATCH);
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).fetching).toBe(false);
  });

  it("does not coalesce across projects", async () => {
    invoke.mockResolvedValue(BATCH);
    await Promise.all([fetchTickets(ROOT, "ENG-1"), fetchTickets("/other", "ENG-1")]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("clears fetching AND the in-flight slot when the command itself fails", async () => {
    invoke.mockRejectedValueOnce(new Error("bridge is down"));
    await expect(fetchTickets(ROOT, "ENG-1")).rejects.toThrow("bridge is down");
    const e = entryFor(useTicketIntakeStore.getState(), ROOT);
    expect(e.fetching).toBe(false);
    expect(e.error).toContain("bridge is down");
    // A stuck in-flight entry would mean this project could never fetch again this session.
    invoke.mockResolvedValueOnce(BATCH);
    await expect(fetchTickets(ROOT, "ENG-1")).resolves.toEqual(BATCH);
  });

  it("a per-reference failure is NOT a command failure", async () => {
    invoke.mockResolvedValue({ tickets: [], failures: BATCH.failures });
    await fetchTickets(ROOT, "ABC-9");
    const e = entryFor(useTicketIntakeStore.getState(), ROOT);
    expect(e.failures).toHaveLength(1);
    expect(e.error).toBeNull();
  });

  it("survives a reply missing its arrays rather than throwing at render time", async () => {
    invoke.mockResolvedValue({} as BatchResult);
    const out = await fetchTickets(ROOT, "ENG-1");
    expect(out).toEqual({ tickets: [], failures: [] });
  });
});

describe("fetchTicketIntakeStatus", () => {
  it("folds a status in", async () => {
    invoke.mockResolvedValue(STATUS);
    await fetchTicketIntakeStatus(ROOT);
    expect(invoke).toHaveBeenCalledWith("ticket_intake_status", { projectRoot: ROOT });
    expect(entryFor(useTicketIntakeStore.getState(), ROOT).status).toEqual(STATUS);
  });

  it("LEAVES a status we already hold alone when the next read fails", async () => {
    // A transient bridge failure must not render as "your ticket intake is disabled" — a sentence
    // that sends someone to edit a config file that is already correct.
    invoke.mockResolvedValueOnce(STATUS);
    await fetchTicketIntakeStatus(ROOT);
    invoke.mockRejectedValueOnce(new Error("bridge is down"));
    await fetchTicketIntakeStatus(ROOT);
    const e = entryFor(useTicketIntakeStore.getState(), ROOT);
    expect(e.status).toEqual(STATUS);
    expect(e.error).toContain("bridge is down");
  });
});

describe("loadTicketImage", () => {
  const DATA = "data:image/png;base64,AAAA";

  it("asks the backend for the bytes, by the frozen command name", async () => {
    invoke.mockResolvedValue(DATA);
    await expect(loadTicketImage(ROOT, "/att/one.png")).resolves.toBe(DATA);
    expect(invoke).toHaveBeenCalledWith("ticket_intake_image", {
      projectRoot: ROOT,
      path: "/att/one.png",
    });
  });

  it("caches a SUCCESSFUL read, because a data URL is the whole file", async () => {
    invoke.mockResolvedValue(DATA);
    await loadTicketImage(ROOT, "/att/cached.png");
    await loadTicketImage(ROOT, "/att/cached.png");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure — one unlucky read must not be permanent for the session", async () => {
    invoke.mockRejectedValueOnce(new Error("mid-write"));
    await expect(loadTicketImage(ROOT, "/att/retry.png")).rejects.toThrow("mid-write");
    invoke.mockResolvedValueOnce(DATA);
    await expect(loadTicketImage(ROOT, "/att/retry.png")).resolves.toBe(DATA);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("BOUNDS the cache — a decoded screenshot is a whole file held in the renderer", async () => {
    invoke.mockResolvedValue(DATA);
    // 25 distinct paths against a cap of 24: the first must have been evicted, so re-reading it
    // costs a second invoke while a recent one still does not.
    for (let i = 0; i < 25; i += 1) {
      await loadTicketImage(ROOT, `/att/bound-${i}.png`);
    }
    expect(invoke).toHaveBeenCalledTimes(25);
    await loadTicketImage(ROOT, "/att/bound-24.png");
    expect(invoke).toHaveBeenCalledTimes(25);
    await loadTicketImage(ROOT, "/att/bound-0.png");
    expect(invoke).toHaveBeenCalledTimes(26);
  });

  it("treats an empty reply as a failure rather than a blank image", async () => {
    invoke.mockResolvedValue("");
    await expect(loadTicketImage(ROOT, "/att/empty.png")).rejects.toThrow("no data came back");
  });
});
