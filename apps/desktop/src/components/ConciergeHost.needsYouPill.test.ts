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
//
// ══ EVERY PIN HERE GOES THROUGH `assertPinnedNeedle`, AND THE THIRD ONE USED TO BE VACUOUS ═══════
// A source pin on a bare IDENTIFIER cannot tell a use from a mention. The third case below pinned
// `isolateStatusBand` and `showAllStatusBands`, and by the time anyone looked, the toggle had stopped
// calling `isolateStatusBand` altogether — the name survived only in the host's explanatory comments,
// while `showAllStatusBands` matched the digest click's call further down the file. So the one thing
// this case exists to prove — that the pill writes the SAME `statusFilter` the sidebar chips write
// rather than a second state that can disagree — was unguarded: the toggle's whole body could be
// swapped for a private filter and all three cases stayed green.
//
// The pins are now EXPRESSIONS from the toggle's own use site, checked by a helper that rejects a
// needle appearing only on import/comment lines. Pin expressions, not identifiers.
import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertPinnedNeedle } from "../testing/pinnedNeedle";

const host = readFileSync(
  fileURLToPath(new URL("./ConciergeHost.tsx", import.meta.url)),
  "utf8",
);

const HOST = "ConciergeHost.tsx";

describe("the concierge's needs-you pill is actually reachable", () => {
  it("the production host supplies the toggle the pill's render is gated on", () => {
    // The handler itself, not the name: the comment above the property mentions
    // `onNeedsYouFilterToggle` too, so the arrow is what proves something is wired.
    assertPinnedNeedle(host, "onNeedsYouFilterToggle: () => {", HOST);
  });

  it("…and the pressed state the pill reflects", () => {
    // Bound to the derived value, so a regression to a hardcoded `false` — which would mount the
    // pill but leave it permanently unpressed — goes red here.
    assertPinnedNeedle(host, "needsYouFilter: needsYouIsolated", HOST);
  });

  it("the toggle writes the SAME filter the sidebar chips write, not a second one", () => {
    // One state or two that can disagree. rev4.html calls this out explicitly: a header pill and
    // per-column chips hiding rows through separate mechanisms is how the controls came to lie
    // about the view.
    //
    // Both arms of the toggle, as expressions, so the assertion is about THIS handler:
    //   - it reads the shared `statusFilter` to decide which way it is going, and widens back
    //     through the store's own action rather than a private reset;
    //   - and it narrows by WRITING that same shared filter — covering both asking bands, since
    //     `questions` blocks the founder just as squarely as `waiting`/`approval`.
    assertPinnedNeedle(host, "isAskingIsolated(ui.statusFilter)) ui.showAllStatusBands()", HOST);
    assertPinnedNeedle(host, "ui.setStatusFilter({ needs_you: true, questions: true", HOST);
  });
});
