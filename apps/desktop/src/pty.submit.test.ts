import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  chainPtyOp,
  pasteIntoPty,
  stripPasteMarkers,
  submitPrompt,
  PtyGoneError,
  writePty,
  writePtyChained,
  writePtyChainedStrict,
} from "./pty";

const ESC = String.fromCharCode(27);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("submitPrompt", () => {
  it("wraps the text in a bracketed paste, then sends a carriage return", async () => {
    vi.useFakeTimers();
    try {
      const p = submitPrompt("a1", "give me a status update", { machine: false });
      await vi.runAllTimersAsync();
      await p;
      expect(invoke).toHaveBeenNthCalledWith(1, "pty_write", {
        id: "a1",
        data: `${ESC}[200~give me a status update${ESC}[201~`,
      });
      expect(invoke).toHaveBeenNthCalledWith(2, "pty_write", { id: "a1", data: "\r" });
    } finally {
      vi.useRealTimers();
    }
  });

  // The bug: an agent whose PTY died kept accepting prompts. pty_write returned
  // Err("no such pty"), writePty swallowed it, submitPrompt resolved as success, and the
  // composer recorded the prompt into history — so the prompt vanished with no feedback.
  // A deliberate user submit must NEVER be silently dropped.
  it("strips embedded paste markers, like every other paste this module frames", async () => {
    // roborev 2197, reopened at 54397: the guard used to live in ONE caller
    // (selectionActions.fixInAgent), so submitPrompt's untrusted-text callers — the concierge
    // free-text path, conciergeTools' sendToAgentTerminal — pasted phone-relayed and model-authored
    // strings unstripped. A payload that closes paste mode mid-flight has its tail read as
    // KEYSTROKES.
    vi.useFakeTimers();
    try {
      const p = submitPrompt("a1", `fix this${ESC}[201~rm -rf ~`, { machine: false });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(invoke).toHaveBeenNthCalledWith(1, "pty_write", {
      id: "a1",
      data: `${ESC}[200~fix thisrm -rf ~${ESC}[201~`,
    });
  });

  it("rejects with PtyGoneError when the paste lands on a dead PTY", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("dead", "land it to main", { machine: false })).rejects.toBeInstanceOf(PtyGoneError);
  });

  it("rejects with PtyGoneError when the PTY dies between the paste and the carriage return", async () => {
    invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("no such pty"));
    vi.useFakeTimers();
    try {
      const p = submitPrompt("dead", "land it to main", { machine: false });
      const assertion = expect(p).rejects.toBeInstanceOf(PtyGoneError);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the agent id on the error so the caller can restart that agent", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("agent-7", "hi", { machine: false })).rejects.toMatchObject({ id: "agent-7" });
  });

  it("does not send the carriage return when the paste failed", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("dead", "hi", { machine: false })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-teardown write error unchanged", async () => {
    invoke.mockRejectedValueOnce(new Error("disk on fire"));
    await expect(submitPrompt("a1", "hi", { machine: false })).rejects.toThrow("disk on fire");
  });

  // Fire-and-forget callers (stray keystrokes, resizes) still swallow the teardown race —
  // that swallow was correct for them, it was only wrong on the deliberate submit path.
  it("leaves writePty's teardown-race swallow intact for fire-and-forget callers", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(writePty("dead", "x")).resolves.toBeUndefined();
  });

  // Two concurrent submits to the SAME agent must not interleave their paste/CR writes,
  // which would submit one prompt's text with the other's carriage return.
  it("serializes concurrent submits to the same agent", async () => {
    vi.useFakeTimers();
    try {
      const a = submitPrompt("same", "first", { machine: false });
      const b = submitPrompt("same", "second", { machine: false });
      await vi.runAllTimersAsync();
      await Promise.all([a, b]);
      const data = invoke.mock.calls.map((c) => (c[1] as { data: string }).data);
      expect(data).toEqual([
        `${ESC}[200~first${ESC}[201~`,
        "\r",
        `${ESC}[200~second${ESC}[201~`,
        "\r",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a failed submit wedge the agent's queue", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("same", "doomed", { machine: false })).rejects.toThrow();
    invoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
    try {
      const p = submitPrompt("same", "recovered", { machine: false });
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(invoke).toHaveBeenLastCalledWith("pty_write", { id: "same", data: "\r" });
  });
});

// The no-carriage-return sibling of submitPrompt: text lands at the CLI's current input line and
// stops there. Used by the terminal drop path (hooks/useTerminalDrop) and the selection popup —
// both of which INSERT for the user to edit, and must never fire a turn the user didn't write.
describe("pasteIntoPty", () => {
  it("wraps the text in a bracketed paste and sends NO carriage return", async () => {
    await pasteIntoPty("a1", "/tmp/shot.png ");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("pty_write", {
      id: "a1",
      data: `${ESC}[200~/tmp/shot.png ${ESC}[201~`,
    });
  });

  it("never lands BETWEEN another write's paste and its carriage return", async () => {
    // THE RACE (roborev 54369). deliverSubmit leaves a deliberate 60ms gap before its \r. An
    // unchained paste landing in that gap is appended to the in-flight prompt and then submitted by
    // that pending CR — a turn the user never pressed Enter on, carrying paths they never approved,
    // while the drop's confirmation says nothing has been sent.
    vi.useFakeTimers();
    try {
      const submit = submitPrompt("a1", "status?", { machine: false });
      const paste = pasteIntoPty("a1", "/tmp/shot.png ");
      await vi.runAllTimersAsync();
      await Promise.all([submit, paste]);
    } finally {
      vi.useRealTimers();
    }
    expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
      `${ESC}[200~status?${ESC}[201~`,
      "\r",
      `${ESC}[200~/tmp/shot.png ${ESC}[201~`,
    ]);
  });

  it("does not wedge the chain when the submit ahead of it failed", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    const submit = submitPrompt("a1", "doomed", { machine: false });
    await expect(submit).rejects.toThrow();
    invoke.mockResolvedValue(undefined);
    await pasteIntoPty("a1", "/tmp/shot.png ");
    expect(invoke).toHaveBeenLastCalledWith("pty_write", {
      id: "a1",
      data: `${ESC}[200~/tmp/shot.png ${ESC}[201~`,
    });
  });

  it("rejects with PtyGoneError on a dead PTY rather than swallowing it", async () => {
    // Same reasoning as submitPrompt: this is a deliberate user action, so "it went nowhere" has
    // to be reportable. writePty's tolerant swallow is for the teardown race, not for this.
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(pasteIntoPty("dead", "/tmp/a.png ")).rejects.toBeInstanceOf(PtyGoneError);
  });

  it("strips embedded paste markers so the tail can't be read as keystrokes", async () => {
    // roborev 2197: a payload that closes paste mode early turns the rest into typed input.
    await pasteIntoPty("a1", `/tmp/a.png${ESC}[201~rm -rf ~`);
    expect(invoke).toHaveBeenCalledWith("pty_write", {
      id: "a1",
      data: `${ESC}[200~/tmp/a.pngrm -rf ~${ESC}[201~`,
    });
  });
});

describe("stripPasteMarkers", () => {
  it("removes both markers", () => {
    expect(stripPasteMarkers(`a${ESC}[200~b${ESC}[201~c`)).toBe("abc");
  });

  it("loops until stable, so a removal cannot reconstitute a marker from its neighbors", () => {
    // roborev 2210 — one pass turns this into a live marker; the loop is what kills it.
    expect(stripPasteMarkers(`${ESC}[20${ESC}[201~1~`)).toBe("");
  });

  it("leaves ordinary text alone", () => {
    expect(stripPasteMarkers("/Users/me/My Photos/a.png")).toBe("/Users/me/My Photos/a.png");
  });
});

// A single write is atomic, which is why these were unchained for a long time — but the hazard is
// not "this write gets split", it is "this write lands inside SOMEONE ELSE'S paste→CR window". The
// picker answer, the auto-approve keystroke and the phone relay all carry their own carriage
// return, so an interleaved one submits the in-flight prompt with a stray digit appended and leaves
// the picker unanswered (roborev 54375).
describe("writePtyChained", () => {
  it("never lands between another write's paste and its carriage return", async () => {
    vi.useFakeTimers();
    try {
      const submit = submitPrompt("a1", "status?", { machine: false });
      const answer = writePtyChained("a1", "2\r");
      await vi.runAllTimersAsync();
      await Promise.all([submit, answer]);
    } finally {
      vi.useRealTimers();
    }
    expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
      `${ESC}[200~status?${ESC}[201~`,
      "\r",
      "2\r",
    ]);
  });

  it("keeps writePty's tolerance for the dead-PTY teardown race", async () => {
    // Unlike pasteIntoPty this is not a deliberate user action with a confirmation to correct —
    // it inherits the swallow so a keystroke racing a closing pane doesn't log an error storm.
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(writePtyChained("dead", "y\r")).resolves.toBeUndefined();
  });
});

describe("writePtyChainedStrict", () => {
  it("rejects with PtyGoneError where the tolerant variant would resolve", async () => {
    // The concierge picker path catches PtyGoneError and reports "I couldn't reach that terminal".
    // Against the tolerant variant that branch is unreachable, so the path claimed a delivery that
    // never happened (roborev 54387) — the same failure submitPrompt was made strict to prevent.
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(writePtyChainedStrict("dead", "2\r")).rejects.toBeInstanceOf(PtyGoneError);
  });

  it("queues like the tolerant one", async () => {
    vi.useFakeTimers();
    try {
      const submit = submitPrompt("a1", "status?", { machine: false });
      const answer = writePtyChainedStrict("a1", "2\r");
      await vi.runAllTimersAsync();
      await Promise.all([submit, answer]);
    } finally {
      vi.useRealTimers();
    }
    expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
      `${ESC}[200~status?${ESC}[201~`,
      "\r",
      "2\r",
    ]);
  });
});

// The whole-operation form, for multi-write sequences this module does not own — services/agentModel
// types `/model <id>`, waits 200ms, then sends Enter. It used to run that on a PRIVATE chain, which
// ordered model picks against each other and against nothing else, so a composer send landing in
// that 200ms window produced "/model claude-opus-5<user prompt>" as one garbled slash-command line
// (roborev 54387).
describe("chainPtyOp", () => {
  it("keeps a foreign multi-write op and a submit from interleaving, in either order", async () => {
    vi.useFakeTimers();
    try {
      const submit = submitPrompt("a1", "status?", { machine: false });
      const op = chainPtyOp("a1", async () => {
        await writePty("a1", "/model x");
        await new Promise((r) => setTimeout(r, 200));
        await writePty("a1", "\r");
      });
      await vi.runAllTimersAsync();
      await Promise.all([submit, op]);
    } finally {
      vi.useRealTimers();
    }
    expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
      `${ESC}[200~status?${ESC}[201~`,
      "\r",
      "/model x",
      "\r",
    ]);
  });
});
