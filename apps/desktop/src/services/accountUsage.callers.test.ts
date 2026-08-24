// ── WHO IS ALLOWED TO PROMPT ────────────────────────────────────────────────────────────────────
//
// The quiet/forced split (see accountUsage.ts) only holds while the forced reader stays bound to a
// user GESTURE. `tsc` guarantees half of it — `getAccountUsageLive` takes no `force`, so no caller of
// it can prompt however hard it tries. The other half is not type-checkable: nothing stops a future
// timer, effect or poll from importing `getAccountUsageLiveForced` directly, and the bug that comes
// back if one does is precisely the original one (a macOS keychain dialog several times a minute,
// sparkle-dkxuf6 / sparkle-oe9y1k) — invisible to every test of the quiet path.
//
// So this scans the real source tree for who imports the loud reader. It is deliberately a SOURCE
// check rather than a runtime one: the two non-gesture callers it has to cover
// (`services/advisor/deps.ts`, `services/conciergeTools/accounts.ts`) reach live usage through their
// own injectable deps, so a runtime assertion would only ever exercise whatever the test injected.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Every non-test source file under `apps/desktop/src`, repo-relative to `src/`. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(relative(SRC, full));
  }
  return out;
}

/** Source with `//` and block comments removed.
 *
 *  Load-bearing, not tidiness: the rule these tests enforce is written down in prose in several
 *  files, and a scan that counted a doc comment SAYING "do not call `getAccountUsageLiveForced` from
 *  a timer" as a call would report the documentation itself as the violation. Only real code counts.
 *  (String literals containing `//` would confuse this — none of these files has one, and a false
 *  POSITIVE here fails loudly rather than passing something dangerous.) */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Files that can actually REACH the INTERACTIVE reader — its own definition excluded. Catches both
 *  a named import and a `* as usage` namespace access, because either one calls it. */
function forcedReaderUsers(): string[] {
  return sourceFiles(SRC)
    .filter((f) => f !== "services/accountUsage.ts")
    .filter((f) => stripComments(readFileSync(join(SRC, f), "utf8")).includes("getAccountUsageLiveForced"));
}

describe("the keychain-touching reader is reachable only from a user gesture", () => {
  it("is named by exactly ONE production file — the accounts screen that owns the ⋮ click", () => {
    // If this goes red because you added a caller: the question to answer is whether YOUR call site
    // is a click. If it is not (an effect, an interval, a poll, a background refresh, a retry), it
    // wants `getAccountUsageLive` instead — the quiet reader, which cannot prompt. If it genuinely is
    // a gesture, add it here and say so in the same commit.
    expect(forcedReaderUsers()).toEqual(["components/AccountsScreen.tsx"]);
  });

  it("is NOT named by the two non-gesture live-usage callers", () => {
    // Stated explicitly rather than left implicit in the list above, because these two are the ones a
    // future agent is most likely to "fix" by forcing: the advisor spend gate wants a fresh number
    // before it commits money, and the concierge `read_usage` tool wants a fresh number because the
    // user just asked a question. Both run without anyone watching for a keychain dialog — the
    // advisor on a schedule, the concierge inside a tool call — so both must stay quiet.
    //
    // NON-VACUOUS: the assertion above proves the scan actually finds a file, so these cannot pass by
    // the scan reading nothing at all.
    const users = forcedReaderUsers();
    expect(users).not.toContain("services/advisor/deps.ts");
    expect(users).not.toContain("services/conciergeTools/accounts.ts");
  });

  it("finds the quiet reader in BOTH of those callers, so they were scanned, not merely absent", () => {
    // The pair for the test above. Without it, a scan whose paths were wrong (a renamed file, a
    // changed root) would report a clean bill of health for files it never opened.
    for (const f of ["services/advisor/deps.ts", "services/conciergeTools/accounts.ts"]) {
      expect(stripComments(readFileSync(join(SRC, f), "utf8"))).toContain("getAccountUsageLive");
    }
  });

  it("does NOT count a doc comment that merely names the forced reader as a caller", () => {
    // Pins the comment-stripping itself. accountSelection.ts documents at length WHY its timer-driven
    // refresh must never reach `getAccountUsageLiveForced` — mentioning the name. A scan that read
    // prose as code would flag that file, and the natural "fix" would be to delete the explanation
    // that keeps the next agent from reintroducing the bug.
    const selection = readFileSync(join(SRC, "services/accountSelection.ts"), "utf8");
    expect(selection).toContain("getAccountUsageLiveForced"); // …in prose
    expect(stripComments(selection)).not.toContain("getAccountUsageLiveForced"); // …but not in code
  });
});
