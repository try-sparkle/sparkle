import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE SEAM NO OTHER TEST CROSSES (bead `sparkle-he5rq6`, epic `sparkle-dlrqb8`).
 *
 * `apps/mcp-control/src/tools.ts` WRITES the preview bridge payload; `handlePreview` in
 * `apps/desktop/src/services/controlListener.ts` READS it. They must agree on every key — and
 * NOTHING EXECUTES BOTH SIDES. The reason is stated in the code itself (tools.ts and
 * tools.test.ts both say so): the mcp-control suite MOCKS `Bridge`, and the desktop suite hands a
 * payload STRAIGHT to `dispatch`. Neither ever crosses the socket where a mis-spelled field is
 * lost, so a key threaded through only one side ships INERT with both suites green.
 *
 * That is not hypothetical. `concierge_tool` shipped inert in v0.55.0 by exactly this failure —
 * every op-dispatched tool dying `unknown-op` while `get_state`, which carries no inner op, worked.
 * The repair was the `toolOp` rename; `previewOp` is the same rename made before the outage.
 *
 * The existing guards in `buildAgent.test.ts` span BRIEF ↔ MCP SCHEMA. This one spans
 * MCP WIRE KEY ↔ THE HANDLER THAT READS IT, which is the other half and was unguarded.
 *
 * WHY THIS IS GENERIC OVER THE KEY SET rather than pinning today's three names: the payload has
 * already grown once (`target`, bead `sparkle-eqbtqg`, added after `previewOp` and `path`). A test
 * enumerating expected names by hand cannot see the NEXT key added to one side only, which is the
 * direction drift actually travels. So both sides are parsed and compared.
 *
 * EVERY EXTRACTION FAILS CLOSED. If an anchor moves, these tests ERROR naming what they could not
 * find. A guard that passes because it parsed nothing is worse than no guard, because it reads as
 * a check that has been performed.
 */

const toolsSrc = readFileSync(
  fileURLToPath(new URL("../../../mcp-control/src/tools.ts", import.meta.url)),
  "utf8",
);
const serverSrc = readFileSync(
  fileURLToPath(new URL("../../../mcp-control/src/server.ts", import.meta.url)),
  "utf8",
);
const listenerSrc = readFileSync(fileURLToPath(new URL("./controlListener.ts", import.meta.url)), "utf8");

/**
 * The CODE portion of a line: comments and string/template literals removed.
 *
 * LOAD-BEARING, not hygiene. The depth scans below count `{ ( [` / `} ) ]` to find which keys sit
 * at the top level. Counting those characters inside PROSE is a silent false pass waiting to
 * happen: the payload literal in tools.ts is ~25 lines of dense commentary around three keys, and
 * it parses correctly today only because that commentary happens to be bracket-balanced. One
 * net-unbalanced bracket in a comment — an enumeration like `1) … 2) …`, a `:)`, a comment naming
 * a literal `}` — drives the depth off zero and every key AFTER it is skipped. The anti-vacuity
 * assertions would still hold (`previewOp` is written first), `unread` would compute to `[]`, and
 * the guard would go green while the newly-added key it exists to catch was invisible. That is
 * failure in exactly the direction this file guards.
 */
function codeOnly(line: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break;
    out += ch;
  }
  return out;
}

/** Is this line pure commentary? Used to keep a MENTION of a key from standing in for a real read. */
function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/** Brace-match from the first `{` at or after `from`. Returns the body, or null if unbalanced. */
function balancedBody(src: string, from: number): string | null {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The keys `previewTool` puts on the wire: the object literal handed to `bridge.request("preview", …)`. */
function payloadKeysWritten(): Set<string> {
  const fn = toolsSrc.indexOf("export async function previewTool(");
  expect(fn, "could not find `previewTool` in mcp-control/src/tools.ts").toBeGreaterThan(-1);
  const req = toolsSrc.indexOf('bridge.request("preview"', fn);
  expect(req, "could not find previewTool's `bridge.request(\"preview\", …)` call").toBeGreaterThan(-1);
  const body = balancedBody(toolsSrc, req);
  expect(body, "the preview payload literal's braces never balanced — refusing to guess").not.toBeNull();

  // Top-level keys only, so a nested `{ target }` inside a conditional spread is not double-counted
  // as its own entry and a `z.enum([...])`-style nested call cannot contribute a name.
  const keys = new Set<string>();
  let d = 0;
  for (const raw of (body as string).split("\n")) {
    const line = codeOnly(raw);
    const m = /^\s*(?:\.\.\.\([^)]*\?\s*\{\s*)?([A-Za-z_$][\w$]*)\s*[:,}]/.exec(line);
    const name = m?.[1];
    if (d === 0 && name) keys.add(name);
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") d++;
      else if (ch === "}" || ch === ")" || ch === "]") d--;
    }
  }
  // LOUD, not silent. If the scan did not return to depth 0 the key set is under-parsed, and the
  // containment check downstream would pass on a partial list — green for the wrong reason.
  expect(
    d,
    "brace scan of the preview payload literal did not return to depth 0 — the key set is " +
      "under-parsed and this guard would certify a partial list. Fix the scan; do not relax it.",
  ).toBe(0);
  return keys;
}

/** The keys `handlePreview` reads off `req.payload`. */
function payloadKeysRead(): Set<string> {
  const fn = listenerSrc.indexOf("async function handlePreview(");
  expect(fn, "could not find `handlePreview` in controlListener.ts").toBeGreaterThan(-1);
  const body = balancedBody(listenerSrc, fn);
  expect(body, "handlePreview's braces never balanced — refusing to guess").not.toBeNull();
  // Comment lines are dropped BEFORE the match: a comment that merely MENTIONS `req.payload.foo`
  // would otherwise satisfy the containment check for a key nothing actually reads — the reader
  // side of the same false-pass hole the depth scan has.
  const code = (body as string)
    .split("\n")
    .filter((l) => !isCommentLine(l))
    .map(codeOnly)
    .join("\n");
  const keys = new Set<string>();
  for (const m of code.matchAll(/req\.payload\.([A-Za-z_$][\w$]*)/g)) {
    const k = m[1];
    if (k) keys.add(k);
  }
  return keys;
}

describe("preview wire keys — the seam between mcp-control and the desktop handler", () => {
  it("every payload key mcp-control WRITES is one the desktop handler READS", () => {
    const written = payloadKeysWritten();
    const read = payloadKeysRead();

    // Anti-vacuity, both sides. A degenerate parse must fail here rather than certify nothing.
    expect(
      written.size,
      "parsed zero keys out of previewTool's payload — the guard would be vacuous",
    ).toBeGreaterThan(0);
    expect(
      read.size,
      "parsed zero `req.payload.*` reads out of handlePreview — the guard would be vacuous",
    ).toBeGreaterThan(0);
    expect(
      written.has("previewOp"),
      `parsed ${JSON.stringify([...written].sort())} from the writer — expected the sub-op key`,
    ).toBe(true);
    expect(
      read.has("previewOp"),
      `parsed ${JSON.stringify([...read].sort())} from the reader — expected the sub-op key`,
    ).toBe(true);

    // THE CONTRACT. Not equality: the handler may defensively read a key the writer no longer
    // sends, which is harmless. Drift is the writer sending something NOTHING READS — that field
    // is silently dropped on arrival and the feature behind it is inert.
    const unread = [...written].filter((k) => !read.has(k));
    expect(
      unread,
      `mcp-control's previewTool puts ${JSON.stringify(unread)} on the wire, but handlePreview ` +
        `never reads ${unread.length === 1 ? "it" : "them"} (it reads ` +
        `${JSON.stringify([...read].sort())}). The field is dropped on arrival, silently, and ` +
        "neither package's own suite can see it: mcp-control mocks Bridge and the desktop suite " +
        "calls dispatch directly, so nothing crosses the socket. Thread it through both sides.",
    ).toEqual([]);
  });

  it("the sub-op rides as `previewOp` on BOTH sides — never as `op`", () => {
    // `op` is one of `CONTROL_RESERVED_FIELDS` in apps/desktop/src-tauri/src/bridge.rs
    // (id/token/op/callerAgentId/deadlineMs). BridgeClient frames the wire line with the envelope
    // LAST — deliberately, so a caller cannot forge its own token or identity — so an INNER field
    // named `op` is overwritten by the envelope's own op ("preview"), and bridge.rs then strips the
    // survivor as reserved before building `payload`. The app would receive a preview request that
    // never says which operation to run.
    expect(payloadKeysWritten().has("op"), "previewTool must not put a bare `op` on the wire — it is reserved").toBe(
      false,
    );
    expect(payloadKeysRead().has("op"), "handlePreview must not read a bare `op` — it never survives the envelope").toBe(
      false,
    );
  });

  it("the AGENT-FACING schema key stays `op`, so the two namespaces cannot be collapsed", () => {
    // The wire key and the tool argument are deliberately DIFFERENT words. A future "consistency"
    // cleanup that renames the schema key to `previewOp` would break every agent's first call with
    // MCP -32602 — which is the original defect this bead was filed for.
    const reg = serverSrc.indexOf('registerTool(\n    "preview"');
    expect(reg, "could not find the preview tool registration in mcp-control/src/server.ts").toBeGreaterThan(-1);
    const schemaAt = serverSrc.indexOf("inputSchema: {", reg);
    expect(schemaAt, "could not find the preview tool's inputSchema").toBeGreaterThan(-1);
    const body = balancedBody(serverSrc, schemaAt);
    expect(body, "inputSchema braces never balanced — refusing to guess the key set").not.toBeNull();

    // Same comment/string stripping and same depth assertion as the payload scans above — the
    // inputSchema block is also prose-heavy (`.describe("…")` strings full of punctuation), and an
    // apostrophe or bracket inside one of those descriptions would otherwise skew the scan.
    const registered = new Set<string>();
    let d = 0;
    for (const raw of (body as string).split("\n")) {
      const line = codeOnly(raw);
      const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line);
      const name = m?.[1];
      if (d === 0 && name) registered.add(name);
      for (const ch of line) {
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d--;
      }
    }
    expect(d, "brace scan of the preview inputSchema did not return to depth 0 — under-parsed").toBe(0);
    expect(registered.size, "parsed zero keys out of the preview inputSchema — vacuous").toBeGreaterThan(0);
    expect(registered.has("op"), `parsed ${JSON.stringify([...registered].sort())} — expected \`op\``).toBe(true);
    expect(
      registered.has("previewOp"),
      "`previewOp` is the internal WIRE key and must never become an agent-facing argument",
    ).toBe(false);
  });
});
