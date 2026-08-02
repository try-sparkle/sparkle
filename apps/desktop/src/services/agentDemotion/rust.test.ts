import { describe, it, expect } from "vitest";
import {
  parseLandRefusal,
  landRefusalMessage,
  refusalFileList,
  normalizeLanding,
  demotionLandBranch,
  demotionWriteTranscript,
  SANDBOX_REPO_CWD,
  type Invoker,
} from "./rust";

/** An invoker that records its calls and returns a scripted value. */
function fake(result: unknown | ((cmd: string, args?: Record<string, unknown>) => unknown)) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoker: Invoker = async <T,>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    const v = typeof result === "function" ? (result as (c: string, a?: Record<string, unknown>) => unknown)(cmd, args) : result;
    if (v instanceof Error) throw v;
    return v as T;
  };
  return { invoker, calls };
}

describe("parseLandRefusal — the stable prefixes", () => {
  it("classifies dirty and splits its file list", () => {
    expect(parseLandRefusal("dirty:src/a.ts,src/b.ts")).toMatchObject({
      kind: "dirty",
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("tolerates whitespace and empty entries in the list", () => {
    expect(parseLandRefusal("dirty: src/a.ts , ,src/b.ts ").files).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("classifies a bare diverged, and an optional file payload if Rust starts sending one", () => {
    expect(parseLandRefusal("diverged")).toMatchObject({ kind: "diverged", files: [] });
    expect(parseLandRefusal("diverged:a.ts,b.ts")).toMatchObject({
      kind: "diverged",
      files: ["a.ts", "b.ts"],
    });
  });

  it("classifies no-remote, fetch-failed and worktree-failed", () => {
    expect(parseLandRefusal("no-remote").kind).toBe("no-remote");
    expect(parseLandRefusal("fetch-failed: could not read Username").kind).toBe("fetch-failed");
    expect(parseLandRefusal("worktree-failed: already checked out").kind).toBe("worktree-failed");
  });

  it("extracts the actual sha from sha-mismatch", () => {
    expect(parseLandRefusal("sha-mismatch:deadbeef")).toMatchObject({
      kind: "sha-mismatch",
      actualSha: "deadbeef",
    });
    // A prefix with no payload must not claim a sha it doesn't have.
    expect(parseLandRefusal("sha-mismatch:").actualSha).toBeNull();
  });

  it("does NOT classify a git error that merely MENTIONS a keyword", () => {
    // Matching anywhere in the string would tell the user their local branch has commits the cloud
    // does not, for a failure that was nothing of the kind.
    const r = parseLandRefusal("fatal: refusing to merge (branches have diverged)");
    expect(r.kind).toBe("unknown");
    const d = parseLandRefusal("error: working tree is dirty somewhere");
    expect(d.kind).toBe("unknown");
    expect(d.files).toEqual([]);
  });

  it("accepts an Error as well as a string, and keeps the raw text", () => {
    const r = parseLandRefusal(new Error("dirty:x.ts"));
    expect(r.kind).toBe("dirty");
    expect(r.raw).toBe("dirty:x.ts");
  });
});

describe("refusalFileList", () => {
  it("names up to ten files, then counts the rest", () => {
    const many = Array.from({ length: 13 }, (_, i) => `f${i}.ts`);
    const out = refusalFileList(many);
    expect(out).toContain("f0.ts");
    expect(out).toContain("f9.ts");
    expect(out).not.toContain("f10.ts");
    expect(out).toContain("(+3 more)");
  });

  it("is empty for no files", () => {
    expect(refusalFileList([])).toBe("");
  });
});

describe("landRefusalMessage", () => {
  it("names the dirty files and tells the user Sparkle won't overwrite them", () => {
    const m = landRefusalMessage(parseLandRefusal("dirty:a.ts,b.ts"), "sparkle/x");
    expect(m).toContain("a.ts");
    expect(m).toContain("b.ts");
    expect(m).toMatch(/won't overwrite local work/i);
    expect(m).not.toContain("dirty:");
  });

  it("explains a divergence without leaking the prefix", () => {
    const m = landRefusalMessage(parseLandRefusal("diverged"), "sparkle/x");
    expect(m).toContain("origin/sparkle/x");
    expect(m).not.toContain("diverged");
  });

  it("strips the machine prefix from fetch/worktree failures but keeps the git text", () => {
    expect(landRefusalMessage(parseLandRefusal("fetch-failed: no such ref"), "b")).toContain(
      "no such ref",
    );
    expect(landRefusalMessage(parseLandRefusal("fetch-failed: no such ref"), "b")).not.toContain(
      "fetch-failed:",
    );
    expect(
      landRefusalMessage(parseLandRefusal("worktree-failed: already used"), "b"),
    ).toContain("already used");
  });

  it("names the actual sha on a mismatch", () => {
    expect(landRefusalMessage(parseLandRefusal("sha-mismatch:cafe"), "b")).toContain("cafe");
  });

  it("passes an unrecognized error through verbatim rather than guessing at it", () => {
    const m = landRefusalMessage(parseLandRefusal("fatal: something else entirely"), "b");
    expect(m).toContain("fatal: something else entirely");
  });
});

describe("normalizeLanding", () => {
  it("accepts snake_case and camelCase for head_sha", () => {
    expect(normalizeLanding({ worktree: "/wt", head_sha: "abc", created: true })).toEqual({
      worktree: "/wt",
      headSha: "abc",
      created: true,
    });
    expect(normalizeLanding({ worktree: "/wt", headSha: "abc", created: false })).toEqual({
      worktree: "/wt",
      headSha: "abc",
      created: false,
    });
  });

  it("treats a missing `created` as false rather than truthy-by-accident", () => {
    expect(normalizeLanding({ worktree: "/wt", headSha: "abc" }).created).toBe(false);
    expect(normalizeLanding({ worktree: "/wt", headSha: "abc", created: "yes" }).created).toBe(false);
  });

  it("THROWS on a missing worktree or head sha rather than defaulting them", () => {
    // Both are acted on downstream — the worktree is where the agent spawns, the sha is the proof
    // the landing matched — so a silent "" would be used as if it were an answer.
    expect(() => normalizeLanding({ headSha: "abc" })).toThrow(/worktree/);
    expect(() => normalizeLanding({ worktree: "/wt" })).toThrow(/head sha/);
    expect(() => normalizeLanding({ worktree: "", headSha: "abc" })).toThrow(/worktree/);
    expect(() => normalizeLanding(null)).toThrow();
  });
});

describe("demotionLandBranch", () => {
  it("passes camelCase args through to the Tauri command", async () => {
    const { invoker, calls } = fake({ worktree: "/wt", head_sha: "abc", created: true });
    const out = await demotionLandBranch(
      {
        root: "/repo",
        agentId: "tab-1",
        existingWorktree: "/wt/old",
        branch: "sparkle/x",
        expectedSha: "abc",
      },
      invoker,
    );
    expect(calls[0]!.cmd).toBe("demotion_land_branch");
    expect(calls[0]!.args).toEqual({
      root: "/repo",
      agentId: "tab-1",
      existingWorktree: "/wt/old",
      branch: "sparkle/x",
      expectedSha: "abc",
    });
    expect(out).toEqual({ worktree: "/wt", headSha: "abc", created: true });
  });

  it("sends existingWorktree as an explicit null when there is none", async () => {
    // Undefined would be dropped from the payload, and Rust's `Option<String>` would still be None
    // — but the two are indistinguishable in a test, and an explicit null is what the contract pins.
    const { invoker, calls } = fake({ worktree: "/wt", headSha: "a" });
    await demotionLandBranch(
      { root: "/r", agentId: "t", existingWorktree: null, branch: "b", expectedSha: "a" },
      invoker,
    );
    expect(calls[0]!.args).toHaveProperty("existingWorktree", null);
  });

  it("rejects with the Rust refusal string untouched, so the caller can classify it", async () => {
    const { invoker } = fake(new Error("dirty:src/a.ts"));
    await expect(
      demotionLandBranch(
        { root: "/r", agentId: "t", existingWorktree: null, branch: "b", expectedSha: "a" },
        invoker,
      ),
    ).rejects.toThrow("dirty:src/a.ts");
  });
});

describe("demotionWriteTranscript", () => {
  it("defaults the sandbox cwd to the runner's clone path and passes a null config dir", async () => {
    const { invoker, calls } = fake(12);
    const n = await demotionWriteTranscript(
      { worktree: "/wt", sessionId: "sess-9", jsonl: '{"a":1}' },
      invoker,
    );
    expect(calls[0]!.cmd).toBe("demotion_write_transcript");
    expect(calls[0]!.args).toEqual({
      worktree: "/wt",
      configDir: null,
      sessionId: "sess-9",
      jsonl: '{"a":1}',
      sandboxCwd: SANDBOX_REPO_CWD,
    });
    expect(n).toBe(12);
  });

  it("honours an explicit sandbox cwd and config dir", async () => {
    const { invoker, calls } = fake(1);
    await demotionWriteTranscript(
      {
        worktree: "/wt",
        sessionId: "s",
        jsonl: "{}",
        sandboxCwd: "/home/user/other",
        configDir: "/cfg",
      },
      invoker,
    );
    expect(calls[0]!.args).toMatchObject({ sandboxCwd: "/home/user/other", configDir: "/cfg" });
  });

  it("coerces a garbage record count to 0 rather than letting NaN through", async () => {
    const { invoker } = fake("lots");
    expect(await demotionWriteTranscript({ worktree: "/wt", sessionId: "s", jsonl: "{}" }, invoker)).toBe(0);
  });

  it("rejects when the command does — the CALLER decides that isn't fatal, not this wrapper", async () => {
    const { invoker } = fake(new Error("disk full"));
    await expect(
      demotionWriteTranscript({ worktree: "/wt", sessionId: "s", jsonl: "{}" }, invoker),
    ).rejects.toThrow("disk full");
  });
});
