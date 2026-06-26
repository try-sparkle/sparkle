// Regression guard for the silent sign-in failure (bead: opener-scope): the AuthGate buttons
// hand off to the system browser via openUrl(), which Tauri's opener plugin checks against the
// `opener:allow-open-url` scope in capabilities/default.json. That scope is matched with the Rust
// `glob` crate, so a wildcard-free entry like "https://sparkle.ai" matches ONLY that exact string
// — never "https://sparkle.ai/desktop/callback". When the URL falls outside the scope, openUrl()
// rejects and AuthGate's `() => void openSignIn()` swallows it, so the button silently does nothing.
//
// This test asserts every URL the app actually opens is inside the scope. It encodes the URLs from
// services/sparkleApi.ts (openSignIn → /desktop/callback, openPaywall → /paywall) against the two
// supported WEB_BASE_URLs (prod default + the localhost:3000 dev override).
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import capabilities from "../../src-tauri/capabilities/default.json";

// Mirror the Rust `glob` crate's default match (used by tauri-plugin-opener's Scope): `*`/`**`
// match any run of characters INCLUDING `/` (require_literal_separator defaults to false); every
// other character is literal. Anchored to the full string.
//
// SCOPE: this models only the `*`/`?` wildcards our scope actually uses. It does NOT model glob
// character classes (`[...]`) or the `**`-vs-`*` separator distinction (both map to `.*`) — if a
// scope entry ever uses those, match it against the real plugin instead of trusting this proxy.
function globMatches(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (NOT * or ?)
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(value);
}

function openerAllowUrls(): string[] {
  for (const p of capabilities.permissions) {
    if (typeof p === "object" && p.identifier === "opener:allow-open-url") {
      return (p.allow as Array<{ url: string }>).map((a) => a.url);
    }
  }
  throw new Error("opener:allow-open-url permission not found in capabilities/default.json");
}

// The base URLs sparkleApi.ts can target (prod default + the localhost:3000 dev override).
const BASES = ["https://sparkle.ai", "http://localhost:3000"];

// Derive the opened paths from sparkleApi.ts SOURCE rather than hard-coding them, so a newly
// added `openUrl(`${WEB_BASE_URL}/foo`)` is automatically checked against the scope — otherwise a
// new path could slip out of scope and silently fail (the exact bug this guards). We read source
// instead of importing the module because sparkleApi.ts pulls in @tauri-apps/* at load time.
function openedPaths(): string[] {
  const src = readFileSync(new URL("./sparkleApi.ts", import.meta.url), "utf8");
  // Match openUrl(`${WEB_BASE_URL}/some/path`) and capture the path.
  const paths = [...src.matchAll(/openUrl\(\s*`\$\{WEB_BASE_URL\}(\/[^`]*)`/g)]
    .map((m) => m[1])
    .filter((p): p is string => p !== undefined);
  return [...new Set(paths)];
}

const PATHS = openedPaths();
const OPENED_URLS = BASES.flatMap((b) => PATHS.map((p) => b + p));

describe("opener scope covers every URL the app opens", () => {
  const allow = openerAllowUrls();

  it("finds the paths sparkleApi.ts opens (guards the regex against silent drift)", () => {
    expect(PATHS).toEqual(expect.arrayContaining(["/desktop/callback", "/paywall"]));
  });

  it.each(OPENED_URLS)("permits %s", (url) => {
    expect(allow.some((pattern) => globMatches(pattern, url))).toBe(true);
  });

  // Sanity-check the matcher itself: a bare-host entry must NOT cover a sub-path (this is the
  // exact bug). If this assertion ever flips, the matcher is wrong and the guard above is hollow.
  it("matcher: bare host does not cover a sub-path", () => {
    expect(globMatches("https://sparkle.ai", "https://sparkle.ai/desktop/callback")).toBe(false);
    expect(globMatches("https://sparkle.ai/*", "https://sparkle.ai/desktop/callback")).toBe(true);
  });
});
