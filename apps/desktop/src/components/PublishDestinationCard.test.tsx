// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PublishDestinationCard } from "./PublishDestinationCard";
import {
  PUBLISH_AFFORDANCES,
  type DestinationCapabilities,
  type PublishAffordance,
} from "../services/publishCapabilities";

// THE ACCEPTANCE TEST for bead `sparkle-131ms.5`, and the bead names the vacuous shape to avoid:
// asserting the capability STRUCT proves nothing, because the struct is the test's own input. What
// has to be pinned is the RENDERED affordance — that a destination without `upload_image` paints no
// image control, and that one with it does.
//
// It also follows AGENTS.md's "mount every candidate at once" rule. Absence in a component that was
// never mounted is not evidence: an image control is absent from an unmounted card no matter what
// the rule says, and it stays absent when the rule is keyed to entirely the wrong thing. So every
// assertion of absence below runs against a card that IS mounted and that IS painting its siblings
// — the all-four case establishes each control can be painted at all, and each narrower case then
// shows exactly which ones survive.

/** A valid destination offering exactly the affordances named. */
function caps(affordances: PublishAffordance[]): DestinationCapabilities {
  return {
    valid: true,
    missingRequired: [],
    presentOptional: [],
    missingOptional: [],
    argShapeProblems: [],
    affordances,
  };
}

const CONTROL = (a: PublishAffordance) => `publish-affordance-${a}`;

describe("PublishDestinationCard — affordances", () => {
  /** The mount-every-candidate baseline. Without this, every "is not painted" assertion below
   *  would be satisfied by a card that can paint no controls at all. */
  it("paints all four controls when the destination earns all four", () => {
    render(<PublishDestinationCard name="drodio.com" capabilities={caps([...PUBLISH_AFFORDANCES])} />);

    for (const a of PUBLISH_AFFORDANCES) {
      expect(screen.getByTestId(CONTROL(a))).toBeTruthy();
    }
  });

  /** Direction 1 of the bead's acceptance criterion: `upload_image` present → image control
   *  PAINTED. */
  it("paints the image control when upload_image is present", () => {
    render(
      <PublishDestinationCard
        name="drodio.com"
        capabilities={caps(["project-picker", "image-attach"])}
      />,
    );

    expect(screen.getByTestId(CONTROL("image-attach"))).toBeTruthy();
    // The chosen one is painted AND each other one is not — asserted by name, in the same mounted
    // tree, because "one control exists" would still pass if the wrong one were the survivor.
    expect(screen.queryByTestId(CONTROL("video-attach"))).toBeNull();
    expect(screen.queryByTestId(CONTROL("take-down"))).toBeNull();
  });

  /** Direction 2, and the criterion the bead states outright: the required set with NO
   *  `upload_image` is VALID, with the image affordance HIDDEN. */
  it("is valid with the image control hidden when upload_image is absent", () => {
    render(
      <PublishDestinationCard
        name="drodio.com"
        capabilities={{
          valid: true,
          missingRequired: [],
          presentOptional: [],
          missingOptional: ["upload_image", "create_video_upload_token", "attach_video"],
          argShapeProblems: [],
          affordances: ["project-picker"],
        }}
      />,
    );

    expect(screen.getByTestId("publish-destination-verdict").textContent).toContain(
      "Ready to publish",
    );
    // The one it earned IS painted — so the card is demonstrably capable of painting controls in
    // this exact render, which is what makes the three absences below mean something.
    expect(screen.getByTestId(CONTROL("project-picker"))).toBeTruthy();
    expect(screen.queryByTestId(CONTROL("image-attach"))).toBeNull();
    expect(screen.queryByTestId(CONTROL("video-attach"))).toBeNull();
    expect(screen.queryByTestId(CONTROL("take-down"))).toBeNull();
  });

  it("names the tools behind an affordance when its control is opened", () => {
    render(
      <PublishDestinationCard name="drodio.com" capabilities={caps(["video-attach"])} />,
    );

    const control = screen.getByTestId(CONTROL("video-attach"));
    expect(control.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(control);
    expect(control.getAttribute("aria-expanded")).toBe("true");

    // Both halves named — the affordance needs both, and a pane that showed only one would be
    // describing a dead end as a working feature.
    const card = screen.getByTestId("publish-destination-card");
    expect(card.textContent).toContain("create_video_upload_token");
    expect(card.textContent).toContain("attach_video");
  });
});

describe("PublishDestinationCard — an invalid destination", () => {
  /** The bead's other acceptance criterion: a fake destination exposing only `create_content` is
   *  rejected and NAMES the missing required tools. */
  it("names every missing required tool verbatim and paints no controls at all", () => {
    const missing = [
      "update_content",
      "publish_content",
      "get_content",
      "list_content",
      "list_projects",
    ];

    render(
      <PublishDestinationCard
        name="half-built.example"
        capabilities={{
          valid: false,
          missingRequired: missing,
          presentOptional: [],
          missingOptional: [
            "unpublish_content",
            "upload_image",
            "create_video_upload_token",
            "attach_video",
          ],
          argShapeProblems: [],
          // Empty by construction on the Rust side; the card must not resurrect them.
          affordances: [],
        }}
      />,
    );

    expect(screen.getByTestId("publish-destination-verdict").textContent).toContain("can’t publish");

    // Verbatim, one element per tool — the tool NAME is the actionable part, and a rendered count
    // ("5 tools missing") would pass a laxer assertion while helping nobody.
    for (const tool of missing) {
      expect(screen.getByTestId(`publish-missing-tool-${tool}`).textContent).toBe(tool);
    }

    // And every affordance control absent, in a mounted card, by name.
    for (const a of PUBLISH_AFFORDANCES) {
      expect(screen.queryByTestId(CONTROL(a))).toBeNull();
    }
  });

  /** Defense in depth, and the only assertion here that is about the CARD rather than about the
   *  host's invariant. The Rust probe empties `affordances` whenever a destination is invalid — so
   *  every other invalid case above is really testing that the host's guarantee is respected. This
   *  one feeds a payload that CONTRADICTS the guarantee and requires the card to paint nothing
   *  anyway: it is the end that renders the button, and a control for a call that cannot succeed
   *  must not be reachable because one layer stopped being careful. */
  it("paints no controls for an invalid destination even if the payload lists affordances", () => {
    render(
      <PublishDestinationCard
        name="contradictory.example"
        capabilities={{
          valid: false,
          missingRequired: ["list_projects"],
          presentOptional: ["upload_image"],
          missingOptional: [],
          argShapeProblems: [],
          // The host can never send this. The card must not depend on that.
          affordances: [...PUBLISH_AFFORDANCES],
        }}
      />,
    );

    for (const a of PUBLISH_AFFORDANCES) {
      expect(screen.queryByTestId(CONTROL(a))).toBeNull();
    }
    // …and it still says WHY, so the user is not left with a card that shows nothing at all.
    expect(screen.getByTestId("publish-missing-tool-list_projects").textContent).toBe("list_projects");
  });

  it("renders an argument-shape problem verbatim, naming the tool and the property", () => {
    const problem =
      "`create_content` does not require `projectId` — Sparkle sends it on every call";

    render(
      <PublishDestinationCard
        name="wrong-shape.example"
        capabilities={{
          valid: false,
          missingRequired: [],
          presentOptional: [],
          missingOptional: [],
          argShapeProblems: [problem],
          affordances: [],
        }}
      />,
    );

    const rendered = screen.getByTestId("publish-arg-shape-problems").textContent ?? "";
    expect(rendered).toContain("create_content");
    expect(rendered).toContain("projectId");
    // No "missing tools" list, because nothing is missing — the two failures must not be conflated
    // in the pane any more than they are in the probe.
    expect(screen.queryByTestId("publish-missing-required")).toBeNull();
  });
});
