// THE TWO FACTS THIS FILE HOLDS TOGETHER LIVE IN THREE FILES AND TWO LANGUAGES, AND NOTHING ELSE
// CAN FAIL WHEN THEY DRIFT.
//
// `beads_create` runs a create and then PROBES the store for the row before reporting success, so
// one command is two bd invocations and its budget is their SUM. `plans:create_plan` reaches it
// through the concierge bridge, which kills a tool call at `CONCIERGE_TOOL_TIMEOUT_MS`. Those two
// numbers are declared in different packages and different languages, and neither compiles against
// the other — so a perfectly reasonable edit on either side silently reintroduces the exact failure
// the probe was added to remove: the bridge killing the call TEN SECONDS AFTER bd confirmed the
// write, reporting a timeout for a bead that is sitting in the store.
//
// WHY THIS GUARD IS IN TYPESCRIPT RATHER THAN IN THE RUST SUITE, where the constants it reads
// mostly live: a Rust test that reads `apps/mcp-control/src/tools.ts` obliges `RUST_RE` in
// `.github/workflows/ci.yml` to name that path — and `RUST_RE` is the filter deciding whether the
// macOS (10x billing multiplier) and Windows (2x) legs run. `tools.ts` is an actively edited file,
// so that is a standing bill for a check that costs nothing here. Coverage is identical: any
// non-docs change sets `code=true`, which runs this suite, INCLUDING a change to `beads_cmd.rs`
// itself. `scripts/tests/ci-change-filter.test.sh` is what caught the first version of this doing
// it the expensive way.
//
// READING THE SOURCES IS THE POINT. A shared generated constant would be tidier and would add a
// build step to keep three declarations in sync; a grep-shaped assertion costs nothing and fails
// loudly at exactly the moment they diverge — the same argument `claude_oneshot.rs` makes for its
// own env-scrub guard, applied in the cheaper direction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CREATE_PLAN_BRIDGE_HEADROOM_MS,
  CREATE_PLAN_DEDUPE_BUDGET_MS,
  CREATE_PLAN_TOTAL_BUDGET_MS,
  WRITE_DROPPED_MARKER,
} from "./beadsCommands";

// `fileURLToPath`, NOT `new URL(...).pathname` — a URL keeps this repo's path percent-encoded
// ("Application%20Support"), which resolves to nothing and, thanks to the fail-closed reader below,
// reds the whole guard rather than silently skipping it. That is the right failure, but it is not
// one to leave in place.
const HERE = dirname(fileURLToPath(import.meta.url));
const BEADS_CMD_RS = join(HERE, "../../src-tauri/src/beads_cmd.rs");
const MCP_TOOLS_TS = join(HERE, "../../../mcp-control/src/tools.ts");

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    // FAIL-CLOSED. A guard that cannot read its subject must never report agreement — that is the
    // shape where a moved file turns a live check into a permanent green.
    throw new Error(`cannot read ${path}: ${String(e)}`);
  }
}

/** Seconds out of a `const NAME: Duration = Duration::from_secs(N);` declaration. Scoped to the
 *  DECLARATION rather than to any mention of the name, so a comment quoting the number cannot
 *  satisfy it. */
function fromSecs(src: string, name: string): number {
  const m = new RegExp(`const\\s+${name}\\s*:\\s*Duration\\s*=\\s*Duration::from_secs\\((\\d+)\\)`).exec(
    src,
  );
  expect(m, `beads_cmd.rs must declare ${name} as a Duration::from_secs(...)`).not.toBeNull();
  return Number(m![1]);
}

describe("the Rust create path's budget fits under the bridge ceiling that kills it", () => {
  // WHAT THIS ASSERTS, AND WHY IT NO LONGER ADDS UP bd BUDGETS.
  //
  // Two earlier versions of this guard summed the Rust constants and PASSED while the real worst
  // case blew the ceiling. The first forgot the dedupe read the same commit introduced (40s
  // modelled, 70s real). The second, with the dedupe counted, forgot `READER_DRAIN_GRACE`: after a
  // bd child exits, `run_cmd_timed` waits up to 5s on stdout and then up to another 5s on stderr,
  // serially, skipped only on the kill path — so every COMPLETED invocation costs `timeout + 2 x
  // grace`, not `timeout` (65s real). A guard that reads as pinning the ceiling while the chain can
  // exceed it by 15s is worse than no guard, because it stops anyone looking.
  //
  // The fix was not to count more carefully. `create_plan` now carries ONE wall-clock deadline over
  // the whole chain, measured on the clock the bridge is watching, so whatever bd's internals,
  // drains, IPC or a future stage cost, that deadline fires first. This assertion is therefore
  // COMPLETE in a way no sum could be: it is about the only number that bounds the call.
  it("the create_plan deadline leaves real headroom under CONCIERGE_TOOL_TIMEOUT_MS", () => {
    const ts = read(MCP_TOOLS_TS);
    const decl = "export const CONCIERGE_TOOL_TIMEOUT_MS";
    const at = ts.indexOf(decl);
    expect(at, "tools.ts must declare CONCIERGE_TOOL_TIMEOUT_MS").toBeGreaterThan(-1);
    const tail = ts.slice(at + decl.length);
    const end = tail.indexOf(";");
    expect(end, "CONCIERGE_TOOL_TIMEOUT_MS must be a terminated declaration").toBeGreaterThan(-1);
    const ceilingMs = Number(tail.slice(0, end).replace(/[^\d]/g, ""));
    expect(ceilingMs).toBeGreaterThan(0);

    expect(
      CREATE_PLAN_TOTAL_BUDGET_MS + CREATE_PLAN_BRIDGE_HEADROOM_MS,
      `create_plan's own deadline is ${CREATE_PLAN_TOTAL_BUDGET_MS}ms and the bridge kills the call ` +
        `at ${ceilingMs}ms. Shorten CREATE_PLAN_TOTAL_BUDGET_MS rather than widening the ceiling, ` +
        `which the concierge's stall threshold caps — and note that expiring on our own deadline is ` +
        `STRICTLY better than a bridge kill: both mean "unknown", but ours arrives as an actionable ` +
        `refusal naming list_plans instead of an opaque transport error.`,
    ).toBeLessThanOrEqual(ceilingMs);

    // The dedupe is only an optimisation, and it must not be able to eat the budget the WRITE
    // needs. A read allowed to spend most of the total would make the create expire for the sake of
    // a check that is allowed to fail open anyway.
    expect(CREATE_PLAN_DEDUPE_BUDGET_MS * 4).toBeLessThan(CREATE_PLAN_TOTAL_BUDGET_MS);
  });

  // The Rust-side LOCAL invariant is still worth pinning here, because it is the one that decides
  // how much of our deadline a single create can consume. It is NOT a model of the total.
  it("the confirmation probe is bounded well under a full bd budget", () => {
    const rs = read(BEADS_CMD_RS);
    expect(fromSecs(rs, "BD_CONFIRM_PROBE_TIMEOUT")).toBeLessThan(fromSecs(rs, "BD_TIMEOUT"));
  });

  it("the write-dropped wording TS branches on is the one Rust actually emits", () => {
    // The TS side classifies a create failure by this MESSAGE, not by its kind: `badOutput` also
    // covers version skew and partial reads, which prove nothing about whether the row landed. So a
    // reword in Rust silently demotes a PROVEN not-created into an UNKNOWN outcome, and the
    // concierge stops being able to tell the user it is safe to retry.
    const rs = read(BEADS_CMD_RS);
    const at = rs.indexOf("fn write_dropped(");
    expect(at, "beads_cmd.rs must define write_dropped").toBeGreaterThan(-1);
    // Scoped to the function body, so the phrase appearing in a doc comment elsewhere in the file
    // cannot satisfy this.
    const body = rs.slice(at, at + 800);
    expect(body).toContain(WRITE_DROPPED_MARKER);
  });
});
