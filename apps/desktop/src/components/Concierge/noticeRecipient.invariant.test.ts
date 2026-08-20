// THE INVARIANT `noticeRecipient` RESTS ON, PINNED WHERE IT CAN ACTUALLY BREAK (roborev 65813).
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════════════════════════
// `./noticeRecipient` decides that a line is addressed to the CONCIERGE — and so should be greyed
// and re-attributed — by reading `ConciergeSparkleMessage.actionReceipt`. That is only sound while
// a receipt mark means "a call the concierge made". The whole correctness argument therefore rests
// on a property of a DIFFERENT file, and until this test existed nothing enforced it: the invariant
// was stated in a comment, and a comment cannot fail.
//
// THE FAILURE IT GUARDS IS SILENT AND POINTS THE EXPENSIVE WAY. The day someone posts a
// FOUNDER-addressed line through `postSparkle`'s third parameter, that line goes grey and is
// captioned as a message to somebody else. No type error, no test failure — just a row the founder
// stops reading because the app told him it was not for him. `noticeRecipient`'s own header calls
// that outcome "strictly worse than the bug being fixed", and the reviewer named a plausible route
// to it: `conciergeTools/lifecycle.ts`'s unattended `retired` receipt, whose own comment says the
// founder "asked to be told what was retired while he was away".
//
// ══ WHY A SOURCE SCAN RATHER THAN A TYPE ════════════════════════════════════════════════════════
// The sturdier fix is to make provenance explicit — a branded third parameter only `receiptMark`
// can produce. That is a larger change to a 7000-line component owned by several in-flight
// branches, and it is worth doing deliberately rather than as a passenger here. This is the cheap
// half that closes the hole now: it fails the moment a call site supplies a third argument from
// anywhere but `receiptMark`, which is the exact edit that would break the module.
//
// It reads the SOURCE rather than importing anything, because the property is syntactic — "what is
// passed at each call site" — and there is no runtime moment at which all the call sites exist.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOST = join(__dirname, "..", "ConciergeHost.tsx");

/**
 * Every `postSparkle(...)` call in the file, as its top-level argument list.
 *
 * Balances parentheses rather than matching a regex, because the arguments contain template
 * literals, nested calls (`line\`...\``, `ref(a)`, `receiptMark(receipt, resolve)`) and commas
 * inside all of them — a regex over this returns arguments that are not arguments. Strings and
 * template literals are skipped wholesale so a bracket or comma inside prose cannot desynchronise
 * the scan; that is not defensive, it is required, since these call sites are mostly English.
 */
export function stripComments(src: string): string {
  // ── WHY THIS IS REQUIRED, NOT TIDINESS (roborev 65819, Medium) ─────────────────────────────────
  // The scanner below skips strings so a bracket or comma inside prose cannot desynchronise it. A
  // COMMENT is the same hazard wearing different clothes, and this file's call sites are dense with
  // it: "couldn't", "didn't", "I'll". An unskipped apostrophe in a comment opens a phantom string
  // that runs to the next `'` hundreds of lines away, and parenthesis depth is then counted from a
  // corrupted position.
  //
  // The failure is SILENT AND TARGETED, which is what makes it worth the code: the outer loop
  // restarts from the raw source at each `postSparkle(`, so every OTHER call site still parses. The
  // guard stops examining precisely the call someone just edited — while both vacuity backstops
  // stay satisfied by the other 34 sites. A guard that exists to catch a silent mis-attribution
  // must not itself be able to go silently blind.
  //
  // Replaces with SPACES rather than deleting, so nothing that was separated becomes adjacent.
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      for (i++; i < src.length; i++) {
        out += src[i];
        if (src[i] === "\\") {
          i++;
          out += src[i] ?? "";
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      out += "\n";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      i--;
      continue;
    }
    out += c;
  }
  return out;
}

export function postSparkleCalls(rawSrc: string): string[][] {
  const src = stripComments(rawSrc);
  const calls: string[][] = [];
  const NEEDLE = "postSparkle(";
  for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + 1)) {
    // Skip the DEFINITION and any property access (`foo.postSparkle(`) — we want call sites.
    const before = src.slice(Math.max(0, i - 6), i);
    if (/[.\w]$/.test(before.slice(-1)) && !/\s|\(|,|^$/.test(before.slice(-1))) continue;

    let depth = 0;
    let arg = "";
    const args: string[] = [];
    let j = i + NEEDLE.length - 1; // sits on the '('
    for (; j < src.length; j++) {
      const c = src[j];
      // ── skip a string / template literal whole ──
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        arg += c;
        for (j++; j < src.length; j++) {
          arg += src[j];
          if (src[j] === "\\") {
            j++;
            arg += src[j];
            continue;
          }
          if (src[j] === quote) break;
        }
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        depth++;
        if (depth === 1) continue; // the call's own opening paren
        arg += c;
        continue;
      }
      if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          args.push(arg.trim());
          break;
        }
        arg += c;
        continue;
      }
      if (c === "," && depth === 1) {
        args.push(arg.trim());
        arg = "";
        continue;
      }
      arg += c;
    }
    calls.push(args.filter((a, idx) => a !== "" || idx === 0));
  }
  return calls;
}

describe("the receipt mark means what noticeRecipient assumes it means", () => {
  const src = readFileSync(HOST, "utf8");
  const calls = postSparkleCalls(src);

  it("finds the call sites at all — the scan is not vacuously green", () => {
    // If the helper is ever renamed, this test would otherwise pass by finding nothing and would
    // silently stop guarding anything. ConciergeHost has ~25 of these.
    expect(calls.length).toBeGreaterThan(10);
  });

  it("passes a third argument ONLY from receiptMark", () => {
    // THE ACTUAL INVARIANT. `postSparkle(line, collapsed, actionReceipt)` — a third argument is what
    // stamps the mark, and a mark is what `noticeRecipient` reads as "addressed to the concierge".
    // So any third argument that did not come from `receiptMark` is, by construction, a line being
    // re-attributed to the concierge on no evidence.
    // `thirdArg` is what makes the strict-null narrowing honest rather than a `!`: a call with fewer
    // than three arguments has no third one, and that is a real state rather than an impossible one.
    const thirdArg = (args: string[]): string => args[2] ?? "";
    const marked = calls.filter((args) => args.length >= 3 && thirdArg(args) !== "undefined");
    // ANCHORED, not a substring test (roborev 65819). `includes("receiptMark")` is satisfied by any
    // identifier merely CONTAINING it — `notReallyReceiptMarkAtAll`, or a property access on some
    // other object — so the check could pass on an argument that never called the real producer.
    const bad = marked.filter((args) => !/^receiptMark\s*\(/.test(thirdArg(args).trim()));
    expect(
      bad.map((args) => thirdArg(args).slice(0, 120)),
      "a postSparkle call supplies an actionReceipt from something other than receiptMark(); " +
        "see noticeRecipient.ts — this silently greys a line and captions it as not being for the founder",
    ).toEqual([]);
    // …and there IS at least one marked call, so the assertion above has a population. Without this
    // the test passes when the receipt bus is deleted, which is the same vacuity as above.
    expect(marked.length).toBeGreaterThan(0);
  });

  it("SEES a violation hidden behind a comment containing an apostrophe (roborev 65819)", () => {
    // The blind spot itself, as a fixture. Before `stripComments`, the apostrophe in "he didn't"
    // opened a phantom string and the scan desynchronised — so this exact call, the shape someone
    // would actually write, was skipped while the suite stayed green on the other call sites.
    const synthetic = [
      "postSparkle(line`ordinary`, undefined, receiptMark(r, resolve));",
      "postSparkle(line`x`, /* he didn't name it */ undefined, notAMark);",
      "// a trailing comment that isn't code",
    ].join("\n");
    const found = postSparkleCalls(synthetic);
    expect(found.length).toBe(2);
    const marked = found.filter((a) => a.length >= 3 && a[2] !== "undefined");
    expect(marked.map((a) => a[2] ?? "")).toEqual(["receiptMark(r, resolve)", "notAMark"]);
    // …and the real assertion would reject it.
    expect(marked.filter((a) => !/^receiptMark\s*\(/.test((a[2] ?? "").trim())).length).toBe(1);
  });

  it("rejects an argument that merely CONTAINS the producer's name", () => {
    // The substring check this replaced passed on all three of these.
    const impostors = ["notReallyReceiptMarkAtAll", "other.receiptMark", "myReceiptMarkCopy(r)"];
    for (const arg of impostors) {
      expect(/^receiptMark\s*\(/.test(arg.trim())).toBe(false);
    }
    // …while the genuine call still passes, so the tightening did not simply reject everything.
    expect(/^receiptMark\s*\(/.test("receiptMark(receipt, resolveAgent)")).toBe(true);
  });

  it("guards the FIELD, not just the helper (roborev 65819)", () => {
    // The property noticeRecipient depends on is about `actionReceipt` being SET, and the helper is
    // only today's route to setting it. A future `setChat` push that writes the field directly
    // would produce exactly the silent greying this file exists to prevent, and would pass a check
    // keyed to postSparkle's call sites. So: the field may be written in exactly one place.
    const bare = stripComments(src);
    const writes = [...bare.matchAll(/\bactionReceipt\b\s*[,:}]/g)];
    expect(writes.length).toBeGreaterThan(0); // not vacuous
    // Every occurrence must sit inside postSparkle's own definition. Bounded by the useCallback that
    // declares it — a write anywhere else in this 7000-line file fails here.
    const defStart = bare.indexOf("const postSparkle = useCallback(");
    expect(defStart).toBeGreaterThan(-1);
    const defEnd = bare.indexOf("[announce]", defStart);
    expect(defEnd).toBeGreaterThan(defStart);
    const outside = writes.filter((m) => (m.index ?? 0) < defStart || (m.index ?? 0) > defEnd);
    expect(
      outside.map((m) => bare.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 40)),
      "actionReceipt is written outside postSparkle — see noticeRecipient.ts; this silently greys a " +
        "line and captions it as not being for the founder",
    ).toEqual([]);
  });

  it("keeps the mark's producer in the module noticeRecipient documents", () => {
    // `receiptMark` lives beside the sentence it belongs to (./actionReceiptLine) precisely so the
    // fold and the row cannot disagree about a subject. If the import moves, the reasoning in
    // noticeRecipient's header stops being checkable by reading one file.
    expect(src).toMatch(/import\s*\{[^}]*receiptMark[^}]*\}\s*from\s*"\.\/Concierge\/actionReceiptLine"/);
  });
});
