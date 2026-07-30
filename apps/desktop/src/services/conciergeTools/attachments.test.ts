// The ATTACHMENTS domain (concierge PRD section F).
//
// Nearly every test here is about ONE property: a model-supplied absolute path must not become an
// arbitrary file read. The terminal domain answered that question by deleting its `transcriptPath`
// argument; this domain can't delete the path, so each constraint that replaces the deletion is
// pinned individually, and each is asserted on the SIDE EFFECT — what ended up in the staging queue
// — rather than on the refusal object alone. A refusal that returns the right code while still
// staging the file would pass a message-shaped assertion and fail the user.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { usePendingAttachmentsStore } from "../../stores/pendingAttachmentsStore";
import { useProjectStore } from "../../stores/projectStore";
import {
  ATTACHMENTS_OPS,
  ATTACHMENTS_RISK,
  ATTACHMENT_REFUSALS,
  MAX_ATTACHMENT_BYTES,
  MAX_STAGED_PER_AGENT,
  attachToMessage,
  clearAttachments,
  hiddenSegmentBelow,
  isInsideRoot,
  listAttachments,
} from "./attachments";

const invokeMock = vi.mocked(invoke);

const AGENT = "agent-1";
const ROOT = "/Users/dev/proj";
const WORKTREE = "/Users/dev/Library/Application Support/ai.sparkle.desktop/worktrees/wt-1";

/** One entry in the fake filesystem the `probe_attachment` mock answers from. */
interface Entry {
  /** Where the path REALLY points. Defaults to the key — set it to model a symlink. */
  realPath?: string;
  size?: number;
  isFile?: boolean;
}

let fs: Record<string, Entry>;

/** The staged queue for AGENT, read straight out of the store the compose box drains. */
const staged = () => usePendingAttachmentsStore.getState().pending[AGENT] ?? [];

/** Every path `probe_attachment` was asked about, in call order. */
const probed = () =>
  invokeMock.mock.calls
    .filter(([cmd]) => cmd === "probe_attachment")
    .map(([, args]) => (args as { path: string }).path);

function seedAgent(over: Record<string, unknown> = {}) {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "proj",
        rootPath: ROOT,
        defaultBranch: "main",
        agents: [{ id: AGENT, name: "Retry logic", worktreePath: WORKTREE, ...over } as never],
      } as never,
    ],
  } as never);
}

beforeEach(() => {
  invokeMock.mockReset();
  usePendingAttachmentsStore.setState({ pending: {} });
  seedAgent();
  // Both roots resolve to themselves; a 1 KB regular file at each seeded path.
  fs = {
    [ROOT]: { isFile: false },
    [WORKTREE]: { isFile: false },
    [`${ROOT}/docs/spec.md`]: { size: 1024 },
    [`${ROOT}/ui/mock.png`]: { size: 2048 },
    [`${WORKTREE}/out/build.log`]: { size: 4096 },
  };
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd !== "probe_attachment") throw new Error(`unexpected command ${cmd}`);
    const path = (args as { path: string }).path;
    const entry = fs[path];
    if (!entry) throw new Error(`cannot access ${path}: No such file or directory`);
    return {
      real_path: entry.realPath ?? path,
      size: entry.size ?? 0,
      is_file: entry.isFile ?? true,
    };
  });
});

// ---------------------------------------------------------------------------------------------

describe("the operation surface classifies itself", () => {
  it("classifies every op, and only the read is read-only", () => {
    expect(Object.keys(ATTACHMENTS_RISK).sort()).toEqual([...ATTACHMENTS_OPS].sort());
    expect(ATTACHMENTS_RISK.list_attachments).toBe("read-only");
    // Attaching CHANGES what the next message carries, so the registry must see it as a write.
    // `!== "read-only"` is exactly how the registry derives that flag.
    expect(ATTACHMENTS_RISK.attach_to_message).not.toBe("read-only");
    expect(ATTACHMENTS_RISK.clear_attachments).not.toBe("read-only");
  });
});

// ---------------------------------------------------------------------------------------------
// The pure path arithmetic. Small, and the place the containment bug would actually live.
// ---------------------------------------------------------------------------------------------

describe("isInsideRoot compares segments, not string prefixes", () => {
  it("accepts a file below the root", () => {
    expect(isInsideRoot("/Users/dev/proj/src/a.ts", "/Users/dev/proj")).toBe(true);
  });

  it("REJECTS a sibling directory that merely shares the root's prefix", () => {
    // The classic containment hole: "/Users/dev/proj-secrets/x".startsWith("/Users/dev/proj") is
    // true, and a prefix test would have let the whole directory through.
    expect(isInsideRoot("/Users/dev/proj-secrets/creds.txt", "/Users/dev/proj")).toBe(false);
  });

  it("rejects the root itself and anything above it", () => {
    expect(isInsideRoot("/Users/dev/proj", "/Users/dev/proj")).toBe(false);
    expect(isInsideRoot("/Users/dev", "/Users/dev/proj")).toBe(false);
  });

  it("tolerates a trailing slash on either side", () => {
    expect(isInsideRoot("/Users/dev/proj/src/a.ts", "/Users/dev/proj/")).toBe(true);
  });
});

describe("hiddenSegmentBelow only judges the part below the root", () => {
  it("names the first dot-prefixed segment", () => {
    expect(hiddenSegmentBelow("/r/.env", "/r")).toBe(".env");
    expect(hiddenSegmentBelow("/r/.git/config", "/r")).toBe(".git");
    expect(hiddenSegmentBelow("/r/a/b/.npmrc", "/r")).toBe(".npmrc");
  });

  it("ignores dots in the ROOT's own path", () => {
    // A project living under a hidden directory is legal; judging the root would refuse every file
    // in it. Only the portion the caller chose is examined.
    expect(hiddenSegmentBelow("/home/.config/proj/src/a.ts", "/home/.config/proj")).toBeNull();
  });

  it("returns null for an ordinary path", () => {
    expect(hiddenSegmentBelow("/r/src/a.ts", "/r")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------------------------

describe("attaching stages a file for the agent's next message", () => {
  it("queues the file on the store the compose box drains", async () => {
    const r = await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`]);

    expect(r.ok).toBe(true);
    expect(staged()).toEqual([`${ROOT}/docs/spec.md`]);
  });

  it("reports the file's name and kind, and says nothing was sent", async () => {
    const r = await attachToMessage(AGENT, [`${ROOT}/ui/mock.png`]);

    expect(r.ok && r.data.attached).toEqual([
      { path: `${ROOT}/ui/mock.png`, name: "mock.png", kind: "image" },
    ]);
    expect(r.ok && r.data.detail).toMatch(/Nothing has been sent/i);
  });

  it("accepts a file in the agent's WORKTREE, which is outside the project root", async () => {
    // A Sparkle worktree lives under the app's support directory, nowhere near the project folder.
    // Containment on `rootPath` alone would refuse an agent's own build output.
    const r = await attachToMessage(AGENT, [`${WORKTREE}/out/build.log`]);

    expect(r.ok).toBe(true);
    expect(staged()).toEqual([`${WORKTREE}/out/build.log`]);
  });

  it("STAGES THE RESOLVED PATH, not the string it was handed", async () => {
    // The check-vs-use window: if the symlink were staged, swapping it after the check would
    // redirect the send. Staging what `probe_attachment` resolved closes it.
    fs[`${ROOT}/docs/latest.md`] = { realPath: `${ROOT}/docs/spec.md`, size: 1024 };

    await attachToMessage(AGENT, [`${ROOT}/docs/latest.md`]);

    expect(staged()).toEqual([`${ROOT}/docs/spec.md`]);
  });

  it("de-duplicates a link and its TARGET, which are two strings for one file", async () => {
    // The first de-duplication is over the strings the caller sent, and these two differ. Only the
    // resolved paths reveal that they name the same file — without a second pass it is staged
    // twice and prefixed onto the message twice.
    fs[`${ROOT}/docs/latest.md`] = { realPath: `${ROOT}/docs/spec.md`, size: 1024 };

    await attachToMessage(AGENT, [`${ROOT}/docs/latest.md`, `${ROOT}/docs/spec.md`]);

    expect(staged()).toEqual([`${ROOT}/docs/spec.md`]);
  });

  it("de-duplicates within a call and against what is already queued", async () => {
    await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`, `${ROOT}/docs/spec.md`]);
    expect(staged()).toEqual([`${ROOT}/docs/spec.md`]);

    const again = await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`]);
    expect(staged()).toEqual([`${ROOT}/docs/spec.md`]);
    expect(again.ok && again.data.alreadyStaged).toEqual([`${ROOT}/docs/spec.md`]);
    expect(again.ok && again.data.attached).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// CONTAINMENT — one test per rule, each asserting the queue stayed empty
// ---------------------------------------------------------------------------------------------

/** Run a doomed attach and assert BOTH halves: the named refusal, and nothing staged. */
async function refusedWith(paths: string[], code: string) {
  const r = await attachToMessage(AGENT, paths);
  expect(r.ok).toBe(false);
  expect(!r.ok && r.reason).toBe(code);
  expect(staged()).toEqual([]);
  return r;
}

describe("a path may not escape the project", () => {
  it("refuses a relative path", async () => {
    await refusedWith(["docs/spec.md"], ATTACHMENT_REFUSALS.notAbsolute);
  });

  it("refuses a `..` segment WITHOUT touching the filesystem", async () => {
    // Lexical, and before any probe. Two reasons this is checked rather than left to
    // canonicalization: the refusal names the actual defect, and a traversal attempt never becomes
    // a stat the app performed on the caller's behalf.
    await refusedWith([`${ROOT}/../../etc/passwd`], ATTACHMENT_REFUSALS.traversal);

    expect(probed()).not.toContain(`${ROOT}/../../etc/passwd`);
  });

  it("refuses a path that resolves OUT of the project through a symlink", async () => {
    // The path looks contained. `probe_attachment` canonicalizes and it isn't.
    fs[`${ROOT}/notes/link.txt`] = { realPath: "/Users/dev/.ssh/id_rsa", size: 100 };

    const r = await refusedWith([`${ROOT}/notes/link.txt`], ATTACHMENT_REFUSALS.symlinkEscape);

    // …and the refusal does NOT disclose where it pointed — that would make this an oracle for
    // reading link targets outside the project.
    expect(!r.ok && r.message).not.toContain("id_rsa");
  });

  it("still says `symlink-escape` when the PROJECT FOLDER is itself reached through a link", async () => {
    // `/Users/dev/proj` resolves to `/Volumes/work/proj`, so a caller's path can look contained
    // against the folder it was told about while matching neither root once resolved. The GATE is
    // unaffected (it only ever asks the resolved root); this pins that the refusal still names the
    // right problem instead of the misleading `outside-project`.
    fs[ROOT] = { realPath: "/Volumes/work/proj", isFile: false };
    fs[`${ROOT}/notes/link.txt`] = { realPath: "/Users/dev/elsewhere/x.txt", size: 10 };

    await refusedWith([`${ROOT}/notes/link.txt`], ATTACHMENT_REFUSALS.symlinkEscape);
  });

  // A ROOT THAT IS REFUSED IS NOT A ROOT THAT IS MISSING (roborev 55403). `probe_attachment` runs
  // Rust's read allow-list, which rejects a project outside $HOME/temp//Volumes or under a hidden
  // directory — so a perfectly real folder cannot resolve, and the caller used to be told the app
  // "can't resolve" it, blaming a missing folder for a policy rule. The refusal now carries the
  // resolver's own words, which is the difference between "check the path" and "this location is
  // not attachable".
  it("says a project root was REJECTED, not missing, when the read policy refuses it", async () => {
    delete fs[ROOT];
    delete fs[WORKTREE];
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "probe_attachment") throw new Error(`unexpected command ${cmd}`);
      const path = (args as { path: string }).path;
      if (path === ROOT || path === WORKTREE) {
        throw new Error("refusing a path with a hidden component below the root");
      }
      throw new Error(`cannot access ${path}: No such file or directory`);
    });

    const r = await refusedWith([`${ROOT}/docs/spec.md`], ATTACHMENT_REFUSALS.noProjectRoot);

    expect(!r.ok && r.message).toContain("rejected rather than missing");
    expect(!r.ok && r.message).toContain("hidden component");
  });

  it("refuses a path plainly outside the project and the worktree", async () => {
    fs["/Users/dev/other/secret.txt"] = { size: 10 };

    await refusedWith(["/Users/dev/other/secret.txt"], ATTACHMENT_REFUSALS.outsideProject);
  });

  // NOT AN EXISTENCE ORACLE (roborev 55403). The refusal codes deliberately distinguish `not-found`
  // from `not-a-file` from `outside-project`, which is useful for a path the caller may ask about
  // and a FILESYSTEM ORACLE for one it may not: the concierge reads agent terminal output, so a
  // prompt-injected instruction could otherwise walk the user's home tree by refusal code alone.
  // Containment is now decided on the string, before anything is probed — so the two cases below,
  // which differ only in whether the file exists, must be indistinguishable AND must not touch disk.
  it("does not probe — or distinguish — anything outside the project", async () => {
    fs["/Users/dev/other/exists.txt"] = { size: 10 };

    const present = await refusedWith(["/Users/dev/other/exists.txt"], ATTACHMENT_REFUSALS.outsideProject);
    const absent = await refusedWith(["/Users/dev/other/absent.txt"], ATTACHMENT_REFUSALS.outsideProject);

    // Identical once the caller's OWN path is removed — that part is not a disclosure, it is the
    // argument echoed back. What must not differ is the reason, and it doesn't.
    const reason = (r: typeof present, path: string) =>
      (!r.ok && r.message ? r.message : "").split(path).join("<path>");
    expect(reason(present, "/Users/dev/other/exists.txt")).toBe(
      reason(absent, "/Users/dev/other/absent.txt"),
    );
    // …and neither path was ever handed to the filesystem.
    expect(probed()).not.toContain("/Users/dev/other/exists.txt");
    expect(probed()).not.toContain("/Users/dev/other/absent.txt");
  });

  // …while a path that LOOKS contained keeps every bit of its diagnostic quality, which is the half
  // of the trade that makes the refusals worth having.
  it("still tells a missing in-project file apart from a directory", async () => {
    fs[`${ROOT}/docs`] = { isFile: false };

    await refusedWith([`${ROOT}/docs/nope.md`], ATTACHMENT_REFUSALS.notFound);
    await refusedWith([`${ROOT}/docs`], ATTACHMENT_REFUSALS.notAFile);
    expect(probed()).toContain(`${ROOT}/docs/nope.md`);
  });

  it("refuses a sibling directory sharing the root's prefix", async () => {
    fs[`${ROOT}-secrets/creds.txt`] = { size: 10 };

    await refusedWith([`${ROOT}-secrets/creds.txt`], ATTACHMENT_REFUSALS.outsideProject);
  });

  it("refuses a dot-prefixed file inside the project", async () => {
    fs[`${ROOT}/.env`] = { size: 200 };

    await refusedWith([`${ROOT}/.env`], ATTACHMENT_REFUSALS.hidden);
  });

  it("refuses a file reached through a dot-prefixed directory", async () => {
    fs[`${ROOT}/.git/config`] = { size: 200 };

    await refusedWith([`${ROOT}/.git/config`], ATTACHMENT_REFUSALS.hidden);
  });

  it("refuses a path that does not exist", async () => {
    await refusedWith([`${ROOT}/nope.md`], ATTACHMENT_REFUSALS.notFound);
  });

  it("refuses a directory", async () => {
    fs[`${ROOT}/docs`] = { isFile: false };

    await refusedWith([`${ROOT}/docs`], ATTACHMENT_REFUSALS.notAFile);
  });

  it("refuses a file over the size ceiling, and accepts one exactly at it", async () => {
    fs[`${ROOT}/huge.bin`] = { size: MAX_ATTACHMENT_BYTES + 1 };
    await refusedWith([`${ROOT}/huge.bin`], ATTACHMENT_REFUSALS.tooLarge);

    fs[`${ROOT}/edge.bin`] = { size: MAX_ATTACHMENT_BYTES };
    const r = await attachToMessage(AGENT, [`${ROOT}/edge.bin`]);
    expect(r.ok).toBe(true);
  });

  it("refuses more files than the per-agent queue holds", async () => {
    const many = Array.from({ length: MAX_STAGED_PER_AGENT + 1 }, (_, i) => {
      const p = `${ROOT}/f${i}.txt`;
      fs[p] = { size: 1 };
      return p;
    });

    await refusedWith(many, ATTACHMENT_REFUSALS.tooMany);
  });

  it("refuses when the queue is already full, counting what is there", async () => {
    const first = Array.from({ length: MAX_STAGED_PER_AGENT }, (_, i) => {
      const p = `${ROOT}/f${i}.txt`;
      fs[p] = { size: 1 };
      return p;
    });
    await attachToMessage(AGENT, first);
    expect(staged()).toHaveLength(MAX_STAGED_PER_AGENT);

    const r = await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`]);
    expect(!r.ok && r.reason).toBe(ATTACHMENT_REFUSALS.tooMany);
    expect(staged()).toHaveLength(MAX_STAGED_PER_AGENT);
    expect(staged()).not.toContain(`${ROOT}/docs/spec.md`);
  });

  it("refuses an empty list rather than reporting a successful no-op", async () => {
    await refusedWith([], ATTACHMENT_REFUSALS.noPaths);
    await refusedWith(["   "], ATTACHMENT_REFUSALS.noPaths);
  });

  it("refuses when neither the project root nor the worktree can be resolved", async () => {
    delete fs[ROOT];
    delete fs[WORKTREE];

    await refusedWith([`${ROOT}/docs/spec.md`], ATTACHMENT_REFUSALS.noProjectRoot);
  });
});

describe("a batch is all-or-nothing", () => {
  it("stages NOTHING when one path in the batch is refused", async () => {
    // The failure this prevents: "attached your two files" said truthfully about one, with the
    // human sending in the belief that both rode along.
    const r = await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`, `${ROOT}/.env`]);

    expect(r.ok).toBe(false);
    expect(staged()).toEqual([]);
  });

  it("names every rejected path in the refusal, not just the first", async () => {
    fs[`${ROOT}/.env`] = { size: 1 };

    const r = await attachToMessage(AGENT, [`${ROOT}/.env`, `${ROOT}/nope.md`]);

    expect(!r.ok && r.message).toContain(".env");
    expect(!r.ok && r.message).toContain("nope.md");
  });
});

// ---------------------------------------------------------------------------------------------
// Reads and the un-stage
// ---------------------------------------------------------------------------------------------

describe("list_attachments says what it does and does not establish", () => {
  it("lists what is queued, with names and kinds", async () => {
    await attachToMessage(AGENT, [`${ROOT}/ui/mock.png`, `${ROOT}/docs/spec.md`]);

    const r = listAttachments(AGENT);

    expect(r.ok && r.data.count).toBe(2);
    expect(r.ok && r.data.files.map((f) => f.kind)).toEqual(["image", "file"]);
  });

  it("warns that an EMPTY list does not mean nothing is attached", async () => {
    // The queue drains into the compose box's own chips, which a service cannot read. A caller that
    // reads "count: 0" as "no files" will tell the human something false.
    const r = listAttachments(AGENT);

    expect(r.ok && r.data.count).toBe(0);
    expect(r.ok && r.data.detail).toMatch(/does NOT mean nothing is attached/i);
  });
});

describe("clear_attachments un-stages without deleting", () => {
  it("empties the queue and reports how many it took", async () => {
    await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`, `${ROOT}/ui/mock.png`]);

    const r = clearAttachments(AGENT);

    expect(r.ok && r.data.cleared).toBe(2);
    expect(staged()).toEqual([]);
  });

  it("says plainly that nothing was deleted from disk", async () => {
    await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`]);

    const r = clearAttachments(AGENT);

    expect(r.ok && r.data.detail).toMatch(/deleted from disk/i);
  });
});

describe("an agent nobody holds is refused, on every op", () => {
  it("refuses attach, list and clear alike", async () => {
    const a = await attachToMessage("ghost", [`${ROOT}/docs/spec.md`]);
    expect(!a.ok && a.reason).toBe(ATTACHMENT_REFUSALS.unknownAgent);
    // Nothing was staged for the invented id either — an unknown agent must not accumulate a queue
    // that no compose box will ever drain.
    expect(usePendingAttachmentsStore.getState().pending.ghost).toBeUndefined();

    const l = listAttachments("ghost");
    expect(!l.ok && l.reason).toBe(ATTACHMENT_REFUSALS.unknownAgent);

    const c = clearAttachments("ghost");
    expect(!c.ok && c.reason).toBe(ATTACHMENT_REFUSALS.unknownAgent);
  });

  it("does not touch the filesystem for an unknown agent", async () => {
    await attachToMessage("ghost", [`${ROOT}/docs/spec.md`]);

    expect(probed()).toEqual([]);
  });

  it("keeps another agent's queue to itself", async () => {
    await attachToMessage(AGENT, [`${ROOT}/docs/spec.md`]);

    expect(usePendingAttachmentsStore.getState().pending.other).toBeUndefined();
    expect(listAttachments(AGENT).ok).toBe(true);
  });
});
