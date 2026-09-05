import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE OPERATOR LANE HAS EXACTLY ONE CALL SITE, AND THAT IS THE WHOLE SAFETY ARGUMENT
 * (bead sparkle-eou3y0.1; roborev job 81327 graded the missing half a High, correctly).
 *
 * Rust's `Lane::Operator` lets a send DISPLACE another agent's undelivered `act` from a full,
 * provably-stalled inbox. The reason that is safe is not a property of the enum — it is that only
 * the concierge's own tool surface asks for it. `services/peerMessaging.ts`,
 * `beadMentions/beadMentionWatch.ts`, `pusherMount.ts` and `pipelineHealthEscalation.ts` all invoke
 * `inbox_send` directly and pass no lane, so the flood that fills a queue can never be the traffic
 * that displaces from it.
 *
 * WHY THIS FILE EXISTS. `lane` is an OPTIONAL field on the Tauri command, defaulting to the safe
 * `Lane::Ordinary`. That default is right for every other caller and is exactly what makes the
 * dangerous direction silent: adding `lane: "operator"` to any other `invoke("inbox_send", …)`
 * anywhere in the webview hands agent-originated traffic eviction power over another agent's mail,
 * and NOTHING errors, NOTHING type-checks differently, and no existing test reds.
 *
 * `fleet.test.ts` pins the POSITIVE half — that `inboxSend` does send `operator`. Deleting that is
 * not the risk; ADDING a second one is, and `AGENTS.md` names the widening direction as the
 * dangerous one that must be pinned. The Rust
 * `ordinary_traffic_cannot_displace_even_a_stalled_queue` test covers the enum, not which callers
 * reach for it. This covers the callers.
 */

// `fileURLToPath`, never `new URL(..).pathname`: every worktree on this machine lives under a path
// containing a space ("Application Support"), which a URL pathname percent-encodes into a directory
// that does not exist — a walk rooted there reads nothing and every count below reads zero.
const SRC = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

/**
 * A scan that matched nothing would make every assertion here vacuous: they all gate on a COUNT,
 * and zero satisfies "exactly the allowed set" for the negative half forever, over a tree nobody
 * opened. THROWS rather than returning an empty list, so the vacuity is impossible rather than
 * merely detectable.
 */
const MIN_SCANNED_FILES = 200;
function scannedSourceFiles(): string[] {
  const files = sourceFiles(SRC);
  if (files.length < MIN_SCANNED_FILES) {
    throw new Error(
      `the source scan under ${SRC} found ${files.length} file(s), below the floor of ` +
        `${MIN_SCANNED_FILES}. Every assertion in this file gates on a count, so a truncated or ` +
        `empty scan reports GREEN while guarding nothing. Fix the walk — do not lower this floor.`,
    );
  }
  return files;
}

/** Repo-relative-ish path, so a failure message names a file a reader can open. */
const rel = (p: string) => p.slice(SRC.length).split(sep).join("/");

/** Non-test files that invoke the `inbox_send` Tauri command. */
function inboxSendCallers(): string[] {
  return scannedSourceFiles().filter((f) => readFileSync(f, "utf8").includes('"inbox_send"'));
}

/** The one file allowed to ask for the operator lane. */
const OPERATOR_CALL_SITE = "services/conciergeTools/fleet.ts";

describe("the operator lane has exactly one call site", () => {
  /**
   * The anti-vacuity anchor for the SET, not just for the file count: if `"inbox_send"` were ever
   * spelled differently — a constant, a template — this scan would find nothing to judge and the
   * assertions below would pass over an empty set. Four is the measured floor; the real set is
   * larger and is allowed to grow.
   */
  it("finds the inbox_send call sites it is supposed to be judging", () => {
    const callers = inboxSendCallers().map(rel);
    expect(
      callers,
      `the scan found ${callers.length} non-test file(s) invoking "inbox_send". This guard judges ` +
        `that set, so an empty or truncated one passes while guarding nothing. If the command name ` +
        `is no longer spelled as the string literal "inbox_send", teach this scan the new spelling ` +
        `— do not lower this floor.\n${callers.join("\n")}`,
    ).toContain(OPERATOR_CALL_SITE);
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  it("only the concierge tool surface asks for lane: operator", () => {
    const asking = scannedSourceFiles()
      .filter((f) => /lane\s*:\s*"operator"/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(
      asking,
      `${asking.length} non-test file(s) pass lane: "operator" to the inbox. Exactly one may: ` +
        `${OPERATOR_CALL_SITE}, the concierge's own tool surface, reached only from ` +
        `conciergeTools/registry.ts. That lane lets a send DISPLACE another agent's undelivered ` +
        `\`act\` from a full stalled inbox; granting it to a path an agent can call makes the ` +
        `flood that fills a queue also the traffic that empties it. If a new operator surface ` +
        `genuinely needs it, add it here deliberately — do not delete this assertion.\n` +
        `${asking.join("\n")}`,
    ).toEqual([OPERATOR_CALL_SITE]);
  });

  it("every other inbox_send caller passes no lane at all", () => {
    const leaking = inboxSendCallers()
      .filter((f) => rel(f) !== OPERATOR_CALL_SITE)
      .filter((f) => /\blane\s*:/.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(
      leaking,
      `these inbox_send callers mention a \`lane:\` key: they must pass none, so Rust defaults them ` +
        `to the safe Lane::Ordinary. A lane spelled through a variable or a spread is exactly as ` +
        `dangerous as the literal and is why this assertion is broader than the one above.\n` +
        `${leaking.join("\n")}`,
    ).toEqual([]);
  });
});
