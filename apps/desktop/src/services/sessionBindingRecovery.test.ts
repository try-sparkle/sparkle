// Tests for sessionBindingRecovery — see that module's header for the safety contract.
//
// Every case here asserts the SIDE EFFECT (what `recoverSessionBinding` RETURNED), never a
// precondition, per AGENTS.md: an assertion that would pass against the code as it was before the
// change proves nothing. The single most important one is `returns null when the chosen transcript
// does not exist` — that is the case that would otherwise register a binding naming an unreadable
// file and leave the pane in a permanently-failing read instead of an honest empty state.
import { describe, expect, it, vi } from "vitest";
import { recoverSessionBinding, type ReadEventsFn } from "./sessionBindingRecovery";

const ACCOUNT_DIR = "/Users/x/Library/Application Support/ai.sparkle.desktop/accounts/acct-1";
const HOME_DIR = "/Users/x/.claude";

function line(ev: Record<string, unknown>): string {
  return JSON.stringify(ev);
}

/**
 * A reader that behaves like the Rust `read_events_since` command does, because the tail read
 * depends on those exact semantics: `skipExisting` returns the file LENGTH without reading, an
 * offset mid-file yields the bytes from there through the last newline (so the first line is a
 * FRAGMENT), and empty lines are dropped. Copying the real behaviour is what makes the
 * window-bounding test meaningful rather than a test of a convenient fake.
 */
function readerFor(lines: string[]): ReadEventsFn {
  const buf = lines.length === 0 ? "" : lines.join("\n") + "\n";
  const size = Buffer.byteLength(buf, "utf8");
  return async (_logPath, offset, skipExisting) => {
    if (skipExisting) return { lines: [], offset: size };
    const bytes = Buffer.from(buf, "utf8").subarray(offset);
    const text = bytes.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    const usable = lastNl < 0 ? "" : text.slice(0, lastNl + 1);
    return {
      lines: usable.split("\n").filter((s) => s !== ""),
      offset: offset + Buffer.byteLength(usable, "utf8"),
    };
  };
}

const alwaysExists = async (): Promise<boolean> => true;
const neverExists = async (): Promise<boolean> => false;

function call(
  lines: string[],
  opts: {
    exists?: (p: string) => Promise<boolean>;
    read?: ReadEventsFn;
    tailBytes?: number;
  } = {},
) {
  return recoverSessionBinding({
    agentId: "agent-1",
    logPath: "/app-data/hook-events/agent-1.jsonl",
    read: opts.read ?? readerFor(lines),
    exists: opts.exists ?? alwaysExists,
    tailBytes: opts.tailBytes,
  });
}

describe("recoverSessionBinding", () => {
  it("picks the MOST RECENT turn-opener's session when several sessions share one log", async () => {
    // The log is keyed by WORKTREE, so it interleaves sessions. `sess-old` opened first and even
    // emitted the LAST tool event; the newest turn-opener is `sess-new`, and that is the answer.
    const got = await call([
      line({
        event: "SessionStart",
        session_id: "sess-old",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/sess-old.jsonl`,
      }),
      line({
        event: "UserPromptSubmit",
        session_id: "sess-new",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/sess-new.jsonl`,
      }),
      line({
        event: "PostToolUse",
        session_id: "sess-old",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/sess-old.jsonl`,
      }),
    ]);
    expect(got).toEqual({ sessionId: "sess-new", configDir: ACCOUNT_DIR });
  });

  it("returns null when the chosen session's transcript does NOT exist on disk", async () => {
    // THE MOST IMPORTANT CASE. Measured: 2 of 6 unbound agents resolved to a file under a
    // since-removed account. Accepting one registers a binding naming a file nothing can read.
    const lines = [
      line({
        event: "SessionStart",
        session_id: "sess-gone",
        transcript_path: "/Users/x/.../accounts/removed/projects/-slug/sess-gone.jsonl",
      }),
    ];
    expect(await call(lines, { exists: neverExists })).toBeNull();
    // …and the SAME log with the SAME everything else resolves once the file is there, so the null
    // above is attributable to the existence check and to nothing else in the pipeline.
    expect(await call(lines, { exists: alwaysExists })).not.toBeNull();
  });

  it("passes the transcript path it is about to accept to the existence check", async () => {
    const exists = vi.fn(async () => true);
    await call(
      [
        line({
          event: "SessionStart",
          session_id: "s1",
          transcript_path: `${ACCOUNT_DIR}/projects/-slug/s1.jsonl`,
        }),
      ],
      { exists },
    );
    expect(exists).toHaveBeenCalledWith(`${ACCOUNT_DIR}/projects/-slug/s1.jsonl`);
  });

  it("extracts the ACCOUNT config dir from an accounts/<id>/projects/... transcript path", async () => {
    const got = await call([
      line({
        event: "SessionStart",
        session_id: "s1",
        transcript_path: `${ACCOUNT_DIR}/projects/-Users-x-proj/s1.jsonl`,
      }),
    ]);
    expect(got).toEqual({ sessionId: "s1", configDir: ACCOUNT_DIR });
  });

  it("extracts <home>/.claude from a default-root transcript path", async () => {
    const got = await call([
      line({
        event: "UserPromptSubmit",
        session_id: "s2",
        transcript_path: `${HOME_DIR}/projects/-Users-x-proj/s2.jsonl`,
      }),
    ]);
    expect(got).toEqual({ sessionId: "s2", configDir: HOME_DIR });
  });

  it("returns a NULL config dir (never a wrong one) when the grandparent is not `projects`", async () => {
    // A wrong config dir is worse than none: it points every read at a directory that does not
    // exist and turns a working pane into an empty one. The SESSION is still recovered.
    const got = await call([
      line({
        event: "SessionStart",
        session_id: "s3",
        transcript_path: `${ACCOUNT_DIR}/todos/-Users-x-proj/s3.jsonl`,
      }),
    ]);
    expect(got).toEqual({ sessionId: "s3", configDir: null });
  });

  it("falls back to the most recent event carrying a session_id when there is no turn-opener", async () => {
    const got = await call([
      line({
        event: "PreToolUse",
        session_id: "s-early",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/s-early.jsonl`,
      }),
      line({
        event: "PostToolUse",
        session_id: "s-late",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/s-late.jsonl`,
      }),
    ]);
    expect(got).toEqual({ sessionId: "s-late", configDir: ACCOUNT_DIR });
  });

  it("prefers a turn-opener over a LATER non-opener event from a different session", async () => {
    // Pins the ordering rule itself: the fallback must not win when an opener exists, even though
    // the non-opener is the newest event in the log.
    const got = await call([
      line({
        event: "SessionStart",
        session_id: "s-main",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/s-main.jsonl`,
      }),
      line({
        event: "Stop",
        session_id: "s-oneshot",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/s-oneshot.jsonl`,
      }),
    ]);
    expect(got?.sessionId).toBe("s-main");
  });

  it("returns null for an empty log", async () => {
    expect(await call([])).toBeNull();
  });

  it("returns null for a log of unparseable lines, and does not throw", async () => {
    expect(await call(["not json", "{", '{"no":"event field"}'])).toBeNull();
  });

  it("returns null when the reader rejects, and does not throw", async () => {
    const read: ReadEventsFn = async () => {
      throw new Error("read_events_since: log_path is outside the managed hook-events dir");
    };
    await expect(call([], { read })).resolves.toBeNull();
  });

  it("returns null when the existence check rejects, and does not throw", async () => {
    const exists = async (): Promise<boolean> => {
      throw new Error("no such command");
    };
    const lines = [
      line({
        event: "SessionStart",
        session_id: "s1",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/s1.jsonl`,
      }),
    ];
    await expect(call(lines, { exists })).resolves.toBeNull();
  });

  it("returns null when the chosen session has no transcript path to verify", async () => {
    expect(await call([line({ event: "SessionStart", session_id: "s1" })])).toBeNull();
  });

  it("verifies against a LATER event's transcript path when the opener carries none", async () => {
    const got = await call([
      line({ event: "SessionStart", session_id: "s1" }),
      line({
        event: "PostToolUse",
        session_id: "s1",
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/s1.jsonl`,
      }),
    ]);
    expect(got).toEqual({ sessionId: "s1", configDir: ACCOUNT_DIR });
  });

  it("scans only the TAIL of the log, so an ancient opener outside the window cannot win", async () => {
    const filler = Array.from({ length: 40 }, (_, i) =>
      line({
        event: "PostToolUse",
        session_id: "s-recent",
        tool: "Bash",
        pad: "x".repeat(200),
        n: i,
        transcript_path: `${ACCOUNT_DIR}/projects/-slug/s-recent.jsonl`,
      }),
    );
    const got = await call(
      [
        line({
          event: "SessionStart",
          session_id: "s-ancient",
          transcript_path: `${ACCOUNT_DIR}/projects/-slug/s-ancient.jsonl`,
        }),
        ...filler,
      ],
      { tailBytes: 1024 },
    );
    // The window holds no opener, so the fallback answers with the session that is actually live.
    expect(got?.sessionId).toBe("s-recent");
  });

  it("returns null for a blank agent id, so a caller has nothing to record under a nameless key", async () => {
    const got = await recoverSessionBinding({
      agentId: "   ",
      logPath: "/app-data/hook-events/agent-1.jsonl",
      read: readerFor([
        line({
          event: "SessionStart",
          session_id: "s1",
          transcript_path: `${ACCOUNT_DIR}/projects/-slug/s1.jsonl`,
        }),
      ]),
      exists: alwaysExists,
    });
    expect(got).toBeNull();
  });

  // ── THE TWO PROPERTIES THAT WERE UNPINNED (roborev 67645) ────────────────────────────────────
  //
  // Both of these went green with the code deleted, which is the vacuous-test shape AGENTS.md is
  // built around: an assertion that would have passed before the change proves nothing about it.

  it("verifies the CHOSEN session's own transcript, not merely the newest path in the window", async () => {
    // The newest transcript path in this window belongs to `sess-other`, but the chosen session is
    // `sess-new` (the newest turn-opener). Without the session match in the lookup loop the module
    // would verify `sess-other`'s live file and then hand back `sess-new` — an UNVERIFIED binding,
    // exactly what the existence check exists to refuse. `exists` answers only for `sess-new`'s file,
    // so a lookup that grabbed the wrong path gets `null` and the row goes red.
    const mine = `${ACCOUNT_DIR}/projects/-wt/sess-new.jsonl`;
    const theirs = `${ACCOUNT_DIR}/projects/-wt/sess-other.jsonl`;
    const got = await call(
      [
        line({ event: "SessionStart", session_id: "sess-new", transcript_path: mine, ts: 1 }),
        // Newer, and a DIFFERENT session — a background one-shot in the same worktree.
        line({ event: "PostToolUse", session_id: "sess-other", transcript_path: theirs, ts: 2 }),
      ],
      { exists: async (path) => path === mine },
    );
    expect(got).toEqual({ sessionId: "sess-new", configDir: ACCOUNT_DIR });
  });

  it("moves on to the next session when the best candidate's transcript is gone", async () => {
    // A one-shot gate would abort here and leave the pane empty although the log names a session
    // whose transcript is live. Measured on the reporting machine: 7 of 353 logs are this shape.
    const dead = `${ACCOUNT_DIR}/projects/-wt/sess-dead.jsonl`;
    const live = `${HOME_DIR}/projects/-wt/sess-live.jsonl`;
    const got = await call(
      [
        line({ event: "SessionStart", session_id: "sess-live", transcript_path: live, ts: 1 }),
        line({ event: "UserPromptSubmit", session_id: "sess-dead", transcript_path: dead, ts: 2 }),
      ],
      { exists: async (path) => path === live },
    );
    // `sess-dead` is the newest opener and is tried FIRST; it is refused, and the search continues.
    expect(got).toEqual({ sessionId: "sess-live", configDir: HOME_DIR });
  });

  it("still returns null when EVERY candidate's transcript is gone", async () => {
    // The filter must not become a way to eventually accept something unverified.
    const got = await call(
      [
        line({ event: "SessionStart", session_id: "s1", transcript_path: `${ACCOUNT_DIR}/projects/-wt/s1.jsonl`, ts: 1 }),
        line({ event: "UserPromptSubmit", session_id: "s2", transcript_path: `${ACCOUNT_DIR}/projects/-wt/s2.jsonl`, ts: 2 }),
      ],
      { exists: neverExists },
    );
    expect(got).toBeNull();
  });
});
