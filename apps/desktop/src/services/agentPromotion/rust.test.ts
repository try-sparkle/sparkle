import { describe, it, expect, vi } from "vitest";
import {
  normalizePreflight,
  normalizeTranscript,
  promotionPreflight,
  promotionCommitDirty,
  promotionPushBranch,
  promotionReadTranscript,
  SANDBOX_REPO_CWD,
  DEFAULT_TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_ENCODE_EXPANSION,
  type Invoker,
} from "./rust";

// A fake `invoke`: records (cmd, args) and returns whatever the test queued for that command.
function fakeInvoker(returns: Record<string, unknown>) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoker: Invoker = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return returns[cmd] as T;
  };
  return { invoker, calls };
}

describe("normalizePreflight", () => {
  it("reads serde snake_case fields", () => {
    expect(
      normalizePreflight({
        branch: "b",
        branch_exists: true,
        has_remote: true,
        detached: false,
        dirty_files: ["a.ts"],
        dirty_count: 3,
        unpushed: 2,
        origin_url: "git@github.com:acme/widgets.git",
        head_sha: "deadbeef",
      }),
    ).toEqual({
      branch: "b",
      branchExists: true,
      hasRemote: true,
      originUrl: "git@github.com:acme/widgets.git",
      headSha: "deadbeef",
      detached: false,
      dirtyFiles: ["a.ts"],
      dirtyCount: 3,
      unpushed: 2,
    });
  });

  it("reads serde camelCase fields too — the Rust struct's casing is not pinned", () => {
    // Most Tauri-returned structs in this repo carry `rename_all = "camelCase"`. If this normalizer
    // only understood snake_case, `hasRemote` would land as `false` and EVERY promotion would refuse
    // with "no origin remote" — a wrong answer wearing a legitimate refusal's clothes.
    const p = normalizePreflight({
      branch: "b",
      branchExists: true,
      hasRemote: true,
      dirtyFiles: ["a.ts", "b.ts"],
      dirtyCount: 2,
      unpushed: 5,
    });
    expect(p.branchExists).toBe(true);
    expect(p.hasRemote).toBe(true);
    expect(p.dirtyFiles).toEqual(["a.ts", "b.ts"]);
    expect(p.dirtyCount).toBe(2);
    expect(p.unpushed).toBe(5);
  });

  it("defaults every field safely for a garbage payload", () => {
    expect(normalizePreflight(null)).toEqual({
      branch: "",
      branchExists: false,
      hasRemote: false,
      // null, NOT "" — the plan treats an unknown origin as a refusal, and two empty strings would
      // normalize equal and read as a matching remote.
      originUrl: null,
      headSha: "",
      detached: false,
      dirtyFiles: [],
      dirtyCount: 0,
      unpushed: 0,
    });
    expect(normalizePreflight({ origin_url: "   " }).originUrl).toBeNull();
    expect(normalizePreflight({ unpushed: "7", dirty_count: NaN, dirty_files: "nope" })).toMatchObject({
      unpushed: 0,
      dirtyCount: 0,
      dirtyFiles: [],
    });
  });

  it("never reports fewer dirty files than it actually lists", () => {
    // The count is the true total and the list is capped, so count ≥ list — but a Rust bug (or a
    // half-populated payload) must not make the dialog say "0 files" over a list of three.
    const p = normalizePreflight({ dirty_count: 0, dirty_files: ["a", "b", "c"] });
    expect(p.dirtyCount).toBe(3);
  });

  it("keeps a true total that exceeds the capped list", () => {
    const p = normalizePreflight({ dirty_count: 120, dirty_files: ["a", "b"] });
    expect(p.dirtyCount).toBe(120);
  });

  it("drops non-string entries from the dirty list", () => {
    expect(normalizePreflight({ dirty_files: ["a", 3, null, "b"] }).dirtyFiles).toEqual(["a", "b"]);
  });
});

describe("normalizeTranscript", () => {
  it("reads snake_case and camelCase session ids", () => {
    expect(normalizeTranscript({ session_id: "s1", jsonl: "{}", truncated: true, bytes: 4, records: 1 })).toEqual(
      { sessionId: "s1", jsonl: "{}", truncated: true, bytes: 4, records: 1 },
    );
    expect(normalizeTranscript({ sessionId: "s2", jsonl: "{}" })?.sessionId).toBe("s2");
  });

  it("is null for anything unresumable", () => {
    // A transcript with no session id cannot be `claude --resume`d, so it is the same as none —
    // promotion proceeds WITHOUT it rather than shipping an unusable payload over the wire.
    expect(normalizeTranscript(null)).toBeNull();
    expect(normalizeTranscript(undefined)).toBeNull();
    expect(normalizeTranscript({ jsonl: "{}" })).toBeNull();
    expect(normalizeTranscript({ session_id: "", jsonl: "{}" })).toBeNull();
    expect(normalizeTranscript({ session_id: "s1" })).toBeNull();
    expect(normalizeTranscript({ session_id: "s1", jsonl: "" })).toBeNull();
    expect(normalizeTranscript({ session_id: "s1", jsonl: 42 })).toBeNull();
  });
});

describe("command wrappers", () => {
  it("invokes promotion_preflight with camelCase arg keys Tauri maps to snake_case params", () => {
    const { invoker, calls } = fakeInvoker({ promotion_preflight: { branch: "b", has_remote: true } });
    return promotionPreflight(
      { root: "/r", agentId: "a1", worktree: "/wt", baseBranch: "main" },
      invoker,
    ).then((p) => {
      expect(calls[0]!.cmd).toBe("promotion_preflight");
      expect(calls[0]!.args).toEqual({
        root: "/r",
        agentId: "a1",
        worktree: "/wt",
        baseBranch: "main",
      });
      expect(p.hasRemote).toBe(true);
    });
  });

  it("passes the WIP message straight through to promotion_commit_dirty", async () => {
    const { invoker, calls } = fakeInvoker({ promotion_commit_dirty: 4 });
    expect(await promotionCommitDirty({ worktree: "/wt", message: "msg" }, invoker)).toBe(4);
    expect(calls[0]!.args).toEqual({ worktree: "/wt", message: "msg" });
  });

  it("coerces a non-numeric commit count to 0 rather than NaN", async () => {
    const { invoker } = fakeInvoker({ promotion_commit_dirty: "4" });
    expect(await promotionCommitDirty({ worktree: "/wt", message: "m" }, invoker)).toBe(0);
  });

  it("returns either defined push outcome verbatim", async () => {
    const no = fakeInvoker({ promotion_push_branch: "no-remote" });
    expect(await promotionPushBranch({ root: "/r", branch: "b" }, no.invoker)).toBe("no-remote");
    expect(no.calls[0]!.args).toEqual({ root: "/r", branch: "b" });
    const yes = fakeInvoker({ promotion_push_branch: "pushed" });
    expect(await promotionPushBranch({ root: "/r", branch: "b" }, yes.invoker)).toBe("pushed");
  });

  it("REJECTS an unrecognized push result instead of reading it as success", async () => {
    // Coercing an unknown payload to a string the caller reads as "not no-remote, therefore fine"
    // fails silently and late: the state machine advances to `start` with an unpushed branch and the
    // user learns about it as an await_live timeout, long after the WIP commit landed.
    for (const bogus of ["ok", "", null, 0, { pushed: true }]) {
      const { invoker } = fakeInvoker({ promotion_push_branch: bogus });
      await expect(promotionPushBranch({ root: "/r", branch: "b" }, invoker)).rejects.toThrow(
        /unexpected push result/,
      );
    }
  });

  it("caps the transcript below the encoded body limit, not at it", async () => {
    // The 8 MB bodyLimit applies to the JSON-ENCODED body while the cap is measured on RAW JSONL,
    // and JSON string-escaping of a Claude transcript expands it ~1.3–2×. The cap has to leave room
    // for that factor plus the rest of the start payload, or the longest conversations 413 — which
    // fails the whole `start` step rather than degrading to the transcript-less path (the retry is
    // specified but NOT built — bead sparkle-nit44).
    const BODY_LIMIT = 8 * 1024 * 1024;
    expect(DEFAULT_TRANSCRIPT_MAX_BYTES * TRANSCRIPT_ENCODE_EXPANSION).toBeLessThan(BODY_LIMIT);
  });

  it("survives a MEASURED worst case, not just the declared expansion factor", () => {
    // The check above multiplies by the very constant that claims the expansion, so it cannot catch
    // that constant being WRONG: set TRANSCRIPT_ENCODE_EXPANSION to 1 and it still passes while the
    // real bodies grow past the limit. This one measures instead of asserting.
    //
    // A quote-dense line, because that is what actually expands: every `"` becomes `\"`, and a
    // transcript full of quoted file contents and tool JSON is mostly quotes. This is deliberately
    // WORSE than a real transcript — if the cap survives this, it survives the real thing.
    const BODY_LIMIT = 8 * 1024 * 1024;
    const unit = '{"type":"user","cwd":"/home/user/repo","text":"\\"a\\" \\"b\\" \\"c\\""}\n';
    const jsonl = unit.repeat(Math.ceil(DEFAULT_TRANSCRIPT_MAX_BYTES / unit.length)).slice(
      0,
      DEFAULT_TRANSCRIPT_MAX_BYTES,
    );
    expect(jsonl.length).toBe(DEFAULT_TRANSCRIPT_MAX_BYTES);

    // The whole start payload, as promote.ts actually sends it — the transcript is not alone in
    // the body, and the rest of it counts against the same limit.
    const body = JSON.stringify({
      project_id: "00000000-0000-4000-8000-000000000000",
      goal: "x".repeat(2000),
      repo_url: "https://github.com/acme/widgets",
      promotion: {
        session_id: "00000000-0000-4000-8000-000000000001",
        branch: "sparkle/agent-00000000",
        transcript: { session_id: "00000000-0000-4000-8000-000000000002", jsonl },
      },
    });
    expect(body.length).toBeLessThan(BODY_LIMIT);
  });

  it("defaults the transcript's sandbox cwd and byte cap", async () => {
    const { invoker, calls } = fakeInvoker({
      promotion_read_transcript: { session_id: "s1", jsonl: "{}" },
    });
    const t = await promotionReadTranscript({ worktree: "/wt" }, invoker);
    expect(t?.sessionId).toBe("s1");
    expect(calls[0]!.args).toEqual({
      worktree: "/wt",
      configDir: null,
      sandboxCwd: SANDBOX_REPO_CWD,
      maxBytes: DEFAULT_TRANSCRIPT_MAX_BYTES,
    });
  });

  it("honours an explicit cwd / cap / config dir", async () => {
    const { invoker, calls } = fakeInvoker({ promotion_read_transcript: null });
    expect(
      await promotionReadTranscript(
        { worktree: "/wt", sandboxCwd: "/elsewhere", maxBytes: 10, configDir: "/cfg" },
        invoker,
      ),
    ).toBeNull();
    expect(calls[0]!.args).toEqual({
      worktree: "/wt",
      configDir: "/cfg",
      sandboxCwd: "/elsewhere",
      maxBytes: 10,
    });
  });

  it("propagates a Rust error rather than swallowing it", async () => {
    const invoker = vi.fn().mockRejectedValue("not a git repository") as unknown as Invoker;
    await expect(
      promotionPreflight({ root: "/r", agentId: "a", worktree: "/wt", baseBranch: "main" }, invoker),
    ).rejects.toBe("not a git repository");
  });
});
