import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createLibrarian,
  parseFindings,
  LIBRARIAN_PROMPT,
  SKEPTIC_PROMPT,
  SKEPTIC_INSTRUCTIONS,
  SKEPTIC_SKILL_NAME,
  type LibrarianDeps,
  type TurnContext,
} from "./librarian";

const ctx: TurnContext = { agentId: "a1", pat: "pat", chiefProjectId: "proj", conversation: "hi" };

function makeDeps(over: Partial<LibrarianDeps> = {}) {
  const startChat = vi.fn().mockResolvedValue({ chat_id: "c", message_id: "m" });
  const pollForResponse = vi.fn().mockResolvedValue("- a finding");
  const ensureSkill = vi.fn().mockResolvedValue(SKEPTIC_SKILL_NAME);
  const setLane = vi.fn();
  const setStatus = vi.fn();
  const deps: LibrarianDeps = {
    startChat: startChat as unknown as LibrarianDeps["startChat"],
    pollForResponse: pollForResponse as unknown as LibrarianDeps["pollForResponse"],
    ensureSkill: ensureSkill as unknown as LibrarianDeps["ensureSkill"],
    setLane,
    setStatus,
    debounceMs: 800,
    now: () => 1000,
    ...over,
  };
  return { deps, startChat, pollForResponse, ensureSkill, setLane, setStatus };
}

describe("parseFindings", () => {
  it("returns [] for empty / whitespace markdown", () => {
    expect(parseFindings("", 1)).toEqual([]);
    expect(parseFindings("   \n\n  ", 1)).toEqual([]);
  });

  it("splits bullet lines into items and extracts markdown link targets as docRefs", () => {
    const md = [
      "- Prior decision in [Spec One](docs/spec-one.md) conflicts here",
      "* See [Doc Two](PRD/two.md) and [Doc Three](PRD/three.md)",
      "1. A numbered finding with no link",
    ].join("\n");
    const items = parseFindings(md, 42);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      text: "Prior decision in [Spec One](docs/spec-one.md) conflicts here",
      docRefs: ["docs/spec-one.md"],
      ts: 42,
    });
    expect(items[1]!.docRefs).toEqual(["PRD/two.md", "PRD/three.md"]);
    expect(items[2]!.docRefs).toEqual([]);
  });

  it("falls back to blank-line paragraphs when there are no bullets", () => {
    const md = "First paragraph with [L](a.md).\n\nSecond paragraph.";
    const items = parseFindings(md, 7);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ text: "First paragraph with [L](a.md).", docRefs: ["a.md"], ts: 7 });
    expect(items[1]!.text).toBe("Second paragraph.");
  });
});

describe("createLibrarian", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounce coalesces rapid turns into a single fire", async () => {
    const { deps, startChat, ensureSkill, setStatus } = makeDeps();
    const lib = createLibrarian(deps);

    lib.onUserTurn(ctx);
    lib.onUserTurn(ctx);
    lib.onUserTurn(ctx);
    // Not yet fired before the debounce elapses.
    expect(startChat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);

    // One fire = two lanes (grounding + challenges) → two startChat calls, one ensureSkill.
    expect(startChat).toHaveBeenCalledTimes(2);
    expect(ensureSkill).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith("a1", "thinking");
    expect(setStatus).toHaveBeenLastCalledWith("a1", "idle");
  });

  it("fires both lanes with fast intelligence + project scope; skeptic carries the skill", async () => {
    const { deps, startChat, ensureSkill } = makeDeps();
    const lib = createLibrarian(deps);

    lib.onUserTurn({ ...ctx, conceptIds: ["concept_1"] });
    await vi.advanceTimersByTimeAsync(800);

    expect(ensureSkill).toHaveBeenCalledWith(
      "pat",
      "proj",
      SKEPTIC_SKILL_NAME,
      SKEPTIC_INSTRUCTIONS,
      "persona",
    );

    const groundingCall = startChat.mock.calls[0]!;
    const skepticCall = startChat.mock.calls[1]!;
    expect(groundingCall[0]).toBe("pat");
    expect(groundingCall[1]).toBe("proj");
    expect(groundingCall[2]).toBe(LIBRARIAN_PROMPT("hi"));
    expect(groundingCall[3]).toEqual({
      intelligence: "fast",
      scope: { project_ids: ["proj"], concept_ids: ["concept_1"] },
    });
    // grounding lane carries no skills
    expect(groundingCall[3].skills).toBeUndefined();

    expect(skepticCall[2]).toBe(SKEPTIC_PROMPT("hi"));
    expect(skepticCall[3]).toEqual({
      intelligence: "fast",
      scope: { project_ids: ["proj"], concept_ids: ["concept_1"] },
      skills: [SKEPTIC_SKILL_NAME],
    });
  });

  it("omits concept_ids from scope when none are provided", async () => {
    const { deps, startChat } = makeDeps();
    const lib = createLibrarian(deps);
    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800);
    expect(startChat.mock.calls[0]![3].scope).toEqual({ project_ids: ["proj"] });
  });

  it("populates grounding and challenges lanes from the two responses, with docRefs", async () => {
    const { deps, startChat, pollForResponse, setLane } = makeDeps();
    startChat
      .mockResolvedValueOnce({ chat_id: "c1", message_id: "m1" })
      .mockResolvedValueOnce({ chat_id: "c2", message_id: "m2" });
    pollForResponse.mockImplementation((_p: string, _pid: string, chatId: string) =>
      Promise.resolve(
        chatId === "c1"
          ? "- grounding point [Doc A](docs/a.md)"
          : "- challenge point [Doc B](docs/b.md)",
      ),
    );

    const lib = createLibrarian(deps);
    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800);

    expect(setLane).toHaveBeenCalledWith("a1", "grounding", [
      { text: "grounding point [Doc A](docs/a.md)", docRefs: ["docs/a.md"], ts: 1000 },
    ]);
    expect(setLane).toHaveBeenCalledWith("a1", "challenges", [
      { text: "challenge point [Doc B](docs/b.md)", docRefs: ["docs/b.md"], ts: 1000 },
    ]);
  });

  it("a new turn aborts the previous in-flight query and re-fires", async () => {
    const { deps, startChat, pollForResponse } = makeDeps();
    // First fire's polls hang until aborted (so the second turn can interrupt them).
    pollForResponse.mockImplementation(
      (_p: string, _pid: string, _c: string, _m: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const lib = createLibrarian(deps);
    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800);

    expect(startChat).toHaveBeenCalledTimes(2);
    const firstSignal: AbortSignal = pollForResponse.mock.calls[0]![4].signal;
    expect(firstSignal.aborted).toBe(false);

    // A fresh turn aborts the in-flight queries synchronously.
    lib.onUserTurn(ctx);
    expect(firstSignal.aborted).toBe(true);

    // ...and re-fires after the debounce (skill already ensured → no second ensureSkill).
    pollForResponse.mockResolvedValue("- new finding");
    await vi.advanceTimersByTimeAsync(800);
    expect(startChat).toHaveBeenCalledTimes(4);
  });

  it("does not publish a lane when its poll resolves AFTER the turn was aborted (stale-write guard)", async () => {
    const { deps, pollForResponse, setLane } = makeDeps();
    // Model the REAL pollForResponse: it can resolve with data even after the signal aborts (the
    // signal is only checked at the top of each poll iteration). Capture each call's resolver so the
    // test resolves it manually after a newer turn has aborted the first turn.
    const resolvers: Array<(md: string) => void> = [];
    pollForResponse.mockImplementation(
      () => new Promise<string>((resolve) => resolvers.push(resolve)),
    );

    const lib = createLibrarian(deps);
    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800); // first turn's two lanes are now polling
    expect(resolvers).toHaveLength(2);

    // A newer turn aborts the first turn's in-flight queries...
    lib.onUserTurn(ctx);
    // ...but the first turn's polls resolve anyway (stale data in hand).
    resolvers[0]!("- stale finding");
    resolvers[1]!("- stale finding");
    await vi.advanceTimersByTimeAsync(0);

    // The guard must have suppressed both stale lane writes.
    expect(setLane).not.toHaveBeenCalled();
  });

  it("never throws and stays out of 'error' when one lane succeeds", async () => {
    const { deps, startChat, pollForResponse, setLane, setStatus } = makeDeps();
    startChat
      .mockResolvedValueOnce({ chat_id: "c1", message_id: "m1" })
      .mockResolvedValueOnce({ chat_id: "c2", message_id: "m2" });
    pollForResponse.mockImplementation((_p: string, _pid: string, chatId: string) =>
      chatId === "c1" ? Promise.reject(new Error("boom")) : Promise.resolve("- ok"),
    );

    const lib = createLibrarian(deps);
    expect(() => lib.onUserTurn(ctx)).not.toThrow();
    await vi.advanceTimersByTimeAsync(800);

    // The surviving lane still populated; status settled to idle, never error.
    expect(setLane).toHaveBeenCalledWith("a1", "challenges", [
      { text: "ok", docRefs: [], ts: 1000 },
    ]);
    expect(setStatus).toHaveBeenLastCalledWith("a1", "idle");
    expect(setStatus).not.toHaveBeenCalledWith("a1", "error");
  });

  it("sets 'error' only when BOTH lanes fail", async () => {
    const { deps, pollForResponse, setLane, setStatus } = makeDeps();
    pollForResponse.mockRejectedValue(new Error("boom"));

    const lib = createLibrarian(deps);
    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800);

    expect(setLane).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith("a1", "error");
  });

  it("ensures the skeptic skill only once across multiple turns for the same project", async () => {
    const { deps, ensureSkill } = makeDeps();
    const lib = createLibrarian(deps);

    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800);
    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800);
    lib.onUserTurn(ctx);
    await vi.advanceTimersByTimeAsync(800);

    expect(ensureSkill).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending debounce so no fire happens", async () => {
    const { deps, startChat } = makeDeps();
    const lib = createLibrarian(deps);
    lib.onUserTurn(ctx);
    lib.dispose();
    await vi.advanceTimersByTimeAsync(800);
    expect(startChat).not.toHaveBeenCalled();
  });
});
