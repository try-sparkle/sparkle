import { describe, it, expect } from "vitest";
import {
  initialSetupState,
  setupReducer,
  allPrereqsInstalled,
  setupComplete,
  anyInstalling,
  PREREQ_ORDER,
  type SetupState,
  type SetupEvent,
} from "./setupState";

/** Fold a list of events over the initial state — mirrors how the component dispatches. */
function run(events: SetupEvent[], start: SetupState = initialSetupState()): SetupState {
  return events.reduce(setupReducer, start);
}

const allInstalled: SetupEvent = {
  type: "detected",
  statuses: {
    git: { installed: true, path: "/g" },
    node: { installed: true, path: "/n" },
    claude: { installed: true, path: "/c" },
  },
};

describe("setup checklist state machine", () => {
  it("starts with all three rows checking", () => {
    const s = initialSetupState();
    expect(s.rows.git.phase).toBe("checking");
    expect(s.rows.node.phase).toBe("checking");
    expect(s.rows.claude.phase).toBe("checking");
    expect(allPrereqsInstalled(s)).toBe(false);
    expect(setupComplete(s)).toBe(false);
  });

  it("all-missing: a detect pass with nothing installed marks every row missing", () => {
    const s = run([
      {
        type: "detected",
        statuses: {
          git: { installed: false, path: null },
          node: { installed: false, path: null },
          claude: { installed: false, path: null },
        },
      },
    ]);
    expect(s.rows.git.phase).toBe("missing");
    expect(s.rows.node.phase).toBe("missing");
    expect(s.rows.claude.phase).toBe("missing");
  });

  it("installing → installed transitions a single row and streams progress", () => {
    let s = run([{ type: "detected", statuses: { node: { installed: false, path: null } } }]);
    s = setupReducer(s, { type: "installStart", key: "node" });
    expect(s.rows.node.phase).toBe("installing");
    s = setupReducer(s, { type: "installProgress", key: "node", message: "Unpacking…" });
    expect(s.rows.node.progress).toBe("Unpacking…");
    expect(anyInstalling(s)).toBe(true);
    s = setupReducer(s, { type: "installOk", key: "node", path: "/Users/x/.local/bin/node" });
    expect(s.rows.node.phase).toBe("installed");
    expect(s.rows.node.path).toBe("/Users/x/.local/bin/node");
    expect(anyInstalling(s)).toBe(false);
  });

  // THE SHAPE CHANGE THIS SUITE EXISTS TO PIN. Installing all three now COMPLETES the checklist.
  // It used to leave `setupComplete` false pending a fourth `claude login` step — the step that
  // could only ever run on a fresh machine, and so had no way to ask a returning user whose session
  // had expired. Auth moved to ReadinessGate; this screen ends when the installs end.
  it("installing all three completes the checklist — there is no login step left to wait on", () => {
    let s = run([
      {
        type: "detected",
        statuses: {
          git: { installed: false, path: null },
          node: { installed: false, path: null },
          claude: { installed: false, path: null },
        },
      },
    ]);
    expect(setupComplete(s)).toBe(false);
    for (const key of PREREQ_ORDER) {
      s = setupReducer(s, { type: "installStart", key });
      s = setupReducer(s, { type: "installOk", key, path: `/path/${key}` });
    }
    expect(allPrereqsInstalled(s)).toBe(true);
    expect(setupComplete(s)).toBe(true);
  });

  // Guards the deletion itself. A `loginStart`/`loginDone`/`loginReset` left behind anywhere — in a
  // stale dispatch, or re-added by someone restoring the old flow — must not resurrect a fourth
  // gating step. The reducer's default branch returns state unchanged, and `setupComplete` is
  // decided by the install rows alone, so an unknown event can neither block nor complete the
  // screen. Cast because these events are no longer in the union, which is the assertion.
  it("a leftover login event cannot gate or un-gate the checklist", () => {
    const s = run([allInstalled]);
    expect(setupComplete(s)).toBe(true);
    for (const stale of ["loginStart", "loginDone", "loginReset"]) {
      const after = setupReducer(s, { type: stale } as unknown as SetupEvent);
      expect(setupComplete(after)).toBe(true);
      expect(after.rows).toEqual(s.rows);
    }
    // And from an incomplete state, a stale login event cannot complete it either.
    const partial = run([{ type: "detected", statuses: { git: { installed: true, path: "/g" } } }]);
    expect(setupComplete(setupReducer(partial, { type: "loginDone" } as unknown as SetupEvent))).toBe(
      false,
    );
  });

  it("an install error surfaces on the row and blocks completion", () => {
    let s = run([{ type: "detected", statuses: { claude: { installed: false, path: null } } }]);
    s = setupReducer(s, { type: "installStart", key: "claude" });
    s = setupReducer(s, { type: "installError", key: "claude", error: "network down" });
    expect(s.rows.claude.phase).toBe("error");
    expect(s.rows.claude.error).toBe("network down");
    expect(setupComplete(s)).toBe(false);
  });

  it("a re-detect that finds a tool present overrides a prior error (install-then-poll race)", () => {
    let s = run([{ type: "detected", statuses: { git: { installed: false, path: null } } }]);
    s = setupReducer(s, { type: "installError", key: "git", error: "clt install pending" });
    expect(s.rows.git.phase).toBe("error");
    // Polling git_preflight later finds it — the row goes green.
    s = setupReducer(s, {
      type: "detected",
      statuses: { git: { installed: true, path: "/usr/bin/git" } },
    });
    expect(s.rows.git.phase).toBe("installed");
    expect(s.rows.git.error).toBeNull();
  });

  it("a detect pass does not clobber an in-flight install", () => {
    let s = run([{ type: "detected", statuses: { node: { installed: false, path: null } } }]);
    s = setupReducer(s, { type: "installStart", key: "node" });
    // A stale detect that still reports missing must NOT knock node out of `installing`.
    s = setupReducer(s, { type: "detected", statuses: { node: { installed: false, path: null } } });
    expect(s.rows.node.phase).toBe("installing");
  });

  it("a re-detect that still finds everything present keeps the checklist complete", () => {
    let s = run([allInstalled]);
    expect(setupComplete(s)).toBe(true);
    s = setupReducer(s, { type: "detected", statuses: { claude: { installed: true, path: "/c" } } });
    expect(setupComplete(s)).toBe(true);
  });
});
