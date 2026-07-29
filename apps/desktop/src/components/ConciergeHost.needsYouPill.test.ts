// The concierge header's needs-you pill renders behind
// `(needsYou > 0 || model.needsYouFilter === true) && controller.onNeedsYouFilterToggle`.
// ConciergeColumn's own tests inject a controller, so they proved the pill works given a handler —
// they could never see that the ONLY production mount, ConciergeHost, supplied neither field. The
// second conjunct was permanently `undefined`, the pill never mounted, and `needsYouFilter` stayed
// falsy forever (roborev 54769). That is a whole control certified by tests and unreachable by
// users, which is the same shape as the CIRCUIT bug earlier on this branch.
//
// Asserted against the SOURCE because the failure is a wiring absence: a rendering test would need
// the very wiring under test to be present in order to look for it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = readFileSync(
  fileURLToPath(new URL("./ConciergeHost.tsx", import.meta.url)),
  "utf8",
);

describe("the concierge's needs-you pill is actually reachable", () => {
  it("the production host supplies the toggle the pill's render is gated on", () => {
    expect(host).toContain("onNeedsYouFilterToggle:");
  });

  it("…and the pressed state the pill reflects", () => {
    expect(host).toContain("needsYouFilter:");
  });

  it("the toggle writes the SAME filter the sidebar chips write, not a second one", () => {
    // One state or two that can disagree. rev4.html calls this out explicitly: a header pill and
    // per-column chips hiding rows through separate mechanisms is how the controls came to lie
    // about the view.
    expect(host).toContain("isolateStatusBand");
    expect(host).toContain("showAllStatusBands");
  });
});
