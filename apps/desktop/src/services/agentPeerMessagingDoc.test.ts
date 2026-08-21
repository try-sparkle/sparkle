// A GUARD OVER `docs/agent-peer-messaging.md`, because nothing read it (roborev 66542).
//
// That doc is the frozen wire contract for `send_peer_message`, and until now NOTHING in the tree
// referenced it — no suite, no script. So every claim in it was unpinned, and on one branch four
// separate claims went stale and shipped: a header announcing a `FLEET-WIDE` exemption that had been
// withdrawn, a pointer to a module that had been deleted, a sender-label format main had changed,
// and a scope union missing a value. Each was caught by a human or a reviewer reading prose.
//
// This pins only the MECHANICAL claims — the ones a test can check without restating the doc. Each
// assertion names something real (a file, a tuple, a template, a symbol), so it reds when that thing
// moves.
//
// EVERY PATTERN HERE IS DELIBERATELY WIDER THAN THE THING IT MATCHES, because the hazard of a guard
// like this is not a false red — it is going INERT on the one edit it exists to catch (roborev
// 67106). A pattern narrower than the copy stops matching, and a fail-closed assertion then reports
// "the doc's style changed" for a doc that is correct, or silently checks a smaller set than it
// claims to.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STATE_SCOPES } from "@sparkle/core";
import { peerLabel } from "./peerMessaging";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DOC = `${REPO_ROOT}docs/agent-peer-messaging.md`;
const LISTENER = fileURLToPath(new URL("./controlListener.ts", import.meta.url));

/** Every path git tracks, so a pointer is checked against the repo's own index rather than a root
 *  this file guesses at.
 *
 *  THE DOC WRITES ITS POINTERS REPO-ROOT-QUALIFIED, and the check below requires exactly that.
 *  It did not always: `services/fleetWatch.ts`, `src/server.ts` and `src-tauri/src/inbox.rs` were
 *  each written at whatever depth read well in context, and a guard that resolves a fragment by
 *  SUFFIX cannot make those falsifiable — `src/server.ts` ended three tracked paths
 *  (`apps/mcp-control`, `apps/mcp-orchestrator`, `apps/orchestration`), so deleting the intended one
 *  still matched a stranger. Rejecting only the fragments that COLLIDE fixed those instances and not
 *  the rule: a collision is observable only while the intended file and the stranger both exist,
 *  which is precisely not the state this guard is written for (roborev 67130/67135). An exact match
 *  is falsifiable by construction rather than by coincidence of what else the repo tracks today. */
const TRACKED = new Set(
  execFileSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean),
);

/** Suffix matches, used ONLY to turn a miss into "did you mean …" — never to accept a pointer. */
const suffixMatches = (rel: string): string[] =>
  [...TRACKED].filter((p) => p.endsWith(`/${rel}`));

/** The body of `handleSendPeerMessage` alone — the file holds an unrelated
 *  `isSparkleAgentId(req.callerAgentId)` in another handler (line ~725), so a whole-file count
 *  cannot say anything about the hoist. */
function handleSendPeerMessageBody(source: string): string {
  const start = source.indexOf("async function handleSendPeerMessage(");
  if (start === -1) return "";
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:async )?function /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("docs/agent-peer-messaging.md stays true to the code it freezes", () => {
  const doc = readFileSync(DOC, "utf8");

  it("is actually readable — every assertion below is vacuous otherwise", () => {
    expect(doc.length).toBeGreaterThan(1000);
  });

  it("names no source file that does not exist", () => {
    // The `peerCallerResolve.ts` pointer outlived the module by two commits. A path in this doc is a
    // reader's next click, so a dead one sends them looking for code that is not there.
    //
    // MATCHES ANY BACKTICKED PATH WITH A SLASH, not just `services/…`. The first version anchored on
    // that prefix and therefore saw exactly one of the six pointers the doc carries — including
    // NEITHER `apps/desktop/src/services/controlListener.ts`, the module this whole doc freezes, nor
    // the two Rust files. The `length > 0` sentinel was satisfied by that one match, so it read as
    // "the pointers are pinned" while five of six were unchecked (roborev 67106).
    const named = [
      ...new Set(
        [...doc.matchAll(/`([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.(?:ts|tsx|rs))`/g)].map(
          (m) => m[1]!,
        ),
      ),
    ];
    // A COUNT, not just non-empty. Non-empty goes green on one surviving match while the pattern has
    // stopped seeing the rest — the exact way this assertion was already wrong once. Six today; if a
    // pointer is deliberately removed, lower this in the same commit and say which.
    expect(
      named.length,
      `expected at least 6 backticked source paths, found ${named.length}: ${named.join(", ")}`,
    ).toBeGreaterThanOrEqual(6);
    const unqualified = named.filter((rel) => !TRACKED.has(rel));
    expect(
      unqualified.map((rel) => {
        const near = suffixMatches(rel);
        return near.length
          ? `${rel} — not a tracked path; did you mean ${near.join(" or ")}?`
          : `${rel} — names no tracked file at all`;
      }),
      "every pointer must be written repo-root-qualified, so it is falsifiable on its own",
    ).toEqual([]);
    // AND THE INDEX IS NOT THE DISK. `git ls-files` answers from the index, so a module removed with
    // plain `rm` and not yet staged is still "tracked" — which the `existsSync` this grew out of got
    // right. Both: the index says the path is a real repo path, the stat says the file is still there.
    expect(
      named.filter((rel) => !existsSync(`${REPO_ROOT}${rel}`)),
      "tracked but not on disk — deleted without staging?",
    ).toEqual([]);
  });

  it("prints the scope union that `STATE_SCOPES` actually holds", () => {
    // The doc enumerated four values while the tuple held five, six lines below a paragraph telling a
    // caller to use the fifth. `uncallableStateScopesIn` cannot catch that: it flags scopes NAMED
    // that do not exist, never a union that OMITS one.
    //
    // SCOPED TO THE UNION LITERAL, not the whole document. The first version of this asserted
    // `doc.toContain('"fleet"')` — and "fleet" appears all over this doc, so dropping it from the
    // UNION still passed. That is the "positives satisfied by another part of the blob" defect,
    // reproduced inside the guard written to end it; the mutation run is what exposed it.
    //
    // CAPTURES `[^"`]+`, NOT `[a-z]+` — the same correction `stateScopesNamedIn` already carries one
    // file away (roborev 66304). A scope named `all_projects`, `project-fleet` or `activeOnly` does
    // not match a lowercase-only class AT ALL, so the alternation would stop matching line 181
    // entirely and the engine would scan on to some unrelated union — and a NEW scope is precisely
    // where an underscore or a capital gets introduced, which is the one edit this exists to catch.
    const unions = [...doc.matchAll(/`("[^"`]+"(?:\s*\|\s*"[^"`]+")+)`/g)];
    expect(
      unions.length,
      'expected exactly one `"a" | "b"` union literal in the doc — if a second is added, this guard ' +
        "must be told which one is the scope union rather than silently taking the first",
    ).toBe(1);
    const printed = [...unions[0]![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect([...printed].sort()).toEqual([...STATE_SCOPES].sort());
  });

  it("describes the sender label the code actually produces", () => {
    // Main changed this to `Name [id]` while the doc still promised a bare display name.
    expect(doc).toContain(peerLabel("<displayName>", "<agentId>"));
  });

  it("does not still advertise the withdrawn FLEET-WIDE caller exemption", () => {
    // Fleet scope was implemented and withdrawn: the caller id is stamped on the SHARED control
    // socket and is claimable, so any roster it reaches is one a forged stamp reaches
    // (`sparkle-w04ess`). The header announcing it survived the withdrawal by two commits.
    expect(doc).not.toMatch(/FLEET-WIDE/);
  });

  it("still says the no-roster rule is enforced at more than one point", () => {
    // The rule lives in the caller chain AND the sibling-candidate gate. A merge once took main's
    // side at the first and dropped the second, reopening the hole. The doc must keep warning.
    expect(doc).toMatch(/callerIsAppOwned/);
    expect(doc).toMatch(/sparkle-w04ess/);
  });

  it("names a hoisted const the code still actually has, used at every enforcement point", () => {
    // THE DOC SIDE ALONE PINS NOTHING (roborev 67106). Re-inlining either use back to
    // `isSparkleAgentId(req.callerAgentId)` is behaviour-identical: the SPARKLE_PROJECT_ID test stays
    // green, this suite stays green because the doc text never moved, and the doc's claim that there
    // is ONE thing to change becomes false — restoring exactly the drift that dropped the sibling
    // gate. Renaming the const is the same defect wearing an identifier instead of a path, and the
    // pointer check above cannot see it.
    const body = handleSendPeerMessageBody(readFileSync(LISTENER, "utf8"));
    expect(body, "handleSendPeerMessage not found — has it been renamed?").toContain(
      "const siblings",
    );
    // ONE declaration + one use at each of the three decision points.
    expect((body.match(/callerIsAppOwned/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // …and the predicate is called ONCE inside this handler. A second call is a re-inlined use.
    expect((body.match(/isSparkleAgentId\(req\.callerAgentId\)/g) ?? []).length).toBe(1);
  });
});
