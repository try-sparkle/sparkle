import { describe, it, expect } from "vitest";
import { repoUrlFromPrListUrl } from "./repoUrl";

// The clone URL a cloud sandbox is handed. A wrong value here is expensive: the sandbox spins up,
// bills minutes, and fails to clone — so the parser refuses anything it doesn't recognize instead
// of guessing.
describe("repoUrlFromPrListUrl", () => {
  it("strips the /pulls suffix the Rust probe appends", () => {
    expect(repoUrlFromPrListUrl("https://github.com/acme/repo/pulls")).toBe(
      "https://github.com/acme/repo",
    );
    // Enterprise hosts resolve the same way (gh reports the real host).
    expect(repoUrlFromPrListUrl("https://git.acme.internal/team/repo/pulls")).toBe(
      "https://git.acme.internal/team/repo",
    );
    expect(repoUrlFromPrListUrl("  https://github.com/acme/repo/pulls  ")).toBe(
      "https://github.com/acme/repo",
    );
  });

  it("returns null when there's no answer at all (no gh, no remote, not a repo)", () => {
    expect(repoUrlFromPrListUrl(null)).toBeNull();
    expect(repoUrlFromPrListUrl(undefined)).toBeNull();
    expect(repoUrlFromPrListUrl("")).toBeNull();
  });

  it("refuses a shape it doesn't recognize rather than guessing a clone URL", () => {
    expect(repoUrlFromPrListUrl("https://github.com/acme/repo")).toBeNull(); // no /pulls
    expect(repoUrlFromPrListUrl("https://github.com/acme/repo/pull")).toBeNull();
  });

  it("refuses a non-https URL — a sandbox must never be handed ssh:// or file://", () => {
    expect(repoUrlFromPrListUrl("git@github.com:acme/repo/pulls")).toBeNull();
    expect(repoUrlFromPrListUrl("ssh://git@github.com/acme/repo/pulls")).toBeNull();
    expect(repoUrlFromPrListUrl("file:///tmp/repo/pulls")).toBeNull();
    expect(repoUrlFromPrListUrl("https:///pulls")).toBeNull(); // nothing left after the scheme
  });
});
